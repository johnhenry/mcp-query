// A sampling handler backed by Chrome's built-in AI (the Prompt API / on-device
// Gemini Nano). Registering it advertises the `sampling` capability, letting connected
// MCP servers borrow the host's local model — no API key, private, free. See
// docs/sampling-and-non-agentic.md.
//
// The `LanguageModel` is injectable so this is testable without a browser. The real
// global API surface is still evolving; check current Chrome Prompt API docs.

import type { HostHandlers } from "../core/types.js";

// ── minimal structural types for the Prompt API (real ones are ambient globals) ──
export interface PromptSession {
  prompt(input: string): Promise<string>;
  destroy?(): void;
}
export interface LanguageModelLike {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts: {
    initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
  }): Promise<PromptSession>;
}

// ── MCP sampling shapes (subset of the spec we map) ──
type SamplingContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingContent;
}
export interface SamplingRequest {
  messages: SamplingMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  includeContext?: "none" | "thisServer" | "allServers";
  modelPreferences?: unknown;
}
export interface SamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason: string;
}

// JSON-RPC-ish error codes so a server sees a meaningful rejection.
export class ModelUnavailableError extends Error {
  code = -32601;
}
export class SamplingDeclinedError extends Error {
  code = -32001;
}

export interface ChromeSamplingOptions {
  /** Defaults to the global `LanguageModel`. Inject for testing / a custom provider. */
  languageModel?: LanguageModelLike;
  /** Human-in-the-loop gate; return false to decline. Omit to allow all (NOT for prod). */
  approve?: (req: SamplingRequest) => boolean | Promise<boolean>;
  /** Reported back as the result's `model`. Default "gemini-nano". */
  modelName?: string;
  /** Decline requests whose maxTokens exceed this on-device ceiling. Default: no limit. */
  maxTokensCeiling?: number;
}

/**
 * Build a `HostHandlers["sampling"]` that fulfills `sampling/createMessage` via Chrome's
 * built-in AI. Maps the MCP message history onto a Prompt API session and shapes the
 * reply back into a CreateMessageResult.
 */
export function chromeBuiltinAISampling(
  opts: ChromeSamplingOptions = {},
): NonNullable<HostHandlers["sampling"]> {
  const modelName = opts.modelName ?? "gemini-nano";

  return async (raw: unknown): Promise<SamplingResult> => {
    const req = raw as SamplingRequest;
    const lm =
      opts.languageModel ?? (globalThis as { LanguageModel?: LanguageModelLike }).LanguageModel;
    if (!lm) {
      throw new ModelUnavailableError("no LanguageModel available (Chrome built-in AI not present)");
    }

    // (a) availability gate — Gemini Nano may be downloadable/unavailable.
    if ((await lm.availability()) === "unavailable") {
      throw new ModelUnavailableError("local model unavailable");
    }

    // (b) capability mismatch — a tiny on-device model can't honor large requests.
    if (opts.maxTokensCeiling != null && req.maxTokens > opts.maxTokensCeiling) {
      throw new ModelUnavailableError(
        `request maxTokens ${req.maxTokens} exceeds local ceiling ${opts.maxTokensCeiling}`,
      );
    }

    // (c) human-in-the-loop — the server controls the prompt; gate it.
    if (opts.approve && !(await opts.approve(req))) {
      throw new SamplingDeclinedError("user declined sampling");
    }

    // (d) map messages -> session. System + prior turns prime the session; the final
    //     turn is the prompt input (the Prompt API expects a trailing user turn).
    const history = req.messages.slice(0, -1);
    const last = req.messages[req.messages.length - 1];
    const initialPrompts = [
      ...(req.systemPrompt ? [{ role: "system" as const, content: req.systemPrompt }] : []),
      ...history.map((m) => ({ role: m.role, content: textOf(m.content) })),
    ];

    const session = await lm.create({
      initialPrompts: initialPrompts.length ? initialPrompts : undefined,
      temperature: req.temperature,
    });
    try {
      const text = await session.prompt(last ? textOf(last.content) : "");
      return { role: "assistant", content: { type: "text", text }, model: modelName, stopReason: "endTurn" };
    } finally {
      session.destroy?.();
    }
  };
}

function textOf(content: SamplingContent): string {
  return content.type === "text" ? content.text : `[${content.type} content omitted]`;
}
