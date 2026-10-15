#!/usr/bin/env node
/*
FNXC:CccPlanningLiveProof 2026-10-15-00:30:
`pnpm verify:ccc-planning-live` (card LV, CONTRACT-v3.5 section 2.20, section 4.2 step 5, section 4.5, D23, D52; errata E9 rulings 2 and 4). It drives the INSTALLED `fn` end to end on the owned disposable target and records `ccc-planning.live-proof-report.v1`. It never authors, confirms, completes or hashes an authority receipt:
- `--confirm-authority <digest>` is the value Ryan typed. The script checks only that one was typed (a missing, empty or valueless flag is `CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED` before anything is spawned) and hands the bytes to `fn plan start` unchanged. It does not trim, case-fold, validate, compare or record the value, and it never reads the receipt: it only checks that the file exists. Whether the digest is right is G0's job; a wrong one comes back as the downstream refusal, reported unchanged. This is a procedural control, recorded but not authenticated (D52).
- `--profile` accepts only `full`. `adaptive` and `lean` exit 1 with `CCC_PLANNING_PROFILE_NOT_IMPLEMENTED`.
- `--candidate` is the installed-runtime receipt of card IP. IP's `verifyCccPlanningInstalledRuntimeReceipt` recomputes every digest from the installed tree and refuses drift and any receipt whose `piAi.keepaliveModelSource` is not `fusion-receipt-adapter`; this script only calls it. Serve launch, the Pueue lane, PostgreSQL and the sealed `fn` environment are IP's modules too (`ccc-planning-serve-lane.mjs`, `ccc-installed-cli.mjs`); nothing is re-implemented here.
Sequence after the checks: the fn-path keepalive arm (E9 ruling 4, below), 5a serve lane (Pueue group `ccc-r2c-i2`), 5b `fn plan start ... --json` (expects `run_admitted` with `plannedPlanningNodes` 14), 5c `fn plan status <runId> --json` every 60 s until the state is in `cccPlanningRestingStates("build")`, the terminal states or the operator-wait states. The poll is an async timer inside this process, never a shell sleep; the parent runs the script in the background and watches its progress lines on stderr. The script stops the serve task it started (IP's `stop`: `pueue kill` of that task id only, then a check that no process of its group remains) in every outcome except one: when the poll stops at an operator-wait state the run is not finished and serve is its only executor, so serve is left running, the report says so and names the Pueue task id, and the parent's step 6 tears it down. Step 6's PostgreSQL stop and evidence move stay the parent's.
The report is written once to `<ROOT>/evidence/live-proof-report.json` (exclusive create) and printed as one JSON line on stdout. Early refusals (nothing started) print one `ccc-planning.proof-refusal.v1` line on stderr and nothing on stdout, as the P0 stub did. Progress events go to stderr as `ccc-planning.live-proof-progress.v1` lines. Exit codes (ADR D Q1): 0 only when the run reached `accepted`; 1 for a refusal or any failed, partial or incomplete proof; 2 for a usage error. One leading literal `--` is dropped.
Arguments beyond the four the contract names: `--project <projectId>` and `--database-url <owned PostgreSQL url>` are required because the step 5 command line supplies neither (step 3's `fn project add` result and step 2's owned PostgreSQL are known only to the parent), and `--path-env <PATH>` is optional (default: this process's PATH; step 5a's "sealed path"). `<ROOT>` is derived from `--candidate`, which must sit at `<ROOT>/evidence/<file>`; the target, home, tmp and request paths follow the ADR D Q4 layout.
E9 ruling 4, the fn-path keepalive arm: a session with custom provider equal to defaultProvider and receipt adapter `terminal-route-sse-comments.v1`, run through the installed fn against a loopback fake OmniRoute. It runs before 5b (and before 5a, so a failing arm starts nothing) only if a driver is supplied. No installed fn command drives a bound session offline today (card SF is not integrated and the packaged CLI exports no session factory), so the default is a `not_run` record with the reason, never `passed`, and the report lists it under `notRun`. A supplied driver returns observations and THIS script judges them; a driver's own verdict is never trusted.
E9 ruling 2: the installed keepalive lane (`scripts/__tests__/ccc-planning-installed-keepalive.test.mjs`) is parent-run at step 0 and is not in the proof inventory. This script does not run it; the report records step 0 as `parent_run` with the command.
Hang bounds below (fn start, fn status, poll margin) are not measurements: no real live run has happened.
*/
import { realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runInstalledFnJsonCommand } from "./lib/ccc-installed-cli.mjs";
import { verifyCccPlanningInstalledRuntimeReceipt } from "./lib/ccc-planning-installed-runtime.mjs";
import {
  CccPlanningServeLaneError,
  buildCccPlanningServeLaunch,
  startCccPlanningServeLane,
  stopCccPlanningServeLane,
} from "./lib/ccc-planning-serve-lane.mjs";

export const CCC_PLANNING_LIVE_PROOF_REPORT_SCHEMA = "ccc-planning.live-proof-report.v1";
export const CCC_PLANNING_PROOF_REFUSAL_SCHEMA = "ccc-planning.proof-refusal.v1";
export const CCC_PLANNING_LIVE_PROGRESS_SCHEMA = "ccc-planning.live-proof-progress.v1";
export const CCC_PLANNING_LIVE_COMMAND = "verify:ccc-planning-live";
export const CCC_PLANNING_INSTALLED_KEEPALIVE_LANE_COMMAND = "PI_OFFLINE=1 node --test scripts/__tests__/ccc-planning-installed-keepalive.test.mjs";

export const CCC_PLANNING_PROOF_CODES = Object.freeze({
  usage: "CCC_PLANNING_PROOF_USAGE",
  notImplemented: "CCC_PLANNING_PROOF_NOT_IMPLEMENTED",
  profileNotImplemented: "CCC_PLANNING_PROFILE_NOT_IMPLEMENTED",
  confirmationRequired: "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED",
  candidateInvalid: "CCC_PLANNING_INSTALLED_RUNTIME_INVALID",
  inputMissing: "CCC_PLANNING_LIVE_INPUT_MISSING",
  keepaliveArmFailed: "CCC_PLANNING_LIVE_KEEPALIVE_ARM_FAILED",
  fnFailed: "CCC_PLANNING_LIVE_FN_FAILED",
  fnOutputInvalid: "CCC_PLANNING_LIVE_FN_OUTPUT_INVALID",
  planStartUnexpected: "CCC_PLANNING_LIVE_PLAN_START_UNEXPECTED",
  pollDeadline: "CCC_PLANNING_LIVE_POLL_DEADLINE",
  operatorWait: "CCC_PLANNING_LIVE_OPERATOR_WAIT",
  runNotAccepted: "CCC_PLANNING_LIVE_RUN_NOT_ACCEPTED",
  aborted: "CCC_PLANNING_LIVE_ABORTED",
  internal: "CCC_PLANNING_PROOF_INTERNAL_ERROR",
});

/** Run states by role in the poll. Pinned to packages/core/src/ccc-planning/types.ts by the test file (a script cannot import the TypeScript source). */
export const CCC_PLANNING_LIVE_RESTING_STATES = Object.freeze(["accepted", "verification_failed"]);
export const CCC_PLANNING_LIVE_TERMINAL_STATES = Object.freeze(["cancelled", "delivered", "failed"]);
export const CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES = Object.freeze([
  "awaiting_intent", "awaiting_budget", "awaiting_execution_authority", "paused",
  "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect",
]);
/** The remaining run states: the poll keeps going. */
export const CCC_PLANNING_LIVE_IN_PROGRESS_STATES = Object.freeze(["admitted", "running", "spec_ready", "importing", "building", "cancelling", "delivering"]);

export const CCC_PLANNING_FN_PATH_KEEPALIVE_ARM = Object.freeze({
  id: "fn-path-keepalive-arm",
  receiptAdapterId: "terminal-route-sse-comments.v1",
  detail: "A session with custom provider equal to defaultProvider and receipt adapter terminal-route-sse-comments.v1, run through the installed fn against a loopback fake OmniRoute, must report the true model although the keepalive chunks carry a placeholder (errata E9 ruling 4).",
});

/** CONTRACT-v3.5 section 4.5, one entry per declared NOT RUN bullet (the procedural controls are in `notEnforced`). */
export const CCC_PLANNING_I2_NOT_RUN = Object.freeze([
  ["g9-delivery-and-landing", "G9 delivery and any landing on the target's main (leader ruling: no landing in I2; the target has no remote)."],
  ["flash-extraction-leaves", "Flash extraction leaves (not run in I2 Standard; the leaf role must be exercised before final acceptance, I6)."],
  ["coding-repair", "Coding repair: a G7 or G8 rejection ends verification_failed with CCC_PLANNING_CODING_REPAIR_NOT_RUN."],
  ["observed-acceptance-auditor", "The observed-acceptance auditor (P = 0)."],
  ["live-spec-mode", "Live Spec mode: only the offline fake-model run exists, and per PRD section 7 that proof does not count for the mode."],
  ["plan-build-budget-amendments-escalation-pause-resume", "fn plan build, fn plan budget, amendments, the escalation ladder, and pause or resume while importing or building (refused with CCC_PLANNING_COMMAND_NOT_SUPPORTED; fn plan cancel during building is in I2)."],
  ["adaptive-v2-and-lean-v2", "ADAPTIVE-v2 and LEAN-v2."],
  ["dashboard-and-mail-surfaces", "Dashboard and mail surfaces."],
  ["multi-root-concurrency-resource-ramp", "Multi-root graphs, concurrency above 1, and the resource ramp."],
  ["qualification-certificate-held-out-admitted-repositories", "The qualification certificate, the held-out corpus and admitted (non-disposable) repositories."],
  ["linux-confinement-backend", "The Linux confinement backend."],
  ["macos-ci-evidence", "macOS CI evidence (dispatching it is consult-gated)."],
  ["verify-ccc-planning-installed", "verify:ccc-planning-installed, which exits 1 by design."],
  ["raw-m3-tool-call-probe", "A raw M3 tool-call probe before I2 (deferred by ruling; M3's tool behaviour is first observed at the live preflight)."],
  ["unlinked-campaign-turn-key-retry-index", "A retry index on unlinked campaign turn keys (direct fn prd campaigns are unchanged until I3)."],
].map(([id, detail]) => Object.freeze({ id, detail })));

/** D52: three controls that code does not enforce. Each records its actor (OS user plus optional --actor), none authenticates it. */
export const CCC_PLANNING_NOT_ENFORCED = Object.freeze([
  Object.freeze({
    id: "authority-digest-typed-by-operator",
    detail: "Ryan types the receipt digest and no code authenticates who typed it; any local process can compute that digest. This script passes the typed bytes to fn plan start unchanged and never computes, reads back or writes it (D23, D52).",
  }),
  Object.freeze({
    id: "fn-plan-answer",
    detail: "fn plan answer records its actor (OS user plus optional --actor) in the audit event and artifact producer; the actor is recorded, not authenticated, and any local process with the same database access could answer (D52).",
  }),
  Object.freeze({
    id: "fn-plan-pause-cancel-resume",
    detail: "fn plan pause, cancel and resume record their actor (OS user plus optional --actor) in the audit event; the actor is recorded, not authenticated (D52).",
  }),
]);

const LIVE_USAGE = "node scripts/ccc-planning-live-proof.mjs --profile full --candidate <installed-runtime.json> --approval-receipt <receipt.json> --confirm-authority <digest as typed> --project <projectId> --database-url <owned PostgreSQL url> [--path-env <PATH>]";
const LIVE_FLAGS = Object.freeze(["--profile", "--candidate", "--approval-receipt", "--confirm-authority", "--project", "--database-url", "--path-env"]);
const PROFILES = Object.freeze(["full", "adaptive", "lean"]);
const SERVE_GROUP = "ccc-r2c-i2";
const SERVE_LABEL = "ccc-planning-i2-serve";
const REPORT_FILE = "live-proof-report.json";
const EXPECTED_PLANNED_PLANNING_NODES = 14;
const SESSION_FACTORY_MARKER = "ccc-planning/session-factory";
/** Contract section 4.2 step 5c: polled every 60 s. */
const POLL_INTERVAL_MS = 60_000;
/** Hang bounds, not measurements (no real live run has happened). */
const POLL_DEADLINE_MARGIN_MS = 10 * 60_000;
const FN_START_TIMEOUT_MS = 10 * 60_000;
const FN_STATUS_TIMEOUT_MS = 2 * 60_000;

export class CccPlanningLiveProofError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = "CccPlanningLiveProofError";
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

const clip = (value) => (value.length > 80 ? `${value.slice(0, 80)}...` : value);

/**
 * Flags are `--name value` or `--name=value`; one leading literal `--` is dropped. A value is the next token unless that token starts with `--`, in which case the flag has no value (`null`). The caller decides what a valueless flag means.
 * @returns {{ ok: true, values: Map<string, string | null> } | { ok: false, detail: string }}
 */
export function parseCccPlanningProofArguments(argv, allowedFlags) {
  const tokens = [...argv];
  if (tokens[0] === "--") tokens.shift();
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) return { ok: false, detail: `unexpected argument ${JSON.stringify(clip(token))}` };
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!allowedFlags.includes(name)) return { ok: false, detail: `unknown flag ${JSON.stringify(clip(name))}` };
    if (values.has(name)) return { ok: false, detail: `duplicate flag ${name}` };
    if (equals !== -1) {
      values.set(name, token.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(name, null);
    } else {
      values.set(name, next);
      index += 1;
    }
  }
  return { ok: true, values };
}

function makeOutput(deps) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  return {
    result: (value) => stdout.write(`${JSON.stringify(value)}\n`),
    diagnostic: (value) => stderr.write(`${JSON.stringify(value)}\n`),
  };
}

/** An early refusal: nothing was started, one JSON line on stderr, nothing on stdout. */
function refuseEarly(out, command, exitCode, code, detail, extra = {}) {
  const refusal = { schema: CCC_PLANNING_PROOF_REFUSAL_SCHEMA, command, passed: false, code, detail, ...extra };
  out.diagnostic(refusal);
  return { exitCode, refusal };
}

const usageRefusal = (out, command, detail, usage) => refuseEarly(out, command, 2, CCC_PLANNING_PROOF_CODES.usage, detail, { usage });

/** The summary of a verified installed-runtime receipt, copied from the receipt IP returned (nothing is recomputed here). */
export function summarizeCccPlanningCandidate(candidatePath, receipt) {
  return {
    path: candidatePath,
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
    executablePath: receipt.executablePath,
    installedRoot: receipt.installedRoot,
    tarballSha256: receipt.tarballSha256,
    executableSha256: receipt.executableSha256,
    distManifestSha256: receipt.distManifestSha256,
    versionOutputSha256: receipt.versionOutputSha256,
    piAi: {
      version: receipt.piAi.version,
      shipping: receipt.piAi.shipping,
      workspacePatch: receipt.piAi.workspacePatch,
      keepaliveModelSource: receipt.piAi.keepaliveModelSource,
    },
  };
}

/**
 * Verify a candidate through IP. Any failure is a refusal that keeps IP's code and field; a non-IP failure (a probe that could not run) is reported as the same code, because a candidate that cannot be verified is not accepted.
 * @returns {Promise<{ ok: true, receipt: object } | { ok: false, code: string, detail: string, field: string | null }>}
 */
export async function verifyCccPlanningCandidate(candidatePath) {
  try {
    return { ok: true, receipt: await verifyCccPlanningInstalledRuntimeReceipt(candidatePath) };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" && error.code.startsWith("CCC_PLANNING_") ? error.code : CCC_PLANNING_PROOF_CODES.candidateInvalid,
      detail: error instanceof Error ? error.message : String(error),
      field: typeof error?.field === "string" ? error.field : null,
    };
  }
}

async function statKind(target) {
  try {
    const stats = await stat(target);
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
    throw error;
  }
}

const iso = (now) => new Date(now()).toISOString();

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function probeMissingFnPathDriver(installedRoot) {
  let bundled = false;
  try {
    bundled = (await readFile(path.join(installedRoot, "dist", "bin.js"), "utf8")).includes(SESSION_FACTORY_MARKER);
  } catch {
    bundled = false;
  }
  return bundled
    ? "the installed bundle carries the planning session factory, but no installed fn command drives a bound session against a loopback fake OmniRoute offline"
    : "the installed bundle carries no planning session factory (card SF is not integrated), so no installed fn path opens a bound session offline";
}

/**
 * E9 ruling 4. Without a driver: `not_run`, with the reason. With one: the driver returns observations and this function judges them.
 * Observations: { customProvider, defaultProvider, receiptAdapterId, placeholderModel, expectedModel, observedModel }.
 */
export async function runCccPlanningFnPathKeepaliveArm(input, driver) {
  const base = { id: CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.id };
  if (typeof driver !== "function") {
    return { ...base, status: "not_run", reason: await probeMissingFnPathDriver(input.installedRoot) };
  }
  let observed;
  try {
    observed = await driver(input);
  } catch (error) {
    return { ...base, status: "failed", reason: `the driver threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = (key) => (typeof observed?.[key] === "string" && observed[key] !== "" ? observed[key] : null);
  const evidence = Object.fromEntries(["customProvider", "defaultProvider", "receiptAdapterId", "placeholderModel", "expectedModel", "observedModel"].map((key) => [key, text(key)]));
  const missing = Object.entries(evidence).filter(([, value]) => value === null).map(([key]) => key);
  if (missing.length > 0) return { ...base, status: "failed", reason: `the driver did not report ${missing.join(", ")}`, evidence };
  if (evidence.customProvider !== evidence.defaultProvider) {
    return { ...base, status: "failed", reason: `custom provider ${evidence.customProvider} is not defaultProvider ${evidence.defaultProvider}`, evidence };
  }
  if (evidence.receiptAdapterId !== CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.receiptAdapterId) {
    return { ...base, status: "failed", reason: `receipt adapter ${evidence.receiptAdapterId} is not ${CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.receiptAdapterId}`, evidence };
  }
  if (evidence.observedModel === evidence.placeholderModel) {
    return { ...base, status: "failed", reason: "the session reported the keepalive placeholder model", evidence };
  }
  if (evidence.observedModel !== evidence.expectedModel) {
    return { ...base, status: "failed", reason: `the session reported ${evidence.observedModel}, not the true model ${evidence.expectedModel}`, evidence };
  }
  return { ...base, status: "passed", reason: "the session reported the true model and not the placeholder", evidence };
}

function newReport(context) {
  return {
    schema: CCC_PLANNING_LIVE_PROOF_REPORT_SCHEMA,
    command: CCC_PLANNING_LIVE_COMMAND,
    profile: "full",
    passed: true,
    startedAt: iso(context.now),
    finishedAt: null,
    step0: { status: "parent_run", command: CCC_PLANNING_INSTALLED_KEEPALIVE_LANE_COMMAND },
    root: context.root,
    candidate: context.candidateSummary,
    approvalReceiptPath: context.approvalPath,
    authorityConfirmation: { source: "operator-typed", passedThroughUnchanged: true, scriptComputedOrRecordedIt: false },
    keepaliveArm: null,
    serve: null,
    planStart: null,
    run: null,
    reportPath: context.reportPath,
    notRun: [],
    notEnforced: CCC_PLANNING_NOT_ENFORCED,
  };
}

function setOutcome(report, code, detail, extra = {}) {
  if (!report.passed) return;
  report.passed = false;
  report.code = code;
  report.detail = detail;
  Object.assign(report, extra);
}

function describeError(error) {
  if (error instanceof CccPlanningLiveProofError) return { code: error.code, detail: error.detail, extra: error.extra };
  if (error instanceof CccPlanningServeLaneError) return { code: error.code, detail: error.message, extra: { field: error.field } };
  return { code: CCC_PLANNING_PROOF_CODES.internal, detail: error instanceof Error ? error.message : String(error), extra: {} };
}

async function runFn(context, args, timeoutMs) {
  try {
    return await runInstalledFnJsonCommand({
      executablePath: context.candidate.executablePath,
      args,
      cwd: context.targetDir,
      home: context.homeDir,
      extraEnv: { DATABASE_URL: context.databaseUrl, TMPDIR: context.tmpDir },
      parentEnv: context.fnParentEnv,
      timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("installed fn emitted a non-JSON stdout line") ? CCC_PLANNING_PROOF_CODES.fnOutputInvalid : CCC_PLANNING_PROOF_CODES.fnFailed;
    throw new CccPlanningLiveProofError(code, `fn ${args.slice(0, 2).join(" ")}: ${message}`);
  }
}

/** Interpret the single line `fn plan ... --json` printed. A downstream refusal or usage error keeps its code and detail unchanged. */
function singleLine(result, label) {
  if (result.values.length !== 1 || typeof result.values[0] !== "object" || result.values[0] === null) {
    throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, `${label} printed ${result.values.length} JSON line(s) on stdout, expected exactly one (exit ${result.exitCode})`);
  }
  return result.values[0];
}

function downstreamFailure(line, exitCode, label) {
  const expectedExit = line.kind === "refusal" ? 1 : 2;
  if (typeof line.code !== "string" || line.code === "" || exitCode !== expectedExit) {
    throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, `${label} printed a ${line.kind} line (code ${JSON.stringify(line.code)}) with exit ${exitCode}`);
  }
  return new CccPlanningLiveProofError(line.code, typeof line.detail === "string" ? line.detail : "", {
    source: label,
    ...(typeof line.field === "string" ? { field: line.field } : {}),
    refusal: line,
  });
}

async function startPlan(context, report) {
  const args = [
    "plan", "start",
    "--project", context.projectId,
    "--request-file", context.requestFile,
    "--mode", "build",
    "--budget-profile", "standard",
    "--authority-receipt", context.approvalPath,
    "--confirm-authority", context.typedDigest,
    "--json",
  ];
  const result = await runFn(context, args, FN_START_TIMEOUT_MS);
  report.planStart = { exitCode: result.exitCode, lines: result.values };
  const line = singleLine(result, "fn plan start");
  if (line.kind === "refusal" || line.kind === "usage_error") throw downstreamFailure(line, result.exitCode, "fn plan start");
  if (line.kind !== "run_admitted" || result.exitCode !== 0) {
    throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, `fn plan start printed a ${String(line.kind)} line with exit ${result.exitCode}`);
  }
  if (typeof line.runId !== "string" || line.runId === "") {
    throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, "fn plan start run_admitted line has no runId");
  }
  if (line.projectId !== context.projectId || line.plannedPlanningNodes !== EXPECTED_PLANNED_PLANNING_NODES) {
    throw new CccPlanningLiveProofError(
      CCC_PLANNING_PROOF_CODES.planStartUnexpected,
      `run_admitted named project ${JSON.stringify(line.projectId)} with plannedPlanningNodes ${JSON.stringify(line.plannedPlanningNodes)}; expected project ${context.projectId} and ${EXPECTED_PLANNED_PLANNING_NODES}`,
    );
  }
  const deadline = Date.parse(line.deadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, `run_admitted deadlineAt ${JSON.stringify(line.deadlineAt)} is not a timestamp`);
  }
  return { runId: line.runId, deadlineMs: deadline };
}

const KNOWN_STATES = new Set([
  ...CCC_PLANNING_LIVE_RESTING_STATES, ...CCC_PLANNING_LIVE_TERMINAL_STATES,
  ...CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES, ...CCC_PLANNING_LIVE_IN_PROGRESS_STATES,
]);

/** Poll `fn plan status` until a resting, terminal or operator-wait state, the run deadline plus a margin, or an abort. */
async function pollRun(context, report, admitted) {
  const runRecord = { runId: admitted.runId, polls: 0, transitions: [], finalState: null, stoppedBecause: null, finalStatus: null };
  report.run = runRecord;
  const stopAt = admitted.deadlineMs + POLL_DEADLINE_MARGIN_MS;
  for (;;) {
    if (context.signal?.aborted) {
      throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.aborted, "the proof was aborted while polling; serve is stopped");
    }
    const result = await runFn(context, ["plan", "status", admitted.runId, "--json"], FN_STATUS_TIMEOUT_MS);
    runRecord.polls += 1;
    const line = singleLine(result, "fn plan status");
    if (line.kind === "refusal" || line.kind === "usage_error") {
      runRecord.lastLine = line;
      throw downstreamFailure(line, result.exitCode, "fn plan status");
    }
    const state = line.status?.state;
    if (line.kind !== "status" || result.exitCode !== 0 || typeof state !== "string" || !KNOWN_STATES.has(state)) {
      throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.fnOutputInvalid, `fn plan status printed a ${String(line.kind)} line with state ${JSON.stringify(state)} and exit ${result.exitCode}`);
    }
    runRecord.finalStatus = line.status;
    if (runRecord.finalState !== state) {
      runRecord.transitions.push({ state, stateCode: line.status.stateCode ?? null, at: iso(context.now) });
      context.out.diagnostic({ schema: CCC_PLANNING_LIVE_PROGRESS_SCHEMA, event: "state", runId: admitted.runId, state, stateCode: line.status.stateCode ?? null, polls: runRecord.polls });
    }
    runRecord.finalState = state;
    if (CCC_PLANNING_LIVE_RESTING_STATES.includes(state)) { runRecord.stoppedBecause = "resting"; return runRecord; }
    if (CCC_PLANNING_LIVE_TERMINAL_STATES.includes(state)) { runRecord.stoppedBecause = "terminal"; return runRecord; }
    if (CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES.includes(state)) { runRecord.stoppedBecause = "operator_wait"; return runRecord; }
    if (context.now() >= stopAt) {
      runRecord.stoppedBecause = "poll_deadline";
      throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.pollDeadline, `the run was still ${state} ${POLL_DEADLINE_MARGIN_MS} ms after its deadline ${new Date(admitted.deadlineMs).toISOString()}`);
    }
    await context.sleep(POLL_INTERVAL_MS, context.signal);
  }
}

function judgeFinalState(report, runRecord) {
  const state = runRecord.finalState;
  if (state === "accepted") return { leaveServeRunning: false };
  if (runRecord.stoppedBecause === "operator_wait") {
    setOutcome(report, CCC_PLANNING_PROOF_CODES.operatorWait, `the run is waiting on the operator in ${state}; serve was left running, so the parent finishes the run and then tears serve down (step 6)`);
    return { leaveServeRunning: true };
  }
  setOutcome(report, CCC_PLANNING_PROOF_CODES.runNotAccepted, `the run ended in ${state}${runRecord.finalStatus?.stateCode ? ` (${runRecord.finalStatus.stateCode})` : ""}, not accepted`);
  return { leaveServeRunning: false };
}

async function driveLiveSequence(context, report) {
  const { out } = context;
  let lane = null;
  let leaveServeRunning = false;
  try {
    // E9 ruling 4: before 5b, and before 5a so that a failing arm starts nothing.
    const arm = await runCccPlanningFnPathKeepaliveArm(
      { installedRoot: context.candidate.installedRoot, executablePath: context.candidate.executablePath, home: context.homeDir },
      context.fnPathKeepaliveDriver,
    );
    report.keepaliveArm = arm;
    out.diagnostic({ schema: CCC_PLANNING_LIVE_PROGRESS_SCHEMA, event: "keepalive-arm", status: arm.status });
    if (arm.status === "failed") {
      throw new CccPlanningLiveProofError(CCC_PLANNING_PROOF_CODES.keepaliveArmFailed, arm.reason);
    }

    lane = await context.serve.start(context.serveInput, context.serveHost);
    report.serve = { group: SERVE_GROUP, pueueTaskId: lane.pueueTaskId, pid: lane.pid, port: lane.port, stopped: false, leftRunning: false, descendantsRemaining: null };
    out.diagnostic({ schema: CCC_PLANNING_LIVE_PROGRESS_SCHEMA, event: "serve-started", pueueTaskId: lane.pueueTaskId, port: lane.port });

    const admitted = await startPlan(context, report);
    out.diagnostic({ schema: CCC_PLANNING_LIVE_PROGRESS_SCHEMA, event: "run-admitted", runId: admitted.runId });

    const runRecord = await pollRun(context, report, admitted);
    leaveServeRunning = judgeFinalState(report, runRecord).leaveServeRunning;
  } catch (error) {
    const { code, detail, extra } = describeError(error);
    setOutcome(report, code, detail, extra);
  } finally {
    if (lane) {
      if (leaveServeRunning) {
        report.serve.leftRunning = true;
      } else {
        try {
          const stopped = await context.serve.stop(lane, context.serveHost);
          report.serve.stopped = stopped.stopped === true;
          report.serve.descendantsRemaining = stopped.descendantsRemaining;
        } catch (error) {
          const { code, detail } = describeError(error);
          report.serve.teardownError = { code, detail };
          setOutcome(report, code, detail);
        }
      }
    }
  }
}

function finalizeNotRun(report) {
  const armNotRun = report.keepaliveArm?.status === "not_run";
  report.notRun = [
    ...CCC_PLANNING_I2_NOT_RUN,
    ...(armNotRun ? [{ id: CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.id, detail: CCC_PLANNING_FN_PATH_KEEPALIVE_ARM.detail, reason: report.keepaliveArm.reason }] : []),
  ];
}

/**
 * Run `verify:ccc-planning-live`. `deps` are for tests: `stdout`, `stderr` (objects with `write`), `now`, `sleep`, `signal`, `serveHost` (IP's lane `run`/`now`/`sleep` seam, a fake Pueue), `fnPathKeepaliveDriver`, `parentEnv`. The fn runner, the candidate verifier and the serve lane are always IP's.
 * @returns {Promise<{ exitCode: 0 | 1 | 2, report?: object, refusal?: object }>}
 */
export async function runCccPlanningLiveProof(argv, deps = {}) {
  const out = makeOutput(deps);
  const command = CCC_PLANNING_LIVE_COMMAND;
  const parsed = parseCccPlanningProofArguments(argv, LIVE_FLAGS);
  if (!parsed.ok) return usageRefusal(out, command, parsed.detail, LIVE_USAGE);
  const { values } = parsed;

  // Order matters for what a bare invocation reports: a profile that is named but not full is refused as such whatever else is missing; a missing digest is refused before a missing profile, so that no argument at all reads "type the digest" and not "usage".
  const profile = values.get("--profile");
  if (typeof profile === "string" && profile !== "" && !PROFILES.includes(profile)) {
    return usageRefusal(out, command, `--profile must be one of ${PROFILES.join(", ")}`, LIVE_USAGE);
  }
  if (typeof profile === "string" && profile !== "full" && PROFILES.includes(profile)) {
    return refuseEarly(out, command, 1, CCC_PLANNING_PROOF_CODES.profileNotImplemented, `--profile ${profile} is not implemented in I2; only --profile full is`);
  }

  const typedDigest = values.get("--confirm-authority");
  if (typeof typedDigest !== "string" || typedDigest === "") {
    return refuseEarly(out, command, 1, CCC_PLANNING_PROOF_CODES.confirmationRequired, "--confirm-authority is required: the receipt digest exactly as Ryan typed it. No script or agent supplies it.");
  }
  if (profile !== "full") return usageRefusal(out, command, "--profile is required and must be full", LIVE_USAGE);

  for (const flag of ["--candidate", "--approval-receipt", "--project", "--database-url"]) {
    if (typeof values.get(flag) !== "string" || values.get(flag) === "") return usageRefusal(out, command, `${flag} is required and needs a value`, LIVE_USAGE);
  }
  if (values.has("--path-env") && (typeof values.get("--path-env") !== "string" || values.get("--path-env") === "")) {
    return usageRefusal(out, command, "--path-env needs a value", LIVE_USAGE);
  }

  const candidatePath = path.resolve(values.get("--candidate"));
  const approvalPath = path.resolve(values.get("--approval-receipt"));
  const evidenceDir = path.dirname(candidatePath);
  if (path.basename(evidenceDir) !== "evidence") {
    return usageRefusal(out, command, `--candidate must sit at <ROOT>/evidence/<file> so that ROOT can be derived; got ${candidatePath}`, LIVE_USAGE);
  }
  const root = path.dirname(evidenceDir);

  const verified = await verifyCccPlanningCandidate(candidatePath);
  if (!verified.ok) {
    return refuseEarly(out, command, 1, verified.code, verified.detail, verified.field === null ? {} : { field: verified.field });
  }
  const candidate = verified.receipt;

  const targetDir = path.join(root, "target");
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  const requestFile = path.join(root, "request", "request.md");
  const reportPath = path.join(evidenceDir, REPORT_FILE);
  const inputChecks = [
    [approvalPath, "file", "the authority receipt (--approval-receipt)"],
    [requestFile, "file", "the sealed request"],
    [targetDir, "directory", "the disposable target"],
  ];
  for (const [target, kind, label] of inputChecks) {
    if ((await statKind(target)) !== kind) {
      return refuseEarly(out, command, 1, CCC_PLANNING_PROOF_CODES.inputMissing, `${label} is not a ${kind} at ${target}`);
    }
  }
  if ((await statKind(reportPath)) !== "missing") {
    return refuseEarly(out, command, 1, CCC_PLANNING_PROOF_CODES.inputMissing, `a live proof report already exists at ${reportPath}; a report is written once, so use a fresh runtime root`);
  }

  const pathEnv = values.get("--path-env") ?? process.env.PATH ?? "";
  const serveInput = {
    executablePath: candidate.executablePath,
    targetDir,
    home: homeDir,
    databaseUrl: values.get("--database-url"),
    projectId: values.get("--project"),
    pathEnv,
    tmpDir,
    group: SERVE_GROUP,
    label: SERVE_LABEL,
  };
  try {
    buildCccPlanningServeLaunch(serveInput);
  } catch (error) {
    const { code, detail } = describeError(error);
    return refuseEarly(out, command, 1, code, detail);
  }

  const now = deps.now ?? (() => Date.now());
  const parentEnv = { ...(deps.parentEnv ?? process.env), PATH: pathEnv };
  const context = {
    out, now, root, candidate, approvalPath, reportPath, targetDir, homeDir, tmpDir, requestFile, typedDigest,
    projectId: serveInput.projectId,
    databaseUrl: serveInput.databaseUrl,
    candidateSummary: summarizeCccPlanningCandidate(candidatePath, candidate),
    serveInput,
    serve: { start: startCccPlanningServeLane, stop: stopCccPlanningServeLane },
    serveHost: deps.serveHost ?? {},
    sleep: deps.sleep ?? defaultSleep,
    signal: deps.signal,
    fnPathKeepaliveDriver: deps.fnPathKeepaliveDriver,
    fnParentEnv: parentEnv,
  };
  const report = newReport(context);
  await driveLiveSequence(context, report);
  finalizeNotRun(report);
  report.finishedAt = iso(now);

  let written = true;
  let writeError = null;
  try {
    await writeFile(reportPath, `${JSON.stringify(report)}\n`, { flag: "wx" });
  } catch (error) {
    written = false;
    writeError = error instanceof Error ? error.message : String(error);
  }
  const printed = written ? report : { ...report, passed: false, reportWritten: false, reportWriteError: writeError };
  out.result(printed);
  return { exitCode: printed.passed ? 0 : 1, report: printed };
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
  const controller = new AbortController();
  for (const signalName of ["SIGINT", "SIGTERM"]) process.once(signalName, () => controller.abort());
  try {
    const { exitCode } = await runCccPlanningLiveProof(process.argv.slice(2), { signal: controller.signal });
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: CCC_PLANNING_PROOF_REFUSAL_SCHEMA,
      command: CCC_PLANNING_LIVE_COMMAND,
      passed: false,
      code: CCC_PLANNING_PROOF_CODES.internal,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
