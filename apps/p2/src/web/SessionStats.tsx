import type { Usage } from "@earendil-works/pi-ai";
import type { ReactNode } from "react";
import { useMessages } from "../runtime/web.tsx";
import { ContextUsage } from "./Chat.tsx";
import { UsersIcon } from "./icons.tsx";
import { webMessages } from "./messages.ts";
import { cacheHitRate } from "./transcript.ts";
export function cost(value: number): string {
	return value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`;
}

/** Cache hit share of the latest assistant response, independent of session-wide spend. */
export function UsageLine({ usage }: { usage?: Usage }) {
	const { t } = useMessages(webMessages);
	const hit = usage ? cacheHitRate(usage) : undefined;
	return (
		<span
			className="usage"
			role="img"
			aria-label={t("cacheRate", hit === undefined ? undefined : Math.round(hit * 100))}
			title={usage ? t("cacheRateTitle", usage.input, usage.cacheRead, usage.cacheWrite) : t("noAssistantResponse")}
		>
			chr {hit === undefined ? "—" : `${Math.round(hit * 100)}%`}
		</span>
	);
}

export function SessionStats({
	usage,
	cacheUsage,
	clients,
	context,
	onCost,
	controls,
}: {
	usage?: Usage;
	cacheUsage?: Usage;
	clients: number;
	/** The context bar's numbers; "pending" while they load (the bar's space stays), undefined for none. */
	context?: { used: number; limit: number } | "pending";
	onCost?: () => void;
	controls?: ReactNode;
}) {
	const { t } = useMessages(webMessages);
	return (
		<div className="session-usage">
			{controls && <div className="session-controls">{controls}</div>}
			<div className="session-stats">
				<span
					className="usage client-count"
					role="img"
					aria-label={t("viewersAria", clients)}
					title={t("viewersTitle")}
				>
					<UsersIcon />
					{clients}
				</span>
				<span className="usage"> · </span>
				<UsageLine usage={cacheUsage} />
				{usage && (
					<>
						<span className="usage"> · </span>
						{onCost ? (
							<button
								type="button"
								className="usage footer-action cost-link"
								title={t("costDetailsTitle")}
								onClick={onCost}
							>
								{cost(usage.cost.total)}
							</button>
						) : (
							<span className="usage" title={t("sessionCostTitle")}>
								{cost(usage.cost.total)}
							</span>
						)}
					</>
				)}
			</div>
			{context === "pending" ? (
				<ContextUsage />
			) : (
				context && <ContextUsage used={context.used} limit={context.limit} />
			)}
		</div>
	);
}
