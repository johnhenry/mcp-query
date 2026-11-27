// Build a form from a tool's JSON Schema (the non-agentic stand-in for an LLM filling
// arguments). Returns the element + a getValues() that yields a typed args object.
// Framework-agnostic DOM builder used by the Web-Components Console.

import { acceptsFile } from "@johnhenry/mcp-query";

interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema & { description?: string; enum?: unknown[] }>;
  required?: string[];
}

/**
 * EXPERIMENTAL (MCP files extension draft, `io.modelcontextprotocol/files`): the `x-mcp-file` constraints of a
 * property, or undefined when it is not a file param. `accept` is a list of media types / `.ext`; `maxSize` is bytes.
 */
export function fileConstraints(sub: unknown): { accept?: string[]; maxSize?: number } | undefined {
  const kw = (sub as Record<string, unknown> | null | undefined)?.["x-mcp-file"];
  if (kw === undefined || kw === null || kw === false) return undefined;
  const d = typeof kw === "object" ? (kw as { accept?: unknown; maxSize?: unknown }) : {};
  return {
    ...(Array.isArray(d.accept) ? { accept: d.accept.filter((a): a is string => typeof a === "string") } : {}),
    ...(typeof d.maxSize === "number" ? { maxSize: d.maxSize } : {}),
  };
}

/** Why a chosen file cannot be sent for these constraints, or undefined if it can. */
export function fileProblem(file: { name: string; type: string; size: number } | undefined, c: { accept?: string[]; maxSize?: number }): string | undefined {
  if (!file) return undefined;
  if (c.maxSize !== undefined && file.size > c.maxSize) return `${file.size} bytes exceeds the limit of ${c.maxSize} bytes`;
  if (!acceptsFile(c.accept, file.type || "application/octet-stream", file.name)) return `${file.type || "this file type"} is not accepted (${(c.accept ?? []).join(", ")})`;
  return undefined;
}

export interface SchemaFormHandle {
  element: HTMLElement;
  getValues: () => Record<string, unknown>;
}

export function buildSchemaForm(schema: JSONSchema | undefined): SchemaFormHandle {
  const root = document.createElement("div");
  root.className = "schema-form";
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const getters: Array<[string, () => unknown]> = [];

  if (Object.keys(props).length === 0) {
    root.innerHTML = `<p class="muted">no arguments</p>`;
  }

  for (const [key, sub] of Object.entries(props)) {
    const field = document.createElement("label");
    field.className = "field";
    const span = document.createElement("span");
    span.textContent = key + (required.has(key) ? " *" : "");
    field.append(span);

    const t = Array.isArray(sub.type) ? sub.type[0] : sub.type;
    let control: HTMLElement;
    const fileC = fileConstraints(sub);
    if (fileC) {
      // x-mcp-file: a file picker honouring accept and maxSize. A file that breaks them is not returned by getValues().
      const fi = document.createElement("input");
      fi.type = "file";
      if (fileC.accept?.length) fi.accept = fileC.accept.join(",");
      let chosen: File | undefined;
      fi.addEventListener("change", () => {
        const f = fi.files?.[0];
        const problem = fileProblem(f, fileC);
        fi.setCustomValidity(problem ?? "");
        fi.title = problem ?? sub.description ?? "";
        chosen = problem ? undefined : f;
      });
      getters.push([key, () => chosen]);
      control = fi;
    } else if (sub.enum) {
      const sel = document.createElement("select");
      for (const v of sub.enum) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = String(v);
        sel.append(o);
      }
      getters.push([key, () => sel.value]);
      control = sel;
    } else if (t === "boolean") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      getters.push([key, () => cb.checked]);
      control = cb;
    } else if (t === "number" || t === "integer") {
      const n = document.createElement("input");
      n.type = "number";
      getters.push([key, () => (n.value === "" ? undefined : Number(n.value))]);
      control = n;
    } else if (t === "object" || t === "array") {
      const ta = document.createElement("textarea");
      ta.placeholder = "JSON";
      getters.push([key, () => { try { return ta.value ? JSON.parse(ta.value) : undefined; } catch { return ta.value || undefined; } }]);
      control = ta;
    } else {
      const s = document.createElement("input");
      s.type = "text";
      getters.push([key, () => (s.value || undefined)]);
      control = s;
    }
    if (sub.description) control.title = sub.description;
    if (required.has(key) && control instanceof HTMLInputElement) control.required = true;
    field.append(control);
    root.append(field);
  }

  return {
    element: root,
    getValues: () => Object.fromEntries(getters.map(([k, g]) => [k, g()]).filter(([, v]) => v !== undefined)),
  };
}
