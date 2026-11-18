// The team (fake provider): the HR manager hires a manager and its executors; the main agent is the only entry and
// cannot reach a team executor or the HR manager directly; a manager's answer is reported to the main agent only once
// the executors it gave work to are done; members message only their contacts.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { AGENT_MESSAGE_ENTRY, type AgentMessage, type Child, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, hire, holdIn, poll, startFixture, textsOf, until } from "./helpers.ts";

const results = (view: ConversationView | null | undefined, tool: string): ToolResultMessage[] =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool);
const refused = (message: ToolResultMessage | undefined) =>
	(message?.details as { refused?: Record<string, unknown> } | undefined)?.refused;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const agentMessages = (view: ConversationView | null | undefined): AgentMessage[] =>
	(view?.entries ?? [])
		.filter((entry: EntryRecord) => entry.kind === AGENT_MESSAGE_ENTRY)
		.map((entry) => entry.data as AgentMessage);
/**
 * The newest entry's ID of a view. A view holds only a window of the newest entries, so a count of what came before
 * can shrink as the window slides: counts are taken after a marker like this one instead.
 */
const newest = (view: ConversationView | null | undefined): number =>
	Math.max(0, ...(view?.entries ?? []).map((entry) => entry.id));
/** The prompt section `key` in effect at the end of a view: its system messages replayed in order. */
const sectionOf = (view: ConversationView | null | undefined, key: string): string | undefined => {
	let current: string | undefined;
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system" || !message.sections || !(key in message.sections)) continue;
			current = message.sections[key] ?? undefined;
		}
	return current;
};
/** How many messages member `name` sent to the view's conversation after entry `since`. */
const reportsSince = (view: ConversationView | null | undefined, name: string, since: number): number =>
	(view?.entries ?? []).filter(
		(entry) =>
			entry.kind === AGENT_MESSAGE_ENTRY && entry.id > since && (entry.data as AgentMessage).from.name === name,
	).length;

describe("the team (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let chat: RefIn<typeof Chat, "participant">;
	let children: RefIn<typeof Subagents, "reader">;
	let session: string;
	let serial = 0;
	const member = (name: string): Child => children.children.value![session]!.find((each) => each.name === name)!;
	/** The main agent asks one of its members, by `subagent send`. */
	const sendTo = (name: string, message: string) =>
		chat.send(
			{
				text: `subagent ${JSON.stringify({ action: "send", name, message })}`,
				requestId: `team-${++serial}`,
			},
			BACKGROUND_CONTEXT,
		);
	/** The main agent's `subagent status`, as text. */
	const status = async (): Promise<string> => {
		const count = (view: ConversationView | null | undefined) =>
			results(view, "subagent").filter((each) => (each.details as { action?: string }).action === "status");
		const before = count(chat.view.value).length;
		await chat.send({ text: "subagent-status", requestId: `team-${++serial}` }, BACKGROUND_CONTEXT);
		return text(count(await until(chat.view, (view) => count(view).length > before)).at(-1));
	};

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		children = await holdIn(owner, Subagents, {}, "reader");
	});
	after(async () => {
		await fixture?.close();
	});

	it("has the HR manager from the session's start, before anyone hires", async () => {
		// Resident: the session's worker made it at its start, with its own AGENTS.md, and the roster lists it.
		const listed = await until(
			children.children,
			(value) => value?.[session]?.some((each) => each.role === "hr") === true,
		);
		assert.deepEqual(
			listed![session]!.map((each) => [each.name, each.role]),
			[["hr", "hr"]],
		);
		await poll(() => existsSync(join(fixture.dataDir, "sessions", session, "team", "hr", "AGENTS.md")), 5_000, "hr");
		assert.match(await status(), /^hr: HR manager · idle/);
		// Nobody archives it: not the HR manager itself, not the browser.
		await chat.send(
			{
				text: `subagent ${JSON.stringify({ action: "hire", message: `staff ${JSON.stringify({ action: "archive", name: "hr" })}` })}`,
				requestId: `team-${++serial}`,
			},
			BACKGROUND_CONTEXT,
		);
		const hr = await holdIn(owner, Chat, { session, conversation: member("hr").conversationId }, "participant");
		await until(hr.view, (view) => results(view, "staff").some((each) => refused(each)?.role === "hr"), 30_000);
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		assert.equal(member("hr").archived, undefined);
		hr.release();
	});

	it("hires a manager and two executors through the HR manager", async () => {
		const lead = await hire(chat, children, session, { name: "lead", role: "manager", duty: "splits the work" });
		const first = await hire(chat, children, session, { name: "exec-1", manager: "lead", tools: ["bash"] });
		const second = await hire(chat, children, session, { name: "exec-2", manager: "lead", tools: ["bash"] });
		assert.equal(lead.role, "manager");
		assert.equal(lead.manager, undefined);
		assert.deepEqual([first.role, first.manager], ["executor", "lead"]);
		assert.deepEqual([second.role, second.manager], ["executor", "lead"]);
		assert.equal(member("hr").role, "hr");
	});

	it("tells the main agent it leads the team, and no member", async () => {
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		// The main agent's prompt carries the team guide: to look with status first, to staff through the HR manager.
		const guide = sectionOf(chat.view.value, "team-lead");
		assert.match(guide ?? "", /You lead a team/);
		assert.match(guide ?? "", /subagent status/);
		assert.match(guide ?? "", /subagent hire/);
		// A member is led, not a lead: no `team-lead` section in its conversation. The HR manager has run (it hired the
		// others); the executors are checked once they have (the notes test).
		const hr = await holdIn(owner, Chat, { session, conversation: member("hr").conversationId }, "participant");
		await until(hr.view, (value) => (value?.entries.length ?? 0) > 0);
		assert.equal(sectionOf(hr.view.value, "team-lead"), undefined);
		hr.release();
	});

	it("gives the main agent no way to the HR manager or a team executor but hire and the manager", async () => {
		await sendTo("exec-1", "x");
		await sendTo("hr", "x");
		const view = await until(
			chat.view,
			(value) =>
				results(value, "subagent").some((each) => refused(each)?.manager === "lead") &&
				results(value, "subagent").some((each) => refused(each)?.use === "hire"),
		);
		assert.ok(view);
	});

	it("reports a manager's answer once its executors are done", async () => {
		const work = [
			{ action: "send", name: "exec-1", message: "slow-tool" },
			{ action: "send", name: "exec-2", message: "slow-tool" },
		];
		await sendTo("lead", `delegates ${JSON.stringify(work)}`);
		// The manager answers that it handed the work out; its executors are still working, so that is not reported.
		let roster = await status();
		for (let attempt = 0; attempt < 30 && !roster.includes("waiting for its team"); attempt++) {
			await sleep(300);
			roster = await status();
		}
		assert.match(roster, /main → lead: waiting for its team/);
		assert.match(roster, /lead → exec-1: working/);
		assert.match(roster, /lead → exec-2: working/);
		const fromLead = (view: ConversationView | null | undefined) =>
			agentMessages(view).filter((each) => each.from.name === "lead");
		assert.deepEqual(fromLead(chat.view.value), []);
		// Both executors end: the one report arrives, and no executor reported to the main agent.
		await until(chat.view, (view) => fromLead(view).length >= 1, 60_000);
		await until(chat.view, (view) => !(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		const view = chat.view.value;
		assert.equal(fromLead(view).length, 1);
		assert.equal(fromLead(view)[0]?.intent, "answered");
		assert.deepEqual(
			agentMessages(view).filter((each) => each.from.name.startsWith("exec-")),
			[],
		);
		assert.ok(!(await status()).includes("Open work:"));
	});

	it("lets an executor message only its manager and its team", async () => {
		const first = member("exec-1");
		const sub = await holdIn(fixture.browser(), Chat, { session, conversation: first.conversationId }, "participant");
		const ask = { action: "send", to: "hr", message: "hello" };
		const delegate = { action: "send", name: "exec-1", message: `team ${JSON.stringify(ask)}` };
		await sendTo("lead", `delegates ${JSON.stringify([delegate])}`);
		const seen = await until(sub.view, (view) =>
			results(view, "team").some((each) => refused(each)?.contact === true),
		);
		assert.ok(seen);
		sub.release();
	});

	it("gives every member an AGENTS.md the HR manager keeps, read into its prompt", async () => {
		// A direct executor of this test alone: an earlier member's history would answer the waits below, and the
		// manager's team stays as the stop test expects it.
		const fresh = await hire(chat, children, session, { name: "exec-3", tools: ["bash"] });
		const exec = await holdIn(owner, Chat, { session, conversation: fresh.conversationId }, "participant");
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		// Hired members have one already (empty).
		const at = join(fixture.dataDir, "sessions", session, "team", "exec-3", "AGENTS.md");
		await poll(() => existsSync(at), 5_000, "the member's AGENTS.md");
		// The HR manager writes it: the main agent asks it to run the staff call.
		const guidance = "Answer in the user's language; run the tests before answering.";
		await chat.send(
			{
				text: `subagent ${JSON.stringify({ action: "hire", message: `staff ${JSON.stringify({ action: "agents", name: "exec-3", text: guidance })}` })}`,
				requestId: "team-agents-write",
			},
			BACKGROUND_CONTEXT,
		);
		// Its report echoes the request, not the tool's answer: the file itself is what proves the write.
		await poll(
			() => {
				try {
					return readFileSync(at, "utf8") === guidance;
				} catch {
					return false;
				}
			},
			15_000,
			"the HR manager's AGENTS.md write",
		);
		assert.equal(readFileSync(at, "utf8"), guidance);
		// The member reads it in its prompt: its next request carries the section. It works for the main agent directly.
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		await sendTo("exec-3", "slow-tool");
		await until(exec.view, (view) => JSON.stringify(view?.entries ?? []).includes("tool-running"), 30_000);
		const sections = (exec.view.value?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "system")
			.flatMap((message) => Object.entries(message.sections ?? {}))
			.filter(([key, value]) => key === "member-agents" && value !== null)
			.map(([, value]) => value as string);
		// The section is tagged by its key, with the file's text inside.
		assert.ok(
			sections.some((each) => each.includes(guidance)),
			JSON.stringify(sections),
		);
		// Its answer is reported to the main agent: leave a clean turn for the tests after.
		await until(
			chat.view,
			(value) =>
				agentMessages(value).some((each) => each.from.name === "exec-3") &&
				!(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run,
			60_000,
		);
		exec.release();
	});

	it("lets a member keep notes that become part of its instructions", async () => {
		const exec = await holdIn(owner, Chat, { session, conversation: member("exec-1").conversationId }, "participant");
		// The previous test's report chain starts a turn of the main agent: it ends before this test's messages.
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		const mark = newest(chat.view.value);
		const note = "Use pnpm, never npm, in this repository.";
		const work = [{ action: "send", name: "exec-1", message: `remember ${JSON.stringify({ text: note })}` }];
		await sendTo("lead", `delegates ${JSON.stringify(work)}`);
		await until(exec.view, (view) => JSON.stringify(view?.entries ?? []).includes("Noted."));
		const instructions = (exec.view.value?.docs["pi.agent"] as { instructions?: string }).instructions ?? "";
		assert.match(instructions, /What you have learned so far/);
		assert.ok(instructions.includes(note));
		// It has run now: an executor has no team guide, only the main agent does.
		assert.equal(sectionOf(exec.view.value, "team-lead"), undefined);
		// Its report reaches the manager, whose own answer the settle task then reports: wait for that, so the tests
		// after this one start clean.
		await until(chat.view, (view) => reportsSince(view, "lead", mark) > 0, 60_000);
		exec.release();
	});

	it("takes no message or configuration for a member from the browser, but stops", async () => {
		const sub = await holdIn(owner, Chat, { session, conversation: member("exec-2").conversationId }, "participant");
		await assert.rejects(
			sub.send({ text: "hello", requestId: "direct" }, BACKGROUND_CONTEXT),
			/Team members take no direct messages/,
		);
		await assert.rejects(
			sub.configure({ thinkingLevel: "off" }, BACKGROUND_CONTEXT),
			/Team members take no direct messages/,
		);
		assert.deepEqual(await sub.stop(BACKGROUND_CONTEXT), { restored: [] });
		sub.release();
	});

	it("tells the manager when an executor it gave work to is stopped, and the manager decides", async () => {
		const leadChat = await holdIn(
			owner,
			Chat,
			{ session, conversation: member("lead").conversationId },
			"participant",
		);
		const execChat = await holdIn(
			owner,
			Chat,
			{ session, conversation: member("exec-1").conversationId },
			"participant",
		);
		// A report from the previous test starts a turn of the main agent: it ends before this test's messages, which
		// would otherwise join it (the fake provider answers only a turn's last message).
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		const mark = newest(chat.view.value);
		const work = [{ action: "send", name: "exec-1", message: "slow-tool" }];
		await sendTo("lead", `delegates ${JSON.stringify(work)}`);
		let roster = await status();
		for (let attempt = 0; attempt < 30 && !/lead → exec-1: working/.test(roster); attempt++) {
			await sleep(300);
			roster = await status();
		}
		assert.match(roster, /lead → exec-1: working/);
		// The owner stops the executor from its conversation: the flow ends its work and tells the manager.
		await execChat.stop(BACKGROUND_CONTEXT);
		const told = await until(leadChat.view, (view) => agentMessages(view).some((each) => each.intent === "stopped"));
		const notice = agentMessages(told).find((each) => each.intent === "stopped")!;
		assert.equal(notice.from.name, "exec-1");
		assert.match(notice.text, /stopped by owner/);
		assert.match(notice.text, /do not hand it out again unless they ask/);
		// The manager answers the notice; that answer is what the main agent is told, once.
		await until(chat.view, (view) => reportsSince(view, "lead", mark) > 0, 60_000);
		await until(chat.view, (view) => !(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		assert.equal(reportsSince(chat.view.value, "lead", mark), 1);
		assert.ok(!(await status()).includes("Open work:"));
		execChat.release();
		leadChat.release();
	});

	it("stops a manager with its team, reports nothing for it, and tells it about the stop at its next work", async () => {
		const leadChat = await holdIn(
			owner,
			Chat,
			{ session, conversation: member("lead").conversationId },
			"participant",
		);
		// A report from the previous test starts a turn of the main agent: it ends before this test's messages, which
		// would otherwise join it (the fake provider answers only a turn's last message).
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		const mark = newest(chat.view.value);
		const work = [
			{ action: "send", name: "exec-1", message: "slow-tool" },
			{ action: "send", name: "exec-2", message: "slow-tool" },
		];
		await sendTo("lead", `delegates ${JSON.stringify(work)}`);
		let roster = await status();
		for (let attempt = 0; attempt < 30 && !/lead → exec-2: working/.test(roster); attempt++) {
			await sleep(300);
			roster = await status();
		}
		assert.match(roster, /lead → exec-2: working/);
		await chat.send(
			{ text: `subagent ${JSON.stringify({ action: "stop", name: "lead" })}`, requestId: `team-${++serial}` },
			BACKGROUND_CONTEXT,
		);
		const stoppedText = /^Stopped lead, exec-1, exec-2\./;
		const view = await until(chat.view, (value) =>
			results(value, "subagent").some((each) => stoppedText.test(text(each))),
		);
		const stopped = results(view, "subagent").find((each) => stoppedText.test(text(each)))!;
		assert.equal(stopped.isError, false);
		assert.doesNotMatch(text(stopped), /Could not confirm/);
		// No open work is left, and the manager's earlier answer was not reported as its last. A report in flight from an
		// earlier test lands before the stop's own checks: count again once the main agent is idle.
		assert.ok(!(await status()).includes("Open work:"));
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		assert.equal(reportsSince(chat.view.value, "lead", mark), 0);
		// New work for the stopped manager starts with what was stopped, once.
		const note = (value: ConversationView | null | undefined) =>
			textsOf(value).filter(
				(each) => each.startsWith("Your last work") && each.includes("Plan again before you continue"),
			);
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		const noteBefore = note(leadChat.view.value).length;
		await sendTo("lead", "hello again");
		await until(leadChat.view, (value) => note(value).length === noteBefore + 1);
		assert.match(note(leadChat.view.value).at(-1)!, /stopped by main/);
		await sendTo("lead", "and once more");
		await until(leadChat.view, (value) => textsOf(value).some((each) => each.includes("and once more")));
		assert.equal(note(leadChat.view.value).length, noteBefore + 1);
		leadChat.release();
	});
});
