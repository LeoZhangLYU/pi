import { memo, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { SearchResults } from "../../plugins/search/contract.ts";
import type { Session } from "../../plugins/sessions/contract.ts";
import type { Child } from "../../plugins/subagents/contract.ts";
import { locationLabel } from "./path-label.ts";

export { locationLabel } from "./path-label.ts";
export type SessionSummary = Session & {
	subagents: Child[];
	/** `unread`: a finished answer the owner has not read on any device (see `SessionReads`). */
	worker: { busy: number[]; error?: string; unread?: boolean };
	/** A lifecycle operation of the session: running (`label` only), or failed with its error and a Dismiss. */
	operation?: { readonly label: string; readonly error?: string; readonly dismiss?: () => void };
};

import { useMessages } from "../runtime/web.tsx";
import { requestReveal } from "./Chat.tsx";
import { BranchIcon, ChevronIcon, FolderIcon, LockIcon, PencilIcon, PinIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { webMessages } from "./messages.ts";
import { PiLogo } from "./PiLogo.tsx";
import { getTheme, setTheme, subscribeTheme, type ThemePreference } from "./theme.ts";

/** Working (pulsing), else an unread answer (steady blue), else nothing. */
export function SessionDot({ worker }: { worker: SessionSummary["worker"] }) {
	const { t } = useMessages(webMessages);
	if (worker.busy?.length) return <span className="live-dot" title={t("working")} />;
	if (worker.unread) return <span className="unread-dot" title={t("newAnswer")} />;
	return null;
}

function ago(time: number): string {
	const seconds = Math.max(0, (Date.now() - time) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
	return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const THEMES: Record<ThemePreference, { labelKey: "themeSystem" | "themeLight" | "themeDark"; next: ThemePreference }> =
	{
		system: { labelKey: "themeSystem", next: "light" },
		light: { labelKey: "themeLight", next: "dark" },
		dark: { labelKey: "themeDark", next: "system" },
	};

/** Cycles System → Light → Dark; the choice is kept per browser. */
export function ThemeSetting() {
	const { t } = useMessages(webMessages);
	const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
	const { labelKey, next } = THEMES[theme];
	const label = t(labelKey);
	const nextLabel = t(THEMES[next].labelKey);
	return (
		<button
			type="button"
			className="foot-button"
			onClick={() => setTheme(next)}
			aria-label={t("themeSwitch", label, nextLabel)}
			title={t("themeTitle", label)}
		>
			<span>{t("theme")}</span>
			<span className="spacer" />
			<small className="row-value">{label}</small>
		</button>
	);
}

/**
 * A session's `/tree` branches (docs/tree.md), newest first in a stable order: switching only moves the "current" mark.
 * Shown from two branches on, behind the session row's expand control (`hidden` while collapsed). Choosing another branch switches the session to it (`onBranch`, the owner's); the pencil beside a
 * row renames it (`onRenameBranch`). A branch without a label (conversation 1's default) shows the session title. A
 * branch left while running goes on in the background: its row shows the working dot.
 */
function BranchRows({
	session,
	conversationId,
	active,
	onOpen,
	onBranch,
	onRenameBranch,
	hidden,
}: {
	session: SessionSummary;
	conversationId: number;
	active: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	onBranch: (id: string, conversationId: number) => void;
	onRenameBranch?: (id: string, conversationId: number) => void;
	hidden: boolean;
}) {
	const { t } = useMessages(webMessages);
	return (
		<div className="branch-rows" id={`branches-${session.id}`} hidden={hidden}>
			{session.branches.map((branch) => {
				const current = branch.conversation === session.main;
				const label = branch.label ?? session.title;
				return (
					<div className="branch-item" key={branch.conversation}>
						<button
							type="button"
							className={`subagent-row branch-row ${active && conversationId === branch.conversation ? "active" : ""}`}
							title={current ? t("currentBranch") : t("switchBranch")}
							onClick={() =>
								current ? onOpen(session.id, branch.conversation) : onBranch(session.id, branch.conversation)
							}
						>
							<span className="branch" />
							<BranchIcon size={13} />
							<span className="session-title">{label}</span>
							{current && <span className="session-meta">{t("current")}</span>}
							{session.worker.busy?.includes(branch.conversation) && (
								<span className="live-dot" title={t("working")} />
							)}
						</button>
						{onRenameBranch && (
							<button
								type="button"
								className="branch-rename"
								aria-label={t("renameBranchOf", label)}
								title={t("renameBranch")}
								onClick={() => onRenameBranch(session.id, branch.conversation)}
							>
								<PencilIcon />
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}

function SessionRow({
	session,
	conversationId,
	onOpen,
	onBranch,
	onRenameBranch,
	active = false,
	archived = false,
	children,
}: {
	session: SessionSummary;
	conversationId: number;
	onOpen: (id: string, conversationId?: number) => void;
	/** Switches the session to a branch (the owner); absent: no branch rows. */
	onBranch?: (id: string, conversationId: number) => void;
	/** Asks for a branch's new label (the owner). */
	onRenameBranch?: (id: string, conversationId: number) => void;
	/** The session is the one shown. */
	active?: boolean;
	archived?: boolean;
	children: ReactNode;
}) {
	const { t } = useMessages(webMessages);
	// One control expands a session's branch rows and its subagents; a subagent shown expands them. Not any conversation
	// but the main one: right after a `/tree` switch the page shows the new branch before the row names it main.
	const showsSubagent = session.subagents.some((agent) => agent.conversationId === conversationId);
	const [expanded, setExpanded] = useState(showsSubagent);
	useEffect(() => {
		if (showsSubagent) setExpanded(true);
	}, [showsSubagent]);
	// One-shot agents are opened from their script's tool card; archived subagents wait behind their own row.
	const listed = (archived ? [] : session.subagents)
		.filter((agent) => agent.kind !== "agent")
		.toSorted((a, b) => (b.lastEntryId ?? 0) - (a.lastEntryId ?? 0) || b.conversationId - a.conversationId);
	const agents = listed.filter((agent) => !agent.archived);
	const stored = listed.filter((agent) => agent.archived);
	const [showStored, setShowStored] = useState(false);
	const storedOpen = showStored || stored.some((agent) => agent.conversationId === conversationId);
	const branches = onBranch !== undefined && !archived && session.branches.length >= 2;
	const nestedWhat =
		branches && listed.length > 0
			? t("branchesAndSubagents")
			: branches
				? t("branchesOnly")
				: listed.length > 0
					? t("subagentsOnly")
					: undefined;
	const nested = nestedWhat !== undefined;
	const row = (agent: (typeof listed)[number]) => (
		<button
			type="button"
			key={agent.conversationId}
			className={`subagent-row ${conversationId === agent.conversationId ? "active" : ""}`}
			title={
				agent.location
					? t("worksIn", locationLabel(agent.location.env, agent.location.cwd))
					: t("followsSession", locationLabel(session.env, session.cwd))
			}
			onClick={() => onOpen(session.id, agent.conversationId)}
		>
			<span className="branch" />
			<span className="session-title">{agent.name}</span>
			<span className="session-meta">
				{/* A subagent with its own location shows it: it stays there when the session moves. */}
				{agent.location && (
					<span className="subagent-location">{locationLabel(agent.location.env, agent.location.cwd)}</span>
				)}
				{session.worker.busy?.includes(agent.conversationId) && <span className="live-dot" title={t("working")} />}
				{agent.model.split("/").pop()}
			</span>
		</button>
	);
	return (
		<div className="session-row">
			<div className={`session-header ${nested ? "has-subagents" : ""}`}>
				{children}
				{nested && (
					<button
						type="button"
						className="subagent-toggle"
						aria-label={t("expandOrCollapse", expanded, nestedWhat ?? "")}
						aria-expanded={expanded}
						aria-controls={[branches && `branches-${session.id}`, listed.length > 0 && `subagents-${session.id}`]
							.filter(Boolean)
							.join(" ")}
						onClick={() => setExpanded(!expanded)}
					>
						{listed.length > 0 && <span>{agents.length}</span>}
						{branches && (
							<span className="toggle-branches" title={t("branches", session.branches.length)}>
								<BranchIcon size={11} />
								{session.branches.length}
							</span>
						)}
						<span className={`chev ${expanded ? "open" : ""}`}>
							<ChevronIcon size={12} />
						</span>
					</button>
				)}
			</div>
			{session.operation && (
				<div className={`session-operation ${session.operation.error === undefined ? "" : "failed"}`}>
					<span title={session.operation.error}>
						{session.operation.label}
						{session.operation.error === undefined ? "" : `: ${session.operation.error}`}
					</span>
					{session.operation.dismiss && (
						<button type="button" className="text-action" onClick={session.operation.dismiss}>
							{t("dismiss")}
						</button>
					)}
				</div>
			)}
			{branches && (
				<BranchRows
					session={session}
					conversationId={conversationId}
					active={active}
					onOpen={onOpen}
					onBranch={onBranch}
					onRenameBranch={onRenameBranch}
					hidden={!expanded}
				/>
			)}
			{listed.length > 0 && (
				<div id={`subagents-${session.id}`} hidden={!expanded}>
					{agents.map(row)}
					{stored.length > 0 && (
						<button
							type="button"
							className="subagent-row subagent-stored"
							aria-expanded={storedOpen}
							onClick={() => setShowStored(!storedOpen)}
						>
							<span className="branch" />
							<span className="session-title">{t("archivedCount", stored.length)}</span>
							<span className={`chev ${storedOpen ? "open" : ""}`}>
								<ChevronIcon size={12} />
							</span>
						</button>
					)}
					{storedOpen && stored.map(row)}
				</div>
			)}
		</div>
	);
}

/** Memoized: the composer re-renders App on every keypress, and the session list need not follow. */
export const Drawer = memo(function Drawer({
	onSearch,
	onRestore,
	head,
	footer,
	sessions,
	activeId,
	conversationId,
	connected,
	onOpen,
	onBranch,
	onRenameBranch,
	onNew,
	onNewIn,
	onCollapse,
	onProviders,
	onEnvs,
	onOwnerLink,
	sandboxes,
}: {
	onSearch?: (query: string, archived: boolean) => Promise<SearchResults>;
	/** Restores an archived session and opens it (at `conversationId`, a message hit's). */
	onRestore: (id: string, conversationId?: number) => void;
	/** Entries above the folders (plugins' `drawer-head` slots), shown while the list is neither searched nor archived. */
	head?: ReactNode;
	footer?: ReactNode;
	sessions: SessionSummary[];
	activeId?: string;
	conversationId: number;
	connected: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	/** Switches a session to one of its `/tree` branches (the owner's). */
	onBranch?: (id: string, conversationId: number) => void;
	/** Asks for a new label of one of a session's `/tree` branches (the owner's). */
	onRenameBranch?: (id: string, conversationId: number) => void;
	onNew: () => void;
	/** Starts a new session in a sidebar folder's location; absent: folders have no "+". */
	onNewIn?: (env: string | null, cwd: string) => void;
	onCollapse: () => void;
	onProviders: () => void;
	onEnvs: () => void;
	onOwnerLink: () => void;
	/** Environments that are sandboxes (the owner's view): their groups show a lock. */
	sandboxes?: ReadonlySet<string>;
}) {
	const { t } = useMessages(webMessages);
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const [results, setResults] = useState<SearchResults>();
	useEffect(() => {
		if (!onSearch || !connected || !query.trim()) {
			setResults(undefined);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			void onSearch(query, archived)
				.then((value) => current && setResults(value))
				.catch(() => {});
		}, 200);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [onSearch, query, archived, connected]);
	const ids = results ? new Set(results.sessions) : undefined;
	const visible = sessions.filter(
		(session) => Boolean(session.archivedAt) === archived && (!ids || ids.has(session.id)),
	);
	// Group by full locations, not shortened labels: two home directories may both read as ~/project.
	const groups = new Map<string, SessionSummary[]>();
	const latest = new Map<string, number>();
	for (const session of visible) {
		const key = JSON.stringify([session.env ?? null, session.cwd]);
		const group = groups.get(key);
		if (group) group.push(session);
		else groups.set(key, [session]);
		latest.set(key, Math.max(latest.get(key) ?? 0, session.updatedAt));
	}
	// Most recently active directory first; pinned sessions first inside a directory.
	const ordered = [...groups].sort(([a], [b]) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0));
	for (const [, list] of ordered)
		list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
	return (
		<nav className="drawer-content" aria-label={t("sessions")}>
			<div className="drawer-top">
				<div className="brand">
					<PiLogo compact />
				</div>
				<div className="drawer-actions">
					<button type="button" className="new-session" onClick={onNew} disabled={!connected}>
						<PlusIcon size={16} />
						<span>{t("newSession")}</span>
					</button>
					<button
						type="button"
						className="collapse-sidebar"
						onClick={onCollapse}
						aria-label={t("collapseSidebar")}
					>
						<ChevronIcon size={20} />
					</button>
				</div>
			</div>
			<label className="search">
				<SearchIcon />
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={archived ? t("searchArchive") : t("searchSessions")}
					aria-label={t("searchSessionsAndMessages")}
				/>
			</label>
			<div className="session-scroll">
				{!archived && !query && head}
				{ordered.map(([key, list]) => {
					// A group holds at least one session; its first names the folder's location.
					const first = list[0]!;
					const location = locationLabel(first.env, first.cwd);
					return (
						<section key={key} className="group">
							<h3 className="group-head" title={`${first.env ? `${first.env}:` : ""}${first.cwd}`}>
								<FolderIcon />
								{first.env && sandboxes?.has(first.env) && (
									<span className="group-lock" title={t("sandbox")}>
										<LockIcon size={12} />
									</span>
								)}
								<span className="group-label">{location}</span>
								{onNewIn && !archived && (
									<button
										type="button"
										className="group-new"
										aria-label={t("newSessionIn", location)}
										title={t("newSessionIn", location)}
										disabled={!connected}
										onClick={() => onNewIn(first.env ?? null, first.cwd)}
									>
										<PlusIcon size={14} />
									</button>
								)}
							</h3>
							{list.map((session) => (
								<SessionRow
									key={session.id}
									session={session}
									archived={archived}
									conversationId={session.id === activeId ? conversationId : session.main}
									onOpen={onOpen}
									onBranch={onBranch}
									onRenameBranch={onRenameBranch}
									active={session.id === activeId}
								>
									<button
										type="button"
										className={`session-main ${session.id === activeId && conversationId === session.main ? "active" : ""}`}
										onClick={() => (archived ? onRestore(session.id) : onOpen(session.id))}
									>
										<span className="session-title">
											{session.pinned && <PinIcon size={12} />}
											{session.title}
										</span>
										<span className="session-meta">
											{session.worker.error && (
												<span className="error session-worker-error" title={session.worker.error}>
													{t("workerFailed")}
												</span>
											)}
											<SessionDot worker={session.worker} />
											{archived ? t("tapToRestore") : ago(session.updatedAt)}
										</span>
									</button>
								</SessionRow>
							))}
						</section>
					);
				})}
				{results && results.messages.length > 0 && (
					<section className="group">
						<h3>{t("messages")}</h3>
						{results.messages.slice(0, 40).map((hit) => (
							<button
								type="button"
								key={`${hit.session}-${hit.entryId}`}
								className="hit"
								// p2 indexes subagent messages too: a hit opens the conversation it was found in, at the message.
								onClick={() => {
									requestReveal(hit.session, hit.conversationId, hit.entryId);
									if (archived) onRestore(hit.session, hit.conversationId);
									else onOpen(hit.session, hit.conversationId);
								}}
							>
								<strong>{hit.title}</strong>
								<span>{hit.text.slice(0, 160)}</span>
							</button>
						))}
					</section>
				)}
				{!visible.length && !results?.messages.length && (
					<p className="empty-note">
						{query ? t("nothingFound") : archived ? t("noArchivedSessions") : t("noSessionsYet")}
					</p>
				)}
			</div>
			<div className="drawer-foot">
				<button
					type="button"
					className={`foot-button ${archived ? "on" : ""}`}
					aria-pressed={archived}
					onClick={() => setArchived(!archived)}
				>
					{t("archived")}
				</button>
				{footer ?? (
					<>
						<button type="button" className="foot-button" onClick={onProviders}>
							{t("providers")}
						</button>
						<button type="button" className="foot-button" onClick={onEnvs} title={t("envsTitle")}>
							{t("envs")}
						</button>
						<button type="button" className="foot-button" onClick={onOwnerLink} title={t("devicesTitle")}>
							{t("devices")}
						</button>
					</>
				)}
			</div>
		</nav>
	);
});
