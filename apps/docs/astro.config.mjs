// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

// Circuit's syntax palette is fixed across every erisera OSS site (see
// erisera-code/circuit's src/tokens.css) — reused verbatim here so code
// reads identically across the whole family.
const circuitShikiTheme = {
  name: 'circuit',
  type: 'dark',
  colors: {
    'editor.background': '#0f172a',
    'editor.foreground': '#e2e8f0',
  },
  tokenColors: [
    { scope: ['comment'], settings: { foreground: '#8b93a1', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#0f9d63' } },
    { scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], settings: { foreground: '#d6337d' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#1d6fbf' } },
    { scope: ['constant.numeric'], settings: { foreground: '#9333d6' } },
    { scope: ['entity.name.tag', 'meta.tag'], settings: { foreground: '#b45f06' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#1d8f8f' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#7c4fd6' } },
    { scope: ['constant.language', 'constant.language.boolean'], settings: { foreground: '#c0392b', fontStyle: 'bold' } },
    { scope: ['punctuation', 'punctuation.definition', 'punctuation.separator'], settings: { foreground: '#94a3b8' } },
  ],
};

// Each package.json's main/exports fields point at ./dist/*.d.ts (compiled
// output) — the packages haven't been built (no dist/ yet), so
// entryPointStrategy: 'packages' (which discovers entries via those
// fields) fails with "No entry points were provided or discovered".
// Pointing directly at each package's src/index.ts (the default 'resolve'
// strategy) reads real TS source instead, no build step required. `cli`
// is excluded: it's bin-only (no `main` field, entry is src/cli.ts not
// src/index.ts) — a runnable tool, not a documented library surface; its
// README page covers it instead.
const apiEntryPoints = [
  'mcp-bench', 'mcp-contract', 'mcp-docs', 'mcp-gate', 'mcp-lint', 'mcp-query', 'mcp-record',
].map((pkg) => `../../packages/${pkg}/src/index.ts`);

// 'packages' entryPointStrategy invokes TypeDoc's PackageJsonReader, which
// bundles each package's README *and* LICENSE as "media" files regardless
// of `readme: 'none'` (verified on the ai.matey migration — see
// erisera-code/circuit family memory). None of that media has Starlight
// frontmatter, so Astro's content schema rejects it outright. Fix: after
// Starlight's own config:setup hook finishes generating, sweep the output
// dir and inject minimal frontmatter into anything that's missing it, or
// discard non-markdown media entirely.
function fixTypeDocMediaFrontmatter() {
  return {
    name: 'fix-typedoc-media-frontmatter',
    hooks: {
      'astro:config:setup'() {
        const refDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/content/docs/reference');
        const mediaDir = path.join(refDir, '_media');
        if (!fs.existsSync(mediaDir)) return;
        for (const file of fs.readdirSync(mediaDir)) {
          const full = path.join(mediaDir, file);
          if (fs.statSync(full).isDirectory()) {
            fs.rmSync(full, { force: true, recursive: true });
            continue;
          }
          if (!file.endsWith('.md') && !file.endsWith('.mdx')) {
            fs.rmSync(full, { force: true });
            continue;
          }
          const text = fs.readFileSync(full, 'utf8');
          if (!text.startsWith('---')) {
            const title = file.replace(/\.mdx?$/, '');
            fs.writeFileSync(full, `---\ntitle: "${title}"\n---\n\n${text}`);
          }
        }
      },
    },
  };
}

export default defineConfig({
  site: 'https://mcp-query.erisera.com',
  integrations: [
    starlight({
      title: 'mcp-query',
      tagline: 'A data-layer ecosystem for the Model Context Protocol.',
      logo: {
        src: './src/assets/logo.svg',
      },
      customCss: ['./src/styles/circuit-bridge.css'],
      expressiveCode: {
        themes: [circuitShikiTheme],
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/johnhenry/mcp-query' },
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: apiEntryPoints,
          tsconfig: '../../packages/mcp-query/tsconfig.json',
          output: 'reference',
          typeDoc: {
            readme: 'none',
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
          },
          sidebar: { label: 'API Reference', collapsed: true },
        }),
      ],
      sidebar: [
        { label: 'Overview', slug: 'index' },
        { label: 'Getting Started', slug: 'getting-started' },
        {
          label: 'Packages',
          items: [
            { label: 'mcp-query (core)', slug: 'packages/core' },
            { label: '@mcp-query/cli', slug: 'packages/cli' },
            { label: '@mcp-query/gate', slug: 'packages/gate' },
            { label: '@mcp-query/contract', slug: 'packages/contract' },
            { label: '@mcp-query/lint', slug: 'packages/lint' },
            { label: '@mcp-query/docs', slug: 'packages/docs-tool' },
            { label: '@mcp-query/bench', slug: 'packages/bench' },
            { label: '@mcp-query/record', slug: 'packages/record' },
          ],
        },
        { label: 'Example Apps', slug: 'apps' },
        typeDocSidebarGroup,
      ],
    }),
    fixTypeDocMediaFrontmatter(),
  ],
});
