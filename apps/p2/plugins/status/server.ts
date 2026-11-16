import { num, obj } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	canView,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	isOwner,
	isWorker,
	PluginError,
	record,
} from "@p2/app/v1";
import { Hosts, serverOf } from "@p2/app/v1/server";
import { ReportFields, SessionMetrics, SessionStatus, type Status, StatusStore, WorkerControl } from "./contract.ts";

type Report = { generation: number; tasks: number; busy: number[] };

/** The latest report of each session's worker, with the generation that sent it. 2: no usage. */
const Reports = defineTypedState("p2.status-reports", {
	schema: obj({ reports: record(obj({ generation: num(), ...ReportFields })) }),
	version: 2,
	initial: () => ({ reports: {} }),
	// A reload from version 1 drops each report's usage.
	migrate: (old) => {
		const reports = (old.reports ?? {}) as Record<string, Report>;
		return {
			reports: Object.fromEntries(
				Object.entries(reports).map(([session, { generation, tasks, busy }]) => [
					session,
					{ generation, tasks, busy },
				]),
			),
		};
	},
});

/**
 * Pages and workers built with version 1 of `SessionStatus`: statuses read as they are (their usage was optional), and
 * a report's usage is dropped.
 */
const SESSION_STATUS_ACCEPTS: AcceptsTable<typeof SessionStatus> = {
	1: {
		state: { reader: { statuses: (statuses) => statuses } },
		methods: { report: { args: ({ usage: _usage, ...report }) => report } },
	},
};

/** Pages built with version 1 of `SessionMetrics` read no spend. */
const SESSION_METRICS_ACCEPTS: AcceptsTable<typeof SessionMetrics> = {
	1: { state: { reader: { usage: () => null } } },
};

export default defineFacet((host) => {
	// Who looks at a session: one entry per `SessionMetrics` reference (its params name the session and the viewer).
	const metrics = host.references(SessionMetrics);

	host.serve(StatusStore, (_params, self) => {
		const reports = self.state(Reports);
		const hosts = self.get(Hosts, {});
		// Whether a worker runs comes from the workers component, what it does from its own generation's latest report.
		const statuses = deriveTyped(self, [hosts.workers, reports], ([workers, { reports: latest }]) =>
			Object.fromEntries(
				Object.entries(workers).map(([session, worker]): [string, Status] => {
					if (!worker.running)
						return [
							session,
							{ running: false, tasks: 0, busy: [], ...(worker.error ? { error: worker.error } : {}) },
						];
					const report = latest[session];
					if (report === undefined || report.generation !== worker.generation)
						return [session, { running: true, tasks: 0, busy: [] }];
					const { generation: _generation, ...work } = report;
					return [session, { running: true, ...work }];
				}),
			),
		);
		return {
			statuses,
			report: async ({ session, generation, tasks, busy }, ctx) => {
				// A report of an older worker (one that exited while its report travelled) is dropped.
				const worker = hosts.workers.value[session];
				if (worker === undefined || !worker.running || worker.generation !== generation) return null;
				await reports.change((draft) => {
					draft.reports[session] = { generation, tasks, busy: [...busy].sort((a, b) => a - b) };
				}, ctx);
				return null;
			},
		};
	});

	host.serve(WorkerControl, ({ session }, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Only owners may retry session workers");
		const server = serverOf(self);
		return {
			variant: "owner",
			members: {
				// Answers with the start's outcome: the worker runs, or the call fails with why it could not start.
				restart: async (ctx) => {
					const outcome = await server().workers.retry(session, ctx);
					if (outcome.error !== undefined) throw new PluginError("worker_failed", outcome.error);
					return null;
				},
			},
		};
	});

	host.serve(
		SessionMetrics,
		({ session }, principal, self) => {
			if (!canView(principal, session)) throw forbidden("viewers only");
			const clients = self.derive(
				[metrics],
				([references]) =>
					new Set(references.filter((each) => each.params.session === session).map((each) => each.params.viewer))
						.size,
			);
			return { variant: "reader", members: { clients } };
		},
		{ accepts: SESSION_METRICS_ACCEPTS },
	);

	host.serve(
		SessionStatus,
		(_params, principal, self) => {
			const store = self.get(StatusStore, {});
			if (isWorker(principal)) {
				const { session, generation } = principal;
				return {
					variant: "reporter",
					members: { report: (report, ctx) => store.report({ ...report, session, generation }, ctx) },
				};
			}
			if (!isOwner(principal)) throw forbidden("owners only");
			return { variant: "reader", members: { statuses: store.statuses } };
		},
		{ accepts: SESSION_STATUS_ACCEPTS },
	);
});
