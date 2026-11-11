import { contribute, defineFacet, Translations, whenLive } from "@p2/app/v1";
import {
	closeLayers,
	errorText,
	openLayer,
	Sheet,
	Slots,
	useMessages,
	useNavigation,
	useObject,
	useOwner,
	useReadable,
	useSheet,
	useStatus,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { Logs } from "./contract.ts";
import { logsMessages } from "./messages.ts";
import "./style.css";

function LogsSheet({ source }: { source: string }) {
	const { t } = useMessages(logsMessages);
	const sourceLabel = (id: string): string => {
		if (id.startsWith("session:")) return t("worker", id.slice(8));
		return id === "dev" ? t("devSupervisor") : id === "terminals" ? t("terminalHost") : t("server");
	};
	const logs = useObject(Logs, { source });
	const status = useStatus(logs);
	const sources = useReadable(logs?.sources) ?? [];
	const lines = useReadable(logs?.lines) ?? [];
	const [filter, setFilter] = useState("");
	const [follow, setFollow] = useState(true);
	const [message, setMessage] = useState<string>();
	const area = useRef<HTMLPreElement>(null);
	const nav = useNavigation();
	const query = filter.toLowerCase();
	const shown = lines.filter((line) => line.text.toLowerCase().includes(query));
	const text = shown.map((line) => `${new Date(line.time).toISOString()} [${line.level}] ${line.text}`).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: New rendered lines must trigger tail-following after the DOM updates.
	useEffect(() => {
		if (follow && area.current) area.current.scrollTop = area.current.scrollHeight;
	}, [follow, text]);
	useEffect(() => {
		let current = true;
		void (logs ? whenLive(logs) : Promise.resolve()).catch((error: unknown) => {
			if (current) setMessage(errorText(error));
		});
		return () => {
			current = false;
		};
	}, [logs]);
	const choices = [...new Set(["server", "terminals", "dev", source, ...sources.map((entry) => entry.id)])];
	return (
		<Sheet title={t("logs")} onClose={closeLayers} className="logs-sheet">
			<div className="logs-controls">
				<label className="label" htmlFor="logs-source">
					{t("source")}
				</label>
				<select
					id="logs-source"
					className="input"
					value={source}
					onChange={(event) => {
						const value = event.target.value;
						void nav.replace({
							...nav.route,
							layers: nav.route.layers.map((layer, index) =>
								index === nav.route.layers.length - 1 ? { kind: "sheet", name: "logs", locator: value } : layer,
							),
						});
					}}
				>
					{choices.map((id) => (
						<option key={id} value={id}>
							{sourceLabel(id)}
						</option>
					))}
				</select>
				<input
					className="input"
					aria-label={t("filterLogs")}
					placeholder={t("filterLogs")}
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<div className="logs-actions">
					<label>
						<input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />{" "}
						{t("followTail")}
					</label>
					<button
						type="button"
						className="text-action"
						onClick={() => {
							void (
								navigator.clipboard?.writeText(text) ?? Promise.reject(new Error(t("clipboardUnavailable")))
							).then(
								() => setMessage(t("copied")),
								() => setMessage(t("couldNotCopy")),
							);
						}}
					>
						{t("copy")}
					</button>
				</div>
			</div>
			{message && <output className="notice">{message}</output>}
			<pre ref={area} className="logs-output" title={t("logLines")}>
				{text ||
					(status === "live"
						? t("noLogLines")
						: status === "failed" || status === "ended"
							? t("logsUnavailable")
							: t("loadingLogs"))}
			</pre>
		</Sheet>
	);
}

function LogsButton() {
	const { t } = useMessages(logsMessages);
	const sheet = useSheet("logs");
	if (!useOwner()) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "logs" }, { fromDrawer: true })}
			>
				{t("logs")}
			</button>
			{sheet && <LogsSheet source={sheet.locator ?? "server"} />}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-logs", (self) => {
		self.contribute(Slots, { "sidebar-foot:logs": LogsButton });
		self.contribute(Translations, logsMessages.translations);
	});
});
