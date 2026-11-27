// Structural comparison of a card's remote URL with a connected URL.

export function sameEndpoint(template: string, connected: string): boolean {
  try {
    const a = new URL(template);
    const b = new URL(connected);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false; // templated (`{var}…`) URLs can't be compared structurally
  }
}
