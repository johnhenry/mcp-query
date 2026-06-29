// Living Notebook — a notes/knowledge UI over a filesystem MCP server.
//
// Connection: dev runs a WS proxy (npm run dev:proxy) that the browser dials. The proxy
// spawns `@modelcontextprotocol/server-filesystem <sample-notes>` over stdio. We build an
// MCPClient over that proxy and render the app under <AppProvider client={client}>.
//
// The filesystem server exposes files as TOOLS (list_directory / read_text_file /
// write_file / edit_file / search_files), not resources, so the tree + viewer are
// tool-driven (see src/hooks.ts). The library's resources/subscribe killer feature is
// demonstrated against a subscribe-capable mock in test/integration.test.ts.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { makeProxyClient, AppProvider, useProxyServersReady } from "@app-shared";
import { useTool } from "mcp-query/react";
import { renderMarkdown } from "./markdown.js";
import { baseName, type FileEntry } from "./fs.js";
import { useFileTree, useLiveFile, useSearch } from "./hooks.js";
import "./styles.css";

const SAMPLE_NOTES_DIR = __SAMPLE_NOTES_DIR__;

// ── client wired to the WS proxy → filesystem MCP server ────────────────────
const client = makeProxyClient({
  servers: {
    fs: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", SAMPLE_NOTES_DIR],
    },
  },
  clientInfo: { name: "living-notebook", version: "0.0.1" },
});
void client.connect();

// ── tree / sidebar ──────────────────────────────────────────────────────────
function Sidebar({
  open,
  onOpen,
}: {
  open: string | undefined;
  onOpen: (file: FileEntry) => void;
}) {
  const { files, error, loaded, refresh } = useFileTree(SAMPLE_NOTES_DIR);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">📓 Notebook</span>
        <button className="ghost" title="Refresh" onClick={() => void refresh()}>
          ⟳
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!loaded && <p className="muted">Loading files…</p>}
      {loaded && !error && files.length === 0 && <p className="muted">No notes yet.</p>}
      <nav className="file-list">
        {files.map((f) => (
          <button
            key={f.path}
            className={"file-item" + (f.path === open ? " active" : "")}
            onClick={() => onOpen(f)}
          >
            <span className="file-icon">{f.name.endsWith(".md") ? "📝" : "📄"}</span>
            {f.name}
          </button>
        ))}
      </nav>
    </aside>
  );
}

// ── viewer / editor ──────────────────────────────────────────────────────────
type Mode = "render" | "raw" | "edit";

function Viewer({ file }: { file: FileEntry }) {
  const { content, error, isLoading, rev, refetch, setOptimistic, rollback } = useLiveFile(file.path);
  const [mode, setMode] = useState<Mode>("render");
  const [draft, setDraft] = useState("");
  // write_file invalidates the file's resource tag, so any useResource(uri) subscriber
  // re-reads on save — correct mcp-query mutation→invalidation wiring.
  const [write, writeState] = useTool("write_file", {
    server: "fs",
    invalidates: [`res:fs:${file.uri}`],
  });
  const [flash, setFlash] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | undefined>();

  // Flash the "live" pip whenever the on-disk content changes (rev bumps past the first
  // load, i.e. rev > 1).
  useEffect(() => {
    if (rev <= 1) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(id);
  }, [rev]);

  // Reset transient state when the open file changes.
  useEffect(() => {
    setMode("render");
    setSaveMsg(undefined);
  }, [file.path]);

  const startEdit = () => {
    setDraft(content ?? "");
    setMode("edit");
    setSaveMsg(undefined);
  };

  const save = async () => {
    const previous = content;
    setOptimistic(draft); // optimistic: show the saved text immediately
    setMode("render");
    setSaveMsg({ kind: "ok", text: "Saving…" });
    try {
      await write({ path: file.path, content: draft });
      // write's `invalidates` already bumped any useResource subscribers; re-read to
      // confirm the optimistic value matches disk.
      await refetch();
      setSaveMsg({ kind: "ok", text: "Saved ✓" });
      setTimeout(() => setSaveMsg(undefined), 1800);
    } catch (e) {
      rollback(previous); // rollback on failure
      setSaveMsg({ kind: "err", text: "Save failed — rolled back" });
      setMode("edit");
      setDraft(draft);
      void e;
    }
  };

  const isMarkdown = file.name.endsWith(".md");

  return (
    <section className="viewer">
      <header className="viewer-head">
        <div className="title-wrap">
          <h1 className="doc-title">{baseName(file.path)}</h1>
          <span className={"live-pip" + (flash ? " flash" : "")} title="Live-synced with disk">
            ● live
          </span>
        </div>
        <div className="toolbar">
          <div className="segmented">
            <button className={mode === "render" ? "on" : ""} disabled={!isMarkdown} onClick={() => setMode("render")}>
              Rendered
            </button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>
              Raw
            </button>
            <button className={mode === "edit" ? "on" : ""} onClick={startEdit}>
              Edit
            </button>
          </div>
          {saveMsg && <span className={"save-msg " + saveMsg.kind}>{saveMsg.text}</span>}
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {isLoading && content === undefined && <p className="muted">Opening…</p>}

      {mode === "edit" ? (
        <div className="editor">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <div className="editor-actions">
            <button className="primary" disabled={writeState.isPending} onClick={() => void save()}>
              {writeState.isPending ? "Saving…" : "Save"}
            </button>
            <button className="ghost" onClick={() => setMode("render")}>
              Cancel
            </button>
          </div>
        </div>
      ) : mode === "raw" || !isMarkdown ? (
        <pre className="raw">{content ?? ""}</pre>
      ) : (
        <article
          className="rendered"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content ?? "") }}
        />
      )}
    </section>
  );
}

// ── search ───────────────────────────────────────────────────────────────────
function SearchPanel({ onOpen }: { onOpen: (file: FileEntry) => void }) {
  const { run, results, ran, isPending, error } = useSearch(SAMPLE_NOTES_DIR);
  const [q, setQ] = useState("");
  return (
    <div className="search-panel">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) void run(q.trim());
        }}
      >
        <input
          placeholder="Find notes by name, e.g. *.md or *todo*"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" disabled={isPending}>
          {isPending ? "…" : "Search"}
        </button>
      </form>
      {error && <p className="error">{String(error.message ?? error)}</p>}
      {ran && results.length === 0 && !isPending && <p className="muted">No matches.</p>}
      <ul className="search-results">
        {results.map((path) => (
          <li key={path}>
            <button
              className="result"
              onClick={() => onOpen({ name: baseName(path), path, uri: `file://${path}` })}
            >
              {baseName(path)}
              <span className="result-path">{path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── shell ─────────────────────────────────────────────────────────────────────
function Notebook() {
  const ready = useProxyServersReady(client);
  const [open, setOpen] = useState<FileEntry | undefined>();
  const [tab, setTab] = useState<"notes" | "search">("notes");

  const banner = useMemo(
    () =>
      ready ? null : (
        <div className="connect-banner">
          Connecting to the filesystem MCP server… make sure <code>npm run dev</code> is running and
          you opened the URL the proxy printed (with <code>?proxyToken=…&proxyPort=…</code>).
        </div>
      ),
    [ready],
  );

  return (
    <div className="app">
      <Sidebar open={open?.path} onOpen={(f) => setOpen(f)} />
      <main className="content">
        {banner}
        <div className="tabs">
          <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
            Note
          </button>
          <button className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>
            Search
          </button>
        </div>
        {tab === "search" ? (
          <SearchPanel
            onOpen={(f) => {
              setOpen(f);
              setTab("notes");
            }}
          />
        ) : open ? (
          <Viewer key={open.path} file={open} />
        ) : (
          <div className="empty">
            <h2>Living Notebook</h2>
            <p>Select a note on the left to open it. Edit a file on disk and watch the viewer update live.</p>
          </div>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("app")!;
createRoot(root).render(
  <StrictMode>
    <AppProvider client={client}>
      <Notebook />
    </AppProvider>
  </StrictMode>,
);
