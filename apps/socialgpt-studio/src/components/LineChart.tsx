// A hand-rolled, dependency-free inline SVG line chart for follower history / growth.
// No chart library — just compute a polyline + area path from a {label,value}[] series.

export interface LineChartProps {
  data: Array<{ label: string; value: number }>;
  width?: number;
  height?: number;
  title?: string;
}

export function LineChart({ data, width = 560, height = 200, title }: LineChartProps) {
  if (data.length === 0) {
    return <div className="chart-empty">No time-series data available.</div>;
  }
  if (data.length === 1) {
    const only = data[0]!;
    return (
      <div className="chart-empty">
        Single data point: <strong>{only.label}</strong> = {fmt(only.value)}
      </div>
    );
  }

  const pad = { top: 16, right: 16, bottom: 28, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const x = (i: number) => pad.left + (i / (data.length - 1)) * innerW;
  const y = (v: number) => pad.top + innerH - ((v - min) / span) * innerH;

  const linePoints = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const areaPath =
    `M ${x(0)},${y(data[0]!.value)} ` +
    data.map((d, i) => `L ${x(i)},${y(d.value)}`).join(" ") +
    ` L ${x(data.length - 1)},${pad.top + innerH} L ${x(0)},${pad.top + innerH} Z`;

  // A few horizontal gridlines + y labels.
  const ticks = 4;
  const gridY = Array.from({ length: ticks + 1 }, (_, i) => min + (span * i) / ticks);
  // Show at most ~6 x labels to avoid crowding.
  const xStep = Math.max(1, Math.ceil(data.length / 6));

  const last = data[data.length - 1]!;
  const first = data[0]!;
  const delta = last.value - first.value;

  return (
    <figure className="chart">
      {title && (
        <figcaption className="chart-title">
          {title}
          <span className={`chart-delta ${delta >= 0 ? "up" : "down"}`}>
            {delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}
          </span>
        </figcaption>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={title ?? "line chart"}>
        {gridY.map((v, i) => (
          <g key={i}>
            <line className="chart-grid" x1={pad.left} x2={pad.left + innerW} y1={y(v)} y2={y(v)} />
            <text className="chart-ylabel" x={pad.left - 8} y={y(v) + 4} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        <path className="chart-area" d={areaPath} />
        <polyline className="chart-line" points={linePoints} fill="none" />
        {data.map((d, i) =>
          i % xStep === 0 || i === data.length - 1 ? (
            <text key={i} className="chart-xlabel" x={x(i)} y={height - 8} textAnchor="middle">
              {short(d.label)}
            </text>
          ) : null,
        )}
        <circle className="chart-dot" cx={x(data.length - 1)} cy={y(last.value)} r={3.5} />
      </svg>
    </figure>
  );
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(Math.round(v));
}

function short(label: string): string {
  // Trim ISO dates to MM-DD when possible.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (m) return `${m[2]}/${m[3]}`;
  return label.length > 8 ? label.slice(0, 8) : label;
}
