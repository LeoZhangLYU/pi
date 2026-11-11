import type { Static } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, liveIn } from "@p2/app/v1";
import { CopyButton, errorText, Sheet, useMessages, useObject, useOptimisticCall, useReadable } from "@p2/app/v1/web";
import { useState } from "react";
import { type ForwardSchema, Ports } from "./contract.ts";
import { portsMessages } from "./messages.ts";

type Forward = Static<typeof ForwardSchema>;

/** A change of the list while its call is in flight. */
type PortGuess =
	| { readonly kind: "add"; readonly key: string; readonly port: number; readonly name: string | undefined }
	| { readonly kind: "remove"; readonly id: string }
	| { readonly kind: "public"; readonly id: string; readonly open: boolean };

/**
 * The list with a change applied. An added forward's id and addresses are the server's: until it answers, the row
 * shows the port and name only (no Open, no link).
 */
function applyPort(forwards: Forward[] | undefined, guess: PortGuess): Forward[] | undefined {
	if (!forwards) return forwards;
	if (guess.kind === "add")
		return [...forwards, { id: guess.key, port: guess.port, ...(guess.name ? { name: guess.name } : {}) }];
	if (guess.kind === "remove") return forwards.filter((forward) => forward.id !== guess.id);
	return forwards.map((forward) =>
		forward.id === guess.id
			? { ...forward, public: guess.open, ...(guess.open ? {} : { publicUrl: undefined }) }
			: forward,
	);
}

/**
 * Every forward is visible to the owner. Making one public requires a second explicit tap. Adding, removing and the
 * public switch show at once; a refused one rolls back with its error.
 */
export function PortsPanel({ onClose }: { onClose: () => void }) {
	const { t } = useMessages(portsMessages);
	const service = liveIn(useObject(Ports, {}), "owner");
	const origin = useReadable(service?.radiusOrigin);
	const [port, setPort] = useState("");
	const [name, setName] = useState("");
	const [removing, setRemoving] = useState<string>();
	const [publishing, setPublishing] = useState<string>();
	const [error, setError] = useState<string>();
	const [forwards, change] = useOptimisticCall(useReadable(service?.forwards), applyPort, (reason) =>
		setError(errorText(reason)),
	);
	const run = (guess: PortGuess, call: () => Promise<unknown>) => {
		setError(undefined);
		change(guess, call);
	};
	const onDevice = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
	return (
		<Sheet title={t("ports")} onClose={onClose}>
			<p className="muted small">{t("intro")}</p>
			{forwards && !origin && (
				<p className="muted small">
					{t("linksAppearBefore")}
					<span className="mono">npm run radius:login</span>
					{t("linksAppearAfter")}
				</p>
			)}
			<div className="list">
				{forwards?.map((forward) => {
					const url = forward.url ?? (onDevice ? `http://localhost:${forward.port}/` : undefined);
					const pending = forward.id.startsWith("adding-");
					const setPublic = (open: boolean) => {
						setPublishing(undefined);
						if (service)
							run({ kind: "public", id: forward.id, open }, () =>
								service.setPublic({ id: forward.id, public: open }, BACKGROUND_CONTEXT),
							);
					};
					return (
						<div className="forward" key={forward.id}>
							<div className="guest-row forward-row">
								<span>
									{forward.name ?? t("portLabel", forward.port)}{" "}
									<small className="muted mono">localhost:{forward.port}</small>
									{forward.session && (
										<small className="muted">
											{t("bySession", forward.sessionTitle ?? t("anotherSession"))}
										</small>
									)}
								</span>
								<span className="inline-form">
									{removing === forward.id ? (
										<>
											<button
												type="button"
												className="text-action danger"
												onClick={() => {
													setRemoving(undefined);
													if (service)
														run({ kind: "remove", id: forward.id }, () =>
															service.remove({ id: forward.id }, BACKGROUND_CONTEXT),
														);
												}}
											>
												{t("remove")}
											</button>
											<button type="button" className="text-action" onClick={() => setRemoving(undefined)}>
												{t("cancel")}
											</button>
										</>
									) : (
										<>
											<button
												type="button"
												className="text-action"
												disabled={pending}
												onClick={() => setRemoving(forward.id)}
											>
												{t("remove")}
											</button>
											{forward.url && <CopyButton text={forward.url} />}
											{url && (
												<a className="button" href={url} target="_blank" rel="noopener noreferrer">
													{t("open")}
												</a>
											)}
										</>
									)}
								</span>
							</div>
							{publishing === forward.id ? (
								<div className="inline-form forward-public">
									<span className="small">{t("anyoneWithLink", forward.port)}</span>
									<button type="button" className="text-action danger" onClick={() => setPublic(true)}>
										{t("makePublic")}
									</button>
									<button type="button" className="text-action" onClick={() => setPublishing(undefined)}>
										{t("cancel")}
									</button>
								</div>
							) : (
								<label className="check forward-public">
									<input
										type="checkbox"
										checked={forward.public ?? false}
										disabled={pending}
										onChange={(event) =>
											event.target.checked ? setPublishing(forward.id) : setPublic(false)
										}
									/>
									{t("publicNoSignIn")}
								</label>
							)}
							{forward.publicUrl && (
								<div className="inline-form forward-public">
									<span className="mono small forward-link">{forward.publicUrl}</span>
									<CopyButton text={forward.publicUrl} />
								</div>
							)}
						</div>
					);
				})}
				{forwards && !forwards.length && <p className="empty-note">{t("noForwards")}</p>}
			</div>
			<form
				className="inline-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!service) return;
					const added = { port: Number(port.trim()), ...(name.trim() ? { name: name.trim() } : {}) };
					run({ kind: "add", key: `adding-${crypto.randomUUID()}`, port: added.port, name: added.name }, () =>
						service.add(added, BACKGROUND_CONTEXT),
					);
					setPort("");
					setName("");
				}}
			>
				<input
					className="input mono forward-port"
					value={port}
					onChange={(event) => setPort(event.target.value)}
					inputMode="numeric"
					placeholder="5173"
					aria-label={t("port")}
					required
				/>
				<input
					className="input"
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={40}
					placeholder={t("nameOptional")}
					aria-label={t("name")}
				/>
				<button type="submit" className="button primary" disabled={!service || !/^\d+$/.test(port.trim())}>
					{t("add")}
				</button>
			</form>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</Sheet>
	);
}
