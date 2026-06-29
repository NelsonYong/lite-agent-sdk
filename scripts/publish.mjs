#!/usr/bin/env node
// Batch-publish workspace packages, skipping any whose CURRENT version is already
// on the npm registry ("剔除没修改过 package version 的包"). The registry is the
// source of truth for "already published", so this works regardless of changeset
// or git-tag state. Dry-run by default — pass --yes to actually publish.
//
// Usage:
//   node scripts/publish.mjs              # preview: print what would publish / skip
//   node scripts/publish.mjs --yes        # build, then publish the not-yet-published packages
//   node scripts/publish.mjs --yes --otp 123456
//
// Or via pnpm:  pnpm release:changed   /   pnpm release:changed --yes
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages");

const args = process.argv.slice(2);
const DO_PUBLISH = args.includes("--yes");
const otpIdx = args.indexOf("--otp");
const OTP = otpIdx !== -1 ? args[otpIdx + 1] : undefined;

/** Every publishable package under packages/ (has name+version, not private). */
function publishablePackages() {
  const out = [];
  for (const entry of readdirSync(PKG_DIR)) {
    const pj = join(PKG_DIR, entry, "package.json");
    if (!existsSync(pj)) continue;
    const meta = JSON.parse(readFileSync(pj, "utf8"));
    if (meta.private === true) continue; // never publish private packages
    if (!meta.name || !meta.version) continue;
    out.push({ dir: join(PKG_DIR, entry), name: meta.name, version: meta.version });
  }
  return out;
}

/** Registry truth for name@version: 'published' | 'missing' | 'unknown' (check failed). */
function registryStatus(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  if (r.status === 0) {
    // npm prints the version when that exact version exists, nothing when it doesn't.
    return r.stdout.trim() === version ? "published" : "missing";
  }
  // A 404 means the package (or this version) is not on the registry → safe to publish.
  if (`${r.stderr || ""}`.includes("E404")) return "missing";
  // Network / auth / other failure → do NOT publish on uncertainty.
  return "unknown";
}

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ command failed (exit ${r.status}): ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

const pkgs = publishablePackages();
console.log(`Checking ${pkgs.length} publishable package(s) against the npm registry…\n`);

const toPublish = [];
const skipped = [];
const unresolved = [];
for (const p of pkgs) {
  const status = registryStatus(p.name, p.version);
  if (status === "published") {
    skipped.push(p);
    console.log(`  skip     ${p.name}@${p.version}  (already published)`);
  } else if (status === "missing") {
    toPublish.push(p);
    console.log(`  publish  ${p.name}@${p.version}  (new version)`);
  } else {
    unresolved.push(p);
    console.log(`  ?        ${p.name}@${p.version}  (registry check failed — will NOT publish)`);
  }
}

console.log(`\n${toPublish.length} to publish · ${skipped.length} skipped · ${unresolved.length} unresolved`);

if (toPublish.length === 0) {
  console.log("\nNothing to publish.");
  process.exit(0);
}

if (!DO_PUBLISH) {
  console.log("\nDry-run (no --yes): nothing was published. Re-run with --yes to publish the above.");
  process.exit(0);
}

// Real publish: build first so each dist/ is fresh, then publish package-by-package.
// pnpm publish rewrites `workspace:*` deps to the real versions automatically.
console.log("\nBuilding all packages (pnpm -r build)…");
run("pnpm", ["-r", "build"], ROOT);

for (const p of toPublish) {
  console.log(`\nPublishing ${p.name}@${p.version}…`);
  const publishArgs = ["publish", "--access", "public", "--no-git-checks"];
  if (OTP) publishArgs.push("--otp", OTP);
  run("pnpm", publishArgs, p.dir);
}
console.log(`\n✓ Published ${toPublish.length} package(s).`);
