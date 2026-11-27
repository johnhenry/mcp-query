// A stdio MCP server that speaks BOTH protocol generations (the SDK's serveStdio picks the era from the opening
// request: server/discover -> 2026-07-28, initialize -> 2025-era). FIXTURE_MARK: append "start <pid>" / "stdin-closed <pid>".
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const mark = (s) => process.env.FIXTURE_MARK && appendFileSync(process.env.FIXTURE_MARK, `${s} ${process.pid}\n`);
mark("start");
process.stdin.on("close", () => mark("stdin-closed"));

serveStdio(
  () => {
    const server = new Server(
      { name: "dual-fixture", version: "1.0.0" },
      { capabilities: { tools: {}, extensions: { "io.example/widgets": { revision: "2026-09-01" } } } },
    );
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
    }));
    return server;
  },
  {},
);
