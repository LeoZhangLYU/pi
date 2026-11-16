// Browser: a code mode script's one-shot agent opens from its card's row (read-only view); the team's members are no
// conversation entries (the main agent is the only one), and the main agent staffs them through the HR manager, their
// state shown in the Team panel. Fake provider, disposable data.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { type Child, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const SCRIPT = `return await tools.agent({ prompt: 'json {"ok":true}', label: "Check ok", schema: { type: "object" }, tools: [] });`;
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const text = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.textContent`;

describe("one-shot agents and subagent archiving in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let session: string;
	let list: RefIn<typeof Subagents, "reader">;
	let helper: Child;
	let agent: Child;

	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Agents" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		list = await holdIn(owner, Subagents, {}, "reader");
		await chat.send({ text: "subagent", requestId: "spawn" }, BACKGROUND_CONTEXT);
		await until(list.children, (value) => value?.[session]?.some((child) => child.name === "helper") === true);
		// The helper's report is a user message too: send the script once it has been answered (the HR manager's report
		// came first).
		await until(
			chat.view,
			(value) =>
				!live(value)?.run && JSON.stringify(value).includes("Echo: [answered, no reply needed] Echo: hello helper"),
			30_000,
		);
		await chat.send({ text: `codemode ${SCRIPT}`, requestId: "script" }, BACKGROUND_CONTEXT);
		const children = await until(list.children, (value) => value?.[session]?.length === 3);
		helper = children![session]!.find((child) => child.name === "helper")!;
		agent = children![session]!.find((child) => child.kind === "agent")!;
		assert.equal(agent.name, "Check ok");
		await until(chat.view, (value) => !live(value)?.run && JSON.stringify(value).includes('\\"ok\\":true'), 30_000);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 900);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("lists only named subagents in the sidebar and opens a one-shot agent from its script's row", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		// The script's turn: its activity opens the timeline, the script its calls, the agent's call its conversation.
		await browser.wait(
			`[...document.querySelectorAll('[data-testid=activity]')].at(-1) && !document.querySelector('.offline')`,
		);
		// The sidebar lists no team member: the main agent is the only conversation entry.
		assert.equal(await browser.evaluate(`document.querySelectorAll('.subagent-row').length`), 0);
		assert.equal(await browser.evaluate(`document.querySelector('.session-header.has-subagents')===null`), true);
		await browser.evaluate(`[...document.querySelectorAll('[data-testid=activity]')].at(-1).click()`);
		const script = `[...document.querySelectorAll('[data-testid=step]')].find(e=>e.textContent.startsWith('codemode'))`;
		await browser.wait(script);
		await browser.evaluate(`${script}.querySelector('button').click()`);
		const call = `[...document.querySelectorAll('[data-testid=call]')].find(e=>e.textContent.includes('Asked an agent Check ok'))`;
		await browser.wait(call);
		await browser.evaluate(`${call}.querySelector('button').click()`);
		await browser.wait(`document.querySelector('[data-testid=nested-open]')`);
		await browser.click("[data-testid=nested-open]");
		await browser.wait(
			`location.pathname.endsWith('/c/${agent.conversationId}') && document.querySelector('.topbar .sub-tag')?.textContent==='agent'`,
		);
		assert.equal(await browser.evaluate(text(".topbar h1")), "agent Check ok");
		await browser.wait(`document.querySelector('.subagent-wrap .subagent-bar')`);
		assert.equal(
			await browser.evaluate(text(".subagent-wrap .subagent-bar span")),
			"One-shot agent of a script · read-only · Tools: none",
		);
		// Read-only: no composer, no model chip, no Archive; it shows its transcript.
		await browser.wait(`document.querySelector('.scroller')?.textContent.includes('{"ok":true}')`);
		assert.equal(await browser.evaluate(`document.querySelector('.composer')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.model-control')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.subagent-bar .text-action')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.subagent-row.active')===null`), true);
	});

	it("stops a working one-shot agent from its bar", async () => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send(
			{
				text: `codemode return await tools.agent({ prompt: "slow agent", label: "Slow", schema: { type: "object" } });`,
				requestId: "slow-script",
			},
			BACKGROUND_CONTEXT,
		);
		const children = await until(list.children, (value) => value?.[session]?.length === 4);
		const slow = children![session]!.find((child) => child.name === "Slow")!;
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${slow.conversationId}`);
		await browser.metrics(390, 844);
		await browser.wait(`document.querySelector('.subagent-bar .round.stop')`);
		// The read-only view has no composer, so its bar carries the scroll-to-bottom button.
		await browser.wait(
			`(() => { const e=document.querySelector('.scroller');return e && e.scrollHeight > e.clientHeight + 300; })()`,
		);
		const center = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r=document.querySelector('.scroller').getBoundingClientRect();return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: -3000 });
		await browser.wait(`document.querySelector('.subagent-wrap .to-bottom')`);
		await browser.click(".subagent-wrap .to-bottom");
		await browser.wait(`document.querySelector('.subagent-wrap .to-bottom')===null`);
		await browser.click(".subagent-bar .round.stop");
		await browser.wait(`document.querySelector('.subagent-bar .round.stop')===null`);
		// The script's call rejects: the agent did not answer.
		const view = await until(
			chat.view,
			(value) => !live(value)?.run && JSON.stringify(value).includes("The agent did not answer"),
			30_000,
		);
		assert.ok(view);
		chat.release();
		await browser.metrics(1280, 900);
	});

	it("gives a member's conversation no entry: its link opens the main conversation, where the main agent staffs it", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${helper.conversationId}`);
		// The main agent is the team's only entry: a member's conversation opens the session's main one.
		await browser.wait(`location.pathname==='/s/${session}' && document.querySelector('.composer textarea')!==null`);
		assert.equal(await browser.evaluate(`document.querySelectorAll('.subagent-row').length`), 0);
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "subagent-archive", requestId: "archive-ui" }, BACKGROUND_CONTEXT);
		await until(
			list.children,
			(value) => value?.[session]?.find((child) => child.name === "helper")?.archived === true,
		);
		// The Team panel shows the state; it is not an entry either.
		await browser.click("[data-testid=team-button]");
		await browser.wait(`document.querySelector('#side-dock [data-testid=team-panel]')`);
		assert.match(
			String(
				await browser.evaluate(
					`[...document.querySelectorAll('[data-testid=team-member]')].find(e=>e.querySelector('strong').textContent==='helper').textContent`,
				),
			),
			/Archived/,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('[data-testid=team-member]')].find(e=>e.querySelector('strong').textContent==='helper').click()`,
		);
		assert.equal(await browser.evaluate(`location.pathname`), `/s/${session}`, "a member row goes nowhere");
		// The HR manager's report of the archive starts a turn of the main agent: the restore must not join it.
		await until(
			chat.view,
			(value) =>
				JSON.stringify(value?.entries ?? []).includes('Echo: staff {\\"action\\":\\"archive\\"') &&
				!live(value)?.run,
			30_000,
		);
		await chat.send({ text: "subagent-restore", requestId: "restore-ui" }, BACKGROUND_CONTEXT);
		await until(list.children, (value) => !value?.[session]?.find((child) => child.name === "helper")?.archived);
		await browser.wait(
			`![...document.querySelectorAll('[data-testid=team-member]')].find(e=>e.querySelector('strong').textContent==='helper').textContent.includes('Archived')`,
		);
		// The HR manager's report of the restore starts a turn of the main agent: it ends before the next test sends.
		await until(
			chat.view,
			(value) =>
				JSON.stringify(value?.entries ?? []).includes('Echo: staff {\\"action\\":\\"restore\\"') &&
				!live(value)?.run,
			30_000,
		);
		chat.release();
	});

	it("opens the Team panel docked on wide screens and as a sheet on phones; no row is an entry", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('[data-testid=team-button]')`);
		// The panel may have been left open: the button would close it.
		if (await browser.evaluate(`document.querySelector('[data-testid=team-panel]')!==null`)) {
			await browser.click("[data-testid=team-button]");
			await browser.wait(`document.querySelector('[data-testid=team-panel]')===null`);
		}
		// The team: the HR manager and helper; the scripts' one-shot agents are not members.
		await browser.wait(`document.querySelector('[data-testid=team-button] span')?.textContent==='2'`);
		await browser.click("[data-testid=team-button]");
		await browser.wait(`document.querySelector('#side-dock [data-testid=team-panel]')`);
		const members = await browser.evaluate<string[]>(
			`[...document.querySelectorAll('[data-testid=team-member] strong')].map(e=>e.textContent)`,
		);
		assert.equal(members[0], "hr", "the HR manager first");
		assert.deepEqual(members.toSorted(), ["helper", "hr"]);
		// The work given out, newest first: the HR manager's requests and the members' work, each ended.
		await browser.wait(`document.querySelector('[data-testid=team-work]')`);
		const work = await browser.evaluate<{ text: string; status: string }[]>(
			`[...document.querySelectorAll('[data-testid=team-work]')].map(e=>({text:e.querySelector('strong').textContent,status:e.dataset.status}))`,
		);
		assert.ok(work.length > 0);
		assert.ok(work.some((each) => / main → hr$/.test(each.text)));
		assert.ok(work.some((each) => / main → helper$/.test(each.text) && each.status === "done"));
		// Read only: no buttons inside but Close (and the resize handle).
		assert.equal(
			await browser.evaluate(
				`document.querySelectorAll('[data-testid=team-panel] button:not(.side-panel-resize)').length`,
			),
			1,
		);
		assert.equal(
			await browser.evaluate(
				`[...document.querySelectorAll('[data-testid=team-member]')].every((e)=>e.tagName==='DIV')`,
			),
			true,
		);
		// On a phone the panel is a sheet (closed first: an open dock would become the sheet over the header).
		await browser.click(".side-panel button[aria-label=Close]");
		await browser.wait(`document.querySelector('[data-testid=team-panel]')===null`);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.metrics(390, 844);
		await browser.wait(`document.querySelector('[data-testid=team-button]')`);
		await browser.click("[data-testid=team-button]");
		await browser.wait(
			`document.querySelector('[data-testid=team-panel]') && !document.querySelector('#side-dock [data-testid=team-panel]')`,
		);
		await browser.metrics(1280, 900);
	});
});
