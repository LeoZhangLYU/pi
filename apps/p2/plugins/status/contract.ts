import type { Usage } from "@earendil-works/pi-ai";
import { arr, bool, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { evolve, local, method, param, record, remote, serverHost, unsafe } from "@p2/app/v1";

export const StatusSchema = obj({
	/** A worker process runs for the session. */
	running: bool(),
	error: opt(str()),
	/** Live Durable tasks (foreground and background). */
	tasks: num(),
	/** Conversations with foreground work, ascending. */
	busy: arr(num()),
});
export type Status = Static<typeof StatusSchema>;
export const StatusesSchema = record(StatusSchema);

/** What a worker reports of its work: its live tasks and its busy conversations. */
export const ReportFields = {
	tasks: num(),
	busy: arr(num()),
};
const ReportSchema = obj(ReportFields);

/** Live status of every session (server, in memory). Reports are fenced by worker generation. 2: no usage. */
export const StatusStore = local("p2.status-store", {
	version: 2,
	params: {},
	members: {
		statuses: StatusesSchema,
		report: method(obj({ ...ReportFields, session: str(), generation: num() })),
	},
});

/**
 * Version 1, as released: each status and report also carried the session's spend (`usage`), which the footer showed.
 * Copied verbatim (member order included), so its fingerprint is the one old bundles send.
 */
const UsageSchema = unsafe<Usage>(unknown());
const SessionStatusV1 = remote("p2.session-status", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: {
			state: {
				statuses: record(
					obj({ running: bool(), error: opt(str()), usage: opt(UsageSchema), tasks: num(), busy: arr(num()) }),
				),
			},
		},
		reporter: { methods: { report: method(obj({ tasks: num(), busy: arr(num()), usage: opt(UsageSchema) })) } },
	},
});

/**
 * Readers (owner) see every session's status; a worker reports its own session's (its principal names it). 2: no
 * usage (the cost display is gone); the provider still serves 1 (its `accepts`).
 */
export const SessionStatus = evolve(SessionStatusV1, (e) =>
	e.state("reader", "statuses", StatusesSchema).args("report", ReportSchema),
);

/**
 * The session worker's status push (worker, local): reports the worker's work now (its tasks and busy conversations)
 * to the server and returns once the server committed it. A method that starts or stops work (`Chat.send`,
 * `Chat.stop`) awaits it, so the sidebar's working dot is current when the method answers.
 */
export const StatusReport = local("p2.status-report", {
	version: 1,
	params: {},
	members: { push: method() },
});

/**
 * Owner-only retry of a failed session worker; reading status never starts it. `restart` answers once the new worker
 * runs, or fails with why it could not start (`worker_failed`).
 */
export const WorkerControl = remote("p2.worker-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: { owner: { methods: { restart: method() } } },
});

/** Version 1 also held the session's spend (`usage`). */
const SessionMetricsV1 = remote("p2.session-metrics", {
	version: 1,
	params: { session: param.str(), viewer: param.str({ min: 1, max: 80 }) },
	hostAddress: serverHost,
	variants: {
		reader: {
			state: { clients: num(), usage: union([UsageSchema, nul()]) },
		},
	},
});

/**
 * What a page shows about its session: how many viewers (distinct `viewer` params holding it: a page holds one for its
 * active session, child views included). 2: no `usage`; pages of version 1 read null (no spend shown).
 */
export const SessionMetrics = evolve(SessionMetricsV1, (e) => e.removeState("reader", "usage"));
