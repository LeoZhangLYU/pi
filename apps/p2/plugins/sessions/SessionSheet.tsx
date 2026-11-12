import { ChevronIcon, locationLabel, Sheet, SlotList, useMessages } from "@p2/app/v1/web";
import { useState } from "react";
import type { Session } from "./contract.ts";
import { sessionsMessages } from "./messages.ts";

/** The session's search index rebuild (`Search.rebuilds`): running, failed with why, or none. */
export type Reindex = { readonly phase: "running" } | { readonly phase: "failed"; readonly error: string } | undefined;

export function SessionSheet({
	session,
	onClose,
	onRename,
	onPin,
	onArchive,
	onCwd,
	reindex,
	onReindex,
}: {
	session: Session;
	onClose: () => void;
	onRename: (title: string) => void;
	onPin: () => void;
	onArchive: () => void;
	onCwd: () => void;
	reindex: Reindex;
	/** Re-indexes the session's history for search (long work: the row shows it running); absent without search. */
	onReindex: (() => void) | undefined;
}) {
	const { t } = useMessages(sessionsMessages);
	const [title, setTitle] = useState(session.title);
	const changed = title.trim() !== "" && title.trim() !== session.title;
	return (
		<Sheet title={t("session")} onClose={onClose}>
			<form
				className="inline-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) onRename(title.trim());
					onClose();
				}}
			>
				<input
					className="input"
					aria-label={t("title")}
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
				{changed && (
					<button type="submit" className="text-action">
						{t("save")}
					</button>
				)}
			</form>
			<div className="list">
				<button type="button" className="row-button" onClick={onCwd}>
					<span>{t("workingDirectory")}</span>
					<small className="row-value mono">{locationLabel(session.env, session.cwd)}</small>
					<ChevronIcon />
				</button>
				<button type="button" className="row-button" onClick={onPin}>
					<span>{session.pinned ? t("unpin") : t("pinToTop")}</span>
				</button>
				{onReindex && (
					<button type="button" className="row-button" disabled={reindex?.phase === "running"} onClick={onReindex}>
						<span>{reindex?.phase === "running" ? t("rebuildingIndex") : t("rebuildIndex")}</span>
						{reindex?.phase === "failed" && <small className="row-value error">{reindex.error}</small>}
					</button>
				)}
				{/* Plugins' rows for the session (`session-rows:<name>`): they read it from the route. */}
				<SlotList prefix="session-rows" />
				<button type="button" className="row-button danger" onClick={onArchive}>
					<span>{t("archive")}</span>
				</button>
			</div>
		</Sheet>
	);
}
