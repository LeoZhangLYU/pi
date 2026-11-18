// The AGENTS.md files the HR manager keeps for each member. They live beside the session's store
// (`sessions/<id>/team/<member>/AGENTS.md`), are read into that member's prompt (`memberAgentsExtension`), and are
// written only through the staff tool (`agents`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sessionDirectory } from "@p2/app/v1/node";
import { MEMBER_NAME } from "./team.ts";

/** One member's AGENTS.md, as the staff tool and the member's prompt use it. */
export type TeamFiles = {
	/** Its content, or undefined when it does not exist. */
	read(name: string): Promise<string | undefined>;
	/** Replaces it, creating the member's directory. */
	write(name: string, text: string): Promise<void>;
	/** Creates an empty one when the member has none. */
	ensure(name: string): Promise<void>;
};

/** The AGENTS.md files of the session `session` in `dataDir`. */
export function teamFiles(dataDir: string, session: string): TeamFiles {
	const root = join(sessionDirectory(dataDir, session), "team");
	const at = (name: string): string => {
		// Members are named by `MEMBER_NAME` when they are hired; the check keeps a bad name out of the path.
		if (!MEMBER_NAME.test(name)) throw new Error(`Invalid member name ${name}`);
		return join(root, name, "AGENTS.md");
	};
	const code = (error: unknown): string | undefined =>
		typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	return {
		// A subagent from before roles may have a name `MEMBER_NAME` refuses: it has no file, and its prompt must not fail.
		read: async (name) => {
			if (!MEMBER_NAME.test(name)) return undefined;
			try {
				return await readFile(at(name), "utf8");
			} catch (error) {
				if (code(error) === "ENOENT") return undefined;
				throw error;
			}
		},
		write: async (name, text) => {
			const path = at(name);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, text, "utf8");
		},
		ensure: async (name) => {
			const path = at(name);
			await mkdir(dirname(path), { recursive: true });
			try {
				await writeFile(path, "", { flag: "wx" });
			} catch (error) {
				if (code(error) !== "EEXIST") throw error;
			}
		},
	};
}
