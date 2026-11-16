// Persistent background subagents, adapted from pi-durable's
// test/examples/23-subagent-background.ts (MIT; see third-party/pi.LICENSE).
// Adds per-subagent model, thinking level and tool selection, and an optional own location (environment and cwd).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	type ConversationHandle,
	type ConversationId,
	type Cursor,
	type DocumentReader,
	defineExtension,
	defineTask,
	type EntryId,
	type Harness,
	InboxDoc,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
	type Submission,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { bool, compile, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context, JsonValue } from "@p2/app/v1";
import { type Location, type LocationInput, literal, senderText } from "@p2/app/v1";
import { answerOrigin, defineP2Tool, mainConversation, originOf, type P2Tool } from "@p2/app/v1/worker";
import { AGENT_MESSAGE_ENTRY, type AgentMessage, SUBAGENT_TASK_ENTRY, SubagentLocationsSchema } from "./contract.ts";
import {
	CODEMODE_TOOL,
	type Delegation,
	type DelegationStoppedHandler,
	InheritedLocation,
	type Role,
	roleOf,
	type StopNotice,
	type Subagent,
	type SubagentState,
	Subagents,
	TEAM_TOOL,
	type ToolChoice,
} from "./contract.worker.ts";
import {
	delegationOf,
	endDelegation,
	memberOf,
	openDelegations,
	peersOf,
	replyFor,
	replyToMember,
	roleText,
	stopNoteFor,
} from "./team.ts";

export const SUBAGENT_EXTENSION = "subagent-tools";

/** Background work of the calling conversation: its Stop and idle waits do not reach it (a report, a delegation). */
export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/**
 * Background work on conversation 1, whoever creates it: a member's anchor, so stopping the HR manager or a manager that
 * hired it never reaches the member, and a `/tree` branch's Stop does not either.
 */
export const ANCHORED = { ...BACKGROUND, conversationId: ROOT_CONVERSATION_ID } as const;

// Owns a member's conversation. Background and immediately terminal, so no conversation's Stop and idle waits reach the
// member; abort({background}) still does.
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "p2.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * A message queued behind the subagent's current run is placed when that run ends. If the run fails, Durable keeps it
 * queued and nothing places it: the subagent goes idle with the message still queued, and the reporter would wait
 * forever (keeping the worker busy). Withdraw it then; `undefined` means withdrawn.
 */
export async function settledOrWithdrawn(
	submission: Submission,
	subagent: ConversationHandle,
	pause: () => Promise<void>,
	context: Context,
): Promise<SettledSubmissionRecord | undefined> {
	const settled = submission.wait(context);
	for (;;) {
		const idle = subagent.waitForIdle(context).then(() => true);
		if (!(await Promise.race([settled.then(() => false), idle]))) return settled;
		if ((await submission.status(context)).status !== "queued") return settled;
		// Idle while still queued: let an admission in flight settle, then withdraw.
		await pause();
		if ((await submission.status(context)).status !== "queued") return settled;
		if ((await submission.abort(context)) === "aborted") return undefined;
	}
}

/** Wait `ms` on the Harness timer inside a phase; rejects when `context` is cancelled, as when the invocation ends. */
function pause(runtime: { setTimer(callback: () => void, delayMs: number): () => void }, ms: number, context: Context) {
	return new Promise<void>((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			disarm();
			reject(signal?.reason);
		};
		const disarm = runtime.setTimer(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const undelivered = "its previous run failed before this message was delivered; send it again";

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * A subagent's message as an input: the structural entry readers use, and what the model reads: the sender block, then
 * the intent and the text. `replyWith` is the tool call that answers a question (the main agent's `subagent send`, a
 * sibling's `team send`).
 */
function agentMessageInput(message: AgentMessage, replyWith: string) {
	const label = {
		answered: "answered, no reply needed",
		failed: "failed",
		question: `asks; answer with ${replyWith}`,
		note: "notes, no reply needed",
		stopped: "stopped",
	}[message.intent];
	return {
		content: [
			{ type: "text" as const, text: senderText({ kind: "subagent", name: message.from.name }) },
			{ type: "text" as const, text: `[${label}] ${message.text}` },
		],
		entry: { kind: AGENT_MESSAGE_ENTRY, data: message as unknown as JsonValue },
	};
}

/**
 * A conversation's newest assistant reply and its latest completed ("stop") answer with text (with its entry): a
 * bounded, read-only, newest-first scan.
 */
async function scanReplies(
	tx: Tx,
	conversationId: ConversationId,
): Promise<{ last?: AssistantMessage; answer?: { id: EntryId; text: string } }> {
	let last: AssistantMessage | undefined;
	let cursor: Cursor | undefined;
	for (let scanned = 0; scanned < 2000; ) {
		const page = await tx.scanEntries({ conversationId }, 200, cursor);
		for (const entry of page.items) {
			scanned++;
			const message = AssistantEntry.is(entry) ? (entry.model?.[0] as AssistantMessage | undefined) : undefined;
			if (!message) continue;
			last ??= message;
			if (message.stopReason === "stop" && textOf(message).trim())
				return { last, answer: { id: entry.id, text: textOf(message) } };
		}
		if (!page.next) break;
		cursor = page.next;
	}
	return { ...(last ? { last } : {}) };
}

/** The latest completed ("stop") answer with text of a conversation. */
export async function latestAnswer(api: ToolExecutionApi, conversationId: ConversationId, context: Context) {
	return (await api.commit((tx) => scanReplies(tx, conversationId), context)).answer?.text;
}

// Delivers one message, waits for the answer, then reports it to the conversation that sent the message
// as a follow-up input. Request IDs make both submissions exactly-once across restarts.
export type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	/**
	 * The conversation that sent the message, which the report goes to: a `/tree` branch left while the subagent works
	 * still gets its answer. Absent (checkpointed before it was recorded): the current main conversation.
	 */
	parent?: ConversationId;
	message: string;
	followUp: boolean;
	/** The owner started the main agent's turn: the subagent's turn inherits it (`SUBAGENT_TASK_ENTRY`). */
	origin?: "owner";
	/**
	 * The delegation this message is (the registry's `delegations`), which the report ends. Absent: a reporter created
	 * before delegations, which reports as it did.
	 */
	delegation?: number;
};
/**
 * `report`: what to tell the main agent, with the origin of the subagent's run that answered (`answerOrigin`); a
 * failure the reporter itself describes has the task's.
 */
type Report = { intent: "answered" | "failed"; text: string; origin?: "owner" };
/**
 * How the delegation ends once its report is submitted: ending it earlier would let a manager's settle task see it done
 * before the message that tells the manager reached it.
 */
type End = { status: "done" | "failed" | "stopped"; result?: string; by?: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: Report; end?: End };

/** `Promise.race` marker: the phase's wait ran long, so it commits a durable sleep and waits again. */
const recheck = "recheck";

/**
 * Ensures manager `name` has a settle task, in the commit that changed one of its delegations. Reads the claimed task
 * (a task-table read), so callers run it before the commit's first table write.
 */
async function ensureSettle(tx: Tx, state: SubagentState, name: string): Promise<void> {
	const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
	if (!agent || roleOf(agent) !== "manager") return;
	if (agent.settling !== undefined) {
		// The claim is only a task ID: a task that ended without clearing it (faulted after restarts, or aborted) must not
		// keep later waiting delegations from having a settle task of their own.
		const claimed = (await tx.task(agent.settling))?.state.status;
		if (
			claimed === "pending" ||
			claimed === "running" ||
			claimed === "waiting" ||
			claimed === "sleeping" ||
			claimed === "completing"
		)
			return;
		delete agent.settling;
	}
	agent.settling = await tx.createTask(Settle, { manager: name }, ANCHORED);
}

/**
 * Ensures the settle tasks of the managers `delegation` is between (its giver and its member): the same commit, before
 * its table writes (`seen` keeps one call per manager across several delegations of that commit).
 */
export async function ensureSettleFor(
	tx: Tx,
	state: SubagentState,
	delegation: Delegation,
	seen: Set<string> = new Set(),
): Promise<void> {
	for (const name of new Set([delegation.from, delegation.to])) {
		if (seen.has(name)) continue;
		seen.add(name);
		await ensureSettle(tx, state, name);
	}
}
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "p2.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const { name, conversationId, message, followUp, origin } = reporter.input;
			// Work stopped before it was delivered is not delivered.
			const before = delegationOf(
				(await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {},
				reporter.input.delegation,
			)?.status;
			if (before === "stopping" || before === "stopped") {
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report" } }) as const, context);
				return;
			}
			const subagent = await runtime.conversation(conversationId, context);
			if (!subagent) throw new Error(`Subagent ${name} has no conversation`);
			const submission = await subagent.submit(
				{
					type: "input",
					content: message,
					...(origin ? { entry: { kind: SUBAGENT_TASK_ENTRY, data: { origin } } } : {}),
					whenBusy: followUp ? "followUp" : "steer",
					requestId: `subagent:${reporter.id}`,
				},
				context,
			);
			// Waiting inside the phase is cut off by every restart, and after the restart limit the task faults: the wait
			// below re-checks durably every so often, resuming the same submission (its request ID dedupes the submit).
			const settled: SettledSubmissionRecord | undefined | "recheck" = await Promise.race([
				settledOrWithdrawn(submission, subagent, () => pause(runtime, 1000, context), context),
				pause(runtime, 10_000, context).then((): "recheck" => recheck),
			]);
			if (settled === recheck) {
				await runtime.commit(
					() =>
						({
							status: "sleeping",
							until: runtime.now() + 1000,
							checkpoint: { phase: "deliver" },
						}) as const,
					context,
				);
				return;
			}
			await runtime.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const id = reporter.input.delegation;
				const next = (report?: Report, end?: End) =>
					({
						status: "running",
						checkpoint: { phase: "report", ...(report ? { report } : {}), ...(end ? { end } : {}) },
					}) as const;
				const failed = (text: string): Report => ({ intent: "failed", text, ...(origin ? { origin } : {}) });
				// Being stopped, or stopped: the stop ends the delegation, and nothing is reported.
				const delegation = delegationOf(state, id);
				if (delegation?.status === "stopping" || delegation?.status === "stopped") return next();
				// A manager's answer is not the end of its work: its team may still be working. It waits, and the manager's
				// settle task reports once the team is done (a message that never reached it, or a stop, is reported now).
				const agent = state.agents[name];
				const waits = delegation !== undefined && agent !== undefined && roleOf(agent) === "manager";
				const wait = async (answer?: EntryId) => {
					// Before the writes below: it reads the manager's claimed settle task.
					await ensureSettle(tx, state, name);
					if (delegation) {
						delegation.status = "waiting";
						// The delegation keeps its own answer: the settle task reports that, not a later or earlier turn of the
						// manager (a `team send` question it answers meanwhile).
						if (answer !== undefined) delegation.answer = answer;
					}
					return next();
				};
				if (settled === undefined) return next(failed(undelivered), { status: "failed", result: undelivered });
				if (settled.status === "unanswered") {
					if (settled.reason === "aborted") {
						// Aborted outside a stop: stop the member's work the same way, so whoever gave work hears of it.
						await startStop(tx, { member: name, by: "system" });
						return next();
					}
					if (waits) return wait();
					return next(failed(settled.reason), { status: "failed", result: settled.reason });
				}
				// A continue settles like an input (it has no placed entry): its run's answer is reported the same way.
				if (settled.type !== "input" && settled.type !== "continue") return next(undefined, { status: "done" });
				if (waits) return wait(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				const text = textOf(answer);
				const end: End = { status: "done", result: text };
				// Several messages can end in one answer: it is reported once per conversation that gave the work (two
				// branches giving work that one run answers both hear of it). A registry without keys keeps the old rule.
				const key = `${settled.answer}:${reporter.input.parent ?? "main"}`;
				const already =
					agent?.reportedTo === undefined
						? agent.reported.includes(settled.answer)
						: agent.reportedTo.includes(key);
				if (!agent || already) return next(undefined, end);
				if (agent.reportedTo === undefined) agent.reportedTo = [];
				agent.reportedTo.push(key);
				agent.reported.push(settled.answer);
				const answered = await answerOrigin(tx, conversationId, settled.answer);
				return next({ intent: "answered", text, ...(answered ? { origin: answered } : {}) }, end);
			}, context);
		},
		report: async (reporter, runtime, context) => {
			const { report, end } = reporter.state.checkpoint;
			const { name, conversationId, parent, delegation: id } = reporter.input;
			const target =
				report === undefined
					? undefined
					: await runtime.conversation(parent ?? (await mainConversation(runtime, context)), context);
			// Delivering the report and ending the delegation are one decision: a stop that commits in between sees either
			// the work still open or the delegation already reported and done.
			const registry = await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
			const status = delegationOf(registry ?? {}, id)?.status;
			const stopped = status === "stopping" || status === "stopped";
			if (report !== undefined && !stopped && target)
				await target.submit(
					{
						type: "input",
						...agentMessageInput(
							{ from: { name, conversationId }, ...report },
							replyFor(registry?.agents[name], name),
						),
						whenBusy: "followUp",
						requestId: `subagent-report:${reporter.id}`,
					},
					context,
				);
			await runtime.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const ending = delegationOf(state, id)?.status;
				// Only work still going ends here: a stop ends its own.
				if (end !== undefined && (ending === "working" || ending === "waiting")) {
					const delegation = delegationOf(state, id);
					if (delegation) await ensureSettleFor(tx, state, delegation);
					endDelegation(state, id, end.status, runtime.now(), end.result, end.by);
				}
				return { status: "terminal", outcome: { status: "completed", result: null } } as const;
			}, context);
		},
	},
	abort: (_reporter, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** What a settle task tells the conversation that gave a manager its work. */
type SettleReport = { parent: ConversationId; intent: "answered" | "failed"; text: string; origin?: "owner" };
type SettleState = { phase: "check"; round: number; stuck: number } | { phase: "report"; reports: SettleReport[] };

/**
 * Reports a manager's answer once its team is done. A manager's answer to work it was given waits (`Delegation.status`
 * `waiting`) while the executors it gave work to may still be working: this task, at most one per manager, watches until
 * the manager is idle with nothing queued and none of the work it gave out or was newly given is open, then ends the
 * waiting delegations with its latest answer and reports it, once per conversation that gave it work. It ends when the
 * team is not done yet: the delegations' next change creates it again (`ensureSettle`).
 */
export const Settle = defineTask<{ manager: string }, SettleState, null>({
	name: "p2.team-settle",
	version: 1,
	initial: () => ({ phase: "check", round: 0, stuck: 0 }),
	phases: {
		check: async (settle, runtime, context) => {
			const { manager } = settle.input;
			const { round, stuck } = settle.state.checkpoint;
			await runtime.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const agent = Object.hasOwn(state.agents, manager) ? state.agents[manager] : undefined;
				const finish = () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;
				if (!agent) return finish();
				const done = () => {
					if (agent.settling === settle.id) delete agent.settling;
					return finish();
				};
				// Waiting inside the phase is cut off by every restart; a sleep is durable, and a message on its way (a
				// report of an executor) gets the second between checks to be queued.
				const again = (stuckRuns: number) =>
					({
						status: "sleeping",
						until: runtime.now() + 1000,
						checkpoint: { phase: "check", round: round + 1, stuck: stuckRuns },
					}) as const;
				const waiting = Object.values(state.delegations ?? {}).filter(
					(each) => each.to === manager && each.status === "waiting",
				);
				if (waiting.length === 0) return done();
				// Work it gave out, or was given since: when that ends, the delegation's change creates this task again.
				const open = openDelegations(state).some(
					(each) =>
						(each.from === manager && each.status !== "waiting") ||
						(each.to === manager && each.status === "working"),
				);
				if (open) return done();
				const running = (await tx.doc(LiveDoc, agent.conversationId)).run !== undefined;
				if (running) return again(0);
				const queued = (await tx.doc(InboxDoc, agent.conversationId)).items.some((item) => item.mode !== "write");
				// Idle with input still queued, twice running: its last run failed before taking it.
				if (queued && stuck < 1) return again(stuck + 1);
				const replies = await scanReplies(tx, agent.conversationId);
				const failure = queued
					? undelivered
					: replies.last?.stopReason === "error"
						? replies.last.errorMessage || "its last run failed"
						: undefined;
				// The answer each waiting delegation got, not the manager's newest reply: a `team send` question it answered
				// meanwhile belongs to its sender, not to the work that waits. Delegations from before the answer was
				// recorded fall back to the conversation's latest answer.
				const answers = waiting.flatMap((each) => (each.answer === undefined ? [] : [each.answer]));
				const newest = answers.length ? answers.reduce((a, b) => (a > b ? a : b)) : undefined;
				const fallback = answers.length === 0 && waiting.some((each) => each.answer === undefined);
				const answerId = newest ?? (fallback ? replies.answer?.id : undefined);
				const answerText =
					newest === undefined
						? fallback
							? (replies.answer?.text ?? "")
							: ""
						: textOf((await tx.entry(AssistantEntry, newest))?.model?.[0] as AssistantMessage | undefined);
				const reason = failure ?? (answerText.trim() ? undefined : "it gave no answer");
				const now = runtime.now();
				const text = reason ?? answerText;
				const answered =
					reason === undefined && answerId !== undefined
						? await answerOrigin(tx, agent.conversationId, answerId)
						: undefined;
				if (reason === undefined && answerId !== undefined && !agent.reported.includes(answerId))
					agent.reported.push(answerId);
				const reports: SettleReport[] = [];
				for (const each of waiting) {
					endDelegation(state, each.id, reason === undefined ? "done" : "failed", now, text);
					if (!reports.some((report) => report.parent === each.parent))
						reports.push({
							parent: each.parent,
							intent: reason === undefined ? "answered" : "failed",
							text,
							...(answered ? { origin: answered } : {}),
						});
				}
				// Cleared with the claim: work given to the manager from now on settles through a task of its own.
				if (agent.settling === settle.id) delete agent.settling;
				return { status: "running", checkpoint: { phase: "report", reports } } as const;
			}, context);
		},
		report: async (settle, runtime, context) => {
			const { manager } = settle.input;
			const agent = (await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context))?.agents[manager];
			const reports = settle.state.checkpoint.reports;
			const targets = new Map<ConversationId, Awaited<ReturnType<typeof runtime.conversation>>>();
			for (const report of reports) {
				if (targets.has(report.parent)) continue;
				targets.set(report.parent, await runtime.conversation(report.parent, context));
			}
			// Each report is admitted before the terminal commit, with a stable request ID, so a restart cannot deliver it
			// twice; a manager's settle task reports once the work it gave out has ended.
			for (const report of reports) {
				if (!agent) break;
				await targets.get(report.parent)?.submit(
					{
						type: "input",
						...agentMessageInput(
							{
								from: { name: manager, conversationId: agent.conversationId },
								intent: report.intent,
								text: report.text,
								...(report.origin ? { origin: report.origin } : {}),
							},
							replyFor(agent, manager),
						),
						whenBusy: "followUp",
						requestId: `team-settle:${settle.id}:${report.parent}`,
					},
					context,
				);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	// An aborted or faulted settle frees its claim, so later work gets a settle task of its own.
	abort: (settle, runtime, context) =>
		runtime.commit(async (tx) => {
			const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
			const agent = Object.hasOwn(state.agents, settle.input.manager)
				? state.agents[settle.input.manager]
				: undefined;
			if (agent?.settling === settle.id) delete agent.settling;
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context),
});

let readStoppedHandlers: () => readonly DelegationStoppedHandler[] = () => [];
/** Binds the stop flow to the worker's `DelegationStopped` registry (a Harness task has no access to Chord registries). */
export function bindStoppedHandlers(read: () => readonly DelegationStoppedHandler[]): void {
	readStoppedHandlers = read;
}

/** A stop of `member` (a manager's covers its executors) by `by`: "main", "owner", "hr", "system" or a manager's name. */
export type StopInput = { member: string; by: string; archive?: boolean };
/** What a stop did: the members it covered, the delegations it stopped, and whether their runs were confirmed ended. */
export type StopResult = { names: string[]; stopped: number[]; verified: boolean };
type StopState =
	| { phase: "mark" }
	| { phase: "abort"; names: string[]; delegations: number[] }
	| { phase: "verify"; names: string[]; delegations: number[] }
	| { phase: "finish"; names: string[]; delegations: number[]; verified: boolean };

/** The members a stop of `member` covers: a manager and its executors, any other member alone, none when it is gone. */
function stopScope(state: Pick<SubagentState, "agents">, member: string): string[] {
	const agent = Object.hasOwn(state.agents, member) ? state.agents[member] : undefined;
	if (!agent) return [];
	if (roleOf(agent) !== "manager") return [member];
	return [
		member,
		...Object.entries(state.agents)
			.filter(([, each]) => roleOf(each) === "executor" && each.manager === member)
			.map(([name]) => name),
	];
}

/**
 * The one way work given to members stops (`subagent stop`, `delegate stop`, the HR manager archiving, the owner's Stop
 * button, a turn aborted by something else). It marks the members stopping (nothing more reaches them: the send tools
 * and the Reporter refuse), aborts their runs, confirms nothing runs or waits in them, tells whoever gave the work
 * through the `DelegationStopped` hooks, then ends the stopped work. A second stop of a member waits for the first.
 */
export const Stop = defineTask<StopInput, StopState, StopResult>({
	name: "p2.team-stop",
	version: 1,
	initial: () => ({ phase: "mark" }),
	phases: {
		mark: async (stop, runtime, context) => {
			await runtime.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const names = stopScope(state, stop.input.member);
				if (names.length === 0)
					return {
						status: "terminal",
						outcome: { status: "completed", result: { names: [], stopped: [], verified: true } },
					} as const;
				// Another stop of one of them is in progress: this one starts when it has ended.
				const other = names
					.map((name) => state.agents[name]?.stopping)
					.find((id) => id !== undefined && id !== stop.id);
				if (other !== undefined)
					return { status: "waiting", checkpoint: { phase: "mark" }, on: [other], policy: "allSettled" } as const;
				const delegations: number[] = [];
				for (const name of names) {
					const agent = state.agents[name];
					if (agent) agent.stopping = stop.id;
				}
				for (const delegation of openDelegations(state)) {
					if (!names.includes(delegation.to)) continue;
					delegation.status = "stopping";
					delegation.stoppedBy = stop.input.by;
					delegations.push(delegation.id);
				}
				return { status: "running", checkpoint: { phase: "abort", names, delegations } } as const;
			}, context);
		},
		abort: async (stop, runtime, context) => {
			const { names, delegations } = stop.state.checkpoint;
			const registry = await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
			for (const name of names) {
				const agent = registry?.agents[name];
				if (agent)
					await (await runtime.conversation(agent.conversationId, context))?.abort(context, {
						// A member's work may run as background work of a task that gave it the message (a reporter): a stop
						// reaches it too, or abort() would wait for an idle it can never reach.
						background: true,
					});
			}
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "verify", names, delegations } }) as const,
				context,
			);
		},
		verify: async (stop, runtime, context) => {
			const { names, delegations } = stop.state.checkpoint;
			let verified = false;
			// Nothing running and nothing queued in any member; abort again (up to three checks) what is not.
			for (let attempt = 0; attempt < 3 && !verified; attempt++) {
				const registry = await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
				const busy: ConversationId[] = [];
				for (const name of names) {
					const agent = registry?.agents[name];
					if (!agent) continue;
					const live = await runtime.snapshot(LiveDoc, agent.conversationId, context);
					const inbox = await runtime.snapshot(InboxDoc, agent.conversationId, context);
					if (live?.run !== undefined || inbox?.items.some((item) => item.mode !== "write"))
						busy.push(agent.conversationId);
				}
				verified = busy.length === 0;
				if (verified || attempt === 2) break;
				for (const id of busy)
					await (await runtime.conversation(id, context))?.abort(context, { background: true });
				await pause(runtime, 1000, context);
			}
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "finish", names, delegations, verified } }) as const,
				context,
			);
		},
		finish: async (stop, runtime, context) => {
			const { names, delegations, verified } = stop.state.checkpoint;
			const { by, archive, member } = stop.input;
			const registry = (await runtime.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {
				agents: {},
				reporters: {},
			};
			// The hooks decide whom to tell; the notices go out before the closing commit, so a manager's settle task, which
			// that commit may start, finds them queued and does not report the manager's earlier answer as its last.
			const notices: StopNotice[] = [];
			for (const id of delegations) {
				const delegation = delegationOf(registry, id);
				if (delegation?.status !== "stopping") continue;
				for (const handler of readStoppedHandlers())
					notices.push(...(await handler({ delegation, by, scope: names, verified, registry })));
			}
			const targets = new Map<ConversationId, Awaited<ReturnType<typeof runtime.conversation>>>();
			for (const notice of notices) {
				if (targets.has(notice.to)) continue;
				targets.set(notice.to, await runtime.conversation(notice.to, context));
			}
			for (const [index, notice] of notices.entries()) {
				await targets.get(notice.to)?.submit(
					{
						type: "input",
						...agentMessageInput({ from: notice.from, intent: "stopped", text: notice.text }, ""),
						whenBusy: "followUp",
						requestId: `team-stop:${stop.id}:${index}`,
					},
					context,
				);
			}
			await runtime.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const stopping = delegations.flatMap((id) => {
					const delegation = delegationOf(state, id);
					return delegation?.status === "stopping" ? [delegation] : [];
				});
				// Before the writes: the settle tasks (task-table reads) these ends may need.
				const seen = new Set<string>();
				for (const delegation of stopping) await ensureSettleFor(tx, state, delegation, seen);
				const stopped: number[] = [];
				for (const id of delegations) {
					if (delegationOf(state, id)?.status !== "stopping") continue;
					endDelegation(state, id, "stopped", runtime.now(), undefined, by);
					stopped.push(id);
				}
				for (const name of names) {
					const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
					if (!agent) continue;
					if (agent.stopping === stop.id) delete agent.stopping;
					const note = stopNoteFor(state, name, stopped, by);
					if (note !== undefined) agent.stopNote = note;
					if (archive && name === member) agent.archived = true;
				}
				return {
					status: "terminal",
					outcome: { status: "completed", result: { names, stopped, verified } },
				} as const;
			}, context);
		},
	},
	// An aborted stop frees what it marked, and ends the work it was stopping as stopped.
	abort: (stop, runtime, context) =>
		runtime.commit(async (tx) => {
			const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
			const freed = Object.entries(state.agents).filter(([, agent]) => agent.stopping === stop.id);
			for (const [name, agent] of freed) {
				delete agent.stopping;
				for (const delegation of openDelegations(state)) {
					if (delegation.to !== name || delegation.status !== "stopping") continue;
					const ended = endDelegation(state, delegation.id, "stopped", runtime.now(), undefined, stop.input.by);
					if (ended) await ensureSettleFor(tx, state, ended);
				}
			}
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context),
});

/** Starts a stop in `tx`: the flow runs in the background on conversation 1, whoever asked. */
export const startStop = (tx: Tx, input: StopInput) => tx.createTask(Stop, input, ANCHORED);

/** The result of a settled stop (a stop that did not complete is reported as unconfirmed). */
export const stopResultOf = (
	settled: { state: { outcome: { status: string; result?: StopResult; error?: unknown } } },
	member: string,
): StopResult =>
	settled.state.outcome.status === "completed" && settled.state.outcome.result
		? settled.state.outcome.result
		: { names: [member], stopped: [], verified: false };

/** What the subagent and staff tools give as a call's details. */
export type SubagentDetails = {
	action: string;
	name?: string;
	conversationId?: number;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	/** Its own cwd (raw path) and, on a remote environment, that environment's name. */
	cwd?: string;
	env?: string;
	role?: Role;
	/** A team executor's manager. */
	manager?: string;
	/** The delegation a hire or send opened. */
	delegation?: number;
	/**
	 * Why a call was refused, structured, so callers (and tests) never read the sentence: a placement (`sandbox`), a busy
	 * member (`working`), a member the main agent asks with hire (`use`), a team executor (`manager`: whom to give its
	 * work), a caller without the role (`role`), a manager that still has a team (`team`).
	 */
	refused?:
		| { sandbox: string }
		| { working: true }
		| { use: "hire" }
		| { manager: string }
		| { role: Role }
		| { team: true }
		| { stopping: true }
		| { notYours: true };
};

/** A member's own location as the tools' details carry it. */
export const locationDetails = (location: Location | undefined): Pick<SubagentDetails, "cwd" | "env"> =>
	location === undefined ? {} : { cwd: location.cwd, ...(location.env === null ? {} : { env: location.env }) };

/** A member as the tools' details carry it: plain values, never the registry's draft. */
export const memberDetails = (agent: Subagent): Partial<SubagentDetails> => ({
	conversationId: agent.conversationId,
	model: agent.model,
	thinkingLevel: agent.thinkingLevel,
	tools: [...agent.tools],
	role: roleOf(agent),
	...(agent.manager === undefined ? {} : { manager: agent.manager }),
	...locationDetails(agent.location),
});

/**
 * Places what version 1 left unplaced (an own cwd without its environment: `spawnedOn` tells the environment it was
 * spawned on), then lists where the session's subagents work: the conversations following the session (Pi Mobile
 * 78056b34e: subagents spawned without their own location, one-shot agents) and the own locations.
 */
export async function placeSubagents(
	harness: Pick<Harness, "snapshot" | "commit">,
	spawnedOn: (conversationId: ConversationId, cwd: string) => string | null,
	context: Context,
): Promise<{ followers: ConversationId[]; own: Location[] }> {
	let registry = await harness.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	if (Object.values(registry?.agents ?? {}).some((agent) => agent.unplacedCwd !== undefined)) {
		await harness.commit(async (tx) => {
			for (const agent of Object.values((await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents)) {
				if (agent.unplacedCwd === undefined) continue;
				agent.location = { env: spawnedOn(agent.conversationId, agent.unplacedCwd), cwd: agent.unplacedCwd };
				delete agent.unplacedCwd;
			}
		}, context);
		registry = await harness.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	}
	const agents = Object.values(registry?.agents ?? {});
	return {
		followers: [
			...agents.filter((agent) => agent.location === undefined),
			...Object.values(registry?.oneShots ?? {}),
		].map((child) => child.conversationId),
		own: agents.flatMap((agent) => (agent.location === undefined ? [] : [agent.location])),
	};
}

const isSubagentLocations = compile(SubagentLocationsSchema).check;

/**
 * Where version 1 own cwds were spawned: on the environment the server recorded for them (`recorded`, the worker init
 * value `subagentLocations`), else on the session's spawn environment (a session could not change machines while it
 * had them).
 */
export function spawnEnvironments(
	recorded: unknown,
	sessionEnv: string | null,
): (conversationId: ConversationId, cwd: string) => string | null {
	const known = isSubagentLocations(recorded) ? recorded : {};
	return (conversationId, cwd) => {
		const location: Location | undefined = known[String(conversationId)];
		return location?.cwd === cwd ? location.env : sessionEnv;
	};
}

/**
 * A conversation's own location (a subagent spawned with a cwd, or a one-shot agent started by a conversation with
 * one), or undefined: it follows the session.
 */
export async function ownLocation(
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
): Promise<Location | undefined> {
	if (conversationId === ROOT_CONVERSATION_ID) return undefined;
	const registry = await read.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	const own = Object.values(registry?.agents ?? {}).find((agent) => agent.conversationId === conversationId)?.location;
	return own ?? (await read.snapshot(InheritedLocation, conversationId, context))?.location;
}

/** Where the conversation calling a tool works (the session's, or its own), for a spawned subagent's own location. */
export type Locate = (conversationId: ConversationId, read: DocumentReader, context: Context) => Promise<Location>;

/** What the subagent tool needs to place subagents: locating conversations and resolving directories. */
export type SubagentLocator = {
	readonly locate: Locate;
	/** The sandbox a conversation working at `location` is confined to (its environment's configured type), if any. */
	readonly sandbox: (location: Location) => Promise<string | undefined>;
	/** `target` as an existing directory's location, relative to `from` (see `resolveDirectory`), or why not. */
	readonly directory: (
		target: LocationInput,
		from: Location,
		context: Context,
	) => Promise<Location | { error: string }>;
};

/**
 * Where a subagent of a caller at `caller` should work: `env` (default the caller's; null this device) and `cwd`
 * (default the caller's cwd on its own environment, the home elsewhere). Text when it is not an existing directory.
 */
/** Where a subagent may go: its location, or why it may not go there (the tool says why in words). */
export type Placement = { readonly location: Location } | { readonly refused: "sandbox"; readonly sandbox: string };

export async function placeTarget(
	locator: SubagentLocator,
	caller: Location,
	args: { env?: string | null; cwd?: string },
	context: Context,
): Promise<Placement | string> {
	const env = args.env === undefined ? caller.env : args.env;
	// A caller in a sandbox places its subagents in the same sandbox only.
	const sandbox = await locator.sandbox(caller);
	if (sandbox !== undefined && env !== sandbox) return { refused: "sandbox", sandbox };
	const resolved = await locator.directory({ env, path: args.cwd ?? "" }, caller, context);
	if (!("error" in resolved)) return { location: resolved };
	const where = `${env === caller.env ? "" : `${env ?? "local"}:`}${args.cwd ?? "~"}`;
	return resolved.error === "not an existing directory"
		? `cwd ${where} is not an existing directory.`
		: `cwd ${where}: ${resolved.error}`;
}

/** What a placement refusal says: the reason is the placement's, the words are here. */
export function placementRefusal(placement: Extract<Placement, { refused: "sandbox" }>): string {
	return `You work in sandbox ${placement.sandbox}; your subagents can only work inside it.`;
}

/** What archiving needs: a tool call's API, or the worker's Harness. */
type ArchiveTarget = {
	conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<void> } | undefined>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
};

/**
 * Archives (aborting its work first, as archiving a session stops its worker) or restores a subagent of conversation
 * `parent`. Used by the tool's archive/restore and by the browser's Archive/Restore.
 */
export async function setArchived(
	target: ArchiveTarget,
	parent: ConversationId,
	conversationId: ConversationId,
	archived: boolean,
	context: Context,
): Promise<void> {
	if (archived) await (await target.conversation(conversationId, context))?.abort(context);
	await target.commit(async (tx) => {
		const agent = Object.values((await tx.doc(Subagents, parent)).agents).find(
			(each) => each.conversationId === conversationId,
		);
		if (agent && archived) agent.archived = true;
		else if (agent) delete agent.archived;
	}, context);
}

/**
 * An agent's tools as its Durable agent state takes them: exactly these enabled (nested calls resolve among them, so the
 * script-only ones are named too; the worker adds ones installed later, see `enableScriptTools`), and the deferred ones
 * it is offered from the start.
 */
export const agentTools = (choice: ToolChoice) => ({ tools: choice.tools, modelTools: { add: choice.loaded } });

/**
 * Adds the tools behind code mode installed now (`names`) to every subagent with code mode, by name: MCP tools come and
 * go with their servers, so the names written at spawn go stale. It runs between scripts, not inside one: a script's
 * call resolves the agent once, at its start. A name whose tool goes away is ignored by Durable and works again when it
 * returns, so none is removed.
 */
export async function enableScriptTools(
	harness: Pick<Harness, "snapshot" | "commit">,
	names: readonly string[],
	context: Context,
): Promise<void> {
	const registry = await harness.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	const lacking: ConversationId[] = [];
	for (const agent of Object.values(registry?.agents ?? {})) {
		if (!agent.tools.includes(CODEMODE_TOOL)) continue;
		const enabled = (await harness.snapshot(AgentDoc, agent.conversationId, context))?.tools;
		if (Array.isArray(enabled) && names.some((name) => !enabled.includes(name))) lacking.push(agent.conversationId);
	}
	if (lacking.length === 0) return;
	await harness.commit(async (tx) => {
		for (const conversationId of lacking) {
			const state = await tx.doc(AgentDoc, conversationId);
			if (Array.isArray(state.tools)) state.tools = [...new Set([...state.tools, ...names])];
		}
	}, context);
}

/**
 * Subagents' messaging: to the main agent and to the other subagents of the same main agent (siblings), as structural
 * `p2.agent-message` inputs that start a turn like any input. Within one session, so no cross-session rule applies. No
 * automatic replies: loops are left to the prompt.
 */
const teamTool: P2Tool = defineP2Tool({
	name: TEAM_TOOL,
	description: [
		"Message whoever gave you work and your contacts while you work, without ending your turn. Your contacts: a manager",
		"the other managers; an executor of a team its manager and the team's other executors; a direct executor the other",
		"direct executors; the HR manager nobody (it asks the main agent only).",
		'- send (to: "parent" or a contact\'s name, message; optional intent "question" (default) or "note", steer):',
		"  delivers it as a message from you; it starts the receiver's turn if it is idle, else waits for its next step",
		"  (steer: true interrupts its current step). A question asks for a reply, which arrives as a message to you; a note needs none.",
		"- answer (name): the latest completed answer of a contact.",
		"- list: your contacts and whether they are working.",
		"Only message when it helps the work. Never send acknowledgements or thanks, and do not reply to notes.",
	].join("\n"),
	parameters: obj(
		{
			action: union([literal("send"), literal("answer"), literal("list")]),
			to: opt(str({ minLength: 1, maxLength: 200 })),
			name: opt(str({ minLength: 1, maxLength: 200 })),
			message: opt(str({ minLength: 1, maxLength: 32768 })),
			intent: opt(union([literal("question"), literal("note")])),
			steer: opt(bool()),
		},
		{ open: true },
	),
	// A send is admitted once per call (its request ID); list and answer only read.
	replay: "safe",
	deferred: true,
	scope: "subagent",
	execute: async (args, api, context) => {
		const reply = (
			text: string,
			extra: { refused?: { contact: true } | { stopping: true } } = {},
			isError = false,
		) => ({
			output: [{ type: "text" as const, text }],
			details: { action: args.action, ...(args.to === undefined ? {} : { to: args.to }), ...extra },
			isError,
		});
		const registry = await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
		const self = registry ? memberOf(registry, api.conversationId)?.[0] : undefined;
		if (!registry || self === undefined) return reply("Only team members can use the team tool.", {}, true);
		// Whom this member may message besides whoever gave it work: its role's contacts (`peersOf`).
		const contacts = peersOf(registry, self);
		if (args.action === "list") {
			const lines: string[] = [];
			for (const [name, agent] of contacts) {
				const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
				lines.push(
					`${name}: ${roleText(agent)} · ${busy ? "working" : "idle"}${agent.archived ? " · archived" : ""}`,
				);
			}
			return reply(lines.length ? lines.join("\n") : "No one to message but whoever gave you work.");
		}
		if (args.action === "answer") {
			const contact = contacts.find(([name]) => name === args.name)?.[1];
			if (!contact)
				return reply(`${args.name ?? "(none)"} is not one of your contacts.`, { refused: { contact: true } }, true);
			const answer = await latestAnswer(api, contact.conversationId, context);
			return reply(answer ?? `${args.name} has not answered yet.`);
		}
		if (!args.to) return reply('send needs to ("parent" or a contact\'s name).', {}, true);
		if (!args.message?.trim()) return reply("send needs a message.", {}, true);
		const contact = args.to === "parent" ? undefined : contacts.find(([name]) => name === args.to)?.[1];
		if (args.to !== "parent" && !contact)
			return reply(
				`${args.to} is not one of your contacts (team list shows them).`,
				{ refused: { contact: true } },
				true,
			);
		const receiver =
			contact?.conversationId ?? registry.agents[self]?.parent ?? (await mainConversation(api, context));
		// No work reaches a member while it is being stopped.
		if (memberOf(registry, receiver)?.[1].stopping !== undefined)
			return reply(`${args.to} is being stopped; message it once it is.`, { refused: { stopping: true } }, true);
		const target = await api.conversation(receiver, context);
		if (!target) return reply(`${args.to} has no conversation.`, {}, true);
		// The receiver's turn may act for the owner if this one may.
		const origin = await originOf(api, context);
		await target.submit(
			{
				type: "input",
				...agentMessageInput(
					{
						from: { name: self, conversationId: api.conversationId },
						intent: args.intent ?? "question",
						text: args.message,
						...(origin ? { origin } : {}),
					},
					replyToMember(registry, self, receiver),
				),
				whenBusy: args.steer ? "steer" : "followUp",
				requestId: `team:${api.taskId}:${api.callId}`,
			},
			context,
		);
		return reply(`Sent to ${args.to}.`);
	},
});

/** The `team` tool's extension: installed for every conversation, given to subagents only (its `scope: "subagent"`). */
export const teamExtension = defineExtension<P2Tool>({ name: "p2-subagent-team", tools: [teamTool] });
