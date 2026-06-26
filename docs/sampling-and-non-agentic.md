# Sampling, and why "non-agentic" ≠ "no LLM"

An earlier framing of this project said: *"non-agentic apps usually have no LLM, so omit
the sampling handler."* That conflated two different things. This note corrects it,
because plugging an LLM (e.g. Chrome's built-in AI) into a non-agentic app is a genuinely
good fit.

## Two distinct things that both involve "plugging in an AI"

**1. Your app uses AI for its own features.** A non-agentic app can call an LLM —
summarize a field, classify input — by calling the model directly (e.g. Chrome's Prompt
API / on-device Gemini Nano). **MCP is not involved.** "Non-agentic" only means the app's
control flow is deterministic/user-driven, not that the app is LLM-free.

**2. An MCP *server* needs an LLM and borrows yours.** This is what **sampling** is — a
server→client `sampling/createMessage` request. A server that ships no model/API key asks
the host to run a completion on its behalf. Omitting the handler is right only if you have
no model to lend *and* don't want servers using one.

**Sampling is orthogonal to agentic-ness.** And on-device models make it *more* attractive
for embedded apps, not less: local, free, private, no API key. The original advice was
backwards for that world.

## Wiring Chrome built-in AI into the sampling handler

Registration *is* advertisement in MCP — provide the handler and connected servers may
request completions; omit it and they're told you can't. (API surface for Chrome's Prompt
API is still evolving; check current docs.)

```ts
const client = new MCPClient({
  servers: { /* … */ },
  handlers: {
    sampling: async (req) => {
      // req: { messages, systemPrompt?, maxTokens?, temperature?, modelPreferences?, includeContext? }

      // (a) availability gate — Gemini Nano may be "downloadable"/"unavailable"
      if ((await LanguageModel.availability()) !== "available") {
        throw { code: -32601, message: "no local model available" };
      }

      // (b) HUMAN-IN-THE-LOOP — the spec recommends approval; a server controls the prompt
      // and could prompt-inject or exfiltrate. Show the user what's being asked.
      if (!(await confirmSamplingUI(req.messages))) {
        throw { code: -32001, message: "user declined sampling" };
      }

      // (c) map MCP messages -> Prompt API session
      const session = await LanguageModel.create({
        initialPrompts: [
          ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
          ...req.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : m.content.text ?? "",
          })),
        ],
        temperature: req.temperature,
      });
      const text = await session.prompt("");
      session.destroy();

      // (d) shape back into a CreateMessageResult
      return { role: "assistant", content: { type: "text", text }, model: "gemini-nano", stopReason: "endTurn" };
    },
  },
});
```

## Caveats that matter

- **Human-in-the-loop / trust.** The spec leans hard on user approval for sampling
  precisely because a malicious/compromised server controls the prompt. Auto-approve only
  trusted local servers; gate everything else.
- **Capability mismatch.** An on-device model is one small model with a modest context
  window. `maxTokens` and `modelPreferences` (cost/speed/intelligence hints) mostly can't
  be honored — map what you can, or *decline* requests too heavy for the local model.
- **`includeContext`.** A server can ask you to fold in context from `thisServer` /
  `allServers`. The client decides what's safe to include — don't blindly forward.
- **Availability lifecycle.** `"downloadable"` implies a large first-use download; design
  real UX for it rather than hanging.

## Status in this repo

Implemented. `chromeBuiltinAISampling()` lives in
[`src/handlers/chromeAI.ts`](../src/handlers/chromeAI.ts) (exported from the package root)
with an injectable `LanguageModel` (so it's testable without a browser), an availability
gate, a `maxTokensCeiling` decline, and an `approve` human-in-the-loop hook. Registering
it advertises the `sampling` capability.

```ts
import { MCPClient, chromeBuiltinAISampling } from "mcp-query";

const client = new MCPClient({
  servers: { /* … */ },
  handlers: {
    sampling: chromeBuiltinAISampling({
      approve: (req) => confirmSamplingUI(req.messages), // human-in-the-loop
      maxTokensCeiling: 1024,                             // decline oversized requests
    }),
  },
});
```

`test/sampling.test.ts` covers it both as a unit (mapping, availability, decline, token
ceiling, session cleanup) and as a full **round-trip through the client** — a mock server
calls `sampling/createMessage`, the handler fulfills it via a fake `LanguageModel`, and the
sampled text flows back as the tool result.
