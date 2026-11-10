// The web page's language: the host follows the user's LocaleChoice, else the browser's languages, seeded with the
// last choice kept in localStorage and the language cookie so the first render already matches it.

import { followActiveLanguage, hostLanguage, type Language } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Host } from "../runtime/chord.ts";
import { LANGUAGE_COOKIE, LANGUAGE_STORAGE } from "../runtime/language-constants.ts";

/** The device's languages, the last choice first: a cookie set on the sign-in page wins over the browser's list. */
function preferredLanguages(): readonly string[] {
	const stored = localStorage.getItem(LANGUAGE_STORAGE);
	const cookie = document.cookie
		.split("; ")
		.map((part) => part.split("="))
		.find(([name]) => name === LANGUAGE_COOKIE)?.[1];
	return [stored, cookie, ...navigator.languages].filter((value): value is string => !!value);
}

/** Follows the active language for `host`'s life, updating the document's `lang` and `dir` as it changes. */
export async function startLanguage(host: Host): Promise<() => void> {
	const follower = await followActiveLanguage(
		host,
		preferredLanguages(),
		(language: Language) => {
			document.documentElement.lang = language.locale;
			document.documentElement.dir = language.dir;
		},
		() => {},
		BACKGROUND_CONTEXT,
	);
	return () => follower.stop();
}

/** The page's current locale, for Intl formatting; `undefined` before the follower set a language. */
export function currentLocale(host: Host): string | undefined {
	return hostLanguage(host).read()?.locale;
}

/** Remembers a choice (or, with null, follows the device); the server's LocaleChoice is written separately. */
export function rememberLanguage(locale: string | null): void {
	if (locale === null) {
		localStorage.removeItem(LANGUAGE_STORAGE);
		setLanguageCookie("", 0);
		return;
	}
	localStorage.setItem(LANGUAGE_STORAGE, locale);
	setLanguageCookie(encodeURIComponent(locale), 31536000);
}

function setLanguageCookie(value: string, maxAge: number): void {
	// The Cookie Store API is not available in every browser p2 supports, and the cookie carries the language from the
	// browser app to the server-rendered pages.
	// biome-ignore lint/suspicious/noDocumentCookie: see above.
	document.cookie = `${LANGUAGE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
