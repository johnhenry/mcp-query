// 06 · TanStack bridge, headless — mcp-query-tanstack's queryOptions factories
// driven in plain Node (QueryClient.fetchQuery is what useQuery wraps): the
// tool list and a read-only tool call land in TanStack Query's cache under
// stable keys, with the fetch itself delegated to mcp-query's own cache.
// Run: npm run example:06   (from the repo root; `npm run build` first)

import { QueryClient } from "@tanstack/react-query";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { mcpqToolListQueryOptions, mcpqToolQueryOptions } from "@johnhenry/mcp-query-tanstack";

const mock = new MockMCPServer({
  tools: [
    {
      name: "search",
      annotations: { readOnlyHint: true }, // queryTool only bridges READ-ONLY tools
      handler: (a) => ({ content: [{ type: "text", text: `found:${a.q}` }] }),
    },
  ],
});

const client = new MCPClient({ servers: { docs: { transport: mock.transport } } });
await client.connect();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

const listOpts = mcpqToolListQueryOptions(client, "docs");
console.log("list queryKey:", listOpts.queryKey); // [ 'mcp-query', 'docs', 'toolList' ]
const tools = await queryClient.fetchQuery(listOpts);
console.log("tools:", tools.map((t) => t.name));

const searchOpts = mcpqToolQueryOptions(client, "docs.search", { q: "cats" });
console.log("tool queryKey:", searchOpts.queryKey); // [ 'mcp-query', 'docs', 'toolResult', 'search', argsHash({ q: 'cats' }) ]
const result = (await queryClient.fetchQuery(searchOpts)) as { content: { text: string }[] };
console.log("result:", result.content[0]?.text); // found:cats

// Same key, no refetch: TanStack (staleTime) and mcp-query (its cache) both hold it.
console.log("cached:", queryClient.getQueryData(searchOpts.queryKey) === result);

queryClient.clear();
await client.close();
await mock.close();
