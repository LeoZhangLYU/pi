import { contribute, defineFacet, liveIn, Translations } from "@p2/app/v1";
import {
	closePanel,
	conversationRoute,
	openPanel,
	Slots,
	ToolActivities,
	UsersIcon,
	useMessages,
	useNavigation,
	useObject,
	useReadable,
	useRoute,
	useSidePanelShown,
	webMessages,
} from "@p2/app/v1/web";
import { Sessions } from "../sessions/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { subagentActivity } from "./activity.tsx";
import { Subagents, TeamWork } from "./contract.ts";
import { teamMessages } from "./messages.ts";
import { TeamPanel } from "./TeamPanel.tsx";

/** The side panel's name for the team (`Route.panel`). */
const PANEL = "team";

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

/** The header's Team button: shown once the session has a team member. */
function TeamButton() {
	const { t } = useMessages(teamMessages);
	const route = useRoute();
	const children = useReadable(liveIn(useObject(Subagents, {}), "reader")?.children);
	const count = (route.session ? (children?.[route.session] ?? []) : []).filter(
		(child) => child.kind !== "agent",
	).length;
	if (!count) return null;
	const open = route.panel === PANEL;
	return (
		<button
			type="button"
			className={`artifact-button ${open ? "on" : ""}`}
			aria-label={t("teamTitle", count)}
			aria-pressed={open}
			data-testid="team-button"
			onClick={() => (open ? closePanel() : openPanel(PANEL))}
		>
			<UsersIcon />
			<span>{count}</span>
		</button>
	);
}

function TeamPanelSlot() {
	const route = useRoute();
	const shown = useSidePanelShown();
	const open = route.panel === PANEL && shown && route.session !== undefined;
	const session = open ? route.session : undefined;
	const children = useReadable(liveIn(useObject(Subagents, {}), "reader")?.children);
	const work = useReadable(liveIn(useObject(TeamWork, session ? { session } : undefined), "reader")?.delegations);
	const statuses = useReadable(liveIn(useObject(SessionStatus, {}), "reader")?.statuses);
	if (!session) return null;
	const busy = statuses?.[session]?.busy ?? [];
	return <TeamPanel members={children?.[session] ?? []} work={work ?? []} busy={busy} />;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-subagents", (self) => {
		self.contribute(Slots, {
			"chat-parent": ParentLink,
			"team-actions": TeamButton,
			"team-panel": TeamPanelSlot,
		});
		self.contribute(ToolActivities, {
			subagent: subagentActivity,
			staff: subagentActivity,
			delegate: subagentActivity,
		});
		self.contribute(Translations, teamMessages.translations);
	});
});
