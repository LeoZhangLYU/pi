// Owner devices and recovery tokens, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const devicesMessages = defineMessages("p2.devices", {
	en: {
		devices: "Devices",
		signInAnotherDevice: "Sign in another device",
		tokenIntro:
			"This token grants full owner access. Give it only to your own device, not to collaborators. Use it to sign in another device, or to recover access if the password is lost.",
		tokenHowTo:
			"Open Pi's domain on the other device, paste this token into the sign-in page, and tap Sign in. It expires after ten minutes and works once.",
		cannotMint:
			"Generate owner links on the host with npm run owner-link. Associated devices cannot mint more tokens.",
		couldNotGenerate: "Could not generate a recovery token.",
		couldNotSignOut: "Could not sign out. Try again.",
		oneTimeToken: "One-time recovery token",
		copyToken: "Copy token",
		generateNewToken: "Generate a new token",
		generating: "Generating token…",
		signOutThisDevice: "Sign out on this device",
		signOutAllDevices: "Sign out all devices",
		confirmSignOutAll: "Confirm sign out all devices",
		signOutAllWarning:
			"This signs out every device and every browser on the host, including this one, and invalidates outstanding owner links. TUIs on the host sign in again by themselves. Already-running agent work is not stopped.",
		cancel: "Cancel",
	},
	"zh-CN": {
		devices: "设备",
		signInAnotherDevice: "登录另一台设备",
		tokenIntro:
			"此 Token 授予完整的所有者权限。只应把它交给你自己的设备，不要给协作者。可以用它登录另一台设备，或在密码丢失时恢复访问。",
		tokenHowTo: "在另一台设备上打开 Pi 的域名，把此 Token 粘贴到登录页并点击登录。它十分钟后过期，且只能使用一次。",
		cannotMint: "请在主机上运行 npm run owner-link 生成所有者链接。已关联的设备无法再生成更多 Token。",
		couldNotGenerate: "无法生成恢复 Token。",
		couldNotSignOut: "无法退出登录，请重试。",
		oneTimeToken: "一次性恢复 Token",
		copyToken: "复制 Token",
		generateNewToken: "生成新 Token",
		generating: "正在生成 Token…",
		signOutThisDevice: "在此设备退出登录",
		signOutAllDevices: "退出所有设备",
		confirmSignOutAll: "确认退出所有设备",
		signOutAllWarning:
			"这会退出主机上的所有设备和所有浏览器（包括此设备），并使未使用的所有者链接失效。主机上的 TUI 会自行重新登录。正在运行的 Agent 工作不会被停止。",
		cancel: "取消",
	},
});
