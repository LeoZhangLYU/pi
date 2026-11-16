// The team's records in the session's registry (`contract.worker.ts`): who has which role, what each role is told, and
// the delegations the subagent, staff and delegate tools open and the Reporter ends. Pure functions over the registry
// document, used inside commits.

import type { ConversationId } from "@earendil-works/pi-durable";
import { locationText } from "@p2/app/v1";
import {
	DELEGATION_RESULT,
	DELEGATION_TEXT,
	DELEGATIONS_KEPT,
	type Delegation,
	type DelegationStoppedEvent,
	isOpen,
	type Role,
	roleOf,
	type StopNotice,
	type Subagent,
	type SubagentState,
} from "./contract.worker.ts";

/** Who gives work: the main agent, or a manager by name. */
export const MAIN = "main";

/** A member's name: what other members and the transcript call it. */
export const MEMBER_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Names no member may take: `team send to: "parent"`, and the main agent in delegations. */
export const RESERVED_NAMES = new Set(["main", "parent"]);

/** The member whose conversation is `conversationId`, with its name. */
export function memberOf(state: Pick<SubagentState, "agents">, conversationId: number): [string, Subagent] | undefined {
	return Object.entries(state.agents).find(([, agent]) => agent.conversationId === conversationId);
}

/** The team in order: the HR manager, each manager followed by its executors, then the direct executors. */
export function teamOrder(state: Pick<SubagentState, "agents">): [string, Subagent][] {
	const all = Object.entries(state.agents);
	const ordered = all.filter(([, agent]) => roleOf(agent) === "hr");
	for (const manager of all.filter(([, agent]) => roleOf(agent) === "manager")) {
		ordered.push(manager);
		ordered.push(...all.filter(([, agent]) => roleOf(agent) === "executor" && agent.manager === manager[0]));
	}
	const listed = new Set(ordered.map(([name]) => name));
	return [...ordered, ...all.filter(([name]) => !listed.has(name))];
}

/**
 * Whom member `self` may message with the team tool besides whoever gave it its work (`to: "parent"`): the HR manager
 * nobody; a manager the other managers; an executor its manager and the other executors of its team, a direct executor
 * the other direct executors.
 */
export function peersOf(state: Pick<SubagentState, "agents">, self: string): [string, Subagent][] {
	const me = state.agents[self];
	if (!me) return [];
	const role = roleOf(me);
	return Object.entries(state.agents).filter(([name, other]) => {
		if (name === self || role === "hr") return false;
		if (role === "manager") return roleOf(other) === "manager";
		if (me.manager !== undefined && name === me.manager) return true;
		return roleOf(other) === "executor" && other.manager === me.manager;
	});
}

/** The team as the status and roster actions list it: one line per member, in team order, then the open work. */
export function rosterText(state: SubagentState, busy: ReadonlySet<string>, only: string | undefined): string {
	const all = teamOrder(state);
	const listed =
		only === undefined ? all.filter(([, agent]) => !agent.archived) : all.filter(([name]) => name === only);
	const lines = listed.map(([name, agent]) => {
		const indent = roleOf(agent) === "executor" && agent.manager !== undefined ? "  " : "";
		const where = agent.location === undefined ? "" : ` · in ${locationText(agent.location)}`;
		return [
			`${indent}${name}: ${roleText(agent)} · ${busy.has(name) ? "working" : "idle"}`,
			agent.archived ? " · archived" : "",
			agent.stopping === undefined ? "" : " · being stopped",
			` · ${agent.model} · thinking ${agent.thinkingLevel} · tools ${agent.tools.join(", ") || "none"}${where}`,
			agent.duty ? ` · ${agent.duty}` : "",
		].join("");
	});
	const archived = only === undefined ? all.length - listed.length : 0;
	if (archived) lines.push(`${archived} archived (status with a name shows one).`);
	const open = only === undefined ? openDelegations(state) : [];
	if (open.length) lines.push("Open work:", ...open.map((delegation) => `  ${delegationLine(delegation)}`));
	return lines.length ? lines.join("\n") : "No team members.";
}

/** The HR manager's name and entry, if the session has one. */
export function hrOf(state: Pick<SubagentState, "agents">): [string, Subagent] | undefined {
	return Object.entries(state.agents).find(([, agent]) => roleOf(agent) === "hr");
}

/** The name a new HR manager gets: `hr`, or `hr-2`, `hr-3`, … when a subagent from before roles has it. */
export function hrName(state: Pick<SubagentState, "agents">): string {
	if (!Object.hasOwn(state.agents, "hr")) return "hr";
	for (let n = 2; ; n++) if (!Object.hasOwn(state.agents, `hr-${n}`)) return `hr-${n}`;
}

/**
 * The call that answers what member `name` reports or asks to whoever gave it the work: the HR manager is asked with
 * `subagent hire`, a team executor's manager answers with `delegate send`, the main agent with `subagent send`.
 */
export function replyFor(agent: Pick<Subagent, "role" | "manager"> | undefined, name: string): string {
	if (agent && roleOf(agent) === "hr") return "subagent hire";
	return agent?.manager !== undefined ? `delegate send to ${name}` : `subagent send to ${name}`;
}

/**
 * The call that answers a team message from member `senderName` to the conversation `receiver`: a manager answers its
 * executor with `delegate send`, a member that is none of the team's (the main agent, or a branch of it) answers as
 * `replyFor` says, and peers with `team send`.
 */
export function replyToMember(state: Pick<SubagentState, "agents">, senderName: string, receiver: number): string {
	const sender = state.agents[senderName];
	const target = memberOf(state, receiver);
	if (!target) return replyFor(sender, senderName);
	if (roleOf(target[1]) === "manager" && sender?.manager === target[0]) return `delegate send to ${senderName}`;
	return `team send to ${senderName}`;
}

/** A role as the team's lists name it. */
export function roleText(agent: Pick<Subagent, "role" | "manager">): string {
	const role = roleOf(agent);
	if (role === "hr") return "HR manager";
	if (role === "manager") return "manager";
	return agent.manager === undefined ? "direct executor" : `executor of ${agent.manager}`;
}

/** What a member is told about its place in the team: its agent's instructions. */
export function instructionsFor(
	role: Role,
	name: string,
	duty: string | undefined,
	manager: string | undefined,
): string {
	const what = duty ? `, responsible for: ${duty}.` : ".";
	if (role === "hr")
		return [
			`You are "${name}", the team's HR manager, working for the main agent.`,
			"You only staff the team, with the staff tool: hire managers and executors, configure them, move executors between managers, archive and restore them.",
			"Never do the work yourself, and never give anyone work: the main agent and the managers do that.",
			"For each hire choose a short name, its role, a one-line duty, and the model, thinking level, tools and location that fit the duty (staff models lists the models).",
			"Answer concisely with whom you hired or changed and what each is for; your answer is reported back to the main agent.",
			"If a request is unclear, ask the main agent with the team tool.",
		].join(" ");
	if (role === "manager")
		return [
			`You are the manager "${name}", working for the main agent${what}`,
			"Split the work you get into pieces and give them to your executors with the delegate tool (delegate status lists them); their answers come back to you as messages.",
			"Do small parts yourself when that is quicker.",
			"Your answer is reported to the main agent only once your team is done: when every piece you gave out has ended, answer with the combined result.",
			"If you need more executors, tell the main agent with the team tool; you can also message the other managers with it.",
		].join(" ");
	if (manager !== undefined)
		return [
			`You are the executor "${name}" in the team of the manager "${manager}"${what}`,
			`Do the work you are given and answer concisely; your final answer is reported back to ${manager}.`,
			`With the team tool you can ask ${manager} a question or tell it something while you keep working, and message the other executors of your team.`,
		].join(" ");
	return [
		`You are the executor "${name}", working directly for the main agent${what}`,
		"Do the requested work and answer concisely; your final answer is reported back to it.",
		"With the team tool you can ask the main agent a question or tell it something while you keep working, and message the other direct executors.",
	].join(" ");
}

/**
 * The subagents plugin's own `DelegationStopped` handler: tells whoever gave the stopped work, unless they stopped it
 * themselves (their tool result lists what stopped) or are stopped with it (a manager's stop covers its executors'
 * work). The notice names the work, who stopped it, whom the giver could hand it to, and asks it to decide.
 */
export function stoppedNotices(event: DelegationStoppedEvent): StopNotice[] {
	const { delegation, by, scope, verified, registry } = event;
	const member = registry.agents[delegation.to];
	if (!member || delegation.from === by || scope.includes(delegation.from)) return [];
	// A member's own stop of its work is nobody's news; the main agent giving it work hears from the one who stopped it.
	if (delegation.from === MAIN && by === MAIN) return [];
	const others = Object.entries(registry.agents)
		.filter(([name, agent]) => {
			if (agent.archived || scope.includes(name)) return false;
			const role = roleOf(agent);
			if (delegation.from === MAIN)
				return role === "manager" || (role === "executor" && agent.manager === undefined);
			return role === "executor" && agent.manager === delegation.from;
		})
		.map(([name]) => name);
	const text = [
		`#${delegation.id} (${delegation.to}) was stopped by ${by}: ${delegation.text}`,
		verified ? "" : "Its run could not be confirmed ended.",
		others.length ? `Others you could give it to: ${others.join(", ")}.` : "No one else is free to take it.",
		"Decide now: give it to the same member again, to another, change your plan, or say in your answer that you cannot continue.",
		by === "owner" ? "The user stopped it: do not hand it out again unless they ask." : "",
	]
		.filter(Boolean)
		.join(" ");
	return [{ to: delegation.parent, from: { name: delegation.to, conversationId: member.conversationId }, text }];
}

/** What a member is told with its next work after its work was stopped: once, then cleared (`Subagent.stopNote`). */
export function stopNoteFor(
	registry: Pick<SubagentState, "delegations">,
	name: string,
	stopped: readonly number[],
	by: string,
): string | undefined {
	const all = stopped.flatMap((id) => {
		const delegation = delegationOf(registry, id);
		return delegation ? [delegation] : [];
	});
	const own = all.filter((delegation) => delegation.to === name);
	if (own.length === 0) return undefined;
	const given = all.filter((delegation) => delegation.from === name);
	return [
		`Your last work (${own.map((delegation) => `#${delegation.id}`).join(", ")}) was stopped by ${by}.`,
		given.length
			? `The work you had given out stopped with it: ${given.map((delegation) => `#${delegation.id} (${delegation.to})`).join(", ")}.`
			: "",
	]
		.filter(Boolean)
		.join(" ");
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Opens a delegation of `text` from `from` to `to` (working), whose report goes to `parent`; returns its ID. */
export function openDelegation(
	state: SubagentState,
	fields: { from: string; to: string; parent: ConversationId; text: string },
	now: number,
): number {
	const id = state.nextDelegation ?? 1;
	state.nextDelegation = id + 1;
	state.delegations ??= {};
	state.delegations[String(id)] = {
		id,
		from: fields.from,
		to: fields.to,
		parent: fields.parent,
		text: clip(fields.text.replace(/\s+/g, " ").trim(), DELEGATION_TEXT),
		status: "working",
		createdAt: now,
	};
	return id;
}

/** Delegation `id`, if the registry still has it. */
export const delegationOf = (
	state: Pick<SubagentState, "delegations">,
	id: number | undefined,
): Delegation | undefined => (id === undefined ? undefined : state.delegations?.[String(id)]);

/**
 * Ends open delegation `id` with `status`, its answer `result` and who stopped it, then drops the oldest ended ones
 * past `DELEGATIONS_KEPT`. An ended or unknown delegation is left as it is. Returns the delegation.
 */
export function endDelegation(
	state: SubagentState,
	id: number | undefined,
	status: "done" | "failed" | "stopped",
	now: number,
	result?: string,
	stoppedBy?: string,
): Delegation | undefined {
	const delegation = delegationOf(state, id);
	if (!delegation || !isOpen(delegation)) return delegation;
	delegation.status = status;
	delegation.endedAt = now;
	if (result?.trim()) delegation.result = clip(result.trim(), DELEGATION_RESULT);
	if (stoppedBy !== undefined) delegation.stoppedBy = stoppedBy;
	const ended = Object.values(state.delegations ?? {})
		.filter((each) => !isOpen(each))
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id);
	for (const old of ended.slice(DELEGATIONS_KEPT)) delete state.delegations?.[String(old.id)];
	return delegation;
}

/** The open delegations, oldest first. */
export const openDelegations = (state: SubagentState): Delegation[] =>
	Object.values(state.delegations ?? {})
		.filter(isOpen)
		.sort((a, b) => a.id - b.id);

const STATUS_TEXT: Record<Delegation["status"], string> = {
	working: "working",
	waiting: "waiting for its team",
	stopping: "being stopped",
	done: "done",
	failed: "failed",
	stopped: "stopped",
};

/** One delegation as the team's lists show it. */
export function delegationLine(delegation: Delegation): string {
	const by = delegation.stoppedBy === undefined ? "" : ` by ${delegation.stoppedBy}`;
	return `#${delegation.id} ${delegation.from} → ${delegation.to}: ${STATUS_TEXT[delegation.status]}${by} · ${delegation.text}`;
}
