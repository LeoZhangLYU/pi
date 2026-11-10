// Atomic writes of private state files: a temporary file renamed over the target, mode 0600. A failed write never
// truncates the previous file, so a crash leaves the last committed value in place.

import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function privateWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
