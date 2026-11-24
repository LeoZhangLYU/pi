import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions } from "@p2/app/v1/worker";
import { webExtension } from "./tool.ts";

/** The web tools (`web_search`, `web_fetch`): internet access for agents, without a provider key. */
export default defineFacet((host) => {
	contribute(host, "p2.web-tools", (self) => {
		self.contribute(Extensions, { [webExtension.name]: webExtension });
	});
});
