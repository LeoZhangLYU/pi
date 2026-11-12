import { defineFacet, nativeOf, serveNative } from "@p2/app/v1";
import { RequestResolvers, Server } from "@p2/app/v1/server";
import { ForwardStore, ForwardsNative } from "../ports/contract.ts";
import { RadiusBrain, type RadiusStatus } from "./brain.ts";
import { RadiusConnections, RadiusService } from "./contract.ts";
import { RelayAccess } from "./relay-access.ts";

/** Pi Mobile's status lines: the brain it connected as, or why it is not connected (retrying). */
export function radiusStatusText(status: RadiusStatus): string {
	return status.status === "connected"
		? status.name === undefined
			? `connected as brain ${status.serverId}`
			: `connected as brain "${status.name}" (${status.serverId})`
		: status.status === "retrying"
			? `not connected (${status.error})`
			: "";
}

export default defineFacet((host) => {
	serveNative(host, RadiusConnections);
	host.serve(RadiusService, (_params, self) => {
		const server = self.get(Server, {});
		self.get(ForwardStore, {});
		const forwards = nativeOf(self, ForwardsNative, "The forwards");
		const connection = self.open(
			async () => {
				const relay = new RelayAccess();
				let lastStatus = "";
				const brain = new RadiusBrain({
					directory: server.info.value.dataDir,
					port: () => server.info.value.port,
					relay,
					forwards: forwards().forwards,
					// As Pi Mobile: each new status once, retries with their error.
					onStatus: (status) => {
						const text = radiusStatusText(status);
						if (text && text !== lastStatus) console.log(`Radius: ${text}`);
						if (text) lastStatus = text;
					},
				});
				if (process.env.P2_RADIUS !== "0") brain.start();
				return { relay, brain };
			},
			({ brain }) => brain.close(),
		);
		self.contribute(RequestResolvers, {
			radius: (request) => {
				const relayed = connection.value.relay.verify(request);
				if (relayed === undefined) return undefined;
				const origin = {
					origin: relayed.publicOrigin,
					remote: true,
					port: server.info.value.port,
					...(relayed.shellOrigin === undefined ? {} : { relayShellOrigin: relayed.shellOrigin }),
				};
				// Anyone else is refused by the request handler (p2 shares nothing).
				return relayed.user === undefined
					? { principal: { kind: "owner", access: "relay" }, origin }
					: { principal: undefined, origin: { ...origin, relayUser: relayed.user } };
			},
		});
		self.contribute(RadiusConnections, {
			get connection() {
				return connection.value;
			},
		});
		return {};
	});
});
