// The owner's sign-out sheet, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const devicesMessages = defineMessages("p2.devices", {
	en: {
		devices: "Devices",
		couldNotSignOut: "Could not sign out. Try again.",
		signOutThisDevice: "Sign out on this device",
		signOutAllDevices: "Sign out all devices",
		confirmSignOutAll: "Confirm sign out all devices",
		signOutAllWarning:
			"This signs out every device and every browser on the host, including this one, and invalidates outstanding owner links. TUIs on the host sign in again by themselves. Already-running agent work is not stopped.",
		cancel: "Cancel",
	},
	"zh-CN": {
		devices: "设备",
		couldNotSignOut: "无法退出登录，请重试。",
		signOutThisDevice: "在此设备退出登录",
		signOutAllDevices: "退出所有设备",
		confirmSignOutAll: "确认退出所有设备",
		signOutAllWarning:
			"这会退出主机上的所有设备和所有浏览器（包括此设备），并使未使用的所有者链接失效。主机上的 TUI 会自行重新登录。正在运行的 Agent 工作不会被停止。",
		cancel: "取消",
	},
});
