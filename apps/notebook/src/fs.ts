// Filesystem-MCP helpers. The @modelcontextprotocol/server-filesystem server exposes
// its files through *tools* (list_directory / read_text_file / write_file / edit_file /
// search_files), NOT through resources/list — so the notebook drives the tree and the
// viewer off those tools. These helpers parse the tools' text output into typed data and
// are pure (no React) so they can be unit-tested.

export interface FileEntry {
  /** The bare file name, e.g. "welcome.md". */
  name: string;
  /** Absolute path, e.g. "/abs/sample-notes/welcome.md". */
  path: string;
  /** A pseudo-URI used as the cache key / live-viewer subscription target. */
  uri: string;
}

/** Extract the concatenated text from an MCP CallToolResult content array. */
export function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * Parse `list_directory` output ("[FILE] a.md\n[DIR] sub") into the files in a directory.
 * Only [FILE] entries are returned (the notebook is a flat note list). `baseDir` is the
 * absolute directory the names live under, used to build absolute paths + uris.
 */
export function parseDirectory(text: string, baseDir: string): FileEntry[] {
  const dir = baseDir.replace(/\/+$/, "");
  const out: FileEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^\[FILE\]\s+(.*)$/);
    if (!m) continue;
    const name = m[1]!.trim();
    if (!name) continue;
    const path = `${dir}/${name}`;
    out.push({ name, path, uri: `file://${path}` });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Parse `search_files` output (one absolute path per line) into matched paths. */
export function parseSearch(text: string): string[] {
  const t = text.trim();
  if (!t || /^no matches/i.test(t)) return [];
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^no matches/i.test(l));
}

/** Best-effort display name for an absolute path. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}
