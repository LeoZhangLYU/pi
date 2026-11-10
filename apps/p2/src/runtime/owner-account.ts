// The owner account: one username and one password, stored only as a scrypt hash in `<dataDir>/owner-account.json`
// (0600, atomically replaced). There is no user table: p2 has exactly one owner, and the password replaces the
// one-time invitation as the everyday way in. `generation` is the password-session epoch: every write regenerates it,
// so changing the password ends every password-issued session without touching owner links or local key sessions.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateWrite } from "./private-file.ts";

export type ScryptParameters = { readonly N: number; readonly r: number; readonly p: number; readonly keylen: number };

/** The exact v1 parameters: a hand-edited file cannot force larger memory use. */
export const SCRYPT_PARAMETERS: ScryptParameters = { N: 16384, r: 8, p: 1, keylen: 32 };
export const OWNER_ACCOUNT_FILE = "owner-account.json";
export const DEFAULT_OWNER_USERNAME = "owner";
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

export type OwnerAccount = {
	readonly version: 1;
	readonly username: string;
	readonly salt: string;
	readonly hash: string;
	readonly scrypt: ScryptParameters;
	readonly revision: number;
	readonly generation: string;
	readonly updatedAt: number;
};

export type AccountState =
	| { readonly kind: "configured"; readonly account: OwnerAccount }
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly message: string };

export type Verification =
	| { readonly kind: "configured"; readonly matched: boolean; readonly account: OwnerAccount }
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly message: string };

const GENERATION = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export const ownerAccountPath = (directory: string): string => join(directory, OWNER_ACCOUNT_FILE);

/** Why `username` cannot be stored, or undefined when it can. */
export function usernameProblem(username: string): string | undefined {
	if (username.length < 1 || username.length > 64) return "Username must be 1 to 64 characters.";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	if (/[\u0000-\u001f\u007f]/.test(username)) return "Username cannot contain control characters.";
	return undefined;
}

/** Why `password` cannot be stored, or undefined when it can. The 512-byte cap keeps the login body under 1 KiB. */
export function passwordProblem(password: string): string | undefined {
	const bytes = Buffer.byteLength(password, "utf8");
	if (bytes < 8) return "Password must be at least 8 bytes.";
	if (bytes > 512) return "Password must be at most 512 bytes.";
	return undefined;
}

function scryptParameters(value: unknown): ScryptParameters | undefined {
	if (!value || typeof value !== "object") return undefined;
	const parameters = value as Record<string, unknown>;
	if (
		parameters.N !== SCRYPT_PARAMETERS.N ||
		parameters.r !== SCRYPT_PARAMETERS.r ||
		parameters.p !== SCRYPT_PARAMETERS.p ||
		parameters.keylen !== SCRYPT_PARAMETERS.keylen
	)
		return undefined;
	return SCRYPT_PARAMETERS;
}

/** Validates a file's contents at this trust boundary (hand-edited or corrupt files). */
export function parseOwnerAccount(text: string): AccountState {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "invalid", message: "The owner account file is not valid JSON." };
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { kind: "invalid", message: "The owner account file is not an object." };
	const account = value as Record<string, unknown>;
	if (account.version !== 1) return { kind: "invalid", message: "Unsupported owner account version." };
	const scryptValue = scryptParameters(account.scrypt);
	if (scryptValue === undefined) return { kind: "invalid", message: "Unsupported password hash parameters." };
	if (typeof account.username !== "string" || usernameProblem(account.username) !== undefined)
		return { kind: "invalid", message: "The owner account has an invalid username." };
	if (typeof account.salt !== "string" || !GENERATION.test(account.salt))
		return { kind: "invalid", message: "The owner account has an invalid salt." };
	if (typeof account.hash !== "string" || !HASH.test(account.hash))
		return { kind: "invalid", message: "The owner account has an invalid password hash." };
	if (typeof account.generation !== "string" || !GENERATION.test(account.generation))
		return { kind: "invalid", message: "The owner account has an invalid session generation." };
	if (typeof account.revision !== "number" || !Number.isSafeInteger(account.revision) || account.revision < 1)
		return { kind: "invalid", message: "The owner account has an invalid revision." };
	if (typeof account.updatedAt !== "number" || !Number.isSafeInteger(account.updatedAt))
		return { kind: "invalid", message: "The owner account has an invalid timestamp." };
	return {
		kind: "configured",
		account: {
			version: 1,
			username: account.username,
			salt: account.salt,
			hash: account.hash,
			scrypt: scryptValue,
			revision: account.revision,
			generation: account.generation,
			updatedAt: account.updatedAt,
		},
	};
}

function missing(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readOwnerAccount(directory: string): Promise<AccountState> {
	let text: string;
	try {
		text = await readFile(ownerAccountPath(directory), "utf8");
	} catch (error) {
		if (missing(error)) return { kind: "absent" };
		return { kind: "invalid", message: "The owner account file cannot be read." };
	}
	return parseOwnerAccount(text);
}

export function readOwnerAccountSync(directory: string): AccountState {
	let text: string;
	try {
		text = readFileSync(ownerAccountPath(directory), "utf8");
	} catch (error) {
		if (missing(error)) return { kind: "absent" };
		return { kind: "invalid", message: "The owner account file cannot be read." };
	}
	return parseOwnerAccount(text);
}

export async function writeOwnerAccount(directory: string, account: OwnerAccount): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await privateWrite(ownerAccountPath(directory), `${JSON.stringify(account, undefined, 2)}\n`);
	await chmod(ownerAccountPath(directory), 0o600);
}

function deriveKey(password: string, salt: string, parameters: ScryptParameters): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password,
			salt,
			parameters.keylen,
			{ N: parameters.N, r: parameters.r, p: parameters.p, maxmem: MAX_SCRYPT_MEMORY },
			(error, key) => (error ? reject(error) : resolve(key)),
		);
	});
}

/**
 * Whether `username` and `password` match the account. The key derivation always runs when an account exists, so a
 * wrong username costs what a wrong password does; both comparisons are constant-time.
 */
export async function verifyOwnerAccount(account: OwnerAccount, username: string, password: string): Promise<boolean> {
	const derived = await deriveKey(password, account.salt, account.scrypt);
	const passwordMatch = timingSafeEqual(derived, Buffer.from(account.hash, "hex"));
	const usernameMatch = timingSafeEqual(SHA256(username.trim()), SHA256(account.username));
	return passwordMatch && usernameMatch;
}

/** Creates or replaces the account (the CLI path). A corrupt existing file is refused rather than overwritten. */
export async function setOwnerPassword(directory: string, username: string, password: string): Promise<OwnerAccount> {
	const name = username.trim();
	const nameProblem = usernameProblem(name);
	if (nameProblem !== undefined) throw new Error(nameProblem);
	const passwordIssue = passwordProblem(password);
	if (passwordIssue !== undefined) throw new Error(passwordIssue);
	const current = await readOwnerAccount(directory);
	if (current.kind === "invalid") throw new Error(`Cannot replace ${ownerAccountPath(directory)}: ${current.message}`);
	const salt = randomBytes(16).toString("hex");
	const account: OwnerAccount = {
		version: 1,
		username: name,
		salt,
		hash: (await deriveKey(password, salt, SCRYPT_PARAMETERS)).toString("hex"),
		scrypt: SCRYPT_PARAMETERS,
		revision: current.kind === "configured" ? current.account.revision + 1 : 1,
		generation: randomBytes(16).toString("hex"),
		updatedAt: Date.now(),
	};
	await writeOwnerAccount(directory, account);
	return account;
}

/**
 * The account as the server sees it, refreshed by a stat fingerprint (an atomic rename changes the inode), so a CLI
 * password change applies without a restart. Only requests presenting a password cookie pay for the stat.
 */
export class OwnerAccounts {
	private readonly directory: string;
	private cached: AccountState;
	private fingerprint: string;

	private constructor(directory: string, state: AccountState) {
		this.directory = directory;
		this.cached = state;
		this.fingerprint = this.#fingerprint();
	}

	/** Never rejects: an unreadable or corrupt account becomes `invalid`, and owner recovery keeps working. */
	static async open(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnerAccounts> {
		let state: AccountState;
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			state = await readOwnerAccount(directory);
			const bootstrap = state.kind === "absent" ? env.P2_PASSWORD : undefined;
			if (state.kind === "absent" && bootstrap) {
				await setOwnerPassword(directory, env.P2_USERNAME ?? DEFAULT_OWNER_USERNAME, bootstrap);
				state = await readOwnerAccount(directory);
			}
			await chmod(ownerAccountPath(directory), 0o600).catch(() => {});
		} catch (error) {
			state = {
				kind: "invalid",
				message: `Cannot prepare the owner account: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return new OwnerAccounts(directory, state);
	}

	state(): AccountState {
		const fingerprint = this.#fingerprint();
		if (fingerprint !== this.fingerprint) {
			this.cached = readOwnerAccountSync(this.directory);
			this.fingerprint = fingerprint;
		}
		return this.cached;
	}

	async verify(username: string, password: string): Promise<Verification> {
		const state = this.state();
		if (state.kind !== "configured") return state;
		const matched = await verifyOwnerAccount(state.account, username, password);
		return { kind: "configured", matched, account: state.account };
	}

	#fingerprint(): string {
		try {
			const info = statSync(ownerAccountPath(this.directory), { bigint: true });
			return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
		} catch {
			return "missing";
		}
	}
}
