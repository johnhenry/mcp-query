#!/usr/bin/env node
// Publish ONE workspace package if its version is new on npm.
//
//   node scripts/release.mjs <package-name> [--dry-run]
//   npm run release -- @johnhenry/mcp-query
//
// Used by all publish workflows (release.yml, release-gate.yml,
// release-mcp-query-tanstack.yml, release-mcp-query-ui.yml, release-mcp-record.yml,
// release-mcp-contract.yml). npm trusted publishing trusts one workflow
// filename per package, so each package is published from its own workflow file
// rather than through a single `changeset publish`. (`changeset publish` would also
// pass an explicit `--tag latest`, which overrides `publishConfig.tag`.)
//
// - Idempotent: a version already on the registry is skipped (exit 0).
// - A version of 0.0.0 is the "not released yet" placeholder a brand-new package carries until
//   its first Changesets "Version Packages" PR lands (changeset minor: 0.0.0 -> 0.1.0). It is
//   never published (exit 0), so merging the PR that adds a package cannot publish 0.0.0.
// - First publish: `npm view` 404s for a package that has never been on npm. That is reported
//   and falls through to the publish. npm trusted publishing cannot create a package, so that
//   first run needs the maintainer's one-time manual publish (see CONTRIBUTING.md).
// - Dist-tag: `publishConfig.tag` if set (none set for mcp-query-tanstack now), else "rc" for
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
const workspaces = new Map(); // package name -> package.json, for the internal dependency build order
for (const pattern of root.workspaces) {
  if (!pattern.endsWith("/*")) continue;
  const base = pattern.slice(0, -2);
  for (const entry of readdirSync(base)) {
    const pkg = readSafe(join(base, entry, "package.json"));
    if (!pkg?.name) continue;
    workspaces.set(pkg.name, pkg);
    if (pkg.name === name) found = { dir: join(base, entry), pkg };
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

if (pkg.version === "0.0.0") {
  console.log(`${spec} is the unreleased placeholder version; waiting for the Version Packages PR. Nothing to do.`);
  process.exit(0);
}

try {
  execFileSync("npm", ["view", spec, "version"], { stdio: "pipe" });
  console.log(`${spec} is already on npm; nothing to do.`);
  process.exit(0);
} catch (e) {
  // E404 -> this version (or the whole package, on a first publish) is not on the registry -> publish.
  const firstPublish = /E404/.test(String(e.stderr ?? ""));
  if (firstPublish) {
    let packageExists = true;
    try {
      execFileSync("npm", ["view", pkg.name, "name"], { stdio: "pipe" });
    } catch (e2) {
      packageExists = !/E404/.test(String(e2.stderr ?? ""));
    }
    if (!packageExists) console.log(`${pkg.name} has never been published: this is a first publish (trusted publishing cannot create a package; see CONTRIBUTING.md).`);
  }
}

const tag = pkg.publishConfig?.tag ?? (pkg.version.includes("-") ? "rc" : "latest");
console.log(`publishing ${spec} with dist-tag ${tag}${dryRun ? " (dry run)" : ""}`);
if (dryRun) process.exit(0);

// mcp-query's dist/ is imported by the other packages' builds, and so is the dist/ of any
// other workspace package this one depends on by name (e.g. mcp-record -> mcp-contract).
const buildOrder = [];
const addWithDeps = (n) => {
  if (buildOrder.includes(n) || !workspaces.has(n)) return;
  const p = workspaces.get(n);
  for (const dep of Object.keys({ ...p.dependencies, ...p.peerDependencies })) addWithDeps(dep);
  buildOrder.push(n);
};
addWithDeps("@johnhenry/mcp-query");
addWithDeps(name);
run("npm", ["run", "build", ...buildOrder.flatMap((n) => ["-w", n])]);
run("npm", ["publish", "--access", "public", "--provenance", "--tag", tag], { cwd: dir });
run("git", ["tag", spec]);
console.log(`New tag:  ${spec}`);
output("published", "true");
output("tag", spec);
