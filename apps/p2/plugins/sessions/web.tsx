// The mobile drawer's component tree, with catalog/status/subagent/search handles supplying its data, and the owner's
// session actions on its rows.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type HeldIn,
	keptIn,
	liveIn,
	Translations,
	whenLive,
} from "@p2/app/v1";
import {
	closeLayers,
	Drawer,
	LanguageSetting,
	MoreIcon,
	navigate,
	openLayer,
	rememberMains,
	type SessionSummary,
	Sheet,
	Slot,
	SlotList,
	Slots,
	ThemeSetting,
	toggleSidebar,
	useComposerState,
	useConnected,
	useHost,
	useMessages,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Envs } from "../envs/contract.ts";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { BranchSheet } from "./BranchSheet.tsx";
import { type Operation, type Session, Sessions } from "./contract.ts";
import { sessionsMessages } from "./messages.ts";
import { SessionSheet } from "./SessionSheet.tsx";

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

/**
 * The footer's Settings button and its sheet: the owner entries in an explicit order. The sheet stays mounted while an
 * entry's own sheet is open above it (each entry renders that sheet through a portal); it is hidden, not unmounted,
 * then, so Back returns to it.
 */
function SettingsSheet({ shown, onClose }: { shown: boolean; onClose: () => void }) {
	const { t } = useMessages(sessionsMessages);
	return (
		<Sheet title={t("settings")} onClose={onClose} className="settings-sheet" hidden={!shown}>
			<div className="list settings-list">
				<Slot name="sidebar-foot:providers" />
				<Slot name="sidebar-foot:mcp" />
				<Slot name="sidebar-foot:envs" />
				<Slot name="sidebar-foot:devices" />
				<Slot name="sidebar-foot:ports" />
				<Slot name="sidebar-foot:voice" />
				<Slot name="sidebar-foot:logs" />
				<LanguageSetting />
				<ThemeSetting />
			</div>
		</Sheet>
	);
}

/** The sheets the Settings sheet's slots render: opened directly, they still need it mounted for their slot. */
const SETTINGS_ENTRIES = new Set(["settings", "providers", "mcp", "envs", "devices", "ports", "voice", "logs"]);

/** The drawer footer's owner entries behind one Settings button. */
function SettingsButton() {
	const { t } = useMessages(sessionsMessages);
	const owner = useOwner();
	const route = useRoute();
	const settings = route.layers.findLastIndex((layer) => layer.kind === "sheet" && layer.name === "settings");
	const mounted = route.layers.some((layer) => layer.kind === "sheet" && SETTINGS_ENTRIES.has(layer.name));
	if (!owner) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "settings" }, { fromDrawer: true })}
			>
				{t("settings")}
			</button>
			{/* Mounted while Settings or one of its entries is open: an entry may be opened directly (the
			    new-session hero's provider sign-in) and its sheet still needs the slot that renders it. */}
			{mounted && (
				<SettingsSheet shown={settings >= 0 && settings === route.layers.length - 1} onClose={closeLayers} />
			)}
		</>
	);
}

const footer = <SettingsButton />;
/** Entries above the folders, e.g. the Familiar's. */
const head = <SlotList prefix="drawer-head" />;

/** What a row says about a lifecycle operation (`Sessions.operations`), by kind: running, and failed. */
const OPERATION_LABELS: Record<Operation["kind"], { running: OperationKey; failed: OperationKey }> = {
	relocate: { running: "moving", failed: "moveFailed" },
	clone: { running: "cloning", failed: "cloneFailed" },
	fork: { running: "forking", failed: "forkFailed" },
	archive: { running: "archiving", failed: "archiveFailed" },
};

type OperationKey =
	| "moving"
	| "moveFailed"
	| "cloning"
	| "cloneFailed"
	| "forking"
	| "forkFailed"
	| "archiving"
	| "archiveFailed"
	| "copyingFiles";

/**
 * The operation row `session` shows: a failed one of it first (with Dismiss), else one running on it, else a copy
 * into it whose files are still being copied (its worker waits for them).
 */
function operationOf(
	operations: readonly Operation[],
	session: string,
	dismiss: (operation: string) => void,
	translate: (key: OperationKey) => string,
): SessionSummary["operation"] {
	const failed = operations.find((operation) => operation.phase === "failed" && operation.session === session);
	if (failed?.phase === "failed")
		return {
			label: translate(OPERATION_LABELS[failed.kind].failed),
			error: failed.error,
			dismiss: () => dismiss(failed.id),
		};
	const running = operations.find((operation) => operation.session === session);
	if (running) return { label: translate(OPERATION_LABELS[running.kind].running) };
	const copying = operations.find(
		(operation) => operation.phase === "running" && operation.target === session && operation.copying,
	);
	return copying ? { label: translate("copyingFiles") } : undefined;
}

/** A change to one session's row while its call is in flight. */
type RowGuess = { readonly id: string; readonly change: Partial<Session> };
const applyRow = (rows: Session[] | undefined, { id, change }: RowGuess): Session[] | undefined =>
	rows?.map((row) => (row.id === id ? { ...row, ...change } : row));

/**
 * The drawer, and the owner's session actions on its rows: rename, pin, archive and restore (the Session sheet is
 * rendered here, opened from the top bar's button), switching and renaming `/tree` branches. Each action shows its
 * effect on the rows at once (`useOptimisticCall`); a refused one rolls back and the toast says why. Reads use
 * `keptIn`: while the connection is down the rows stay as last seen; actions need the live catalog.
 */
function Sidebar() {
	const { t } = useMessages(sessionsMessages);
	const connected = useConnected();
	const route = useRoute();
	const service = useObject(Sessions, {});
	const catalog = liveIn(service, "owner");
	// As the server last said (kept across starts): unread marks and search hold without waiting for the catalog.
	const owner = useOwner();
	const status = keptIn(useObject(SessionStatus, {}), "reader");
	const { fail } = useComposerState();
	const [list, edit] = useOptimisticCall(useReadable(keptIn(service, "owner")?.sessions), applyRow, fail);
	const statuses = useReadable(status?.statuses);
	useEffect(() => {
		if (list) rememberMains(list);
	}, [list]);
	// Unread answers are the owner's (any device).
	const marks = useObject(SessionReads, owner ? {} : undefined);
	const answers = useReadable(marks?.answers);
	const reads = useReadable(marks?.reads);
	// Dismissing a failed operation removes its line at once.
	const [operations, dismissing] = useOptimisticCall(
		useReadable(keptIn(service, "owner")?.operations) ?? [],
		(list, operation: string) => list.filter((each) => each.id !== operation),
		fail,
	);
	const dismiss = useCallback(
		(operation: string) => {
			if (catalog) dismissing(operation, () => catalog.dismissOperation({ operation }, BACKGROUND_CONTEXT));
		},
		[catalog, dismissing],
	);
	const sessions = useMemo(
		() =>
			(list ?? []).map((session) => {
				const busy = statuses?.[session.id]?.busy ?? [];
				return {
					...session,
					env: session.env ?? null,
					worker: {
						busy,
						error: statuses?.[session.id]?.error,
						unread: (answers?.[session.id] ?? 0) > (reads?.[session.id] ?? 0),
					},
					operation: operationOf(operations, session.id, dismiss, t),
				};
			}),
		[list, statuses, answers, reads, operations, dismiss, t],
	);
	// This build keeps a single session: the most recently used active one. Others stay in storage, unlisted: there is
	// no entry to start another, and the team lives in this one.
	const single = useMemo(
		() =>
			sessions
				.filter((session) => session.archivedAt === null)
				.reduce<SessionSummary | undefined>(
					(kept, session) => (kept === undefined || session.updatedAt > kept.updatedAt ? session : kept),
					undefined,
				),
		[sessions],
	);
	const folders = useMemo(() => (single ? [single] : []), [single]);
	// The open session's main conversation, shown on a visible page, is read through its latest answer.
	const visible = usePageVisible();
	const viewed = list?.find((session) => session.id === route.session);
	const shown = visible && route.conversation === viewed?.main ? route.session : undefined;
	const latest = shown ? (answers?.[shown] ?? 0) : 0;
	const read = shown ? (reads?.[shown] ?? 0) : 0;
	useEffect(() => {
		if (shown && marks && latest > read)
			void marks.markRead({ session: shown, through: latest }, BACKGROUND_CONTEXT).catch(() => {});
	}, [marks, shown, latest, read]);
	// Sandboxed groups show a lock; only the owner reads environments.
	const envs = useReadable(useObject(Envs, owner ? {} : undefined)?.envs);
	const sandboxes = useMemo(
		() => new Set((envs ?? []).flatMap((env) => (env.config.type === "gondolin" ? [env.name] : []))),
		[envs],
	);
	const search = liveIn(useObject(Search, owner ? {} : undefined), "owner");
	// A rebuild shows as running at once; it is long work (a job), so the sheet shows it running until it is done.
	const [rebuilds, reindex] = useOptimisticCall(
		useReadable(search?.rebuilds) ?? [],
		(list, session: string) => [
			...list.filter((each) => each.session !== session),
			{ session, phase: "running" as const },
		],
		fail,
	);
	const onSearch = useCallback(
		(query: string, archived: boolean) => search!.search({ query, archived }, BACKGROUND_CONTEXT),
		[search],
	);
	// A session opens at its main conversation; `/s/<id>` would open conversation 1, which redirects there.
	const onOpen = useCallback(
		(session: string, conversation?: number) =>
			navigate({ session, conversation: conversation ?? list?.find((each) => each.id === session)?.main ?? 1 }),
		[list],
	);
	// A branch's switch or rename: a reference of its own (the change also reaches the session row).
	const host = useHost();
	const withTree = useCallback(
		(session: string, action: (tree: HeldIn<typeof SessionTree, "owner">) => Promise<unknown>) => {
			const held = host.hold(SessionTree, { session }, BACKGROUND_CONTEXT);
			return whenLive(held)
				.then(() => {
					const tree = liveIn(held, "owner");
					if (!tree) throw new Error(t("onlyOwnerBranches"));
					return action(tree);
				})
				.finally(() => held.release());
		},
		[host, t],
	);
	// The row marks the chosen branch at once; the view follows once the session's main conversation moved.
	const onBranch = useCallback(
		(session: string, conversation: number) =>
			edit({ id: session, change: { main: conversation } }, async () => {
				await withTree(session, (tree) => tree.select({ conversation }, BACKGROUND_CONTEXT));
				navigate({ session, conversation });
			}),
		[withTree, edit],
	);
	const [renaming, setRenaming] = useState<{ session: string; conversation: number }>();
	const onRenameBranch = useCallback(
		(session: string, conversation: number) => setRenaming({ session, conversation }),
		[],
	);
	const renamed = renaming && list?.find((each) => each.id === renaming.session);
	const branch = renamed?.branches.find((each) => each.conversation === renaming?.conversation);
	const renameBranch = (session: Session, conversation: number, label: string | null) =>
		edit(
			{
				id: session.id,
				change: {
					branches: session.branches.map((each) =>
						each.conversation === conversation ? { ...each, label } : each,
					),
				},
			},
			() => withTree(session.id, (tree) => tree.rename({ conversation, label }, BACKGROUND_CONTEXT)),
		);
	const sessionSheet = useSheet("session");
	return (
		<>
			<Drawer
				sessions={folders}
				sandboxes={sandboxes}
				activeId={route.session}
				conversationId={route.conversation}
				connected={connected}
				onOpen={onOpen}
				onBranch={catalog ? onBranch : undefined}
				onRenameBranch={catalog ? onRenameBranch : undefined}
				onCollapse={toggleSidebar}
				onSearch={search ? onSearch : undefined}
				head={head}
				footer={footer}
				onProviders={() => openLayer({ kind: "sheet", name: "providers" }, { fromDrawer: true })}
				onEnvs={() => openLayer({ kind: "sheet", name: "envs" }, { fromDrawer: true })}
				onOwnerLink={() => openLayer({ kind: "sheet", name: "devices" }, { fromDrawer: true })}
			/>
			{renamed && branch && (
				<BranchSheet
					title={renamed.title}
					conversation={branch.conversation}
					label={branch.label}
					onSave={(label) => renameBranch(renamed, branch.conversation, label)}
					onClose={() => setRenaming(undefined)}
				/>
			)}
			{sessionSheet && catalog && viewed && route.conversation === viewed.main && (
				<SessionSheet
					session={viewed}
					onClose={closeLayers}
					onRename={(title) =>
						edit({ id: viewed.id, change: { title } }, () =>
							catalog.rename({ id: viewed.id, title }, BACKGROUND_CONTEXT),
						)
					}
					onCwd={() => openLayer(directoryPickerLayer(viewed.env ?? null, viewed.cwd))}
					reindex={rebuilds.find((each) => each.session === viewed.id)}
					onReindex={
						search &&
						(() => reindex(viewed.id, () => search.rebuildIndex({ session: viewed.id }, BACKGROUND_CONTEXT)))
					}
				/>
			)}
		</>
	);
}

/** The top bar's button that opens the Session sheet (the drawer renders the sheet, where the rows are). */
function SessionOptions() {
	const { t } = useMessages(sessionsMessages);
	const route = useRoute();
	const rows = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions);
	const session = rows?.find((row) => row.id === route.session);
	if (!session || route.conversation !== session.main) return null;
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={t("sessionOptions")}
			onClick={() => openLayer({ kind: "sheet", name: "session" })}
		>
			<MoreIcon />
		</button>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-sessions", (self) => {
		self.contribute(Slots, { sidebar: Sidebar, "session-options": SessionOptions });
		self.contribute(Translations, sessionsMessages.translations);
	});
});
