// Integration test: a real MCPClient wired to a MockMCPServer (over InMemoryTransport)
// emulating a couple of SocialGPT tools, with a component rendering their data via the
// library hooks. Asserts the search list and the follower-history chart render.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MCPClient } from "mcp-query";
import { MCPProvider, useToolResult } from "mcp-query/react";
import { MockMCPServer } from "mcp-query/testing";
import { asList, asSeries, displayName } from "../src/lib/format.js";
import { LineChart } from "../src/components/LineChart.js";

afterEach(() => cleanup());

function makeServer(): MockMCPServer {
  return new MockMCPServer({
    tools: [
      {
        name: "search",
        description: "Search creators",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        handler: (args) => ({
          results: [
            { id: "c1", display_name: `Ada (${args.query})`, followers: 1200 },
            { id: "c2", display_name: "Babbage", followers: 800 },
          ],
        }),
      },
      {
        name: "get_follower_history",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: () => ({
          history: [
            { date: "2026-01-01", count: 100 },
            { date: "2026-01-02", count: 140 },
            { date: "2026-01-03", count: 210 },
          ],
        }),
      },
    ],
  });
}

function makeClient(server: MockMCPServer): MCPClient {
  return new MCPClient({
    servers: { socialgpt: { transport: server.transport } },
    clientInfo: { name: "socialgpt-studio-test", version: "0.0.0" },
  });
}

function SearchList() {
  const { data, isLoading, error } = useToolResult("search", { query: "ml" }, { server: "socialgpt" });
  if (error) return <div>error: {String(error.message ?? error)}</div>;
  if (isLoading && !data) return <div>loading…</div>;
  const rows = asList(data);
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={i} data-testid="creator">
          {displayName(r)}
        </li>
      ))}
    </ul>
  );
}

function FollowerChart() {
  const { data } = useToolResult("get_follower_history", { id: "c1" }, { server: "socialgpt" });
  const series = asSeries(data);
  if (series.length === 0) return <div>no data</div>;
  return (
    <div data-testid="chart">
      <span data-testid="points">{series.length}</span>
      <LineChart data={series} title="Followers" />
    </div>
  );
}

describe("SocialGPT Studio integration (MockMCPServer + MCPClient)", () => {
  it("renders search results from the emulated `search` tool", async () => {
    const server = makeServer();
    const client = makeClient(server);
    await client.connect();

    render(
      <MCPProvider client={client}>
        <SearchList />
      </MCPProvider>,
    );

    await waitFor(() => {
      const items = screen.getAllByTestId("creator");
      expect(items.length).toBe(2);
    });
    expect(screen.getByText(/Ada \(ml\)/)).toBeTruthy();
    expect(screen.getByText("Babbage")).toBeTruthy();
    expect(server.callLog.some((c) => c.name === "search")).toBe(true);

    await client.close();
  });

  it("renders a follower-history line chart (3 points → an SVG polyline)", async () => {
    const server = makeServer();
    const client = makeClient(server);
    await client.connect();

    const { container } = render(
      <MCPProvider client={client}>
        <FollowerChart />
      </MCPProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chart")).toBeTruthy();
    });
    expect(screen.getByTestId("points").textContent).toBe("3");
    // The hand-rolled chart draws a <polyline> with 3 comma-separated points.
    const polyline = container.querySelector("polyline.chart-line");
    expect(polyline).toBeTruthy();
    const pts = polyline!.getAttribute("points")!.trim().split(/\s+/);
    expect(pts.length).toBe(3);

    await client.close();
  });
});
