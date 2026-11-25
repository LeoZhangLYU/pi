import type {
	ExecutionEnv,
	FileError,
	FileInfo,
	FileWatcher,
	Result,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@p2/app/v1";
import { withCancel } from "@p2/app/v1";
import {
	WORKSPACE_READ_CHUNK,
	WORKSPACE_TEXT_LIMIT,
	type WorkspaceBytes,
	type WorkspaceEntry,
	type WorkspaceMatch,
	type WorkspaceQuery,
	type WorkspaceResult,
	type WorkspaceUpload,
	workspaceGlobs,
	workspacePath,
} from "./protocol.ts";

const LIST_LIMIT = 2000;
const STATUS_BYTES = 1024 * 1024;
const GIT_TIMEOUT = 10_000;
const SEARCH_BYTES = 256 * 1024;
const SEARCH_LIMIT = 500;
const FILES_LIMIT = 50_000;
const FILES_BYTES = 4 * 1024 * 1024;
const WALK_DIRECTORIES = 5000;
/** Entries the walk reads from one directory; beyond it the directory is cut in its own (unsorted) order. */
const WALK_DIRECTORY_ENTRIES = 2 * FILES_LIMIT;
/**
 * Most directories the working tree's watch covers. Every change rescans the whole watched tree (and on Linux each
 * directory is one watch), so a larger tree, such as a home folder, gets only its root's own entries watched.
 */
const WATCH_DIRECTORIES = 2000;
/** Folders the working tree's watch skips at any depth. */
const WATCH_EXCLUDED = [".git", "node_modules"];

// Read-only, bounded views of one execution environment's working directory. Every
// file operation and git command goes through the environment, never this process's
// filesystem, so a remote environment works unchanged. Canonical confinement filters
// accidental escapes (symlinked directories); it is not a security boundary against
// a hostile environment, which the owner can already command.
export class Workspace {
	readonly env: ExecutionEnv;
	/** Canonical directories the panel must never expose, such as pi-mobile's private data. */
	private readonly denied: readonly string[];
	private root?: string;

	constructor(env: ExecutionEnv, denied: readonly string[]) {
		this.env = env;
		this.denied = denied;
	}

	private async canonicalRoot(context: Context): Promise<string> {
		if (this.root) return this.root;
		const result = await this.env.canonicalPath(this.env.cwd, context);
		if (!result.ok) throw new Error(`Working directory unavailable: ${result.error.code}`);
		this.root = result.value.replace(/\/+$/, "") || "/";
		return this.root;
	}

	/** Absolute environment path of a validated relative path, confined to the root. */
	private async resolve(path: string, context: Context): Promise<string> {
		const absolute = await this.absolute(path, context);
		await this.confine(absolute, context);
		return absolute;
	}

	/** The absolute environment path of a validated relative path, not yet checked to stay inside the root. */
	private async absolute(path: string, context: Context): Promise<string> {
		const relative = workspacePath(path);
		if (relative === undefined) throw new Error("Invalid workspace path");
		const root = await this.canonicalRoot(context);
		return relative ? `${root === "/" ? "" : root}/${relative}` : root;
	}

	/**
	 * Open `path` while checking that it stays inside the root, in parallel: a remote environment pays one round trip for
	 * both. Nothing opened is used before the check passed; an opened handle of a refused path is closed.
	 */
	private async openConfined<T extends { close(context: Context): Promise<void> }>(
		path: string,
		open: (absolute: string) => Promise<Result<T, FileError>>,
		context: Context,
	): Promise<{ absolute: string; opened: Result<T, FileError> }> {
		const absolute = await this.absolute(path, context);
		const [confined, opened] = await Promise.allSettled([this.confine(absolute, context), open(absolute)]);
		if (confined.status === "rejected") {
			if (opened.status === "fulfilled" && opened.value.ok) void opened.value.value.close(context);
			throw confined.reason;
		}
		if (opened.status === "rejected") throw opened.reason;
		return { absolute, opened: opened.value };
	}

	private async confine(absolute: string, context: Context): Promise<void> {
		const root = await this.canonicalRoot(context);
		const canonical = await this.env.canonicalPath(absolute, context);
		if (!canonical.ok) throw new Error(canonical.error.code === "not_found" ? "File not found" : "Cannot open path");
		const inside = (base: string, value: string) =>
			value === base || value.startsWith(base === "/" ? "/" : `${base}/`);
		if (!inside(root, canonical.value)) throw new Error("Path leaves the working directory");
		if (this.denied.some((denied) => inside(denied, canonical.value))) throw new Error("Path is private");
	}

	/** Every query but `place`, which the worker answers (where it opened this workspace). */
	async query(query: Exclude<WorkspaceQuery, { kind: "place" }>, context: Context): Promise<WorkspaceResult> {
		switch (query.kind) {
			case "list":
				return this.list(query.path, context);
			case "file":
				return this.file(query.path, context);
			case "files":
				return this.files(context);
			case "search":
				return this.search(query, context);
		}
	}

	private async list(path: string, context: Context): Promise<WorkspaceResult> {
		// Git's filter overrides are needed for check-ignore below: fetch them while the folder is read.
		const filters = this.filterOverrides(context);
		filters.catch(() => {});
		const { absolute, opened } = await this.openConfined(
			path,
			(directory) => this.env.openDirReader(directory, context),
			context,
		);
		if (!opened.ok)
			throw new Error(opened.error.code === "not_directory" ? "Not a directory" : "Cannot list directory");
		const entries: WorkspaceEntry[] = [];
		let truncated = false;
		try {
			for (;;) {
				const page = await opened.value.next(Math.min(500, LIST_LIMIT + 1 - entries.length), context);
				if (!page.ok) throw new Error("Cannot list directory");
				for (const entry of page.value.entries) {
					if (!path && entry.name === ".git") continue;
					entries.push({ name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs });
				}
				if (entries.length > LIST_LIMIT) {
					truncated = true;
					entries.length = LIST_LIMIT;
					break;
				}
				if (page.value.done) break;
			}
		} finally {
			// Nothing waits for the close: it costs a remote environment a round trip.
			void opened.value.close(context);
		}
		entries.sort(
			(a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
		);
		// Ignored entries, by .gitignore; tracked files and non-repositories report none. Run from this directory, in
		// batches of at most 24,000 characters (Windows limits a command line to 32,767) started together: one round
		// trip for any directory. Names containing newlines remain unannotated because output is line-based.
		const batches: string[][] = [];
		let length = 0;
		for (const entry of entries) {
			if (entry.name.includes("\n")) continue;
			const last = batches.at(-1);
			if (!last || length + entry.name.length + 3 > 24_000) {
				batches.push([entry.name]);
				length = entry.name.length + 3;
			} else {
				last.push(entry.name);
				length += entry.name.length + 3;
			}
		}
		const runs = await Promise.all(
			batches.map((names) =>
				this.git(["check-ignore", "--", ...names], STATUS_BYTES, context, filters, absolute).catch(() => undefined),
			),
		);
		const ignored = new Set(
			runs.flatMap((run) => (run && run.exitCode <= 1 ? run.stdout.split("\n").filter(Boolean) : [])),
		);
		for (const entry of entries) if (ignored.has(entry.name)) entry.ignored = true;
		return { kind: "list", path, entries, truncated };
	}

	private async file(path: string, context: Context): Promise<WorkspaceResult> {
		const { opened } = await this.openConfined(
			path,
			(absolute) => this.env.openBinaryReader(absolute, { noFollow: true }, context),
			context,
		);
		if (!opened.ok) throw new Error(opened.error.code === "is_directory" ? "Is a directory" : "Not a regular file");
		try {
			// Size and content together: the read stops at the limit or the end of the file either way.
			const [info, read] = await Promise.all([
				opened.value.info(context),
				opened.value.read(0, WORKSPACE_TEXT_LIMIT, context),
			]);
			if (!info.ok || !read.ok) throw new Error("Cannot read file");
			const size = info.value.size;
			const truncated = size > WORKSPACE_TEXT_LIMIT;
			const text = decodeText(read.value, truncated);
			return text === undefined
				? { kind: "file", path, size, binary: true, truncated }
				: { kind: "file", path, size, binary: false, text, truncated };
		} finally {
			void opened.value.close(context);
		}
	}

	/** Up to one chunk of bytes. `end` is inclusive; `suffix` reads the last bytes. */
	async read(
		path: string,
		range: { start?: number; end?: number; suffix?: number },
		context: Context,
	): Promise<WorkspaceBytes> {
		const { opened } = await this.openConfined(
			path,
			(absolute) => this.env.openBinaryReader(absolute, { noFollow: true }, context),
			context,
		);
		if (!opened.ok) throw new Error("Not a regular file");
		try {
			// A range from a known start is read together with the size; a suffix needs the size first.
			const known = range.suffix === undefined ? (range.start ?? 0) : undefined;
			const ahead =
				known === undefined
					? undefined
					: opened.value.read(
							known,
							Math.min(
								range.end === undefined ? Number.MAX_SAFE_INTEGER : range.end - known + 1,
								WORKSPACE_READ_CHUNK,
							),
							context,
						);
			ahead?.catch(() => {});
			const info = await opened.value.info(context);
			if (!info.ok) throw new Error("Cannot read file");
			const size = info.value.size;
			const start = range.suffix !== undefined ? Math.max(0, size - range.suffix) : (range.start ?? 0);
			const end = Math.min(range.end ?? size - 1, size - 1, start + WORKSPACE_READ_CHUNK - 1);
			if (start >= size || end < start) return { size, start, data: "" };
			const read = ahead ? await ahead : await opened.value.read(start, end - start + 1, context);
			if (!read.ok) throw new Error("Cannot read file");
			// The file may have grown since its size was read: serve the announced range only.
			return { size, start, data: Buffer.from(read.value.subarray(0, end - start + 1)).toString("base64") };
		} finally {
			void opened.value.close(context);
		}
	}

	private async files(context: Context): Promise<WorkspaceResult> {
		const root = await this.canonicalRoot(context);
		const base = root === "/" ? "" : root;
		const privateDirectory = (absolute: string) =>
			this.denied.some((denied) => absolute === denied || absolute.startsWith(`${denied}/`));
		const run = await this.git(
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			FILES_BYTES,
			context,
		).catch(() => undefined);
		if (run && (run.exitCode === 0 || run.truncated)) {
			// The text after the last NUL is empty, or a record cut at the output cap. Unmerged files repeat.
			const records = run.stdout.split("\0").slice(0, -1);
			const paths = [...new Set(records)].filter((path) => !privateDirectory(`${base}/${path}`));
			return {
				kind: "files",
				paths: paths.slice(0, FILES_LIMIT),
				truncated: run.truncated || paths.length > FILES_LIMIT,
			};
		}
		const paths: string[] = [];
		const queue = [""];
		let truncated = false;
		for (let index = 0; index < queue.length && !truncated; index++) {
			if (index >= WALK_DIRECTORIES) {
				truncated = true;
				break;
			}
			const relative = queue[index] ?? "";
			const absolute = relative ? `${base}/${relative}` : root;
			if (privateDirectory(absolute)) continue;
			const opened = await this.env.openDirReader(absolute, context);
			if (!opened.ok) continue;
			const entries: FileInfo[] = [];
			try {
				for (;;) {
					const page = await opened.value.next(500, context);
					if (!page.ok) break;
					entries.push(...page.value.entries);
					if (entries.length > WALK_DIRECTORY_ENTRIES) {
						truncated = true;
						entries.length = WALK_DIRECTORY_ENTRIES;
						break;
					}
					if (page.value.done) break;
				}
			} finally {
				void opened.value.close(context);
			}
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const entry of entries) {
				const path = relative ? `${relative}/${entry.name}` : entry.name;
				if (entry.kind !== "directory") paths.push(path);
				else if (entry.name !== ".git" && entry.name !== "node_modules") queue.push(path);
				if (paths.length > FILES_LIMIT) {
					truncated = true;
					paths.length = FILES_LIMIT;
					break;
				}
			}
		}
		return { kind: "files", paths, truncated };
	}

	/**
	 * Literal, smart-case (case-insensitive unless the text has capitals) search of text
	 * files below `path`, tracked and untracked, skipping ignored files. Outside a
	 * repository it searches the directory itself. Include/exclude globs relative to
	 * `path` become case-insensitive glob pathspecs; a pattern also matches everything
	 * below a folder it matches. Includes are alternatives; excludes apply to all.
	 */
	private async search(
		query: Extract<WorkspaceQuery, { kind: "search" }>,
		context: Context,
	): Promise<WorkspaceResult> {
		const { text, path } = query;
		if (path) await this.resolve(path, context);
		const include = workspaceGlobs(query.include ?? "");
		const exclude = workspaceGlobs(query.exclude ?? "");
		if (!include || !exclude) throw new Error("Invalid file pattern");
		// Every pathspec carries explicit magic, so the scope path itself stays literal.
		const base = path ? `${path.replace(/[*?[\\]/g, "\\$&")}/` : "";
		const specs = (patterns: string[], magic: string) =>
			patterns.flatMap((pattern) => [`:(${magic})${base}${pattern}`, `:(${magic})${base}${pattern}/**`]);
		const pathspecs = [
			...(include.length ? specs(include, "glob,icase") : path ? [`:(literal)${path}`] : []),
			...specs(exclude, "glob,icase,exclude"),
		];
		const args = [
			"grep",
			"-n",
			"-z",
			"-I",
			"-F",
			"--no-color",
			"--no-textconv",
			"--exclude-standard",
			"-m",
			"20",
			...(text === text.toLowerCase() ? ["-i"] : []),
			"-e",
			text,
			"--",
			...pathspecs,
		];
		const grep = async (mode: string) => {
			let run = await this.git(["grep", mode, ...args.slice(1)], SEARCH_BYTES, context);
			// Git before 2.38 has no grep -m. Keep the byte/time limits and cap each file below instead.
			if (run.exitCode === 129 && run.stderr.includes("unknown switch `m'")) {
				args.splice(args.indexOf("-m"), 2);
				run = await this.git(["grep", mode, ...args.slice(1)], SEARCH_BYTES, context);
			}
			return run;
		};
		let run = await grep("--untracked");
		// Not a repository: search the directory itself.
		if (run.exitCode === 128) run = await grep("--no-index");
		if (run.exitCode > 1) throw new Error(firstLine(run.stderr) ?? "Search failed");
		const matches: WorkspaceMatch[] = [];
		const perFile = new Map<string, number>();
		// Records are path NUL line NUL text LF; a cut record at the output cap is dropped.
		let position = 0;
		while (matches.length < SEARCH_LIMIT) {
			const pathEnd = run.stdout.indexOf("\0", position);
			const lineEnd = pathEnd < 0 ? -1 : run.stdout.indexOf("\0", pathEnd + 1);
			const textEnd = lineEnd < 0 ? -1 : run.stdout.indexOf("\n", lineEnd + 1);
			if (textEnd < 0) break;
			const matchPath = run.stdout.slice(position, pathEnd);
			const count = perFile.get(matchPath) ?? 0;
			if (count < 20) {
				matches.push({
					path: matchPath,
					line: Number(run.stdout.slice(pathEnd + 1, lineEnd)),
					text: run.stdout.slice(lineEnd + 1, textEnd).slice(0, 300),
				});
				perFile.set(matchPath, count + 1);
			}
			position = textEnd + 1;
		}
		return {
			kind: "search",
			text,
			path,
			matches,
			truncated: run.truncated || matches.length >= SEARCH_LIMIT,
		};
	}

	/**
	 * Git without a shell, against untrusted repository configuration: no optional locks
	 * (never blocks the agent's git), no network fetches, no prompts, no pager, no system
	 * config, no fsmonitor, literal pathspecs and every configured clean/smudge filter
	 * disabled. Stdout and stderr are captured separately; stdout beyond `limit` cancels
	 * the command and is reported as truncated.
	 */
	/** `overrides`: filter overrides this request already fetched. */
	/**
	 * One chunk of an upload into a folder: chunks append to a hidden temporary file
	 * in that folder, renamed into place by the final one. Existing files are never
	 * overwritten.
	 */
	async write(upload: WorkspaceUpload, context: Context): Promise<void> {
		if (!/^[0-9a-f-]{36}$/.test(upload.token)) throw new Error("Invalid upload");
		const name = upload.name;
		if (!name || name.includes("/") || workspacePath(name) === undefined || name.startsWith(".pi-upload-"))
			throw new Error("Invalid file name");
		const directory = await this.resolve(upload.path, context);
		const prefix = directory === "/" ? "" : directory;
		const target = `${prefix}/${name}`;
		const temp = `${prefix}/.pi-upload-${upload.token}`;
		if (upload.abort) {
			await this.env.remove(temp, { force: true }, context);
			return;
		}
		const free = async () => {
			const exists = await this.env.exists(target, context);
			if (!exists.ok) throw new Error("Cannot write here");
			if (exists.value) throw new Error(`${name} already exists`);
		};
		const bytes = Buffer.from(upload.data, "base64");
		if (upload.offset === 0) await free();
		const written =
			upload.offset === 0
				? await this.env.writeFile(temp, bytes, context)
				: await this.env.appendFile(temp, bytes, context);
		if (!written.ok) throw new Error("Cannot write here");
		if (!upload.final) return;
		try {
			await free();
			const renamed = await this.env.renameFile(temp, target, context);
			if (!renamed.ok) throw new Error("Cannot write here");
		} catch (error) {
			await this.env.remove(temp, { force: true }, context);
			throw error;
		}
	}

	private async git(args: string[], limit: number, context: Context, overrides?: Promise<string[]>, cwd?: string) {
		const filters = await (overrides ?? this.filterOverrides(context));
		return this.capture(
			[
				"git",
				"--no-optional-locks",
				// check-ignore rejects the flag; it matches its arguments literally anyway.
				// grep gives each pathspec explicit magic for its file globs.
				...(args[0] === "check-ignore" || args[0] === "grep" ? [] : ["--literal-pathspecs"]),
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.quotepath=off",
				"-c",
				"core.pager=cat",
				...filters,
				...args,
			],
			limit,
			context,
			cwd,
		);
	}

	private filters?: Promise<string[]>;
	/** Running watchers: while one runs, any change (or watch error) discards the cached filter overrides. */
	private watchers = 0;
	private filterOverrides(context: Context): Promise<string[]> {
		// Clean/process filters run on stat-dirty files during status and diff. Override every configured driver so
		// repository config cannot run programs from the panel. Kept between requests only while a watcher would report
		// a configuration change; otherwise only requests in flight together share them.
		if (this.filters) return this.filters;
		const pending = this.capture(
			["git", "config", "--name-only", "--get-regexp", "^filter\\."],
			64 * 1024,
			context,
		).then((run) => {
			const drivers = new Set(
				run.stdout
					.split("\n")
					.map((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1])
					.filter((name) => name !== undefined),
			);
			return [...drivers].flatMap((name) => [
				"-c",
				`filter.${name}.clean=`,
				"-c",
				`filter.${name}.smudge=`,
				"-c",
				`filter.${name}.process=`,
				"-c",
				`filter.${name}.required=false`,
			]);
		});
		this.filters = pending;
		void pending.then(
			() => {
				if (!this.watchers && this.filters === pending) this.filters = undefined;
			},
			() => {
				if (this.filters === pending) this.filters = undefined;
			},
		);
		return pending;
	}

	private async capture(argv: string[], limit: number, context: Context, cwd?: string) {
		const run = withCancel(context);
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const result = await this.env.exec(
			argv,
			{
				cwd: cwd ?? (await this.canonicalRoot(context)),
				timeout: GIT_TIMEOUT,
				env: {
					GIT_OPTIONAL_LOCKS: "0",
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_PAGER: "cat",
					LC_ALL: "C",
				},
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") {
						if (stderr.length < 16 * 1024) stderr += text;
						return;
					}
					if (truncated) return;
					stdout += text;
					if (stdout.length > limit) {
						stdout = stdout.slice(0, limit);
						truncated = true;
						run.cancel(new Error("Output limit reached"));
					}
				},
			},
			run.context,
		);
		if (result.ok) return { exitCode: result.value.exitCode, stdout, stderr, truncated };
		if (truncated) return { exitCode: 0, stdout, stderr, truncated };
		if (result.error.code === "timeout") throw new Error("Git timed out");
		if (result.error.code === "spawn_error") throw new Error("Git is not installed in this environment");
		throw new Error(result.error.message);
	}

	/**
	 * Watch the working tree (without .git internals and node_modules) plus the
	 * repository's HEAD and index, which commits and staging change. A linked worktree
	 * (or a directory below the repository root) has them in a git directory elsewhere,
	 * and its config in the main repository's.
	 */
	async watch(onChange: () => void, context: Context): Promise<FileWatcher | undefined> {
		const root = await this.canonicalRoot(context);
		const located = await this.capture(
			["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
			8192,
			context,
		).catch(() => undefined);
		const [gitDir, commonDir] = located?.exitCode === 0 ? located.stdout.split("\n").map((line) => line.trim()) : [];
		const git = gitDir || `${root === "/" ? "" : root}/.git`;
		const config = `${commonDir || git}/config`;
		// Counted in `watchers` from start until closed or failed: a failed watcher reports nothing more.
		const state = { open: false };
		const stop = () => {
			if (!state.open) return;
			state.open = false;
			this.watchers--;
			this.filters = undefined;
		};
		const tree = await this.watchTargets(root, context);
		context.abortSignal?.throwIfAborted();
		const result = await this.env.watch(
			[...tree, { path: `${git}/HEAD` }, { path: `${git}/index` }, { path: config }],
			(change) => {
				// Any change may be configuration: .git/config, or a file it includes from the working tree.
				this.filters = undefined;
				if (change.kind === "failed") stop();
				else onChange();
			},
			context,
		);
		if (!result.ok) return undefined;
		const watcher = result.value;
		state.open = true;
		this.watchers++;
		return {
			mode: watcher.mode,
			stop: async (stopping) => {
				stop();
				await watcher.stop(stopping);
			},
		};
	}

	/**
	 * The working tree's watch targets, without private directories inside it (p2's data directory below a home folder
	 * changes all the time): the root recursively; around a private directory, each directory on the way to it by its own
	 * entries and its other folders recursively. A tree over `WATCH_DIRECTORIES` folders gets its root's entries only.
	 * Counted with a walk first (stopping at the bound, and when the watch is abandoned), as the watcher would scan it.
	 */
	private async watchTargets(root: string, context: Context): Promise<WatchTarget[]> {
		const join = (directory: string, name: string) => `${directory === "/" ? "" : directory}/${name}`;
		const within = (directory: string, path: string) =>
			path === directory || path.startsWith(directory === "/" ? "/" : `${directory}/`);
		const hidden = this.denied.filter((denied) => denied !== root && within(root, denied));
		const holdsPrivate = (path: string) => hidden.some((denied) => within(path, denied));
		/** Folders of the directories on the way to a private one. */
		const folders = new Map<string, string[]>();
		const queue = [root];
		let counted = 0;
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			context.abortSignal?.throwIfAborted();
			const listed = await this.env.listDir(next, context);
			if (!listed.ok) continue;
			const names: string[] = [];
			for (const entry of listed.value) {
				if (entry.kind !== "directory" || WATCH_EXCLUDED.includes(entry.name)) continue;
				const path = join(next, entry.name);
				if (hidden.some((denied) => within(denied, path))) continue;
				if (++counted > WATCH_DIRECTORIES) return [{ path: root }];
				names.push(entry.name);
				queue.push(path);
			}
			if (holdsPrivate(next)) folders.set(next, names);
		}
		const targets: WatchTarget[] = [];
		const cover = (directory: string): void => {
			if (!holdsPrivate(directory)) {
				targets.push({ path: directory, recursive: true, exclude: { names: WATCH_EXCLUDED } });
				return;
			}
			targets.push({ path: directory });
			for (const name of folders.get(directory) ?? []) cover(join(directory, name));
		};
		cover(root);
		return targets;
	}
}

function firstLine(text: string): string | undefined {
	return text.trim().split("\n")[0]?.slice(0, 300) || undefined;
}

/** UTF-8 text, or undefined for binary content (NUL bytes or invalid UTF-8). */
function decodeText(bytes: Uint8Array, truncated: boolean): string | undefined {
	if (bytes.subarray(0, 8192).includes(0)) return undefined;
	// A cut inside a multi-byte character is not binary; drop up to three trailing bytes.
	for (let drop = 0; drop <= (truncated ? 3 : 0); drop++) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - drop));
		} catch {}
	}
	return undefined;
}
