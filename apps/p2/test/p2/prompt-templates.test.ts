// Prompt templates and `/skill:` (p2-tui-port.md 10.8): pi's parsing and expansion, the loader, and the worker's
// PromptResources object (participants only, live reload, expand).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { promptComposer } from "../../plugins/prompt/composer.ts";
import { loadPromptResources } from "../../plugins/prompt/context-files.ts";
import { PromptResources } from "../../plugins/prompt/contract.ts";
import {
	expandPrompt,
	parseCommandArgs,
	parseTemplate,
	type SkillFile,
	substituteArgs,
} from "../../plugins/prompt/templates.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { expandComposerText } from "../../src/runtime/composer.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

test("pi's argument parsing and substitution", () => {
	assert.deepEqual(parseCommandArgs(`one "two words" 'three'  four`), ["one", "two words", "three", "four"]);
	const args = ["a", "b", "c"];
	assert.equal(substituteArgs("$1-$2-$3-$4", args), "a-b-c-");
	assert.equal(substituteArgs("$@|$ARGUMENTS", args), "a b c|a b c");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: pi's template syntax, not a JS template.
	assert.equal(substituteArgs("${2:-x} ${5:-default}", args), "b default");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: pi's template syntax, not a JS template.
	assert.equal(substituteArgs("${@:-none}", []), "none");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: pi's template syntax, not a JS template.
	assert.equal(substituteArgs("${@:2}|${@:2:1}|${@:0}", args), "b c|b|a b c");
	assert.equal(substituteArgs("$1", ["$2"]), "$2", "values are not substituted again");
});

test("templates: pi's file format; expansion of templates and skill blocks", async () => {
	const withHint = parseTemplate(
		"review.md",
		"---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully.",
		"global",
		"/p/review.md",
	);
	assert.deepEqual(withHint, {
		name: "review",
		description: "Review a file",
		argumentHint: "<file>",
		content: "Review $1 carefully.",
		source: "global",
		path: "/p/review.md",
	});
	assert.equal(parseTemplate("x.md", `\n${"long ".repeat(20)}`, "project", "/x.md").description.length, 63);
	const skill: SkillFile = {
		name: "deploy",
		description: "Deploys",
		path: "/s/deploy/SKILL.md",
		baseDir: "/s/deploy",
	};
	const read = async () => "---\nname: deploy\ndescription: Deploys\n---\nRun the script.\n";
	assert.deepEqual(await expandPrompt('/review "a file.ts"', [withHint], [skill], read), {
		text: "Review a file.ts carefully.",
	});
	const invoked = await expandPrompt("/skill:deploy now please", [withHint], [skill], read);
	assert.equal(
		invoked.text,
		'<skill name="deploy" location="/s/deploy/SKILL.md">\nReferences are relative to /s/deploy.\n\nRun the script.\n</skill>\n\nnow please',
	);
	assert.deepEqual(invoked.skill, { name: "deploy" });
	for (const text of ["/unknown x", "/skill:missing", "plain /review", "/skill:deploy"])
		if (text !== "/skill:deploy") assert.deepEqual(await expandPrompt(text, [withHint], [skill], read), { text });
	assert.deepEqual(await expandPrompt("/skill:deploy", [], [skill], async () => undefined), { text: "/skill:deploy" });
});

test("loader: global then project templates, invalid ones skipped, every skill invocable", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-templates-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const cwd = join(directory, "project");
	await mkdir(join(directory, "prompts"), { recursive: true });
	await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
	await mkdir(join(directory, "skills", "hidden"), { recursive: true });
	writeFileSync(join(directory, "prompts", "fix.md"), "Fix $@");
	writeFileSync(join(directory, "prompts", "broken.md"), "---\n: : bad\n---\nx");
	writeFileSync(join(directory, "prompts", "notes.txt"), "not a template");
	writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), "Project fix");
	writeFileSync(join(cwd, ".pi", "prompts", "plan.md"), "---\ndescription: Plan it\n---\nPlan $1");
	writeFileSync(
		join(directory, "skills", "hidden", "SKILL.md"),
		"---\nname: hidden\ndescription: Only by name\ndisable-model-invocation: true\n---\nSecret steps",
	);
	const loaded = await loadPromptResources(directory, cwd);
	assert.deepEqual(
		loaded.templates.map(({ name, source }) => `${source}:${name}`),
		["global:fix", "project:fix", "project:plan"],
	);
	assert.equal((await expandPrompt("/fix it", loaded.templates, [], async () => "")).text, "Fix it", "global first");
	assert.deepEqual(
		loaded.skillFiles.map(({ name, baseDir }) => [name, baseDir]),
		[["hidden", join(directory, "skills", "hidden")]],
	);
	assert.equal(loaded.skills, "", "hidden from the model's list, still invocable");
});

test("PromptResources on the worker: participants only, live templates, expand with skills", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	await mkdir(join(fixture.dataDir, "prompts"), { recursive: true });
	await writeFile(join(fixture.dataDir, "prompts", "greet.md"), "---\ndescription: Greets\n---\nHello $1!");
	await mkdir(join(fixture.dataDir, "skills", "deploy"), { recursive: true });
	await writeFile(
		join(fixture.dataDir, "skills", "deploy", "SKILL.md"),
		"---\nname: deploy\ndescription: Deploys the app.\n---\nRun the deploy script.",
	);
	const owner = fixture.browser();
	const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
		{ cwd: fixture.workspace },
		BACKGROUND_CONTEXT,
	);
	const resources = owner.hold(PromptResources, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
	await whenLive(resources);
	assert.equal(resources.variant, "participant");
	const templates = await until(resources.templates, (value) => Boolean(value?.length));
	assert.deepEqual(templates, [{ name: "greet", description: "Greets", source: "global" }]);
	assert.deepEqual(await until(resources.skills, (value) => Boolean(value?.length)), [
		{ name: "deploy", description: "Deploys the app." },
	]);
	assert.deepEqual(await resources.expand({ text: "/greet world" }, BACKGROUND_CONTEXT), { text: "Hello world!" });
	const skill = await resources.expand({ text: "/skill:deploy go" }, BACKGROUND_CONTEXT);
	assert.equal(skill.skill?.name, "deploy");
	assert.match(
		skill.text,
		/^<skill name="deploy" location="[^"]+SKILL\.md">\n[\s\S]*Run the deploy script\.\n<\/skill>\n\ngo$/,
	);
	// The web composer's expander (prompt/composer.ts, the web facet) uses the same worker method.
	const web = fixture.browser([{ name: "prompt-web", facet: promptComposer }]);
	assert.equal(await expandComposerText(web, session.id, 1, "/greet web"), "Hello web!");
	assert.equal(await expandComposerText(web, session.id, 1, "no command"), "no command");
	// The project's templates appear live.
	await mkdir(join(fixture.workspace, ".pi", "prompts"), { recursive: true });
	await writeFile(join(fixture.workspace, ".pi", "prompts", "plan.md"), "Plan $@");
	await until(resources.templates, (value) => value?.some((entry) => entry.name === "plan") === true);
});
