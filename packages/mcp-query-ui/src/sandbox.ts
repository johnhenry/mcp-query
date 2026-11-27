// Sandbox-token policy for the double-iframe (issue #66). The spec fixes the OUTER sandbox-proxy
// frame at `allow-scripts allow-same-origin` (on the proxy's own, different origin); the INNER
// app frame defaults here to `allow-scripts` (opaque origin). Hosts may tighten; loosening is an
// explicit opt-in, and some combinations are refused outright.

/** Every `sandbox` token browsers understand; anything else is a typo and is rejected. */
export const KNOWN_SANDBOX_TOKENS: readonly string[] = [
  "allow-downloads", "allow-forms", "allow-modals", "allow-orientation-lock", "allow-pointer-lock", "allow-popups",
  "allow-popups-to-escape-sandbox", "allow-presentation", "allow-same-origin", "allow-scripts",
  "allow-storage-access-by-user-activation", "allow-top-navigation", "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
];

export const BASE_OUTER_SANDBOX: readonly string[] = ["allow-scripts", "allow-same-origin"];
export const BASE_INNER_SANDBOX: readonly string[] = ["allow-scripts"];

/** Host sandbox configuration (`MountIframeOptions.sandbox`). */
export interface SandboxOptions {
  /**
   * Tokens for the INNER app frame (replaces the default `allow-scripts`). Subsets of the default tighten
   * (e.g. `[]` = fully inert); extra tokens need `unsafeLoosen`. `allow-same-origin` is refused here
   * unconditionally: with `allow-scripts` it lets the app rewrite its own sandbox from the proxy.
   */
  inner?: string | readonly string[];
  /** Tokens added to the OUTER proxy frame (always at least `allow-scripts allow-same-origin`, per spec). Needs `unsafeLoosen`. */
  extraOuter?: readonly string[];
  /** Explicit opt-in to tokens beyond the spec baseline. */
  unsafeLoosen?: boolean;
}

function tokens(v: string | readonly string[], name = "sandbox"): string[] {
  const list = (typeof v === "string" ? v.split(/\s+/) : [...v]).map((t) => t.trim()).filter(Boolean);
  for (const t of list) {
    if (!KNOWN_SANDBOX_TOKENS.includes(t)) throw new Error(`unknown sandbox token ${JSON.stringify(t)} in ${name}`);
  }
  return [...new Set(list)];
}

export interface ResolvedSandbox {
  outer: string;
  inner: string;
}

/**
 * Resolve the outer/inner `sandbox` attribute values. `legacyInner` is the deprecated `innerSandbox` string; it is
 * validated exactly like `sandbox.inner` (the option name appears in the error). Passing both is an error.
 */
export function resolveSandbox(opts: SandboxOptions | undefined, legacyInner: string | undefined): ResolvedSandbox {
  if (legacyInner !== undefined && opts?.inner !== undefined) {
    throw new Error("pass either `innerSandbox` (deprecated) or `sandbox.inner`, not both: use `sandbox.inner`");
  }
  let outer = [...BASE_OUTER_SANDBOX];
  let inner: string[] = [...BASE_INNER_SANDBOX];
  if (opts?.extraOuter?.length) {
    if (!opts.unsafeLoosen) throw new Error("sandbox.extraOuter loosens the proxy frame beyond the spec's `allow-scripts allow-same-origin`; set sandbox.unsafeLoosen: true to opt in");
    outer = [...new Set([...outer, ...tokens(opts.extraOuter)])];
  }
  const name = legacyInner !== undefined ? "innerSandbox" : "sandbox.inner";
  const requested = legacyInner !== undefined ? legacyInner : opts?.inner;
  if (requested !== undefined) {
    const t = tokens(requested, name);
    if (t.includes("allow-same-origin")) {
      throw new Error(
        `${name} may not include allow-same-origin: the app frame must keep an opaque origin (it would otherwise share the proxy's origin and could lift its own sandbox). No option permits it`,
      );
    }
    const extra = t.filter((x) => !BASE_INNER_SANDBOX.includes(x));
    if (extra.length && !opts?.unsafeLoosen) {
      throw new Error(`${name} ${JSON.stringify(extra.join(" "))} loosens the app frame beyond \`allow-scripts\`; set sandbox.unsafeLoosen: true to opt in`);
    }
    inner = t;
  }
  return { outer: outer.join(" "), inner: inner.join(" ") };
}
