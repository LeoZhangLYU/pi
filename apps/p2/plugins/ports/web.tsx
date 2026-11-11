import { contribute, defineFacet, Translations } from "@p2/app/v1";
import {
	ChevronIcon,
	closeLayers,
	openLayer,
	Slots,
	ToolActivities,
	useMessages,
	useOwner,
	useSheet,
} from "@p2/app/v1/web";
import { portsActivity } from "./activity.tsx";
import { portsMessages } from "./messages.ts";
import { PortsPanel } from "./PortsPanel.tsx";

function PortsButton() {
	const { t } = useMessages(portsMessages);
	return (
		<button className="row-button" type="button" onClick={() => openLayer({ kind: "sheet", name: "ports" })}>
			<span>{t("ports")}</span>
			<small className="row-value">{t("openDevServers")}</small>
			<ChevronIcon />
		</button>
	);
}
function PortsSheet() {
	const sheet = useSheet("ports");
	return useOwner() && sheet ? <PortsPanel onClose={closeLayers} /> : null;
}
export default defineFacet((host) => {
	contribute(host, "p2.web-ports", (self) => {
		self.contribute(Slots, { "envs-actions:ports": PortsButton, "sidebar-foot:ports": PortsSheet });
		self.contribute(ToolActivities, { ports: portsActivity });
		self.contribute(Translations, portsMessages.translations);
	});
});
