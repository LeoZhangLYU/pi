import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, constant } from "@p2/app/v1";
import { Server } from "@p2/app/v1/server";
import { openResources, summarize } from "../../plugins/models/config.ts";
import { CustomProviders } from "../../plugins/models/contract.ts";
import {
	addCustomProvider,
	customProviderView,
	discoverModels,
	normalizeCustomProvider,
	providerIdFrom,
	removeCustomProvider,
	sanitizeProviderId,
	updateCustomProvider,
} from "../../plugins/models/custom-providers.ts";
import { parseModelsDocument } from "../../plugins/models/model-config.ts";
import modelsServer from "../../plugins/models/server.ts";
import { APP, holdIn, testHost, until } from "./helpers.ts";

const input = {
	id: "relay",
	name: "Relay",
	baseUrl: "https://relay.example.com/v1/",
	api: "openai-completions",
	models: [{ id: "m1" }, { id: "m2", name: "Model Two" }],
};

test("normalizes custom provider input", () => {
	const provider = normalizeCustomProvider({
		...input,
		models: [{ id: " m1 " }, { id: "m1" }, { id: "m2", name: "M2" }],
	});
	assert.deepEqual(provider, {
		id: "relay",
		name: "Relay",
		baseUrl: "https://relay.example.com/v1",
		api: "openai-completions",
		models: [{ id: "m1" }, { id: "m2", name: "M2" }],
	});
	assert.throws(() => normalizeCustomProvider({ ...input, id: "Bad ID" }), /Provider ID/);
	assert.throws(() => normalizeCustomProvider({ ...input, baseUrl: "ftp://x" }), /http\(s\)/);
	assert.throws(() => normalizeCustomProvider({ ...input, api: "made-up" }), /Unsupported API/);
	assert.throws(() => normalizeCustomProvider({ ...input, models: [] }), /at least one model/);
});

test("adds, updates and removes a provider, keeping the rest of models.json", () => {
	const doc = parseModelsDocument(
		JSON.stringify({
			$schema: "https://pi.dev/schemas/models.schema.json",
			providers: {
				anthropic: { baseUrl: "https://proxy.example.com" },
				relay: {
					baseUrl: "https://old.example.com",
					api: "anthropic-messages",
					headers: { "x-trace": "1" },
					models: [{ id: "old" }],
				},
			},
		}),
	);
	assert.throws(
		() => addCustomProvider(doc, normalizeCustomProvider({ ...input, id: "anthropic" }), new Set(["anthropic"])),
		/built-in/,
	);
	assert.throws(() => addCustomProvider(doc, normalizeCustomProvider(input), new Set()), /exists/);

	updateCustomProvider(doc, "relay", normalizeCustomProvider({ ...input, name: undefined }));
	assert.equal(doc.providers.anthropic?.baseUrl, "https://proxy.example.com");
	assert.deepEqual(doc.providers.relay?.headers, { "x-trace": "1" });
	assert.equal(doc.providers.relay?.baseUrl, "https://relay.example.com/v1");
	assert.deepEqual(
		doc.providers.relay?.models?.map((model) => model.id),
		["m1", "m2"],
	);
	assert.equal(doc.$schema, "https://pi.dev/schemas/models.schema.json");

	addCustomProvider(doc, normalizeCustomProvider({ ...input, id: "second" }), new Set(["anthropic"]));
	assert.ok(doc.providers.second);
	removeCustomProvider(doc, "second");
	assert.equal(doc.providers.second, undefined);
	assert.throws(() => removeCustomProvider(doc, "second"), /not defined/);
});

test("a view never carries the API key, and skips entries that are not plain custom providers", () => {
	const view = customProviderView("relay", {
		name: "Relay",
		baseUrl: "https://relay.example.com",
		api: "openai-completions",
		apiKey: "!cat ~/.config/relay",
		models: [{ id: "m1" }],
	});
	assert.deepEqual(view, {
		id: "relay",
		name: "Relay",
		baseUrl: "https://relay.example.com",
		api: "openai-completions",
		models: [{ id: "m1" }],
	});
	assert.equal(customProviderView("oauth", { oauth: "radius", models: [] }), undefined);
	assert.equal(customProviderView("override", { modelOverrides: {} }), undefined);
});

async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
	base: string;
	close: () => Promise<void>;
	requests: { url?: string; headers: IncomingMessage["headers"] }[];
}> {
	const requests: { url?: string; headers: IncomingMessage["headers"] }[] = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url, headers: request.headers });
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return {
		base: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

test("discovers models from OpenAI-, Anthropic- and Google-shaped endpoints", async () => {
	const openai = await endpoint((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "gpt-a", name: "GPT A" }, { id: "gpt-b" }] }));
	});
	const anthropic = await endpoint((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "claude-a" }] }));
	});
	const google = await endpoint((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ models: [{ name: "models/gemini-a", displayName: "Gemini A" }] }));
	});
	try {
		assert.deepEqual(
			await discoverModels({ baseUrl: `${openai.base}/v1`, api: "openai-completions", apiKey: "sk-test" }),
			[{ id: "gpt-a", name: "GPT A" }, { id: "gpt-b" }],
		);
		assert.equal(openai.requests[0]?.url, "/v1/models");
		assert.equal(openai.requests[0]?.headers.authorization, "Bearer sk-test");

		assert.deepEqual(await discoverModels({ baseUrl: anthropic.base, api: "anthropic-messages", apiKey: "ak" }), [
			{ id: "claude-a" },
		]);
		assert.equal(anthropic.requests[0]?.url, "/v1/models");
		assert.equal(anthropic.requests[0]?.headers["x-api-key"], "ak");

		assert.deepEqual(await discoverModels({ baseUrl: google.base, api: "google-generative-ai", apiKey: "gk" }), [
			{ id: "gemini-a", name: "Gemini A" },
		]);
		assert.match(google.requests[0]?.url ?? "", /^\/models\?key=gk/);
	} finally {
		await Promise.all([openai.close(), anthropic.close(), google.close()]);
	}
});

test("discovery reports HTTP errors, non-JSON answers and oversized lists", async () => {
	const failing = await endpoint((_request, response) => {
		response.statusCode = 404;
		response.end("no");
	});
	const notJson = await endpoint((_request, response) => response.end("<html>"));
	try {
		await assert.rejects(discoverModels({ baseUrl: failing.base, api: "openai-completions" }), /HTTP 404/);
		await assert.rejects(discoverModels({ baseUrl: notJson.base, api: "openai-completions" }), /JSON/);
		const huge = {
			headers: new Headers({ "content-length": String(3 * 1024 * 1024) }),
			ok: true,
			status: 200,
			text: async () => "{}",
		} as unknown as Response;
		await assert.rejects(
			discoverModels({ baseUrl: "https://relay.example.com", api: "openai-completions" }, async () => huge),
			/too large/,
		);
	} finally {
		await Promise.all([failing.close(), notJson.close()]);
	}
});

test("resources publish custom providers and count models.json keys as signed in", async () => {
	const dir = mkdtempSync(join(tmpdir(), "p2-custom-providers-"));
	const modelsPath = join(dir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			$schema: "https://pi.dev/schemas/models.schema.json",
			providers: {
				relay: {
					name: "Relay",
					baseUrl: "https://relay.example.com",
					api: "anthropic-messages",
					apiKey: "!cat ~/.config/relay",
					models: [{ id: "relay-model", name: "Relay Model" }],
				},
			},
		}),
	);
	const resources = await openResources(dir, false);
	try {
		const snapshot = resources.snapshot();
		assert.deepEqual(snapshot.customProviders, [
			{
				id: "relay",
				name: "Relay",
				baseUrl: "https://relay.example.com",
				api: "anthropic-messages",
				models: [{ id: "relay-model", name: "Relay Model" }],
			},
		]);
		assert.deepEqual(snapshot.configuredProviders, ["relay"]);
		assert.deepEqual(
			summarize(resources, false).models.map((model) => `${model.provider}/${model.modelId}`),
			["relay/relay-model"],
		);

		await resources.writeModels((doc) => {
			addCustomProvider(doc, normalizeCustomProvider({ ...input, id: "added" }), new Set(["anthropic"]));
		});
		const written = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown> & {
			providers: Record<string, Record<string, unknown>>;
		};
		assert.equal(written.$schema, "https://pi.dev/schemas/models.schema.json");
		assert.ok(written.providers.relay);
		assert.ok(written.providers.added);
		assert.equal(written.providers.added?.apiKey, undefined);
	} finally {
		resources.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the owner's contract adds, edits and removes a provider on disk", async () => {
	const dir = mkdtempSync(join(tmpdir(), "p2-custom-contract-"));
	const fixture = await testHost({
		facets: [modelsServer],
		stubs: [
			[
				Server,
				{
					info: constant({ app: APP, dataDir: dir, fake: false, allowedHosts: [], port: 0 }),
					revokeOwners: () => {},
					revokeGuests: () => {},
				},
			],
		],
	});
	try {
		const owner = fixture.client({ kind: "owner", access: "local" });
		const providers = await holdIn(owner, CustomProviders, {}, "owner");
		await providers.add({ provider: input, apiKey: "sk-test" }, BACKGROUND_CONTEXT);
		const added = (
			await until(providers.providers, (rows) => rows.some((row) => row.id === "relay" && row.storedKey))
		).find((row) => row.id === "relay");
		assert.equal(added?.baseUrl, "https://relay.example.com/v1");
		assert.equal(added?.storedKey, true);
		assert.equal(added?.configuredKey, false);

		const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		assert.equal(models.providers.relay?.apiKey, undefined);
		const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Record<
			string,
			{ type: string; key: string }
		>;
		assert.equal(auth.relay?.type, "api_key");
		assert.equal(auth.relay?.key, "sk-test");

		await providers.update(
			{
				provider: { ...input, baseUrl: "https://new.example.com/v1", models: [{ id: "m3" }] },
				clearKey: true,
			},
			BACKGROUND_CONTEXT,
		);
		const edited = (
			await until(providers.providers, (rows) =>
				rows.some((row) => row.baseUrl === "https://new.example.com/v1" && !row.storedKey),
			)
		).find((row) => row.id === "relay");
		assert.equal(edited?.storedKey, false);
		assert.deepEqual(
			edited?.models.map((model) => model.id),
			["m3"],
		);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), {});

		await providers.remove({ id: "relay" }, BACKGROUND_CONTEXT);
		await until(providers.providers, (rows) => rows.length === 0);
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
			providers: Record<string, unknown>;
		};
		assert.deepEqual(written.providers, {});
		providers.release();
	} finally {
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("provider IDs are generated from free text", () => {
	assert.equal(sanitizeProviderId("Claude Relay"), "claude-relay");
	assert.equal(sanitizeProviderId("ent.mmkg.cloud"), "ent-mmkg-cloud");
	assert.equal(sanitizeProviderId("+++"), "");
	assert.equal(sanitizeProviderId("9lives"), "p-9lives");
	assert.equal(sanitizeProviderId("a"), "a1");
	assert.equal(providerIdFrom("", "", "https://ent.mmkg.cloud/v1"), "ent-mmkg-cloud");
	assert.equal(providerIdFrom("", "", "https://ent.mmkg.cloud/v1", "openai-completions"), "ent-mmkg-cloud-openai");
	assert.equal(providerIdFrom("", "", "https://ent.mmkg.cloud", "anthropic-messages"), "ent-mmkg-cloud-anthropic");
	assert.equal(providerIdFrom("", "我的中转", "https://ent.mmkg.cloud"), "ent-mmkg-cloud");
	assert.equal(providerIdFrom("", "", ""), "provider");
	assert.equal(providerIdFrom("x", "Name", "https://host"), "x1");
});
