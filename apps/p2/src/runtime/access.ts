// Who the browser is (browser-safe contract): the owner. Served by the server host. The `guest` variant remains in the
// history for contracts released before sharing was removed; the server never serves it.

import { remote } from "@earendil-works/chord";
import { obj, opt, str, union } from "@earendil-works/pi-schema";
import { serverHost } from "./chord.ts";
import { literal, record } from "./schema.ts";

const Mode = union([literal("view"), literal("full")]);

/** A guest's grant, as released versions declared it (dead schema: no guest exists anymore). */
const GrantSchema = obj({
	id: str(),
	name: str(),
	session: str(),
	mode: Mode,
	sessions: opt(record(Mode)),
	email: opt(str()),
});

export const Access = remote("p2.access", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: {} },
		guest: { state: { grant: GrantSchema } },
	},
});
