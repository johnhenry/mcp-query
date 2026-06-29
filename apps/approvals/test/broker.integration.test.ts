// Integration test: drive a real InteractionBroker (no React) the way the UI does.
// We enqueue interactions by calling the broker's public server entry points
// (handleSampling / handleElicitation), then settle them with resolve() — exactly
// what useInteractions().resolve(id, decision) does in the app.

import { describe, it, expect } from "vitest";
import { InteractionBroker, type AuditEntry, type InteractionDecision } from "mcp-query";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Resolve the single pending interaction and assert it was there. */
async function settleNext(broker: InteractionBroker, decision: InteractionDecision): Promise<void> {
  await tick();
  const pending = broker.list();
  expect(pending.length).toBeGreaterThan(0);
  broker.resolve(pending[0]!.id, decision);
  await tick();
}

describe("InteractionBroker — approval flows", () => {
  it("enqueues a manual sampling interaction and approving with an authored result settles it", async () => {
    const audit: AuditEntry[] = [];
    const broker = new InteractionBroker({ manualSampling: true, onAudit: (e) => audit.push(e) });

    const call = broker.handleSampling("everything", {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      maxTokens: 100,
    });
    await tick();

    // It appears in the queue as a manual request-phase sampling interaction.
    const queued = broker.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.type).toBe("sampling");
    expect(queued[0]!.phase).toBe("request");
    expect(queued[0]!.manual).toBe(true);
    expect(queued[0]!.server).toBe("everything");

    // Human authors the response (editedResult) and approves.
    const authored = {
      role: "assistant",
      content: { type: "text", text: "hello back" },
      model: "human-in-the-loop",
      stopReason: "endTurn",
    };
    broker.resolve(queued[0]!.id, { action: "approve", editedResult: authored });

    const result = await call;
    expect(result).toEqual(authored);
    expect(broker.list()).toHaveLength(0);

    const log = broker.auditLog();
    expect(log.at(-1)?.outcome).toBe("approved");
    expect(log.at(-1)?.type).toBe("sampling");
    // onAudit sink received the same entry.
    expect(audit.at(-1)?.outcome).toBe("approved");
  });

  it("enqueues an elicitation interaction and approving returns the user's content", async () => {
    const broker = new InteractionBroker({});

    const call = broker.handleElicitation("everything", {
      message: "Need your name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
    await tick();

    const queued = broker.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.type).toBe("elicitation");

    broker.resolve(queued[0]!.id, { action: "approve", content: { name: "Ada" } });

    const result = await call;
    expect(result).toEqual({ action: "accept", content: { name: "Ada" } });
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
  });

  it("denying an elicitation declines and records the reason in the audit log", async () => {
    const broker = new InteractionBroker({});
    const call = broker.handleElicitation("everything", {
      message: "Need your SSN",
      requestedSchema: { type: "object", properties: {} },
    });
    await settleNext(broker, { action: "deny", reason: "too sensitive" });

    const result = await call;
    expect(result).toEqual({ action: "decline" });
    const last = broker.auditLog().at(-1);
    expect(last?.outcome).toBe("denied");
    expect(last?.reason).toBe("too sensitive");
  });

  it("denying a manual sampling request rejects the underlying call", async () => {
    const broker = new InteractionBroker({ manualSampling: true });
    const call = broker.handleSampling("everything", {
      messages: [{ role: "user", content: { type: "text", text: "do something risky" } }],
      maxTokens: 50,
    });
    // Attach the rejection assertion *before* settling so the rejection is never
    // momentarily unhandled (which Vitest would flag as an unhandled rejection).
    const rejects = expect(call).rejects.toThrow();
    await settleNext(broker, { action: "deny", reason: "not allowed" });
    await rejects;
    expect(broker.auditLog().at(-1)?.outcome).toBe("denied");
  });

  it("a policy verdict of allow auto-approves without queuing", async () => {
    const broker = new InteractionBroker({ policy: () => "allow" });
    const result = await broker.handleElicitation("everything", {
      message: "trusted",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result).toEqual({ action: "accept", content: {} });
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-allow");
  });

  it("response review (reviewResponses) lets a human redact the model result", async () => {
    const model = async () => ({
      role: "assistant" as const,
      content: { type: "text" as const, text: "SECRET: 1234" },
      model: "fake",
      stopReason: "endTurn",
    });
    const broker = new InteractionBroker({ model, reviewResponses: true });

    const call = broker.handleSampling("everything", {
      messages: [{ role: "user", content: { type: "text", text: "leak it" } }],
      maxTokens: 50,
    });

    // Phase 1: request approval (allow the messages through to the model).
    await settleNext(broker, { action: "approve" });

    // Phase 2: response review — redact before it returns to the server.
    const redacted = {
      role: "assistant",
      content: { type: "text", text: "[REDACTED]" },
      model: "fake",
      stopReason: "endTurn",
    };
    await settleNext(broker, { action: "approve", editedResult: redacted });

    const result = await call;
    expect(result).toEqual(redacted);
  });
});
