// Chat mode's browser chrome, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";
import { mentionToken } from "./contract.ts";

export const chatModeMessages = defineMessages("p2.chat-mode", {
	en: {
		chat: "Chat",
		chatWaiting: (waiting: number) => `Chat · ${waiting}`,
		modeHint: (name: string) =>
			`Chat mode: messages go to the people in this session, not to ${name}. Mention ${mentionToken(name)} (or say "${name}") to ask ${name}; it then reads the chat since its last answer.`,
		agentName: "Agent name",
		nameInConversation: "Name in this conversation",
		mentionHint: (token: string) =>
			`People mention it as ${token}, and in voice mode its name anywhere in what they say counts. One word: letters, digits, - and _.`,
		save: "Save",
		resetTo: (name: string) => `Reset to ${name}`,
		mentionedAs: (token: string) => `Mentioned as ${token}: rename`,
		agentNameRename: (name: string) => `Agent name ${name}. Rename`,
	},
	"zh-CN": {
		chat: "聊天",
		chatWaiting: (waiting) => `聊天 · ${waiting}`,
		modeHint: (name) =>
			`聊天模式：消息会发给此 Session 中的人，而不是 ${name}。提及 ${mentionToken(name)}（或说出“${name}”）即可询问 ${name}；它会读取自上次回复以来的聊天内容。`,
		agentName: "Agent 名称",
		nameInConversation: "此对话中的名称",
		mentionHint: (token) =>
			`人们用 ${token} 提及它；在语音模式下，说的话里出现它的名字都算。只能是一个词：字母、数字、- 和 _。`,
		save: "保存",
		resetTo: (name) => `重置为 ${name}`,
		mentionedAs: (token) => `以 ${token} 被提及：点击重命名`,
		agentNameRename: (name) => `Agent 名称 ${name}。重命名`,
	},
});
