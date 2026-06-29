// 07 · Hybrid: agent + UI in one app (illustrative; compiles, needs a bundler/DOM + an
// LLM to run). The pattern: an LLM agent *acts* (chooses and calls MCP tools), while
// mcp-query is the *reactive read layer* over the same servers — the UI stays live with
// whatever the agent does, and the InteractionBroker mediates the agent's sampling /
// elicitation through human approval. Non-agentic UI + agentic actions, side by side.

import { useState } from "react";
import { MCPClient, InteractionBroker } from "../src/index.js";
import { MCPProvider, useMCPClient } from "../src/react/provider.js";
import { useResource } from "../src/react/useResource.js";
import { useInteractions } from "../src/react/interactions.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The agent borrows the host's model via the broker; the human approves each use.
const broker = new InteractionBroker({ policy: () => "ask" /* model: chromeBuiltinAISampling() */ });

const client = new MCPClient({
  servers: { workspace: { transport: () => new StreamableHTTPClientTransport(new URL("https://example.com/mcp")) } },
  interactions: broker,
});

export function App() {
  return (
    <MCPProvider client={client}>
      <AgentChat />
      <LiveWorkspace />   {/* updates as the agent calls tools — no manual refresh */}
      <ApprovalCenter />  {/* the agent's sampling/elicitation requests land here */}
    </MCPProvider>
  );
}

// A tiny agent loop. In reality this is your LLM (Anthropic SDK / Vercel AI SDK / etc.)
// deciding which MCP tools to call. mcp-query and the agent share the SAME `client`, so
// every tool the agent runs flows through mcp-query's cache + invalidation.
function AgentChat() {
  const client = useMCPClient();
  const [log, setLog] = useState<string[]>([]);

  async function run(goal: string) {
    setLog((l) => [...l, `you: ${goal}`]);
    // … LLM picks a tool from client.listTools("workspace") and arguments from inputSchema …
    const result = await client.callTool("workspace.create_task", { title: goal }, {
      invalidates: ["res:workspace:workspace://tasks"], // keep the live view below in sync
    });
    setLog((l) => [...l, `agent → create_task → ${JSON.stringify(result)}`]);
  }

  return (
    <div>
      <button onClick={() => void run("write the README")}>send goal</button>
      <ol>{log.map((line, i) => <li key={i}>{line}</li>)}</ol>
    </div>
  );
}

// Pure read layer — re-renders whenever the agent (or anyone) changes the resource.
function LiveWorkspace() {
  const { data } = useResource<{ contents?: { text?: string }[] }>("workspace://tasks", {
    server: "workspace",
    subscribe: true,
  });
  return <pre>{data?.contents?.[0]?.text ?? "no tasks yet"}</pre>;
}

function ApprovalCenter() {
  const { interactions, resolve } = useInteractions();
  return (
    <>
      {interactions.map((i) => (
        <dialog key={i.id} open>
          The agent on <b>{i.server}</b> requests <code>{i.type}</code>.
          <button onClick={() => resolve(i.id, { action: "approve" })}>allow</button>
          <button onClick={() => resolve(i.id, { action: "deny" })}>deny</button>
        </dialog>
      ))}
    </>
  );
}
