// `@` and Tab file completion (p2-tui-port.md sections 8.2-8.4): the shared text helpers (copies of pi-tui's) and
// the index's bounds on a large directory (P7a, P7b).

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import {
	applyFileCompletion,
	atItems,
	extractAtPrefix,
	extractPathPrefix,
	outOfScope,
	pathItems,
} from "../../src/runtime/completion.ts";
import { FileIndex } from "../../src/runtime/file-index.ts";
import { holdIn, startFixture } from "./helpers.ts";

test("prefix extraction, quoting and insertion follow pi-tui", () => {
	assert.equal(extractAtPrefix("look at @src/ma"), "@src/ma");
	assert.equal(extractAtPrefix('see @"my fi'), '@"my fi');
	assert.equal(extractAtPrefix("mail me@example"), null, "not at a token start");
	assert.equal(extractAtPrefix("(@src"), "@src", "opening wrappers are stripped");
	assert.equal(extractPathPrefix("edit src/ma"), "src/ma");
	assert.equal(extractPathPrefix("hello"), null);
	assert.equal(extractPathPrefix("hello", true), "hello", "forced Tab takes any token");
	for (const prefix of ["/etc", "~", "~/x", "..", "../x"]) assert(outOfScope(prefix), prefix);
	assert(!outOfScope("src") && !outOfScope(".env") && !outOfScope("./src"));
	assert.deepEqual(atItems([{ path: "my dir/a b.ts", dir: false }], { isQuotedPrefix: false }), [
		{ value: '@"my dir/a b.ts"', label: "a b.ts", description: "my dir/a b.ts" },
	]);
	assert.deepEqual(
		pathItems(
			[
				{ name: "main.ts", dir: false },
				{ name: "maps", dir: true },
				{ name: "other.ts", dir: false },
			],
			"src/ma",
			{ isAtPrefix: false, isQuotedPrefix: false },
		),
		[
			{ value: "src/maps/", label: "maps/" },
			{ value: "src/main.ts", label: "main.ts" },
		],
	);
	// Files after `@` get a trailing space; directories none (completion continues).
	assert.deepEqual(applyFileCompletion("see @sr now", 7, { value: "@src/a.ts", label: "a.ts" }, "@sr"), {
		line: "see @src/a.ts  now",
		cursorCol: 14,
	});
	assert.deepEqual(applyFileCompletion("@sr", 3, { value: "@src/", label: "src/" }, "@sr"), {
		line: "@src/",
		cursorCol: 5,
	});
});

test("the index stays within its bounds on a large directory and says so", { timeout: 120_000 }, async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	// More entries than either source lists: the daemon's listFiles (50 000 entries) and the bounded fallback walk
	// (5000 directories) both truncate.
	for (let index = 0; index < 50_100; index++) {
		const dir = join(fixture.workspace, `d${index}`);
		mkdirSync(dir);
		if (index % 500 === 0) writeFileSync(join(dir, `file${index}.ts`), "");
	}
	const owner = fixture.browser();
	const session = (
		await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
	).id;
	const index = owner.hold(FileIndex, { session, conversation: 1 }, BACKGROUND_CONTEXT);
	await whenLive(index);
	const started = Date.now();
	const result = await index.complete({ query: "file", limit: 100 }, BACKGROUND_CONTEXT);
	assert.equal(result.truncated, true);
	assert(result.items.length > 0 && result.items.length <= 100);
	assert(result.items.every((item) => item.path.includes("file")));
	// Both sources keep the first names in byte order whatever the filesystem's directory order (the daemon depth first,
	// the walk breadth first), so d0/file0.ts is in the index. Ranked: name prefix matches first, shallow and short
	// paths first among equals.
	assert.deepEqual(result.items[0], { path: "d0/file0.ts", dir: false });
	const again = Date.now();
	await index.complete({ query: "file4", limit: 5 }, BACKGROUND_CONTEXT);
	assert(Date.now() - again < Date.now() - started + 1000, "the cached index answers");
});
