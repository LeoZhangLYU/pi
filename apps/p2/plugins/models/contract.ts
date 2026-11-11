import { arr, bool, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { defineRegistry, local, method, remote, serverHost, unsafe } from "@p2/app/v1";
import type { MobileSettings } from "@p2/app/v1/node";
import type { ResourceSnapshot, Resources } from "./resources.ts";

export type { ResourceSnapshot, Resources } from "./resources.ts";

export const ModelInfoSchema = obj({
	provider: str(),
	modelId: str(),
	name: str(),
	thinkingLevels: arr(str()),
	contextWindow: num(),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

export const ModelChoiceSchema = obj({
	provider: str({ minLength: 1 }),
	modelId: str({ minLength: 1 }),
	thinkingLevel: str({ minLength: 1 }),
});
export type ModelChoice = Static<typeof ModelChoiceSchema>;

export const ScopedModelSchema = obj({
	provider: str(),
	modelId: str(),
	thinkingLevel: opt(str()),
});
export const EnabledModelsSchema = arr(str({ minLength: 1, maxLength: 300 }), { maxItems: 500 });

/** Provider models for the picker and the default for new sessions (owner only). */
export const Models = remote("p2.models", {
	/** 2: `enabledModels`, `scopedModels` and `setEnabledModels` (pi's model scope for cycling). */
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				models: arr(ModelInfoSchema),
				/** Non-secret resource state for the faithful mobile picker and sign-in hint. */
				resources: unsafe<ResourceSnapshot>(unknown()),
				defaultModel: union([ModelChoiceSchema, nul()]),
				errors: arr(str()),
				/** settings.json `enabledModels` patterns (empty: no scope, cycling uses every model). */
				enabledModels: EnabledModelsSchema,
				/** The patterns resolved against `models`, in pattern order (plugins/models/scope.ts). */
				scopedModels: arr(ScopedModelSchema),
			},
			methods: {
				setDefault: method(ModelChoiceSchema),
				/** Saves the patterns to settings.json (an empty list removes the scope). */
				setEnabledModels: method(obj({ patterns: EnabledModelsSchema })),
			},
		},
	},
});

export const ModelSummarySchema = obj({
	models: arr(ModelInfoSchema),
	defaultModel: union([ModelChoiceSchema, nul()]),
	errors: arr(str()),
});

/**
 * The server's configuration resources (host-internal): `settings.json`, `models.json`, `auth.json`, watched and
 * hot-reloaded (p2's Resources). `summary` is what the model picker needs, `snapshot` everything without
 * secrets (settings, signed-in providers, login methods, errors). The observer itself, for plugins that change the
 * configuration (provider login), is `ModelResources`.
 */
export const ModelConfig = local("p2.model-config", {
	version: 2,
	params: {},
	members: {
		summary: ModelSummarySchema,
		snapshot: unsafe<ResourceSnapshot>(unknown()),
		setDefault: method(ModelChoiceSchema),
		setEnabledModels: method(obj({ patterns: EnabledModelsSchema })),
	},
});

/** The server's configuration observer (`ModelConfig` contributes it once open): read `.value?.resources` at each use. */
export const ModelResources = defineRegistry<
	{ readonly resources: Resources },
	{ readonly resources: Resources } | undefined
>("p2.model-resources", { version: 1 });

/** A custom provider's model, as models.json defines it. */
export const CustomProviderModelSchema = obj({
	id: str({ minLength: 1, maxLength: 300 }),
	name: opt(str({ minLength: 1, maxLength: 128 })),
});

/** A custom provider without its API key: never send a secret to the page. */
export const CustomProviderSchema = obj({
	id: str(),
	name: str(),
	baseUrl: str(),
	api: str(),
	models: arr(CustomProviderModelSchema),
	/** An auth.json credential is stored for it. */
	storedKey: bool(),
	/** Its models.json entry carries an API key (literal, `$ENV` or `!command`). */
	configuredKey: bool(),
});
export type CustomProvider = Static<typeof CustomProviderSchema>;

/** What the custom provider form saves; the ID is immutable after creation. */
export const CustomProviderInputSchema = obj({
	id: str({ minLength: 1 }),
	name: opt(str({ minLength: 1, maxLength: 128 })),
	baseUrl: str({ minLength: 1 }),
	api: str({ minLength: 1 }),
	models: arr(CustomProviderModelSchema, { minItems: 1, maxItems: 500 }),
});

/** models.json's custom providers, added, edited and removed from the Providers sheet (the owner only). */
export const CustomProviders = remote("p2.custom-providers", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { providers: arr(CustomProviderSchema) },
			methods: {
				add: method(
					obj({
						provider: CustomProviderInputSchema,
						apiKey: opt(str({ minLength: 1, maxLength: 10_000 })),
					}),
				),
				update: method(
					obj({
						provider: CustomProviderInputSchema,
						apiKey: opt(str({ minLength: 1, maxLength: 10_000 })),
						clearKey: opt(bool()),
					}),
				),
				remove: method(obj({ id: str({ minLength: 1 }) })),
				/** Best effort: the models an endpoint lists, using `apiKey` for this request only. */
				discover: method(
					obj({
						baseUrl: str({ minLength: 1 }),
						api: str({ minLength: 1 }),
						apiKey: opt(str({ maxLength: 10_000 })),
					}),
					obj({ models: arr(CustomProviderModelSchema) }),
				),
			},
		},
	},
});

/** The worker's own configuration observer (host-internal): its current, valid `settings.json`, hot-reloaded. */
export const WorkerModels = local("p2.worker-models", {
	version: 1,
	params: {},
	members: { settings: unsafe<MobileSettings>(unknown()) },
});
