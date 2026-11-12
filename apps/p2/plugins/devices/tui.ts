// `/devices` in the TUI (p2-tui-port.md P11g), after the web's Devices sheet (owner): signing out this device. Signing
// out is the launcher's: the TUI's sign-in cookie lives there, never in this worker, so it is a C launcher action
// (`signOut`, section 3.2) whose consent UI shows the scope.

import { contribute, defineFacet } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import { grantNotice, ListOverlay, type TuiCommand, TuiCommands } from "@p2/app/v1/tui";

/**
 * The launcher's consent UI (section 3.3) is the confirmation: it states the scope before anything is signed out. On
 * success the server revokes this connection; the launcher then forgets its cookie and asks for an owner link. On
 * loopback the launcher signs in again with the data directory's owner key, so "this device" is refused there
 * (`denied`, like declining).
 */
async function signOut(ctx: TuiContext): Promise<void> {
	const result = await ctx.grant("signOut", {});
	if (!result.ok && result.error === "denied") ctx.notify("Not signed out", "warning");
	else grantNotice(ctx, "Signed out this device", result);
}

function openDevices(ctx: TuiContext): void {
	const overlay = ctx.overlay(
		"devices",
		new ListOverlay(ctx, {
			title: "Devices",
			rows: () => [{ key: "signout", label: "Sign out this device" }],
			onSelect: () => {
				overlay.close();
				void signOut(ctx);
			},
			onClose: () => overlay.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.devices": {
		title: "Devices and sign-out",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "devices" },
		run: (ctx) => openDevices(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-devices", (self) => {
		self.contribute(TuiCommands, COMMANDS);
	}),
);
