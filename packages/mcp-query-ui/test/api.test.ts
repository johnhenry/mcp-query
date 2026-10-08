// Public-API stability: the exported names and their type-level shapes. `npm run typecheck`
// compiles this file, so a signature change fails CI even if the runtime tests still pass.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { MCPClient } from "@johnhenry/mcp-query";
import type { Transport } from "@modelcontextprotocol/client";
import * as root from "../src/index.js";
import * as react from "../src/react.js";
import type { AppHost, AppHostOptions, AppSession, AppSessionState, AppStatus, OpenAppOptions, UseMcpAppResultLike } from "./api-types.js";

describe("public API", () => {
  it("root entry exports exactly the documented names (and never imports React)", () => {
    expect(Object.keys(root).sort()).toEqual(["MCP_APPS_EXTENSION_ID", "SANDBOX_PROXY_SANDBOX", "buildAppCsp", "createAppHost", "isSafeCspSource", "mcpAppsExtensions", "mountIframe", "sanitizeCsp"]);
  });
  it("react subpath exports exactly the documented hooks", () => {
    expect(Object.keys(react).sort()).toEqual(["useAppSession", "useAppSessions", "useMcpApp"]);
  });

  it("type-level shapes are stable", () => {
    expectTypeOf(root.createAppHost).parameter(0).toEqualTypeOf<AppHostOptions>();
    expectTypeOf(root.createAppHost).returns.toEqualTypeOf<AppHost>();
    expectTypeOf<AppHostOptions["client"]>().toEqualTypeOf<MCPClient>();
    expectTypeOf<AppHostOptions["server"]>().toEqualTypeOf<string>();
    expectTypeOf<AppHost["open"]>().toEqualTypeOf<(opts: OpenAppOptions) => Promise<AppSession>>();
    expectTypeOf<AppSession["connect"]>().toEqualTypeOf<(t: Transport) => Promise<void>>();
    expectTypeOf<AppSession["getState"]>().toEqualTypeOf<() => AppSessionState>();
    expectTypeOf<AppSession["subscribe"]>().toEqualTypeOf<(cb: () => void) => () => void>();
    expectTypeOf<AppSession["close"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<AppStatus>().toEqualTypeOf<"loading" | "loaded" | "connecting" | "ready" | "closing" | "closed" | "error">();
    expectTypeOf<AppSessionState["calls"][number]["outcome"]>().toEqualTypeOf<"pending" | "ok" | "denied" | "error">();
    expectTypeOf(root.mcpAppsExtensions).returns.toEqualTypeOf<Record<string, object>>();
    expectTypeOf(react.useMcpApp).parameters.toEqualTypeOf<[AppHost, import("../src/react.js").UseMcpAppOptions]>();
    expectTypeOf<ReturnType<typeof react.useMcpApp>>().toMatchTypeOf<UseMcpAppResultLike>();
  });
});
