// App-level hooks bridging the notebook UI to the filesystem MCP server's *tools*.
//
// Why tools and not useResource? The reference @modelcontextprotocol/server-filesystem
// does NOT implement resources/list or resources/subscribe — its files are exposed as
// tools. So:
//   - the tree comes from list_directory
//   - file content comes from read_text_file, kept "live" by polling (refetchInterval),
//     which is mcp-query's documented real-time fallback for servers without subscribe.
//
// The *true* resources/subscribe -> resources/updated -> cache-invalidation path is the
// killer feature mcp-query exists for; it is exercised against a subscribe-capable server
// in test/integration.test.ts. Against this FS server we approximate it with polling and
// flash the same "live" indicator when the on-disk bytes change.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTool } from "mcp-query/react";
import { parseDirectory, parseSearch, toolText, type FileEntry } from "./fs.js";

const SERVER = "fs";

/** The directory listing, refreshable. Polls so files added on disk appear. */
export function useFileTree(baseDir: string, pollMs = 4000) {
  const [list] = useTool("list_directory", { server: SERVER });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await list({ path: baseDir });
      setFiles(parseDirectory(toolText(res), baseDir));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [list, baseDir]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { files, error, loaded, refresh };
}

/**
 * Live file content. Reads via read_text_file and re-reads on an interval; when the bytes
 * change we bump `rev` (which the UI uses to flash the "live" indicator). This is the
 * polling stand-in for resources/subscribe against the FS server.
 *
 * `optimistic` lets the editor show a just-saved value immediately; it is cleared once the
 * next read confirms (or contradicts) it.
 */
export function useLiveFile(path: string | undefined, pollMs = 1500) {
  const [read] = useTool("read_text_file", { server: SERVER });
  const [content, setContent] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setLoading] = useState(false);
  const [rev, setRev] = useState(0);
  const optimisticRef = useRef<string | undefined>(undefined);
  const lastRef = useRef<string | undefined>(undefined);

  const refetch = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const res = await read({ path });
      const text = toolText(res);
      setError(undefined);
      // Clear an optimistic value once the server confirms (or supersede if disk differs).
      optimisticRef.current = undefined;
      if (text !== lastRef.current) {
        lastRef.current = text;
        setContent(text);
        setRev((r) => r + 1); // <- drives the live flash
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [read, path]);

  // Reset + load when the open file changes.
  useEffect(() => {
    lastRef.current = undefined;
    optimisticRef.current = undefined;
    setContent(undefined);
    setError(undefined);
    if (!path) return;
    void refetch();
    const id = setInterval(() => void refetch(), pollMs);
    return () => clearInterval(id);
  }, [path, refetch, pollMs]);

  /** Show a value immediately (optimistic) before the read confirms it. */
  const setOptimistic = useCallback((text: string) => {
    optimisticRef.current = text;
    lastRef.current = text;
    setContent(text);
  }, []);

  /** Roll back an optimistic value after a failed write. */
  const rollback = useCallback((previous: string | undefined) => {
    optimisticRef.current = undefined;
    lastRef.current = previous;
    setContent(previous);
  }, []);

  return { content, error, isLoading, rev, refetch, setOptimistic, rollback };
}

/** Search the notes directory via the search_files tool. */
export function useSearch(baseDir: string) {
  const [search, state] = useTool("search_files", { server: SERVER });
  const [results, setResults] = useState<string[]>([]);
  const [ran, setRan] = useState(false);

  const run = useCallback(
    async (pattern: string) => {
      const res = await search({ path: baseDir, pattern });
      setResults(parseSearch(toolText(res)));
      setRan(true);
    },
    [search, baseDir],
  );

  return { run, results, ran, isPending: state.isPending, error: state.error };
}
