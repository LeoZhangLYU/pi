// The session worker's part of status: its Durable task graph, followed, and pushed to the server's index of statuses
// (the sidebar's working dot). The worker pushes; the server never asks.
import type { TaskGraph } from "@earendil-works/pi-durable";
import { type Ctx, defineFacet, expectVariant } from "@p2/app/v1";
import { harnessOf, workerOf } from "@p2/app/v1/worker";
import { SessionStatus, StatusReport } from "./contract.ts";

/** Live tasks, and conversations with foreground work: a background reporter does not make a conversation busy. */
function summarize(graph: TaskGraph): { tasks: number; busy: number[] } {
	const nodes = Object.values(graph.tasks);
	const busy = [...new Set(nodes.filter((node) => !node.background).map((node) => node.conversationId))];
	return { tasks: nodes.length, busy: busy.sort((a, b) => a - b) };
}

export default defineFacet((host) => {
	host.serve(StatusReport, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const status = self.get(SessionStatus, {});
		const graph = self.follow((observer, ctx) => harness().durable.observeTaskGraph(observer, ctx));
		/** The push running now: pushes run one after another, each reading the graph when it starts. */
		let last: Promise<unknown> = Promise.resolve();
		const report = async (ctx: Ctx): Promise<void> => {
			const summary = summarize(graph.value as TaskGraph);
			worker().liveness.setDurableTasks(summary.tasks);
			await expectVariant(status, "reporter").report(summary, ctx);
		};
		const push = (ctx: Ctx): Promise<void> => {
			const run = last.then(() => report(ctx));
			last = run.catch(() => {});
			return run;
		};
		// Work the agent starts on its own (a turn continuing, a subagent's report) is pushed as the graph changes.
		self.on(graph, async (_call, ctx) => push(ctx));
		return {
			push: async (ctx) => {
				await push(ctx);
				return null;
			},
		};
	});
});
