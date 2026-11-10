// Server-rendered pages (join, owner sign-in, ended share, UI-less server) use the
// app's visual language: the tokens of src/web/style.css, thin separators, an
// underlined input, one outline button and the canonical colored Pi logo.
// Without a script they follow the system scheme; with a nonce they also apply
// the browser's sidebar theme choice (src/web/theme.ts, same origin storage).

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

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
.error{color:var(--bad)}`;

// Same geometry and colours as src/web/PiLogo.tsx (canonical startup logo).
const LOGO = `<svg viewBox="0 0 4 4" role="img" aria-label="Pi"><rect fill="rgb(228 138 122)" width="3" height="1"/><rect fill="rgb(228 138 122)" x="2" y="1" width="1" height="1"/><rect fill="rgb(79 142 179)" y="1" width="1" height="3"/><rect fill="rgb(79 142 179)" x="1" y="2" width="1" height="1"/><rect fill="rgb(234 182 93)" x="3" y="2" width="1" height="2"/></svg>`;

const THEME = `try{const t=localStorage.getItem("pi-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;

const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** `heading` is escaped; `body` and `script` are trusted markup written by the server. */
export function page({
	title,
	heading,
	body,
	script,
	nonce,
}: {
	title: string;
	heading: string;
	body: string;
	script?: string;
	nonce?: string;
}): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${STYLE}</style>${nonce ? `<script nonce="${nonce}">${THEME}</script>` : ""}</head><body><main><header>${LOGO}<h1>${escapeHtml(heading)}</h1></header>${body}</main>${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
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
	let intro = `<p>No owner password is configured yet. Sign in with a recovery token, or run <span class="mono">npm run set-password</span> on the host (or start it with <span class="mono">P2_PASSWORD</span>) to create one.</p>`;
	if (configured) intro = `<p>Sign in with the owner account for this server.</p>`;
	else if (options.account === "invalid")
		intro = `<p>Password sign-in is unavailable: the owner account file cannot be read. Sign in with a recovery token, or fix <span class="mono">owner-account.json</span> in the data directory on the host.</p>`;
	const passwordForm = configured
		? `<form id="sign-in"><label for="username">Username</label><input id="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><button id="submit" type="submit">Sign in</button></form>`
		: "";
	const recovery = `<form id="recovery"><label for="token">Recovery token</label><input id="token" class="mono" type="password" autocomplete="off" spellcheck="false"${configured ? "" : " required autofocus"}><button id="recovery-submit" type="submit">Sign in</button></form>
<p class="small">A recovery token is printed when the server starts; <span class="mono">npm run owner-link</span> on the host creates a link to one. It expires after ten minutes and works once.</p>`;
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	});
	response.end(
		request.method === "HEAD"
			? undefined
			: page({
					title: "Pi · Sign in",
					heading: "Sign in to Pi",
					nonce,
					body: `${intro}
${passwordForm}
${configured ? `<details><summary class="small">Use a recovery token</summary>${recovery}</details>` : recovery}
<p id="status" role="status"></p><p class="small">This grants full owner access, including shell commands. A sign-in lasts 30 days and renews while you use it.</p>`,
					script: `${options.reload ? "if(!location.hash)location.replace(location.href);" : ""}const status=document.getElementById("status");
const fail=(message)=>{status.className="error";status.textContent=message;};
async function post(path,body){const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});let data={};try{data=await response.json();}catch{data={};}if(!response.ok)throw new Error(data.error||"Sign-in failed. Try again.");}
const signIn=document.getElementById("sign-in");
if(signIn){const username=document.getElementById("username"),password=document.getElementById("password"),submit=document.getElementById("submit");signIn.onsubmit=(event)=>{event.preventDefault();submit.disabled=true;status.className="";status.textContent="Signing in…";post("/owner/login",{username:username.value,password:password.value}).then(()=>location.replace("/")).catch((error)=>{fail(error.message);password.value="";submit.disabled=false;});};}
const recovery=document.getElementById("recovery"),token=document.getElementById("token"),recoverySubmit=document.getElementById("recovery-submit");
if(recovery)recovery.onsubmit=(event)=>{event.preventDefault();recoverySubmit.disabled=true;status.className="";status.textContent="Signing in…";post("/owner/claim",{token:token.value.trim()}).then(()=>location.replace("/")).catch(()=>{fail("Invalid, expired or already-used link. Generate a fresh owner link on the host.");token.value="";recoverySubmit.disabled=false;});};
if(location.hash){const fragment=location.hash.slice(1);history.replaceState(null,"","/owner");try{post("/owner/claim",{token:decodeURIComponent(fragment)}).then(()=>location.replace("/")).catch(()=>fail("Invalid owner link."));}catch{fail("Invalid owner link.");}}`,
				}),
	);
}
