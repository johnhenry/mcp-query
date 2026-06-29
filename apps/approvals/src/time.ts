// Tiny relative-time formatter for "age" labels on queue cards / audit rows.

export function ago(ts: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
