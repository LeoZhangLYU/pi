// p2's own chrome and the server's plain-text answers, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@earendil-works/chord";

export const coreMessages = defineMessages("p2.core", {
	en: {
		language: "Language",
		followSystem: "Follow system",
		localhostOnly: "Localhost only",
		invalidOrigin: "Invalid origin",
		notFound: "Not found",
		forbidden: "Forbidden",
		notShared: "Nothing on this brain is shared with you. Ask its owner for a share link.",
		uiUnavailable: "Could not load the UI",
	},
	"zh-CN": {
		language: "语言",
		followSystem: "跟随系统",
		localhostOnly: "仅限本机访问",
		invalidOrigin: "来源无效",
		notFound: "未找到",
		forbidden: "无权访问",
		notShared: "这个 brain 没有向你分享任何内容，请向所有者索取分享链接。",
		uiUnavailable: "无法加载界面",
	},
});
