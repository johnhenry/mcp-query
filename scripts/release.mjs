#!/usr/bin/env node
// Publish ONE workspace package if its version is new on npm.
//
//   node scripts/release.mjs <package-name> [--dry-run]
//   npm run release -- @johnhenry/mcp-query
//
// Used by all three publish workflows (release.yml, release-gate.yml,
// release-mcp-query-tanstack.yml). npm trusted publishing trusts one workflow
// filename per package, so each package is published from its own workflow file
// rather than through a single `changeset publish`. (`changeset publish` would also
// pass an explicit `--tag latest`, which overrides `publishConfig.tag`.)
//
// - Idempotent: a version already on the registry is skipped (exit 0).
// - Dist-tag: `publishConfig.tag` if set (mcp-query-tanstack -> "rc"), else "rc" for
//   prerelease versions, else "latest".
// - On a real publish: creates the local git tag `<name>@<version>` (the format
//   changesets uses), prints a `New tag:` line (parsed by changesets/action to push
//   tags + create the GitHub Release) and sets `published=true` / `tag=<tag>` in
//   $GITHUB_OUTPUT for workflows that create the tag/Release themselves.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const name = args.find((a) => !a.startsWith("--"));
if (!name) {
  console.error("usage: node scripts/release.mjs <package-name> [--dry-run]");
  process.exit(2);
}

const readSafe = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const root = readSafe("package.json");
let found;
for (const pattern of root.workspaces) {
  if (!pattern.endsWith("/*")) continue;
  const base = pattern.slice(0, -2);
  for (const entry of readdirSync(base)) {
    const pkg = readSafe(join(base, entry, "package.json"));
    if (pkg?.name === name) found = { dir: join(base, entry), pkg };
  }
}
if (!found) {
  console.error(`workspace package ${name} not found`);
  process.exit(2);
}
const { dir, pkg } = found;
if (pkg.private) {
  console.error(`${name} is private`);
  process.exit(2);
}

const output = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: "inherit", ...opts });
const spec = `${pkg.name}@${pkg.version}`;

output("published", "false");
output("version", pkg.version);

try {
  execFileSync("npm", ["view", spec, "version"], { stdio: "ignore" });
  console.log(`${spec} is already on npm; nothing to do.`);
  process.exit(0);
} catch {
  // not on the registry yet -> publish
}

const tag = pkg.publishConfig?.tag ?? (pkg.version.includes("-") ? "rc" : "latest");
console.log(`publishing ${spec} with dist-tag ${tag}${dryRun ? " (dry run)" : ""}`);
if (dryRun) process.exit(0);

// mcp-query's dist/ is imported by the other packages' builds.
run("npm", ["run", "build", "-w", "@johnhenry/mcp-query", ...(name === "@johnhenry/mcp-query" ? [] : ["-w", name])]);
run("npm", ["publish", "--access", "public", "--provenance", "--tag", tag], { cwd: dir });
run("git", ["tag", spec]);
console.log(`New tag:  ${spec}`);
output("published", "true");
output("tag", spec);
