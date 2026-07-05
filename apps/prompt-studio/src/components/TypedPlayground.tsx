// The codegen loop, closed: src/mcp.gen.ts was emitted by `npm run codegen` against the
// live server; createTypedHooks<GeneratedToolMap> gives compile-time-checked tool calls —
// `useTool("get-sum")` knows args are {a: number; b: number} without any manual typing.
import { useState } from "react";
import { createTypedHooks } from "@johnhenry/mcpq/react";
import { ResultView } from "@app-shared";
import type { GeneratedToolMap } from "../mcp.gen.js";

const { useTool } = createTypedHooks<GeneratedToolMap>();

export function TypedPlayground() {
  const [a, setA] = useState("19");
  const [b, setB] = useState("23");
  const [sum, sumState] = useTool("get-sum");
  const [echo, echoState] = useTool("echo");
  const [message, setMessage] = useState("typed end to end");

  return (
    <div className="typed">
      <p className="muted">
        These calls are typed by <code>src/mcp.gen.ts</code> (regenerate with <code>npm run codegen</code>): the
        compiler rejects <code>get-sum({"{"}a: "x"{"}"})</code> before the server ever sees it.
      </p>
      <section className="card">
        <h3>get-sum(a: number, b: number)</h3>
        <div className="row">
          <input type="number" value={a} onChange={(e) => setA(e.target.value)} aria-label="a" />
          <input type="number" value={b} onChange={(e) => setB(e.target.value)} aria-label="b" />
          <button className="primary" onClick={() => void sum({ a: Number(a), b: Number(b) })}>
            call
          </button>
        </div>
        {sumState.isPending && <p className="muted">calling…</p>}
        {sumState.data !== undefined && <ResultView value={(sumState.data as { content?: unknown[] })?.content ?? sumState.data} />}
      </section>
      <section className="card">
        <h3>echo(message: string)</h3>
        <div className="row">
          <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="message" />
          <button className="primary" onClick={() => void echo({ message })}>
            call
          </button>
        </div>
        {echoState.data !== undefined && <ResultView value={(echoState.data as { content?: unknown[] })?.content ?? echoState.data} />}
      </section>
    </div>
  );
}
