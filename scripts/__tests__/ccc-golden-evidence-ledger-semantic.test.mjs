import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeContractCandidate } from "./helpers/ccc-golden-evidence-ledger-candidate.mjs";
import { createEvidenceLedgerBaseline } from "../lib/ccc-golden-evidence-ledger.mjs";

test("PRD:GOLDEN-1 campaign mode emits exact semantic-v2 proof evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-semantic-green-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    const sourceCommit = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs", "src/record.mjs", "src/validation.mjs",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CCC_PROOF_ID: "PROOF-LEDGER-CONTRACT",
        CCC_PROOF_PHASE: "task",
        CCC_PROOF_SOURCE_COMMIT: sourceCommit,
        CCC_PROOF_SOURCE_TREE: sourceTree,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: "ccc-prd.proof-evidence.v2",
      proofId: "PROOF-LEDGER-CONTRACT",
      phase: "task",
      sourceCommit,
      sourceTree,
      passed: true,
      clauseResults: [{ clauseId: "AC-REQ-LEDGER-CONTRACT-001", passed: true }],
      positiveCaseResults: [{ caseId: "CASE-LEDGER-CONTRACT", passed: true }],
      negativeControlResults: [{ controlId: "CONTROL-LEDGER-CONTRACT", passed: true }],
    });
    const mismatched = spawnSync(process.execPath, [
      "verify/project-verifier.mjs", "src/record.mjs", "src/validation.mjs",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CCC_PROOF_ID: "PROOF-NOT-ADMITTED",
        CCC_PROOF_PHASE: "task",
        CCC_PROOF_SOURCE_COMMIT: sourceCommit,
        CCC_PROOF_SOURCE_TREE: sourceTree,
      },
    });
    assert.equal(mismatched.status, 1, mismatched.stdout);
    assert.equal(JSON.parse(mismatched.stdout).passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
