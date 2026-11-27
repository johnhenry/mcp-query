// Webhook receiver-side verification for the Events extension (Standard Webhooks profile). Signatures
// here are computed with node:crypto, independently of the implementation's WebCrypto.

import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateWebhookSecret, verifyEventWebhook, WebhookVerificationError } from "../src/server/index.js";

const NOW = 1_739_980_800_000; // 2025-02-19T16:00:00Z, ms
const secretBytes = randomBytes(32);
const SECRET = `whsec_${secretBytes.toString("base64")}`;

function sign(id: string, ts: number | string, body: string, key = secretBytes): string {
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}
const EVENT = JSON.stringify({ eventId: "evt_789", name: "incident.created", timestamp: "2026-02-19T16:00:00Z", data: { severity: "P1" }, cursor: "cursor_xyz" });
function headers(body: string, over: Record<string, string> = {}) {
  const ts = String(NOW / 1000);
  return { "webhook-id": "msg_abc", "webhook-timestamp": ts, "webhook-signature": sign("msg_abc", ts, body), "X-MCP-Subscription-Id": "sub_1", ...over };
}
const verify = (body: string, h: Record<string, string>, extra: Partial<Parameters<typeof verifyEventWebhook>[0]> = {}) =>
  verifyEventWebhook({ secret: SECRET, headers: h, body, now: () => NOW, ...extra });
const reason = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: WebhookVerificationError) => e)) as WebhookVerificationError | undefined;

describe("verifyEventWebhook", () => {
  it("accepts a correctly signed event and classifies it", async () => {
    const v = await verify(EVENT, headers(EVENT));
    expect(v.kind).toBe("event");
    expect(v.webhookId).toBe("msg_abc");
    expect(v.subscriptionId).toBe("sub_1");
    expect(v.timestamp).toBe(NOW / 1000);
    expect((v.payload as { eventId: string }).eventId).toBe("evt_789");
  });

  it("takes Headers objects and Uint8Array bodies", async () => {
    const h = new Headers(headers(EVENT));
    const v = await verifyEventWebhook({ secret: SECRET, headers: h, body: new TextEncoder().encode(EVENT), now: () => NOW });
    expect(v.kind).toBe("event");
  });

  it("is over the RAW body: a re-serialized (whitespace-changed) body fails", async () => {
    const h = headers(EVENT);
    const reformatted = JSON.stringify(JSON.parse(EVENT), null, 2);
    expect((await reason(verify(reformatted, h)))!.reason).toBe("bad_signature");
  });

  it("rejects a tampered body, a wrong secret, and a different webhook-id", async () => {
    expect((await reason(verify(EVENT.replace("P1", "P4"), headers(EVENT))))!.reason).toBe("bad_signature");
    const other = `whsec_${randomBytes(32).toString("base64")}`;
    expect((await reason(verify(EVENT, headers(EVENT), { secret: other })))!.reason).toBe("bad_signature");
    expect((await reason(verify(EVENT, headers(EVENT, { "webhook-id": "msg_other" }))))!.reason).toBe("bad_signature");
  });

  it("accepts any of several space-delimited signatures (rotation) and ignores unknown versions", async () => {
    const ts = String(NOW / 1000);
    const oldKey = randomBytes(24);
    const sigHeader = `${sign("msg_abc", ts, EVENT, oldKey)} v1a,AAAA ${sign("msg_abc", ts, EVENT)}`;
    expect((await verify(EVENT, headers(EVENT, { "webhook-signature": sigHeader }))).kind).toBe("event");
    // only an unknown scheme: nothing verifies
    expect((await reason(verify(EVENT, headers(EVENT, { "webhook-signature": "v1a,AAAA" }))))!.reason).toBe("bad_signature");
    // rotation on the receiver: either secret may verify
    const oldSecret = `whsec_${oldKey.toString("base64")}`;
    const v = await verify(EVENT, headers(EVENT, { "webhook-signature": sign("msg_abc", ts, EVENT, oldKey) }), { secret: [SECRET, oldSecret] });
    expect(v.kind).toBe("event");
  });

  it("rejects stale and future timestamps, and malformed ones", async () => {
    const mk = (ts: number) => headers(EVENT, { "webhook-timestamp": String(ts), "webhook-signature": sign("msg_abc", ts, EVENT) });
    expect((await reason(verify(EVENT, mk(NOW / 1000 - 301))))!.reason).toBe("stale");
    expect((await reason(verify(EVENT, mk(NOW / 1000 + 301))))!.reason).toBe("stale");
    expect((await verify(EVENT, mk(NOW / 1000 - 299))).kind).toBe("event");
    expect((await verify(EVENT, mk(NOW / 1000 - 3000), { toleranceSeconds: 3600 })).kind).toBe("event");
    expect((await reason(verify(EVENT, headers(EVENT, { "webhook-timestamp": "yesterday" }))))!.reason).toBe("bad_timestamp");
  });

  it("rejects missing headers and malformed secrets", async () => {
    const { "webhook-signature": _s, ...noSig } = headers(EVENT);
    expect((await reason(verify(EVENT, noSig)))!.reason).toBe("missing_header");
    expect((await reason(verify(EVENT, headers(EVENT), { secret: "nope" })))!.reason).toBe("bad_secret");
    expect((await reason(verify(EVENT, headers(EVENT), { secret: "whsec_" + randomBytes(8).toString("base64") })))!.reason).toBe("bad_secret");
    expect((await reason(verify(EVENT, headers(EVENT), { secret: "whsec_!!!" })))!.reason).toBe("bad_secret");
  });

  it("classifies the signed control envelopes: gap, terminated, verification", async () => {
    const mk = async (body: string) => {
      const ts = String(NOW / 1000);
      return verify(body, { "webhook-id": "msg_gap_x", "webhook-timestamp": ts, "webhook-signature": sign("msg_gap_x", ts, body) });
    };
    expect((await mk('{"type":"gap","cursor":"c9"}')).kind).toBe("gap");
    const t = await mk('{"type":"terminated","error":{"code":-32024,"message":"Forbidden"}}');
    expect(t.kind).toBe("terminated");
    expect((t.payload as { error: { code: number } }).error.code).toBe(-32024);
    expect((await mk('{"type":"verification","challenge":"n0nce"}')).kind).toBe("verification");
    expect((await reason(mk('{"type":"mystery"}')))!.reason).toBe("bad_body");
  });

  it("rejects a verified body that is not a JSON object", async () => {
    for (const body of ["not json", "[1]", "null"]) {
      const ts = String(NOW / 1000);
      expect((await reason(verify(body, { "webhook-id": "m", "webhook-timestamp": ts, "webhook-signature": sign("m", ts, body) })))!.reason).toBe("bad_body");
    }
  });

  it("generateWebhookSecret makes a valid whsec_ secret (24-64 bytes)", async () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(s.slice(6), "base64")).toHaveLength(32);
    expect(Buffer.from(generateWebhookSecret(64).slice(6), "base64")).toHaveLength(64);
    expect(() => generateWebhookSecret(8)).toThrow(RangeError);
    // and it verifies what it signs
    const key = Buffer.from(s.slice(6), "base64");
    const ts = String(NOW / 1000);
    const v = await verifyEventWebhook({ secret: s, headers: { "webhook-id": "m", "webhook-timestamp": ts, "webhook-signature": sign("m", ts, EVENT, key) }, body: EVENT, now: () => NOW });
    expect(v.kind).toBe("event");
  });
});
