import { BACKGROUND_CONTEXT, contribute, defineFacet, Translations } from "@p2/app/v1";
import {
	CopyButton,
	closeLayers,
	forgetOwner,
	openLayer,
	Sheet,
	Slots,
	useMessages,
	useObject,
	useOwner,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Devices } from "./contract.ts";
import { devicesMessages } from "./messages.ts";

function DevicesSheet() {
	const { t } = useMessages(devicesMessages);
	const service = useObject(Devices, {});
	const canMint = useReadable(service?.canMint);
	const [token, setToken] = useState<string>();
	const [error, setError] = useState<string>();
	const [generation, setGeneration] = useState(0);
	const [confirmAll, setConfirmAll] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const signOut = (all: boolean) => {
		setSigningOut(true);
		setError(undefined);
		void fetch(all ? "/owner/logout-all" : "/owner/logout", { method: "POST", credentials: "same-origin" })
			.then(async (response) => {
				if (!response.ok) throw new Error(t("couldNotSignOut"));
				// Conversations kept on this device for the owner go with the sign-in.
				await forgetOwner();
				location.replace("/owner");
			})
			.catch((reason: Error) => {
				setError(reason.message);
				setSigningOut(false);
			});
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: generation explicitly requests a fresh token.
	useEffect(() => {
		let current = true;
		setToken(undefined);
		setError(undefined);
		if (service && canMint)
			void service
				.token(BACKGROUND_CONTEXT)
				.then(({ token }) => {
					if (current) setToken(token);
				})
				.catch((reason: unknown) => {
					if (current) setError(reason instanceof Error ? reason.message : t("couldNotGenerate"));
				});
		return () => {
			current = false;
		};
	}, [service, canMint, generation]);
	return (
		<Sheet title={t("devices")} onClose={closeLayers}>
			<div className="stack">
				<p className="small">{t("tokenIntro")}</p>
				<p className="muted small">{t("tokenHowTo")}</p>
				{canMint === false ? (
					<p className="error" role="alert">
						{t("cannotMint")}
					</p>
				) : error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : token ? (
					<>
						<label className="label" htmlFor="owner-token">
							{t("oneTimeToken")}
						</label>
						<textarea
							id="owner-token"
							className="input mono"
							rows={2}
							readOnly
							value={token}
							onFocus={(event) => event.target.select()}
						/>
						<CopyButton key={token} primary text={token} label={t("copyToken")} />
						<button type="button" className="text-action" onClick={() => setGeneration((value) => value + 1)}>
							{t("generateNewToken")}
						</button>
					</>
				) : (
					<output className="muted">{t("generating")}</output>
				)}
				{canMint === false && error && (
					<p className="error" role="alert">
						{error}
					</p>
				)}
				<div className="list">
					<button type="button" className="text-action" disabled={signingOut} onClick={() => signOut(false)}>
						{t("signOutThisDevice")}
					</button>
					{confirmAll ? (
						<>
							<p className="muted small">{t("signOutAllWarning")}</p>
							<button
								type="button"
								className="text-action danger"
								disabled={signingOut}
								onClick={() => signOut(true)}
							>
								{t("confirmSignOutAll")}
							</button>
							<button
								type="button"
								className="text-action"
								disabled={signingOut}
								onClick={() => setConfirmAll(false)}
							>
								{t("cancel")}
							</button>
						</>
					) : (
						<button
							type="button"
							className="text-action danger"
							disabled={signingOut}
							onClick={() => setConfirmAll(true)}
						>
							{t("signOutAllDevices")}
						</button>
					)}
				</div>
			</div>
		</Sheet>
	);
}
function DevicesButton() {
	const { t } = useMessages(devicesMessages);
	const sheet = useSheet("devices");
	if (!useOwner()) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				title={t("signInAnotherDevice")}
				onClick={() => openLayer({ kind: "sheet", name: "devices" }, { fromDrawer: true })}
			>
				{t("devices")}
			</button>
			{sheet && <DevicesSheet />}
		</>
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-devices", (self) => {
		self.contribute(Slots, { "sidebar-foot:devices": DevicesButton });
		self.contribute(Translations, devicesMessages.translations);
	});
});
