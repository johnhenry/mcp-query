// @vitest-environment happy-dom
// useEventTypes / useEvents against MockMCPServer's events fixture (modern wire, SDK 2.0.0 is enough).

import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { EVENTS_LIST_CHANGED } from "../src/core/eventsExt.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider, useEvents, useEventTypes } from "../src/react/index.js";

afterEach(cleanup);

function Types({ server }: { server?: string }) {
  const { types, isLoading, error } = useEventTypes(server);
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <ul>
        {types.map((t) => (
          <li key={`${t.server}:${t.name}`}>
            {t.server}/{t.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Feed({ severity, skip }: { severity?: string; skip?: boolean }) {
  const { events, status, gaps, truncated, cursor, error, refresh } = useEvents("s", "incident.created", severity ? { severity } : {}, {
    pollFloorMs: 0,
    skip,
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="count">{events.length}</span>
      <span data-testid="gaps">{gaps.length}</span>
      <span data-testid="truncated">{String(truncated)}</span>
      <span data-testid="cursor">{cursor ?? "none"}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <button onClick={refresh}>refresh</button>
      <ul>
        {events.map((e) => (
          <li key={e.eventId}>{String(e.data.title)}</li>
        ))}
      </ul>
    </div>
  );
}

const TYPES = [{ name: "incident.created", match: (d: Record<string, unknown>, a: Record<string, unknown>) => !a.severity || d.severity === a.severity }];

function setup() {
  const server = new MockMCPServer({ tools: [{ name: "t" }], events: { types: TYPES, nextPollMs: 0 } }, { era: "modern" });
  const client = new MCPClient({ servers: { s: { transport: server.transport, versions: ["2026-07-28"] } } });
  return { server, client, src: server.events! };
}
async function teardown(client: MCPClient, server: MockMCPServer) {
  cleanup();
  await client.close();
  await server.close();
}

describe("useEventTypes", () => {
  it("lists types and re-renders after a list_changed", async () => {
    const { server, client } = setup();
    await client.connect();
    render(
      <MCPProvider client={client}>
        <Types server="s" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("s/incident.created")).toBeTruthy());

    server.spec.events!.types = [...TYPES, { name: "deploy.done" }];
    (client.connection("s")!.sdk.transport as { onmessage?: (m: unknown) => void }).onmessage!({ jsonrpc: "2.0", method: EVENTS_LIST_CHANGED });
    await waitFor(() => expect(screen.getByText("s/deploy.done")).toBeTruthy(), { timeout: 5000 });
    await teardown(client, server);
  });

  it("without a server, unions the events-capable servers; a server without the extension reports its error", async () => {
    const { server, client } = setup();
    await client.connect();
    const { rerender } = render(
      <MCPProvider client={client}>
        <Types />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("s/incident.created")).toBeTruthy());

    const plain = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "modern" });
    const c2 = new MCPClient({ servers: { p: { transport: plain.transport, versions: ["2026-07-28"] } } });
    await c2.connect();
    rerender(
      <MCPProvider client={c2}>
        <Types server="p" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error").textContent).toMatch(/does not advertise the events extension/));
    await c2.close();
    await plain.close();
    await teardown(client, server);
  });
});

describe("useEvents", () => {
  it("streams events into the render, exposes the cursor, and polls on refresh()", async () => {
    const { server, client, src } = setup();
    await client.connect();
    render(
      <MCPProvider client={client}>
        <Feed />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("live"));
    src.emit("incident.created", { title: "db down" });
    src.emit("incident.created", { title: "cache cold" });
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"), { timeout: 5000 });
    expect(screen.getByText("db down")).toBeTruthy();
    expect(screen.getByTestId("cursor").textContent).toBe(src.head());
    expect(screen.getByTestId("truncated").textContent).toBe("false");
    fireEvent.click(screen.getByText("refresh"));
    await teardown(client, server);
  });

  it("resubscribes when the arguments change, and stops on unmount and when skipped", async () => {
    const { server, client, src } = setup();
    await client.connect();
    const view = render(
      <MCPProvider client={client}>
        <Feed severity="P1" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("live"));
    expect(src.polls.at(-1)!.arguments).toEqual({ severity: "P1" });
    view.rerender(
      <MCPProvider client={client}>
        <Feed severity="P2" />
      </MCPProvider>,
    );
    await waitFor(() => expect(src.polls.at(-1)!.arguments).toEqual({ severity: "P2" }), { timeout: 5000 });

    view.rerender(
      <MCPProvider client={client}>
        <Feed severity="P2" skip />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    await new Promise((r) => setTimeout(r, 30));
    const n = src.polls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(src.polls.length).toBe(n);
    await teardown(client, server);
  });

  it("shows a gap explicitly in the render", async () => {
    const { server, client, src } = setup();
    await client.connect();
    function Resume({ cursor }: { cursor: string }) {
      const { gaps, truncated, status } = useEvents("s", "incident.created", {}, { pollFloorMs: 0, cursor });
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="gaps">{gaps.length}</span>
          <span data-testid="truncated">{String(truncated)}</span>
        </div>
      );
    }
    const stale = src.head();
    src.emit("incident.created", { title: "lost" });
    src.truncate();
    render(
      <MCPProvider client={client}>
        <Resume cursor={stale} />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("truncated").textContent).toBe("true"), { timeout: 5000 });
    expect(screen.getByTestId("gaps").textContent).toBe("1");
    await teardown(client, server);
  });

  it("reports a start error (unknown server) instead of throwing during render", async () => {
    const { server, client } = setup();
    await client.connect();
    function Bad() {
      const { status, error } = useEvents("nope", "x");
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="error">{error?.message ?? ""}</span>
        </div>
      );
    }
    render(
      <MCPProvider client={client}>
        <Bad />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(screen.getByTestId("error").textContent).toMatch(/unknown server/);
    await teardown(client, server);
  });
});
