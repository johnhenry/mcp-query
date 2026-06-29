// A tiny, dependency-free markdown -> HTML renderer. Intentionally small: it covers
// headings (#, ##, ###), **bold**, `inline code`, unordered lists, and fenced ```code```
// blocks. Everything is HTML-escaped first, so user/file content can never inject markup.
//
// This is its own module (no React, no DOM) so it can be unit-tested in isolation.

/** Escape the five HTML-significant characters. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline spans: **bold** then `code`, applied to already-escaped text. */
function renderInline(escaped: string): string {
  // `code` first would swallow ** inside it; do bold first, but code wins by re-escaping
  // its body is unnecessary since we already escaped the whole line.
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Render a markdown string to an HTML string. Block-level: fenced code, headings,
 * unordered lists, and paragraphs. Inline: bold + inline code. Input is escaped up front.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCode) {
        // closing fence
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.*)$/);
    if (listItem) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInline(escapeHtml(listItem[1]!))}</li>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }

  // Flush any unterminated structures.
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  closeList();

  return out.join("\n");
}
