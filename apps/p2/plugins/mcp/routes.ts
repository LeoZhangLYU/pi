// The browser routes of MCP sign-ins (owners only). `GET /mcp/sign-in/<server>` begins a sign-in and redirects to the
// authorization server: the browser returns to a loopback callback on the p2 host when it runs there, else to `GET
// /mcp/callback` on the origin it reaches p2 through (Radius, a public host). The device owner's browser runs on the
// p2 host; for any other owner a probe page finds out first (`LoopbackProbe`).

import type { IncomingMessage, ServerResponse } from "node:http";
import { type Ctx, isOwner, type StoreSelf } from "@p2/app/v1";
import { type RequestAccess, Routes, requestLanguage } from "@p2/app/v1/server";
import { McpManager } from "./contract.ts";
import { mcpMessages } from "./messages.ts";
import { resultPage, sendPage, sendProbePage } from "./pages.ts";

/** Contributes the sign-in routes. */
export function signInRoutes(self: StoreSelf): void {
	self.contribute(Routes, {
		"GET /mcp/sign-in/*": (request, response, access, ctx) => signIn(request, response, access, ctx),
		"GET /mcp/callback": (request, response, access, ctx) => callback(request, response, access, ctx),
	});
}

/** The path of the callback route on p2's own origin. */
const CALLBACK_PATH = "/mcp/callback";

/** The page's language and its translator: the owner's cookie or the browser's list. */
function translator(request: IncomingMessage) {
	const language = requestLanguage(
		request,
		mcpMessages.translations.map(({ locale }) => locale),
	);
	return { language, t: mcpMessages.in(language) };
}

/**
 * Begins the sign-in to the server the path names. `?via=loopback|callback` is the probe page's answer; without it, the
 * device owner signs in through loopback and any other owner gets the probe page.
 */
async function signIn(
	request: IncomingMessage,
	response: ServerResponse,
	{ principal, origin }: RequestAccess,
	ctx: Ctx,
): Promise<void> {
	const { language, t } = translator(request);
	if (!isOwner(principal)) return refuse(request, response, principal === undefined);
	const url = new URL(request.url ?? "/", "http://localhost");
	let name: string;
	try {
		name = decodeURIComponent(url.pathname.slice("/mcp/sign-in/".length));
	} catch {
		return sendPage(response, 400, resultPage(language, t("unknownServerTitle"), t("malformedLink")));
	}
	const via = url.searchParams.get("via");
	const local = principal.access === "local" && !origin.remote;
	const manager = await ctx.get(McpManager, {});
	if (!local && via !== "loopback" && via !== "callback") {
		const { url: probeUrl } = await manager.probe({ origin: origin.origin }, ctx);
		return sendProbePage(response, name, probeUrl, language, t);
	}
	let start: Awaited<ReturnType<typeof manager.beginSignIn>>;
	try {
		start = await manager.beginSignIn(
			{
				server: name,
				redirect:
					local || via === "loopback"
						? { kind: "loopback" }
						: { kind: "route", url: origin.origin + CALLBACK_PATH },
			},
			ctx,
		);
	} catch (error) {
		return sendPage(response, 502, resultPage(language, t("signInFailedTitle", name), messageOf(error)));
	}
	if (start.kind === "authorized")
		return sendPage(response, 200, resultPage(language, t("signedInTitle", name), t("closePage")));
	response.writeHead(302, { Location: start.url });
	response.end();
}

/** Completes a route sign-in with the authorization response the browser brings back. */
async function callback(
	request: IncomingMessage,
	response: ServerResponse,
	{ principal }: RequestAccess,
	ctx: Ctx,
): Promise<void> {
	const { language, t } = translator(request);
	const params = new URL(request.url ?? "/", "http://localhost").searchParams;
	if (!isOwner(principal))
		return sendPage(
			response,
			principal === undefined ? 401 : 403,
			resultPage(language, t("notFinishedTitle"), t("notSignedInHere")),
		);
	const state = params.get("state");
	if (state === null) return sendPage(response, 400, resultPage(language, t("notFinishedTitle"), t("noState")));
	const [code, iss, error] = [params.get("code"), params.get("iss"), params.get("error")];
	try {
		const { server } = await (await ctx.get(McpManager, {})).completeSignIn(
			{
				state,
				...(code === null ? {} : { code }),
				...(iss === null ? {} : { iss }),
				...(error === null ? {} : { error: params.get("error_description") ?? error }),
			},
			ctx,
		);
		sendPage(response, 200, resultPage(language, t("signedInTitle", server), t("closePage")));
	} catch (failure) {
		sendPage(response, 400, resultPage(language, t("failedTitle"), messageOf(failure)));
	}
}

/** People without a sign-in get no sign-in. */
function refuse(request: IncomingMessage, response: ServerResponse, anonymous: boolean): void {
	const { language, t } = translator(request);
	sendPage(response, anonymous ? 401 : 403, resultPage(language, t("notSignedInTitle"), t("ownerOnly")));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
