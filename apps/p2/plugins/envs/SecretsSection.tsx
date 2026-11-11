// A sandbox's secrets in its Envs sheet: names, hosts and age (never values), adding one from a preset, replacing a
// value, deleting. Changes apply when the VM starts next.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { errorText, useMessages, useObject } from "@p2/app/v1/web";
import { useCallback, useEffect, useState } from "react";
import { SandboxSecrets, type SecretInfoView } from "./contract.ts";
import { envsMessages } from "./messages.ts";
import { SECRET_PRESETS } from "./secret-presets.ts";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function age(setAt: number): string {
	const days = Math.floor((Date.now() - setAt) / 86_400_000);
	return days <= 0 ? "set today" : days === 1 ? "set yesterday" : `set ${days} days ago`;
}

type Draft = { preset: string; name: string; value: string; hosts: string; existing: boolean };

/** Secrets of sandbox `sandbox`; `onChanged` after a change (the VM's configuration is no longer current). */
export function SecretsSection({ sandbox, onChanged }: { sandbox: string; onChanged: () => void }) {
	const { t } = useMessages(envsMessages);
	const service = useObject(SandboxSecrets, {});
	const [secrets, setSecrets] = useState<SecretInfoView[]>();
	const [draft, setDraft] = useState<Draft>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const load = useCallback(() => {
		if (!service) return;
		service
			.list({ name: sandbox }, BACKGROUND_CONTEXT)
			.then(setSecrets, (reason: unknown) => setError(errorText(reason)));
	}, [service, sandbox]);
	useEffect(() => load(), [load]);
	const run = async (operation: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await operation();
			setDraft(undefined);
			load();
			onChanged();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	const choose = (id: string) => {
		const preset = SECRET_PRESETS.find((entry) => entry.id === id);
		if (preset)
			setDraft({ preset: id, name: preset.name, value: "", hosts: preset.hosts.join("\n"), existing: false });
	};
	const preset = SECRET_PRESETS.find((entry) => entry.id === draft?.preset);
	const hosts = (draft?.hosts ?? "")
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter(Boolean);
	return (
		<div className="list sandbox-secrets">
			<span className="label">{t("secrets")}</span>
			<p className="muted small">{t("secretsIntro")}</p>
			{secrets?.map((secret) => (
				<button
					type="button"
					key={secret.name}
					className="row-button"
					onClick={() =>
						setDraft({
							preset: secret.preset ?? "custom",
							name: secret.name,
							value: "",
							hosts: secret.hosts.join("\n"),
							existing: true,
						})
					}
				>
					<span className="mono">{secret.name}</span>
					<small className="row-value">
						{secret.hosts.join(", ")} · {age(secret.setAt)}
					</small>
				</button>
			))}
			{secrets && !secrets.length && <p className="empty-note">{t("noSecrets")}</p>}
			{draft ? (
				<form
					className="stack env-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!service) return;
						void run(() =>
							service.set(
								{
									sandbox,
									name: draft.name.trim(),
									...(draft.value ? { value: draft.value } : {}),
									hosts,
									...(draft.preset !== "custom" ? { preset: draft.preset } : {}),
									addHosts: true,
								},
								BACKGROUND_CONTEXT,
							),
						);
					}}
				>
					{!draft.existing && (
						<label className="field">
							<span className="label">{t("secretName")}</span>
							<input
								className="input mono"
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value.toUpperCase() })}
								{...NO_AUTOCORRECT}
							/>
						</label>
					)}
					<label className="field">
						<span className="label">{draft.existing ? t("newValueFor", draft.name) : t("value")}</span>
						<input
							className="input mono"
							type="password"
							autoComplete="off"
							value={draft.value}
							onChange={(event) => setDraft({ ...draft, value: event.target.value })}
							{...NO_AUTOCORRECT}
						/>
					</label>
					<label className="field">
						<span className="label">{t("sentOnlyTo")}</span>
						<textarea
							className="input mono"
							rows={2}
							value={draft.hosts}
							onChange={(event) => setDraft({ ...draft, hosts: event.target.value })}
							{...NO_AUTOCORRECT}
						/>
						<span className="muted small">{t("hostsAddedNote")}</span>
					</label>
					{preset && <p className="muted small">{preset.hint}</p>}
					<div className="inline-form">
						<button
							type="submit"
							className="button primary"
							disabled={busy || !draft.name.trim() || !hosts.length || (!draft.existing && !draft.value)}
						>
							{busy ? t("saving") : t("save")}
						</button>
						{draft.existing && service && (
							<button
								type="button"
								className="text-action danger"
								disabled={busy}
								onClick={() =>
									void run(() => service.delete({ sandbox, name: draft.name }, BACKGROUND_CONTEXT))
								}
							>
								{t("deleteSecret")}
							</button>
						)}
						<button type="button" className="text-action" onClick={() => setDraft(undefined)}>
							{t("cancel")}
						</button>
					</div>
				</form>
			) : (
				<label className="field">
					<span className="label">{t("addSecret")}</span>
					<select className="input" value="" onChange={(event) => choose(event.target.value)}>
						<option value="">{t("choosePreset")}</option>
						{SECRET_PRESETS.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.label}
							</option>
						))}
					</select>
				</label>
			)}
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
