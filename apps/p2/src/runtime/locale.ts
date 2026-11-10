// The language of pages the server renders without a React host (sign-in, join, MCP result pages, plain-text errors):
// `?lang=` first, then the `p2_language` cookie, then `Accept-Language`, matched against the catalogs p2 offers, else
// English. The React app follows the user's LocaleChoice and the browser on its own (src/web/language.ts).

import type { IncomingMessage } from "node:http";
import { createLanguage, type Language, NO_TRANSLATIONS, resolveLocale } from "@earendil-works/chord";
import { cookieValue } from "./http.ts";
import { LANGUAGE_COOKIE } from "./language-constants.ts";

export { LANGUAGE_COOKIE };
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/** The `?lang=` a request asks for, when it is a language tag. */
export function queryLanguage(request: IncomingMessage): string | undefined {
	const query = new URL(request.url ?? "/", "http://localhost").searchParams.get("lang");
	return query !== null && LANGUAGE_TAG.test(query) ? query : undefined;
}

/** The language a page request asks for: its `?lang=`, else the language cookie. */
export function requestedLanguage(request: IncomingMessage): string | undefined {
	const query = queryLanguage(request);
	if (query !== undefined) return query;
	const cookie = cookieValue(request, LANGUAGE_COOKIE);
	return cookie !== undefined && LANGUAGE_TAG.test(cookie) ? cookie : undefined;
}

/** `Accept-Language`'s tags by descending priority, without `*` and invalid tags. */
export function acceptedLanguages(header: string | undefined): readonly string[] {
	if (header === undefined) return [];
	const weighted: { tag: string; q: number }[] = [];
	for (const part of header.split(",")) {
		const [tag = "", ...parameters] = part.trim().split(";");
		if (tag !== "*" && !LANGUAGE_TAG.test(tag)) continue;
		let q = 1;
		for (const parameter of parameters) {
			const [name, value] = parameter.trim().split("=");
			if (name === "q" && value !== undefined) {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) q = parsed;
			}
		}
		if (tag !== "*") weighted.push({ tag, q });
	}
	return weighted.sort((left, right) => right.q - left.q).map(({ tag }) => tag);
}

/** The language of a page request: its language tag or cookie wins over the browser's list. */
export function requestLanguage(request: IncomingMessage, offered: readonly string[]): Language {
	const pick = requestedLanguage(request) ?? null;
	const locale = resolveLocale(pick, acceptedLanguages(request.headers["accept-language"]), offered);
	return createLanguage(locale, NO_TRANSLATIONS, () => {});
}

/** Remembers the page language for later pages; `?lang=` links call it. */
export function languageCookie(locale: string): string {
	return `${LANGUAGE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** English, for pages rendered without a request (a provider's loopback callback): the source catalog. */
export const ENGLISH: Language = createLanguage("en", NO_TRANSLATIONS, () => {});
