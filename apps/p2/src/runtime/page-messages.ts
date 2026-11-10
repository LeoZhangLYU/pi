// The server-rendered sign-in page, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@earendil-works/chord";

export const pageMessages = defineMessages("p2.page", {
	en: {
		title: "Pi · Sign in",
		heading: "Sign in to Pi",
		introConfigured: "Sign in with the owner account for this server.",
		introAbsent:
			"No owner password is configured yet. Sign in with a recovery token, or set one on the host with npm run set-password (or P2_PASSWORD) and reload.",
		introInvalid:
			"Password sign-in is unavailable: the owner account file cannot be read. Sign in with a recovery token, or fix owner-account.json in the data directory on the host.",
		username: "Username",
		password: "Password",
		signIn: "Sign in",
		recoveryToken: "Recovery token",
		recoveryHint:
			"A recovery token is printed when the server starts; npm run owner-link on the host creates a link to one. It expires after ten minutes and works once.",
		signingIn: "Signing in…",
		signInFailed: "Sign-in failed. Try again.",
		invalidLink: "Invalid, expired or already-used link. Generate a fresh owner link on the host.",
		invalidOwnerLink: "Invalid owner link.",
		grantNote:
			"This grants full owner access, including shell commands. A sign-in lasts 30 days and renews while you use it.",
	},
	"zh-CN": {
		title: "Pi · 登录",
		heading: "登录 Pi",
		introConfigured: "使用此服务器的所有者账号登录。",
		introAbsent:
			"还没有配置所有者密码。可以用恢复 Token 登录，或在主机上运行 npm run set-password（或设置 P2_PASSWORD）设置密码后刷新本页。",
		introInvalid:
			"密码登录不可用：无法读取所有者账号文件。可以用恢复 Token 登录，或在主机上修复数据目录里的 owner-account.json。",
		username: "用户名",
		password: "密码",
		signIn: "登录",
		recoveryToken: "恢复 Token",
		recoveryHint:
			"服务器启动时会打印一个恢复 Token；在主机上运行 npm run owner-link 可以生成指向它的链接。Token 十分钟内有效，只能使用一次。",
		signingIn: "正在登录…",
		signInFailed: "登录失败，请重试。",
		invalidLink: "链接无效、已过期或已被使用。请在主机上重新生成 owner 链接。",
		invalidOwnerLink: "owner 链接无效。",
		grantNote: "这会授予完整的所有者权限，包括执行 shell 命令。登录有效期 30 天，使用期间会自动续期。",
	},
});
