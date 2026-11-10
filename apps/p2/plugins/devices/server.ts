import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type Ctx,
	constant,
	defineFacet,
	forbidden,
	isOwner,
	nativeOf,
	type P2Principal,
	serveNative,
} from "@p2/app/v1";
import {
	Authenticators,
	fromOrigin,
	LOCAL_CHALLENGE_PATH,
	LOCAL_CLAIM_PATH,
	LoginAttempts,
	OwnerAccounts,
	PageCookies,
	type RequestOrigin,
	RequestResolvers,
	Routes,
	requestOrigin,
	Server,
	type SignInState,
	SignInStates,
	sendJson,
	signIn,
	type Verification,
} from "@p2/app/v1/server";
import { DeviceAccess, DeviceAccesses, Devices } from "./contract.ts";
import { OwnerAccess } from "./owner-access.ts";

export default defineFacet((host) => {
	serveNative(host, DeviceAccesses);
	host.serve(DeviceAccess, (_params, self) => {
		const server = self.get(Server, {});
		const accessResource = self.open(
			async () => OwnerAccess.open(server.info.value.dataDir),
			(access) => access.close(),
		);
		// The owner account (one username and password) and the login throttle. Both stay in this plugin object.
		const accountsResource = self.open(
			async () => OwnerAccounts.open(server.info.value.dataDir),
			() => {},
		);
		const loginAttempts = new LoginAttempts();
		const signInState = (): SignInState => {
			const state = accountsResource.value.state();
			return {
				account: state.kind === "configured" ? "configured" : state.kind === "absent" ? "absent" : "invalid",
			};
		};
		self.contribute(DeviceAccesses, {
			get access() {
				return accessResource.value;
			},
		});
		// A local session counts only on loopback: a copied cookie on a tunnel host or through Radius is nobody.
		const principal = (request: IncomingMessage, origin: RequestOrigin): P2Principal | undefined => {
			const session = accessResource.value.session(request, origin.port);
			if (session?.kind === "password") {
				// A password change regenerates the account's generation: its sessions end on their next request.
				const state = accountsResource.value.state();
				if (state.kind !== "configured" || state.account.generation !== session.generation) return undefined;
				return origin.remote
					? { kind: "owner", access: "device", device: session.id }
					: { kind: "owner", access: "local" };
			}
			if (session?.kind === "device") return { kind: "owner", access: "device", device: session.id };
			return session?.kind === "local" && !origin.remote ? { kind: "owner", access: "local" } : undefined;
		};
		self.contribute(Authenticators, { owner: (request, origin) => principal(request, origin) });
		// A valid owner cookie takes precedence over a pre-existing guest cookie. Host checks still apply.
		self.contribute(RequestResolvers, {
			ownerCookie: (request) => {
				const origin = requestOrigin(request, server.info.value.allowedHosts);
				const owner = origin?.remote ? principal(request, origin) : undefined;
				return origin && owner ? { origin, principal: owner } : undefined;
			},
		});
		// A local or password session in use does not expire: each app load renews it for another 30 days.
		self.contribute(PageCookies, {
			localSession: (request, { origin }) => {
				const session = origin.remote ? undefined : accessResource.value.session(request, origin.port);
				return session?.kind === "local" ? accessResource.value.localCookie(origin.port, session.id) : undefined;
			},
			passwordSession: (request, { origin }) => {
				const session = accessResource.value.session(request, origin.port);
				if (session?.kind !== "password") return undefined;
				const state = accountsResource.value.state();
				if (state.kind !== "configured" || state.account.generation !== session.generation) return undefined;
				return accessResource.value.passwordCookie(origin.port, session.generation, origin.remote, session.id);
			},
		});
		// What the sign-in page shows: whether the owner password exists (see src/runtime/page.ts).
		self.contribute(SignInStates, { ownerAccount: signInState });
		/** Reads a small JSON body; undefined (after answering 413/400) when it is too large or not JSON. */
		const readJson = async (request: IncomingMessage, response: ServerResponse): Promise<unknown> => {
			let body = "";
			for await (const chunk of request) {
				body += String(chunk);
				if (Buffer.byteLength(body) > 1024) {
					request.resume();
					response.writeHead(413);
					response.end("Too large");
					return undefined;
				}
			}
			try {
				return JSON.parse(body);
			} catch {
				response.writeHead(400);
				response.end("Invalid sign-in request");
				return undefined;
			}
		};
		/** A same-origin POST that no other site's page made; refused (403) otherwise. */
		const sameOriginPost = (request: IncomingMessage, response: ServerResponse, origin: RequestOrigin): boolean => {
			if (fromOrigin(request, origin) && request.headers["sec-fetch-site"] !== "cross-site") return true;
			request.resume();
			response.writeHead(403);
			response.end("Invalid origin");
			return false;
		};
		const logout = async (
			request: IncomingMessage,
			response: ServerResponse,
			access: { principal: P2Principal | undefined; origin: { origin: string; port: number; remote: boolean } },
			all: boolean,
			ctx: Ctx,
		) => {
			if (!sameOriginPost(request, response, access.origin)) return;
			if (all && !isOwner(access.principal)) {
				request.resume();
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			request.resume();
			const session = accessResource.value.session(request, access.origin.port);
			try {
				if (all) await accessResource.value.rotate();
				else if (session) await accessResource.value.logout(session);
			} finally {
				// Local sessions share one principal: ending one leaves the others' live links alone. A remote password
				// session is a device of its own (loopback password sessions are the shared local principal).
				if (all) await server.revokeOwners({}, ctx);
				else if (session && (session.kind === "device" || (session.kind === "password" && access.origin.remote)))
					await server.revokeOwners({ device: session.id }, ctx);
			}
			sendJson(
				response,
				200,
				{ ok: true },
				{ "Set-Cookie": accessResource.value.clearCookie(access.origin.port, access.origin.remote) },
			);
		};
		self.contribute(Routes, {
			"GET /owner": (request, response) => signIn(request, response, 200, signInState()),
			"HEAD /owner": (request, response) => signIn(request, response, 200, signInState()),
			"GET /owner/check": (request, response, { principal }) => {
				if (!isOwner(principal)) {
					signIn(request, response, 401, signInState());
					return;
				}
				sendJson(response, 200, { owner: true });
			},
			// The owner account (one username and password). The token routes below are the recovery escape hatch.
			"POST /owner/login": async (request, response, { origin }) => {
				if (!sameOriginPost(request, response, origin)) return;
				const value = await readJson(request, response);
				if (value === undefined) return;
				const field = (key: string): unknown =>
					value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
				const username = field("username");
				const password = field("password");
				if (typeof username !== "string" || typeof password !== "string") {
					sendJson(response, 400, { error: "Username and password are required" });
					return;
				}
				const state = accountsResource.value.state();
				if (state.kind !== "configured") {
					sendJson(response, state.kind === "absent" ? 409 : 503, {
						error:
							state.kind === "absent"
								? "No owner password is configured. Sign in with a recovery token or run npm run set-password."
								: "Password sign-in is unavailable. Sign in with a recovery token.",
					});
					return;
				}
				const release = loginAttempts.acquire();
				if (release === undefined) {
					response.setHeader("Retry-After", String(Math.max(1, Math.ceil(loginAttempts.retryAfterMs() / 1000))));
					sendJson(response, 429, { error: "Too many attempts. Wait and try again." });
					return;
				}
				let verification: Verification;
				try {
					verification = await accountsResource.value.verify(username.trim(), password);
				} finally {
					release();
				}
				if (verification.kind !== "configured") {
					sendJson(response, verification.kind === "absent" ? 409 : 503, {
						error:
							verification.kind === "absent"
								? "No owner password is configured. Sign in with a recovery token or run npm run set-password."
								: "Password sign-in is unavailable. Sign in with a recovery token.",
					});
					return;
				}
				if (!verification.matched) {
					loginAttempts.failed();
					sendJson(response, 401, { error: "Invalid username or password" });
					return;
				}
				loginAttempts.succeeded();
				const cookie = accessResource.value.passwordCookie(
					origin.port,
					verification.account.generation,
					origin.remote,
				);
				sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
			},
			"POST /owner/logout": (request, response, access, ctx) => logout(request, response, access, false, ctx),
			"POST /owner/logout-all": (request, response, access, ctx) => logout(request, response, access, true, ctx),
			// Only a local owner's own request: no browser fetch of another origin, not even of this site.
			"GET /owner-token": (request, response, { principal, origin }) => {
				const site = request.headers["sec-fetch-site"];
				if (
					!isOwner(principal) ||
					principal.access !== "local" ||
					origin.remote ||
					(site !== undefined && site !== "same-origin")
				) {
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				sendJson(response, 200, { token: accessResource.value.issueToken() });
			},
			// On loopback the claim is a local session: the invitation came from a local owner to someone at this machine.
			"POST /owner/claim": async (request, response, { origin }) => {
				if (!sameOriginPost(request, response, origin)) return;
				const value = await readJson(request, response);
				if (value === undefined) return;
				const token = value && typeof value === "object" && "token" in value ? value.token : undefined;
				if (!accessResource.value.claim(token)) {
					response.writeHead(403);
					response.end("Invalid one-time token");
					return;
				}
				const cookie = origin.remote
					? accessResource.value.cookie(origin.port, true)
					: accessResource.value.localCookie(origin.port);
				sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
			},
			// Local sign-in (src/runtime/local-owner.ts): a challenge, then its answer under the owner key.
			[`POST ${LOCAL_CHALLENGE_PATH}`]: (request, response, { origin }) => {
				request.resume();
				if (origin.remote) {
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				if (sameOriginPost(request, response, origin))
					sendJson(response, 200, { challenge: accessResource.value.issueChallenge() });
			},
			[`POST ${LOCAL_CLAIM_PATH}`]: async (request, response, { origin }) => {
				if (origin.remote) {
					request.resume();
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				if (!sameOriginPost(request, response, origin)) return;
				const value = await readJson(request, response);
				if (value === undefined) return;
				const field = (key: string): unknown =>
					value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
				if (!accessResource.value.proveLocal(field("challenge"), field("proof"), origin.port)) {
					response.writeHead(403);
					response.end("Invalid local sign-in");
					return;
				}
				sendJson(response, 200, { ok: true }, { "Set-Cookie": accessResource.value.localCookie(origin.port) });
			},
		});
		return {};
	});
	host.serve(Devices, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Devices is owner-only");
		self.get(DeviceAccess, {});
		const access = nativeOf(self, DeviceAccesses, "The owner access");
		const local = principal.access === "local";
		return {
			variant: "owner",
			members: {
				canMint: constant(local),
				token: async () => {
					if (!local) throw forbidden("Generate owner links on the host with npm run owner-link");
					return { token: access().access.issueToken() };
				},
			},
		};
	});
});
