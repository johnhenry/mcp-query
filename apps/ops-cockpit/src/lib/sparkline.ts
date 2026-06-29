// Rolling latency history + a hand-rolled SVG sparkline path builder. No chart lib —
// just enough math to turn a numeric series into an `<svg><polyline points=…>`. Pure
// and side-effect-free so it's trivially unit-testable.

/** A single latency sample. `ms` is undefined when the ping failed (a gap in the line). */
export interface LatencySample {
  t: number;
  ms?: number;
}

/** Append a sample to a rolling buffer, capped at `max` entries (oldest dropped). */
export function pushSample(history: LatencySample[], sample: LatencySample, max = 30): LatencySample[] {
  const next = history.length >= max ? history.slice(history.length - max + 1) : history.slice();
  next.push(sample);
  return next;
}

export interface SparklineGeometry {
  /** `points` attribute for an SVG <polyline> (empty string when nothing to draw). */
  points: string;
  /** Last value, for a trailing dot. undefined if the last sample was a failure. */
  last?: { x: number; y: number };
  min: number;
  max: number;
}

/**
 * Project a latency series into an SVG coordinate space (width × height). Failed
 * pings (ms === undefined) break the line into separate segments — but since
 * <polyline> can't have gaps, we simply skip them, which keeps the curve continuous
 * across the surviving samples. y is inverted (lower latency → higher on screen).
 */
export function sparklinePath(history: LatencySample[], width: number, height: number, pad = 2): SparklineGeometry {
  const pts = history.filter((s): s is { t: number; ms: number } => typeof s.ms === "number");
  if (pts.length === 0) return { points: "", min: 0, max: 0 };

  const values = pts.map((p) => p.ms);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const step = pts.length > 1 ? innerW / (pts.length - 1) : 0;

  const coords = pts.map((p, i) => {
    const x = pad + step * i;
    // Lower latency (better) sits near the top (small y); a spike dips toward the bottom.
    const y = pad + ((p.ms - min) / span) * innerH;
    return { x, y };
  });

  return {
    points: coords.map((c) => `${round(c.x)},${round(c.y)}`).join(" "),
    last: coords[coords.length - 1],
    min,
    max,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
