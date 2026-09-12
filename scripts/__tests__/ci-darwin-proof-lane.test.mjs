import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DARWIN_PROOF_LANE_FILES,
  DARWIN_PROOF_LANE_SUITES,
  decideDarwinProofLaneOutcome,
} from "../ci-darwin-proof-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the Darwin-only suite list is non-empty and every listed file exists", () => {
  assert.ok(DARWIN_PROOF_LANE_SUITES.length > 0, "expected at least one suite group");
  assert.ok(DARWIN_PROOF_LANE_FILES.length > 0, "expected at least one test file");

  for (const suite of DARWIN_PROOF_LANE_SUITES) {
    assert.ok(
      existsSync(path.join(repoRoot, suite.packageDir)),
      `suite package dir is missing: ${suite.packageDir}`,
    );
    assert.ok(suite.files.length > 0, `suite ${suite.packageDir} lists no files`);
  }

  for (const file of DARWIN_PROOF_LANE_FILES) {
    assert.ok(existsSync(path.join(repoRoot, file)), `listed test file is missing: ${file}`);
  }
});

test("every listed file is repo-relative, unique, and a TypeScript test file", () => {
  const seen = new Set();
  for (const file of DARWIN_PROOF_LANE_FILES) {
    assert.ok(!path.isAbsolute(file), `file must be repo-relative: ${file}`);
    assert.match(file, /\.test\.ts$/, `file must be a .test.ts file: ${file}`);
    assert.ok(!seen.has(file), `duplicate file in the lane list: ${file}`);
    seen.add(file);
  }
});

test("engine suites pin an explicit vitest project so engine-core never triggers a build", () => {
  for (const suite of DARWIN_PROOF_LANE_SUITES) {
    if (suite.packageDir === "packages/engine") {
      assert.equal(
        suite.project,
        "engine-default",
        "engine files must run under --project=engine-default (engine-core's globalSetup runs a build)",
      );
    }
  }
});

test("decideDarwinProofLaneOutcome passes when every suite executed tests and none failed", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 40, numFailedTests: 0, exitStatus: 0 },
    { suite: "packages/core", numTotalTests: 5, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.executed, 45);
  assert.equal(outcome.failed, 0);
  assert.match(outcome.message, /darwin-proof-lane executed 45 test\(s\)/);
});

test("decideDarwinProofLaneOutcome does NOT count skipped tests as executed", () => {
  // This is the whole point of the lane: the Darwin-only suites are expected to
  // skip themselves on hosts without a sandbox-exec backend, so a suite that
  // reports "7 tests, all pending" here proves the macOS runner ran nothing.
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/cli", numTotalTests: 7, numPendingTests: 7, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.executed, 0);
  assert.equal(outcome.skipped, 7);
  assert.match(outcome.message, /packages\/cli/);
  assert.match(outcome.message, /darwin-proof-lane executed 0 test\(s\)/);
});

test("decideDarwinProofLaneOutcome subtracts skipped tests from the executed total", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 40, numPendingTests: 4, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.executed, 36);
  assert.equal(outcome.skipped, 4);
  assert.match(outcome.message, /darwin-proof-lane executed 36 test\(s\)/);
});

test("decideDarwinProofLaneOutcome fails when zero tests executed", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 0, numFailedTests: 0, exitStatus: 0 },
    { suite: "packages/core", numTotalTests: 0, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.executed, 0);
  assert.match(outcome.message, /darwin-proof-lane executed 0 test\(s\)/);
});

test("decideDarwinProofLaneOutcome fails when a single suite executed nothing", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 40, numFailedTests: 0, exitStatus: 0 },
    { suite: "packages/cli", numTotalTests: 0, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /packages\/cli/);
});

test("decideDarwinProofLaneOutcome fails when any test failed", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 40, numFailedTests: 3, exitStatus: 1 },
    { suite: "packages/core", numTotalTests: 5, numFailedTests: 0, exitStatus: 0 },
  ]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.executed, 45);
  assert.equal(outcome.failed, 3);
  assert.match(outcome.message, /darwin-proof-lane executed 45 test\(s\)/);
});

test("decideDarwinProofLaneOutcome fails on a non-zero exit with no counted failures (crash)", () => {
  const outcome = decideDarwinProofLaneOutcome([
    { suite: "packages/engine", numTotalTests: 40, numFailedTests: 0, exitStatus: 7 },
  ]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 7);
});

test("decideDarwinProofLaneOutcome refuses an empty report set", () => {
  const outcome = decideDarwinProofLaneOutcome([]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.executed, 0);
});
