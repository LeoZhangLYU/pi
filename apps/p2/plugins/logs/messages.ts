// The owner's log viewer, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const logsMessages = defineMessages("p2.logs", {
	en: {
		logs: "Logs",
		source: "Source",
		server: "Server",
		devSupervisor: "Dev supervisor",
		terminalHost: "Terminal host",
		worker: (id: string) => `Worker ${id}`,
		filterLogs: "Filter logs",
		followTail: "Follow tail",
		copy: "Copy",
		clipboardUnavailable: "Clipboard unavailable",
		copied: "Copied",
		couldNotCopy: "Could not copy logs",
		logLines: "Log lines",
		noLogLines: "No log lines",
		logsUnavailable: "Logs unavailable",
		loadingLogs: "Loading logs…",
	},
	"zh-CN": {
		logs: "日志",
		source: "来源",
		server: "服务器",
		devSupervisor: "开发守护进程",
		terminalHost: "终端主机",
		worker: (id) => `Worker ${id}`,
		filterLogs: "筛选日志",
		followTail: "跟随末尾",
		copy: "复制",
		clipboardUnavailable: "剪贴板不可用",
		copied: "已复制",
		couldNotCopy: "无法复制日志",
		logLines: "日志行",
		noLogLines: "没有日志行",
		logsUnavailable: "日志不可用",
		loadingLogs: "正在加载日志…",
	},
});
