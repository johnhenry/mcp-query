// Build a form from a tool's JSON Schema (the non-agentic stand-in for an LLM filling
// arguments). Returns the element + a getValues() that yields a typed args object.
// Framework-agnostic DOM builder used by the Web-Components Console.

interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema & { description?: string; enum?: unknown[] }>;
  required?: string[];
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
    if (sub.enum) {
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
