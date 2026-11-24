// Team Tasks Sidebar: displays delegation tasks/work
import { setMultiSidebarOpen } from "@p2/app/v1/web";
import { useMessages } from "@p2/app/v1/web";
import { CloseIcon } from "../../src/web/icons.tsx";
import type { DelegationInfo } from "./contract.ts";
import { teamMessages } from "./messages.ts";

const STATUS_KEYS = {
	working: "statusWorking",
	waiting: "statusWaiting",
	stopping: "statusStopping",
	done: "statusDone",
	failed: "statusFailed",
	stopped: "statusStopped",
} as const;

export function TeamTasksPanel({ work }: { work: readonly DelegationInfo[] }) {
	const { t } = useMessages(teamMessages);

	return (
		<aside className="side-panel team-tasks-panel" data-testid="team-tasks-panel">
			<header className="side-panel-head">
				<h2>{t("teamTasksTitle")}</h2>
				<button
					type="button"
					className="icon-button"
					onClick={() => setMultiSidebarOpen("task", false)}
					aria-label={t("close")}
				>
					<CloseIcon />
				</button>
			</header>

			<div className="side-panel-body">
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
										<span className="task-id">#{delegation.id}</span> {delegation.from} → {delegation.to}
									</strong>
									<small>{delegation.text}</small>
									{delegation.result && <small className="team-result">{delegation.result}</small>}
								</span>
								<small>
									{t(STATUS_KEYS[delegation.status])}
									{delegation.stoppedBy && ` · ${t("stoppedBy", delegation.stoppedBy)}`}
								</small>
							</div>
						))}
					</div>
				) : (
					<p className="empty-note">{t("noTasks")}</p>
				)}
			</div>
		</aside>
	);
}
