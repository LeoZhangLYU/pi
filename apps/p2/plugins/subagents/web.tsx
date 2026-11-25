import { contribute, defineFacet, liveIn, Translations } from "@p2/app/v1";
import {
	conversationRoute,
	Slots,
	ToolActivities,
	toggleMultiSidebar,
	UsersIcon,
	useMessages,
	useMultiSidebarOpen,
	useNavigation,
	useObject,
	useReadable,
	useRoute,
	webMessages,
} from "@p2/app/v1/web";
import { Sessions } from "../sessions/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { subagentActivity } from "./activity.tsx";
import { Subagents, TeamWork } from "./contract.ts";
import { teamMessages } from "./messages.ts";
import { TeamMembersPanel } from "./TeamMembersPanel.tsx";
import { TeamTasksPanel } from "./TeamTasksPanel.tsx";

function TeamMembersButton() {
	const { t } = useMessages(teamMessages);
	const route = useRoute();
	const isOpen = useMultiSidebarOpen("team");
	const children = useReadable(liveIn(useObject(Subagents, {}), "reader")?.children);
	const count = children?.[route.session ?? ""]?.length ?? 0;
	if (!route.session) return null;
	return (
		<button
			type="button"
			className={`team-action-button ${isOpen ? "active" : ""}`}
			onClick={() => toggleMultiSidebar("team")}
			aria-label={t("teamMembers", count)}
		>
			<UsersIcon />
			<span className="button-label">{t("teamMembersTitle")}</span>
			{count > 0 && <span className="badge">{count}</span>}
		</button>
	);
}

function TeamTasksButton() {
	const { t } = useMessages(teamMessages);
	const route = useRoute();
	const isOpen = useMultiSidebarOpen("task");
	const work = useReadable(
		liveIn(useObject(TeamWork, route.session ? { session: route.session } : undefined), "reader")?.delegations,
	);
	const count = work?.length ?? 0;
	if (!route.session) return null;
	return (
		<button
			type="button"
			className={`team-action-button ${isOpen ? "active" : ""}`}
			onClick={() => toggleMultiSidebar("task")}
			aria-label={t("teamTasks", count)}
		>
			<span>📋</span>
			<span className="button-label">{t("teamTasksTitle")}</span>
			{count > 0 && <span className="badge">{count}</span>}
		</button>
	);
}

function ParentLink() {
	const { t } = useMessages(webMessages);
	const nav = useNavigation();
	const route = useRoute();
	const rows = useReadable(liveIn(useObject(Sessions, {}), "owner")?.sessions);
	const main = rows?.find((row) => row.id === route.session)?.main;
	if (!route.session || main === undefined || route.conversation === main) return null;
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => void nav.backOrPush(conversationRoute(route, route.session, main))}
		>
			{t("backToMainConversation")}
		</button>
	);
}

function TeamMembersSidebar() {
	const isOpen = useMultiSidebarOpen("team");
	const route = useRoute();
	const session = route.session;
	const children = useReadable(liveIn(useObject(Subagents, {}), "reader")?.children);
	const statuses = useReadable(liveIn(useObject(SessionStatus, {}), "reader")?.statuses);
	if (!isOpen || !session) return null;
	const busy = statuses?.[session]?.busy ?? [];
	return <TeamMembersPanel members={children?.[session] ?? []} busy={busy} />;
}

function TeamTasksSidebar() {
	const isOpen = useMultiSidebarOpen("task");
	const route = useRoute();
	const session = route.session;
	const work = useReadable(liveIn(useObject(TeamWork, session ? { session } : undefined), "reader")?.delegations);
	if (!isOpen || !session) return null;
	return <TeamTasksPanel work={work ?? []} />;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-subagents", (self) => {
		self.contribute(Slots, {
			"chat-parent": ParentLink,
			"team-actions": () => (
				<>
					<TeamMembersButton />
					<TeamTasksButton />
				</>
			),
			"team-sidebar": TeamMembersSidebar,
			"task-sidebar": TeamTasksSidebar,
		});
		self.contribute(ToolActivities, {
			subagent: subagentActivity,
			staff: subagentActivity,
			delegate: subagentActivity,
		});
		self.contribute(Translations, teamMessages.translations);
	});
});
