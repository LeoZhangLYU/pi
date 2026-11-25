import { useRef, useState } from "react";
import { Slot, useCanWrite, useMessages, useRoute, useUnshownLayers } from "../runtime/web.tsx";
import { useComposerState } from "./composer-state.tsx";
import { webMessages } from "./messages.ts";
import { OwnerNotices } from "./OwnerNotices.tsx";

export function AppLayout() {
	const { t } = useMessages(webMessages);
	const route = useRoute();
	const canWrite = useCanWrite(route.session);
	const { addFiles } = useComposerState();
	const [draggingFiles, setDraggingFiles] = useState(false);
	const dragDepth = useRef(0);
	useUnshownLayers();
	return (
		<div className="app">
			<Slot name="topbar" />
			<main
				className={`main ${draggingFiles ? "dragging-files" : ""} ${route.session ? "" : "new-session-view"}`}
				onDragEnter={(event) => {
					if (!canWrite || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
					event.preventDefault();
					dragDepth.current++;
					setDraggingFiles(true);
				}}
				onDragOver={(event) => {
					if (!canWrite || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				}}
				onDragLeave={(event) => {
					if (!draggingFiles) return;
					event.preventDefault();
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) setDraggingFiles(false);
				}}
				onDrop={(event) => {
					if (!canWrite) return;
					event.preventDefault();
					dragDepth.current = 0;
					setDraggingFiles(false);
					addFiles([...event.dataTransfer.files]);
					document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
				}}
			>
				{draggingFiles && <div className="drop-overlay">{t("dropFiles")}</div>}
				<OwnerNotices />
				<Slot name="main" fallback={<div className="hero">{t("noChatPlugin")}</div>} />
			</main>
			<div id="side-dock" className="side-dock" />
			<Slot name="team-sidebar" />
			<Slot name="task-sidebar" />
			<Slot name="workspace-panel" />
		</div>
	);
}
