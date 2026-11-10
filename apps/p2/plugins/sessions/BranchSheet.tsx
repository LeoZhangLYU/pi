// The owner's sheet for a `/tree` branch's label (docs/tree.md): a new label, or for conversation 1 the session title.
import { Sheet, useMessages } from "@p2/app/v1/web";
import { useState } from "react";
import { PREVIEW_LENGTH } from "../tree/contract.ts";
import { sessionsMessages } from "./messages.ts";

/**
 * Renames a branch; `label` null shows `title` (conversation 1's default), and only conversation 1 may go back to it.
 * Saving closes the sheet: the row shows the new label while the rename is in flight.
 */
export function BranchSheet({
	title,
	conversation,
	label,
	onSave,
	onClose,
}: {
	/** The session title, what a null label shows. */
	title: string;
	conversation: number;
	label: string | null;
	onSave: (label: string | null) => void;
	onClose: () => void;
}) {
	const { t } = useMessages(sessionsMessages);
	const [draft, setDraft] = useState(label ?? title);
	const next = draft.replace(/\s+/g, " ").trim();
	const resettable = conversation === 1;
	const unchanged = next === (label ?? title);
	const save = (value: string | null) => {
		onSave(value);
		onClose();
	};
	return (
		<Sheet title={t("branchName")} onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (!unchanged && (next || resettable)) save(next || null);
				}}
			>
				<label className="field">
					<span className="label">{t("branchLabel")}</span>
					<input
						className="input"
						value={draft}
						maxLength={PREVIEW_LENGTH}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</label>
				{resettable && <p className="muted small">{t("branchFirstNote")}</p>}
				<div className="inline-form">
					<button type="submit" className="button" disabled={unchanged || (!next && !resettable)}>
						{t("save")}
					</button>
					{resettable && label !== null && (
						<button type="button" className="text-action" onClick={() => save(null)}>
							{t("useSessionTitle")}
						</button>
					)}
				</div>
			</form>
		</Sheet>
	);
}
