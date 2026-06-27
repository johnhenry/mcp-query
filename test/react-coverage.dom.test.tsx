// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { Suspense } from "react";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider } from "../src/react/provider.js";
import { useInteractions, useAuditLog } from "../src/react/interactions.js";
import { createTypedHooks } from "../src/react/typed.js";
import { usePrompt, usePromptList, useResourceList } from "../src/react/capabilities.js";
import { useResource } from "../src/react/useResource.js";
import { useTool } from "../src/react/useTool.js";
import { useServerState } from "../src/react/useServerState.js";

afterEach(cleanup);

const fullSpec = {
  tools: [{ name: "echo", handler: (a: Record<string, unknown>) => ({ content: [{ type: "text", text: String(a.msg) }] }) }],
  resources: [{ uri: "mem://doc", read: () => ({ text: "HELLO" }) }],
  prompts: [{ name: "greet", description: "greet", get: () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }) }],
};

async function setup(opts: { broker?: InteractionBroker } = {}) {
  const mock = new MockMCPServer(fullSpec);
  const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: opts.broker });
  await client.connect();
  return { client, mock };
}

describe("useInteractions / useAuditLog", () => {
  it("renders the pending queue and resolves it", async () => {
    const broker = new InteractionBroker();
    const { client } = await setup({ broker });
    const pending = broker.handleElicitation("srv", { message: "name?", requestedSchema: {} });

    function View() {
      const { interactions, resolve } = useInteractions();
      const audit = useAuditLog();
      return (
        <div>
          <span>q:{interactions.length}</span>
          <span>a:{audit.length}</span>
          {interactions.map((i) => (
            <button key={i.id} onClick={() => resolve(i.id, { action: "approve", content: { name: "Ada" } })}>ok</button>
          ))}
        </div>
      );
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    await waitFor(() => expect(screen.getByText("q:1")).toBeTruthy());
    fireEvent.click(screen.getByText("ok"));
    await expect(pending).resolves.toMatchObject({ action: "accept" });
    await waitFor(() => expect(screen.getByText("q:0")).toBeTruthy());
    await client.close();
  });

  it("no-ops gracefully when no broker is configured", async () => {
    const { client } = await setup();
    function View() {
      const { interactions } = useInteractions();
      return <span>q:{interactions.length}</span>;
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    expect(screen.getByText("q:0")).toBeTruthy();
    await client.close();
  });
});

describe("createTypedHooks", () => {
  it("produces a working typed useTool", async () => {
    const { client } = await setup();
    const { useTool: useTypedTool } = createTypedHooks<{ "srv.echo": { args: { msg: string }; result: { content: { text: string }[] } } }>();
    function View() {
      const [echo, { data }] = useTypedTool("srv.echo");
      return (
        <div>
          <button onClick={() => void echo({ msg: "typed" })}>go</button>
          <span>{data?.content?.[0]?.text ?? "-"}</span>
        </div>
      );
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByText("typed")).toBeTruthy());
    await client.close();
  });
});

describe("prompt + list hooks", () => {
  it("usePromptList, useResourceList, usePrompt render", async () => {
    const { client } = await setup();
    function View() {
      const { prompts } = usePromptList({ server: "srv" });
      const { resources } = useResourceList({ server: "srv" });
      const { messages } = usePrompt("greet", {}, "srv");
      return <span>{`${prompts.map((p) => p.name).join(",")}|${resources.length}|${messages ? "got" : "none"}`}</span>;
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    await waitFor(() => expect(screen.getByText(/greet\|1\|got/)).toBeTruthy());
    await client.close();
  });
});

describe("useResource suspense", () => {
  it("suspends then renders data", async () => {
    const { client } = await setup();
    function Doc() {
      const { data } = useResource<{ contents?: { text?: string }[] }>("mem://doc", { server: "srv", suspense: true });
      return <span>{data?.contents?.[0]?.text}</span>;
    }
    render(<MCPProvider client={client}><Suspense fallback={<span>loading</span>}><Doc /></Suspense></MCPProvider>);
    expect(screen.getByText("loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    await client.close();
  });
});

describe("useTool cancel/reset", () => {
  it("exposes cancel and reset that clear state", async () => {
    const { client } = await setup();
    function View() {
      const [echo, { data, cancel, reset }] = useTool<{ msg: string }, { content: { text: string }[] }>("srv.echo");
      return (
        <div>
          <button onClick={() => void echo({ msg: "x" })}>run</button>
          <button onClick={() => cancel()}>cancel</button>
          <button onClick={() => reset()}>reset</button>
          <span>{data?.content?.[0]?.text ?? "-"}</span>
        </div>
      );
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(screen.getByText("x")).toBeTruthy());
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(screen.getByText("-")).toBeTruthy());
    fireEvent.click(screen.getByText("cancel")); // no-op (nothing in flight) — must not throw
    await client.close();
  });
});

describe("useServerState transition", () => {
  it("reflects a state change when a server is removed", async () => {
    const { client } = await setup();
    function View() {
      const { state } = useServerState("srv");
      return <span>state:{state}</span>;
    }
    render(<MCPProvider client={client}><View /></MCPProvider>);
    await waitFor(() => expect(screen.getByText("state:ready")).toBeTruthy());
    await act(async () => { await client.removeServer("srv"); });
    await waitFor(() => expect(screen.getByText("state:idle")).toBeTruthy());
  });
});
