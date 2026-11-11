// Sharing in the browser: the share sheet (owner), and the guest's presence while its page is open.

import { BACKGROUND_CONTEXT, contribute, defineFacet, Translations } from "@p2/app/v1";
import {
	closeLayers,
	copyText,
	errorText,
	readValue,
	Sheet,
	Slots,
	useMessages,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { GuestPresence, type ShareMode, Sharing } from "./contract.ts";
import { sharingMessages } from "./messages.ts";

/**
 * Two links per session (read-only; read/write: send and Stop), the people it is shared with by email, and the guests
 * connected now. People are offered only while the brain is connected to Radius (`peopleUrl`): they open the session
 * there, signed in with that email, in any organization.
 */
function ShareSheet({ session, onClose }: { session: string; onClose: () => void }) {
	const { t } = useMessages(sharingMessages);
	const sharing = useObject(Sharing, { session });
	const links = useReadable(sharing?.links);
	const guests = useReadable(sharing?.guests);
	const people = useReadable(sharing?.people);
	const peopleUrl = useReadable(sharing?.peopleUrl);
	const remoteEnv = useReadable(sharing?.env);
	const [copied, setCopied] = useState<ShareMode | "address">();
	const [email, setEmail] = useState("");
	const [personMode, setPersonMode] = useState<ShareMode>("view");
	const [confirming, setConfirming] = useState<
		{ reset: ShareMode } | { remove: string } | { remote: true } | { share: string }
	>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(undefined), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const copy = async (mode: ShareMode, remoteConfirmed = false) => {
		if (!sharing) return;
		setError(undefined);
		try {
			let url = links?.find((link) => link.mode === mode)?.url;
			if (url === undefined && mode === "full" && remoteEnv && !remoteConfirmed) {
				setConfirming({ remote: true });
				return;
			}
			if (url === undefined) {
				await sharing.link({ mode, ...(remoteConfirmed ? { remoteConfirmed } : {}) }, BACKGROUND_CONTEXT);
				// The answer follows its state: the new link is in `links` when the call resolves.
				url = readValue(sharing.links)?.find((link) => link.mode === mode)?.url;
			}
			if (url !== undefined && (await copyText(url))) setCopied(mode);
		} catch (reason) {
			setError(errorText(reason));
		}
	};
	/** Shares with the typed email; read/write on a remote environment is confirmed first. */
	const share = async (address: string, remoteConfirmed = false) => {
		if (!sharing) return;
		setError(undefined);
		if (personMode === "full" && remoteEnv && !remoteConfirmed) {
			setConfirming({ share: address });
			return;
		}
		try {
			await sharing.share(
				{ email: address, mode: personMode, ...(remoteConfirmed ? { remoteConfirmed } : {}) },
				BACKGROUND_CONTEXT,
			);
			setEmail("");
		} catch (reason) {
			setError(errorText(reason));
		}
	};
	const copyAddress = async () => {
		if (peopleUrl && (await copyText(peopleUrl))) setCopied("address");
	};
	const confirm = () => {
		if (!sharing || !confirming) return;
		setConfirming(undefined);
		if ("remote" in confirming) {
			void copy("full", true);
			return;
		}
		if ("share" in confirming) {
			void share(confirming.share, true);
			return;
		}
		const action =
			"reset" in confirming
				? sharing.link(
						{
							mode: confirming.reset,
							reset: true,
							...(remoteEnv && confirming.reset === "full" ? { remoteConfirmed: true } : {}),
						},
						BACKGROUND_CONTEXT,
					)
				: sharing.remove({ guestId: confirming.remove }, BACKGROUND_CONTEXT);
		action.catch((reason: unknown) => setError(errorText(reason)));
	};
	const cancel = (
		<button type="button" className="text-action" onClick={() => setConfirming(undefined)}>
			{t("cancel")}
		</button>
	);
	/** Remove, confirmed in place: for a link guest (blocked from the session) or a person (shared no more). */
	const removal = (id: string) =>
		confirming && "remove" in confirming && confirming.remove === id ? (
			<span className="inline-form">
				<button type="button" className="text-action danger" onClick={confirm}>
					{t("remove")}
				</button>
				{cancel}
			</span>
		) : (
			<button type="button" className="text-action" onClick={() => setConfirming({ remove: id })}>
				{t("remove")}
			</button>
		);
	return (
		<Sheet title={t("share")} onClose={onClose}>
			<p className="muted small">{t("anyoneWithLink", remoteEnv ?? undefined)}</p>
			<div className="list">
				{(["view", "full"] as const).map((mode) => {
					const exists = links?.some((link) => link.mode === mode) ?? false;
					return (
						<div className="share-row" key={mode}>
							<span>{t(mode === "full" ? "readWrite" : "readOnly")}</span>
							{mode === "full" && confirming && "remote" in confirming ? (
								<>
									<span className="muted small">{t("guestsCanRun", remoteEnv ?? "")}</span>
									<button type="button" className="text-action danger" onClick={confirm}>
										{t("create")}
									</button>
									{cancel}
								</>
							) : confirming && "reset" in confirming && confirming.reset === mode ? (
								<>
									<span className="muted small">{t("newLinkDisconnect")}</span>
									<button type="button" className="text-action danger" onClick={confirm}>
										{t("reset")}
									</button>
									{cancel}
								</>
							) : (
								<>
									{exists && (
										<button
											type="button"
											className="text-action"
											onClick={() => setConfirming({ reset: mode })}
										>
											{t("reset")}
										</button>
									)}
									<button
										type="button"
										className={`button ${copied === mode ? "done" : ""}`}
										disabled={links === undefined}
										onClick={() => void copy(mode)}
									>
										{copied === mode ? t("copied") : t("copyLink")}
									</button>
								</>
							)}
						</div>
					);
				})}
			</div>
			{peopleUrl && (
				<div className="list">
					<span className="label">{t("people")}</span>
					<p className="muted small">{t("shareWithEmail")}</p>
					<form
						className="inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (email.trim()) void share(email.trim());
						}}
					>
						<input
							className="input"
							type="email"
							aria-label={t("email")}
							placeholder={t("email")}
							autoComplete="off"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
						<select
							className="input"
							aria-label={t("access")}
							value={personMode}
							onChange={(event) => setPersonMode(event.target.value as ShareMode)}
						>
							<option value="view">{t("readOnly")}</option>
							<option value="full">{t("readWrite")}</option>
						</select>
						<button type="submit" className="button" disabled={!email.trim()}>
							{t("share")}
						</button>
					</form>
					{confirming && "share" in confirming && (
						<div className="share-row">
							<span className="muted small">{t("canRunCommands", confirming.share, remoteEnv ?? "")}</span>
							<button type="button" className="text-action danger" onClick={confirm}>
								{t("share")}
							</button>
							{cancel}
						</div>
					)}
					{people?.map((person) => (
						<div className="guest-row" key={person.id}>
							<span>
								{person.name}{" "}
								<small className="muted">· {person.mode === "full" ? t("readWrite") : t("readOnly")}</small>
							</span>
							{removal(person.id)}
						</div>
					))}
					{people && people.length > 0 && (
						<div className="share-row">
							<span className="muted small">{t("sendAddress")}</span>
							<button
								type="button"
								className={`button ${copied === "address" ? "done" : ""}`}
								onClick={() => void copyAddress()}
							>
								{copied === "address" ? t("copied") : t("copyAddress")}
							</button>
						</div>
					)}
				</div>
			)}
			<div className="list">
				<span className="label">{t("connected")}</span>
				{guests && !guests.length && <p className="empty-note">{t("noGuests")}</p>}
				{guests?.map((guest) => (
					<div className="guest-row" key={guest.id}>
						<span>
							{guest.name}{" "}
							<small className="muted">· {guest.mode === "full" ? t("readWrite") : t("readOnly")}</small>
						</span>
						{removal(guest.id)}
					</div>
				))}
			</div>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
		</Sheet>
	);
}

/** The top bar's share button (owner only). */
function ShareButton() {
	const { session } = useRoute();
	const owner = useOwner();
	const open = useSheet("share") !== undefined;
	if (session === undefined || !owner) return null;
	return open ? <ShareSheet session={session} onClose={closeLayers} /> : null;
}

export default defineFacet((host) => {
	contribute(host, "p2.sharing-web", (self) => {
		// A guest counts as connected while its page holds this (the owner's variant does nothing).
		self.get(GuestPresence, {});
		self.contribute(Slots, { "session-actions": ShareButton });
		self.contribute(Translations, sharingMessages.translations);
	});
});
