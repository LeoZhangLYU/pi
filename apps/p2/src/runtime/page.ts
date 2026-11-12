// Server-rendered pages (owner sign-in, UI-less server) use the
// app's visual language: the tokens of src/web/style.css, thin separators, an
// underlined input, one outline button and the canonical colored Pi logo.
// Without a script they follow the system scheme; with a nonce they also apply
// the browser's sidebar theme choice (src/web/theme.ts, same origin storage).

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Language } from "@earendil-works/chord";
import { languageCookie, queryLanguage, requestLanguage } from "./locale.ts";
import { pageMessages } from "./page-messages.ts";

const STYLE = `:root{color-scheme:light dark;--bg:#fbfaf8;--text:#1d1b19;--muted:#77716a;--line:#e7e4df;--hover:#f1eee9;--bad:#c8433d;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#151413;--text:#ecebe8;--muted:#9b958d;--line:#2c2a27;--hover:#22201e;--bad:#f07a72}}
:root[data-theme=dark]{color-scheme:dark;--bg:#151413;--text:#ecebe8;--muted:#9b958d;--line:#2c2a27;--hover:#22201e;--bad:#f07a72}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}body{margin:0}
main{display:flex;flex-direction:column;gap:16px;max-width:440px;margin:0 auto;padding:12vh 16px 24px}
header{display:flex;align-items:center;gap:12px}
header svg{flex:none;width:32px;height:32px;shape-rendering:crispEdges}
h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}
p{margin:0;color:var(--muted);font-size:15px}
.small{font-size:13px}
form{display:flex;flex-direction:column;gap:12px}
label{margin-bottom:-8px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
input{width:100%;height:44px;padding:0;border:0;border-bottom:1px solid var(--line);border-radius:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:15px}
input:focus{border-bottom-color:var(--text)}
.mono{font-family:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,monospace}
button{align-self:flex-start;min-height:40px;padding:0 16px;border:1px solid var(--text);border-radius:4px;background:transparent;color:var(--text);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
button:hover{background:var(--hover)}button:disabled{opacity:.45;cursor:default}
:focus-visible{outline:1px solid var(--text);outline-offset:2px}
.error{color:var(--bad)}
.languages{display:flex;gap:14px;margin-top:4px;font-size:13px;color:var(--muted)}
.languages a{color:inherit;text-decoration:none}.languages a:hover{color:var(--text)}
.languages [aria-current]{color:var(--text);font-weight:600}`;

// Same geometry and colours as src/web/PiLogo.tsx (canonical startup logo).
const LOGO = `<svg viewBox="0 0 4 4" role="img" aria-label="Pi"><rect fill="rgb(228 138 122)" width="3" height="1"/><rect fill="rgb(228 138 122)" x="2" y="1" width="1" height="1"/><rect fill="rgb(79 142 179)" y="1" width="1" height="3"/><rect fill="rgb(79 142 179)" x="1" y="2" width="1" height="1"/><rect fill="rgb(234 182 93)" x="3" y="2" width="1" height="2"/></svg>`;

const THEME = `try{const t=localStorage.getItem("pi-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;

const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export { escapeHtml };

/** The language links for `request`'s own path, keeping its query and setting `lang`. */
export function languageLinks(
	request: IncomingMessage,
	language: Language,
	offered: readonly string[],
): LanguageLink[] {
	const url = new URL(request.url ?? "/", "http://localhost");
	return offered.map((locale) => {
		const link = new URL(url);
		link.searchParams.set("lang", locale);
		return {
			tag: locale,
			label: locale === "en" ? "English" : locale.startsWith("zh") ? "简体中文" : locale,
			href: `${link.pathname}${link.search}`,
			current: language.locale === locale,
		};
	});
}

/** A language the page offers, with its link (the page marks the current one). */
export type LanguageLink = {
	readonly tag: string;
	readonly label: string;
	readonly href: string;
	readonly current: boolean;
};

/** `heading` is escaped; `body` and `script` are trusted markup written by the server. */
export function page({
	title,
	heading,
	body,
	script,
	nonce,
	language,
	languages,
}: {
	title: string;
	heading: string;
	body: string;
	script?: string;
	nonce?: string;
	language?: Language;
	languages?: readonly LanguageLink[];
}): string {
	const nav = languages?.length
		? `<nav class="languages" aria-label="Language">${languages
				.map((link) =>
					link.current
						? `<span aria-current="true">${escapeHtml(link.label)}</span>`
						: `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
				)
				.join("")}</nav>`
		: "";
	return `<!doctype html><html lang="${escapeHtml(language?.locale ?? "en")}"${language?.dir === "rtl" ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${STYLE}</style>${nonce ? `<script nonce="${nonce}">${THEME}</script>` : ""}</head><body><main><header>${LOGO}<h1>${escapeHtml(heading)}</h1></header>${body}${nav}</main>${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

/** What the sign-in page should show: whether an owner password exists, or why it cannot be used. */
export type SignInState = { readonly account?: "configured" | "absent" | "invalid" };

export type SignInOptions = SignInState & { readonly reload?: boolean };

/**
 * Public, credential-free landing page. Sign-in is a same-origin POST (`/owner/login` for the password, `/owner/claim`
 * for a recovery token); the page never contains a secret. Without a configured password it shows the recovery form
 * only. `reload`: load the page once more from this origin first (a navigation from another site may have arrived
 * without the owner's cookie); that load is same-origin, so it never reloads again.
 */
export function signIn(
	request: IncomingMessage,
	response: ServerResponse,
	status = 200,
	options: SignInOptions = {},
): void {
	const nonce = randomBytes(18).toString("base64url");
	const configured = options.account === "configured";
	const language = requestLanguage(
		request,
		pageMessages.translations.map(({ locale }) => locale),
	);
	const t = pageMessages.in(language);
	let intro = `<p>${escapeHtml(t("introAbsent"))}</p>`;
	if (configured) intro = `<p>${escapeHtml(t("introConfigured"))}</p>`;
	else if (options.account === "invalid") intro = `<p>${escapeHtml(t("introInvalid"))}</p>`;
	const passwordForm = configured
		? `<form id="sign-in"><label for="username">${escapeHtml(t("username"))}</label><input id="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus><label for="password">${escapeHtml(t("password"))}</label><input id="password" type="password" autocomplete="current-password" required><button id="submit" type="submit">${escapeHtml(t("signIn"))}</button></form>`
		: "";
	const recovery = `<form id="recovery"><label for="token">${escapeHtml(t("recoveryToken"))}</label><input id="token" class="mono" type="password" autocomplete="off" spellcheck="false"${configured ? "" : " required autofocus"}><button id="recovery-submit" type="submit">${escapeHtml(t("signIn"))}</button></form>
<p class="small">${escapeHtml(t("recoveryHint"))}</p>`;
	// The language links always target the sign-in page itself: the fallback page is also served for other paths (a
	// session URL, say), whose path must not be echoed to the visitor.
	const languages = pageMessages.translations.map(({ locale }) => ({
		tag: locale,
		label: locale === "en" ? "English" : locale.startsWith("zh") ? "简体中文" : locale,
		href: `/owner?lang=${locale}`,
		current: language.locale === locale,
	}));
	const headers: Record<string, string> = {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	};
	if (queryLanguage(request) !== undefined) headers["Set-Cookie"] = languageCookie(language.locale);
	const texts = JSON.stringify({
		signingIn: t("signingIn"),
		failed: t("signInFailed"),
		invalidLink: t("invalidLink"),
		invalidOwnerLink: t("invalidOwnerLink"),
	});
	response.writeHead(status, headers);
	response.end(
		request.method === "HEAD"
			? undefined
			: page({
					title: t("title"),
					heading: t("heading"),
					nonce,
					language,
					languages,
					body: `${intro}
${passwordForm}
${configured ? `<details><summary class="small">${escapeHtml(t("recoveryToken"))}</summary>${recovery}</details>` : recovery}
<p id="status" role="status"></p><p class="small">${escapeHtml(t("grantNote"))}</p>`,
					script: `${options.reload ? "if(!location.hash)location.replace(location.href);" : ""}const text=${texts};
const status=document.getElementById("status");
const fail=(message)=>{status.className="error";status.textContent=message;};
async function post(path,body){const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});let data={};try{data=await response.json();}catch{data={};}if(!response.ok)throw new Error(data.error||text.failed);}
const signIn=document.getElementById("sign-in");
if(signIn){const username=document.getElementById("username"),password=document.getElementById("password"),submit=document.getElementById("submit");signIn.onsubmit=(event)=>{event.preventDefault();submit.disabled=true;status.className="";status.textContent=text.signingIn;post("/owner/login",{username:username.value,password:password.value}).then(()=>location.replace("/")).catch((error)=>{fail(error.message);password.value="";submit.disabled=false;});};}
const recovery=document.getElementById("recovery"),token=document.getElementById("token"),recoverySubmit=document.getElementById("recovery-submit");
if(recovery)recovery.onsubmit=(event)=>{event.preventDefault();recoverySubmit.disabled=true;status.className="";status.textContent=text.signingIn;post("/owner/claim",{token:token.value.trim()}).then(()=>location.replace("/")).catch(()=>{fail(text.invalidLink);token.value="";recoverySubmit.disabled=false;});};
if(location.hash){const fragment=location.hash.slice(1);history.replaceState(null,"","/owner");try{post("/owner/claim",{token:decodeURIComponent(fragment)}).then(()=>location.replace("/")).catch(()=>fail(text.invalidOwnerLink));}catch{fail(text.invalidOwnerLink);}}`,
				}),
	);
}
