// Open an external URL in the system browser. The packaged `deno desktop` webview can't follow
// `target="_blank"` / `window.open`, so we POST the URL to the backend (`/open`), which spawns the
// OS "open" command. Falls back to window.open for the plain-web path if the backend is unreachable.

export async function openExternal(url: string): Promise<void> {
  try {
    const res = await fetch("/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (res.ok) return;
  } catch {
    /* fall through to window.open */
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    /* nothing else we can do */
  }
}
