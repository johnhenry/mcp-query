// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { useMcpApp } from "../src/react.js";
import { APP_URI, makeFixture } from "./fixture.js";

let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
afterEach(async () => {
  cleanup();
  await fx?.close();
  fx = undefined;
});

describe("useMcpApp", () => {
  it("opens through the gated client, mounts, exposes reactive state, and tears down on unmount", async () => {
    fx = await makeFixture({ policy: { allow: ["demo.save", `demo.${APP_URI}`] } });
    let app: App | undefined;
    const { result, unmount } = renderHook(() => {
      const r = useMcpApp(fx!.host, {
        uri: APP_URI,
        mount: async (session) => {
          const [hostT, viewT] = InMemoryTransport.createLinkedPair();
          app = new App({ name: "hook-view", version: "1" }, {}, { autoResize: false });
          await session.connect(hostT);
          await app.connect(viewT);
        },
      });
      // attach the ref to a real element so the hook's container check passes
      if (!r.containerRef.current) (r.containerRef as { current: HTMLElement | null }).current = document.createElement("div");
      return r;
    });
    await waitFor(() => expect(result.current.state?.status).toBe("ready"));
    expect(result.current.state?.appInfo?.name).toBe("hook-view");

    await act(async () => {
      await app!.callServerTool({ name: "save", arguments: { x: 1 } });
    });
    await waitFor(() => expect(result.current.state?.calls[0]).toMatchObject({ target: "save", outcome: "ok" }));

    const session = result.current.session!;
    unmount();
    await waitFor(() => expect(session.getState().status).toBe("closed"));
    expect(fx.host.getSessions()).toHaveLength(0);
  });

  it("surfaces a gated/refused open as `error` and mounts nothing", async () => {
    fx = await makeFixture({ policy: { deny: [`demo.${APP_URI}`] } });
    const { result } = renderHook(() =>
      useMcpApp(fx!.host, { uri: APP_URI, mount: async () => {} }),
    );
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.session).toBeUndefined();
    expect(fx.host.getSessions()).toHaveLength(0);
  });

  it("does nothing while enabled is false", async () => {
    fx = await makeFixture();
    const { result } = renderHook(() => useMcpApp(fx!.host, { uri: APP_URI, enabled: false, mount: async () => {} }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.session).toBeUndefined();
  });
});
