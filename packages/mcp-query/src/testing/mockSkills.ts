// Skills fixture for MockMCPServer (io.modelcontextprotocol/skills, SEP-2640).
// Builds spec-shaped skill entries (sha256 digest + size manifest, frontmatter)
// from a tiny declarative description, and can deliberately TAMPER with an entry
// so a host's verification has something to reject. No SDK 2.4.0 needed: the
// mock speaks the wire format directly, so it works on every supported SDK.

import { SKILLS_EXT } from "../core/skillsExt.js";

export { SKILLS_EXT };

/** How a fixture entry lies about its files (the file bytes themselves are never altered). */
export type MockSkillTamper =
  /** The listed digest is wrong — reading any file fails with reason `digest`. */
  | "digest"
  /** The listed size is wrong (digest right) — fails with reason `size`. */
  | "size"
  /** The listed frontmatter differs from SKILL.md's — reading SKILL.md fails with reason `frontmatter`. */
  | "frontmatter";

export interface MockSkill {
  /** Skill directory name; also the frontmatter `name`. Served at `skill://<name>/SKILL.md`. */
  name: string;
  description: string;
  /** Markdown body of the generated SKILL.md. */
  body?: string;
  /** Extra files, keyed by path relative to the skill root (e.g. `references/GUIDE.md`). */
  files?: Record<string, string>;
  /** Publish `resources: "dynamic"` — files are NOT verifiable (hosts must mark them `verified: false`). */
  dynamic?: boolean;
  tamper?: MockSkillTamper;
}

/** `ttlMs` / `cacheScope` the mock stamps on skills/list and skills/get results. */
export interface MockSkillsCacheHint {
  ttlMs: number;
  cacheScope?: "public" | "private";
}

export interface BuiltSkill {
  entry: { uri: string; frontmatter: { name: string; description: string }; resources: unknown };
  /** uri -> exact text served by resources/read */
  files: Map<string, string>;
}

const enc = new TextEncoder();

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function skillMarkdown(s: MockSkill): string {
  return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body ?? `Instructions for ${s.name}.`}\n`;
}

export async function buildMockSkill(s: MockSkill): Promise<BuiltSkill> {
  const root = `skill://${s.name}/`;
  const texts: Record<string, string> = { "SKILL.md": skillMarkdown(s), ...(s.files ?? {}) };
  const files = new Map<string, string>();
  const manifest: Array<{ uri: string; digest: string; size: number }> = [];
  for (const [path, text] of Object.entries(texts)) {
    files.set(root + path, text);
    let digest = await sha256(text);
    let size = enc.encode(text).byteLength;
    if (s.tamper === "digest") digest = "sha256:" + "0".repeat(64);
    if (s.tamper === "size") size += 1;
    manifest.push({ uri: root + path, digest, size });
  }
  return {
    entry: {
      uri: root + "SKILL.md",
      frontmatter: {
        name: s.name,
        description: s.tamper === "frontmatter" ? `${s.description} (tampered)` : s.description,
      },
      resources: s.dynamic ? "dynamic" : manifest,
    },
    files,
  };
}
