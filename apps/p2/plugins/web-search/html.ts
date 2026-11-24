// Turning fetched HTML into text and result pages into hits, without a parser dependency.

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
		if (name.startsWith("#")) {
			const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

/** The visible text of an HTML document: scripts, styles and comments dropped, block ends as newlines. */
export function htmlToText(html: string): string {
	const withoutHead = html.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	const withoutComments = withoutHead.replace(/<!--[\s\S]*?-->/g, " ");
	const withBreaks = withoutComments
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre|\/blockquote)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(withBreaks)
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export type Hit = { title: string; url: string; snippet: string };

function cleanText(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

/** Bing's result page: `<li class="b_algo">` blocks, each with an `<h2><a href>` and a caption. */
export function parseBing(html: string): Hit[] {
	const hits: Hit[] = [];
	for (const block of html.split(/<li class="b_algo"/i).slice(1)) {
		const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
		if (heading === undefined) continue;
		const link = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(heading);
		if (link === null) continue;
		const caption =
			/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
			/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
			"";
		const url = cleanUrl(link[1] ?? "");
		if (url === "") continue;
		hits.push({ title: cleanText(link[2] ?? ""), url, snippet: cleanText(caption) });
	}
	return hits;
}

/** DuckDuckGo's HTML result page. */
export function parseDuckDuckGo(html: string): Hit[] {
	const hits: Hit[] = [];
	const block =
		/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>|$)/gi;
	for (const match of html.matchAll(block)) {
		const [, rawUrl = "", rawTitle = "", rest = ""] = match;
		const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest)?.[1] ?? "";
		const url = cleanUrl(rawUrl);
		if (url === "") continue;
		hits.push({ title: cleanText(rawTitle), url, snippet: cleanText(snippet) });
	}
	return hits;
}

/** DuckDuckGo's lite page: a table of links and snippets. */
export function parseDuckDuckGoLite(html: string): Hit[] {
	const hits: Hit[] = [];
	for (const row of html.split(/<tr[^>]*>/i)) {
		const link =
			/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(row) ??
			/<a[^>]+class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
		if (link === null) continue;
		const snippet = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1] ?? "";
		const url = cleanUrl(link[1] ?? "");
		if (url === "") continue;
		hits.push({ title: cleanText(link[2] ?? ""), url, snippet: cleanText(snippet) });
	}
	return hits;
}

/** A result href as an absolute http(s) URL, or "": search engines' own links are unwrapped, redirects dropped. */
export function cleanUrl(href: string): string {
	const decoded = decodeEntities(href);
	const target = /[?&]uddg=([^&]+)/.exec(decoded)?.[1] ?? /[?&]u=a1([^&]+)/.exec(decoded)?.[1];
	let url = decoded;
	if (target !== undefined) {
		try {
			url = target.startsWith("a1")
				? Buffer.from(target.slice(2), "base64url").toString("utf8")
				: decodeURIComponent(target);
		} catch {
			url = target;
		}
	}
	if (!/^https?:\/\//i.test(url)) return "";
	try {
		const parsed = new URL(url);
		// Bing's own pages (redirects, cached links) are not results.
		if (/(^|\.)(bing|duckduckgo|microsofttranslator)\.com$/i.test(parsed.hostname)) return "";
		return parsed.href;
	} catch {
		return "";
	}
}
