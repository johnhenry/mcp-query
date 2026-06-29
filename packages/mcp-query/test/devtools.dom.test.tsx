// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider } from "../src/react/provider.js";
import { MCPDevtools } from "../src/devtools/Panel.js";
import { DevtoolsHub } from "../src/devtools/protocol.js";

afterEach(cleanup);

describe("MCPDevtools panel", () => {
  it("renders all panes and resolves a pending interaction", async () => {
    const hub = new DevtoolsHub();
    const broker = new InteractionBroker();
    const mock = new MockMCPServer({
      tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
      resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker, devtools: hub });
    await client.connect();
    await client.readResource("mem://a"); // seed a cache entry + traffic
    const pending = broker.handleElicitation("srv", { message: "go?", requestedSchema: {} });

    render(<MCPProvider client={client}><MCPDevtools hub={hub} /></MCPProvider>);

    // all panes present
    await waitFor(() => expect(screen.getByText("Servers")).toBeTruthy());
    expect(screen.getByText("Capabilities")).toBeTruthy();
    expect(screen.getByText("Cache")).toBeTruthy();
    expect(screen.getByText("Messages & events")).toBeTruthy();
    expect(screen.getByText("Pending interactions")).toBeTruthy();

    // the connected server + its read-only tool show up
    expect(screen.getAllByText("srv").length).toBeGreaterThan(0);
    expect(screen.getByText("echo")).toBeTruthy();

    // approving the pending interaction resolves it and clears the queue
    fireEvent.click(screen.getByText("approve"));
    await expect(pending).resolves.toMatchObject({ action: "accept" });
    await client.close();
  });
});
