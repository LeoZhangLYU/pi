// The Team panel: the members in team order with what each is doing, and the work given out. Read only, and no entry
// to any of them: the main agent is the team's only conversation.
import { closePanel, SidePanel, useMessages } from "@p2/app/v1/web";
import { type Child, type DelegationInfo, isTeamExecutor, roleOfChild, teamRows } from "./contract.ts";
import { teamMessages } from "./messages.ts";

const STATUS_KEYS = {
	working: "statusWorking",
	waiting: "statusWaiting",
	stopping: "statusStopping",
	done: "statusDone",
	failed: "statusFailed",
	stopped: "statusStopped",
} as const;

export function TeamPanel({
	members,
	work,
	busy,
}: {
	members: readonly Child[];
	work: readonly DelegationInfo[];
	busy: readonly number[];
}) {
	const { t } = useMessages(teamMessages);
	const rows = teamRows(members);
	const roleLabel = (child: Child): string => {
		const role = roleOfChild(child);
		if (role === "hr") return t("roleHr");
		if (role === "manager") return t("roleManager");
		return child.manager === undefined ? t("directExecutor") : t("executorOf", child.manager);
	};
	return (
		<SidePanel title={t("teamTitle", rows.length)} sheetTitle={t("team")} onClose={closePanel} testId="team-panel">
			<p className="empty-note">{t("readOnlyNote")}</p>
			<h4 className="team-heading">{t("members")}</h4>
			{rows.length ? (
				<div className="team-list">
					{rows.map((child) => (
						<div
							className={`team-row ${isTeamExecutor(child, rows) ? "team-executor" : ""}`}
							key={child.conversationId}
							data-testid="team-member"
						>
							<span>
								<strong>{child.name}</strong>
								<small>{[roleLabel(child), child.duty].filter(Boolean).join(" · ")}</small>
							</span>
							<small>
								{busy.includes(child.conversationId) ? t("working") : t("idle")}
								{child.archived ? ` · ${t("archived")}` : ""}
							</small>
						</div>
					))}
				</div>
			) : (
				<p className="empty-note">{t("noMembers")}</p>
			)}
			<h4 className="team-heading">{t("work")}</h4>
			{work.length ? (
				<div className="team-list">
					{work.map((delegation) => (
						<div
							className="team-work"
							key={delegation.id}
							data-testid="team-work"
							data-status={delegation.status}
						>
							<span>
								<strong>
									#{delegation.id} {t("fromTo", delegation.from, delegation.to)}
								</strong>
								<small>{delegation.text}</small>
								{delegation.result && <small className="team-result">{delegation.result}</small>}
							</span>
							<small>
								{t(STATUS_KEYS[delegation.status])}
								{delegation.stoppedBy ? ` · ${t("stoppedBy", delegation.stoppedBy)}` : ""}
							</small>
						</div>
					))}
				</div>
			) : (
				<p className="empty-note">{t("noWork")}</p>
			)}
		</SidePanel>
	);
}
