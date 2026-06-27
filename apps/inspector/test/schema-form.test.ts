import { describe, it, expect } from "vitest";
import { buildSchemaForm } from "../src/lib/schema-form.js";

describe("buildSchemaForm", () => {
  it("renders controls per type and collects typed values", () => {
    const f = buildSchemaForm({
      type: "object",
      properties: {
        name: { type: "string" },
        n: { type: "number" },
        ok: { type: "boolean" },
        kind: { enum: ["a", "b"] },
      },
      required: ["name"],
    });
    (f.element.querySelector("input[type=text]") as HTMLInputElement).value = "Ada";
    (f.element.querySelector("input[type=number]") as HTMLInputElement).value = "3";
    (f.element.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    (f.element.querySelector("select") as HTMLSelectElement).value = "b";

    expect(f.getValues()).toEqual({ name: "Ada", n: 3, ok: true, kind: "b" });
  });

  it("omits empty optional values and shows 'no arguments' for empty schemas", () => {
    const f = buildSchemaForm({ type: "object", properties: { note: { type: "string" } } });
    expect(f.getValues()).toEqual({}); // optional + empty -> omitted

    const empty = buildSchemaForm({ type: "object", properties: {} });
    expect(empty.element.textContent).toContain("no arguments");
  });
});
