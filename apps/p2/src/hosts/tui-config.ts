import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDirectory, localOwnerSignIn } from "../runtime/local-owner.ts";
import { ownerLinkToken, ownerOrigin } from "../runtime/owner-link.ts";

export type TuiCredentials = { cookie?: string };
export type TuiConnection = TuiCredentials;
export type TuiConfig = { connections: Record<string, TuiConnection> };
/**
 * Who the launcher signed in as. Only `cookie` is ever sent, and only by the launcher. `local`: signed in with the data
 * directory's owner key (never saved; a new sign-in replaces it).
 */
export type TuiAdmission = TuiCredentials & { role: "owner"; local?: true };
export const configDirectory = (): string => process.env.P2_TUI_CONFIG_DIR ?? join(homedir(), ".pi", "p2-tui");
export function readConfig(directory = configDirectory()): TuiConfig {
	try {
		const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as TuiConfig;
		if (!config.connections || typeof config.connections !== "object" || Array.isArray(config.connections))
			throw new Error("Invalid TUI config");
		const connections: Record<string, TuiConnection> = {};
		for (const [origin, value] of Object.entries(config.connections)) {
			if (!value || typeof value !== "object" || (value.cookie !== undefined && typeof value.cookie !== "string"))
				throw new Error("Invalid TUI credentials");
			// Only cookies survive; old proxy passwords are neither used nor saved again.
			connections[origin] = value.cookie ? { cookie: value.cookie } : {};
		}
		return { connections };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: {} };
		throw new Error("Cannot read p2-tui config.json");
	}
}
export function saveConfig(config: TuiConfig, directory = configDirectory()): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = join(directory, "config.json");
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}
export function connectionHeaders(url: URL, credentials: TuiCredentials): Record<string, string> {
	return { Origin: url.origin, ...(credentials.cookie ? { Cookie: credentials.cookie } : {}) };
}
export async function claimOwner(url: URL, token: string, credentials: TuiCredentials): Promise<TuiCredentials> {
	const response = await fetch(new URL("/owner/claim", url), {
		method: "POST",
		headers: { ...connectionHeaders(url, credentials), "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("Owner claim failed; generate a fresh link with npm run owner-link on the host");
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
	if (!cookie) throw new Error("Owner claim did not return a cookie");
	return { cookie };
}

const isLoopback = (url: URL): boolean =>
	["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol === "http:";

/** Asks for a link; `reason` says why it is needed (shown before the question). */
export type TuiPrompt = (kind: "link", reason?: string) => Promise<string>;

/**
 * Sign-in (section 4.1). An expired or remotely revoked cookie leads back to sign-in, not an endless unauthenticated
 * reconnect. A valid saved owner cookie comes first. On loopback the server's own user then signs in with the owner key
 * of its data directory (`dataDir`, default `P2_DATA_DIR` or `~/.pi/p2`; a server with another data directory refuses
 * that with a clear error). Everyone else is asked for an owner link.
 */
export async function authenticateTui(
	options: { url: URL; ownerLink?: string; dataDir?: string },
	config: TuiConfig,
	prompt: TuiPrompt,
): Promise<TuiAdmission> {
	const { url } = options;
	const loopback = isLoopback(url);
	const stored = config.connections[url.origin] ?? {};
	let credentials: TuiCredentials = { cookie: stored.cookie };
	if (!options.ownerLink && credentials.cookie) {
		const response = await fetch(new URL("/owner/check", url), {
			headers: connectionHeaders(url, credentials),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (response.ok) {
			const value: unknown = await response.json();
			if (value && typeof value === "object" && "owner" in value && value.owner === true)
				return { ...credentials, role: "owner" };
			throw new Error("Invalid owner-access response");
		}
		await response.arrayBuffer().catch(() => {});
		if (response.status !== 401 && response.status !== 403) throw new Error("Cannot check owner access");
	}
	let reason: string | undefined;
	if (loopback && !options.ownerLink) {
		const local = await localOwnerSignIn(url, options.dataDir ?? dataDirectory());
		if (local.kind === "signed-in") return { cookie: local.cookie, role: "owner", local: true };
		reason = local.message;
	}
	const link = options.ownerLink ?? (await prompt("link", reason));
	credentials = await claimOwner(url, ownerLinkToken(link, url), credentials);
	config.connections[url.origin] = { ...(config.connections[url.origin] ?? {}), ...credentials };
	return { ...credentials, role: "owner" };
}

/** The launcher's own notice when the server stops admitting the stored cookie (the web page's wording). */
export const endedNotice = (): string => "Signed out on this device.";

/**
 * After a refused reconnect: forget the stored cookie, then offer to continue with a new owner link for this origin.
 * Undefined when the visitor quits (empty line).
 */
export async function resumeAfterEnded(
	url: URL,
	config: TuiConfig,
	ask: (question: string) => Promise<string>,
): Promise<{ ownerLink?: string } | undefined> {
	const { cookie: _ended, ...rest } = config.connections[url.origin] ?? {};
	config.connections[url.origin] = rest;
	let question = "Owner link to sign in again (npm run owner-link on the host; Enter to quit): ";
	for (;;) {
		const link = (await ask(question)).trim();
		if (!link) return undefined;
		try {
			ownerLinkToken(link, url);
			return { ownerLink: link };
		} catch (error) {
			question = `${(error as Error).message}. Try again (Enter to quit): `;
		}
	}
}

export function parseTuiArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
	let urlText: string | undefined;
	let ownerLink = env.P2_TUI_OWNER_LINK;
	let theme: string | undefined;
	let noThemes = false;
	let radius: { server?: string } | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--radius") {
			// Optionally followed by the server's ID; without it, the user's only online server.
			const next = args[i + 1];
			radius = next !== undefined && SERVER_ID.test(next) ? { server: args[++i] } : {};
		} else if (arg === "--owner-link") {
			ownerLink = args[++i];
			if (!ownerLink) throw new Error("--owner-link needs a value");
		} else if (arg === "--theme") {
			// pi's --theme: this run's theme setting (a name or "light/dark" pair).
			theme = args[++i];
			if (!theme) throw new Error("--theme needs a value");
		} else if (arg === "--no-themes") noThemes = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown TUI option: ${arg}`);
		else urlText = arg;
	}
	if (radius && (urlText !== undefined || args.includes("--owner-link")))
		throw new Error("--radius signs in through Radius: no URL or owner link");
	if (radius) ownerLink = undefined;
	const url = ownerOrigin(urlText ?? `http://127.0.0.1:${env.PORT ?? 8788}`);
	if (ownerLink) ownerLinkToken(ownerLink, url);
	return { url, ownerLink, theme, noThemes, radius };
}

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
