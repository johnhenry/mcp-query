// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider } from "../src/react/provider.js";
import { useToolResult } from "../src/react/useToolResult.js";
import { useServerState } from "../src/react/useServerState.js";
import { useResourceTemplates } from "../src/react/capabilities.js";

afterEach(cleanup);

async function makeClient() {
  const mock = new MockMCPServer({
    tools: [
      {
        name: "search",
        annotations: { readOnlyHint: true },
        handler: (a) => ({ content: [{ type: "text", text: `found ${(a as { q: string }).q}` }] }),
      },
    ],
    templates: [{ uriTemplate: "note://{id}", name: "note" }],
  });
  const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
  await client.connect();
  return { client, mock };
}

describe("useToolResult", () => {
  it("auto-runs a read-only tool and renders the result", async () => {
    const { client } = await makeClient();
    function View() {
      const { data, isLoading } = useToolResult<{ q: string }, { content: { text: string }[] }>(
        "search",
        { q: "kittens" },
        { server: "srv" },
      );
      if (isLoading && !data) return <span>loading</span>;
      return <span>{data?.content?.[0]?.text}</span>;
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("found kittens")).toBeTruthy());
    await client.close();
  });
});

describe("useServerState", () => {
  it("reports the connection lifecycle", async () => {
    const { client } = await makeClient();
    function View() {
      const { state, isReady } = useServerState("srv");
      return <span>{state}{isReady ? "!" : ""}</span>;
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("ready!")).toBeTruthy());
    await client.close();
  });
});

describe("useResourceTemplates", () => {
  it("renders the template catalog", async () => {
    const { client } = await makeClient();
    function View() {
      const { templates } = useResourceTemplates({ server: "srv" });
      return <span>{templates.map((t) => t.uriTemplate).join(",")}</span>;
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("note://{id}")).toBeTruthy());
    await client.close();
  });
});
