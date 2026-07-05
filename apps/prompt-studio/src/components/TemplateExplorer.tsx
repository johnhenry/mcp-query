// Resource templates: discover uriTemplates, fill their {variables} (completed by the
// server via ref/resource), expand, and live-read the resulting resource.
import { useMemo, useState } from "react";
import { useResource, useResourceTemplates } from "mcpq/react";
import { ResultView } from "@app-shared";
import { CompletionInput } from "./CompletionInput.js";

/** RFC 6570 level-1 variables: {var} (server-everything and most servers stay level 1). */
function templateVars(uriTemplate: string): string[] {
  return [...uriTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!.replace(/^[+#./;?&]/, ""));
}

function expand(uriTemplate: string, values: Record<string, string>): string {
  return uriTemplate.replace(/\{([^}]+)\}/g, (_, raw: string) => {
    const name = raw.replace(/^[+#./;?&]/, "");
    return encodeURIComponent(values[name] ?? "");
  });
}

export function TemplateExplorer({ server }: { server: string }) {
  const { templates } = useResourceTemplates({ server });
  const [active, setActive] = useState<string | null>(null);

  if (templates.length === 0) return <p className="muted">No resource templates on this server.</p>;

  return (
    <div className="templates">
      <div className="gallery">
        {templates.map((t) => (
          <button
            key={t.uriTemplate}
            className={active === t.uriTemplate ? "card active" : "card"}
            onClick={() => setActive(t.uriTemplate)}
          >
            <h3>{t.name}</h3>
            <p>
              <code>{t.uriTemplate}</code>
            </p>
          </button>
        ))}
      </div>
      {active && <TemplateReader key={active} server={server} uriTemplate={active} />}
    </div>
  );
}

function TemplateReader({ server, uriTemplate }: { server: string; uriTemplate: string }) {
  const vars = useMemo(() => templateVars(uriTemplate), [uriTemplate]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [uri, setUri] = useState<string | null>(null);

  return (
    <section className="template-reader">
      <form
        className="arg-form"
        onSubmit={(e) => {
          e.preventDefault();
          setUri(expand(uriTemplate, values));
        }}
      >
        {vars.map((v) => (
          <label key={v} className="field">
            <span>{v}</span>
            <CompletionInput
              server={server}
              refFor={{ type: "ref/resource", uri: uriTemplate }}
              argName={v}
              value={values[v] ?? ""}
              onChange={(val) => setValues((prev) => ({ ...prev, [v]: val }))}
            />
          </label>
        ))}
        <button type="submit" className="primary">
          Expand & read
        </button>
      </form>
      {uri && <LiveResource key={uri} uri={uri} server={server} />}
    </section>
  );
}

function LiveResource({ uri, server }: { uri: string; server: string }) {
  const { data, isLoading, error } = useResource<{ contents?: unknown[] }>(uri, { server, subscribe: true });
  if (isLoading) return <p className="muted">Reading {uri}…</p>;
  if (error) return <p className="error">{String(error.message ?? error)}</p>;
  return (
    <div className="resource-view">
      <header>
        <code>{uri}</code>
        <span className="badge live">subscribed</span>
      </header>
      <ResultView value={data?.contents ?? data} />
    </div>
  );
}
