// The team tools of the main agent and the HR manager. The main agent is the team's only entry: with the subagent tool
// it asks the HR manager to hire (`hire`), gives work to managers and direct executors (`send`), stops members and reads
// their answers. The HR manager staffs the team with the staff tool: it hires, configures, moves and archives members,
// and gives no one work.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Agent,
	configure,
	defineExtension,
	type Extension,
	type Harness,
	LiveDoc,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	section,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { type Context, type Location, literal } from "@p2/app/v1";
import { defineP2Tool, originOf, type P2Tool } from "@p2/app/v1/worker";
import {
	choosableTools,
	DELEGATE_TOOL,
	type Giver,
	type Role,
	resolveChoice,
	resolveTools,
	roleOf,
	STAFF_TOOL,
	SUBAGENT_TOOL,
	type Subagent,
	type SubagentState,
	Subagents,
	stillGiven,
	type ToolChoice,
} from "./contract.worker.ts";
import type { TeamFiles } from "./files.ts";
import {
	hrName,
	hrOf,
	instructionsFor,
	MAIN,
	MEMBER_NAME,
	memberOf,
	NOTE_LENGTH,
	NOTES_KEPT,
	openDelegation,
	openDelegations,
	RESERVED_NAMES,
	rosterText,
} from "./team.ts";
import {
	ANCHORED,
	Anchor,
	agentTools,
	BACKGROUND,
	latestAnswer,
	memberDetails,
	placementRefusal,
	placeTarget,
	Reporter,
	type ReporterInput,
	Settle,
	Stop,
	type StopResult,
	SUBAGENT_EXTENSION,
	type SubagentDetails,
	type SubagentLocator,
	setArchived,
	startStop,
	stopResultOf,
} from "./tools.ts";

/** What the team tools need from the worker. */
/** How much of a member's AGENTS.md reaches its prompt (characters). */
export const AGENTS_LENGTH = 16_000;

export type TeamDeps = {
	readonly models: Models;
	readonly locator: SubagentLocator;
	/** The worker's tools by name, with what they declare: which ones members may get. */
	readonly access: () => ReadonlyMap<string, P2Tool>;
	/** The main agent, whose model, thinking level and tools members start from (the HR manager has none to give). */
	readonly main: (context: Context) => Promise<Agent>;
	/** Each member's AGENTS.md, kept by the HR manager (`staff agents`) and added to that member's prompt. */
	readonly files: TeamFiles;
};

/** A member about to be created, as the subagent and staff tools resolved it. */
type NewMember = {
	role: Role;
	manager?: string;
	duty?: string;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	tools: ToolChoice;
	location?: Location;
};

/**
 * Creates member `name` in `state`, in `tx`: its conversation (owned by a background anchor on conversation 1, so
 * stopping whoever hired it never reaches it), its agent with its role's instructions, and its registry entry.
 */
async function createMember(tx: Tx, state: SubagentState, name: string, member: NewMember): Promise<void> {
	const anchor = await tx.createTask(Anchor, null, ANCHORED);
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
	await configure(tx, child.id, {
		model: member.model,
		thinkingLevel: member.thinkingLevel,
		...agentTools(member.tools),
		...(member.location ? { cwd: member.location.cwd } : {}),
		instructions: instructionsFor(member.role, name, member.duty, member.manager),
	});
	const boss = member.manager === undefined ? undefined : state.agents[member.manager];
	state.agents[name] = {
		conversationId: child.id,
		model: `${member.model.provider}/${member.model.modelId}`,
		thinkingLevel: member.thinkingLevel,
		tools: member.tools.chosen,
		...(member.location ? { location: member.location } : {}),
		// A team executor's `team send to: "parent"` reaches its manager.
		...(boss ? { parent: boss.conversationId } : {}),
		reported: [],
		role: member.role,
		...(member.manager === undefined ? {} : { manager: member.manager }),
		...(member.duty ? { duty: member.duty } : {}),
	};
}

/** The names of the members working now. */
async function busyNames(api: ToolExecutionApi, state: SubagentState, context: Context): Promise<Set<string>> {
	const busy = new Set<string>();
	for (const [name, agent] of Object.entries(state.agents))
		if ((await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined) busy.add(name);
	return busy;
}

/** Member `name` of `state`, never a property of every object (`constructor`, …). */
const memberNamed = (state: Pick<SubagentState, "agents">, name: string): Subagent | undefined =>
	Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;

/** A manager and its executors: whom stopping the manager stops. */
const withTeam = (state: Pick<SubagentState, "agents">, name: string): string[] => [
	name,
	...Object.entries(state.agents)
		.filter(([, agent]) => roleOf(agent) === "executor" && agent.manager === name)
		.map(([each]) => each),
];

/**
 * Stops `member` (a manager's team with it) for `by` through the stop flow, and waits until it has ended: the members'
 * runs are aborted and confirmed ended, and whoever gave them work has been told.
 */
async function stopMember(
	api: ToolExecutionApi,
	member: string,
	by: string,
	context: Context,
	archive = false,
): Promise<StopResult> {
	const id = await api.commit((tx) => startStop(tx, { member, by, ...(archive ? { archive } : {}) }), context);
	return stopResultOf(await api.waitForTask(id, context), member);
}

const stoppedText = (result: StopResult): string =>
	[
		`Stopped ${result.names.join(", ")}.`,
		result.stopped.length ? `Stopped work: ${result.stopped.map((id) => `#${id}`).join(", ")}.` : "",
		result.verified ? "" : "Could not confirm that every run ended.",
	]
		.filter(Boolean)
		.join(" ");

/** Text of a member's latest answer, for the answer actions. */
async function answerText(api: ToolExecutionApi, name: string, agent: Subagent, context: Context): Promise<string> {
	const answer = await latestAnswer(api, agent.conversationId, context);
	const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
	const state = busy ? `${name} is still working.` : "";
	return answer === undefined
		? `${name} has not answered yet.${state ? ` ${state}` : ""}`
		: `${state ? `${state} Its latest answer:\n\n` : ""}${answer}`;
}

/** The tools the HR manager gets from the main agent's: looking at environments and directories, nothing to work with. */
const HR_TOOLS = ["location_envs", "location_dirs"];

/** How work reaches a member: it starts a turn when the member is idle, else it waits for its answer or steers it. */
type Delivery = NonNullable<SubagentDetails["delivery"]>;

/**
 * How work for `member` is delivered now. Work waits behind a working member's current answer and gets a turn after it;
 * only `steer` places it at the member's next step (after its current tool round, or when its answer ends), where it can
 * change what the member is doing and may be answered together with it. The member may start or end its turn right
 * after this read: the answer is what the caller is told.
 */
async function deliveryOf(
	api: ToolExecutionApi,
	member: Subagent,
	steer: boolean | undefined,
	context: Context,
): Promise<Delivery> {
	const busy = (await api.snapshot(LiveDoc, member.conversationId, context))?.run !== undefined;
	return !busy ? "start" : steer === true ? "steer" : "queue";
}

/** What a send tells its caller about where the work went, after "Sent to X (#n)." */
const deliveryText = (delivery: Delivery): string =>
	delivery === "queue"
		? " It is working: this waits until its current answer ends, then gets a turn."
		: delivery === "steer"
			? " It is working: this is placed at its next step."
			: "";

/**
 * How the HR manager starts: the main agent's model and thinking level, with only the tools to look around. Text when
 * the main agent's own choices cannot give it that (an unknown model).
 */
async function hrStart(deps: TeamDeps, context: Context): Promise<NewMember | string> {
	const own = await deps.main(context);
	const given = choosableTools(own, deps.access())
		.map((tool) => tool.name)
		.filter((each) => HR_TOOLS.includes(each));
	const choice = await resolveChoice(
		deps.models,
		{ agent: deps.main },
		deps.access(),
		{ tools: given },
		undefined,
		"hr",
		context,
	);
	if (typeof choice === "string") return choice;
	const { model, thinkingLevel, ...tools } = choice;
	return { role: "hr", model, thinkingLevel, tools };
}

/**
 * Makes the HR manager if the session's team has none: it is resident, there from the session's start (`WorkerStarts`),
 * so the team always has the member that staffs it. Nothing to do when it exists. The HR manager the first `subagent
 * hire` finds missing (this could not make it) is made the same way.
 */
export async function ensureHrManager(deps: TeamDeps, durable: Harness, context: Context): Promise<void> {
	const registry = await durable.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	if (registry && hrOf(registry)) return;
	const start = await hrStart(deps, context);
	if (typeof start === "string") throw new Error(`The HR manager cannot start: ${start}`);
	const name = await durable.commit(async (tx) => {
		const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
		if (hrOf(state)) return undefined;
		const hr = hrName(state);
		await createMember(tx, state, hr, start);
		return hr;
	}, context);
	if (name !== undefined) await deps.files.ensure(name);
}

/**
 * The work message a member gets: its stop note first (why its last work was stopped), once. Clears the note in the
 * commit that sends it.
 */
function withStopNote(agent: Subagent, message: string): string {
	const note = agent.stopNote;
	if (note === undefined) return message;
	delete agent.stopNote;
	return `${note}\n\nPlan again before you continue.\n\n${message}`;
}

/** The main agent's subagent tool: the team's only entry. */
function subagentTool(deps: TeamDeps): P2Tool {
	const { access } = deps;
	return defineP2Tool({
		name: SUBAGENT_TOOL,
		description: [
			"Work with your team: members that work in the background while you keep talking to the user. You are the team's",
			"only entry. The HR manager hires and staffs the team; managers split work among their own executors; direct",
			"executors work for you.",
			"Actions:",
			"- hire (message; optional steer): ask the HR manager to hire or change members, e.g. 'a parser team: one",
			"  manager and two executors, one for the lexer and one for the grammar'. Its answer, naming whom it hired, is",
			"  reported to you as a message. The HR manager is always there; the other members are the ones it hired.",
			"- send (name, message; optional steer): give work to a manager or a direct executor. A member that is working",
			"  finishes its current answer first: the new work waits for it and does not replace it. steer: true places it at",
			"  the member's next step instead (after its current tool round), to change what it is doing now. A manager's",
			"  answer is reported once its whole team is done.",
			"- stop (name): stop its current work; stopping a manager also stops its team's work. They stay usable.",
			"- answer (name): return a member's latest completed answer, e.g. when a report did not reach you.",
			"- status (optional name): the team in order (HR manager, each manager with its executors, direct executors), who is",
			"  working, and the open work; archived members only by name.",
			"Answers are reported back to you as messages when they arrive; do not wait or poll for them.",
			'Members can also message you while they work: a <sender kind="subagent"> message marked [asks; …] needs your',
			"answer (send to that member, or hire for the HR manager); a note needs none.",
		].join("\n"),
		parameters: obj(
			{
				action: union([literal("hire"), literal("send"), literal("stop"), literal("answer"), literal("status")]),
				name: opt(str()),
				message: opt(str()),
				steer: opt(bool()),
			},
			{ open: true },
		),
		// A crash-interrupted stop must not be repeated against newer work.
		replay: "unsafe",
		scope: "main",
		execute: async (args, api, context) => {
			const { action, message, steer } = args;
			const name = args.name?.trim() || undefined;
			const reply = (text: string, extra: Partial<SubagentDetails> = {}, isError = false) => ({
				output: [{ type: "text" as const, text }],
				details: { action, ...(name === undefined ? {} : { name }), ...extra } satisfies SubagentDetails,
				isError,
			});
			const registry: SubagentState = (await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {
				agents: {},
				reporters: {},
			};
			if (action === "status") return reply(rosterText(registry, await busyNames(api, registry, context), name));
			if (action === "hire") {
				if (!message?.trim()) return reply("hire needs a message for the HR manager.", {}, true);
				const hr = hrOf(registry);
				if (hr?.[1].stopping !== undefined)
					return reply(`${hr[0]} is being stopped; send again once it is.`, { refused: { stopping: true } }, true);
				// It is there from the session's start; one the start could not make is made now.
				let created: NewMember | undefined;
				if (!hr) {
					const start = await hrStart(deps, context);
					if (typeof start === "string") return reply(start, {}, true);
					created = start;
				}
				const origin = await originOf(api, context);
				const delivery: Delivery = hr ? await deliveryOf(api, hr[1], steer, context) : "start";
				const result = await api.commit(async (tx) => {
					const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
					let found = hrOf(state);
					if (!found && created) {
						await createMember(tx, state, hrName(state), created);
						found = hrOf(state);
					}
					if (!found) throw new Error("The HR manager disappeared");
					const [hrNameNow, agent] = found;
					delete agent.archived;
					agent.parent = api.conversationId;
					const delegation = openDelegation(
						state,
						{ from: MAIN, to: hrNameNow, parent: api.conversationId, text: message },
						api.now(),
					);
					const input: ReporterInput = {
						name: hrNameNow,
						conversationId: agent.conversationId,
						parent: api.conversationId,
						// A stopped hire is told once, with the next request (its stop note).
						message: withStopNote(agent, message),
						followUp: steer !== true,
						...(origin === "owner" ? { origin } : {}),
						delegation,
					};
					state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);
					return { name: hrNameNow, delegation, details: memberDetails(agent) };
				}, context);
				if (created) await deps.files.ensure(result.name);
				return reply(
					`${created ? `Created the HR manager ${result.name} and asked it` : `Asked ${result.name}`} (#${result.delegation}).${deliveryText(delivery)}`,
					{ ...result.details, name: result.name, delegation: result.delegation, delivery },
				);
			}
			if (name === undefined) return reply(`${action} needs a name.`, {}, true);
			const agent = memberNamed(registry, name);
			if (!agent) return reply(`No team member named ${name}.`, {}, true);
			if (action === "answer")
				return reply(await answerText(api, name, agent, context), { conversationId: agent.conversationId });
			if (action === "stop") {
				const result = await stopMember(api, name, MAIN, context);
				return reply(stoppedText(result), { conversationId: agent.conversationId });
			}
			// send
			if (!message?.trim()) return reply("send needs a message.", {}, true);
			if (roleOf(agent) === "hr")
				return reply(`${name} is the HR manager: ask it with hire.`, { refused: { use: "hire" } }, true);
			if (agent.manager !== undefined)
				return reply(
					`${name} works for the manager ${agent.manager}: give the work to ${agent.manager}.`,
					{ refused: { manager: agent.manager } },
					true,
				);
			if (agent.stopping !== undefined)
				return reply(`${name} is being stopped; send again once it is.`, { refused: { stopping: true } }, true);
			// What it was given that the main agent can no longer give is taken away (the main agent's tools changed).
			const own = await deps.main(context);
			const kept = stillGiven(own, access(), agent);
			const narrowed =
				kept && kept.length !== agent.tools.length
					? resolveTools(own, access(), kept, [], roleOf(agent))
					: undefined;
			const origin = await originOf(api, context);
			// Before the commit: the work it opens may start the member's turn, and that is no reason to call it busy.
			const delivery = await deliveryOf(api, agent, steer, context);
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const target = memberNamed(state, name);
				if (!target) return undefined;
				// A stop that committed while this call waited: its mark lists no work yet to be this one, so nothing would
				// stop it. Checked here, in the commit that opens the delegation.
				if (target.stopping !== undefined) return { refused: "stopping" } as const;
				// Working with an archived member again brings it back.
				delete target.archived;
				target.parent = api.conversationId;
				if (narrowed && typeof narrowed !== "string") {
					await configure(tx, target.conversationId, agentTools(narrowed));
					target.tools = narrowed.chosen;
				}
				const delegation = openDelegation(
					state,
					{ from: MAIN, to: name, parent: api.conversationId, text: message },
					api.now(),
				);
				const input: ReporterInput = {
					name,
					conversationId: target.conversationId,
					parent: api.conversationId,
					message: withStopNote(target, message),
					followUp: steer !== true,
					...(origin === "owner" ? { origin } : {}),
					delegation,
				};
				state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);
				return { delegation, details: memberDetails(target) };
			}, context);
			if (!result) return reply(`No team member named ${name}.`, {}, true);
			if ("refused" in result)
				return reply(`${name} is being stopped; send again once it is.`, { refused: { stopping: true } }, true);
			return reply(`Sent to ${name} (#${result.delegation}).${deliveryText(delivery)}`, {
				...result.details,
				delegation: result.delegation,
				delivery,
			});
		},
	});
}

/** A manager's delegate tool: it gives work to its own executors, and to nobody else. */
function delegateTool(deps: TeamDeps): P2Tool {
	const { access } = deps;
	return defineP2Tool({
		name: DELEGATE_TOOL,
		description: [
			"Give work to your own executors. You are a manager: you split the work you were given, hand the pieces to your",
			"executors, and answer once they are done.",
			"Actions:",
			"- send (name, message; optional steer): give work to one of your executors. An executor that is working finishes",
			"  its current answer first: the new work waits for it and does not replace it. steer: true places it at the",
			"  executor's next step instead (after its current tool round), to change what it is doing now. Its answer comes",
			"  back to you as a message when it arrives; do not wait or poll for it.",
			"- stop (name): stop its current work (it stays usable).",
			"- answer (name): return an executor's latest completed answer.",
			"- status (optional name): your executors, who is working, and the work you gave out.",
			"Your own answer is reported to the main agent once all the work you gave out has ended.",
		].join("\n"),
		parameters: obj(
			{
				action: union([literal("send"), literal("stop"), literal("answer"), literal("status")]),
				name: opt(str()),
				message: opt(str()),
				steer: opt(bool()),
			},
			{ open: true },
		),
		// A crash-interrupted stop must not be repeated against newer work.
		replay: "unsafe",
		deferred: true,
		scope: "manager",
		execute: async (args, api, context) => {
			const { action, message, steer } = args;
			const name = args.name?.trim() || undefined;
			const reply = (text: string, extra: Partial<SubagentDetails> = {}, isError = false) => ({
				output: [{ type: "text" as const, text }],
				details: { action, ...(name === undefined ? {} : { name }), ...extra } satisfies SubagentDetails,
				isError,
			});
			const registry: SubagentState = (await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {
				agents: {},
				reporters: {},
			};
			const self = memberOf(registry, api.conversationId);
			if (!self || roleOf(self[1]) !== "manager")
				return reply("Only a manager can use the delegate tool.", { refused: { role: "manager" } }, true);
			const manager = self[0];
			const own = (agent: Subagent) => roleOf(agent) === "executor" && agent.manager === manager;
			if (action === "status") {
				const team: SubagentState = {
					agents: Object.fromEntries(Object.entries(registry.agents).filter(([, agent]) => own(agent))),
					reporters: {},
					delegations: Object.fromEntries(
						Object.entries(registry.delegations ?? {}).filter(([, delegation]) => delegation.from === manager),
					),
				};
				return reply(rosterText(team, await busyNames(api, team, context), name));
			}
			if (name === undefined) return reply(`${action} needs a name.`, {}, true);
			const agent = memberNamed(registry, name);
			if (!agent || !own(agent))
				return reply(`${name} is not one of your executors.`, { refused: { notYours: true } }, true);
			if (action === "answer")
				return reply(await answerText(api, name, agent, context), { conversationId: agent.conversationId });
			if (action === "stop") {
				const result = await stopMember(api, name, manager, context);
				return reply(stoppedText(result), { conversationId: agent.conversationId });
			}
			// send
			if (!message?.trim()) return reply("send needs a message.", {}, true);
			if (agent.stopping !== undefined)
				return reply(`${name} is being stopped; send again once it is.`, { refused: { stopping: true } }, true);
			if (agent.archived) return reply(`${name} is archived: ask the main agent to have it restored.`, {}, true);
			// What it was given that the main agent can no longer give is taken away (the main agent's tools changed).
			const main = await deps.main(context);
			const kept = stillGiven(main, access(), agent);
			const narrowed =
				kept && kept.length !== agent.tools.length ? resolveTools(main, access(), kept, [], "executor") : undefined;
			const origin = await originOf(api, context);
			// Before the commit: the work it opens may start the member's turn, and that is no reason to call it busy.
			const delivery = await deliveryOf(api, agent, steer, context);
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const target = memberNamed(state, name);
				if (!target) return undefined;
				// A stop or an archive that committed while this call waited: re-checked in the commit that opens the work.
				if (target.stopping !== undefined) return { refused: "stopping" } as const;
				if (target.archived) return { refused: "archived" } as const;
				target.parent = api.conversationId;
				if (narrowed && typeof narrowed !== "string") {
					await configure(tx, target.conversationId, agentTools(narrowed));
					target.tools = narrowed.chosen;
				}
				const delegation = openDelegation(
					state,
					{ from: manager, to: name, parent: api.conversationId, text: message },
					api.now(),
				);
				const input: ReporterInput = {
					name,
					conversationId: target.conversationId,
					parent: api.conversationId,
					message: withStopNote(target, message),
					followUp: steer !== true,
					...(origin === "owner" ? { origin } : {}),
					delegation,
				};
				state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);
				return { delegation, details: memberDetails(target) };
			}, context);
			if (!result) return reply(`No executor named ${name}.`, {}, true);
			if ("refused" in result)
				return result.refused === "stopping"
					? reply(`${name} is being stopped; send again once it is.`, { refused: { stopping: true } }, true)
					: reply(`${name} is archived: ask the main agent to have it restored.`, {}, true);
			return reply(`Sent to ${name} (#${result.delegation}).${deliveryText(delivery)}`, {
				...result.details,
				delegation: result.delegation,
				delivery,
			});
		},
	});
}

/** The HR manager's staff tool: it staffs the team and gives no one work. */
function staffTool(deps: TeamDeps): P2Tool {
	const { models, access, locator } = deps;
	const giver: Giver = { agent: deps.main };
	return defineP2Tool({
		name: STAFF_TOOL,
		description: [
			"Staff the team. You are the HR manager: you hire and change members, and you keep each member's own",
			"AGENTS.md. You never give them work.",
			"Actions:",
			"- hire (name, role, duty; optional manager, model, thinkingLevel, tools, env, cwd): create a member. role is",
			'  "manager" (splits work among its own executors) or "executor" (does work). An executor with manager (an',
			"  existing manager's name) works in that manager's team; without, it works directly for the main agent.",
			"  duty is one line on what it is for. model is 'provider/modelId' (default: the main agent's); thinkingLevel is",
			"  off|minimal|low|medium|high|xhigh|max (clamped to the model); tools names tools of the main agent's it gets",
			"  (default: all it can give; [] for none). Without env and cwd it works where the session works and follows it;",
			"  with them it gets its own location: cwd is an existing directory (relative to the session's cwd on its",
			"  environment, to the home on another), env an environment name from location_envs or null for this device.",
			"- configure (name; optional model, thinkingLevel, tools, env, cwd, followSession): change a member for later work;",
			"  followSession: true makes it follow the session again. A location changes only while it is idle.",
			"- agents (name; optional text): read the member's own AGENTS.md, or replace it with text. It is added to that",
			"  member's instructions, so write lasting guidance there (its way of working, what to keep in mind).",
			"- assign (name, manager): move an executor into a manager's team, or with manager null back to the main agent.",
			"- archive (name): stop it and hide it from the sidebar; restore (name) brings it back. A manager with executors",
			"  cannot be archived: move or archive them first.",
			"- roster (optional name): the team in order, who is working, and the open work.",
			"- models: list models that have credentials configured.",
		].join("\n"),
		parameters: obj(
			{
				action: union([
					literal("hire"),
					literal("configure"),
					literal("agents"),
					literal("assign"),
					literal("archive"),
					literal("restore"),
					literal("roster"),
					literal("models"),
				]),
				name: opt(str()),
				role: opt(union([literal("manager"), literal("executor")])),
				duty: opt(str({ maxLength: 500 })),
				manager: opt(union([str(), nul()])),
				model: opt(str()),
				thinkingLevel: opt(str()),
				tools: opt(arr(str())),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				followSession: opt(bool()),
				text: opt(str({ maxLength: AGENTS_LENGTH })),
			},
			{ open: true },
		),
		// An archive stops work: a crash-interrupted one must not be repeated against newer work.
		replay: "unsafe",
		deferred: true,
		scope: "hr",
		execute: async (args, api, context) => {
			const { action } = args;
			const name = args.name?.trim() || undefined;
			const reply = (text: string, extra: Partial<SubagentDetails> = {}, isError = false) => ({
				output: [{ type: "text" as const, text }],
				details: { action, ...(name === undefined ? {} : { name }), ...extra } satisfies SubagentDetails,
				isError,
			});
			const registry: SubagentState = (await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {
				agents: {},
				reporters: {},
			};
			const self = memberOf(registry, api.conversationId);
			if (!self || roleOf(self[1]) !== "hr")
				return reply("Only the HR manager can use the staff tool.", { refused: { role: "hr" } }, true);
			if (action === "models") {
				const available = await models.getAvailable(undefined, { signal: AbortSignal.timeout(10_000) });
				const lines = available.slice(0, 200).map((model) => `${model.provider}/${model.id} (${model.name})`);
				return reply(lines.length ? lines.join("\n") : "No models with configured credentials.");
			}
			if (action === "roster") return reply(rosterText(registry, await busyNames(api, registry, context), name));
			if (name === undefined) return reply(`${action} needs a name.`, {}, true);
			const agent = memberNamed(registry, name);
			if (action !== "hire" && !agent) return reply(`No team member named ${name}.`, {}, true);
			if (action !== "hire" && agent && roleOf(agent) === "hr" && action !== "agents")
				return reply(`${name} is the HR manager: it stays as it is.`, { refused: { role: "hr" } }, true);

			if (action === "agents" && agent) {
				if (args.text === undefined) {
					const content = await deps.files.read(name);
					return reply(
						content?.trim()
							? `${name}'s AGENTS.md:\n\n${content.slice(0, AGENTS_LENGTH)}`
							: `${name} has no AGENTS.md yet.`,
						{ name },
					);
				}
				// A subagent from before roles may carry a name the files cannot use (`MEMBER_NAME` is what a hire accepts).
				if (!MEMBER_NAME.test(name))
					return reply(
						`${name} has a name that cannot have an AGENTS.md: use letters, digits, ".", "_" and "-".`,
						{},
						true,
					);
				await deps.files.write(name, args.text);
				return reply(
					args.text.trim()
						? `Updated ${name}'s AGENTS.md (${args.text.length} characters).`
						: `Cleared ${name}'s AGENTS.md.`,
					{ name },
				);
			}

			if (action === "restore" && agent) {
				await setArchived(api, ROOT_CONVERSATION_ID, agent.conversationId, false, context);
				return reply(`Restored ${name}.`, memberDetails(agent));
			}
			if (action === "archive" && agent) {
				const team = withTeam(registry, name).filter((each) => each !== name && !registry.agents[each]?.archived);
				if (roleOf(agent) === "manager" && team.length)
					return reply(
						`${name} still has executors (${team.join(", ")}): move or archive them first.`,
						{ refused: { team: true } },
						true,
					);
				// The stop flow ends its work first; its closing commit sets the archived flag.
				const stopped = await stopMember(api, name, "hr", context, true);
				return reply(`Archived ${name}. ${stoppedText(stopped)}`, memberDetails(agent));
			}
			if (action === "assign" && agent) {
				if (roleOf(agent) !== "executor") return reply(`${name} is not an executor.`, {}, true);
				if (args.manager === undefined) return reply("assign needs manager (a manager's name, or null).", {}, true);
				const manager = args.manager === null ? undefined : args.manager;
				const boss = manager === undefined ? undefined : memberNamed(registry, manager);
				if (manager !== undefined && (!boss || roleOf(boss) !== "manager" || boss.archived))
					return reply(`No manager named ${manager}.`, {}, true);
				if (openDelegations(registry).some((each) => each.to === name))
					return reply(
						`${name} has open work: wait or stop it before moving it.`,
						{ refused: { working: true } },
						true,
					);
				await api.commit(async (tx) => {
					const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
					const target = memberNamed(state, name);
					if (!target) return;
					if (manager === undefined) {
						delete target.manager;
						delete target.parent;
					} else {
						target.manager = manager;
						const next = memberNamed(state, manager);
						if (next) target.parent = next.conversationId;
					}
					await configure(tx, target.conversationId, {
						instructions: instructionsFor("executor", name, target.duty, manager, target.notes),
					});
				}, context);
				return reply(
					manager === undefined ? `${name} now works for the main agent.` : `${name} now works for ${manager}.`,
					{
						...memberDetails(agent),
						...(manager === undefined ? {} : { manager }),
					},
				);
			}

			// hire and configure: validate every choice before a commit, so a typo changes nothing.
			const placing = args.cwd !== undefined || args.env !== undefined;
			if (args.followSession && (action !== "configure" || placing))
				return reply("followSession is for configure, without env or cwd.", {}, true);
			let role: Role = agent ? roleOf(agent) : "executor";
			let manager: string | undefined = agent?.manager;
			if (action === "hire") {
				if (agent)
					return reply(`${name} already exists${agent.archived ? " (archived: restore it)" : ""}.`, {}, true);
				if (!MEMBER_NAME.test(name) || RESERVED_NAMES.has(name))
					return reply(
						`${name} is not a name a member can have: use letters, digits, ".", "_" and "-".`,
						{},
						true,
					);
				if (args.role === undefined) return reply('hire needs role ("manager" or "executor").', {}, true);
				role = args.role;
				if (!args.duty?.trim()) return reply("hire needs a duty: one line on what the member is for.", {}, true);
				if (role === "manager" && args.manager !== undefined && args.manager !== null)
					return reply("A manager works for the main agent: hire it without manager.", {}, true);
				manager = args.manager ?? undefined;
				const boss = manager === undefined ? undefined : memberNamed(registry, manager);
				if (manager !== undefined && (!boss || roleOf(boss) !== "manager" || boss.archived))
					return reply(`No manager named ${manager}: hire the manager first.`, {}, true);
			} else if (
				args.model === undefined &&
				args.thinkingLevel === undefined &&
				args.tools === undefined &&
				!placing &&
				!args.followSession
			)
				return reply("configure needs model, thinkingLevel, tools, env, cwd or followSession.", {}, true);
			const choice = await resolveChoice(models, giver, access(), args, agent, role, context);
			if (typeof choice === "string") return reply(choice, {}, true);
			const { model, thinkingLevel, ...tools } = choice;
			// A location changes between runs, never under one: its tools would switch machines mid-task.
			if (
				agent &&
				(placing || args.followSession) &&
				(await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
			)
				return reply(
					`${name} is working: wait before changing its location.`,
					{ refused: { working: true } },
					true,
				);
			/** Its own location; `null`: it follows the session (again). */
			let location: Location | null | undefined;
			if (args.followSession) location = null;
			else if (placing) {
				// From where the session works (the HR manager follows it).
				const caller = await locator.locate(api.conversationId, api, context);
				if (args.env !== undefined && args.env !== caller.env && (await originOf(api, context)) !== "owner")
					return reply("Another environment needs a turn the owner started.", {}, true);
				// A member in a sandbox: a cwd alone means a path in that sandbox (it cannot be placed elsewhere).
				const kept = agent?.location && args.env === undefined ? await locator.sandbox(agent.location) : undefined;
				const placed = await placeTarget(
					locator,
					caller,
					kept === undefined ? args : { ...args, env: kept },
					context,
				);
				if (typeof placed === "string") return reply(placed, {}, true);
				if ("refused" in placed)
					return reply(placementRefusal(placed), { refused: { sandbox: placed.sandbox } }, true);
				location = placed.location;
			}
			// A member working in a sandbox stays there, whoever configures it (only the owner's Relocate leaves one).
			const sandbox = agent?.location === undefined ? undefined : await locator.sandbox(agent.location);
			if (sandbox !== undefined && location !== undefined) {
				const next = location ?? (await locator.locate(ROOT_CONVERSATION_ID, api, context));
				if (next.env !== sandbox)
					return reply(`${name} works in sandbox ${sandbox} and cannot leave it.`, { refused: { sandbox } }, true);
			}
			// A member following the session works at its cwd.
			const session = location === null ? await locator.locate(ROOT_CONVERSATION_ID, api, context) : undefined;
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				if (action === "hire") {
					if (Object.hasOwn(state.agents, name)) return undefined;
					await createMember(tx, state, name, {
						role,
						...(manager === undefined ? {} : { manager }),
						duty: args.duty?.trim() ?? "",
						model,
						thinkingLevel,
						tools,
						...(location ? { location } : {}),
					});
					return memberDetails(state.agents[name]!);
				}
				const target = memberNamed(state, name);
				if (!target) return undefined;
				await configure(tx, target.conversationId, {
					model,
					thinkingLevel,
					...agentTools(tools),
					...(location ? { cwd: location.cwd } : session ? { cwd: session.cwd } : {}),
				});
				if (location) target.location = location;
				else if (location === null) delete target.location;
				target.model = `${model.provider}/${model.modelId}`;
				target.thinkingLevel = thinkingLevel;
				target.tools = tools.chosen;
				return memberDetails(target);
			}, context);
			if (!result)
				return reply(action === "hire" ? `${name} already exists.` : `No team member named ${name}.`, {}, true);
			// Every member has one, even before the HR manager writes it.
			if (action === "hire") await deps.files.ensure(name);
			const what =
				action === "configure"
					? `Configured ${name}.`
					: role === "manager"
						? `Hired the manager ${name}.`
						: manager === undefined
							? `Hired the direct executor ${name}.`
							: `Hired ${name} into ${manager}'s team.`;
			return reply(what, result);
		},
	});
}

/**
 * A member's own notes: lasting lessons it writes down for its future self. They become part of its instructions, so
 * they survive compaction and restarts; the newest `NOTES_KEPT` are kept.
 */
function rememberTool(): P2Tool {
	return defineP2Tool({
		name: "remember",
		description: [
			"Keep a note for yourself: a lasting lesson (a convention, a gotcha, how this project works) you should carry",
			"into later work. It becomes part of your instructions, so write it for your future self, in one or two",
			"sentences; do not use it for transient state. The newest few notes are kept.",
		].join("\n"),
		parameters: obj({ text: str({ minLength: 1, maxLength: NOTE_LENGTH }) }),
		// A crash-interrupted call would append twice on retry.
		replay: "unsafe",
		deferred: true,
		scope: "subagent",
		execute: async (args, api, context) => {
			const text = args.text.replace(/\s+/g, " ").trim();
			const reply = (message: string, isError = false) => ({
				output: [{ type: "text" as const, text: message }],
				isError,
			});
			if (!text) return reply("remember needs a note.", true);
			const before = await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
			const self = before ? memberOf(before, api.conversationId) : undefined;
			if (!self) return reply("Only team members can keep notes.", true);
			await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const found = memberOf(state, api.conversationId);
				if (!found) return;
				const [name, agent] = found;
				agent.notes = [...(agent.notes ?? []), text].slice(-NOTES_KEPT);
				await configure(tx, agent.conversationId, {
					instructions: instructionsFor(roleOf(agent), name, agent.duty, agent.manager, agent.notes),
				});
			}, context);
			return reply("Noted.");
		},
	});
}

/** The team's tools, with the tasks behind them: installed in every conversation, each given by its scope. */
/**
 * What the main agent is told about its team (section `team-lead`): who it is to the members and what to do first.
 * Without it the agent knows the team only from the `subagent` tool's description, and reads a question about its
 * "managers" as one about sessions.
 */
export const TEAM_LEAD_PROMPT = [
	"You lead a team of members that work in the background while you talk to the user. You are the team's only entry:",
	"the user talks to you, and members report to you, never to the user.",
	"- For anything about the team, look first with `subagent status` (the members in order, who is working, the open",
	"  work), and do not answer from memory. A team member is not a session: the conversations tool does not reach it.",
	"- The HR manager is always there. Staffing goes through it: ask it with `subagent hire` to hire managers and",
	"  executors, change them, move executors between managers, archive or restore them, or write a member's own",
	"  AGENTS.md.",
	"- Give work with `subagent send` to a manager (it splits the work among its own executors, and its answer reaches",
	"  you once its whole team is done) or to a direct executor. Answers arrive as messages: do not wait or poll.",
	"- `subagent stop` stops a member's current work; `subagent answer` returns its latest answer.",
].join("\n");

/**
 * The team's prompt sections. `member-agents`: a member's own AGENTS.md, which the HR manager keeps, added to every
 * generation of its conversation (the main agent and one-shot agents have none). `team-lead`: the main agent's guide
 * to its team, for an agent that has the `subagent` tool (only top-level conversations do: it is `scope: "main"`).
 */
export function teamPromptExtension(files: TeamFiles): Extension<P2Tool> {
	return defineExtension<P2Tool>({
		name: "p2-team-prompt",
		sections: [
			section("member-agents", async (input, context) => {
				const registry = await input.read.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
				const member = registry ? memberOf(registry, input.conversationId) : undefined;
				if (!member) return undefined;
				const text = await files.read(member[0]);
				return text?.trim() ? text.slice(0, AGENTS_LENGTH) : undefined;
			}),
			section("team-lead", (input) =>
				input.agent.tools.some((tool) => tool.name === SUBAGENT_TOOL) ? TEAM_LEAD_PROMPT : undefined,
			),
		],
	});
}

export function createTeamExtension(deps: TeamDeps): Extension<P2Tool> {
	return defineExtension<P2Tool>({
		name: SUBAGENT_EXTENSION,
		tasks: [Anchor, Reporter, Settle, Stop],
		tools: [subagentTool(deps), staffTool(deps), delegateTool(deps), rememberTool()],
	});
}
