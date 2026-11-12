import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { cookieValue, localOwnerProof, privateWrite } from "@p2/app/v1/server";

/**
 * An owner session of a browser or client: an associated device's, the local owner's (loopback only), or one issued by
 * the password (`generation` names the account write it belongs to; a changed password invalidates it).
 */
export type OwnerSession =
	| { readonly kind: "device"; readonly id: string; readonly expires: number }
	| { readonly kind: "local"; readonly id: string; readonly expires: number }
	| { readonly kind: "password"; readonly id: string; readonly expires: number; readonly generation: string };

export const ownerCookieName = (port: number): string => `p2_owner_${port}`;
const TOKEN_LIFETIME = 10 * 60_000;
const CHALLENGE_LIFETIME = 60_000;
const COOKIE_LIFETIME = 30 * 24 * 60 * 60_000;
/** `[local.|pw.<generation>.]<id>.<expiry>.<signature>`; the signature covers the port and everything before it. */
const SESSION_COOKIE = /^(?:(local\.)|pw\.([a-f0-9]{32})\.)?([a-f0-9]{32})\.(\d+)\.([a-f0-9]{64})$/;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Owner sessions are signed cookies, never the installation key: one per associated device, and local sessions that
 * prove a loopback client ran as the server's user (it answered a challenge with the key, `src/runtime/local-owner.ts`).
 * Invitations and challenges stay single-use in memory. Rotating the key ends every session of both kinds.
 */
export class OwnerAccess {
	private key: string;
	private readonly directory: string;
	private readonly now: () => number;
	private readonly invitations = new Map<string, number>();
	private readonly challenges = new Map<string, number>();
	private revoked: Record<string, number>;
	private operations: Promise<void> = Promise.resolve();

	private constructor(directory: string, key: string, revoked: Record<string, number>, now: () => number) {
		this.directory = directory;
		this.key = key;
		this.revoked = revoked;
		this.now = now;
	}

	static async open(directory: string, now: () => number = () => Date.now()): Promise<OwnerAccess> {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "owner-key");
		let key: string;
		try {
			key = (await readFile(path, "utf8")).trim();
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			key = randomBytes(32).toString("hex");
			await writeFile(path, key, { mode: 0o600, flag: "wx" });
		}
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid owner key");
		await chmod(path, 0o600);
		// The previous cookie WAS the owner key. Rotate it once before using a private signing key,
		// otherwise an old device could manufacture signed cookies after the format change.
		const schemePath = join(directory, "owner-cookie-version");
		let scheme: string | undefined;
		try {
			scheme = (await readFile(schemePath, "utf8")).trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (scheme === undefined) {
			key = randomBytes(32).toString("hex");
			await privateWrite(path, key);
			await privateWrite(schemePath, "signed-v1\n");
		} else if (scheme !== "signed-v1") throw new Error("Invalid owner cookie version");
		let revoked: Record<string, number> = {};
		try {
			const value: unknown = JSON.parse(await readFile(join(directory, "owner-revoked.json"), "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.entries(value).some(([id, expires]) => !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(expires))
			)
				throw new Error("Invalid owner revocations");
			revoked = value as Record<string, number>;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
				throw new Error("Cannot read owner revocations");
		}
		const access = new OwnerAccess(directory, key, revoked, now);
		// Every startup has a fresh headless invitation. Never log it or put it in a query/path.
		await privateWrite(join(directory, "owner-token.txt"), `${access.issueToken()}\n`);
		return access;
	}

	issueToken(): string {
		return this.issue(this.invitations, TOKEN_LIFETIME);
	}

	claim(token: unknown): boolean {
		return typeof token === "string" && this.redeem(this.invitations, token.trim());
	}

	/** A one-time local sign-in challenge (one minute); a restart forgets it. */
	issueChallenge(): string {
		return this.issue(this.challenges, CHALLENGE_LIFETIME);
	}

	/** Whether `proof` answers the unused challenge for this port with the current key; the challenge is used up. */
	proveLocal(challenge: unknown, proof: unknown, port: number): boolean {
		if (typeof challenge !== "string" || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
		if (!this.redeem(this.challenges, challenge)) return false;
		return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(localOwnerProof(this.key, port, challenge), "hex"));
	}

	private issue(pending: Map<string, number>, lifetime: number): string {
		for (const [id, expires] of pending) if (expires <= this.now()) pending.delete(id);
		if (pending.size >= 32) pending.delete(pending.keys().next().value ?? "");
		const token = randomBytes(32).toString("hex");
		pending.set(hash(token), this.now() + lifetime);
		return token;
	}

	private redeem(pending: Map<string, number>, token: string): boolean {
		const id = hash(token);
		const expires = pending.get(id);
		pending.delete(id);
		return expires !== undefined && expires > this.now();
	}

	private signature(port: number, payload: string): string {
		return createHmac("sha256", this.key).update(`${port}:${payload}`).digest("hex");
	}

	/** A new associated device's session cookie. */
	cookie(port: number, secure: boolean): string {
		return this.sessionCookie(port, "", randomBytes(16).toString("hex"), secure);
	}

	/** A local session cookie: a new session, or `id`'s renewed for another 30 days (loopback only, never Secure). */
	localCookie(port: number, id = randomBytes(16).toString("hex")): string {
		return this.sessionCookie(port, "local.", id, false);
	}

	/**
	 * A session issued by the owner password, bound to `generation`: a new session (or `id`'s renewed). Secure only for
	 * a remote origin; the same cookie is a local or a device session there.
	 */
	passwordCookie(port: number, generation: string, secure: boolean, id = randomBytes(16).toString("hex")): string {
		return this.sessionCookie(port, `pw.${generation}.`, id, secure);
	}

	// SameSite=Lax, not Strict: a link into p2 from another site or local port must arrive signed in. The server drops
	// every cookie principal of another site's requests except top-level page navigations (Fetch Metadata).
	private sessionCookie(port: number, prefix: string, id: string, secure: boolean): string {
		const payload = `${prefix}${id}.${this.now() + COOKIE_LIFETIME}`;
		return `${ownerCookieName(port)}=${payload}.${this.signature(port, payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
	}

	clearCookie(port: number, secure: boolean): string {
		return `${ownerCookieName(port)}=; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Path=/; Max-Age=0`;
	}

	/** The request's valid, unrevoked owner session for this port, if any. */
	session(request: IncomingMessage, port: number): OwnerSession | undefined {
		const value = cookieValue(request, ownerCookieName(port));
		const match = value && SESSION_COOKIE.exec(value);
		if (!match) return undefined;
		const [, localPrefix, generation, id, expiry, signature] = match;
		const expires = Number(expiry);
		if (!Number.isSafeInteger(expires) || expires <= this.now() || (this.revoked[id!] ?? 0) > this.now())
			return undefined;
		const prefix = localPrefix ?? (generation ? `pw.${generation}.` : "");
		const payload = `${prefix}${id}.${expiry}`;
		if (!timingSafeEqual(Buffer.from(signature!, "hex"), Buffer.from(this.signature(port, payload), "hex")))
			return undefined;
		if (localPrefix) return { kind: "local", id: id!, expires };
		if (generation) return { kind: "password", id: id!, expires, generation };
		return { kind: "device", id: id!, expires };
	}

	logout(session: OwnerSession): Promise<void> {
		const operation = this.operations.then(async () => {
			this.revoked = Object.fromEntries(Object.entries(this.revoked).filter(([, expires]) => expires > this.now()));
			this.revoked[session.id] = session.expires;
			await privateWrite(join(this.directory, "owner-revoked.json"), JSON.stringify(this.revoked));
		});
		this.operations = operation.catch(() => {});
		return operation;
	}

	async close(): Promise<void> {
		this.invitations.clear();
		this.challenges.clear();
		await this.operations;
	}
}
