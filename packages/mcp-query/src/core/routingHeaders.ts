// Streamable HTTP routing headers (SEP-2243, spec 2026-07-28 "Request Metadata"): `Mcp-Method`,
// `Mcp-Name` and `Mcp-Param-{Name}` mirror body fields into HTTP headers so intermediaries can route
// without parsing the body. The body is the source of truth; a mismatch is `HeaderMismatch` (-32020).
//
// The SDK (2.0.0) derives `Mcp-Method` / `Mcp-Name` for every request on the 2026-07-28 wire and
// `Mcp-Param-*` for `Client.callTool`, but it exports none of the helpers and does not set
// `Mcp-Param-*` on raw `request()` calls. This module is the small shared piece mcp-query needs for
// the rest: scanning `x-mcp-header` declarations, encoding / decoding values, and cross-checking
// headers against a body. Pure and dependency-free (browser-safe).

/** JSON-RPC error code for a header/body mismatch (spec 2026-07-28, `HeaderMismatchError`). */
export const HEADER_MISMATCH = -32020;

const PARAM_PREFIX = "mcp-param-";
const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_INT = Number.MAX_SAFE_INTEGER;

/**
 * Which body field `Mcp-Name` mirrors, per method. The first three rows are SEP-2243's table; the
 * `tasks/*` rows are SEP-2663 (the client MUST set `Mcp-Name` to `params.taskId`) and the `events/*`
 * rows SEP-3415 (to `params.name`, the event name; `events/list` has none).
 */
export const MCP_NAME_SOURCE: Readonly<Record<string, "name" | "uri" | "taskId">> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
  "events/poll": "name",
  "events/stream": "name",
  "events/subscribe": "name",
  "events/unsubscribe": "name",
};

/**
 * Methods whose `Mcp-Name` is mirrored when sent but not demanded: SDK clients >= 2.3 only emit it for the
 * core methods and `tasks/*` and treat per-request `mcp-name` as reserved, so an `events/*` request from
 * them has no way to carry it. A mismatch is still rejected.
 */
const NAME_OPTIONAL: ReadonlySet<string> = new Set(["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);

/** The `events/*` methods that carry subscription `arguments` (and so `Mcp-Param-*` headers). */
export const EVENT_ARGUMENT_METHODS: ReadonlySet<string> = new Set(["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);

/** Verified routing facts of one request, derived from the BODY (never from a header a caller sent). */
export interface RoutingInfo {
  /** The JSON-RPC method (what `Mcp-Method` mirrors). */
  method: string;
  /** `params.name` / `params.uri` / `params.taskId` where the method has one (what `Mcp-Name` mirrors). */
  name?: string;
  /** Values of the `x-mcp-header`-annotated arguments, by header name (what `Mcp-Param-{Name}` mirrors). */
  params?: Record<string, string>;
}

/** The `Mcp-Name` value a request's body names, or undefined for a method with none. */
export function nameFromBody(method: string, params: unknown): string | undefined {
  const field = Object.hasOwn(MCP_NAME_SOURCE, method) ? MCP_NAME_SOURCE[method] : undefined;
  if (!field || !isRecord(params)) return undefined;
  const v = params[field];
  return typeof v === "string" ? v : undefined;
}

/** One `x-mcp-header` annotation: where the value sits in `arguments`, and the header it maps to. */
export interface HeaderDecl {
  /** Chain of `properties` keys from the schema root. */
  path: string[];
  /** The part after `Mcp-Param-`. */
  headerName: string;
  type: "string" | "integer" | "boolean";
}

export type HeaderScan = { valid: true; decls: HeaderDecl[] } | { valid: false; reason: string };

const NO_DECLS: HeaderScan = { valid: true, decls: [] };

/**
 * Scan an `inputSchema` for `x-mcp-header` annotations, enforcing the spec's constraints: a
 * non-empty RFC 9110 token, case-insensitively unique, primitive `string` / `integer` / `boolean`
 * type only, and only on properties reachable through a chain of `properties` keys (nothing under
 * `items`, composition, conditional or `$ref` keywords; an annotation there invalidates the tool).
 */
export function scanHeaderDecls(inputSchema: unknown): HeaderScan {
  if (!isRecord(inputSchema)) return NO_DECLS;
  const decls: HeaderDecl[] = [];
  const seen = new Map<string, string>();
  let reason: string | undefined;
  const fail = (path: string[], why: string) => (reason ??= `${path.length ? path.join(".") : "(root)"}: ${why}`);

  const walk = (node: unknown, path: string[], reachable: boolean): void => {
    if (!isRecord(node) || reason) return;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const raw = node["x-mcp-header"];
      const type = node.type;
      if (!reachable || path.length === 0) return void fail(path, "x-mcp-header is only permitted on properties reachable through `properties` keys");
      if (typeof raw !== "string" || raw.length === 0) return void fail(path, "x-mcp-header must be a non-empty string");
      if (!TOKEN.test(raw)) return void fail(path, `x-mcp-header '${raw}' is not a valid RFC 9110 token`);
      if (type !== "string" && type !== "integer" && type !== "boolean") return void fail(path, "x-mcp-header is only permitted on string, integer or boolean properties");
      const lower = raw.toLowerCase();
      if (seen.has(lower)) return void fail(path, `x-mcp-header '${raw}' is not case-insensitively unique`);
      seen.set(lower, raw);
      decls.push({ path, headerName: raw, type });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && isRecord(child)) {
        for (const [prop, sub] of Object.entries(child)) walk(sub, [...path, prop], reachable);
      } else if (key !== "x-mcp-header" && typeof child === "object" && child !== null) {
        // Any other keyword (items, oneOf, $defs, ...): annotations below it are invalid, not ignored.
        for (const sub of Array.isArray(child) ? child : [child]) walk(sub, path, false);
      }
    }
  };
  walk(inputSchema, [], true);
  return reason ? { valid: false, reason } : { valid: true, decls };
}

/** Read the value at a `properties` chain in `args`. */
function valueAt(args: unknown, path: string[]): unknown {
  let cur: unknown = args;
  for (const k of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The header string for a body value: string as-is, integer decimal, boolean `true`/`false`; undefined to omit. */
function stringifyValue(decl: HeaderDecl, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (decl.type === "string") return typeof v === "string" ? v : undefined;
  if (decl.type === "boolean") return typeof v === "boolean" ? String(v) : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= SAFE_INT ? String(v) : undefined;
}

/**
 * Encode a header value: plain when it is visible ASCII with no leading/trailing space and does not
 * look like the sentinel, else `=?base64?<utf-8 base64>?=`.
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = /^[\x20-\x7e]*$/.test(value) && value === value.trim() && !(value.startsWith("=?base64?") && value.endsWith("?="));
  if (plain) return value;
  let bin = "";
  for (const b of new TextEncoder().encode(value)) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

/** Decode a header value; undefined when it carries a malformed sentinel. */
export function decodeHeaderValue(value: string): string | undefined {
  const v = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (v.startsWith("=?base64?") && v.endsWith("?=")) {
    const m = SENTINEL.exec(v);
    if (!m) return undefined;
    try {
      const bin = atob(m[1]!);
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return undefined;
    }
  }
  return v;
}

/** Plain (un-encoded) header strings by header name for the annotated arguments present in `args`. */
export function annotatedValues(decls: HeaderDecl[], args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of decls) {
    const s = stringifyValue(d, valueAt(args, d.path));
    if (s !== undefined) out[d.headerName] = s;
  }
  return out;
}

/**
 * The `Mcp-Param-{Name}` request headers for a call: one per annotated argument that has a value,
 * encoded. Empty for a schema with no (or invalid) annotations.
 */
export function paramHeadersFor(inputSchema: unknown, args: unknown): Record<string, string> {
  const scan = scanHeaderDecls(inputSchema);
  if (!scan.valid) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(annotatedValues(scan.decls, args))) out[`Mcp-Param-${name}`] = encodeHeaderValue(value);
  return out;
}

/** What the body says the routing facts are. `inputSchema` is the tool's / event type's, when known. */
export function routingFromBody(method: string, params: unknown, inputSchema?: unknown): RoutingInfo {
  const name = nameFromBody(method, params);
  const scan = inputSchema === undefined ? NO_DECLS : scanHeaderDecls(inputSchema);
  const args = isRecord(params) ? params.arguments : undefined;
  const values = scan.valid ? annotatedValues(scan.decls, args) : {};
  return { method, ...(name !== undefined ? { name } : {}), ...(Object.keys(values).length ? { params: values } : {}) };
}

export interface HeaderCheckInput {
  /** Request headers (any case). */
  headers: { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void };
  body: { method: string; params?: unknown };
  /** The tool's / event type's `inputSchema` for `Mcp-Param-*` validation; absent: params are not checked. */
  inputSchema?: unknown;
  /** A modern (2026-07-28) request: required headers that are absent are an error. Legacy: only present headers are compared. */
  modern: boolean;
}

/**
 * Cross-check routing headers against the body. Returns a description of the first disagreement, or
 * undefined when they agree. Checked: `Mcp-Method` equals the method; `Mcp-Name` equals the body's
 * name for methods that have one (and, on a modern request, is required there); each annotated
 * argument present in the body has a matching `Mcp-Param-*` header, and an `Mcp-Param-*` header for an
 * annotated argument the body does not carry is a mismatch too. Header names are case-insensitive,
 * values are not; sentinel-encoded values are decoded before comparing; integers compare numerically.
 */
export function checkRoutingHeaders(input: HeaderCheckInput): string | undefined {
  const { headers, body, modern } = input;
  const method = headers.get("mcp-method");
  if (method === null) {
    if (modern) return `the body names method ${body.method} but the required Mcp-Method header is absent`;
  } else if (method.trim() !== body.method) {
    return `the Mcp-Method header names "${method.trim()}" but the body names "${body.method}"`;
  }

  const expected = nameFromBody(body.method, body.params);
  const sourceField = Object.hasOwn(MCP_NAME_SOURCE, body.method) ? MCP_NAME_SOURCE[body.method] : undefined;
  const nameHeader = headers.get("mcp-name");
  if (nameHeader !== null && sourceField !== undefined && expected !== undefined) {
    const decoded = decodeHeaderValue(nameHeader);
    if (decoded === undefined) return "the Mcp-Name header carries an invalid Base64 sentinel value";
    if (decoded !== expected) return `the body carries params.${sourceField}="${expected}" but the Mcp-Name header names "${decoded}"`;
  } else if (nameHeader === null && modern && expected !== undefined && !NAME_OPTIONAL.has(body.method)) {
    return `the body carries params.${sourceField}="${expected}" but the required Mcp-Name header is absent`;
  }

  if (input.inputSchema === undefined) return undefined;
  const scan = scanHeaderDecls(input.inputSchema);
  if (!scan.valid) return undefined; // a tool with an invalid annotation is excluded by conforming clients; nothing to mirror
  const args = isRecord(body.params) ? body.params.arguments : undefined;
  for (const d of scan.decls) {
    const header = headers.get(`${PARAM_PREFIX}${d.headerName}`);
    const bodyValue = stringifyValue(d, valueAt(args, d.path));
    if (bodyValue === undefined) {
      if (header !== null) return `the Mcp-Param-${d.headerName} header is set but the body carries no value for it`;
      continue;
    }
    if (header === null) {
      if (!modern) continue; // a 2025-era client mirrors nothing
      return `the body carries a value for ${d.path.join(".")} but the Mcp-Param-${d.headerName} header is absent`;
    }
    const decoded = decodeHeaderValue(header);
    if (decoded === undefined) return `the Mcp-Param-${d.headerName} header carries an invalid Base64 sentinel value`;
    const same = d.type === "integer" && /^-?\d+(\.0+)?$/.test(decoded) ? Number(decoded) === Number(bodyValue) : decoded === bodyValue;
    if (!same) return `the body carries ${d.path.join(".")}=${JSON.stringify(bodyValue)} but the Mcp-Param-${d.headerName} header carries ${JSON.stringify(decoded)}`;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
