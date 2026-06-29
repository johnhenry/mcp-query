// Inline SVG latency sparkline — no chart library. Renders a polyline through the
// rolling ping history plus a trailing dot at the most recent value.

import { sparklinePath, type LatencySample } from "../lib/sparkline.js";

export function Sparkline({
  history,
  width = 96,
  height = 28,
  color = "#3fb950",
}: {
  history: LatencySample[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const geo = sparklinePath(history, width, height);
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="latency history">
      {geo.points ? (
        <>
          <polyline points={geo.points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {geo.last && <circle cx={geo.last.x} cy={geo.last.y} r={2} fill={color} />}
        </>
      ) : (
        <line x1={2} y1={height / 2} x2={width - 2} y2={height / 2} stroke="#30363d" strokeWidth={1} strokeDasharray="2 3" />
      )}
    </svg>
  );
}
