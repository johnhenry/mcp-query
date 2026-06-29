import { describe, it, expect } from "vitest";
import { reduceAnalysis, isSettled, extractStatus, extractProgress } from "../src/lib/analysis.js";
import { asSeries, asList, displayName, unwrapResult } from "../src/lib/format.js";

describe("analysis polling state machine", () => {
  it("starts pending with no data", () => {
    const s = reduceAnalysis(undefined);
    expect(s.phase).toBe("pending");
    expect(isSettled(s)).toBe(false);
  });

  it("stays pending while status is running, carrying progress", () => {
    const s = reduceAnalysis({ status: "running", progress: 42 });
    expect(s.phase).toBe("pending");
    expect(s.progress).toBeCloseTo(0.42);
    expect(isSettled(s)).toBe(false);
  });

  it("transitions pending → done when status completes", () => {
    const pending = reduceAnalysis({ status: "queued" });
    expect(pending.phase).toBe("pending");
    const done = reduceAnalysis({ status: "completed", summary: "great account" });
    expect(done.phase).toBe("done");
    expect(isSettled(done)).toBe(true);
    expect(done.result).toMatchObject({ summary: "great account" });
  });

  it("transitions to error on a failed status", () => {
    const s = reduceAnalysis({ status: "failed" });
    expect(s.phase).toBe("error");
    expect(isSettled(s)).toBe(true);
  });

  it("surfaces a thrown error", () => {
    const s = reduceAnalysis(undefined, new Error("boom"));
    expect(s.phase).toBe("error");
    expect(s.error).toContain("boom");
  });

  it("treats a status-less payload with a result as done", () => {
    const s = reduceAnalysis({ analysis: { score: 9 } });
    expect(s.phase).toBe("done");
  });

  it("unwraps MCP content-array results before inspecting status", () => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify({ status: "completed", report: "x" }) }] };
    const s = reduceAnalysis(wrapped);
    expect(s.phase).toBe("done");
    expect(extractStatus(wrapped)).toBe("completed");
  });

  it("normalizes percentage progress to 0..1", () => {
    expect(extractProgress({ progress: 50 })).toBeCloseTo(0.5);
    expect(extractProgress({ progress: 0.25 })).toBeCloseTo(0.25);
  });
});

describe("result formatters", () => {
  it("unwraps structuredContent", () => {
    expect(unwrapResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it("extracts a list from a results envelope", () => {
    const list = asList({ content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a" }, { id: "b" }] }) }] });
    expect(list).toHaveLength(2);
  });

  it("extracts a {label,value} time series from follower history", () => {
    const raw = { history: [
      { date: "2026-01-01", count: 100 },
      { date: "2026-01-02", count: 150 },
    ] };
    const series = asSeries(raw);
    expect(series).toEqual([
      { label: "2026-01-01", value: 100 },
      { label: "2026-01-02", value: 150 },
    ]);
  });

  it("derives a display name from common fields", () => {
    expect(displayName({ display_name: "Ada" })).toBe("Ada");
    expect(displayName({ username: "ada99" })).toBe("ada99");
    expect(displayName({})).toBe("(unnamed)");
  });
});
