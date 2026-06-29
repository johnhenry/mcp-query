// Illustrative React example (compiles under tsc; needs a bundler + DOM to actually
// run). Demonstrates every React surface: provider, reads, mutations, query-shaped
// tool reads, capability + template lists, connection state, the human-in-the-loop
// queue, and the devtools panel.

import { Suspense } from "react";
import { MCPClient, InteractionBroker, chromeBuiltinAISampling, persistCache } from "../src/index.js";
import { MCPProvider } from "../src/react/provider.js";
import { useResource } from "../src/react/useResource.js";
import { useTool } from "../src/react/useTool.js";
import { useToolResult } from "../src/react/useToolResult.js";
import { useTools, useResourceTemplates } from "../src/react/capabilities.js";
import { useServerState } from "../src/react/useServerState.js";
import { useInteractions } from "../src/react/interactions.js";
import { createTypedHooks } from "../src/react/typed.js";
import { MCPDevtools, DevtoolsHub } from "../src/devtools/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const hub = new DevtoolsHub();

const broker = new InteractionBroker({
  model: chromeBuiltinAISampling(),
  policy: ({ server }) => (server === "fs" ? "allow" : "ask"),
});

const client = new MCPClient({
  servers: {
    github: {
      // Auth is configured on the transport itself (OAuth 2.1 for Streamable HTTP).
      transport: () => new StreamableHTTPClientTransport(new URL("https://example.com/mcp")),
    },
  },
  interactions: broker,
  devtools: hub,
  retry: 2,
});

// Offline / restore: hydrate the cache from localStorage and keep it saved.
if (typeof localStorage !== "undefined") persistCache(client.cache, localStorage, { key: "demo" });

// Typed hooks from codegen output: `import type { GeneratedToolMap } from "./mcp.gen"`.
type GeneratedToolMap = { "github.create_issue": { args: { title: string }; result: { id: number } } };
const typed = createTypedHooks<GeneratedToolMap>();

export function App() {
  return (
    <MCPProvider client={client}>
      <ConnectionBadge />
      <Issues />
      <IssueSearch />
      <ToolPalette />
      <TypedCreate />
      <Templates />
      <Suspense fallback={<p>loading readme…</p>}>
        <Readme />
      </Suspense>
      <ApprovalCenter />
      <MCPDevtools hub={hub} />
    </MCPProvider>
  );
}

// Suspense + polling: throws to the boundary above; re-fetches every 10s.
function Readme() {
  const { data } = useResource<{ contents?: { text?: string }[] }>("github://readme", {
    server: "github",
    suspense: true,
    refetchInterval: 10_000,
  });
  return <pre>{data?.contents?.[0]?.text}</pre>;
}

// Fully-typed mutation from the generated tool map.
function TypedCreate() {
  const [create, { isPending, progress }] = typed.useTool("github.create_issue");
  return (
    <button disabled={isPending} onClick={() => void create({ title: "typed!" })}>
      create {progress ? `(${progress.progress})` : ""}
    </button>
  );
}

function ConnectionBadge() {
  const { state, isReady } = useServerState("github");
  return <div>github: {state}{isReady ? " ✓" : ""}</div>;
}

function Issues() {
  const { data, isLoading } = useResource<{ contents?: { text?: string }[] }>("github://repos/acme/app/issues", {
    server: "github",
    subscribe: true,
  });
  if (isLoading) return <p>loading…</p>;
  return <pre>{data?.contents?.[0]?.text}</pre>;
}

function IssueSearch() {
  // Query-shaped read of a read-only tool.
  const { data, isLoading } = useToolResult<{ q: string }, { content: { text?: string }[] }>(
    "github.search_issues",
    { q: "is:open" },
    { server: "github" },
  );
  return <div>{isLoading ? "searching…" : data?.content?.[0]?.text}</div>;
}

function ToolPalette() {
  const { tools } = useTools({ server: "github" });
  const [createIssue, { isPending, isDestructive }] = useTool<{ title: string }>("github.create_issue", {
    server: "github",
    invalidates: ["res:github:github://repos/acme/app/issues"],
  });
  return (
    <div>
      <ul>{tools.map((t) => <li key={t.name}>{t.name}</li>)}</ul>
      <button disabled={isPending} onClick={() => void createIssue({ title: "from mcp-query" })}>
        {isDestructive ? "⚠️ " : ""}create issue
      </button>
    </div>
  );
}

function Templates() {
  const { templates } = useResourceTemplates({ server: "github" });
  return <ul>{templates.map((t) => <li key={t.uriTemplate}>{t.name}: {t.uriTemplate}</li>)}</ul>;
}

function ApprovalCenter() {
  const { interactions, resolve } = useInteractions();
  return (
    <>
      {interactions.map((i) => (
        <dialog key={i.id} open>
          <p><b>{i.server}</b> requests <code>{i.type}</code> ({i.phase})</p>
          <pre>{JSON.stringify(i.payload, null, 2)}</pre>
          <button onClick={() => resolve(i.id, { action: "approve" })}>Approve</button>
          <button onClick={() => resolve(i.id, { action: "deny" })}>Deny</button>
        </dialog>
      ))}
    </>
  );
}
