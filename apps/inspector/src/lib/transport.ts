// Browser side of the proxy bridge: an SDK Transport that relays JSON-RPC frames to the
// local proxy over a WebSocket. mcp-query consumes it via ConnectionConfig.transport.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface TargetSpec {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export class WebSocketProxyTransport implements Transport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private ws?: WebSocket;

  constructor(
    private proxyUrl: string,
    private token: string,
    private target: TargetSpec,
  ) {}

  async start(): Promise<void> {
    const ws = (this.ws = new WebSocket(`${this.proxyUrl}/?token=${encodeURIComponent(this.token)}`));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not reach the inspector proxy"));
    });

    ws.onmessage = (e) => {
      const f = JSON.parse(e.data as string);
      if (f.msg !== undefined) this.onmessage?.(f.msg);
      else if (f.error) this.onerror?.(new Error(f.error));
      else if (f.control?.closed) this.onclose?.();
    };
    ws.onclose = () => this.onclose?.();

    // Ask the proxy to dial the target and await its ack.
    await new Promise<void>((resolve, reject) => {
      const onAck = (e: MessageEvent) => {
        const f = JSON.parse(e.data as string);
        if (f.control?.connected) { ws.removeEventListener("message", onAck); resolve(); }
        else if (f.control?.failed || f.error) { ws.removeEventListener("message", onAck); reject(new Error(f.error ?? "connect failed")); }
      };
      ws.addEventListener("message", onAck);
      ws.send(JSON.stringify({ control: { connect: this.target } }));
    });
  }

  async send(message: unknown): Promise<void> {
    this.ws?.send(JSON.stringify({ msg: message }));
  }

  async close(): Promise<void> {
    try { this.ws?.send(JSON.stringify({ control: { close: true } })); } catch { /* gone */ }
    this.ws?.close();
    this.onclose?.();
  }
}
