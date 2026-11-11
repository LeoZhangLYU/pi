// The custom provider form (Providers sheet): definition into models.json, API key into auth.json, models from the
// endpoint or typed by hand. The ID is immutable after creation; removing happens on the provider's page.

import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	closeLayers,
	errorText,
	Sheet,
	useMessages,
	useNavigation,
	useObject,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { useState } from "react";
import { type CustomProvider, CustomProviders } from "../models/contract.ts";
import {
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	type CustomProviderInput,
	providerIdFrom,
	sanitizeProviderId,
} from "../models/custom-providers.ts";
import { loginMessages } from "./messages.ts";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** `id = display name` per line, as the textarea edits models. */
function modelsText(models: readonly { id: string; name?: string }[]): string {
	return models.map((model) => (model.name ? `${model.id} = ${model.name}` : model.id)).join("\n");
}

function parseModels(text: string): { id: string; name?: string }[] {
	const models: { id: string; name?: string }[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const [rawId, ...rest] = line.split("=");
		const id = rawId?.trim() ?? "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name = rest.join("=").trim();
		models.push({ id, ...(name && name !== id ? { name } : {}) });
	}
	return models;
}

/** One custom provider's form; `existing` undefined creates one. */
function CustomProviderForm({
	existing,
	onClose,
	onDone,
}: {
	existing: (CustomProviderInput & Pick<CustomProvider, "storedKey" | "configuredKey">) | undefined;
	onClose: () => void;
	onDone: () => void;
}) {
	const { t } = useMessages(loginMessages);
	const service = useObject(CustomProviders, {});
	const [id, setId] = useState(existing?.id ?? "");
	const [name, setName] = useState(existing?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
	const known = CUSTOM_PROVIDER_APIS.includes(existing?.api as CustomProviderApi);
	const [api, setApi] = useState<CustomProviderApi>(
		known ? (existing?.api as CustomProviderApi) : "openai-completions",
	);
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const [models, setModels] = useState(modelsText(existing?.models ?? []));
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<"saving" | "fetching" | "removing">();
	const creating = existing === undefined;
	const providerId = creating ? providerIdFrom(id, name, baseUrl, api) : existing.id;
	const canSave =
		!busy &&
		baseUrl.trim().length > 0 &&
		parseModels(models).length > 0 &&
		(creating ? apiKey.trim().length > 0 : true);

	const discover = async () => {
		if (!service) return;
		setBusy("fetching");
		setError(undefined);
		try {
			const { models: found } = await service.discover(
				{ baseUrl: baseUrl.trim(), api, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
				BACKGROUND_CONTEXT,
			);
			if (!found.length) setError(t("fetchFailed"));
			else setModels(modelsText(found));
		} catch (reason) {
			setError(`${t("fetchFailed")} ${errorText(reason)}`);
		} finally {
			setBusy(undefined);
		}
	};

	const save = async () => {
		if (!service || !canSave) return;
		setBusy("saving");
		setError(undefined);
		const provider: CustomProviderInput = {
			id: providerId,
			...(name.trim() ? { name: name.trim() } : {}),
			baseUrl: baseUrl.trim(),
			api,
			models: parseModels(models),
		};
		try {
			if (creating)
				await service.add({ provider, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }, BACKGROUND_CONTEXT);
			else
				await service.update(
					{
						provider,
						...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
						...(clearKey ? { clearKey: true } : {}),
					},
					BACKGROUND_CONTEXT,
				);
			onDone();
		} catch (reason) {
			setError(errorText(reason));
			setBusy(undefined);
		}
	};

	return (
		<Sheet
			title={creating ? t("newCustomProvider") : t("editCustomProvider")}
			onClose={onClose}
			onBack={onDone}
			className="login-sheet"
		>
			<form
				className="stack provider-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<label className="field">
					<span className="label">{t("providerId")}</span>
					<input
						className="input mono"
						value={id}
						readOnly={!creating}
						onChange={(event) => setId(event.target.value)}
						onBlur={() => {
							if (creating && id.trim()) setId(sanitizeProviderId(id));
						}}
						{...NO_AUTOCORRECT}
					/>
					{creating && (
						<>
							<span className="muted small">{t("providerIdHint")}</span>
							{providerId !== id.trim() && (
								<span className="muted small">{t("providerIdAuto", providerId)}</span>
							)}
						</>
					)}
				</label>
				<label className="field">
					<span className="label">{t("displayNameOptional")}</span>
					<input className="input" value={name} onChange={(event) => setName(event.target.value)} />
				</label>
				<label className="field">
					<span className="label">{t("baseUrl")}</span>
					<input
						className="input mono"
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						{...NO_AUTOCORRECT}
					/>
					<span className="muted small">{t("baseUrlHint")}</span>
				</label>
				<label className="field">
					<span className="label">{t("apiType")}</span>
					<select
						className="input"
						value={api}
						onChange={(event) => setApi(event.target.value as CustomProviderApi)}
					>
						{CUSTOM_PROVIDER_APIS.map((entry) => (
							<option key={entry} value={entry}>
								{entry}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span className="label">{t("apiKey")}</span>
					<input
						className="input mono"
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						{...NO_AUTOCORRECT}
					/>
					{!creating && <span className="muted small">{t("apiKeyKeep")}</span>}
				</label>
				{!creating && existing.storedKey && (
					<label className="check">
						<input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
						{t("clearKey")}
					</label>
				)}
				<div className="field">
					<span className="label">{t("models")}</span>
					<textarea
						className="input mono"
						rows={6}
						value={models}
						onChange={(event) => setModels(event.target.value)}
						{...NO_AUTOCORRECT}
					/>
					<span className="muted small">{t("modelsHint")}</span>
				</div>
				<div className="inline-form">
					<button
						type="button"
						className="button"
						disabled={busy !== undefined || !baseUrl.trim()}
						onClick={() => void discover()}
					>
						{busy === "fetching" ? t("fetchingModels") : t("fetchModels")}
					</button>
					<button type="submit" className="button primary" disabled={!canSave}>
						{busy === "saving" ? t("saving") : t("save")}
					</button>
				</div>
				{error && (
					<p className="notice error" role="alert">
						{error}
					</p>
				)}
			</form>
		</Sheet>
	);
}

/** The custom provider layer: `new`, or a provider ID for editing. */
export function CustomProviderSheet({ id }: { id: string }) {
	const { t } = useMessages(loginMessages);
	const providers = useReadable(useObject(CustomProviders, {})?.providers);
	const nav = useNavigation();
	const route = useRoute();
	const close = () => void nav.close({ ...route, layers: route.layers.slice(0, -1) });
	if (id === "new") return <CustomProviderForm existing={undefined} onClose={closeLayers} onDone={close} />;
	const existing = providers?.find((provider) => provider.id === id);
	if (!providers)
		return (
			<Sheet title={t("editCustomProvider")} onClose={closeLayers} onBack={close} className="login-sheet">
				<p className="empty-note">{t("loading")}</p>
			</Sheet>
		);
	if (!existing)
		return (
			<Sheet title={t("editCustomProvider")} onClose={closeLayers} onBack={close} className="login-sheet">
				<p className="empty-note">{t("customProviderGone")}</p>
			</Sheet>
		);
	return <CustomProviderForm existing={existing} onClose={closeLayers} onDone={close} />;
}
