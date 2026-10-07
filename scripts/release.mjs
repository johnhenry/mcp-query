#!/usr/bin/env node
// Publish step for the Changesets workflow (.github/workflows/publish.yml).
//
//   npm run release            publish every public package whose version is new
//   npm run release -- --dry-run   print what would happen, publish nothing
//
// `changeset publish` always passes an explicit `--tag latest` (or the pre-mode
// tag), which overrides a package's `publishConfig.tag`. So packages that declare
// `publishConfig.tag` (mcp-query-tanstack -> "rc") are published here, with that
// dist-tag, before delegating everything else to `changeset publish`.
//
// Both paths are idempotent: a version already on the registry is skipped. The
// "New tag:" lines are the contract changesets/action parses to push the git tags
// and create a GitHub Release per published package.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const readSafe = (p) => {
  try {
    return read(p);
  } catch {
    return null;
  }
};

const root = read("package.json");
const publicPkgs = [];
for (const pattern of root.workspaces) {
  if (!pattern.endsWith("/*")) continue;
  const base = pattern.slice(0, -2);
  for (const entry of readdirSync(base)) {
    const dir = join(base, entry);
    const pkg = readSafe(join(dir, "package.json"));
    if (pkg && !pkg.private && pkg.name && pkg.version) publicPkgs.push({ dir, pkg });
  }
}

const onRegistry = (name, version) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// 1. Build everything that gets published (mcp-query first: the others import its dist/).
const buildOrder = ["@johnhenry/mcp-query", ...publicPkgs.map(({ pkg }) => pkg.name).filter((n) => n !== "@johnhenry/mcp-query")];
const workspaceArgs = buildOrder.flatMap((n) => ["-w", n]);
if (!dryRun) run("npm", ["run", "build", "--if-present", ...workspaceArgs]);

// 2. Packages with their own dist-tag (publishConfig.tag).
for (const { dir, pkg } of publicPkgs) {
  const tag = pkg.publishConfig?.tag;
  if (!tag) continue;
  if (onRegistry(pkg.name, pkg.version)) {
    console.log(`${pkg.name}@${pkg.version} is already on npm; skipping`);
    continue;
  }
  console.log(`publishing ${pkg.name}@${pkg.version} with dist-tag ${tag}`);
  if (dryRun) continue;
  run("npm", ["publish", "--access", "public", "--provenance", "--tag", tag], { cwd: dir });
  run("git", ["tag", `${pkg.name}@${pkg.version}`]);
  console.log(`New tag:  ${pkg.name}@${pkg.version}`);
}

// 3. Everything else, at the default dist-tag. Skips versions already published
// (including the ones just handled above).
if (dryRun) {
  for (const { pkg } of publicPkgs) {
    if (!pkg.publishConfig?.tag && !onRegistry(pkg.name, pkg.version)) {
      console.log(`would publish ${pkg.name}@${pkg.version} (latest)`);
    }
  }
} else {
  run("npx", ["changeset", "publish"]);
}
