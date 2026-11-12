// Principals of p2 (browser-safe). Links stamp them; plugins check them in factories and methods.

/** The person running this p2 (one today). */
export type OwnerPrincipal =
	/**
	 * A local owner session on loopback: a client that proved to run as the server's user, or a browser that redeemed an
	 * owner link on loopback. Its local-only powers (minting owner links, loopback provider sign-ins) rest on that proof.
	 */
	| { readonly kind: "owner"; readonly access: "local" }
	/** Through Radius, authenticated by the relay. */
	| { readonly kind: "owner"; readonly access: "relay" }
	/** An associated device's owner cookie, on any address (also on loopback). Revoked per device. */
	| { readonly kind: "owner"; readonly access: "device"; readonly device: string };
/** A session worker calling the server: stamped by the server's `session:` route, with the spawn generation. */
export type WorkerPrincipal = { readonly kind: "worker"; readonly session: string; readonly generation: number };
/** The server's own code calling into a session worker (fork, transfers, the conversation broker). */
export type ServerPrincipal = { readonly kind: "server" };
/** A host's own code calling objects on the same host. */
export type HostPrincipal = { readonly kind: "host" };
export type P2Principal = OwnerPrincipal | WorkerPrincipal | ServerPrincipal | HostPrincipal;

/**
 * What revokes principals (`host.revoke`, the same on every host): one associated device's owner, every remote owner
 * (relay and devices), or every local owner session.
 */
export type Revocation = { readonly device: string } | { readonly owners: "remote" | "local" };

/** The revocations that end `principal`'s objects and links. */
export function revokedBy(principal: P2Principal): Revocation[] {
	switch (principal.kind) {
		case "owner":
			return principal.access === "device"
				? [{ device: principal.device }, { owners: "remote" }]
				: principal.access === "relay"
					? [{ owners: "remote" }]
					: [{ owners: "local" }];
		default:
			return [];
	}
}

/** Every host's own principal (`createHost({ principal })`). */
export const HOST: HostPrincipal = { kind: "host" };
/** What a worker's parent (the server) acts as when its own code calls the worker (`connect`). */
export const SERVER: ServerPrincipal = { kind: "server" };

// `undefined`: no principal (a request nobody authenticated).
export const isOwner = (principal: P2Principal | undefined): principal is OwnerPrincipal => principal?.kind === "owner";
export const isWorker = (principal: P2Principal | undefined): principal is WorkerPrincipal =>
	principal?.kind === "worker";

/** May read the session: the owner (the only person p2 admits). */
export const canView = (principal: P2Principal | undefined, _session: string): boolean => isOwner(principal);

/** May send, stop and upload in the session: the owner (the only person p2 admits). */
export const canSend = (principal: P2Principal | undefined, _session: string): boolean => isOwner(principal);

/** Object key per principal: owner tabs of one access share objects, each worker generation its own. */
export function principalKey(principal: P2Principal): string {
	switch (principal.kind) {
		case "owner":
			return principal.access === "device" ? `owner:device:${principal.device}` : `owner:${principal.access}`;
		case "worker":
			return `worker:${principal.session}:${principal.generation}`;
		default:
			return principal.kind;
	}
}

/**
 * Who wrote a message: assigned by the worker from the principal, never by the client. `guest` remains readable for
 * entries written before sharing was removed; p2 creates none.
 */
export type Author = { readonly kind: "owner" | "guest"; readonly id: string; readonly name: string };

/** The owner's name when none is configured. */
export const DEFAULT_OWNER_NAME = "Owner";

/** Whose texts and drafts these are: the owner's. */
export const authorIdOf = (_principal: OwnerPrincipal): string => "owner";

/**
 * The author an entry records. `ownerName` is settings.json's `ownerName` read when writing, so a renamed owner's next
 * entries carry the new name; entries already written keep theirs.
 */
export function authorOf(principal: OwnerPrincipal, ownerName: string): Author {
	return { kind: "owner", id: authorIdOf(principal), name: ownerName };
}
