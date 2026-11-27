// Verifier for Events-extension webhook deliveries (io.modelcontextprotocol/events, SEP-3415).
// Webhook delivery is server-to-server: the MCP server POSTs signed events to a callback URL the
// client registered with `events/subscribe`. This is the receiver-side check, exactly as the
// spec's "Signature scheme (Standard Webhooks profile)" defines it:
//   https://github.com/modelcontextprotocol/ext-events/blob/c77b843/specification/beta/events/events.mdx
//
//   signature = base64( HMAC-SHA256( secret, webhook-id + "." + webhook-timestamp + "." + rawBody ) )
//   header    = "v1," + signature   (several, space-delimited, during secret rotation)
//   secret    = the bytes of base64-decode(value after the "whsec_" prefix), 24 to 64 bytes
//
// The HMAC is over the RAW body bytes: pass the body exactly as received, never a re-serialized
// object. Deliveries older than 5 minutes are rejected (replay). Unknown signature versions
// (e.g. the optional asymmetric `v1a,`) are ignored, never trusted. Uses WebCrypto only.
//
// This module verifies and classifies a delivery. It does not subscribe, refresh, route by
// `X-MCP-Subscription-Id`, dedupe on `webhook-id`, or answer a `verification` challenge: those are
// the receiver's job (and `events/subscribe` itself is not driven by mcp-query yet).

export type WebhookFailure = "missing_header" | "bad_secret" | "bad_timestamp" | "stale" | "bad_signature" | "bad_body";

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
  constructor(
    readonly reason: WebhookFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifyEventWebhookOptions {
  /** The `whsec_...` signing secret registered for this subscription; pass several during rotation. */
  secret: string | readonly string[];
  /** The request headers (`Headers`, or a plain object with any casing). */
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The raw request body exactly as received. */
  body: string | Uint8Array;
  /** Maximum clock skew / age in seconds. Default 300 (the spec's 5 minutes). */
  toleranceSeconds?: number;
  /** Clock override (ms since epoch), for tests. */
  now?: () => number;
}

/** What a verified delivery is: an event, or one of the signed control envelopes. */
export type VerifiedWebhook =
  | { kind: "event"; webhookId: string; subscriptionId?: string; timestamp: number; payload: { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor?: string | null; [k: string]: unknown } }
  | { kind: "gap"; webhookId: string; subscriptionId?: string; timestamp: number; payload: { type: "gap"; cursor: string | null; [k: string]: unknown } }
  | { kind: "terminated"; webhookId: string; subscriptionId?: string; timestamp: number; payload: { type: "terminated"; error: { code: number; message: string; data?: unknown }; [k: string]: unknown } }
  | { kind: "verification"; webhookId: string; subscriptionId?: string; timestamp: number; payload: { type: "verification"; challenge: string; [k: string]: unknown } };

const SECRET_PREFIX = "whsec_";
const enc = new TextEncoder();

/** A fresh `whsec_` secret (32 random bytes). Spec: the client generates it; the server never does. */
export function generateWebhookSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 64) throw new RangeError("a whsec_ secret is 24 to 64 random bytes");
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Verify a webhook delivery and classify its body. Throws {@link WebhookVerificationError}
 * (never returns an unverified payload). Respond `2xx` only after durably accepting the event.
 */
export async function verifyEventWebhook(opts: VerifyEventWebhookOptions): Promise<VerifiedWebhook> {
  const get = headerReader(opts.headers);
  const webhookId = get("webhook-id");
  const tsHeader = get("webhook-timestamp");
  const sigHeader = get("webhook-signature");
  if (!webhookId || !tsHeader || !sigHeader) {
    throw new WebhookVerificationError("missing_header", "missing webhook-id, webhook-timestamp or webhook-signature");
  }

  const ts = /^\d+$/.test(tsHeader) ? Number(tsHeader) : NaN;
  if (!Number.isSafeInteger(ts)) throw new WebhookVerificationError("bad_timestamp", "webhook-timestamp is not a Unix timestamp in seconds");
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new WebhookVerificationError("stale", `webhook-timestamp is outside the ${tolerance}s window`);
  }

  const bodyBytes = typeof opts.body === "string" ? enc.encode(opts.body) : opts.body;
  const prefix = enc.encode(`${webhookId}.${tsHeader}.`); // the header as received (it is what was signed)
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);

  const secrets = (typeof opts.secret === "string" ? [opts.secret] : [...opts.secret]).map(decodeSecret);
  const candidates = sigHeader
    .split(/\s+/)
    .filter((p) => p.startsWith("v1,"))
    .map((p) => fromBase64(p.slice(3)))
    .filter((b): b is Uint8Array => b !== undefined);

  let ok = false;
  for (const raw of secrets) {
    const key = await crypto.subtle.importKey("raw", raw as never, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    for (const sig of candidates) {
      // subtle.verify compares in constant time.
      if (await crypto.subtle.verify("HMAC", key, sig as never, signed as never)) ok = true;
    }
  }
  if (!ok) throw new WebhookVerificationError("bad_signature", "no webhook-signature matched");

  let payload: unknown;
  try {
    payload = JSON.parse(typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body));
  } catch {
    throw new WebhookVerificationError("bad_body", "the verified body is not JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new WebhookVerificationError("bad_body", "the verified body is not a JSON object");
  }
  const base = { webhookId, subscriptionId: get("x-mcp-subscription-id"), timestamp: ts };
  // Spec: a body with a top-level `type` is a control envelope; without one it is an EventOccurrence.
  const type = (payload as { type?: unknown }).type;
  if (type === undefined) return { kind: "event", ...base, payload: payload as never };
  if (type === "gap" || type === "terminated" || type === "verification") return { kind: type, ...base, payload: payload as never };
  throw new WebhookVerificationError("bad_body", `unknown control envelope type ${JSON.stringify(type)}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function headerReader(headers: VerifyEventWebhookOptions["headers"]): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === "function") return (n) => (headers as Headers).get(n) ?? undefined;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (v !== undefined) lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(" ") : v);
  }
  return (n) => lower.get(n);
}

function decodeSecret(secret: string): Uint8Array {
  if (!secret.startsWith(SECRET_PREFIX)) throw new WebhookVerificationError("bad_secret", `secret must start with "${SECRET_PREFIX}"`);
  const raw = fromBase64(secret.slice(SECRET_PREFIX.length));
  if (!raw || raw.length < 24 || raw.length > 64) {
    throw new WebhookVerificationError("bad_secret", `secret must be "${SECRET_PREFIX}" + base64 of 24 to 64 bytes`);
  }
  return raw;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array | undefined {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}
