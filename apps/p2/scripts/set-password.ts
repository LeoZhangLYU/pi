// Sets the owner password (or changes it): writes <data-dir>/owner-account.json with a scrypt hash. The password comes
// from P2_PASSWORD or stdin, never from argv (shell history, `ps`). A changed password signs out password sessions.

import { dataDirectory } from "../src/runtime/local-owner.ts";
import { DEFAULT_OWNER_USERNAME, readOwnerAccount, setOwnerPassword } from "../src/runtime/owner-account.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks)
		.toString("utf8")
		.replace(/\r?\n$/, "");
}

const args = process.argv.slice(2);
try {
	if (args.length > 1) throw new Error("Usage: npm run set-password [username]");
	const directory = dataDirectory();
	const current = await readOwnerAccount(directory);
	const username = (
		args[0] ??
		process.env.P2_USERNAME ??
		(current.kind === "configured" ? current.account.username : DEFAULT_OWNER_USERNAME)
	).trim();
	const password = process.env.P2_PASSWORD ?? (process.stdin.isTTY ? undefined : await readStdin());
	if (password === undefined || password === "") throw new Error("Set P2_PASSWORD or pipe the password on stdin");
	await setOwnerPassword(directory, username, password);
	console.log(`p2: password set for ${username}; password sessions are signed out.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Cannot set the owner password");
	process.exitCode = 1;
}
