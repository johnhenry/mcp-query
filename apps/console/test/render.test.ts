// Unit tests for the pure render/coercion helpers and schema-form value handling.

import { describe, it, expect } from "vitest";
import { buildSchemaForm } from "@app-shared/schema-form";
import {
  coerceArgs,
  isTabular,
  renderTable,
  renderToolResult,
  renderResourceContents,
  renderPromptMessages,
} from "../src/lib/render.js";

const schema = {
  type: "object",
  properties: {
    count: { type: "integer" },
    ratio: { type: "number" },
    enabled: { type: "boolean" },
    mode: { type: "string", enum: ["fast", "slow"] },
    label: { type: "string" },
  },
  required: ["count"],
};

describe("buildSchemaForm + coerceArgs", () => {
  it("coerces enum/number/boolean form values into typed args", () => {
    const form = buildSchemaForm(schema as never);
    document.body.append(form.element);

    (form.element.querySelector('input[type="number"]') as HTMLInputElement).value = "7"; // count (integer)
    // second number control is ratio
    const numbers = form.element.querySelectorAll('input[type="number"]');
    (numbers[1] as HTMLInputElement).value = "1.5"; // ratio
    (form.element.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = true; // enabled
    (form.element.querySelector("select") as HTMLSelectElement).value = "slow"; // mode
    (form.element.querySelector('input[type="text"]') as HTMLInputElement).value = "hi"; // label

    const raw = form.getValues();
    const args = coerceArgs(raw, schema as never);

    expect(args).toEqual({ count: 7, ratio: 1.5, enabled: true, mode: "slow", label: "hi" });
    expect(Number.isInteger(args.count)).toBe(true);
    expect(typeof args.ratio).toBe("number");
    expect(typeof args.enabled).toBe("boolean");
  });

  it("truncates integers and drops empty values", () => {
    expect(coerceArgs({ count: "9.8", label: "" }, schema as never)).toEqual({ count: 9 });
    expect(coerceArgs({ enabled: "true" }, schema as never)).toEqual({ enabled: true });
  });
});

describe("result rendering", () => {
  it("detects tabular arrays and renders an HTML table", () => {
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];
    expect(isTabular(rows)).toBe(true);
    const html = renderTable(rows);
    expect(html).toContain("<table");
    expect(html).toContain("<th>id</th>");
    expect(html).toContain("<th>name</th>");
    expect((html.match(/<tr>/g) ?? []).length).toBe(3); // header + 2 rows
  });

  it("lifts JSON from a single text block into a table", () => {
    const result = { content: [{ type: "text", text: JSON.stringify([{ a: 1 }, { a: 2 }]) }] };
    const html = renderToolResult(result as never);
    expect(html).toContain("<table");
    expect(html).toContain("<th>a</th>");
  });

  it("renders plain text content (non-JSON) as escaped text, not a table", () => {
    const html = renderToolResult({ content: [{ type: "text", text: "<hello> & world" }] } as never);
    expect(html).toContain("content-text");
    expect(html).toContain("&lt;hello&gt; &amp; world");
    expect(html).not.toContain("<table");
  });

  it("flags error results", () => {
    const html = renderToolResult({ isError: true, content: [{ type: "text", text: "boom" }] } as never);
    expect(html).toContain("result-error");
  });

  it("renders resource contents and prompt messages", () => {
    const res = renderResourceContents({ contents: [{ text: "file body", mimeType: "text/plain" }] });
    expect(res).toContain("file body");

    const prompt = renderPromptMessages({
      messages: [{ role: "assistant", content: { type: "text", text: "hello" } }],
    });
    expect(prompt).toContain("message-assistant");
    expect(prompt).toContain("hello");
  });
});
