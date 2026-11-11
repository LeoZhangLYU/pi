import { contribute, defineFacet, Translations } from "@p2/app/v1";
import { closeLayers, openLayer, Slots, useMessages, useOwner, useSheet } from "@p2/app/v1/web";
import { EnvsPanel } from "./EnvsPanel.tsx";
import { envsMessages } from "./messages.ts";
import "./style.css";

function EnvsButton() {
	const { t } = useMessages(envsMessages);
	const sheet = useSheet("envs");
	if (!useOwner()) return null;
	return (
		<>
			<button
				className="foot-button"
				type="button"
				onClick={() => openLayer({ kind: "sheet", name: "envs" }, { fromDrawer: true })}
				title={t("remoteTitle")}
			>
				{t("environments")}
			</button>
			{sheet && <EnvsPanel env={sheet.locator} onClose={closeLayers} />}
		</>
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-envs", (self) => {
		self.contribute(Slots, { "sidebar-foot:envs": EnvsButton });
		self.contribute(Translations, envsMessages.translations);
	});
});
