import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders headings at levels 1-3", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("## Sub")).toBe("<h2>Sub</h2>");
    expect(renderMarkdown("### Small")).toBe("<h3>Small</h3>");
  });

  it("renders bold and inline code", () => {
    expect(renderMarkdown("a **bold** word")).toBe("<p>a <strong>bold</strong> word</p>");
    expect(renderMarkdown("use `code` here")).toBe("<p>use <code>code</code> here</p>");
  });

  it("groups consecutive list items into a single <ul>", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>");
  });

  it("renders fenced code blocks and escapes their contents", () => {
    const html = renderMarkdown("```\nconst x = a < b && c > d;\n```");
    expect(html).toBe("<pre><code>const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>");
  });

  it("escapes HTML in normal text so file content cannot inject markup", () => {
    const html = renderMarkdown("<script>alert('x')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps bold/code escaping safe", () => {
    expect(escapeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    // bold inside escaped text still becomes <strong>, body stays escaped
    expect(renderMarkdown("**<b>**")).toBe("<p><strong>&lt;b&gt;</strong></p>");
  });

  it("handles a mixed document", () => {
    const md = "# H\n\nintro **strong**\n\n- a\n- b\n\n```\ncode\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("<h1>H</h1>");
    expect(html).toContain("<p>intro <strong>strong</strong></p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<pre><code>code</code></pre>");
  });
});
