// Custom providers in models.json: input validation, document mutation, sanitized views and endpoint discovery.
// API keys never appear in a view or an error: they live in auth.json or in models.json, not in this module's output.

import type { ModelsDocument, ModelsJsonModel, ModelsJsonProvider } from "./model-config.ts";

export type { ModelsDocument } from "./model-config.ts";

export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];
export type CustomProviderModel = { id: string; name?: string };
/** A custom provider as the owner's form edits it; the id is immutable once saved. */
export type CustomProviderInput = {
	id: string;
	name?: string;
	baseUrl: string;
	api: string;
	models: CustomProviderModel[];
};
/** A custom provider without secrets, for the providers sheet. */
export type CustomProviderView = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	models: CustomProviderModel[];
};

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_MODELS = 500;
const MAX_NAME = 128;
const MAX_MODEL_ID = 300;

/** A valid provider ID from free text: lowercase, `a-z0-9-`, starting with a letter, 2–32 characters. */
export function sanitizeProviderId(value: string): string {
	let id = value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+/, "");
	id = id.slice(0, 32).replace(/-+$/, "");
	if (!id) return "";
	if (!/^[a-z]/.test(id)) id = `p-${id}`.slice(0, 32).replace(/-+$/, "");
	if (id.length < 2) id = `${id}1`;
	return id;
}

/** The ID a new provider gets: the typed one, else its name, else its host (with the API family); always valid. */
export function providerIdFrom(raw: string, name: string, baseUrl: string, api?: string): string {
	const host = (() => {
		try {
			return new URL(baseUrl).hostname;
		} catch {
			return baseUrl;
		}
	})();
	// Two relays on one host (an Anthropic and an OpenAI endpoint) still get distinct IDs.
	const family = api?.replace(/-.*$/, "");
	for (const candidate of [raw, name, family ? `${host}-${family}` : host]) {
		const id = sanitizeProviderId(candidate);
		if (id) return id;
	}
	return "provider";
}

const text = (value: string | undefined): string => (value ?? "").trim();

function httpUrl(value: string): string {
	const normalized = value.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new Error("Base URL must be an absolute http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Base URL must be an absolute http(s) URL");
	return normalized;
}

/** The input as stored: trimmed, deduplicated and bounded; throws the first problem it finds. */
export function normalizeCustomProvider(input: CustomProviderInput): CustomProviderInput {
	const id = input.id.trim();
	if (!ID.test(id))
		throw new Error("Provider ID must be 2–32 lowercase letters, digits or dashes, starting with a letter");
	const api = input.api as CustomProviderApi;
	if (!CUSTOM_PROVIDER_APIS.includes(api)) throw new Error("Unsupported API type");
	const name = text(input.name).slice(0, MAX_NAME);
	const models: CustomProviderModel[] = [];
	const seen = new Set<string>();
	for (const entry of input.models) {
		const modelId = text(entry.id);
		if (!modelId) continue;
		if (modelId.length > MAX_MODEL_ID) throw new Error("Model ID is too long");
		if (seen.has(modelId)) continue;
		seen.add(modelId);
		const modelName = text(entry.name).slice(0, MAX_NAME);
		models.push({ id: modelId, ...(modelName && modelName !== modelId ? { name: modelName } : {}) });
		if (models.length > MAX_MODELS) throw new Error(`At most ${MAX_MODELS} models per provider`);
	}
	if (!models.length) throw new Error("Add at least one model ID");
	return { id, ...(name ? { name } : {}), baseUrl: httpUrl(input.baseUrl), api, models };
}

function definition(provider: CustomProviderInput): ModelsJsonProvider {
	return {
		...(provider.name ? { name: provider.name } : {}),
		baseUrl: provider.baseUrl,
		api: provider.api,
		models: provider.models.map(
			(model): ModelsJsonModel => ({
				id: model.id,
				...(model.name ? { name: model.name } : {}),
			}),
		),
	};
}

/** The document with a new provider; `existing` are the provider IDs models.json already has. */
export function addCustomProvider(
	doc: ModelsDocument,
	provider: CustomProviderInput,
	builtinIds: ReadonlySet<string>,
): void {
	if (builtinIds.has(provider.id))
		throw new Error(`Provider ID ${provider.id} belongs to a built-in provider; choose another one`);
	if (Object.hasOwn(doc.providers, provider.id)) throw new Error(`Provider ${provider.id} already exists`);
	doc.providers[provider.id] = definition(provider);
}

/** The document with a provider's managed fields replaced; its unmanaged fields (headers, compat, …) stay. */
export function updateCustomProvider(doc: ModelsDocument, id: string, provider: CustomProviderInput): void {
	const current = doc.providers[id];
	if (!current) throw new Error(`Provider ${id} is not defined in models.json`);
	if (provider.id !== id) throw new Error("A provider's ID cannot change");
	const next = { ...current, ...definition(provider) };
	if (!provider.name) delete next.name;
	doc.providers[id] = next;
}

/** The document without a provider. */
export function removeCustomProvider(doc: ModelsDocument, id: string): void {
	if (!Object.hasOwn(doc.providers, id)) throw new Error(`Provider ${id} is not defined in models.json`);
	delete doc.providers[id];
}

/** A models.json provider as the sheet shows it, or undefined when it is not a plain custom provider. */
export function customProviderView(id: string, provider: ModelsJsonProvider): CustomProviderView | undefined {
	if (provider.oauth || !provider.baseUrl) return undefined;
	const api = provider.api ?? provider.models?.find((model) => model.api)?.api ?? "";
	const models = (provider.models ?? []).map(
		(model): CustomProviderModel => ({
			id: model.id,
			...(model.name ? { name: model.name } : {}),
		}),
	);
	return { id, name: provider.name ?? id, baseUrl: provider.baseUrl, api, models };
}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

type Fetcher = typeof fetch;

/**
 * The models an endpoint lists, best effort: OpenAI-compatible `/models`, Anthropic `/v1/models`, Gemini `models`. The
 * owner triggers this with the form's values; the key is used for this request only and never echoed.
 */
export async function discoverModels(
	input: { baseUrl: string; api: string; apiKey?: string },
	fetchImpl: Fetcher = fetch,
): Promise<CustomProviderModel[]> {
	const api = input.api as CustomProviderApi;
	if (!CUSTOM_PROVIDER_APIS.includes(api)) throw new Error("Unsupported API type");
	const base = httpUrl(input.baseUrl);
	const key = input.apiKey?.trim();
	const headers: Record<string, string> = { accept: "application/json" };
	let url: string;
	if (api === "openai-completions" || api === "openai-responses") {
		url = `${base}/models`;
		if (key) headers.authorization = `Bearer ${key}`;
	} else if (api === "anthropic-messages") {
		url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
		if (key) headers["x-api-key"] = key;
		headers["anthropic-version"] = "2023-06-01";
	} else {
		url = `${base}/models${key ? `?key=${encodeURIComponent(key)}` : ""}`;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("The model list is too large");
		const body = await response.text();
		if (body.length > MAX_BYTES) throw new Error("The model list is too large");
		if (!response.ok) throw new Error(`The endpoint answered HTTP ${response.status}`);
		return parseModels(api, body);
	} catch (error) {
		if (controller.signal.aborted) throw new Error("The endpoint did not answer in time");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function parseModels(api: CustomProviderApi, body: string): CustomProviderModel[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("The endpoint did not answer with JSON");
	}
	const rows =
		api === "google-generative-ai" ? (parsed as { models?: unknown })?.models : (parsed as { data?: unknown })?.data;
	if (!Array.isArray(rows)) throw new Error("The endpoint did not list models");
	const models: CustomProviderModel[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const value = row as Record<string, unknown>;
		const raw = api === "google-generative-ai" ? value.name : value.id;
		if (typeof raw !== "string") continue;
		const id = raw.replace(/^models\//, "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name =
			api === "google-generative-ai"
				? typeof value.displayName === "string"
					? value.displayName
					: undefined
				: typeof value.name === "string" && value.name !== id
					? value.name
					: undefined;
		models.push({ id, ...(name ? { name } : {}) });
		if (models.length >= MAX_MODELS) break;
	}
	return models;
}
