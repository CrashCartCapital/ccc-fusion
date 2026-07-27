#!/usr/bin/env node
/*
FNXC:CccShallowBrand 2026-07-27-00:00:
ccc-fusion is a shallow-branded fork (CF-018 / CF-DIV-008): the operator-facing
name is "ccc-fusion", but internal package/bin identifiers stay upstream
(@fusion/*, @runfusion/fusion, fn/fusion bins) so upstream diffs stay
mergeable. This verifier enforces that boundary from BOTH directions — no
upstream identifier may be renamed away, and no "ccc-" identifier may leak
into the internal package graph or the CLI bin block — plus that the operator
alias (scripts/ccc-fusion) exists, is executable, and README.md actually
names ccc-fusion for discoverability. Checks are pure functions over already-
read file contents so --self-test can drive them with synthetic fixtures
without touching any tracked file.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CLI_PACKAGE_NAME = "@runfusion/fusion";
export const EXPECTED_ROOT_PACKAGE_NAME = "fusion-workspace";
export const EXPECTED_CLI_BIN_KEYS = ["agent-browser", "fn", "fusion"];
export const FORBIDDEN_NAME_PREFIX = "ccc-";
export const WRAPPER_RELATIVE_PATH = "scripts/ccc-fusion";
export const README_MARKER = "ccc-fusion";

/** (a) packages/cli/package.json must keep the exact upstream name and bin block. */
export function checkCliPackageJson(cliPackageJson) {
  const violations = [];
  if (!cliPackageJson || typeof cliPackageJson !== "object") {
    return [`packages/cli/package.json: could not be parsed as an object`];
  }
  if (cliPackageJson.name !== EXPECTED_CLI_PACKAGE_NAME) {
    violations.push(
      `packages/cli/package.json: name must be exactly "${EXPECTED_CLI_PACKAGE_NAME}", found ${JSON.stringify(cliPackageJson.name)}`,
    );
  }
  const bin = cliPackageJson.bin;
  const binKeys = bin && typeof bin === "object" ? Object.keys(bin).sort() : [];
  const expectedSorted = [...EXPECTED_CLI_BIN_KEYS].sort();
  const missing = expectedSorted.filter((key) => !binKeys.includes(key));
  const extra = binKeys.filter((key) => !expectedSorted.includes(key));
  if (missing.length > 0) {
    violations.push(`packages/cli/package.json: bin block is missing required key(s): ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    violations.push(`packages/cli/package.json: bin block has unexpected key(s) (deep rename guard): ${extra.join(", ")}`);
  }
  return violations;
}

/** (b) root package.json must keep the exact upstream workspace name. */
export function checkRootPackageJson(rootPackageJson) {
  if (!rootPackageJson || typeof rootPackageJson !== "object") {
    return [`package.json: could not be parsed as an object`];
  }
  if (rootPackageJson.name !== EXPECTED_ROOT_PACKAGE_NAME) {
    return [`package.json: name must be exactly "${EXPECTED_ROOT_PACKAGE_NAME}", found ${JSON.stringify(rootPackageJson.name)}`];
  }
  return [];
}

/**
 * (c) No package under packages/* or plugins/* may declare a "ccc-" prefixed
 * name — internal identifiers stay upstream; ccc-fusion is operator-facing
 * naming only.
 * @param {Array<{path: string, name: unknown}>} entries
 */
export function checkNoCccPrefixedPackageNames(entries) {
  const violations = [];
  for (const entry of entries) {
    if (typeof entry.name === "string" && entry.name.startsWith(FORBIDDEN_NAME_PREFIX)) {
      violations.push(`${entry.path}: package name "${entry.name}" starts with "${FORBIDDEN_NAME_PREFIX}" (shallow-brand violation)`);
    }
  }
  return violations;
}

/**
 * (d) The operator alias wrapper must exist and be executable.
 * @param {{exists: boolean, executable: boolean}} wrapperStatus
 */
export function checkWrapperExecutable(wrapperStatus) {
  const violations = [];
  if (!wrapperStatus || !wrapperStatus.exists) {
    violations.push(`${WRAPPER_RELATIVE_PATH}: does not exist`);
    return violations;
  }
  if (!wrapperStatus.executable) {
    violations.push(`${WRAPPER_RELATIVE_PATH}: exists but is not executable`);
  }
  return violations;
}

/** (e) README.md must name ccc-fusion so the operator brand is discoverable. */
export function checkReadmeMentionsCccFusion(readmeContent) {
  if (typeof readmeContent !== "string" || !readmeContent.includes(README_MARKER)) {
    return [`README.md: does not contain "${README_MARKER}"`];
  }
  return [];
}

/**
 * Run every check over already-read inputs and return the combined
 * violation list. Pure: no filesystem access here.
 */
export function runShallowBrandChecks({
  rootPackageJson,
  cliPackageJson,
  packageNameEntries,
  wrapperStatus,
  readmeContent,
}) {
  return [
    ...checkRootPackageJson(rootPackageJson),
    ...checkCliPackageJson(cliPackageJson),
    ...checkNoCccPrefixedPackageNames(packageNameEntries),
    ...checkWrapperExecutable(wrapperStatus),
    ...checkReadmeMentionsCccFusion(readmeContent),
  ];
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Collect {path, name} for every packages/*\/package.json and plugins/*\/package.json. */
function collectPackageNameEntries(repoRoot) {
  const entries = [];
  for (const group of ["packages", "plugins"]) {
    const groupDir = join(repoRoot, group);
    let children;
    try {
      children = readdirSync(groupDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const relativePath = `${group}/${child.name}/package.json`;
      const manifest = readJsonIfExists(join(groupDir, child.name, "package.json"));
      if (manifest === undefined) continue;
      entries.push({ path: relativePath, name: manifest.name });
    }
  }
  return entries;
}

function readWrapperStatus(repoRoot) {
  try {
    const stat = statSync(join(repoRoot, WRAPPER_RELATIVE_PATH));
    return { exists: true, executable: (stat.mode & 0o111) !== 0 };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, executable: false };
    }
    throw error;
  }
}

function gatherLiveInputs(repoRoot) {
  return {
    rootPackageJson: readJsonIfExists(join(repoRoot, "package.json")),
    cliPackageJson: readJsonIfExists(join(repoRoot, "packages", "cli", "package.json")),
    packageNameEntries: collectPackageNameEntries(repoRoot),
    wrapperStatus: readWrapperStatus(repoRoot),
    readmeContent: (() => {
      try {
        return readFileSync(join(repoRoot, "README.md"), "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
        throw error;
      }
    })(),
  };
}

function printViolations(violations) {
  console.error("[check-ccc-shallow-brand] shallow-brand policy violation(s):");
  for (const violation of violations) {
    console.error(`  FAIL  ${violation}`);
  }
}

export function main(repoRoot = process.cwd()) {
  const violations = runShallowBrandChecks(gatherLiveInputs(repoRoot));
  if (violations.length > 0) {
    printViolations(violations);
    return 1;
  }
  console.log("[check-ccc-shallow-brand] shallow-brand policy OK");
  return 0;
}

// --- self-test: synthetic fixtures through the same pure check functions ---

function assertViolationContains(violations, needle, label) {
  if (!violations.some((line) => line.includes(needle))) {
    throw new Error(`self-test:${label}: expected a violation containing ${JSON.stringify(needle)}, got: ${JSON.stringify(violations)}`);
  }
}

function assertNoViolations(violations, label) {
  if (violations.length > 0) {
    throw new Error(`self-test:${label}: expected no violations, got: ${JSON.stringify(violations)}`);
  }
}

export function selfTest() {
  // Passing baseline: every check accepts the real current-tree shape.
  assertNoViolations(
    checkRootPackageJson({ name: EXPECTED_ROOT_PACKAGE_NAME }),
    "root-package-json:accept",
  );
  assertNoViolations(
    checkCliPackageJson({ name: EXPECTED_CLI_PACKAGE_NAME, bin: { "agent-browser": "./agent-browser.mjs", fn: "./bin.mjs", fusion: "./bin.mjs" } }),
    "cli-package-json:accept",
  );
  assertNoViolations(
    checkNoCccPrefixedPackageNames([{ path: "packages/core/package.json", name: "@fusion/core" }]),
    "no-ccc-prefixed-names:accept",
  );
  assertNoViolations(checkWrapperExecutable({ exists: true, executable: true }), "wrapper-executable:accept");
  assertNoViolations(checkReadmeMentionsCccFusion("intro\n\n## ccc-fusion\n\nbody"), "readme-mentions:accept");
  assertNoViolations(
    runShallowBrandChecks({
      rootPackageJson: { name: EXPECTED_ROOT_PACKAGE_NAME },
      cliPackageJson: { name: EXPECTED_CLI_PACKAGE_NAME, bin: { "agent-browser": "x", fn: "x", fusion: "x" } },
      packageNameEntries: [{ path: "packages/core/package.json", name: "@fusion/core" }],
      wrapperStatus: { exists: true, executable: true },
      readmeContent: "see ccc-fusion",
    }),
    "runShallowBrandChecks:accept",
  );

  // (a) root name renamed away from upstream.
  assertViolationContains(
    checkRootPackageJson({ name: "ccc-fusion-workspace" }),
    "package.json: name must be exactly",
    "root-package-json:renamed",
  );

  // (b) CLI package renamed away from upstream.
  assertViolationContains(
    checkCliPackageJson({ name: "@crashcartcapital/ccc-fusion", bin: { "agent-browser": "x", fn: "x", fusion: "x" } }),
    "packages/cli/package.json: name must be exactly",
    "cli-package-json:renamed",
  );

  // (b) CLI bin block missing an upstream key (deep rename in one direction).
  assertViolationContains(
    checkCliPackageJson({ name: EXPECTED_CLI_PACKAGE_NAME, bin: { fn: "x", fusion: "x" } }),
    "bin block is missing required key(s): agent-browser",
    "cli-package-json:bin-missing",
  );

  // (b) CLI bin block gained a "ccc-fusion" key (deep rename in the other direction).
  assertViolationContains(
    checkCliPackageJson({
      name: EXPECTED_CLI_PACKAGE_NAME,
      bin: { "agent-browser": "x", fn: "x", fusion: "x", "ccc-fusion": "./bin.mjs" },
    }),
    "bin block has unexpected key(s) (deep rename guard): ccc-fusion",
    "cli-package-json:bin-extra",
  );

  // (c) A workspace package leaks a "ccc-" prefixed internal name.
  assertViolationContains(
    checkNoCccPrefixedPackageNames([
      { path: "packages/core/package.json", name: "@fusion/core" },
      { path: "packages/ccc-thing/package.json", name: "ccc-thing" },
    ]),
    'package name "ccc-thing" starts with "ccc-"',
    "no-ccc-prefixed-names:leak",
  );

  // (d) Wrapper missing, and wrapper present but not executable.
  assertViolationContains(
    checkWrapperExecutable({ exists: false, executable: false }),
    `${WRAPPER_RELATIVE_PATH}: does not exist`,
    "wrapper-executable:missing",
  );
  assertViolationContains(
    checkWrapperExecutable({ exists: true, executable: false }),
    `${WRAPPER_RELATIVE_PATH}: exists but is not executable`,
    "wrapper-executable:not-executable",
  );

  // (e) README no longer names ccc-fusion.
  assertViolationContains(
    checkReadmeMentionsCccFusion("Fusion is a task board."),
    'README.md: does not contain "ccc-fusion"',
    "readme-mentions:missing",
  );

  // Full orchestration catches a violation mixed in with otherwise-clean inputs.
  const mixedViolations = runShallowBrandChecks({
    rootPackageJson: { name: EXPECTED_ROOT_PACKAGE_NAME },
    cliPackageJson: { name: EXPECTED_CLI_PACKAGE_NAME, bin: { "agent-browser": "x", fn: "x", fusion: "x" } },
    packageNameEntries: [{ path: "plugins/ccc-runtime/package.json", name: "ccc-runtime" }],
    wrapperStatus: { exists: true, executable: true },
    readmeContent: "see ccc-fusion",
  });
  assertViolationContains(mixedViolations, 'package name "ccc-runtime" starts with "ccc-"', "runShallowBrandChecks:mixed");

  console.log("check-ccc-shallow-brand self-test passed");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = process.argv.includes("--self-test") ? selfTest() : main();
}
