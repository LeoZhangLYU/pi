import type { Held, Location } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, filePreview, follow } from "@p2/app/v1";
import {
	ChevronIcon,
	CloseIcon,
	FileIcon,
	FolderIcon,
	type Navigation,
	QueryCache,
	RefreshIcon,
	routeKey,
	SearchIcon,
	Slot,
	TerminalIcon,
	useDragSize,
	useMessages,
	useScrollMemory,
	type WorkspaceFileRoute,
	type WorkspaceRoute,
	type WorkspaceTab,
} from "@p2/app/v1/web";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Workspace } from "./contract.ts";
import { type FileView, WorkspaceFile } from "./file.tsx";
import { type FuzzyMatch, rankFiles } from "./fuzzy.ts";
import { workspaceMessages } from "./messages.ts";
import type { WorkspaceQuery, WorkspaceResult } from "./protocol.ts";

/** Name filter results shown, best first. */
const FILTER_RESULTS = 200;
/** Narrowest chat and file column for which a file opens beside the list instead of in its place. */
const SPLIT_MIN = 480;
/** Workspace answers by session, conversation and query (see WorkspacePanel's load). */
const results = new QueryCache<unknown>(300);
/** Expanded folders of the Files tree by session and conversation, kept while the page lives. */
const expandedFolders = new Map<string, ReadonlySet<string>>();

/** `text` with the matched ranges emphasized; ranges may run past its end. */
function Highlight({ text, matches }: { text: string; matches?: FuzzyMatch[] }) {
	const parts: ReactNode[] = [];
	let at = 0;
	for (const match of matches ?? []) {
		const start = Math.max(at, match.start);
		const end = Math.min(text.length, match.end);
		if (end <= start) continue;
		if (start > at) parts.push(text.slice(at, start));
		parts.push(
			<strong key={start} className="fuzzy-hit">
				{text.slice(start, end)}
			</strong>,
		);
		at = end;
	}
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/**
 * The conversation's answers that a change in its working tree can alter. A file at a commit
 * (`file:<hash>:path`) stays valid.
 */
function invalidate(sessionId: string, conversationId: number): void {
	const scope = `${sessionId}\0${conversationId}\0`;
	results.invalidate((key) => key.startsWith(scope) && !/^file:[^:]/.test(key.slice(scope.length)));
}

/** `key` identifies what was requested: a refetch of the same key keeps showing the old value. */
type Loaded<T> = { key?: string; value?: T; error?: string; loading: boolean };

function size(bytes: number): string {
	return bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function initialView(path: string): FileView {
	const kind = filePreview(path)?.kind;
	return kind === "image" || kind === "audio" || kind === "video" || /\.(md|markdown)$/i.test(path)
		? "preview"
		: "file";
}

// Right-hand panel for the viewed conversation's working directory. All data comes
// from that conversation's execution environment via the worker; media and downloads
// use the separately authorized /workspace-file endpoint. Where it is (tab, folder,
// file) is part of the route: folders and files are steps.
export function WorkspacePanel({
	workspace,
	nav,
	route,
	sessionId,
	conversationId,
	attached,
	unavailable,
	onRetry,
	cwd,
	where,
	label,
	owner,
}: {
	workspace: Held<typeof Workspace> | undefined;
	nav: Navigation;
	route: WorkspaceRoute;
	sessionId: string;
	conversationId: number;
	/** The conversation's snapshot arrived: the server answers workspace queries only for the viewed conversation. */
	attached: boolean;
	/** Why the workspace could not be opened, while it is not attached; with `onRetry` to open it again. */
	unavailable?: string;
	onRetry?: () => void;
	cwd: string;
	/** Where the conversation works, as people read it (`gpu:/path`). */
	where?: string;
	/** A location as people read it: the header shows where the workspace is really open once it answered. */
	label?: (location: Location) => string;
	/** Terminals are a shell on the session's machine: only the owner gets them. */
	owner: boolean;
}) {
	const { t } = useMessages(workspaceMessages);
	const { tab, directory, file: selection } = route;
	// Docked with room for a file beside the list (measured below): Files then shows the open file to the left of
	// its list instead of in its place. Phones and narrow windows keep one column.
	const [roomy, setRoomy] = useState(false);
	const split = roomy && selection !== undefined && tab === "files";
	// Steps applied to the latest route, not this render's: queued steps may be pending.
	const update = (change: (current: WorkspaceRoute) => WorkspaceRoute) => (current: typeof nav.route) => ({
		...current,
		...(current.workspace ? { workspace: change(current.workspace) } : {}),
	});
	const step = (next: Partial<WorkspaceRoute>) =>
		void nav.push(update((current) => ({ ...current, ...next }))(nav.route));
	// Folders expand in place (not a step). The last expanded folder is where uploads go; collapsing it or a folder
	// around it moves that to the collapsed folder's parent.
	const toggleFolder = (path: string) => {
		const open = !expanded.has(path);
		const next = new Set(expanded);
		if (open) {
			next.add(path);
			prefetch(`list:${path}`, { kind: "list", path });
		} else next.delete(path);
		setExpanded(next);
		const current = nav.route.workspace?.directory ?? "";
		const target = open
			? path
			: current === path || current.startsWith(`${path}/`)
				? path.slice(0, Math.max(0, path.lastIndexOf("/")))
				: current;
		if (target !== current) void nav.replace(update((workspace) => ({ ...workspace, directory: target }))(nav.route));
	};
	// Opening a file is a step; leaving it goes up to the list it was opened from.
	const setSelection = (next: WorkspaceFileRoute | undefined) => {
		if (next && selection && routeKey(next) === routeKey(selection)) return;
		if (next) prefetch(`file::${next.path}`, { kind: "file", path: next.path });
		if (next) step({ file: next });
		else void nav.close(update((current) => ({ ...current, file: undefined })));
	};
	// Tabs are lateral: switching returns to where the panel opened, keeping the folder
	// but dropping files visited meanwhile.
	const setTab = (next: WorkspaceTab) => {
		const current = nav.route.workspace;
		if (!current) return;
		const target: WorkspaceRoute = {
			tab: next,
			directory: current.directory,

			...(current.terminal ? { terminal: current.terminal } : {}),
			...(next === "terminal" ? { startTerminal: true } : {}),
		};
		void nav.reset(
			(entry) => entry.workspace !== undefined && entry.layers.length === 0,
			(landed) => ({ ...landed, workspace: target }),
		);
	};
	const [_collapsed, _setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [wrap, setWrap] = useState(() => localStorage.getItem("pi-workspace-wrap") === "1");
	const [version, setVersion] = useState(0);
	// The Files tree: every shown folder's listing, by path ("" is the root).
	const [listings, setListings] = useState<Record<string, Loaded<Extract<WorkspaceResult, { kind: "list" }>>>>({});
	const folderKey = `${sessionId}\0${conversationId}`;
	const [expanded, setExpandedState] = useState<ReadonlySet<string>>(new Set());
	// A restored route's folder shows expanded, with the folders around it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the conversation changes, see below.
	useEffect(() => {
		const next = new Set(expandedFolders.get(folderKey));
		const segments = directory ? directory.split("/") : [];
		for (let index = 1; index <= segments.length; index++) next.add(segments.slice(0, index).join("/"));
		setExpandedState(next);
		// Only when the conversation changes: later folder changes come from the tree itself.
	}, [folderKey]);
	const setExpanded = (next: ReadonlySet<string>) => {
		setExpandedState(next);
		expandedFolders.set(folderKey, next);
	};
	const [fileFilter, setFileFilter] = useState("");
	const filterText = useDeferredValue(fileFilter.trim() ? fileFilter : "");
	const [fileIndex, setFileIndex] = useState<Loaded<Extract<WorkspaceResult, { kind: "files" }>>>({ loading: false });
	const [place, setPlace] = useState<Loaded<Extract<WorkspaceResult, { kind: "place" }>>>({ loading: true });
	const [file, setFile] = useState<Loaded<Extract<WorkspaceResult, { kind: "file" }>>>({ loading: true });
	const [uploading, setUploading] = useState<string>();
	const [uploadError, setUploadError] = useState<string>();
	// Until the conversation is attached, queries wait instead of failing; attaching
	// changes this function, so every load runs again.
	const query = useCallback(
		async <T extends WorkspaceResult>(value: WorkspaceQuery): Promise<T> => {
			if (!workspace || !attached) return new Promise<T>(() => {});
			return (await workspace.query(value, BACKGROUND_CONTEXT)) as T;
		},
		[workspace, attached],
	);

	const fileUrl = (path: string) =>
		`/workspace-file?${new URLSearchParams({ session: sessionId, conversation: String(conversationId), path })}`;

	// Native handle lifetime leases the watch; changes invalidate the same mobile cache without a heartbeat request.
	useEffect(() => {
		invalidate(sessionId, conversationId);
		let first = true;
		let pending: ReturnType<typeof setTimeout> | undefined;
		if (!workspace) return;
		const stop = follow(workspace.changes, () => {
			if (first) {
				first = false;
				return;
			}
			invalidate(sessionId, conversationId);
			clearTimeout(pending);
			pending = setTimeout(() => setVersion((current) => current + 1), 500);
		});
		return () => {
			clearTimeout(pending);
			stop?.();
		};
	}, [workspace, sessionId, conversationId]);

	// Answers are kept per conversation (results): Back and revisits show a fresh one without a request and a stale one
	// at once while it refreshes, and a tap's request (prefetch) is joined instead of repeated. Nothing is cached before
	// the conversation is attached, when queries wait without answering.
	const scoped = (key: string) => `${sessionId}\0${conversationId}\0${key}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scoped is recreated each render and depends only on sessionId and conversationId.
	const load = useCallback(
		<T,>(key: string, request: () => Promise<T>, set: Dispatch<SetStateAction<Loaded<T>>>) => {
			let current = true;
			const cached = attached ? (results.get(scoped(key)) as T | undefined) : undefined;
			if (cached !== undefined && results.fresh(scoped(key))) {
				set({ key, value: cached, loading: false });
				return;
			}
			// Live refreshes keep showing the previous value instead of flashing a spinner.
			set((previous) =>
				previous.key === key
					? { ...previous, loading: true }
					: cached !== undefined
						? { key, value: cached, loading: true }
						: { key, loading: true },
			);
			(attached ? (results.fetch(scoped(key), request) as Promise<T>) : request()).then(
				(value) => current && set({ key, value, loading: false }),
				(error: Error) => current && set({ key, error: error.message, loading: false }),
			);
			return () => {
				current = false;
			};
		},
		[attached, sessionId, conversationId],
	);
	/** Start loading what a tap opens, together with its navigation step. */
	const prefetch = (key: string, value: WorkspaceQuery) => {
		if (attached && !results.fresh(scoped(key))) results.prefetch(scoped(key), () => query(value));
	};
	// Only what is shown loads: a change under an open file reloads the file, not the folder listing behind it.
	const showsListing = tab === "files" && (!selection || split);
	// Folders the tree shows: the root and each expanded folder inside a shown one that lists it.
	const shownFolders: string[] = [""];
	for (let index = 0; index < shownFolders.length; index++) {
		const folder = shownFolders[index] ?? "";
		for (const entry of listings[folder]?.value?.entries ?? []) {
			const path = folder ? `${folder}/${entry.name}` : entry.name;
			if (entry.kind === "directory" && expanded.has(path)) shownFolders.push(path);
		}
	}
	const shownKey = shownFolders.join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (!showsListing || filterText) return;
		const stops = shownKey.split("\0").map((path) =>
			load(
				`list:${path}`,
				() => query<Extract<WorkspaceResult, { kind: "list" }>>({ kind: "list", path }),
				(action) =>
					setListings((current) => ({
						...current,
						[path]: typeof action === "function" ? action(current[path] ?? { loading: true }) : action,
					})),
			),
		);
		return () => {
			for (const stop of stops) stop?.();
		};
	}, [shownKey, load, query, version, showsListing, filterText]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (!showsListing || !filterText) return;
		return load("files", () => query<Extract<WorkspaceResult, { kind: "files" }>>({ kind: "files" }), setFileIndex);
	}, [load, query, version, showsListing, filterText]);
	const filePaths = fileIndex.value?.paths;
	const ranked = useMemo(
		() => (filePaths && filterText ? rankFiles(filePaths, filterText, FILTER_RESULTS) : []),
		[filePaths, filterText],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(
		() => load("place", () => query<Extract<WorkspaceResult, { kind: "place" }>>({ kind: "place" }), setPlace),
		[load, query, version],
	);
	const opened = place.value?.location;
	const shownWhere = opened && label ? label(opened) : where;
	const moveNote = place.value?.failed
		? t("moveFailed", label ? label(place.value.failed.to) : place.value.failed.to.cwd, place.value.failed.error)
		: place.value?.pending
			? t("movePending", label ? label(place.value.pending) : place.value.pending.cwd)
			: undefined;
	const upload = async (picked: File[]) => {
		setUploadError(undefined);
		for (const entry of picked) {
			setUploading(entry.name);
			const params = new URLSearchParams({
				session: sessionId,
				conversation: String(conversationId),
				path: directory,
				name: entry.name,
			});
			try {
				const response = await fetch(`/workspace-upload?${params}`, {
					method: "POST",
					body: entry,
					credentials: "same-origin",
				});
				const result = (await response.json().catch(() => ({}))) as { error?: string };
				if (!response.ok) throw new Error(result.error ?? t("uploadFailed", response.status));
			} catch (error) {
				setUploadError(`${entry.name}: ${error instanceof Error ? error.message : "upload failed"}`);
				break;
			}
		}
		setUploading(undefined);
		invalidate(sessionId, conversationId);
		setVersion((current) => current + 1);
	};
	const needsFile = selection !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selected path, not the selection object; version triggers refetches.
	useEffect(() => {
		if (!selection || !needsFile) return;
		return load(
			`file::${selection.path}`,
			() => query<Extract<WorkspaceResult, { kind: "file" }>>({ kind: "file", path: selection.path }),
			setFile,
		);
	}, [load, query, selection?.path, needsFile, version]);

	const panel = useRef<HTMLElement>(null);
	// Each list, file and commit keeps its scroll position for Back. Keyed by the panel's
	// location only: a sheet opened beside the docked panel leaves it where it was.
	const scroller = useRef<HTMLDivElement>(null);
	// Beside an open file, the list is the same step as without it.
	// The upload folder changes without a step: it is not part of the location.
	const located = { ...route, directory: "" };
	useScrollMemory(
		scroller,
		routeKey({ sessionId, conversationId, route: split ? { ...located, file: undefined } : located }),
	);
	const previewScroller = useRef<HTMLDivElement>(null);
	useScrollMemory(previewScroller, routeKey({ sessionId, conversationId, route: located, preview: split }));
	// A changed filter starts its results at the top.
	const shownFilter = useRef(filterText);
	useEffect(() => {
		if (shownFilter.current === filterText) return;
		shownFilter.current = filterText;
		scroller.current?.scrollTo({ top: 0 });
	}, [filterText]);
	// Its width, dragged from the left edge and remembered; phones ignore it (full screen).
	const width = useDragSize("pi-workspace-width", "--workspace-width");
	// Room to split: the chat and the panel share what the sidebar leaves; the list keeps its width, and the chat and
	// the file column split the rest equally (flex in style.css). Their sum doesn't change when the split toggles.
	const column = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = panel.current;
		const main = element?.parentElement?.querySelector<HTMLElement>(":scope > .main");
		const list = column.current;
		if (!element || !main || !list) return;
		const docked = window.matchMedia("(min-width: 1280px)");
		const measure = () =>
			setRoomy(docked.matches && main.offsetWidth + element.offsetWidth - list.offsetWidth >= 2 * SPLIT_MIN);
		measure();
		const observer = new ResizeObserver(measure);
		for (const target of [element, main, list]) observer.observe(target);
		docked.addEventListener("change", measure);
		return () => {
			observer.disconnect();
			docked.removeEventListener("change", measure);
		};
	}, []);
	const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
		const element = panel.current;
		if (!element) return;
		const right = element.getBoundingClientRect().right;
		width.drag(event, element, (moved) => Math.min(Math.max(right - moved.clientX, 320), window.innerWidth * 0.7));
	};

	const rootName = cwd.replace(/\/+$/, "").split("/").pop() || "/";

	const terminal = tab === "terminal" && owner && !selection;
	// The open file: in place of the list, or beside it when split.
	let fileBody: ReactNode;
	if (selection) {
		const name = selection.path.slice(selection.path.lastIndexOf("/") + 1);
		const kind = filePreview(name)?.kind;
		const previewable = kind === "image" || kind === "audio" || kind === "video" || /\.(md|markdown)$/i.test(name);
		const views: FileView[] = [...(["file"] as const), ...(previewable ? (["preview"] as const) : [])];
		const fileLoaded = file.key === `file::${selection.path}` ? file : undefined;
		fileBody = (
			<WorkspaceFile
				path={selection.path}
				view={selection.view}
				views={views}
				file={fileLoaded?.value}
				error={fileLoaded?.error}
				url={fileUrl(selection.path)}
				wrap={wrap}
				line={selection.line}
				onView={(view) =>
					void nav.replace(update((current) => ({ ...current, file: { ...selection, view } }))(nav.route))
				}
				onWrap={() => {
					localStorage.setItem("pi-workspace-wrap", wrap ? "0" : "1");
					setWrap(!wrap);
				}}
				onBack={() => setSelection(undefined)}
				closable={split}
			/>
		);
	}
	let body: ReactNode;
	if (!terminal && !attached && unavailable !== undefined) {
		body = (
			<>
				<p className="notice error workspace-note">{t("workspaceCouldNotOpen", unavailable)}</p>
				{onRetry && (
					<button type="button" className="text-action workspace-note" onClick={onRetry}>
						{t("retry")}
					</button>
				)}
			</>
		);
	} else if (terminal) {
		body = <Slot name="workspace-terminal" />;
	} else if (selection && !split) {
		body = fileBody;
	} else if (tab === "files") {
		const indent = (depth: number) => ({ paddingLeft: `calc(var(--x) + ${depth * 14}px)` });
		const tree = (folder: string, depth: number): ReactNode[] => {
			const loaded = listings[folder];
			if (!loaded?.value)
				return [
					loaded?.error ? (
						<p key={`${folder}\0error`} className="notice error workspace-note" style={indent(depth)}>
							{loaded.error}
						</p>
					) : (
						<div key={`${folder}\0loading`} className="workspace-row" style={indent(depth)}>
							<span className="spinner" />
						</div>
					),
				];
			// Ignored entries show too, dimmed.
			const entries = loaded.value.entries;
			return [
				...entries.flatMap((entry) => {
					const path = folder ? `${folder}/${entry.name}` : entry.name;
					const className = `workspace-row ${entry.ignored ? "ignored" : ""}`;
					if (entry.kind === "directory") {
						const open = expanded.has(path);
						return [
							<button
								type="button"
								key={path}
								className={`${className} directory`}
								style={indent(depth)}
								aria-expanded={open}
								onClick={() => toggleFolder(path)}
							>
								<span className={`chev ${open ? "open" : ""}`}>
									<ChevronIcon size={12} />
								</span>
								<span className="workspace-name">{entry.name}</span>
							</button>,
							...(open ? tree(path, depth + 1) : []),
						];
					}
					return [
						<button
							type="button"
							key={path}
							className={className}
							style={indent(depth)}
							aria-current={split && selection?.path === path ? "true" : undefined}
							onClick={() => setSelection({ path, view: initialView(path) })}
						>
							<FileIcon />
							<span className="workspace-name">{entry.name}</span>
							<small>{entry.kind === "symlink" ? "link" : size(entry.size)}</small>
						</button>,
					];
				}),
				...(!entries.length
					? [
							<p key={`${folder}\0empty`} className="notice workspace-note" style={indent(depth)}>
								{folder ? t("emptyFolder") : t("emptyDirectory")}
							</p>,
						]
					: []),
				...(loaded.value.truncated
					? [
							<p key={`${folder}\0truncated`} className="notice workspace-note" style={indent(depth)}>
								{t("showingFirstEntries", 2000)}
							</p>,
						]
					: []),
			];
		};
		body = (
			<>
				<div className="workspace-filter">
					<div className="search workspace-search">
						<SearchIcon />
						<input
							type="search"
							value={fileFilter}
							maxLength={200}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							onChange={(event) => setFileFilter(event.target.value)}
							onKeyDown={(event) => {
								// As in Quick Open: Enter opens the best match, Escape clears.
								const best = ranked[0];
								if (event.key === "Enter" && best)
									setSelection({ path: best.path, view: initialView(best.path) });
								else if (event.key === "Escape" && fileFilter) {
									event.stopPropagation();
									setFileFilter("");
								}
							}}
							placeholder={t("goToFile")}
							aria-label={t("goToFileByName")}
						/>
						{fileFilter && (
							<button type="button" className="text-action" onClick={() => setFileFilter("")}>
								{t("clear")}
							</button>
						)}
					</div>
					<label
						className="text-action workspace-upload"
						title={t("uploadInto", directory ? `${rootName}/${directory}` : rootName)}
					>
						{uploading ? t("uploading", uploading) : t("uploadTo", directory.split("/").pop() || rootName)}
						<input
							type="file"
							multiple
							hidden
							disabled={uploading !== undefined}
							onChange={(event) => {
								void upload([...(event.target.files ?? [])]);
								event.target.value = "";
							}}
						/>
					</label>
				</div>
				{uploadError && <p className="notice error workspace-note">{uploadError}</p>}
				{filterText ? (
					fileIndex.error ? (
						<p className="notice error workspace-note">{fileIndex.error}</p>
					) : !filePaths ? (
						<div className="spinner large" />
					) : (
						<div className="workspace-list">
							{ranked.map(({ path, score }) => {
								const slash = path.lastIndexOf("/");
								return (
									<button
										type="button"
										key={path}
										className="workspace-row"
										aria-current={split && selection?.path === path ? "true" : undefined}
										onClick={() => setSelection({ path, view: initialView(path) })}
									>
										<FileIcon />
										<span className="workspace-name">
											<Highlight text={path.slice(slash + 1)} matches={score.labelMatch} />
											{slash > 0 && (
												<span className="muted">
													{" "}
													<Highlight text={path.slice(0, slash)} matches={score.descriptionMatch} />
												</span>
											)}
										</span>
									</button>
								);
							})}
							{!ranked.length && <p className="notice workspace-note">{t("noMatchingFiles")}</p>}
							{fileIndex.value?.truncated && <p className="notice workspace-note">{t("firstFiftyThousand")}</p>}
						</div>
					)
				) : (
					<div className="workspace-list workspace-tree">{tree("", 0)}</div>
				)}
			</>
		);
	}

	return (
		<aside
			className={`workspace ${split ? "split" : ""}`}
			aria-label={t("workspace")}
			ref={panel}
			style={width.style}
		>
			{/* The column stays the second child either way, so toggling the split never remounts the list. */}
			{split && (
				<section className="workspace-preview" aria-label={t("openFile")}>
					<div className="workspace-preview-body" ref={previewScroller}>
						{fileBody}
					</div>
				</section>
			)}
			<div className="workspace-column" ref={column}>
				<button
					type="button"
					className="workspace-resize"
					aria-label={t("dragToResize")}
					tabIndex={-1}
					onPointerDown={startResize}
				/>
				<header className="workspace-head">
					<div className="workspace-tabs">
						{(
							[
								["files", t("files"), <FolderIcon key="icon" size={20} />, 0],
								...(owner
									? [["terminal", t("terminal"), <TerminalIcon key="icon" size={20} />, 0] as const]
									: []),
							] as const
						).map(([id, label, icon, count]) => (
							<button
								key={id}
								type="button"
								aria-pressed={tab === id}
								aria-label={count ? `${label} (${count})` : label}
								title={label}
								onClick={() => setTab(id)}
							>
								{icon}
								{count > 0 && <span>{count}</span>}
							</button>
						))}
					</div>
					<span className="spacer workspace-location" title={shownWhere}>
						{shownWhere}
					</span>
					{terminal ? (
						<button
							type="button"
							className="icon-button"
							onClick={() => setTab("files")}
							aria-label={t("closeTerminalPanel")}
							title={t("closeTerminalPanel")}
						>
							<CloseIcon />
						</button>
					) : (
						<>
							<button
								type="button"
								className="icon-button"
								onClick={() => setVersion((current) => current + 1)}
								aria-label={t("refresh")}
								title={t("refresh")}
							>
								<RefreshIcon />
							</button>
							<button
								type="button"
								className="icon-button"
								onClick={() => void nav.close((current) => ({ ...current, workspace: undefined }))}
								aria-label={t("closeWorkspace")}
							>
								<CloseIcon />
							</button>
						</>
					)}
				</header>
				<div className={`workspace-body ${terminal ? "terminal-body" : ""}`} ref={scroller}>
					{moveNote && !terminal && <p className="notice workspace-note">{moveNote}</p>}
					{body}
				</div>
			</div>
		</aside>
	);
}
