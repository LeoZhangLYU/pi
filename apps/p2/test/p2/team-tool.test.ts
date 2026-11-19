// The team tool's delivery: a member may steer another member's turn, and nothing a member says ever steers the main
// agent's. Durable acts on the submission's `whenBusy`, so the test reads that from the submission itself rather than
// from what the tool reports about it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Subagent, type SubagentState, Subagents } from "../../plugins/subagents/contract.worker.ts";
import { teamExtension } from "../../plugins/subagents/tools.ts";
import { MainDoc } from "../../src/runtime/main-conversation.ts";

const MAIN = 1;
const SOLO = 3;
const MATE = 4;

// A conversation ID is a branded number: the fixtures use plain ones.
const member = (conversationId: number, extra: Partial<Subagent> = {}): Subagent => ({
	conversationId: conversationId as ConversationId,
	model: "faux/faux-1",
	thinkingLevel: "off",
	tools: [],
	reported: [],
	role: "executor",
	...extra,
});

/** Two direct executors (contacts of each other) and a manager; the main conversation is conversation 1. */
const registry: SubagentState = {
	agents: { lead: member(2, { role: "manager" }), solo: member(SOLO), mate: member(MATE) },
	reporters: {},
};

/** The tool's call as `solo` (conversation 3) makes it, and the submissions it made: whom to, and `whenBusy`. */
function asSolo() {
	const submissions: { to: number; whenBusy: string | undefined }[] = [];
	const api = {
		conversationId: SOLO,
		taskId: 7,
		callId: "call",
		snapshot: async (doc: { definition: { kind: string } }) => {
			if (doc.definition.kind === Subagents.definition.kind) return registry;
			if (doc.definition.kind === MainDoc.definition.kind)
				return { conversation: MAIN, branches: [{ conversation: MAIN, label: null }] };
			// No run of its own: the turn has no origin to pass on.
			return undefined;
		},
		conversation: async (id: number) => ({
			submit: async (draft: { whenBusy?: string }) => {
				submissions.push({ to: id, whenBusy: draft.whenBusy });
			},
		}),
	} as unknown as ToolExecutionApi;
	const [team] = teamExtension.tools ?? [];
	assert.ok(team, "the team extension has its tool");
	const send = async (args: { to: string; steer?: boolean }) => {
		const result = await team.execute({ action: "send", message: "fyi", intent: "note", ...args }, api, {} as never);
		const details = result.details as { steered?: boolean } | undefined;
		const text = result.output?.[0]?.type === "text" ? result.output[0].text : "";
		return { text, steered: details?.steered, isError: result.isError === true };
	};
	return { send, submissions };
}

describe("the team tool's delivery", () => {
	it("steers a member's turn only when asked to, and never the main agent's", async () => {
		const { send, submissions } = asSolo();
		// To the main agent: a steer is refused and the message queues (whenBusy is what Durable acts on).
		const steeredMain = await send({ to: "parent", steer: true });
		assert.deepEqual(submissions.at(-1), { to: MAIN, whenBusy: "followUp" });
		assert.equal(steeredMain.steered, false);
		assert.match(steeredMain.text, /never joins its current turn/);
		const plainMain = await send({ to: "parent" });
		assert.deepEqual(submissions.at(-1), { to: MAIN, whenBusy: "followUp" });
		assert.equal(plainMain.text, "Sent to parent.");
		// To another member: queued by default, steered when asked.
		const plainMate = await send({ to: "mate" });
		assert.deepEqual(submissions.at(-1), { to: MATE, whenBusy: "followUp" });
		assert.equal(plainMate.steered, false);
		const steeredMate = await send({ to: "mate", steer: true });
		assert.deepEqual(submissions.at(-1), { to: MATE, whenBusy: "steer" });
		assert.equal(steeredMate.steered, true);
		assert.equal(submissions.length, 4);
	});

	it("refuses a message to someone who is not a contact, and submits nothing", async () => {
		const { send, submissions } = asSolo();
		// A direct executor's contacts are the other direct executors: not the manager.
		const refused = await send({ to: "lead", steer: true });
		assert.equal(refused.isError, true);
		assert.deepEqual(submissions, []);
	});
});
