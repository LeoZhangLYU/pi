import { defineRegistry, local } from "@p2/app/v1";
import type { OwnerAccess } from "./owner-access.ts";

/**
 * Installation-owned key, the owner account, and one-time recovery tokens (open while held; its access is the
 * `DeviceAccesses` native). Neither the key, the password hash nor the cookie ever enters web state.
 */
export const DeviceAccess = local("p2.device-access", { version: 2, params: {}, members: {} });

/** The open `DeviceAccess`'s owner access: read `.access` at each use. */
export const DeviceAccesses = defineRegistry<
	{ readonly access: OwnerAccess },
	{ readonly access: OwnerAccess } | undefined
>("p2.device-accesses", { version: 1 });
