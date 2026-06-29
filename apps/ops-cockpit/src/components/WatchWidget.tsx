// A "watch" widget for a read-only tool: calls it on a configurable interval via
// useToolResult and renders the latest result with ResultView. The library handles
// caching + the refetch timer; we just drive args + interval and render states.

import { useState } from "react";
import { useToolResult } from "mcp-query/react";
import { ResultView } from "@app-shared";
import { SchemaForm, type JSONSchemaLike } from "@app-shared";

export function WatchWidget({
  server,
  toolName,
  inputSchema,
}: {
  server: string;
  toolName: string;
  inputSchema?: JSONSchemaLike;
}) {
  const [args, setArgs] = useState<Record<string, unknown> | null>(null);
  const [intervalMs, setIntervalMs] = useState(5000);
  const [watching, setWatching] = useState(false);

  const { data, error, isLoading, refetch } = useToolResult(toolName, args ?? {}, {
    server,
    skip: !watching || args === null,
    refetchInterval: watching ? intervalMs : undefined,
  });

  const hasArgs = inputSchema?.properties && Object.keys(inputSchema.properties).length > 0;

  return (
    <div className="watch">
      {!watching ? (
        <div className="watch__setup">
          {hasArgs ? (
            <SchemaForm
              schema={inputSchema}
              submitLabel="Start watching"
              onSubmit={(values) => {
                setArgs(values);
                setWatching(true);
              }}
            />
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setArgs({});
                setWatching(true);
              }}
            >
              Start watching
            </button>
          )}
        </div>
      ) : (
        <div className="watch__live">
          <div className="watch__controls">
            <label className="watch__interval">
              every
              <input
                type="number"
                min={250}
                step={250}
                value={intervalMs}
                onChange={(e) => setIntervalMs(Math.max(250, Number(e.target.value) || 250))}
              />
              ms
            </label>
            <button type="button" className="btn" onClick={() => void refetch()}>
              refresh now
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setWatching(false)}>
              stop
            </button>
          </div>
          {isLoading && data === undefined && <p className="muted">loading…</p>}
          {error && <p className="error">error: {error.message}</p>}
          {data !== undefined && <ResultView value={extractContent(data)} />}
        </div>
      )}
    </div>
  );
}

/** queryTool resolves to a CallToolResult-ish object; surface its `content` to ResultView. */
function extractContent(data: unknown): unknown {
  if (data && typeof data === "object" && "content" in (data as Record<string, unknown>)) {
    return (data as { content: unknown }).content;
  }
  return data;
}
