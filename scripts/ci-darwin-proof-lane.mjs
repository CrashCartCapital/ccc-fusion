#!/usr/bin/env node
/**
 * Darwin-only proof lane (full-suite.yml job `darwin-proof-lane`).
 *
 * The CCC semantic-v2 proof sandbox has exactly ONE backend — macOS
 * `sandbox-exec` (packages/engine/src/ccc-campaign-proof-sandbox.ts:
 * `inspectCccSemanticProofSandboxReadiness` returns UNAVAILABLE on every
 * non-Darwin platform). Every Linux runner therefore fails these suites for a
 * platform reason, not a product reason, and the repo's only end-to-end proof
 * vertical slice has no honest signal anywhere. This wrapper runs that exact
 * file set on a native macOS runner.
 *
 * Same failure model as scripts/assert-engine-slow-nonempty.mjs: a plain
 * `vitest run` exits 0 when it matched no files ("no tests" is not a failure by
 * default), so a glob/rename drift would make this lane deceptively green while
 * proving nothing. Zero executed tests is a hard failure here.
 *
 * stdlib only. Runs vitest per package with the json reporter and sums
 * numTotalTests / numFailedTests across the packages.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

/**
 * The Darwin-only proof suites, grouped by the package (and vitest project)
 * that owns them. Kept as one exported const so a later lockstep test can
 * compare this list against the suites that skip themselves on Linux — the
 * drift this list exists to make visible is "a Darwin-only file was added and
 * nobody added it here", which silently shrinks the only lane that runs it.
 *
 * `project` pins the vitest project explicitly where the package has more than
 * one. packages/engine MUST stay on `engine-default`: the `engine-core`
 * project's globalSetup esbuilds the core gate-bundle, so an unpinned engine
 * run silently triggers a build before any test executes.
 * packages/core and packages/cli each define a single unnamed project, so they
 * take no `--project` flag (`project: null`).
 */
export const DARWIN_PROOF_LANE_SUITES = Object.freeze([
  Object.freeze({
    packageDir: "packages/engine",
    filterName: "@fusion/engine",
    project: "engine-default",
    files: Object.freeze([
      "src/__tests__/ccc-campaign-proof-sandbox.test.ts",
      "src/__tests__/ccc-campaign-proof-materialization.test.ts",
      "src/__tests__/ccc-campaign-semantic-proof-execution.test.ts",
      "src/__tests__/ccc-campaign-ready-verifier.real-git.test.ts",
      "src/__tests__/ccc-gate2-usefulness-probe.test.ts",
      "src/__tests__/ccc-campaign-runtime-bootstrap.real-pg.test.ts",
      "src/__tests__/ccc-campaign-required-commit.real-git.test.ts",
      "src/__tests__/ccc-python-proof-adapter.test.ts",
    ]),
  }),
  Object.freeze({
    packageDir: "packages/core",
    filterName: "@fusion/core",
    project: null,
    files: Object.freeze(["src/__tests__/ccc-prd-semantic-proof-custody.test.ts"]),
  }),
  Object.freeze({
    packageDir: "packages/cli",
    filterName: "@fusion/cli",
    project: null,
    files: Object.freeze([
      "src/commands/__tests__/ccc-golden-evidence-ledger.real-pg.test.ts",
    ]),
  }),
]);

/** Flat, repo-relative view of every file this lane must execute. */
export const DARWIN_PROOF_LANE_FILES = Object.freeze(
  DARWIN_PROOF_LANE_SUITES.flatMap((suite) =>
    suite.files.map((file) => `${suite.packageDir}/${file}`),
  ),
);

/** Tests a suite actually RAN: vitest's total minus its pending/skipped count. */
function executedIn(row) {
  const total = Number(row.numTotalTests) || 0;
  const pending = Number(row.numPendingTests) || 0;
  return Math.max(0, total - pending);
}

/**
 * Pure decision function: given one report per suite, decide whether the lane
 * passed. Split out from the spawning so the failure branches are unit-testable
 * without running vitest.
 *
 * Skipped tests deliberately do NOT count as executed. That is the failure mode
 * this lane exists to catch: these suites are expected to skip themselves on a
 * host with no sandbox-exec backend, so "7 tests, all pending" on the macOS
 * runner means the runner proved nothing — and vitest would still exit 0.
 *
 * @param {ReadonlyArray<{suite: string, numTotalTests: number, numPendingTests?: number, numFailedTests: number, exitStatus: number}>} reports
 * @returns {{ok: boolean, exitCode: number, executed: number, skipped: number, failed: number, message: string}}
 */
export function decideDarwinProofLaneOutcome(reports) {
  const rows = Array.isArray(reports) ? reports : [];
  const executed = rows.reduce((sum, row) => sum + executedIn(row), 0);
  const skipped = rows.reduce((sum, row) => sum + (Number(row.numPendingTests) || 0), 0);
  const failed = rows.reduce((sum, row) => sum + (Number(row.numFailedTests) || 0), 0);
  const headline = `darwin-proof-lane executed ${executed} test(s)`;
  const base = { executed, skipped, failed };

  if (rows.length === 0) {
    return {
      ...base,
      ok: false,
      exitCode: 1,
      message: `✗ ${headline}: no suite reports were produced at all.`,
    };
  }

  const emptySuites = rows.filter((row) => executedIn(row) === 0).map((row) => row.suite);
  if (emptySuites.length > 0) {
    return {
      ...base,
      ok: false,
      exitCode: 1,
      message:
        `✗ ${headline}; these suites executed 0 tests: ${emptySuites.join(", ")}. ` +
        "The Darwin-only proof lane is silently empty (skipped on this host, or " +
        "glob/rename/project drift). Failing.",
    };
  }

  if (failed > 0) {
    return {
      ...base,
      ok: false,
      exitCode: 1,
      message: `✗ ${headline} and reported ${failed} failure(s).`,
    };
  }

  const crashed = rows.find((row) => (Number(row.exitStatus) || 0) !== 0);
  if (crashed) {
    return {
      ...base,
      ok: false,
      exitCode: Number(crashed.exitStatus) || 1,
      message:
        `✗ ${headline} with no counted failures, but ${crashed.suite} exited ` +
        `${crashed.exitStatus} (crash, unhandled rejection, or config error).`,
    };
  }

  return {
    ...base,
    ok: true,
    exitCode: 0,
    message: `✓ ${headline} and passed${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
  };
}

function runSuite(suite) {
  const packageDir = path.join(repoRoot, suite.packageDir);
  const outputFile = path.join(packageDir, ".darwin-proof-lane-results.json");
  if (existsSync(outputFile)) rmSync(outputFile, { force: true });

  const args = ["exec", "vitest", "run"];
  if (suite.project) args.push(`--project=${suite.project}`);
  args.push(
    "--silent=passed-only",
    "--reporter=dot",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...suite.files,
  );

  console.log(`\n── darwin-proof-lane: ${suite.packageDir} (${suite.files.length} file(s)) ──`);
  const result = spawnSync("pnpm", args, {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env },
  });

  if (result.error) {
    console.error(`✗ failed to run ${suite.packageDir}: ${result.error.message}`);
    return { suite: suite.packageDir, numTotalTests: 0, numFailedTests: 0, exitStatus: 1 };
  }

  if (!existsSync(outputFile)) {
    console.error(
      `✗ ${suite.packageDir} produced no JSON results file; cannot assert execution`,
    );
    return { suite: suite.packageDir, numTotalTests: 0, numFailedTests: 0, exitStatus: 1 };
  }

  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, "utf8"));
  } catch (err) {
    console.error(`✗ could not parse ${suite.packageDir} results: ${err.message}`);
    return { suite: suite.packageDir, numTotalTests: 0, numFailedTests: 0, exitStatus: 1 };
  } finally {
    rmSync(outputFile, { force: true });
  }

  const numTotalTests =
    typeof report.numTotalTests === "number"
      ? report.numTotalTests
      : (report.testResults || []).reduce(
          (sum, file) => sum + (file.assertionResults?.length || 0),
          0,
        );
  const numFailedTests =
    typeof report.numFailedTests === "number"
      ? report.numFailedTests
      : (report.testResults || []).reduce(
          (sum, file) =>
            sum + (file.assertionResults || []).filter((a) => a.status === "failed").length,
          0,
        );
  // "pending" is vitest's json-reporter name for skipped/todo tests.
  const numPendingTests =
    typeof report.numPendingTests === "number"
      ? report.numPendingTests
      : (report.testResults || []).reduce(
          (sum, file) =>
            sum +
            (file.assertionResults || []).filter(
              (a) => a.status === "pending" || a.status === "skipped" || a.status === "todo",
            ).length,
          0,
        );

  return {
    suite: suite.packageDir,
    numTotalTests,
    numPendingTests,
    numFailedTests,
    exitStatus: result.status ?? 1,
  };
}

export function main() {
  const reports = DARWIN_PROOF_LANE_SUITES.map(runSuite);

  console.log("\n── darwin-proof-lane per-suite execution ──");
  for (const report of reports) {
    console.log(
      `  ${report.suite}: ${report.numTotalTests} total, ${report.numPendingTests} skipped, ` +
        `${report.numFailedTests} failed, exit ${report.exitStatus}`,
    );
  }

  const outcome = decideDarwinProofLaneOutcome(reports);
  if (outcome.ok) {
    console.log(outcome.message);
  } else {
    console.error(outcome.message);
  }
  return outcome.exitCode;
}

if (process.argv[1] && currentFilePath === process.argv[1]) {
  process.exitCode = main();
}
