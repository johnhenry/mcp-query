// Unit tests for the pure cockpit helpers: health → tile-status mapping, the rolling
// latency history + SVG sparkline geometry, and the activity filter.

import { describe, it, expect } from "vitest";
import { healthToTileStatus, statusLabel } from "../src/lib/tile-status.js";
import { pushSample, sparklinePath, type LatencySample } from "../src/lib/sparkline.js";
import { filterRows, type ActivityRow } from "../src/lib/activity.js";

describe("healthToTileStatus", () => {
  it("maps ready+ok to healthy, ready+failing-ping to degraded", () => {
    expect(healthToTileStatus({ state: "ready", ok: true, pingMs: 12 })).toBe("healthy");
    expect(healthToTileStatus({ state: "ready", ok: false })).toBe("degraded");
  });

  it("maps lifecycle states to coarse statuses", () => {
    expect(healthToTileStatus({ state: "connecting", ok: false })).toBe("warming");
    expect(healthToTileStatus({ state: "initializing", ok: false })).toBe("warming");
    expect(healthToTileStatus({ state: "reconnecting", ok: false })).toBe("degraded");
    expect(healthToTileStatus({ state: "failed", ok: false })).toBe("failed");
    expect(healthToTileStatus({ state: "closed", ok: false })).toBe("failed");
  });

  it("treats a missing snapshot as offline", () => {
    expect(healthToTileStatus(undefined)).toBe("offline");
    expect(statusLabel(healthToTileStatus(undefined))).toBe("Offline");
  });
});

describe("pushSample (rolling latency history)", () => {
  it("appends and caps to the max length, dropping oldest", () => {
    let hist: LatencySample[] = [];
    for (let i = 0; i < 10; i++) hist = pushSample(hist, { t: i, ms: i }, 5);
    expect(hist).toHaveLength(5);
    expect(hist[0]!.ms).toBe(5); // 0..4 dropped
    expect(hist[4]!.ms).toBe(9);
  });

  it("does not mutate the input array", () => {
    const a: LatencySample[] = [{ t: 0, ms: 1 }];
    const b = pushSample(a, { t: 1, ms: 2 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});

describe("sparklinePath", () => {
  it("returns empty geometry when there are no successful samples", () => {
    const geo = sparklinePath([{ t: 0 }, { t: 1 }], 100, 30);
    expect(geo.points).toBe("");
    expect(geo.last).toBeUndefined();
  });

  it("projects values into the svg box, inverting y (low latency = high on screen)", () => {
    const geo = sparklinePath(
      [
        { t: 0, ms: 10 },
        { t: 1, ms: 20 },
      ],
      100,
      30,
      2,
    );
    const pts = geo.points.split(" ").map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(2);
    // lower ms (10, better) maps to a SMALLER y (higher on screen) than higher ms (20)
    expect(pts[0]![1]!).toBeLessThan(pts[1]![1]!);
    expect(geo.min).toBe(10);
    expect(geo.max).toBe(20);
    expect(geo.last).toBeDefined();
  });

  it("skips failed pings (no ms) but keeps the surviving curve", () => {
    const geo = sparklinePath(
      [
        { t: 0, ms: 5 },
        { t: 1 }, // failed ping
        { t: 2, ms: 15 },
      ],
      100,
      30,
    );
    expect(geo.points.split(" ")).toHaveLength(2);
  });
});

describe("filterRows", () => {
  const rows: ActivityRow[] = [
    { id: 1, at: 1, source: "audit", server: "a", method: "call x", ok: true },
    { id: 2, at: 2, source: "audit", server: "a", method: "call y", ok: false },
    { id: 3, at: 3, source: "devtools", server: "b", method: "response #4", ok: true },
  ];

  it("filters by ok / error / source", () => {
    expect(filterRows(rows, "all")).toHaveLength(3);
    expect(filterRows(rows, "ok").map((r) => r.id)).toEqual([1, 3]);
    expect(filterRows(rows, "error").map((r) => r.id)).toEqual([2]);
    expect(filterRows(rows, "audit").map((r) => r.id)).toEqual([1, 2]);
    expect(filterRows(rows, "devtools").map((r) => r.id)).toEqual([3]);
  });
});
