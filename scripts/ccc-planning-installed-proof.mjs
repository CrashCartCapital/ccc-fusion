#!/usr/bin/env node
/*
FNXC:CccPlanningInstalledProof 2026-10-15-01:10:
`pnpm verify:ccc-planning-installed` (card LV, CONTRACT-v3.5 section 2.20 and section 4.5). In I2 it ALWAYS exits 1 and lists everything it did not run: the neutral-directory journeys, the twelve-criterion release matrix and the held-out results belong to I6, and the fn-path keepalive arm (errata E9 ruling 4) has no offline installed-fn driver yet (card SF, the planning session factory, is not integrated). A script that exited 0 here would claim an installed-product proof that nobody has run, so exit 0 is not reachable.
What it does do, honestly and cheaply: when `--candidate <installed-runtime.json>` is given it verifies that receipt through card IP's `verifyCccPlanningInstalledRuntimeReceipt` (via the live script's wrapper, which recomputes every digest from the installed tree and refuses drift and any receipt whose `piAi.keepaliveModelSource` is not `fusion-receipt-adapter`), and the refusal line then carries the verified summary, or IP's refusal code and field when the candidate is bad. `--approval-receipt <receipt.json>` is accepted so that the same arguments as the live proof can be passed, and is neither read, hashed, written nor confirmed (D23, D52). Anything else is a usage error (exit 2). One leading literal `--` is dropped.
Output: one `ccc-planning.proof-refusal.v1` JSON line on stderr, nothing on stdout (as the P0 stub did, so the NOT_IMPLEMENTED pin of run-ccc-planning-proof.test.mjs still holds for this command). Exit codes follow ADR D Q1: 2 usage, 1 refusal or proof not run, 0 never.
E9 ruling 2: the installed keepalive lane (`scripts/__tests__/ccc-planning-installed-keepalive.test.mjs`) is parent-run and sits in no inventory card; this script does not run it either.
*/
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CCC_PLANNING_FN_PATH_KEEPALIVE_ARM,
  CCC_PLANNING_PROOF_CODES,
  CCC_PLANNING_PROOF_REFUSAL_SCHEMA,
  parseCccPlanningProofArguments,
  summarizeCccPlanningCandidate,
  verifyCccPlanningCandidate,
} from "./ccc-planning-live-proof.mjs";

export const CCC_PLANNING_INSTALLED_COMMAND = "verify:ccc-planning-installed";

/** Everything the installed proof does not run in I2. Each entry names what is missing and when it lands. */
export const CCC_PLANNING_INSTALLED_NOT_RUN = Object.freeze([
  ["neutral-directory-cli-journeys", "The neutral-directory CLI journeys of the installed product (I6): the packed fn driven from a directory outside the repository, end to end."],
  ["neutral-directory-dashboard-journeys", "The neutral-directory dashboard journeys of the installed product (I6)."],
  ["twelve-criterion-release-matrix", "The twelve-criterion release matrix (I6)."],
  ["held-out-results", "The held-out results (I6): no held-out corpus is admitted in I2."],
  [CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.id, `${CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.detail} NOT RUN: no installed fn command drives a bound session against a loopback fake OmniRoute offline (card SF, the planning session factory, is not integrated).`],
].map(([id, detail]) => Object.freeze({ id, detail })));

const INSTALLED_FLAGS = Object.freeze(["--candidate", "--approval-receipt"]);
const INSTALLED_USAGE = "node scripts/ccc-planning-installed-proof.mjs [--candidate <installed-runtime.json>] [--approval-receipt <receipt.json>]";

/**
 * @param {string[]} argv
 * @param {{ stderr?: { write(chunk: string): unknown } }} [deps]
 * @returns {Promise<{ exitCode: 1 | 2, refusal: object }>}
 */
export async function runCccPlanningInstalledProof(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr;
  const emit = (refusal) => stderr.write(`${JSON.stringify(refusal)}\n`);
  const base = { schema: CCC_PLANNING_PROOF_REFUSAL_SCHEMA, command: CCC_PLANNING_INSTALLED_COMMAND, passed: false };

  const parsed = parseCccPlanningProofArguments(argv, INSTALLED_FLAGS);
  const candidateArgument = parsed.ok ? parsed.values.get("--candidate") : undefined;
  const receiptArgument = parsed.ok ? parsed.values.get("--approval-receipt") : undefined;
  const usageDetail = !parsed.ok
    ? parsed.detail
    : candidateArgument === null || candidateArgument === ""
      ? "--candidate needs a value"
      : receiptArgument === null || receiptArgument === ""
        ? "--approval-receipt needs a value"
        : null;
  if (usageDetail !== null) {
    const refusal = { ...base, code: CCC_PLANNING_PROOF_CODES.usage, detail: usageDetail, usage: INSTALLED_USAGE };
    emit(refusal);
    return { exitCode: 2, refusal };
  }

  let candidateSummary = null;
  let code = CCC_PLANNING_PROOF_CODES.notImplemented;
  let detail = "verify:ccc-planning-installed always exits 1 before I6: the journeys, the release matrix and the held-out results are not run (see notRun).";
  let field = null;
  if (typeof candidateArgument === "string") {
    const candidatePath = path.resolve(candidateArgument);
    const verified = await verifyCccPlanningCandidate(candidatePath);
    if (verified.ok) {
      candidateSummary = summarizeCccPlanningCandidate(candidatePath, verified.receipt);
    } else {
      code = verified.code;
      detail = verified.detail;
      field = verified.field;
    }
  }
  const refusal = {
    ...base,
    code,
    detail,
    ...(field === null ? {} : { field }),
    ...(candidateSummary === null ? {} : { candidate: candidateSummary }),
    notRun: CCC_PLANNING_INSTALLED_NOT_RUN,
  };
  emit(refusal);
  return { exitCode: 1, refusal };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = (await runCccPlanningInstalledProof(process.argv.slice(2))).exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: CCC_PLANNING_PROOF_REFUSAL_SCHEMA,
      command: CCC_PLANNING_INSTALLED_COMMAND,
      passed: false,
      code: CCC_PLANNING_PROOF_CODES.internal,
      detail: error instanceof Error ? error.message : String(error),
      notRun: CCC_PLANNING_INSTALLED_NOT_RUN,
    })}\n`);
    process.exitCode = 1;
  }
}
