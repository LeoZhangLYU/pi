import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnerAccess } from "../../plugins/devices/owner-access.ts";
import { LoginAttempts } from "../../src/runtime/login-attempts.ts";
import {
	OwnerAccounts,
	ownerAccountPath,
	parseOwnerAccount,
	setOwnerPassword,
	verifyOwnerAccount,
} from "../../src/runtime/owner-account.ts";
import { http, startFixture } from "./helpers.ts";

const requestWith = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
const cookieOf = (response: { headers: Record<string, string | string[] | undefined> }): string => {
	const values = response.headers["set-cookie"];
	const value = Array.isArray(values) ? values[0] : values;
	assert(value, "expected a Set-Cookie header");
	return value.split(";")[0]!;
};
const login = (port: number, body: unknown, headers: Record<string, string> = {}) =>
	http(port, "/owner/login", {
		method: "POST",
		headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

test("the owner account file is private, hashed and regenerates its session generation on every write", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-owner-account-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = await setOwnerPassword(directory, "owner", "correct horse battery");
	assert.equal((await stat(ownerAccountPath(directory))).mode & 0o777, 0o600);
	const text = await readFile(ownerAccountPath(directory), "utf8");
	assert(!text.includes("correct horse battery"));
	const parsed = parseOwnerAccount(text);
	assert.equal(parsed.kind, "configured");
	assert(parsed.kind === "configured" && parsed.account.revision === 1);
	assert.equal(await verifyOwnerAccount(first, "owner", "correct horse battery"), true);
	assert.equal(await verifyOwnerAccount(first, "owner", "wrong password"), false);
	assert.equal(await verifyOwnerAccount(first, "someone", "correct horse battery"), false);
	const second = await setOwnerPassword(directory, "owner", "another good password");
	assert.equal(second.revision, 2);
	assert.notEqual(second.generation, first.generation, "a password write starts a new session generation");
	assert.equal(await verifyOwnerAccount(second, "owner", "correct horse battery"), false);
	assert.equal(parseOwnerAccount("{").kind, "invalid");
	assert.equal(parseOwnerAccount(JSON.stringify({ ...second, version: 2 })).kind, "invalid");
});

test("OwnerAccounts refreshes the account after a CLI write without a restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-owner-accounts-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await setOwnerPassword(directory, "owner", "first password");
	const accounts = await OwnerAccounts.open(directory);
	const first = await accounts.verify("owner", "first password");
	assert(first.kind === "configured" && first.matched);
	await setOwnerPassword(directory, "owner", "second password");
	const second = await accounts.verify("owner", "second password");
	assert(second.kind === "configured" && second.matched);
	const old = await accounts.verify("owner", "first password");
	assert(old.kind === "configured" && !old.matched);
	const corrupt = join(directory, "owner-account.json");
	await writeFile(corrupt, "not json");
	assert.deepEqual(accounts.state().kind, "invalid");
});

test("password cookies are port-bound, signed and expire like other owner sessions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-password-cookie-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let now = 1_000_000;
	const access = await OwnerAccess.open(directory, () => now);
	t.after(() => access.close());
	const generation = "a".repeat(32);
	const value = access.passwordCookie(8788, generation, true);
	assert.match(
		value,
		/^p2_owner_8788=pw\.a{32}\.[a-f0-9]{32}\.\d+\.[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure$/,
	);
	const cookie = value.split(";")[0]!;
	const session = access.session(requestWith(cookie), 8788);
	assert(session?.kind === "password" && session.generation === generation);
	assert.equal(access.session(requestWith(cookie), 8789), undefined, "cookies are scoped to the port");
	const tampered = cookie.replace(`pw.${generation}.`, `pw.${"b".repeat(32)}.`);
	assert.equal(access.session(requestWith(tampered), 8788), undefined, "the signature covers the generation");
	now += 30 * 24 * 60 * 60_000 + 1;
	assert.equal(access.session(requestWith(cookie), 8788), undefined, "sessions expire");
});

test("login attempts back off globally and allow one verification at a time", () => {
	let now = 0;
	const attempts = new LoginAttempts(() => now, 5, 30_000, 5 * 60_000);
	const release = attempts.acquire();
	assert(release);
	assert.equal(attempts.acquire(), undefined, "one verification in flight");
	release?.();
	for (let count = 0; count < 5; count++) attempts.failed();
	assert.equal(attempts.retryAfterMs(), 30_000);
	assert.equal(attempts.acquire(), undefined);
	now += 30_000;
	const next = attempts.acquire();
	assert(next, "the first block ends after thirty seconds");
	next?.();
	attempts.failed();
	assert.equal(attempts.retryAfterMs(), 60_000, "each further failure doubles the block");
	now += 60_000;
	attempts.succeeded();
	assert.equal(attempts.retryAfterMs(), 0);
	const after = attempts.acquire();
	assert(after);
	after?.();
});

test("password login works on loopback, renews, and a password change ends password sessions only", async () => {
	const fixture = await startFixture({ web: true });
	try {
		const port = fixture.server.port;
		await setOwnerPassword(fixture.dataDir, "owner", "a good password");
		assert.equal((await login(port, { username: "owner", password: "wrong password" })).status, 401);
		const accepted = await login(port, { username: "owner", password: "a good password" });
		assert.equal(accepted.status, 200, accepted.body);
		const cookie = cookieOf(accepted);
		assert(cookie.includes("=pw."));
		assert(!cookieOf(accepted).includes("Secure"));
		assert.equal((await http(port, "/owner/check", { headers: { Cookie: cookie } })).status, 200);
		assert.equal((await http(port, "/", { headers: { Cookie: cookie } })).status, 200);
		const renewed = await http(port, "/", { headers: { Cookie: cookie } });
		const renewedCookie = cookieOf(renewed);
		assert.equal(renewedCookie.split(".").slice(0, 3).join("."), cookie.split(".").slice(0, 3).join("."));
		assert.equal(
			(await http(port, "/owner/check", { headers: { Cookie: cookie } })).headers["set-cookie"],
			undefined,
		);
		// The recovery token keeps working after a password change; the old password session does not.
		await setOwnerPassword(fixture.dataDir, "owner", "a different password");
		assert.equal((await http(port, "/owner/check", { headers: { Cookie: cookie } })).status, 401);
		assert.equal((await login(port, { username: "owner", password: "a good password" })).status, 401);
		assert.equal((await login(port, { username: "owner", password: "a different password" })).status, 200);
		const token = JSON.parse((await fixture.http("/owner-token")).body).token;
		assert.equal(
			(
				await http(port, "/owner/claim", {
					method: "POST",
					headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
				})
			).status,
			200,
		);
	} finally {
		await fixture.close();
	}
});

test("password login on a tunnel host is a secure device session without local powers", async () => {
	const fixture = await startFixture({ allowedHosts: ["owner.test"] });
	try {
		await setOwnerPassword(fixture.dataDir, "owner", "a good password");
		const port = fixture.server.port;
		const headers = { Host: "owner.test", Origin: "https://owner.test" };
		const accepted = await login(port, { username: "owner", password: "a good password" }, headers);
		assert.equal(accepted.status, 200, accepted.body);
		const setCookie = String(accepted.headers["set-cookie"]);
		assert(setCookie.includes("; Secure"));
		const cookie = setCookie.split(";")[0]!;
		assert.equal((await http(port, "/owner/check", { headers: { ...headers, Cookie: cookie } })).status, 200);
		assert.equal((await http(port, "/owner-token", { headers: { ...headers, Cookie: cookie } })).status, 403);
	} finally {
		await fixture.close();
	}
});

test("without an account the sign-in page offers the recovery token and login reports it absent", async () => {
	const fixture = await startFixture();
	try {
		const port = fixture.server.port;
		const page = await http(port, "/owner");
		assert.equal(page.status, 200);
		assert(page.body.includes("No owner password is configured"));
		assert(page.body.includes('"/owner/claim"'));
		assert(!page.body.includes('autocomplete="username"'));
		const response = await login(port, { username: "owner", password: "whatever" });
		assert.equal(response.status, 409);
	} finally {
		await fixture.close();
	}
});

test("a corrupt account file disables password login but keeps the recovery token working", async () => {
	const fixture = await startFixture();
	try {
		const port = fixture.server.port;
		await writeFile(ownerAccountPath(fixture.dataDir), "{broken");
		const page = await http(port, "/owner");
		assert(page.body.includes("Password sign-in is unavailable"));
		assert.equal((await login(port, { username: "owner", password: "a good password" })).status, 503);
		const token = JSON.parse((await fixture.http("/owner-token")).body).token;
		assert.equal(
			(
				await http(port, "/owner/claim", {
					method: "POST",
					headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
				})
			).status,
			200,
		);
	} finally {
		await fixture.close();
	}
});

test("failed logins back off and hardening rejects foreign or malformed requests", async () => {
	const fixture = await startFixture();
	try {
		const port = fixture.server.port;
		await setOwnerPassword(fixture.dataDir, "owner", "a good password");
		const foreign = await login(
			port,
			{ username: "owner", password: "a good password" },
			{ Origin: "https://foreign.test" },
		);
		assert.equal(foreign.status, 403);
		const malformed = await http(port, "/owner/login", {
			method: "POST",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: "{",
		});
		assert.equal(malformed.status, 400);
		const huge = await http(port, "/owner/login", {
			method: "POST",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: "x".repeat(1025),
		});
		assert.equal(huge.status, 413);
		const missing = await http(port, "/owner/login", {
			method: "POST",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ username: "owner" }),
		});
		assert.equal(missing.status, 400);
		for (let count = 0; count < 5; count++)
			assert.equal((await login(port, { username: "owner", password: "wrong password" })).status, 401);
		const blocked = await login(port, { username: "owner", password: "a good password" });
		assert.equal(blocked.status, 429);
		assert(String(blocked.headers["retry-after"]).length > 0);
	} finally {
		await fixture.close();
	}
});

test("P2_USERNAME and P2_PASSWORD bootstrap the account only when none exists", async () => {
	process.env.P2_USERNAME = "boss";
	process.env.P2_PASSWORD = "bootstrap password";
	const fixture = await startFixture();
	try {
		const port = fixture.server.port;
		const stored = await readFile(ownerAccountPath(fixture.dataDir), "utf8");
		assert.equal(JSON.parse(stored).username, "boss");
		assert.equal((await login(port, { username: "boss", password: "bootstrap password" })).status, 200);
	} finally {
		delete process.env.P2_USERNAME;
		delete process.env.P2_PASSWORD;
		await fixture.close();
	}
});
