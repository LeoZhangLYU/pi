// The owner's sign-out sheet, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const devicesMessages = defineMessages("p2.devices", {
	en: {
		devices: "Devices",
		couldNotSignOut: "Could not sign out. Try again.",
		signOutThisDevice: "Sign out this device",
	},
	"zh-CN": {
		devices: "设备",
		couldNotSignOut: "无法退出登录，请重试。",
		signOutThisDevice: "退出此设备",
	},
});
