import type { Static } from "@earendil-works/pi-schema";
import type { Location } from "@p2/app/v1";
import type { QuerySchema, WriteSchema } from "./contract.ts";

// Workspace panel protocol: read-only views of a conversation's working directory,
// always resolved inside that conversation's execution environment by its worker.
/** The types of the contract's schemas (contract.ts). */
export type WorkspaceQuery = Static<typeof QuerySchema>;
export type WorkspaceUpload = Static<typeof WriteSchema>;
export type WorkspaceEntry = {
	name: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
	/** Matched by .gitignore (not reported for tracked files or outside a repository). */
	ignored?: boolean;
};
export type WorkspaceResult =
	| { kind: "list"; path: string; entries: WorkspaceEntry[]; truncated: boolean }
	| { kind: "file"; path: string; size: number; binary: boolean; text?: string; truncated: boolean }
	| { kind: "files"; paths: string[]; truncated: boolean }
	| {
			kind: "place";
			/** Where the workspace is open: the conversation's location as its worker resolved it. */
			location: Location;
			/** The session's move waiting for the main agent's turn to end. */
			pending?: Location;
			/** The session's last move that failed (cleared by the next one). */
			failed?: { to: Location; error: string };
	  };
/** A bounded byte range of one workspace file, transferred over IPC as base64. */
export type WorkspaceBytes = { size: number; start: number; data: string };

export const WORKSPACE_TEXT_LIMIT = 1024 * 1024;
export const WORKSPACE_READ_CHUNK = 1024 * 1024;
export const WORKSPACE_DOWNLOAD_LIMIT = 25 * 1024 * 1024;

export { workspacePath } from "./contract.ts";
