// @vitest-environment happy-dom
// useToolTask / useTask — task-augmented calls from React, driven end-to-end against
// MockMCPServer's task support.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider, useToolTask } from "../src/react/index.js";

afterEach(cleanup);

function Crunches() {
  const [start, state] = useToolTask<{ n: number }, { content: Array<{ text: string }> }>("crunch");
  return (
    <div>
      <button onClick={() => void start({ n: 5 })}>go</button>
      <span data-testid="status">{state.task?.status ?? "idle"}</span>
      <span data-testid="data">{state.data?.content[0]?.text ?? ""}</span>
    </div>
  );
}

describe("useToolTask", () => {
  it("starts a task, shows live status, and lands the result", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "crunch",
          task: true,
          taskDelayMs: 30,
          handler: (args) => ({ content: [{ type: "text", text: `crunched ${args.n}` }] }),
        },
      ],
      // Tasks are legacy-era-gated until the SDK ships the extension runtime.
    }, { era: "legacy" });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    render(
      <MCPProvider client={client}>
        <Crunches />
      </MCPProvider>,
    );

    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("working"));
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("crunched 5"), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("completed"), { timeout: 5000 });

    await client.close();
  });
});
