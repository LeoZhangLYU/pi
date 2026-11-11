// The history tools' details, in the languages p2 offers. `en` is the source catalog.

import { defineMessages } from "@p2/app/v1";

export const historyMessages = defineMessages("p2.history", {
	en: {
		moreMatches: "More matches",
		cutAtBudget: "Cut at the output budget",
		newContext: "New context started; earlier history stays searchable.",
	},
	"zh-CN": {
		moreMatches: "还有更多匹配",
		cutAtBudget: "已按输出预算截断",
		newContext: "已开始新的上下文；更早的历史仍可搜索。",
	},
});
