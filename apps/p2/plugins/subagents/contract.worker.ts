// Worker-side contracts of the subagents plugin: the session's team registry (a Durable document other worker plugins
// read: one-shot agents, search, PowerShell), with each member's role and the team's delegations; the tool choices team
// members and one-shot agents resolve alike from their giver's tools; and giving a member its own location (a granted
// `location_move`).

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models";
import {
	type Agent,
	type ConversationId,
	configure,
	defineDoc,
	type EntryId,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { type Context, keyedRegistry, type Location } from "@p2/app/v1";
import type { P2Tool } from "@p2/app/v1/worker";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const TEAM_TOOL = "team";
/** The HR manager's tool: hiring and staffing the team. */
export const STAFF_TOOL = "staff";
/** A manager's tool: giving work to its own executors. */
export const DELEGATE_TOOL = "delegate";

/**
 * A team member's role. The main agent is the team's only entry: it asks the HR manager (`hr`) to hire, and gives work
 * to managers and direct executors; a manager gives work to its own executors.
 */
export type Role = "hr" | "manager" | "executor";

/** A member's role: a subagent from before roles is a direct executor. */
export const roleOf = (agent: Pick<Subagent, "role">): Role => agent.role ?? "executor";

/** Where a delegation stands. `waiting`: a manager answered, its report waits until its team is done. */
export type DelegationStatus = "working" | "waiting" | "stopping" | "done" | "failed" | "stopped";

/** One piece of work given to a member: by the main agent (`subagent hire`/`send`) or a manager (`delegate send`). */
export type Delegation = {
	id: number;
	/** Who gave it: "main", or a manager's name. */
	from: string;
	/** The member doing it. */
	to: string;
	/** The conversation its report goes to. */
	parent: ConversationId;
	/** The work as given, at most `DELEGATION_TEXT` characters. */
	text: string;
	status: DelegationStatus;
	createdAt: number;
	endedAt?: number;
	/** The answer it ended with, at most `DELEGATION_RESULT` characters. */
	result?: string;
	/**
	 * The answer entry the member's last run gave for this work, once a manager's answer waits for its team: the settle
	 * task reports it, not whatever the manager answered last in the meantime.
	 */
	answer?: EntryId;
	/** Who stopped it: "main", "owner", "hr", "system" or a manager's name. */
	stoppedBy?: string;
};

/** How much of a delegation's work and result the registry keeps, and how many ended delegations. */
export const DELEGATION_TEXT = 200;
export const DELEGATION_RESULT = 300;
export const DELEGATIONS_KEPT = 100;

/** A delegation that has not ended: its member still has it (working, waiting for its team, or being stopped). */
export const isOpen = (delegation: Pick<Delegation, "status">): boolean =>
	delegation.status === "working" || delegation.status === "waiting" || delegation.status === "stopping";

/** What a stop flow tells a hook about one delegation it stopped. */
export type DelegationStoppedEvent = {
	delegation: Delegation;
	/** Who stopped it: "main", "owner", "hr", "system" or a manager's name. */
	by: string;
	/** The members this stop covered (a manager's stop covers its executors too). */
	scope: readonly string[];
	/** The members' runs were confirmed ended. */
	verified: boolean;
	/** The registry as the flow's closing commit reads it (read only). */
	registry: SubagentState;
};
/** A message a hook asks the flow to deliver: committed with the flow's closing commit, once. */
export type StopNotice = {
	to: ConversationId;
	/** The stopped member the message is from. */
	from: { name: string; conversationId: ConversationId };
	text: string;
};
/**
 * Worker extension point of the stop flow: told of each delegation a stop ended, a handler returns the notices to send
 * (it decides, the flow delivers). The subagents plugin's own handler tells whoever gave the work.
 */
export type DelegationStoppedHandler = (
	event: DelegationStoppedEvent,
) => readonly StopNotice[] | Promise<readonly StopNotice[]>;
export const DelegationStopped = keyedRegistry<DelegationStoppedHandler>("p2.delegation-stopped");

export type Subagent = {
	conversationId: ConversationId;
	model: string;
	thinkingLevel: string;
	tools: string[];
	/**
	 * Its own location, chosen at spawn (e.g. a git worktree, on the caller's environment) and kept when the session
	 * moves; absent: it follows the session.
	 */
	location?: Location;
	/**
	 * An own cwd from version 1, which did not record the environment: the worker places it (`placeSubagents`) on the
	 * environment it was spawned on before the Harness is live, so no one else reads it.
	 */
	unplacedCwd?: string;
	/**
	 * The top-level conversation that last spawned it or sent it a message (the main conversation or a `/tree` branch):
	 * where `team send to: "parent"` goes. Absent (spawned before it was recorded): the current main conversation.
	 */
	parent?: ConversationId;
	/** Answers already reported: several messages can end in one answer, reported once. */
	reported: EntryId[];
	/**
	 * Reported answers by giver: `<answer entry>:<parent conversation>`. An answer two delegations end is reported once
	 * to each conversation that gave the work (`reported` alone would report it to only one of them).
	 */
	reportedTo?: string[];
	/** Hidden from the sidebar's list and `status`; still usable, and `send` restores it. */
	archived?: true;
	/** Its role in the team; absent (a subagent from before roles): an executor (`roleOf`). */
	role?: Role;
	/** An executor's manager (a member's name); absent: a direct executor, which the main agent gives work to. */
	manager?: string;
	/** What it is for, as the HR manager hired it. */
	duty?: string;
	/** The stop flow stopping it now (`p2.team-stop`): no new work reaches it until that flow ends. */
	stopping?: TaskId;
	/** A manager's settle task (`p2.team-settle`): it reports the manager's answer once its team is done. */
	settling?: TaskId;
	/** Why its last work was stopped: told with the next work it gets, then cleared. */
	stopNote?: string;
};
/** A code mode script's one-shot agent (plugins/agent), listed for inspection from the script's tool card. */
export type OneShot = {
	conversationId: ConversationId;
	label: string;
	model: string;
	thinkingLevel: string;
	tools: string[];
};
export type SubagentState = {
	agents: Record<string, Subagent>;
	reporters: Record<string, TaskId>;
	/** One-shot agents by the nested call ID that ran them (`<script call ID>/c<n>`). */
	oneShots?: Record<string, OneShot>;
	/** The team's work by ID: every open delegation, and the newest `DELEGATIONS_KEPT` ended ones. */
	delegations?: Record<string, Delegation>;
	/** The next delegation's ID. */
	nextDelegation?: number;
};
/**
 * The session's subagent registry. Kept on conversation 1 for every top-level conversation (the main conversation and
 * its `/tree` branches, `docs/tree.md`): subagents are session-wide and outlive branch switches.
 * TODO: this should probably be a session-scoped document; moving it there needs a migration of existing sessions.
 */
export const Subagents = defineDoc<SubagentState>({
	kind: "p2.subagents",
	// 2: an own location (environment and cwd) instead of an own cwd (version 1's is `unplacedCwd` until placed).
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unknown p2.subagents version ${fromVersion}`);
		const state = value as unknown as SubagentState & { agents: Record<string, Subagent & { cwd?: string }> };
		return {
			...state,
			agents: Object.fromEntries(
				Object.entries(state.agents).map(([name, { cwd, ...agent }]) => [
					name,
					cwd === undefined ? agent : { ...agent, unplacedCwd: cwd },
				]),
			),
		};
	},
	checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** A subagent's model ('provider/modelId'), thinking level and tools, as the tools take them. */
export type AgentChoice = { model?: string; thinkingLevel?: string; tools?: string[] };

/** The tools an agent gets, as `resolveTools` resolves them. */
export type ToolChoice = {
	/** The tools it chose (or got by default), by name: what its registry entry records and `configure` keeps. */
	readonly chosen: string[];
	/**
	 * Every tool it gets: the chosen ones, the script-only ones with code mode, and a team member's own (`team`, and its
	 * role's: `staff` for the HR manager, `delegate` for a manager).
	 */
	readonly tools: ToolRegistration[];
	/** Deferred tools it is offered from the start: a member's own ones, and deferred ones chosen by name. */
	readonly loaded: ToolRegistration[];
};

/**
 * Whose model, thinking level and tools an agent starts from (`Agent` of a tool call, `api`, or of a conversation): a
 * one-shot agent its caller's; a team member the main agent's, whoever hires or configures it (the HR manager has no
 * tools to give).
 */
export type Giver = { agent(context: Context): Promise<Agent> };

/**
 * Validates a choice before any commit, so a typo changes nothing; an error is returned as text. Unset fields keep
 * `current`'s (its recorded tools as far as the giver can still give them), or for a new agent the giver's model and
 * thinking level and every tool the giver may give (`resolveTools`).
 */
export async function resolveChoice(
	models: Models,
	giver: Giver,
	access: ReadonlyMap<string, P2Tool>,
	choice: AgentChoice,
	current: Subagent | undefined,
	kind: AgentKind,
	context: Context,
): Promise<({ model: ModelRef; thinkingLevel: ModelThinkingLevel } & ToolChoice) | string> {
	const own = await giver.agent(context);
	const text = choice.model ?? current?.model;
	const slash = text?.indexOf("/") ?? -1;
	const ref =
		text === undefined
			? own.model
			: slash > 0
				? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) }
				: undefined;
	const model = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
	if (!ref || !model)
		return `Unknown model ${choice.model ?? "(none)"}.${kind === "one-shot" ? "" : " Use the staff tool's models action to list them."}`;
	if (choice.thinkingLevel !== undefined && !THINKING.includes(choice.thinkingLevel))
		return `Invalid thinkingLevel ${choice.thinkingLevel}.`;
	const requested = (choice.thinkingLevel ?? current?.thinkingLevel ?? own.thinkingLevel) as ModelThinkingLevel;
	const tools = resolveTools(own, access, choice.tools ?? stillGiven(own, access, current), choice.tools ?? [], kind);
	if (typeof tools === "string") return tools;
	return { model: ref, thinkingLevel: clampThinkingLevel(model, requested), ...tools };
}

/** Which agent gets the tools: a team member of a role also gets its own (`resolveTools`); a one-shot agent none. */
export type AgentKind = Role | "one-shot";

/** The giver's tools an agent may be given: the ones its model calls, except those only some agents get (`scope`). */
export function choosableTools(caller: CallerTools, access: ReadonlyMap<string, P2Tool>): ToolRegistration[] {
	return everyTool(caller).filter((tool) => calledByModel(tool) && scopeOf(tool, access) === "any");
}

/** `current`'s recorded tools that the giver can still give; undefined for a new agent (all of them). */
export function stillGiven(
	caller: CallerTools,
	access: ReadonlyMap<string, P2Tool>,
	current: Subagent | undefined,
): string[] | undefined {
	const choosable = new Set(choosableTools(caller, access).map((tool) => tool.name));
	return current?.tools.filter((name) => choosable.has(name));
}

/**
 * The tools an agent of `kind` gets from a giver with tools `caller`: `names` among its choosable tools (default: all),
 * with code mode the giver's script-only tools (MCP tools, the terminal, `agent`, code mode's own), and for a team
 * member its own: the `scope: "subagent"` ones, and its role's (`scope: "hr"` for the HR manager, `"manager"` for a
 * manager). Deferred tools stay deferred, except those in `load`. Text names the tools `names` may not choose.
 */
export function resolveTools(
	caller: CallerTools,
	access: ReadonlyMap<string, P2Tool>,
	names: readonly string[] | undefined,
	load: readonly string[],
	kind: AgentKind,
): ToolChoice | string {
	const all = everyTool(caller);
	const choosable = choosableTools(caller, access);
	const unknown = (names ?? []).filter((name) => !choosable.some((tool) => tool.name === name));
	if (unknown.length) {
		const whose = kind === "one-shot" ? "your own tools" : "the main agent's tools";
		return `Unknown tools: ${unknown.join(", ")}. Choose from ${whose}: ${choosable.map((tool) => tool.name).join(", ")}.`;
	}
	// In the order given, each once.
	const chosen =
		names === undefined
			? choosable
			: [...new Set(names)].flatMap((name) => choosable.filter((tool) => tool.name === name));
	// Code mode brings the script-only tools anyone may call: never a role's own.
	const scripts = chosen.some((tool) => tool.name === CODEMODE_TOOL)
		? all.filter((tool) => !calledByModel(tool) && !["main", "hr", "manager"].includes(scopeOf(tool, access)))
		: [];
	const own =
		kind === "one-shot"
			? []
			: all.filter((tool) => {
					const scope = scopeOf(tool, access);
					return scope === "subagent" || scope === kind;
				});
	return {
		chosen: chosen.map((tool) => tool.name),
		tools: [...chosen, ...scripts, ...own],
		loaded: [...own, ...chosen.filter((tool) => tool.deferred && load.includes(tool.name))],
	};
}

/** A caller's resolved agent: the tools offered to its model, its deferred ones and the ones scripts call. */
export type CallerTools = Pick<Agent, "tools" | "deferred" | "callable">;

/** The code mode tool (plugins/codemode): choosing it brings the tools only scripts call. */
export const CODEMODE_TOOL = "codemode";

/** Whether the model may call `tool` (`callers`); the others are script-only: MCP tools in code mode, `agent`, … */
export const calledByModel = (tool: ToolRegistration): boolean => tool.callers?.includes("model") ?? true;

/** Every tool the caller has, each once. */
const everyTool = (caller: CallerTools): ToolRegistration[] => [
	...new Map([...caller.tools, ...caller.deferred, ...caller.callable].map((tool) => [tool.name, tool])).values(),
];

/** Where a tool works, as its plugin declared it. */
const scopeOf = (tool: ToolRegistration, access: ReadonlyMap<string, P2Tool>) => access.get(tool.name)?.scope ?? "any";

/**
 * The own location a one-shot agent inherited from the conversation whose script started it (a subagent with its own
 * location, or another one-shot agent of one); absent: it follows the session like its caller.
 */
export const InheritedLocation = defineDoc<{ location?: Location }>({
	kind: "p2.inherited-location",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/**
 * Gives the subagent working in `conversationId` its own location `location` (a granted `location_move`), in `tx`:
 * its registry entry and its agent cwd. False when the conversation is not a subagent (one-shot agents are not).
 */
export async function placeSubagent(tx: Tx, conversationId: ConversationId, location: Location): Promise<boolean> {
	const agent = Object.values((await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents).find(
		(each) => each.conversationId === conversationId,
	);
	if (!agent) return false;
	agent.location = location;
	await configure(tx, conversationId, { cwd: location.cwd });
	return true;
}
