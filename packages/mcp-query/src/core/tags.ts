// Tags — RTK Query's invalidation currency. An entry "provides" tags; a tool
// "invalidates" them. The MCP twist: most tags are derived from protocol signals
// (resources/updated, list_changed), so the common case needs zero hand-tagging.

import type { ListKind } from "./types.js";

export type Tag = string;

/** A specific resource. Auto-provided by every useResource and fired by resources/updated. */
export const resourceTag = (server: string, uri: string): Tag => `res:${server}:${uri}`;

/** A server's capability catalog. Invalidated by *_list_changed notifications. */
export const capsTag = (server: string, what: ListKind): Tag => `caps:${server}:${what}`;

/** Coarse "anything from this server" tag — handy for blunt invalidation on reconnect. */
export const serverTag = (server: string): Tag => `server:${server}`;

/** Opt-in entity tag for the app-declared normalization layer, e.g. entityTag("Issue", 1234). */
export const entityTag = (type: string, id: string | number): Tag => `${type}:${id}`;
