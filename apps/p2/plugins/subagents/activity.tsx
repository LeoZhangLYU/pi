// How the `subagent` tool shows in the chat: what it asked which subagent, and for an answer or a spawn how it went,
// with the subagent's conversation one tap away.
import {
	DetailLink,
	DetailNote,
	DetailProse,
	DetailSection,
	detailsOf,
	failureOf,
	OpenConversation,
	OutputBlock,
	plainText,
	relativePath,
	type Step,
	sentence,
	stringOf,
	type ToolActivity,
	type ToolView,
	useMessages,
	WorkingDirectory,
	webMessages,
} from "@p2/app/v1/web";
import { useContext } from "react";

const VERBS: Record<string, string> = {
	hire: "Asked the HR manager",
	send: "Gave work to",
	answer: "Read the answer of",
	status: "Checked on",
	roster: "Checked the team",
	models: "Listed models",
	assign: "Moved",
	archive: "Archived",
	restore: "Restored",
	configure: "Configured",
	stop: "Stopped",
};

/** What a `staff hire` made, as a line: its role, its manager and its duty. */
const hired = (args: Record<string, unknown>): string =>
	[stringOf(args.role), stringOf(args.manager) && `of ${stringOf(args.manager)}`, stringOf(args.duty)]
		.filter(Boolean)
		.join(" · ");

const nameOf = (tool: ToolView) => stringOf(tool.args.name) || stringOf(detailsOf(tool).name);

function SubagentDetail({ step }: { step: Step }) {
	const { t } = useMessages(webMessages);
	const { tool } = step;
	const openConversation = useContext(OpenConversation);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const details = detailsOf(tool);
	const action = stringOf(tool.args.action);
	const target = typeof details.conversationId === "number" ? details.conversationId : undefined;
	const config = [
		details.model,
		details.thinkingLevel && t("thinkingValue", stringOf(details.thinkingLevel)),
		Array.isArray(details.tools) && t("toolsValue", details.tools.join(", ") || t("none")),
		typeof details.cwd === "string" &&
			`cwd ${typeof details.env === "string" ? `${details.env}:${details.cwd}` : relativePath(cwd, details.cwd)}`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<DetailSection label={t("input")}>
				<DetailNote>{[action, nameOf(tool)].filter(Boolean).join(" · ")}</DetailNote>
				{tool.args.message !== undefined && <DetailProse text={stringOf(tool.args.message)} />}
				{config && <DetailNote testId="tool-config">{config}</DetailNote>}
			</DetailSection>
			{tool.output && (
				<DetailSection label={t("output")}>
					{action === "answer" && tool.status === "done" ? (
						<DetailProse text={tool.output} />
					) : (
						<OutputBlock output={tool.output} failed={step.status === "error"} />
					)}
				</DetailSection>
			)}
			{target !== undefined && (
				<DetailLink onClick={() => openConversation(target)}>
					{t("open", nameOf(tool) || t("conversation"))}
				</DetailLink>
			)}
		</>
	);
}

/** The call's words: the HR manager's `staff hire` makes a member, the main agent's `subagent hire` only asks for one. */
const verbOf = (tool: ToolView): string => {
	const action = stringOf(tool.args.action);
	if (tool.name === "staff" && action === "hire") return "Hired";
	return VERBS[action] ?? "Team";
};

/** What the call says it did, in a line under its label: a hire's role, manager and duty, else the message. */
const describeLine = (tool: ToolView): string | undefined =>
	tool.name === "staff" && stringOf(tool.args.action) === "hire"
		? hired(tool.args) || undefined
		: plainText(sentence(stringOf(tool.args.message))) || undefined;

export const subagentActivity: ToolActivity = {
	describe: (step) => ({
		label: { kind: "agent", verb: verbOf(step.tool), object: nameOf(step.tool), style: "file" },
		description: failureOf(step) ?? describeLine(step.tool),
	}),
	running: (step) => ({ kind: "agent", verb: "Asking", object: stringOf(step.tool.args.name), style: "file" }),
	argument: (tool) => [stringOf(tool.args.action), nameOf(tool)].filter(Boolean).join(" "),
	summary: (count) => (count === 1 ? "worked with the team" : `worked with the team ${count} times`),
	Detail: SubagentDetail,
};
