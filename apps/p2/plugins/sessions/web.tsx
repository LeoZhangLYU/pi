// The mobile drawer's component tree, with catalog/status/subagent/search handles supplying its data, and the owner's
// session actions on its rows.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type HeldIn,
	keptIn,
	liveIn,
	Translations,
	whenLive,
} from "@p2/app/v1";
import {
	closeLayers,
	LanguageSetting,
	openLayer,
	type SessionSummary,
	SettingsIcon,
	Sheet,
	Slot,
	SlotList,
	Slots,
	ThemeSetting,
	useComposerState,
	useConnected,
	useHost,
	useMessages,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Envs } from "../envs/contract.ts";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { BranchSheet } from "./BranchSheet.tsx";
import { type Operation, type Session, Sessions } from "./contract.ts";
import { sessionsMessages } from "./messages.ts";
import { SessionSheet } from "./SessionSheet.tsx";

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

/**
 * The footer's Settings button and its sheet: the owner entries in an explicit order. The sheet stays mounted while an
 * entry's own sheet is open above it (each entry renders that sheet through a portal); it is hidden, not unmounted,
 * then, so Back returns to it.
 */
export function SettingsSheet({ shown, onClose }: { shown: boolean; onClose: () => void }) {
	const { t } = useMessages(sessionsMessages);
	return (
		<Sheet title={t("settings")} onClose={onClose} className="settings-sheet" hidden={!shown}>
			<div className="list settings-list">
				<Slot name="sidebar-foot:providers" />
				<Slot name="sidebar-foot:mcp" />
				<Slot name="sidebar-foot:envs" />
				<Slot name="sidebar-foot:devices" />
				<Slot name="sidebar-foot:ports" />
				<Slot name="sidebar-foot:voice" />
				<Slot name="sidebar-foot:logs" />
				<LanguageSetting />
				<ThemeSetting />
			</div>
		</Sheet>
	);
}

/** The sheets the Settings sheet's slots render: opened directly, they still need it mounted for their slot. */
const SETTINGS_ENTRIES = new Set(["settings", "providers", "mcp", "envs", "devices", "ports", "voice", "logs"]);

/** Settings button for topbar (icon-button style). */
function TopbarSettingsButton() {
	const { t } = useMessages(sessionsMessages);
	const owner = useOwner();
	const route = useRoute();
	const settings = route.layers.findLastIndex((layer) => layer.kind === "sheet" && layer.name === "settings");
	const mounted = route.layers.some((layer) => layer.kind === "sheet" && SETTINGS_ENTRIES.has(layer.name));
	if (!owner) return null;
	return (
		<>
			<button
				type="button"
				className="icon-button"
				aria-label={t("settings")}
				onClick={() => openLayer({ kind: "sheet", name: "settings" })}
			>
				<SettingsIcon />
			</button>
			{/* Mounted while Settings or one of its entries is open: an entry may be opened directly (the
			    new-session hero's provider sign-in) and its sheet still needs the slot that renders it. */}
			{mounted && (
				<SettingsSheet shown={settings >= 0 && settings === route.layers.length - 1} onClose={closeLayers} />
			)}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-sessions", (self) => {
		self.contribute(Slots, { "session-options": TopbarSettingsButton });
		self.contribute(Translations, sessionsMessages.translations);
	});
});
