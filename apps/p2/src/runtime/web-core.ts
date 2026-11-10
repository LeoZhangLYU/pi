// The web page's base facet and the web's own registries: plain TypeScript (no JSX), so tests load it too.

import { Translations } from "@earendil-works/chord";
import type { ComponentType, ReactNode } from "react";
import type { ToolActivity } from "../web/activity/model.ts";
import { webMessages } from "../web/messages.ts";
import { defineFacet, keyedRegistry, serveKeyed } from "./chord.ts";
import { ComposerExpanders } from "./composer.ts";
import { contribute } from "./contribute.ts";
import { coreMessages } from "./core-messages.ts";

/** React components by slot name ("app", "sidebar", "main"), contributed by web facets. */
export const Slots = keyedRegistry<ComponentType<{ children?: ReactNode }>>("p2.web-slots");

/**
 * How a tool's calls show in the chat, by tool name: contributed by the web facet of the plugin that owns the tool (no
 * tool is known to p2's own UI; a tool without one gets the generic look).
 */
export const ToolActivities = keyedRegistry<ToolActivity>("p2.web-tool-activities");

/** The web's base facet (the page loads it with the plugins' web facets): it serves the web's keyed registries. */
export const webCoreFacet = defineFacet((host) => {
	serveKeyed(host, Slots);
	serveKeyed(host, ComposerExpanders);
	serveKeyed(host, ToolActivities);
	contribute(host, "p2.web-core-i18n", (self) => {
		self.contribute(Translations, [...coreMessages.translations, ...webMessages.translations]);
	});
});
