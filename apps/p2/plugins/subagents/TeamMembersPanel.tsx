// Team Members Sidebar: displays team members with archived members collapsible
import { setMultiSidebarOpen, toggleShowArchived, useShowArchived } from "@p2/app/v1/web";
import { useMessages } from "@p2/app/v1/web";
import { CloseIcon } from "../../src/web/icons.tsx";
import { type Child, isTeamExecutor, roleOfChild, teamRows } from "./contract.ts";
import { teamMessages } from "./messages.ts";

export function TeamMembersPanel({ members, busy }: { members: readonly Child[]; busy: readonly number[] }) {
	const { t } = useMessages(teamMessages);
	const showArchived = useShowArchived();
	const rows = teamRows(members);

	// Separate active and archived members
	const activeMembers = rows.filter((child) => !child.archived);
	const archivedMembers = rows.filter((child) => child.archived);

	const roleLabel = (child: Child): string => {
		const role = roleOfChild(child);
		if (role === "hr") return t("roleHr");
		if (role === "manager") return t("roleManager");
		return child.manager === undefined ? t("directExecutor") : t("executorOf", child.manager);
	};

	return (
		<aside className="side-panel team-members-panel" data-testid="team-members-panel">
			<header className="side-panel-head">
				<h2>{t("teamMembersTitle")}</h2>
				<button
					type="button"
					className="icon-button"
					onClick={() => setMultiSidebarOpen("team", false)}
					aria-label={t("close")}
				>
					<CloseIcon />
				</button>
			</header>

			<div className="side-panel-body">
				{/* Active members */}
				{activeMembers.length ? (
					<div className="team-list">
						{activeMembers.map((child) => {
							const isWorking = busy.includes(child.conversationId);
							const role = roleLabel(child);
							const info = [role, child.duty].filter(Boolean);

							return (
								<div
									className={`team-row ${isTeamExecutor(child, rows) ? "team-executor" : ""}`}
									key={child.conversationId}
									data-testid="team-member"
									data-status={isWorking ? "working" : "idle"}
								>
									<span>
										<strong>{child.name}</strong>
										{info.length > 0 && (
											<small>
												{info.map((item, i) => (
													<span key={i}>
														{i > 0 && " / "}
														{item}
													</span>
												))}
											</small>
										)}
									</span>
									<small>{isWorking ? t("working") : t("idle")}</small>
								</div>
							);
						})}
					</div>
				) : (
					<p className="empty-note">{t("noMembers")}</p>
				)}

				{/* Show archived button */}
				{archivedMembers.length > 0 && (
					<button type="button" className="show-archived-button" onClick={toggleShowArchived}>
						{showArchived ? t("hideArchived") : t("showArchived", archivedMembers.length)}
					</button>
				)}

				{/* Archived members (conditionally rendered) */}
				{showArchived && archivedMembers.length > 0 && (
					<div className="team-list archived-members">
						{archivedMembers.map((child) => {
							const role = roleLabel(child);
							const info = [role, child.duty].filter(Boolean);

							return (
								<div
									className={`team-row ${isTeamExecutor(child, rows) ? "team-executor" : ""} archived`}
									key={child.conversationId}
									data-testid="team-member-archived"
									data-status="archived"
								>
									<span>
										<strong>{child.name}</strong>
										{info.length > 0 && (
											<small>
												{info.map((item, i) => (
													<span key={i}>
														{i > 0 && " / "}
														{item}
													</span>
												))}
											</small>
										)}
									</span>
									<small>{t("archived")}</small>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</aside>
	);
}
