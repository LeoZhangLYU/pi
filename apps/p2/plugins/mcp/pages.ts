// The browser pages of MCP sign-ins: a result (signed in, or why not) and the page that finds out whether the browser
// runs on the p2 host before choosing where the sign-in returns. Plain HTML with their own strict CSP.

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Language, MessagesOf, Translator } from "@p2/app/v1";
import type { mcpMessages } from "./messages.ts";

type McpMessages = MessagesOf<typeof mcpMessages>;
type McpTranslator = Translator<"p2.mcp", McpMessages>;

/** A page saying `title`, then `message`. */
export function resultPage(language: Language, title: string, message: string): string {
	return document(language, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** Sends `html` with `status` and a CSP allowing nothing but inline styles (and `extra` directives). */
export function sendPage(response: ServerResponse, status: number, html: string, extra: readonly string[] = []): void {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
			...extra,
		].join("; "),
	});
	response.end(html);
}

/**
 * Sends the page that asks the p2 host's loopback probe at `probeUrl` whether this browser runs there, then continues
 * the sign-in to `server` with `?via=loopback` (it does) or `?via=callback` (it does not, or the browser blocks the
 * request). While the answer takes long (a browser asking the user for local network access), the page offers both.
 */
export function sendProbePage(
	response: ServerResponse,
	server: string,
	probeUrl: string,
	language: Language,
	t: McpTranslator,
): void {
	const nonce = randomBytes(16).toString("base64");
	const heading = t("probeHeading", server);
	const body = `<h1>${escapeHtml(heading)}</h1>
<p id="checking">${escapeHtml(t("checking"))}</p>
<div id="choose" hidden>
<p>${escapeHtml(t("whereRuns"))}</p>
<p><a href="?via=loopback">${escapeHtml(t("onP2"))}</a></p>
<p><a href="?via=callback">${escapeHtml(t("otherDevice"))}</a></p>
</div>
<noscript><p><a href="?via=loopback">${escapeHtml(t("runsOnP2"))}</a></p><p><a href="?via=callback">${escapeHtml(t("runsElsewhere"))}</a></p></noscript>
<script nonce="${nonce}">
let chosen = false;
const go = (via) => { if (!chosen) { chosen = true; location.replace("?via=" + via); } };
for (const link of document.querySelectorAll("#choose a")) link.addEventListener("click", () => { chosen = true; });
const slow = setTimeout(() => { document.getElementById("checking").hidden = true; document.getElementById("choose").hidden = false; }, 1500);
fetch(${JSON.stringify(probeUrl)}, { cache: "no-store" }).then(
	(answer) => { clearTimeout(slow); go(answer.ok ? "loopback" : "callback"); },
	() => { clearTimeout(slow); go("callback"); },
);
</script>`;
	sendPage(response, 200, document(language, heading, body), [
		`script-src 'nonce-${nonce}'`,
		`connect-src ${new URL(probeUrl).origin}`,
	]);
}

function document(language: Language, title: string, body: string): string {
	return `<!doctype html>
<html lang="${escapeHtml(language.locale)}"${language.dir === "rtl" ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#0a58ca}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}a{color:#6ea8fe}}</style>
</head><body>${body}</body></html>`;
}

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);
}
