// The `web_search` and `web_fetch` tools: internet access for an agent, without a provider key.
// Search goes through DuckDuckGo's HTML endpoints; fetch reads one URL and returns text or a truncated body.

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { type Hit, htmlToText, parseBing, parseDuckDuckGo, parseDuckDuckGoLite } from "./html.ts";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** How much of a fetched body is returned, in characters. */
const MAX_TEXT = 40_000;
/** How many bytes of a body are read before giving up. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

export const SEARCH_DESCRIPTION = [
	"Search the web. Returns up to `count` results as title, URL and snippet.",
	"Use it to find sources, then read one with web_fetch. Prefer specific queries; one or two searches beat many.",
].join(" ");

export const FETCH_DESCRIPTION = [
	"Fetch one URL over HTTPS and return it as text.",
	"HTML is reduced to its visible text; JSON, XML and plain text are returned as they are, truncated to about 40000 characters.",
	"Use it after web_search to read a source.",
].join(" ");

async function request(url: string, init: { method?: string; body?: string; accept?: string } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: init.method ?? "GET",
			redirect: "follow",
			signal: controller.signal,
			headers: {
				"user-agent": USER_AGENT,
				accept: init.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
				"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
				...(init.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
			},
			...(init.body === undefined ? {} : { body: init.body }),
		});
	} finally {
		clearTimeout(timer);
	}
}

/** Bytes of a body, at most MAX_BYTES. */
async function readCapped(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (reader === undefined) return { bytes: new Uint8Array(await response.arrayBuffer()), truncated: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
		if (total >= MAX_BYTES) {
			await reader.cancel();
			break;
		}
	}
	const bytes = new Uint8Array(Math.min(total, MAX_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.length, bytes.length - offset);
		bytes.set(chunk.subarray(0, take), offset);
		offset += take;
		if (offset >= bytes.length) break;
	}
	return { bytes, truncated: total >= MAX_BYTES };
}

function decode(bytes: Uint8Array, contentType: string): string {
	const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
	try {
		return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

async function search(query: string, count: number): Promise<Hit[]> {
	// DuckDuckGo first (no tracking, stable markup); Bing's cn host as the fallback where DDG is unreachable.
	const attempts: Array<() => Promise<Hit[]>> = [
		async () => {
			const response = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parseDuckDuckGo(decode((await readCapped(response)).bytes, response.headers.get("content-type") ?? ""));
		},
		async () => {
			const response = await request("https://lite.duckduckgo.com/lite/", {
				method: "POST",
				body: `q=${encodeURIComponent(query)}`,
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parseDuckDuckGoLite(
				decode((await readCapped(response)).bytes, response.headers.get("content-type") ?? ""),
			);
		},
		async () => {
			const response = await request(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parseBing(decode((await readCapped(response)).bytes, response.headers.get("content-type") ?? ""));
		},
	];
	const failures: string[] = [];
	for (const attempt of attempts) {
		try {
			const hits = await attempt();
			if (hits.length > 0) return hits.slice(0, count);
			failures.push("no results");
		} catch (error) {
			failures.push(messageOf(error));
		}
	}
	if (failures.every((failure) => failure === "no results")) return [];
	throw new Error(`every search backend failed (${failures.join("; ")})`);
}

export const searchTool = defineTool({
	name: "web_search",
	description: SEARCH_DESCRIPTION,
	parameters: obj({
		query: str({ minLength: 1, maxLength: 500, description: "The search query." }),
		count: opt(num({ description: "How many results (default 8, at most 20)." })),
	}),
	replay: "safe",
	execute: async (args: { query: string; count?: number }) => {
		const count = Math.min(Math.max(Math.trunc(args.count ?? 8), 1), 20);
		try {
			const hits = await search(args.query, count);
			if (hits.length === 0) {
				return { output: [{ type: "text" as const, text: `No results for "${args.query}".` }], isError: false };
			}
			const text = hits
				.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
				.join("\n\n");
			return { output: [{ type: "text" as const, text }] };
		} catch (error) {
			return {
				output: [{ type: "text" as const, text: `Search failed: ${messageOf(error)}` }],
				isError: true,
			};
		}
	},
});

export const fetchTool = defineTool({
	name: "web_fetch",
	description: FETCH_DESCRIPTION,
	parameters: obj({
		url: str({ minLength: 1, maxLength: 4000, description: "An http or https URL." }),
		raw: opt(bool({ description: "Return the body as it arrives (HTML not reduced to text)." })),
	}),
	replay: "safe",
	execute: async (args: { url: string; raw?: boolean }) => {
		let url: URL;
		try {
			url = new URL(args.url);
		} catch {
			return { output: [{ type: "text" as const, text: `Not a URL: ${args.url}` }], isError: true };
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return {
				output: [{ type: "text" as const, text: `Only http and https are fetched: ${url.protocol}` }],
				isError: true,
			};
		}
		try {
			const response = await request(url.href);
			const contentType = response.headers.get("content-type") ?? "";
			const { bytes, truncated } = await readCapped(response);
			const body = decode(bytes, contentType);
			const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*</.test(body.slice(0, 200));
			const text = args.raw === true || !isHtml ? body : htmlToText(body);
			const cut = text.length > MAX_TEXT;
			const header = `# ${url.href}\nHTTP ${response.status} · ${contentType || "unknown type"} · ${bytes.length} bytes${truncated || cut ? " (truncated)" : ""}\n\n`;
			return { output: [{ type: "text" as const, text: header + (cut ? text.slice(0, MAX_TEXT) : text) }] };
		} catch (error) {
			return {
				output: [{ type: "text" as const, text: `Fetch failed: ${messageOf(error)}` }],
				isError: true,
			};
		}
	},
});

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.name === "AbortError" ? "timed out" : error.message;
	return String(error);
}

export const webExtension = defineExtension({
	name: "p2-web",
	tools: [searchTool, fetchTool],
});
