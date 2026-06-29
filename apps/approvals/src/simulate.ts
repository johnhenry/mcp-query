// "Simulate agent action" — generate real interactions in the queue.
//
// Preferred path: call one of server-everything's trigger tools, which makes the
// *server* send a real sampling/createMessage or elicitation/create request back
// to us. The broker intercepts it and enqueues an Interaction for human review.
//
// Fallback path: if those tools aren't available (older server build, offline),
// drive the broker's public entry points directly so the UI is still demonstrable.

import { broker, client, EVERYTHING_SERVER } from "./broker.js";
import type { InteractionType } from "mcp-query";

const SAMPLING_TOOL = "trigger-sampling-request";
const ELICITATION_TOOL = "trigger-elicitation-request";

/** Names of tools the connected server exposes (best-effort). */
export function availableTools(): string[] {
  try {
    return client
      .connections()
      .flatMap((c) => [...c.tools.values()])
      .map((t) => t.name);
  } catch {
    return [];
  }
}

function hasTool(name: string): boolean {
  return availableTools().includes(name);
}

/**
 * Trigger a real interaction of the given kind.
 * Returns a label describing what path was taken. The returned promise resolves
 * once the underlying server call settles (i.e. after the human approves/denies).
 */
export async function simulate(kind: InteractionType): Promise<string> {
  if (kind === "sampling") {
    if (hasTool(SAMPLING_TOOL)) {
      void callToolDetached(SAMPLING_TOOL, { prompt: "Summarize the latest deploy.", maxTokens: 100 });
      return `Server ${EVERYTHING_SERVER} → ${SAMPLING_TOOL} (real sampling request)`;
    }
    void injectSyntheticSampling();
    return "Synthetic sampling interaction (fallback)";
  }

  if (kind === "elicitation") {
    if (hasTool(ELICITATION_TOOL)) {
      void callToolDetached(ELICITATION_TOOL, {});
      return `Server ${EVERYTHING_SERVER} → ${ELICITATION_TOOL} (real elicitation request)`;
    }
    void injectSyntheticElicitation();
    return "Synthetic elicitation interaction (fallback)";
  }

  // confirm
  void injectSyntheticConfirm();
  return "Synthetic confirm interaction";
}

/** Fire a tool call without awaiting its (human-gated) completion. Errors are swallowed. */
function callToolDetached(tool: string, args: Record<string, unknown>): Promise<void> {
  return client
    .callTool(`${EVERYTHING_SERVER}.${tool}`, args)
    .then(() => {})
    .catch(() => {
      /* tool will reject if the human denies — that's expected, audit captures it */
    });
}

// ── synthetic fallbacks (drive the broker's public API directly) ────────────

function injectSyntheticSampling(): Promise<void> {
  return broker
    .handleSampling(EVERYTHING_SERVER, {
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Draft a customer apology email for the outage." },
        },
      ],
      systemPrompt: "You are a careful, on-brand communications assistant.",
      maxTokens: 200,
      temperature: 0.7,
    })
    .then(() => {})
    .catch(() => {});
}

function injectSyntheticElicitation(): Promise<void> {
  return broker
    .handleElicitation(EVERYTHING_SERVER, {
      message: "The agent needs your shipping details to place the order.",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Full name", description: "Recipient name" },
          address: { type: "string", title: "Address", description: "Street address" },
          express: { type: "boolean", title: "Express shipping", description: "Pay extra for 2-day" },
        },
        required: ["name", "address"],
      },
    })
    .then(() => {})
    .catch(() => {});
}

function injectSyntheticConfirm(): Promise<void> {
  // The broker has no dedicated confirm entry point yet; model it as an elicitation
  // with an empty schema so the human just allows/denies.
  return broker
    .handleElicitation(EVERYTHING_SERVER, {
      message: "Agent wants to delete the staging database. Confirm?",
      requestedSchema: { type: "object", properties: {} },
    })
    .then(() => {})
    .catch(() => {});
}
