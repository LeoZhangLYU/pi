import { contribute, defineFacet, Translations } from "@p2/app/v1";
import { closeLayers, forgetOwner, openLayer, Sheet, Slots, useMessages, useOwner, useSheet } from "@p2/app/v1/web";
import { useState } from "react";
import { devicesMessages } from "./messages.ts";

function DevicesSheet() {
	const { t } = useMessages(devicesMessages);
	const [error, setError] = useState<string>();
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
	return (
		<Sheet title={t("devices")} onClose={closeLayers}>
			<div className="stack">
				{error && <output className="notice error">{error}</output>}
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
				title={t("devices")}
				onClick={() => openLayer({ kind: "sheet", name: "devices" })}
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
