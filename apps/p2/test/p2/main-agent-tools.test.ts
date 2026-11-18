// A session's main agent follows the worker's registry: a fixed tool list, which the removed Familiar wrote, is
// cleared at start, so tools added since (the team's `subagent`) reach the main agent and the members that start from
// its tools. A conversation's chosen tools and tool search's loaded deferred tools stay.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentDoc, createRegistry, Harness as DurableHarness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { createP2Models } from "../../plugins/models/models.ts";
import { createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { MainDoc } from "../../src/runtime/main-conversation.ts";
import { HOST } from "../../src/runtime/principals.ts";
import { openSessionStorage } from "../../src/runtime/session-store.ts";
import {
	HarnessConfig,
	HarnessHost,
	HarnessNative,
	Liveness,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { APP } from "./helpers.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };
const context = durableContext(new AbortController().signal);

/**
 * A session as the Familiar left it: its main conversation has the fixed tool lists, a branch has only a deferred tool
 * loaded by tool search, and a member has its own tools.
 */
async function seed(dataDir: string, cwd: string) {
	const session = await openSessionStorage(dataDir, "s1", context);
	const durable = await DurableHarness.open(
		session.storage,
		{ models: createP2Models(true), registry: createRegistry() },
		context,
	);
	try {
		const root = await durable.root(context, { agent: { model: MODEL, cwd } });
		const branch = await durable.createConversation({ ownership: { kind: "ownerless" } }, context);
		const member = await durable.createConversation({ ownership: { kind: "ownerless" } }, context);
		await durable.commit(async (tx) => {
			const main = await tx.doc(AgentDoc, root.id);
			main.model = MODEL;
			main.cwd = cwd;
			main.tools = [
				"conversations",
				"codemode",
				"history_search",
				"history_read",
				"history_handoff",
				"agent",
				"bash",
				"read",
			];
			main.modelTools = ["conversations", "codemode", "history_search", "history_read", "history_handoff"];
			const forked = await tx.doc(AgentDoc, branch.id);
			forked.model = MODEL;
			forked.cwd = cwd;
			forked.modelTools = { add: ["powershell"] };
			const child = await tx.doc(AgentDoc, member.id);
			child.tools = ["bash", "team"];
			child.modelTools = { add: ["team"] };
			(await tx.doc(MainDoc)).branches = [
				{ conversation: root.id, label: null },
				{ conversation: branch.id, label: "Branch" },
			];
		}, context);
		return { root: root.id, branch: branch.id, member: member.id };
	} finally {
		await durable.close(context);
		await session.close();
	}
}

const models = defineFacet((_host, self) =>
	self.contribute(HarnessConfig, { default: { models: () => createP2Models(true), settings: () => ({}) } }),
);

/** The worker's core over `dataDir`, its Harness open (`HarnessHost` held). */
async function start(dataDir: string, cwd: string) {
	const store = await openHostStore(sessionDirectory(dataDir, "s1"), { outbox: false }, BACKGROUND_CONTEXT);
	const host = createHost({
		address: Session({ id: "s1" }),
		principal: HOST,
		store,
		onError: (error) => console.error(error),
	});
	const init: WorkerInit = {
		app: APP,
		dataDir,
		fake: true,
		generation: 1,
		values: { session: { id: "s1", cwd, env: null, model: MODEL, thinkingLevel: "off" } },
	};
	const location = new SessionLocation({ cwd, env: null });
	const core = workerCore(init, new Liveness(), location, store, (fn) => host.root(fn, BACKGROUND_CONTEXT));
	await host.load(
		[
			{ name: "@p2/core", facet: core },
			{ name: "models", facet: models },
		],
		BACKGROUND_CONTEXT,
	);
	const holder = host.hold(HarnessHost, {}, BACKGROUND_CONTEXT);
	await whenLive(holder);
	const durable = (await host.registry(HarnessNative, BACKGROUND_CONTEXT)).value!.durable;
	return { host, store, durable, release: () => holder.release() };
}

test("the main agent drops the Familiar's fixed tools at start; chosen and loaded tools stay", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-main-agent-tools-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const project = join(directory, "project");
	mkdirSync(project);
	const dataDir = join(directory, "data");
	const ids = await seed(dataDir, project);
	const { host, store, durable, release } = await start(dataDir, project);
	try {
		const main = await durable.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
		assert.equal(main?.tools, undefined, "the main agent follows the registry");
		assert.equal(main?.modelTools, undefined);
		assert.deepEqual(main?.model, MODEL);
		assert.equal(main?.cwd, project, "the rest of the agent stays");
		// A loaded deferred tool (tool search) is `modelTools.add`, not a fixed list: it stays.
		const branch = await durable.snapshot(AgentDoc, ids.branch, context);
		assert.equal(branch?.tools, undefined);
		assert.deepEqual(branch?.modelTools, { add: ["powershell"] });
		// A member's own tools are not the main agent's.
		const member = await durable.snapshot(AgentDoc, ids.member, context);
		assert.deepEqual(member?.tools, ["bash", "team"]);
		assert.deepEqual(member?.modelTools, { add: ["team"] });
	} finally {
		release();
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	}
});
