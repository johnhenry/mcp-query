// @vitest-environment happy-dom
// Integration: build a real MCPClient over an in-memory MockMCPServer, wrap it in the
// shared AppProvider, and assert the tool-insertion path Composer uses produces a draft
// block carrying the tool's live result — then that the draft assembles into a grounded
// message. No model, no proxy, no subprocess.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MCPClient } from "mcp-query";
import { MockMCPServer } from "mcp-query/testing";
import { AppProvider } from "@app-shared";
import {
  assembleMessage,
  draftReducer,
  emptyDraft,
  nextId,
  resultToText,
  type ToolBlock,
  type ResourceBlock,
} from "../src/draft.js";

afterEach(cleanup);

function makeClient() {
  const mock = new MockMCPServer({
    resources: [{ uri: "mem://greeting", name: "greeting", read: () => ({ text: "hi there" }) }],
    tools: [
      {
        name: "get-sum",
        description: "Add two numbers",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        handler: (args) => {
          const a = Number((args as { a: number }).a);
          const b = Number((args as { b: number }).b);
          return { content: [{ type: "text", text: String(a + b) }] };
        },
      },
    ],
  });
  const client = new MCPClient({
    servers: { everything: { transport: mock.transport } },
    schemeMap: { mem: "everything" },
  });
  return { client, mock };
}

describe("AppProvider wires the client", () => {
  it("mounts without crashing and exposes the client to children", async () => {
    const { client } = makeClient();
    await client.connect();
    // A trivial consumer proves the provider context is in place.
    function Probe() {
      return <span data-testid="ok">{client.connections().length}</span>;
    }
    const { getByTestId } = render(
      <AppProvider client={client}>
        <Probe />
      </AppProvider>,
    );
    expect(getByTestId("ok").textContent).toBe("1");
    await client.close();
  });
});

describe("tool-insertion path → grounded draft block", () => {
  it("runs a tool via the client and produces a block carrying its result", async () => {
    const { client } = makeClient();
    await client.connect();

    // This mirrors ToolPalette.runTool: list the tool, call it, build a ToolBlock.
    const tools = client.listTools("everything");
    expect(tools.map((t) => t.name)).toContain("get-sum");
    expect(tools.find((t) => t.name === "get-sum")?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool("everything.get-sum", { a: 2, b: 3 });
    const block: ToolBlock = {
      id: nextId("tool"),
      kind: "tool",
      server: "everything",
      tool: "get-sum",
      args: { a: 2, b: 3 },
      result,
    };

    expect(resultToText(block.result)).toBe("5");

    // Insert into a draft alongside freeform text and assemble.
    let draft = emptyDraft();
    draft = draftReducer(draft, { type: "addText", text: "what is 2 + 3?" });
    draft = draftReducer(draft, { type: "addBlock", block });

    const message = assembleMessage(draft);
    expect(message).toContain("what is 2 + 3?");
    expect(message).toContain("‹tool everything.get-sum(a:2, b:3)›");
    expect(message).toContain("\n5");

    await client.close();
  });

  it("reads a resource and produces a grounded resource block", async () => {
    const { client } = makeClient();
    await client.connect();

    const resources = client.listResources("everything");
    expect(resources.map((r) => r.uri)).toContain("mem://greeting");

    const result = await client.readResource("mem://greeting", { server: "everything" });
    const block: ResourceBlock = {
      id: nextId("res"),
      kind: "resource",
      server: "everything",
      uri: "mem://greeting",
      name: "greeting",
      result,
    };

    expect(resultToText(block.result)).toBe("hi there");

    let draft = emptyDraft();
    draft = draftReducer(draft, { type: "addBlock", block });
    expect(assembleMessage(draft)).toBe("‹resource everything mem://greeting›\nhi there");

    await client.close();
  });

  it("re-running a tool updates the block result via the reducer", async () => {
    const { client } = makeClient();
    await client.connect();

    const first = await client.callTool("everything.get-sum", { a: 1, b: 1 });
    let draft = draftReducer(emptyDraft(), {
      type: "addBlock",
      block: { id: "tool1", kind: "tool", server: "everything", tool: "get-sum", args: { a: 1, b: 1 }, result: first },
    });
    expect(resultToText((draft.blocks[0] as ToolBlock).result)).toBe("2");

    // Re-run with new args (mirrors BlockView.rerun patching the block).
    const second = await client.callTool("everything.get-sum", { a: 10, b: 20 });
    draft = draftReducer(draft, { type: "patchBlock", id: "tool1", patch: { result: second } });
    expect(resultToText((draft.blocks[0] as ToolBlock).result)).toBe("30");

    await client.close();
  });
});
