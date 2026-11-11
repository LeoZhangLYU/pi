// A conversation's artifacts, every version newest first, in the side panel (docked on the right, a sheet on phones).
import type { ArtifactInfo } from "../runtime/schemas.ts";
import { useMessages } from "../runtime/web.tsx";
import { webMessages } from "./messages.ts";
import { SidePanel } from "./SidePanel.tsx";

/** Lists `artifacts` in the side panel; a row opens that version. */
export function ArtifactPicker({
	artifacts,
	onOpen,
	onClose,
}: {
	artifacts: ArtifactInfo[];
	onOpen: (artifact: ArtifactInfo) => void;
	onClose: () => void;
}) {
	const { t } = useMessages(webMessages);
	return (
		<SidePanel title={t("artifacts")} onClose={onClose} testId="artifact-panel">
			{artifacts.length ? (
				<div className="artifact-list">
					{artifacts.map((artifact) => (
						<button
							type="button"
							className="artifact-row"
							key={`${artifact.name}:${artifact.version}`}
							onClick={() => onOpen(artifact)}
						>
							<span>
								<strong>{artifact.title}</strong>
								<small>{artifact.name}</small>
							</span>
							<small>
								{artifact.type} · v{artifact.version}
							</small>
						</button>
					))}
				</div>
			) : (
				<p className="empty-note">{t("noArtifacts")}</p>
			)}
		</SidePanel>
	);
}
