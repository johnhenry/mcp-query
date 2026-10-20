// Browser side of the WebSocket <-> MCP bridge (#63). An SDK-compatible Transport that relays
// JSON-RPC frames to a bridge over a WebSocket (protocol: ./protocol.ts). Use it as a
// `ConnectionConfig.transport` factory. Browser-safe: only the global `WebSocket`.

import type { Transport } from "@modelcontextprotocol/client";
import type { BridgeFrame, TargetSpec } from "./protocol.js";

export class WebSocketBridgeTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private ws?: WebSocket;
  private closed = false;

  /**
   * @param bridgeUrl `ws://host:port` of the bridge
   * @param token bearer token the bridge expects
   * @param target the server for the bridge to dial
   * @param WebSocketImpl override the WebSocket constructor (tests, non-browser hosts)
   */
  constructor(
    private bridgeUrl: string,
    private token: string,
    private target: TargetSpec,
    private WebSocketImpl: typeof WebSocket = globalThis.WebSocket,
  ) {}

  async start(): Promise<void> {
    const ws = (this.ws = new this.WebSocketImpl(`${this.bridgeUrl.replace(/\/$/, "")}/?token=${encodeURIComponent(this.token)}`));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not reach the bridge")), { once: true });
      ws.addEventListener("close", () => reject(new Error("bridge refused the connection")), { once: true });
    });

    // Ack: resolve on connected, reject on failed / early close.
    await new Promise<void>((resolve, reject) => {
      const settle = (fn: () => void) => {
        ws.removeEventListener("message", onAck);
        ws.removeEventListener("close", onEarlyClose);
        fn();
      };
      const onAck = (e: MessageEvent) => {
        const f = JSON.parse(String(e.data)) as BridgeFrame;
        if ("control" in f && "connected" in f.control) settle(resolve);
        else if ("control" in f && "failed" in f.control) settle(() => reject(new Error(("error" in f && f.error) || "connect failed")));
        else if ("error" in f && !("control" in f)) settle(() => reject(new Error(f.error)));
      };
      const onEarlyClose = () => settle(() => reject(new Error("bridge closed before the target connected")));
      ws.addEventListener("message", onAck);
      ws.addEventListener("close", onEarlyClose);
      ws.send(JSON.stringify({ control: { connect: this.target } }));
    });

    ws.addEventListener("message", (e) => {
      const f = JSON.parse(String(e.data)) as BridgeFrame;
      if ("msg" in f) (this.onmessage as ((m: unknown) => void) | undefined)?.(f.msg);
      else if ("error" in f) this.onerror?.(new Error(f.error));
      else if ("control" in f && "closed" in f.control) this.finish();
    });
    ws.addEventListener("close", () => this.finish());
  }

  async send(message: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("bridge socket is not open");
    this.ws.send(JSON.stringify({ msg: message }));
  }

  async close(): Promise<void> {
    try {
      this.ws?.send(JSON.stringify({ control: { close: true } }));
    } catch {
      // socket already gone
    }
    this.ws?.close();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
