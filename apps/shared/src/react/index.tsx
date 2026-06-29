// React glue shared by the four React example apps (socialgpt-studio, ops-cockpit,
// approvals, notebook). Builds an MCPClient wired to the WS proxy, a thin provider
// wrapper, a schema-driven form, and result/JSON renderers. Dependency-light: React
// only — no UI framework. The Web-Components Console imports the sibling modules
// (../proxy, ../schema-form, ../reactive, ../transport, ../oauth) directly, not this file.

import {
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MCPClient, type ClientInfo, type InteractionBroker } from "mcp-query";
import type { DevtoolsHub } from "mcp-query/devtools";
import { MCPProvider } from "mcp-query/react";
import { WebSocketProxyTransport } from "../transport.js";
import type { TargetSpec } from "../transport.js";

export type { TargetSpec } from "../transport.js";

// ── proxy connection params (read from the URL, mirroring the inspector store) ──

/** ws://<host>:<proxyPort> + ?proxyToken, read from the current URL. */
export function useProxyToken(): { token: string; url: string } {
  return useMemo(() => readProxyParams(), []);
}

function readProxyParams(): { token: string; url: string } {
  const params = new URLSearchParams(location.search);
  const token = params.get("proxyToken") ?? "";
  const url = `ws://${location.hostname}:${params.get("proxyPort") ?? 6280}`;
  return { token, url };
}

// ── client factory ──

/** The `onCall` audit callback type, derived from MCPClient's config. */
type OnCall = ConstructorParameters<typeof MCPClient>[0]["onCall"];

export interface MakeProxyClientOptions {
  /** name -> TargetSpec. Each server is dialed through the proxy via WebSocketProxyTransport. */
  servers: Record<string, TargetSpec>;
  /** Human-in-the-loop broker (sampling/elicitation approvals). */
  broker?: InteractionBroker;
  /** Devtools sink for the message log. */
  hub?: DevtoolsHub;
  /** Identity advertised to every server during initialize. */
  clientInfo?: ClientInfo;
  /** Durable audit callback for every read/call/query. */
  onCall?: OnCall;
}

/**
 * Build an MCPClient whose every server connects through the local WS proxy. The proxy
 * url + token are read from the URL (?proxyToken / ?proxyPort), exactly like the inspector.
 */
export function makeProxyClient(opts: MakeProxyClientOptions): MCPClient {
  const { url, token } = readProxyParams();
  const servers: Record<string, { transport: () => WebSocketProxyTransport }> = {};
  for (const [name, spec] of Object.entries(opts.servers)) {
    servers[name] = { transport: () => new WebSocketProxyTransport(url, token, spec) };
  }
  return new MCPClient({
    servers,
    interactions: opts.broker,
    devtools: opts.hub,
    clientInfo: opts.clientInfo,
    onCall: opts.onCall,
  });
}

// ── provider ──

export function AppProvider({ client, children }: { client: MCPClient; children: ReactNode }) {
  return <MCPProvider client={client}>{children}</MCPProvider>;
}

/** True once every server registered on the client has reached "ready". */
export function useProxyServersReady(client: MCPClient): boolean {
  useSyncExternalStore(
    (cb) => client.subscribeServerState(cb),
    () => client.serverStateVersion(),
    () => client.serverStateVersion(),
  );
  const conns = safeConnections(client);
  if (conns.length === 0) return false;
  return conns.every((c) => client.serverState(c.name) === "ready");
}

function safeConnections(client: MCPClient): Array<{ name: string }> {
  try {
    return client.connections().map((c) => ({ name: c.name }));
  } catch {
    return [];
  }
}

// ── schema-driven form (React port of buildSchemaForm) ──

export interface JSONSchemaLike {
  type?: string | string[];
  properties?: Record<string, JSONSchemaLike & { description?: string; enum?: unknown[] }>;
  required?: string[];
}

export interface SchemaFormProps {
  schema?: JSONSchemaLike;
  onSubmit: (values: Record<string, unknown>) => void;
  submitLabel?: string;
}

export function SchemaForm({ schema, onSubmit, submitLabel = "Run" }: SchemaFormProps) {
  const props = schema?.properties ?? {};
  const required = useMemo(() => new Set(schema?.required ?? []), [schema]);
  const [raw, setRaw] = useState<Record<string, string | boolean>>({});

  const keys = Object.keys(props);

  function coerce(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const sub = props[key]!;
      const t = Array.isArray(sub.type) ? sub.type[0] : sub.type;
      const v = raw[key];
      if (sub.enum) {
        if (v !== undefined && v !== "") out[key] = v;
      } else if (t === "boolean") {
        out[key] = v === true;
      } else if (t === "number" || t === "integer") {
        if (v !== undefined && v !== "") out[key] = Number(v);
      } else if (t === "object" || t === "array") {
        if (typeof v === "string" && v) {
          try { out[key] = JSON.parse(v); } catch { out[key] = v; }
        }
      } else {
        if (typeof v === "string" && v) out[key] = v;
      }
    }
    return out;
  }

  return (
    <form
      className="schema-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit(coerce()); }}
    >
      {keys.length === 0 && <p className="muted">no arguments</p>}
      {keys.map((key) => {
        const sub = props[key]!;
        const t = Array.isArray(sub.type) ? sub.type[0] : sub.type;
        const label = key + (required.has(key) ? " *" : "");
        const set = (val: string | boolean) => setRaw((r) => ({ ...r, [key]: val }));
        let control: ReactNode;
        if (sub.enum) {
          control = (
            <select
              value={(raw[key] as string) ?? ""}
              title={sub.description}
              onChange={(e) => set(e.target.value)}
            >
              <option value="" />
              {sub.enum.map((v) => (
                <option key={String(v)} value={String(v)}>{String(v)}</option>
              ))}
            </select>
          );
        } else if (t === "boolean") {
          control = (
            <input
              type="checkbox"
              checked={raw[key] === true}
              title={sub.description}
              onChange={(e) => set(e.target.checked)}
            />
          );
        } else if (t === "number" || t === "integer") {
          control = (
            <input
              type="number"
              value={(raw[key] as string) ?? ""}
              required={required.has(key)}
              title={sub.description}
              onChange={(e) => set(e.target.value)}
            />
          );
        } else if (t === "object" || t === "array") {
          control = (
            <textarea
              placeholder="JSON"
              value={(raw[key] as string) ?? ""}
              title={sub.description}
              onChange={(e) => set(e.target.value)}
            />
          );
        } else {
          control = (
            <input
              type="text"
              value={(raw[key] as string) ?? ""}
              required={required.has(key)}
              title={sub.description}
              onChange={(e) => set(e.target.value)}
            />
          );
        }
        return (
          <label className="field" key={key}>
            <span>{label}</span>
            {control}
          </label>
        );
      })}
      <button type="submit">{submitLabel}</button>
    </form>
  );
}

// ── result rendering ──

interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

function isContentArray(value: unknown): value is MCPContentBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((b) => b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string")
  );
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))
  );
}

/** Renders a tool/resource result: MCP content arrays → text/image, arrays of objects →
 *  table, anything else → <JsonView>. */
export function ResultView({ value }: { value: unknown }) {
  // MCP content blocks (from CallToolResult.content) take priority.
  if (isContentArray(value) && (value as MCPContentBlock[]).some((b) => b.type === "text" || b.type === "image")) {
    return (
      <div className="result-content">
        {(value as MCPContentBlock[]).map((block, i) => {
          if (block.type === "text") return <pre key={i} className="result-text">{block.text}</pre>;
          if (block.type === "image" && block.data) {
            return (
              <img
                key={i}
                className="result-image"
                alt="result"
                src={`data:${block.mimeType ?? "image/png"};base64,${block.data}`}
              />
            );
          }
          return <JsonView key={i} value={block} />;
        })}
      </div>
    );
  }

  if (isObjectArray(value)) {
    const cols = Array.from(
      value.reduce<Set<string>>((set, row) => {
        for (const k of Object.keys(row)) set.add(k);
        return set;
      }, new Set()),
    );
    return (
      <table className="result-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{renderCell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <JsonView value={value} />;
}

function renderCell(v: unknown): ReactNode {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return <JsonView value={v} />;
  return String(v);
}

// ── collapsible pretty JSON ──

export function JsonView({ value }: { value: unknown }) {
  const [open, setOpen] = useState(true);
  const text = useMemo(() => {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }, [value]);
  const isCollapsible = typeof value === "object" && value !== null;

  if (!isCollapsible) {
    return <pre className="json-view">{text}</pre>;
  }
  return (
    <div className="json-view">
      <button type="button" className="json-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {Array.isArray(value) ? `Array(${value.length})` : "Object"}
      </button>
      {open && <pre>{text}</pre>}
    </div>
  );
}
