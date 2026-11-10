import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { mcpMessages } from "../../plugins/mcp/messages.ts";
import { sharingMessages } from "../../plugins/sharing/messages.ts";
import { coreMessages } from "../../src/runtime/core-messages.ts";
import { acceptedLanguages, queryLanguage, requestLanguage } from "../../src/runtime/locale.ts";
import { pageMessages } from "../../src/runtime/page-messages.ts";
import { webMessages } from "../../src/web/messages.ts";

const OFFERED = pageMessages.translations.map(({ locale }) => locale);
const request = (url: string, headers: Record<string, string> = {}): IncomingMessage =>
	({ url, headers }) as IncomingMessage;

test("Accept-Language parses by q, drops stars and invalid tags", () => {
	assert.deepEqual(acceptedLanguages("zh-CN,zh;q=0.9,en;q=0.8"), ["zh-CN", "zh", "en"]);
	assert.deepEqual(acceptedLanguages("en;q=0.2, fr;q=0.9"), ["fr", "en"]);
	assert.deepEqual(acceptedLanguages("*"), []);
	assert.deepEqual(acceptedLanguages("not a tag, en"), ["en"]);
	assert.deepEqual(acceptedLanguages(undefined), []);
});

test("the query language wins over the cookie, both over the browser", () => {
	assert.equal(queryLanguage(request("/owner?lang=zh-CN")), "zh-CN");
	assert.equal(queryLanguage(request("/owner?lang=not a tag")), undefined);
	assert.equal(requestLanguage(request("/owner?lang=en", { cookie: "p2_language=zh-CN" }), OFFERED).locale, "en");
	assert.equal(requestLanguage(request("/owner", { cookie: "p2_language=zh-CN" }), OFFERED).locale, "zh-CN");
	assert.equal(requestLanguage(request("/owner", { "accept-language": "zh-CN,en;q=0.5" }), OFFERED).locale, "zh-CN");
	assert.equal(requestLanguage(request("/owner", { "accept-language": "en-US" }), OFFERED).locale, "en");
});

test("related languages match, unknown ones fall back to English", () => {
	assert.equal(requestLanguage(request("/owner", { "accept-language": "zh-TW" }), OFFERED).locale, "zh-CN");
	assert.equal(requestLanguage(request("/owner", { "accept-language": "de-DE" }), OFFERED).locale, "en");
	assert.equal(requestLanguage(request("/owner"), OFFERED).locale, "en");
});

test("every catalog has the same keys and value types in English and Chinese", () => {
	for (const [name, messages] of [
		["p2.core", coreMessages],
		["p2.page", pageMessages],
		["p2.web", webMessages],
		["p2.sharing", sharingMessages],
		["p2.mcp", mcpMessages],
	] as const) {
		const catalogs = new Map(messages.translations.map(({ locale, messages: catalog }) => [locale, catalog]));
		const en = catalogs.get("en");
		const zh = catalogs.get("zh-CN");
		assert(en && zh, `${name} needs en and zh-CN`);
		assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), `${name} key parity`);
		for (const key of Object.keys(en)) {
			assert.equal(typeof zh[key], typeof en[key], `${name}.${key} value type`);
			assert.notEqual(zh[key], "", `${name}.${key} has a Chinese value`);
		}
	}
});
