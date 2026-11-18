// This build keeps one session: `/` opens it, from a fresh tab and after a long break alike (the chat's Main redirects
// once the catalog is known). The new-session screen is only for a server with no session at all.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

describe("entering the one session", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("opens the session from / in a fresh tab and after a long break", async () => {
		const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title: "Where I was" },
			BACKGROUND_CONTEXT,
		);
		const url = (path: string) => `http://127.0.0.1:${fixture.server.port}${path}`;
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);

		// A launch at / enters it.
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);

		// A fresh tab (not the installed app) enters it too.
		await browser.evaluate(`sessionStorage.setItem("tab", "1")`);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);

		// The remembered "last conversation" no longer matters: one session is the entry.
		await browser.open(url("/health"));
		await browser.evaluate(
			`localStorage.setItem("p2-last-conversation", JSON.stringify({ session: ${JSON.stringify(session.id)}, conversation: 1, at: Date.now() - 3 * 3600 * 1000 }))`,
		);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);
		assert.equal(await browser.evaluate<string>("location.pathname"), `/s/${session.id}`);
	});
});
