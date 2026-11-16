import { arr, bool, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	evolve,
	type Location,
	LocationSchema,
	literal,
	local,
	method,
	param,
	record,
	remote,
	serverHost,
	sessionHost,
} from "@p2/app/v1";

/** A child as `Subagents` version 2 listed it: before team roles. */
const ChildSchemaV2 = obj({
	name: str(),
	kind: opt(literal("agent")),
	callId: opt(str()),
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	location: opt(LocationSchema),
	lastEntryId: num(),
});
export type ChildV2 = Static<typeof ChildSchemaV2>;

export const RoleSchema = union([literal("hr"), literal("manager"), literal("executor")]);

export const ChildSchema = obj({
	/** A team member's name; a one-shot agent's label. */
	name: str(),
	/** `agent`: a code mode script's one-shot agent, read-only and listed on the script's tool card, not the sidebar. */
	kind: opt(literal("agent")),
	/** A one-shot agent's nested call ID (`<script call ID>/c<n>`), as the script's tool card lists it. */
	callId: opt(str()),
	/** An archived member: hidden in the sidebar's archived row; still usable. */
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	/** A member's own location (environment and cwd, e.g. a git worktree); absent: it follows the session. */
	location: opt(LocationSchema),
	lastEntryId: num(),
	/** A team member's role; absent (a subagent from before roles): a direct executor. */
	role: opt(RoleSchema),
	/** A team executor's manager (a member's name); absent: it works directly for the main agent. */
	manager: opt(str()),
	/** What the member is for, as the HR manager hired it. */
	duty: opt(str()),
});
export type Child = Static<typeof ChildSchema>;

/** A member's role: a subagent from before roles is a direct executor. */
export const roleOfChild = (child: Pick<Child, "role">): "hr" | "manager" | "executor" => child.role ?? "executor";

/**
 * The team as the sidebar lists it: the HR manager, then each manager followed by its executors, then the direct
 * executors; within a group the most recently active first. One-shot agents are not members and stay out.
 */
export function teamRows(children: readonly Child[]): Child[] {
	const members = children
		.filter((child) => child.kind !== "agent")
		.toSorted((a, b) => b.lastEntryId - a.lastEntryId || b.conversationId - a.conversationId);
	const hr = members.filter((child) => roleOfChild(child) === "hr");
	const managers = members.filter((child) => roleOfChild(child) === "manager");
	const executors = members.filter((child) => roleOfChild(child) === "executor");
	const placed = new Set<string>();
	const rows = [...hr];
	for (const manager of managers) {
		rows.push(manager);
		for (const executor of executors)
			if (executor.manager === manager.name) {
				rows.push(executor);
				placed.add(executor.name);
			}
	}
	// Direct executors, and an executor whose manager is gone.
	rows.push(...executors.filter((executor) => !placed.has(executor.name)));
	return rows;
}

/** Whether `child` is shown under a manager (indented in the sidebar). */
export const isTeamExecutor = (child: Child, rows: readonly Child[]): boolean =>
	roleOfChild(child) === "executor" &&
	child.manager !== undefined &&
	rows.some((row) => roleOfChild(row) === "manager" && row.name === child.manager);

/** Where a conversation works: a child's own location, else the session's (the main conversation's). */
export const conversationLocation = (
	session: { readonly cwd: string; readonly env?: string | null } | undefined,
	child: Child | undefined,
): Location | undefined => child?.location ?? (session ? { cwd: session.cwd, env: session.env ?? null } : undefined);

/**
 * The remote environments a session's conversations work on: the session's, then its subagents' own (archived ones
 * included: still usable).
 */
export const remoteEnvironments = (
	session: { readonly env?: string | null } | undefined,
	children: readonly Child[] | undefined,
): string[] => [
	...new Set(
		[session?.env, ...(children ?? []).map((child) => child.location?.env)].filter(
			(env): env is string => typeof env === "string" && env !== "",
		),
	),
];

/**
 * The own locations the server recorded for a session's subagents, by conversation ID: a worker init value
 * (`subagentLocations`), so a worker places a version 1 own cwd on the environment it was spawned on.
 */
export const SubagentLocationsSchema = record(LocationSchema);
const ChildrenSchema = record(arr(ChildSchema));

/** Persistent sidebar metadata; transcripts remain in the worker's Durable storage. */
export const ChildStore = local("p2.child-store", {
	// 2: a child's own location instead of its own cwd. 3: a team member's role, manager and duty.
	version: 3,
	params: {},
	members: {
		children: ChildrenSchema,
		report: method(obj({ session: str(), generation: num(), children: arr(ChildSchema) })),
	},
});

/** Version 2, as released: children without team roles. */
const SubagentsV2 = remote("p2.subagents", {
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { children: record(arr(ChildSchemaV2)) } },
		reporter: { methods: { report: method(obj({ children: arr(ChildSchemaV2) })) } },
	},
});

/**
 * Workers report their own team members; readers never start workers just to fill the sidebar. 2: a child's own
 * location instead of its own cwd. 3: a member's role, manager and duty. The provider still serves 2 (its `accepts`).
 */
export const Subagents = evolve(SubagentsV2, (e) =>
	e.state("reader", "children", ChildrenSchema).args("report", obj({ children: arr(ChildSchema) })),
);

export const DelegationStatusSchema = union([
	literal("working"),
	literal("waiting"),
	literal("stopping"),
	literal("done"),
	literal("failed"),
	literal("stopped"),
]);

/** One piece of work given to a member (the registry's `delegations`), as the Team panel lists it. */
export const DelegationSchema = obj({
	id: num(),
	/** Who gave it: "main" or a manager's name. */
	from: str(),
	/** The member doing it. */
	to: str(),
	text: str(),
	status: DelegationStatusSchema,
	createdAt: num(),
	endedAt: opt(num()),
	result: opt(str()),
	stoppedBy: opt(str()),
});
export type DelegationInfo = Static<typeof DelegationSchema>;

/**
 * The session's team work, newest first: the open delegations and the latest ended ones. Read by the Team panel (the
 * members come from `Subagents`). Read only: the main agent is the team's only entry.
 */
export const TeamWork = remote("p2.team-work", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: { reader: { state: { delegations: arr(DelegationSchema) } } },
});

/** Changing the session's subagents from the browser (worker): the owner. */
export const SubagentControl = remote("p2.subagent-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		participant: {
			methods: {
				/**
				 * Archives a subagent (stopping its work first) or restores it. One-shot agents are read-only: they belong to
				 * the script waiting for their answer.
				 */
				archive: method(obj({ conversation: num(), archived: bool() })),
			},
		},
	},
});

export { ChildrenSchema };

export {
	AGENT_MESSAGE_ENTRY,
	type AgentMessage,
	AgentMessageSchema,
	SUBAGENT_TASK_ENTRY,
} from "@p2/app/v1";
