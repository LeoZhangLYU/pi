import assert from "node:assert/strict";
import { test } from "node:test";
import { http, startFixture } from "./helpers.ts";

test("the sign-in page follows ?lang, the language cookie and Accept-Language", async () => {
	const fixture = await startFixture();
	try {
		const port = fixture.server.port;
		const plain = await http(port, "/owner");
		assert.equal(plain.status, 200);
		assert(plain.body.includes('<html lang="en"'));
		assert(plain.body.includes("Sign in to Pi"));

		const chinese = await http(port, "/owner", { headers: { "Accept-Language": "zh-CN,en;q=0.5" } });
		assert(chinese.body.includes('<html lang="zh-CN"'));
		assert(chinese.body.includes("登录 Pi"));
		assert.equal(chinese.headers["set-cookie"], undefined, "the browser list sets no cookie");

		const switched = await http(port, "/owner?lang=zh-CN");
		assert(switched.body.includes("登录 Pi"));
		assert.match(String(switched.headers["set-cookie"]), /p2_language=zh-CN/);

		const remembered = await http(port, "/owner", {
			headers: { cookie: "p2_language=zh-CN", "Accept-Language": "en-US" },
		});
		assert(remembered.body.includes("登录 Pi"), "the cookie wins over the browser");
		assert(remembered.body.includes("/owner?lang=en"));
		const irrelevant = await http(port, "/owner?lang=not%20a%20tag");
		assert.equal(irrelevant.headers["set-cookie"], undefined);
	} finally {
		await fixture.close();
	}
});

test("the app shell follows the request language", async () => {
	const fixture = await startFixture({ web: true });
	try {
		const english = await http(fixture.server.port, "/", { headers: { Cookie: fixture.owner.cookie } });
		assert.equal(english.status, 200);
		assert(english.body.includes('<html lang="en"'));
		const chinese = await http(fixture.server.port, "/", {
			headers: { Cookie: fixture.owner.cookie, "Accept-Language": "zh-CN" },
		});
		assert(chinese.body.includes('<html lang="zh-CN"'));
	} finally {
		await fixture.close();
	}
});
