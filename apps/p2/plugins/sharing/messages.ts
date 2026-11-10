// The share join and ended pages, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const sharingMessages = defineMessages("p2.sharing", {
	en: {
		endedTitle: "Share ended",
		endedHeading: "This share has ended",
		endedBody: "The link was reset or the session was archived. Ask the owner for a new one.",
		joinTitle: "Join shared session",
		joinLead: "A session has been shared with you.",
		accessFull:
			"You can read, send messages and uploads, and stop runs. This lets you make the agent run commands on the host.",
		accessView: "You can read along, but not send messages.",
		nameHint: "Enter your name to join; names are not verified.",
		nameLabel: "Your name",
		join: "Join session",
	},
	"zh-CN": {
		endedTitle: "分享已结束",
		endedHeading: "这个分享已结束",
		endedBody: "链接已被重置，或 Session 已被归档。请向所有者索取新的链接。",
		joinTitle: "加入共享 Session",
		joinLead: "有人向你分享了一个 Session。",
		accessFull: "你可以阅读、发送消息和上传文件，并停止运行。这会让 Agent 能在主机上执行命令。",
		accessView: "你可以阅读，但不能发送消息。",
		nameHint: "输入你的名字即可加入；名字不会被验证。",
		nameLabel: "你的名字",
		join: "加入 Session",
	},
});
