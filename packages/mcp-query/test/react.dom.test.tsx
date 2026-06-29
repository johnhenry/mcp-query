// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider } from "../src/react/provider.js";
import { useResource } from "../src/react/useResource.js";
import { useTool } from "../src/react/useTool.js";
import { useTools } from "../src/react/capabilities.js";

afterEach(cleanup);

async function makeClient() {
  const mock = new MockMCPServer({
    resources: [{ uri: "mem://doc", read: () => ({ text: "HELLO" }) }],
    tools: [
      { name: "shout", handler: (a) => ({ content: [{ type: "text", text: String((a as any).msg).toUpperCase() }] }) },
    ],
  });
  const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, schemeMap: { mem: "srv" } });
  await client.connect();
  return { client, mock };
}

describe("useResource", () => {
  it("transitions from loading to data", async () => {
    const { client } = await makeClient();
    function View() {
      const { data, isLoading } = useResource<any>("mem://doc", { server: "srv" });
      if (isLoading && !data) return <span>loading</span>;
      return <span>{data?.contents?.[0]?.text}</span>;
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    await client.close();
  });
});

describe("useTool", () => {
  it("invokes a tool and exposes the result", async () => {
    const { client } = await makeClient();
    function View() {
      const [shout, { data }] = useTool<{ msg: string }, any>("shout", { server: "srv" });
      return (
        <div>
          <button onClick={() => void shout({ msg: "hi" })}>go</button>
          <span>{data?.content?.[0]?.text ?? "—"}</span>
        </div>
      );
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByText("HI")).toBeTruthy());
    await client.close();
  });
});

describe("useTools reactivity", () => {
  it("re-renders when the server announces a tools/list change", async () => {
    const { client, mock } = await makeClient();
    function View() {
      const { tools } = useTools({ server: "srv" });
      return <span>{tools.map((t) => t.name).sort().join(",")}</span>;
    }
    render(
      <MCPProvider client={client}>
        <View />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("shout")).toBeTruthy());

    mock.spec.tools = [...(mock.spec.tools ?? []), { name: "whisper" }];
    await mock.notifyToolListChanged();

    await waitFor(() => expect(screen.getByText("shout,whisper")).toBeTruthy());
    await client.close();
  });
});
