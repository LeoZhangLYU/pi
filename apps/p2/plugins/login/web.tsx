// The Providers sheet (any owner): sign in to model providers, refresh their catalogs, sign out.

import type { AuthEvent } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, contribute, defineFacet, Translations } from "@p2/app/v1";
import type { Layer } from "@p2/app/v1/web";
import {
	CheckIcon,
	ChevronIcon,
	closeLayers,
	openLayer,
	PlusIcon,
	SearchIcon,
	Sheet,
	Slots,
	useComposerState,
	useHost,
	useMessages,
	useNavigation,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CustomProviders } from "../models/contract.ts";
import { CustomProviderSheet } from "./CustomProviderSheet.tsx";
import { type LoginState, ProviderLogin } from "./contract.ts";
import { loginMessages } from "./messages.ts";

/** Links from providers open only over http(s). */
function Link({ url, label }: { url: string; label: string }) {
	let safe = false;
	try {
		safe = ["http:", "https:"].includes(new URL(url).protocol);
	} catch {}
	return safe ? (
		<a className="login-continue" href={url} target="_blank" rel="noreferrer">
			{label}
			<ChevronIcon />
		</a>
	) : (
		<span>{label}</span>
	);
}

function Notice({ event }: { event: AuthEvent }): ReactNode {
	const { t } = useMessages(loginMessages);
	switch (event.type) {
		case "auth_url":
			return (
				<div className="login-step">
					<Link url={event.url} label={t("continueInBrowser")} />
					{event.instructions && <p className="muted small">{event.instructions}</p>}
				</div>
			);
		case "device_code":
			return (
				<div className="login-step">
					<p className="muted small">{t("enterCodeOnPage")}</p>
					<div className="code-box">{event.userCode}</div>
					{/* A provider may ask clients not to offer opening the page; its address is still needed. */}
					{event.openBrowserOnConfirm === false ? (
						<p className="muted small">{event.verificationUri}</p>
					) : (
						<Link url={event.verificationUri} label={t("openVerificationPage")} />
					)}
				</div>
			);
		case "progress":
			return <p className="muted small">{event.message}</p>;
		case "info":
			return (
				<div className="login-step">
					<p>{event.message}</p>
					{event.links?.map((link) => (
						<Link key={link.url} url={link.url} label={link.label ?? t("moreInformation")} />
					))}
				</div>
			);
	}
}

/** The provider's question; answering it shows the flow working at once (the next prompt or progress follows). */
function PromptForm({ state, onAnswer }: { state: LoginState; onAnswer: (promptId: string, value: string) => void }) {
	const { t } = useMessages(loginMessages);
	const prompt = state.prompt;
	const [value, setValue] = useState("");
	if (!prompt) return null;
	const answer = (input: string) => {
		onAnswer(prompt.id, input);
		setValue("");
	};
	if (prompt.type === "select")
		return (
			<div className="login-step">
				<p>{prompt.message}</p>
				<div className="list">
					{prompt.options.map((option) => (
						<button type="button" key={option.id} className="row-button" onClick={() => answer(option.id)}>
							<span>{option.label}</span>
							<ChevronIcon />
						</button>
					))}
				</div>
			</div>
		);
	return (
		<form
			className="login-step"
			onSubmit={(event) => {
				event.preventDefault();
				answer(value);
			}}
		>
			<label className="label" htmlFor="login-value">
				{prompt.message}
			</label>
			{prompt.type === "manual_code" && <p className="muted small">{t("manualCodeHint")}</p>}
			<input
				id="login-value"
				className="input"
				type={prompt.type === "secret" ? "password" : "text"}
				autoComplete="off"
				placeholder={prompt.placeholder}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			<button type="submit" className="login-continue">
				<span>{t("continue")}</span>
				<ChevronIcon />
			</button>
		</form>
	);
}

/** One provider in the list: its name and, once signed in, how (a subscription or an API key). */
function ProviderRow({
	entry,
	onOpen,
}: {
	entry: { id: string; name: string; signedIn: "oauth" | "api_key" | null };
	onOpen: (id: string) => void;
}) {
	const { t } = useMessages(loginMessages);
	return (
		<button type="button" className="row-button" onClick={() => onOpen(entry.id)}>
			<span>{entry.name}</span>
			{entry.signedIn && (
				<small className="row-value">{entry.signedIn === "oauth" ? t("subscription") : t("apiKey")}</small>
			)}
			<ChevronIcon />
		</button>
	);
}

/** The provider list, one provider's actions, or the running login. Closing the sheet cancels an unfinished one. */
function ProvidersSheet({ onClose }: { onClose: () => void }) {
	const { t } = useMessages(loginMessages);
	const login = useObject(ProviderLogin, {});
	// Provider errors go to the app's toast, as in Pi Mobile.
	const { fail } = useComposerState();
	const known = useReadable(login?.providers);
	// Signing out shows at once; a refused sign-out puts the provider back.
	const [providers, signOut] = useOptimisticCall(
		known ?? [],
		(list, providerId: string) =>
			list.map((entry) => (entry.id === providerId ? { ...entry, signedIn: null } : entry)),
		fail,
	);
	// A start, an answer or a cancel shows the flow's next state at once: working (the provider's attempt and its
	// prompts are the server's, so a start shows the spinner until they arrive), or cancelled.
	const [state, guessLogin] = useOptimisticCall(
		useReadable(login?.login) ?? null,
		(_, next: LoginState) => next,
		fail,
	);
	const [query, setQuery] = useState("");
	const nav = useNavigation();
	const route = useRoute();
	// The list or a provider's page is the topmost layer named "providers": a custom provider form may stack above it.
	const sheets = route.layers.filter(
		(layer): layer is Extract<Layer, { kind: "sheet" | "viewer" }> => layer.kind !== "drawer",
	);
	const selected = sheets.reverse().find((layer) => layer.kind === "sheet" && layer.name === "providers")?.locator;
	const customService = useObject(CustomProviders, {});
	const custom = useReadable(customService?.providers) ?? [];
	const [removing, setRemoving] = useState(false);
	const [removingBusy, setRemovingBusy] = useState(false);
	const openCustom = (id: string) => {
		void nav.push({ ...route, layers: [...route.layers, { kind: "sheet", name: "provider-custom", locator: id }] });
	};
	const current = useRef(state);
	current.current = state;
	const host = useHost();
	// Keep a hold through cleanup: useObject releases its own handle first on ×/Escape.
	// Back leaves the sheet mounted, but must still end the provider's flow as in Pi Mobile.
	useEffect(() => {
		if (!login || !selected) return;
		const held = host.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		return () => {
			const flow = current.current;
			if (!flow || flow.providerId !== selected) {
				held.release();
				return;
			}
			const cancel =
				flow.status === "working"
					? held.cancel({ attemptId: flow.attemptId }, BACKGROUND_CONTEXT)
					: Promise.resolve();
			void cancel
				.then(() => held.dismiss({ attemptId: flow.attemptId }, BACKGROUND_CONTEXT))
				.catch(() => {})
				.finally(() => held.release());
		};
	}, [host, login, selected]);
	const [result, setResult] = useState<string>();
	const [busy, setBusy] = useState(false);
	const providerId = selected;
	const provider = providers.find((entry) => entry.id === providerId);
	if (login && provider) {
		const edited = custom.find((entry) => entry.id === provider.id);
		const back = () => {
			setResult(undefined);
			setRemoving(false);
			void nav.close({ ...route, layers: [...route.layers.slice(0, -1), { kind: "sheet", name: "providers" }] });
		};
		if (state && state.providerId === selected)
			return (
				<Sheet title={provider.name} onClose={onClose} className="login-sheet">
					<div className="login-flow">
						{state.notices.map((entry) => (
							<Notice key={entry.id} event={entry.event} />
						))}
						{state.prompt && (
							<PromptForm
								key={state.prompt.id}
								state={state}
								onAnswer={(promptId, value) =>
									guessLogin({ ...state, prompt: null }, () =>
										login.answer({ attemptId: state.attemptId, promptId, value }, BACKGROUND_CONTEXT),
									)
								}
							/>
						)}
						{state.status === "working" && !state.prompt && !state.notices.length && (
							<div className="spinner large" />
						)}
						{state.status === "success" && (
							<p className="success">
								<CheckIcon /> {state.message ?? t("signedInDefault")}
							</p>
						)}
						{state.status !== "working" && state.status !== "success" && (
							<p className={state.status === "error" ? "error" : "muted"}>{state.message}</p>
						)}
						{state.status === "working" ? (
							<button
								type="button"
								className="text-action"
								// A start not answered yet has no attempt to cancel.
								disabled={!state.attemptId}
								onClick={() =>
									guessLogin({ ...state, status: "cancelled", prompt: null, message: t("cancelled") }, () =>
										login.cancel({ attemptId: state.attemptId }, BACKGROUND_CONTEXT),
									)
								}
							>
								{t("cancel")}
							</button>
						) : (
							<button type="button" className="text-action" onClick={back}>
								{t("done")}
							</button>
						)}
					</div>
				</Sheet>
			);
		return (
			<Sheet title={provider.name} onClose={onClose} onBack={back} className="login-sheet">
				<div className="provider-detail">
					<p className="small">
						{provider.signedIn
							? t("signedInWith", provider.signedIn === "oauth" ? "subscription" : "key")
							: t("notSignedIn")}
					</p>
					<p className="muted small">{provider.signedIn ? t("credentialsStored") : t("envKeysNote")}</p>
					{edited && (
						<>
							<p className="muted small mono">{edited.baseUrl}</p>
							<p className="muted small">
								{edited.api} · {t("modelsCount", edited.models.length)} ·{" "}
								{edited.storedKey ? t("keySaved") : edited.configuredKey ? t("keyConfigured") : t("keyMissing")}
							</p>
						</>
					)}
					<div className="login-actions">
						{provider.loginMethods.map((method) => (
							<button
								type="button"
								key={method.type}
								className="login-action primary"
								onClick={() =>
									guessLogin(
										{
											attemptId: "",
											providerId: provider.id,
											authType: method.type,
											status: "working",
											prompt: null,
											notices: [],
										},
										() => login.start({ providerId: provider.id, authType: method.type }, BACKGROUND_CONTEXT),
									)
								}
							>
								<span>{method.label}</span>
								<ChevronIcon />
							</button>
						))}
						{provider.signedIn && !edited && (
							<button
								type="button"
								className="login-action"
								disabled={busy}
								onClick={() => {
									setBusy(true);
									setResult(undefined);
									login
										.refresh({ providerId: provider.id }, BACKGROUND_CONTEXT)
										.then(({ models }) =>
											setResult(models ? t("modelsAvailable", models) : t("catalogUpdatedNoModels")),
										)
										.catch(fail)
										.finally(() => setBusy(false));
								}}
							>
								<span>{busy ? t("updatingCatalog") : t("updateCatalog")}</span>
							</button>
						)}
						{provider.signedIn && (!edited || edited.storedKey) && (
							<button
								type="button"
								className="login-action danger"
								onClick={() =>
									signOut(provider.id, () => login.logout({ providerId: provider.id }, BACKGROUND_CONTEXT))
								}
							>
								<span>{t("signOut")}</span>
							</button>
						)}
						{edited && (
							<button type="button" className="login-action" onClick={() => openCustom(edited.id)}>
								<span>{t("edit")}</span>
								<ChevronIcon />
							</button>
						)}
						{edited && !removing && (
							<button type="button" className="login-action danger" onClick={() => setRemoving(true)}>
								<span>{t("remove")}</span>
							</button>
						)}
						{edited && removing && (
							<div className="stack">
								<p className="muted small">{t("removeProviderConfirm", edited.name)}</p>
								<div className="inline-form">
									<button
										type="button"
										className="text-action danger"
										disabled={removingBusy}
										onClick={() => {
											if (!customService) return;
											setRemovingBusy(true);
											void customService
												.remove({ id: edited.id }, BACKGROUND_CONTEXT)
												.then(() => {
													setRemoving(false);
													setRemovingBusy(false);
													setResult(undefined);
													void nav.close({
														...route,
														layers: route.layers.slice(0, -1),
													});
												})
												.catch((reason: unknown) => {
													setRemovingBusy(false);
													fail(reason);
												});
										}}
									>
										{removingBusy ? t("removing") : t("remove")}
									</button>
									<button type="button" className="text-action" onClick={() => setRemoving(false)}>
										{t("cancel")}
									</button>
								</div>
							</div>
						)}
					</div>
					{result && <p className="provider-result">{result}</p>}
				</div>
			</Sheet>
		);
	}
	const terms = query.toLowerCase();
	const openProvider = (id: string) => {
		setResult(undefined);
		// The provider screen replaces the list's layer (one step), as in Pi Mobile: Back closes onto the entry before
		// it, which shows the list.
		const top = route.layers.at(-1);
		if (top?.kind !== "sheet" || top.name !== "providers") return;
		void nav.push({
			...route,
			layers: [...route.layers.slice(0, -1), { kind: "sheet", name: "providers", locator: id }],
		});
	};
	const matching = providers.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(terms));
	const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
	const signedIn = matching.filter((entry) => entry.signedIn).sort(byName);
	const others = matching.filter((entry) => !entry.signedIn).sort(byName);
	return (
		<Sheet title={t("providers")} onClose={onClose} className="login-sheet">
			<div className="sheet-sticky">
				<label className="search">
					<SearchIcon />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("searchProviders")}
						aria-label={t("searchProviders")}
					/>
				</label>
			</div>
			<div className="list">
				{signedIn.length > 0 && (
					<>
						<span className="label">{t("signedInGroup")}</span>
						{signedIn.map((entry) => (
							<ProviderRow key={entry.id} entry={entry} onOpen={openProvider} />
						))}
					</>
				)}
				{others.length > 0 && (
					<>
						<span className="label">{t("otherProviders")}</span>
						{others.map((entry) => (
							<ProviderRow key={entry.id} entry={entry} onOpen={openProvider} />
						))}
					</>
				)}
				{known && !matching.length && (
					<p className="empty-note">{query ? t("noProviderMatches") : t("noProvidersAvailable")}</p>
				)}
				<button type="button" className="row-button" onClick={() => openCustom("new")}>
					<span>
						<PlusIcon size={14} /> {t("customProvider")}
					</span>
					<ChevronIcon />
				</button>
			</div>
		</Sheet>
	);
}

/** The sidebar footer's Providers button: any authenticated owner. */
function ProvidersButton() {
	const { t } = useMessages(loginMessages);
	const owner = useOwner();
	const list = useSheet("providers");
	const custom = useSheet("provider-custom");
	const open = list !== undefined || custom !== undefined;
	if (!owner) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "providers" }, { fromDrawer: true })}
			>
				{t("providers")}
			</button>
			{open && <ProvidersSheet onClose={closeLayers} />}
			{custom && <CustomProviderSheet id={custom.locator ?? "new"} />}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-login", (self) => {
		self.contribute(Slots, { "sidebar-foot:providers": ProvidersButton });
		self.contribute(Translations, loginMessages.translations);
	});
});
