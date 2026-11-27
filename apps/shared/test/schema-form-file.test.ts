// @vitest-environment happy-dom
// EXPERIMENTAL x-mcp-file params render as a file input honouring accept and maxSize (vanilla builder + React form).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildSchemaForm, fileConstraints, fileProblem } from "../src/schema-form.js";
import { SchemaForm } from "../src/react/index.js";

const schema = {
  type: "object",
  properties: {
    note: { type: "string" },
    doc: { type: "object", description: "the PDF", "x-mcp-file": { accept: ["application/pdf", ".txt"], maxSize: 10 } },
    anyfile: { type: "object", "x-mcp-file": {} },
  },
  required: ["doc"],
} as never;

describe("x-mcp-file in the shared schema forms", () => {
  it("constraints are read from the keyword", () => {
    expect(fileConstraints({ "x-mcp-file": { accept: ["a/b", 1], maxSize: 5 } })).toEqual({ accept: ["a/b"], maxSize: 5 });
    expect(fileConstraints({ "x-mcp-file": true })).toEqual({});
    expect(fileConstraints({ type: "object" })).toBeUndefined();
    expect(fileConstraints(undefined)).toBeUndefined();
  });

  it("fileProblem checks size and type", () => {
    const c = { accept: ["application/pdf", ".txt", "image/*"], maxSize: 10 };
    expect(fileProblem({ name: "a.pdf", type: "application/pdf", size: 10 }, c)).toBeUndefined();
    expect(fileProblem({ name: "a.pdf", type: "application/pdf", size: 11 }, c)).toMatch(/exceeds/);
    expect(fileProblem({ name: "a.bin", type: "application/zip", size: 1 }, c)).toMatch(/not accepted/);
    expect(fileProblem({ name: "n.txt", type: "", size: 1 }, c)).toBeUndefined();
    expect(fileProblem({ name: "p.png", type: "image/png", size: 1 }, c)).toBeUndefined();
    expect(fileProblem(undefined, c)).toBeUndefined();
  });

  it("the DOM builder renders a file input with accept, and only returns a file that passes", () => {
    const form = buildSchemaForm(schema);
    const input = form.element.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.accept).toBe("application/pdf,.txt");
    expect(form.element.querySelectorAll('input[type="file"]')).toHaveLength(2);
    expect(form.getValues()).toEqual({});

    const pick = (f: File) => {
      Object.defineProperty(input, "files", { value: [f], configurable: true });
      input.dispatchEvent(new Event("change"));
    };
    pick(new File(["x".repeat(20)], "big.txt", { type: "text/plain" }));
    expect(input.validationMessage).toMatch(/exceeds/);
    expect(form.getValues().doc).toBeUndefined();
    const ok = new File(["hello"], "ok.txt", { type: "text/plain" });
    pick(ok);
    expect(input.validationMessage).toBe("");
    expect(form.getValues().doc).toBe(ok);
  });

  it("the React form renders the same file input", () => {
    const html = renderToStaticMarkup(createElement(SchemaForm, { schema, onSubmit: () => {} }));
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="application/pdf,.txt"');
    expect(html).toContain("doc *");
  });
});
