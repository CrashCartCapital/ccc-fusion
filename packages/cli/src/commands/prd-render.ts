/**
 * Pure operator presentation layer for `fn prd`.
 *
 * Every function here turns an already-built operator payload into display
 * lines. Nothing in this file reads the filesystem, the process, the network,
 * the engine, or the command io: the operator loop owns those and hands in
 * plain data, so human rendering stays testable without a project or a
 * database.
 *
 * Two invariants hold for every line produced here:
 *   1. No line is a bare JSON object, so `--json` stays the only machine
 *      readable surface and prose output can be asserted against.
 *   2. Campaign claim tokens and proof controller tokens never appear, by key
 *      name or by value. The JSON path gets that from its serializer replacer;
 *      prose gets it from {@link redactOperatorSecrets} plus a key skip in the
 *      generic flattener.
 */

const OPERATOR_SECRET_KEYS: ReadonlySet<string> = new Set([
  "claimToken",
  "controllerToken",
]);

const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const CONFIRMATION_DIGEST = /^[0-9a-f]{64}$/u;
const STOP_REASON_PLACEHOLDER = "'<why you are stopping, 10+ characters>'";
const STATUS_DIGEST_PLACEHOLDER = "<status-digest>";
const MAX_FLATTEN_DEPTH = 10;

export type PreviewRenderOptions = Readonly<{
  /** The six positional packet arguments the operator just previewed. */
  packetArgs: readonly string[];
  /** A fresh candidate key so the printed import command is paste-ready. */
  candidateIdempotencyKey: string;
}>;

export function parseOperatorJsonFlag(
  args: readonly string[],
): { args: string[]; json: boolean } {
  const kept: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--json") {
      json = true;
      continue;
    }
    kept.push(token);
    // A token in the value slot of a value-taking flag is operator data, not a
    // flag, so `--reason --json` keeps its literal reason.
    if (token.startsWith("--") && token !== "--context-stdin" && index + 1 < args.length) {
      index += 1;
      kept.push(args[index] as string);
    }
  }
  return { args: kept, json };
}

export function renderOperatorPayload(value: unknown): string[] {
  return finish(payloadLines(value), value);
}

export function renderPreview(
  preview: unknown,
  options: PreviewRenderOptions,
): string[] {
  return finish(previewLines(preview, options), preview);
}

export function renderIdempotencyKey(idempotencyKey: string): string[] {
  return [
    idempotencyKey,
    `Use this key once, as the last positional argument of: fn prd import <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> ${idempotencyKey} --confirm <preview-digest>`,
  ];
}

export function redactOperatorSecrets(
  lines: readonly string[],
  payload: unknown,
): string[] {
  const secrets = new Set<string>();
  collectSecretValues(payload, secrets, new Set<object>());
  if (secrets.size === 0) return [...lines];
  return lines.map((line) => {
    let redacted = line;
    for (const secret of secrets) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  });
}

function finish(lines: readonly string[], payload: unknown): string[] {
  return redactOperatorSecrets(lines, payload).map(inline);
}

function collectSecretValues(
  value: unknown,
  into: Set<string>,
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectSecretValues(entry, into, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (OPERATOR_SECRET_KEYS.has(key)) {
      if (typeof entry === "string" && entry.length > 0) into.add(entry);
      continue;
    }
    collectSecretValues(entry, into, seen);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asScalar(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

/** Keeps one payload field on exactly one output line. */
function inline(line: string): string {
  return line
    .split("\r\n").join("\\n")
    .split("\n").join("\\n")
    .split("\r").join("\\n")
    .split("\t").join("\\t");
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function field(
  lines: string[],
  depth: number,
  label: string,
  value: unknown,
): void {
  const scalar = asScalar(value);
  if (scalar === null) return;
  lines.push(`${pad(depth)}${label}: ${scalar}`);
}

function prose(lines: string[], depth: number, label: string, value: unknown): void {
  const scalar = asScalar(value);
  if (scalar === null) return;
  lines.push(`${pad(depth)}${label}: ${scalar}`);
}

function bulletList(
  lines: string[],
  depth: number,
  label: string,
  value: unknown,
): void {
  const entries = asList(value)
    .map(asScalar)
    .filter((entry): entry is string => entry !== null);
  if (entries.length === 0) return;
  lines.push(`${pad(depth)}${label}:`);
  for (const entry of entries) lines.push(`${pad(depth + 1)}- ${entry}`);
}

function shellArgument(value: string): string {
  if (value.length > 0 && SHELL_SAFE_ARGUMENT.test(value)) return value;
  return `'${value.split("'").join("'\\''")}'`;
}

function command(lines: string[], depth: number, text: string): void {
  lines.push(`${pad(depth)}${text}`);
}

/**
 * Last-resort rendering for a payload field this layer has no hand-written
 * shape for. Emits `path: scalar` lines only, so an unexpected shape degrades
 * into readable prose instead of a JSON dump or a crash.
 */
function flatten(
  lines: string[],
  depth: number,
  path: string,
  value: unknown,
  seen: Set<object>,
): void {
  if (depth > MAX_FLATTEN_DEPTH) {
    lines.push(`${pad(depth)}${path}: (nested beyond ${MAX_FLATTEN_DEPTH} levels)`);
    return;
  }
  const scalar = asScalar(value);
  if (scalar !== null) {
    lines.push(`${pad(depth)}${path}: ${scalar}`);
    return;
  }
  if (value === null || value === undefined) {
    lines.push(`${pad(depth)}${path}: none`);
    return;
  }
  if (typeof value !== "object") {
    lines.push(`${pad(depth)}${path}: ${String(value)}`);
    return;
  }
  if (seen.has(value)) {
    lines.push(`${pad(depth)}${path}: (already shown)`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad(depth)}${path}: none`);
      return;
    }
    value.forEach((entry, index) => {
      flatten(lines, depth, `${path}[${index}]`, entry, seen);
    });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !OPERATOR_SECRET_KEYS.has(key));
  if (entries.length === 0) {
    lines.push(`${pad(depth)}${path}: none`);
    return;
  }
  for (const [key, entry] of entries) {
    flatten(lines, depth, `${path}.${key}`, entry, seen);
  }
}

function flattenSection(
  lines: string[],
  depth: number,
  label: string,
  value: unknown,
): void {
  if (value === undefined) return;
  flatten(lines, depth, label, value, new Set<object>());
}

function payloadLines(value: unknown): string[] {
  const payload = asRecord(value);
  if (!payload) {
    const scalar = asScalar(value);
    return [scalar === null ? "No operator payload was produced." : scalar];
  }
  switch (payload.kind) {
    case "product-status":
      return productStatusLines(payload);
    case "refusal":
      return refusalLines(payload);
    case "imported":
      return importedLines(payload);
    case "inspection":
      return inspectionLines(payload);
    case "reconciled":
      return reconciledLines(payload);
    case "execution-approved":
      return approvalAppliedLines(
        payload,
        "Live execution approved",
        "approval",
      );
    case "merge-approved":
      return approvalAppliedLines(payload, "Merge approved and landed", "result");
    case "campaign-paused":
      return campaignControlLines(payload, "Campaign paused");
    case "campaign-resumed":
      return campaignControlLines(payload, "Campaign resumed");
    case "campaign-stopped":
      return campaignControlLines(payload, "Campaign stopped");
    case "proof-resolution-preview":
      return resolutionPreviewLines(payload, "Proof resolution preview");
    case "provider-resolution-preview":
      return resolutionPreviewLines(payload, "Provider resolution preview");
    case "proof-resolved":
      return resolvedLines(payload, "Proof attempt resolved");
    case "provider-resolved":
      return resolvedLines(payload, "Provider attempt resolved");
    case "idempotency-key":
      return renderIdempotencyKey(String(payload.idempotencyKey ?? ""));
    default:
      return unknownPayloadLines(payload);
  }
}

function unknownPayloadLines(payload: Record<string, unknown>): string[] {
  const kind = asScalar(payload.kind) ?? "unlabeled";
  const lines: string[] = [`Operator payload (${kind})`];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "kind" || OPERATOR_SECRET_KEYS.has(key)) continue;
    flattenSection(lines, 1, key, value);
  }
  return lines;
}

function productStatusLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (payload.found === false) {
    const key = asScalar(payload.idempotencyKey) ?? "(no idempotency key given)";
    lines.push(`No imported campaign was found for idempotency key ${key}.`);
    lines.push(
      "  Check the key, or run fn prd import with a fresh preview confirmation to create the campaign.",
    );
    return lines;
  }
  const status = asRecord(payload.status);
  if (!status) return unknownPayloadLines(payload);
  statusBody(lines, status, payload);
  return lines;
}

function statusBody(
  lines: string[],
  status: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  const importRecord = asRecord(status.import) ?? {};
  const idempotencyKey = asScalar(importRecord.idempotencyKey) ?? "";

  lines.push("CCC PRD campaign status");
  field(lines, 1, "idempotency key", importRecord.idempotencyKey);
  field(lines, 1, "import", importRecord.importId);
  field(lines, 1, "campaign", importRecord.campaignId);
  const state = asScalar(importRecord.state);
  if (state !== null) {
    const runnable = importRecord.runnable === true ? "runnable" : "not runnable";
    lines.push(`${pad(1)}state: ${state} (${runnable})`);
  }
  const target = asScalar(importRecord.targetRepository);
  const base = asScalar(importRecord.targetBase);
  if (target !== null) {
    lines.push(`${pad(1)}target: ${target}${base === null ? "" : ` at base ${base}`}`);
  }
  field(lines, 1, "campaign deadline", importRecord.campaignDeadlineAt);
  field(lines, 1, "last error", importRecord.lastError);
  requestBudgetLines(lines, asRecord(importRecord.requestBudget));

  nextActionLines(lines, asRecord(status.nextAction));
  taskLines(lines, asList(status.tasks));
  workItemLines(lines, asList(status.workItems));
  proofLines(lines, asList(status.proofs), asList(status.orphanProofAttempts));
  providerAttemptLines(lines, asList(status.providerAttempts));
  const sealedAuthorizationPresent = executionAuthorizationLines(
    lines,
    status,
    payload,
    idempotencyKey,
  ) || status.executionAuthorizationMode === "sealed_bundle_v1";
  approvalLines(lines, status, payload, idempotencyKey, sealedAuthorizationPresent);
  landingLines(lines, asRecord(status.landing));
  operatorControlLines(lines, asList(payload.operatorControls), idempotencyKey);
}

function nextActionLines(
  lines: string[],
  nextAction: Record<string, unknown> | null,
): void {
  if (!nextAction) return;
  lines.push(`Next action: ${asScalar(nextAction.kind) ?? "unknown"}`);
  // The status layer already wrote these as operator prose; transcribe them
  // rather than re-summarizing, so the words the operator acts on are exact.
  prose(lines, 1, "Reason", nextAction.reason);
  field(lines, 1, "Execution authorization", nextAction.executionAuthorizationId);
  field(lines, 1, "Execution authorization status", nextAction.executionAuthorizationStatus);
  field(lines, 1, "Approval request", nextAction.approvalRequestId);
  field(lines, 1, "Approval status", nextAction.approvalStatus);
  prose(lines, 1, "Diagnostic", nextAction.diagnostic);
  prose(lines, 1, "Safe state", nextAction.safeState);
  prose(lines, 1, "Decision owner", nextAction.decisionOwner);
  prose(lines, 1, "Consequence", nextAction.consequence);
  bulletList(lines, 1, "Recovery options", nextAction.recoveryOptions);
  prose(lines, 1, "Next safe action", nextAction.nextSafeAction);
}

function taskLines(lines: string[], tasks: readonly unknown[]): void {
  if (tasks.length === 0) return;
  lines.push(`Tasks (${tasks.length})`);
  for (const entry of tasks) {
    const task = asRecord(entry);
    if (!task) continue;
    const ordinal = asScalar(task.ordinal) ?? "?";
    const semanticTaskId = asScalar(task.semanticTaskId) ?? "(unnamed task)";
    const title = asScalar(task.title);
    lines.push(
      `${pad(1)}${ordinal}. ${semanticTaskId}${title === null ? "" : ` - ${title}`}`,
    );
    if (task.present === false) {
      lines.push(`${pad(2)}not yet materialized in the project`);
    }
    const taskState = asRecord(task.state) ?? {};
    const column = asScalar(taskState.column);
    const columnStatus = asScalar(taskState.status);
    if (column !== null || columnStatus !== null) {
      lines.push(
        `${pad(2)}state: ${[column, columnStatus].filter((part) => part !== null).join(" / ")}`,
      );
    }
    if (taskState.paused === true || taskState.userPaused === true) {
      const reason = asScalar(taskState.pausedReason);
      lines.push(`${pad(2)}paused${reason === null ? "" : `: ${reason}`}`);
    }
    field(lines, 2, "error", taskState.error);
    const route = asRecord(task.route);
    if (route) {
      const provider = asScalar(route.providerId) ?? "unknown provider";
      const model = asScalar(route.modelId) ?? "unknown model";
      const transport = asScalar(route.transport) ?? "unknown transport";
      lines.push(`${pad(2)}route: ${provider} / ${model} over ${transport}`);
      field(lines, 3, "executor", route.executor);
      field(lines, 3, "cli adapter", route.cliAdapterId);
      field(lines, 3, "worktree mode", route.worktreeMode);
      bulletList(lines, 3, "owned paths", route.ownedPaths);
      bulletList(lines, 3, "allowed write roots", route.allowedWriteRoots);
    }
    const worktree = asScalar(task.worktree);
    const branch = asScalar(task.branch);
    if (worktree !== null || branch !== null) {
      lines.push(
        `${pad(2)}worktree: ${worktree ?? "none"}${branch === null ? "" : ` (branch ${branch})`}`,
      );
    }
    field(lines, 2, "merge commit", task.mergeCommit);
  }
}

function workItemLines(lines: string[], workItems: readonly unknown[]): void {
  if (workItems.length === 0) return;
  lines.push(`Work items (${workItems.length})`);
  for (const entry of workItems) {
    const workItem = asRecord(entry);
    if (!workItem) continue;
    const id = asScalar(workItem.id) ?? "(unidentified work item)";
    const state = asScalar(workItem.state) ?? "unknown state";
    const attempt = asScalar(workItem.attempt);
    lines.push(
      `${pad(1)}${id} - state ${state}${attempt === null ? "" : `, attempt ${attempt}`}`,
    );
    field(lines, 2, "task", workItem.taskId);
    field(lines, 2, "last error", workItem.lastError);
    field(lines, 2, "blocked reason", workItem.blockedReason);
    field(lines, 2, "wait reason", workItem.waitReason);
    const leaseOwner = asScalar(workItem.leaseOwner);
    if (leaseOwner !== null) {
      const expires = asScalar(workItem.leaseExpiresAt);
      lines.push(
        `${pad(2)}leased by ${leaseOwner}${expires === null ? "" : ` until ${expires}`}`,
      );
    }
    field(lines, 2, "retry after", workItem.retryAfter);
  }
}

function proofAttemptLines(
  lines: string[],
  depth: number,
  attempts: readonly unknown[],
): void {
  for (const entry of attempts) {
    const attempt = asRecord(entry);
    if (!attempt) continue;
    const attemptKey = asScalar(attempt.attemptKey) ?? "(unidentified attempt)";
    const state = asScalar(attempt.state) ?? "unknown state";
    lines.push(`${pad(depth)}${attemptKey} - state ${state}`);
    const contractVersion = asScalar(attempt.attemptContractVersion);
    field(lines, depth + 1, "attempt contract", contractVersion);
    field(lines, depth + 1, "proof phase", attempt.phase);
    field(lines, depth + 1, "verifier closure digest", attempt.verifierClosureSha256);
    field(lines, depth + 1, "candidate inputs digest", attempt.candidateInputsSha256);
    field(lines, depth + 1, "execution toolchain digest", attempt.executionToolchainSha256);
    if (contractVersion === "v2") {
      const envelope = asRecord(attempt.terminalEnvelope);
      if (envelope) {
        const kind = asScalar(envelope.kind) ?? "unknown";
        lines.push(`${pad(depth + 1)}terminal envelope: ${kind}`);
        if (kind === "verified") {
          lines.push(
            `${pad(depth + 2)}verified verdict: ${envelope.passed === true ? "passed" : "failed"}`,
          );
        } else {
          field(lines, depth + 2, "refusal code", envelope.code);
        }
      }
      const evidence = asRecord(attempt.proofEvidence);
      if (evidence) {
        lines.push(
          `${pad(depth + 1)}semantic evidence: ${evidence.passed === true ? "passed" : "failed"}`,
        );
      }
      field(lines, depth + 1, "terminal envelope digest", attempt.terminalEnvelopeSha256);
      field(lines, depth + 1, "semantic evidence digest", attempt.proofEvidenceSha256);
      field(lines, depth + 1, "settled at", attempt.settledAt);
      continue;
    }
    const result = asRecord(attempt.result);
    if (result) {
      const verdict = result.success === true ? "passed" : "failed";
      const exitCode = asScalar(result.exitCode);
      const durationMs = asScalar(result.durationMs);
      lines.push(
        `${pad(depth + 1)}result: ${verdict}${exitCode === null ? "" : `, exit code ${exitCode}`}${durationMs === null ? "" : `, ${durationMs}ms`}`,
      );
      if (result.timedOut === true) lines.push(`${pad(depth + 1)}timed out`);
      if (result.killed === true) lines.push(`${pad(depth + 1)}killed`);
      field(lines, depth + 1, "stdout tail", result.stdoutTail);
      field(lines, depth + 1, "stderr tail", result.stderrTail);
      bulletList(lines, depth + 1, "warnings", result.warnings);
      field(lines, depth + 1, "negative control", result.negativeControlLabel);
    }
    field(lines, depth + 1, "settled at", attempt.settledAt);
  }
}

function proofLines(
  lines: string[],
  proofs: readonly unknown[],
  orphanAttempts: readonly unknown[],
): void {
  if (proofs.length > 0) {
    lines.push(`Proofs (${proofs.length})`);
    for (const entry of proofs) {
      const proof = asRecord(entry);
      if (!proof) continue;
      const definition = asRecord(proof.definition) ?? {};
      const id = asScalar(definition.id) ?? "(unnamed proof)";
      const attempts = asList(proof.attempts);
      lines.push(`${pad(1)}${id} - ${attempts.length} attempt(s)`);
      const proofCommand = asList(definition.command)
        .map(asScalar)
        .filter((part): part is string => part !== null);
      if (proofCommand.length > 0) {
        lines.push(`${pad(2)}command: ${proofCommand.join(" ")}`);
      }
      proofAttemptLines(lines, 2, attempts);
    }
  }
  if (orphanAttempts.length > 0) {
    lines.push(`Proof attempts without a matching definition (${orphanAttempts.length})`);
    proofAttemptLines(lines, 1, orphanAttempts);
  }
}

/**
 * Cost is a union: a claimed amount or an explicit unknown. An unknown cost is
 * reported as unknown, never as a zero dollar amount, because a campaign with
 * no receipt did not cost nothing.
 */
function costLine(cost: Record<string, unknown>): string {
  if (cost.kind === "unknown") {
    const reason = asScalar(cost.reason) ?? "no reason recorded";
    return `cost unknown: ${reason}`;
  }
  const amount = asScalar(cost.amountUsd);
  if (amount === null) return "cost unknown: no amount recorded";
  const source = asScalar(cost.source);
  return `cost: $${amount}${source === null ? "" : ` (source ${source})`}`;
}

function providerAttemptLines(
  lines: string[],
  providerAttempts: readonly unknown[],
): void {
  if (providerAttempts.length === 0) return;
  lines.push(`Provider attempts (${providerAttempts.length})`);
  for (const entry of providerAttempts) {
    const attempt = asRecord(entry);
    if (!attempt) continue;
    const attemptKey = asScalar(attempt.attemptKey) ?? "(unidentified attempt)";
    const state = asScalar(attempt.state) ?? "unknown state";
    const semanticTaskId = asScalar(attempt.semanticTaskId);
    lines.push(
      `${pad(1)}${attemptKey} - state ${state}${semanticTaskId === null ? "" : ` (task ${semanticTaskId})`}`,
    );
    const effectiveProvider = asScalar(attempt.effectiveProvider);
    const effectiveModel = asScalar(attempt.effectiveModel);
    if (effectiveProvider !== null || effectiveModel !== null) {
      lines.push(
        `${pad(2)}effective route: ${effectiveProvider ?? "unknown provider"} / ${effectiveModel ?? "unknown model"}`,
      );
    }
    field(lines, 2, "reasoning effort", attempt.effectiveReasoningEffort);
    field(lines, 2, "service tier", attempt.effectiveServiceTier);
    const usage = asRecord(attempt.usage);
    if (usage) {
      const inputTokens = asScalar(usage.inputTokens) ?? "unknown";
      const outputTokens = asScalar(usage.outputTokens) ?? "unknown";
      lines.push(
        `${pad(2)}usage: ${inputTokens} input tokens, ${outputTokens} output tokens`,
      );
    } else if ("usage" in attempt) {
      lines.push(`${pad(2)}usage: not reported`);
    }
    const cost = asRecord(attempt.cost);
    if (cost) lines.push(`${pad(2)}${costLine(cost)}`);
    field(lines, 2, "receipt source", attempt.receiptSource);
    field(lines, 2, "requests", attempt.requestCount);
  }
}

function confirmationFor(
  confirmations: readonly unknown[],
  approvalRequestId: string,
): string | null {
  for (const entry of confirmations) {
    const confirmation = asRecord(entry);
    if (!confirmation) continue;
    if (asScalar(confirmation.approvalRequestId) !== approvalRequestId) continue;
    if (confirmation.status !== "issued") continue;
    const digest = asScalar(confirmation.confirmation);
    if (digest !== null && CONFIRMATION_DIGEST.test(digest)) return digest;
  }
  return null;
}

function executionAuthorizationLines(
  lines: string[],
  status: Record<string, unknown>,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): boolean {
  const authorization = asRecord(status.executionAuthorization);
  if (!authorization) return false;

  const authorizationId = asScalar(authorization.authorizationId)
    ?? "(unidentified execution authorization)";
  const authorizationStatus = asScalar(authorization.status) ?? "unknown status";
  const members = asList(authorization.members);
  lines.push("Execution authorization");
  lines.push(`${pad(1)}${authorizationId} - ${authorizationStatus}`);
  field(lines, 2, "expires", authorization.expiresAt);
  field(lines, 2, "expected request count", authorization.expectedRequestCount);
  field(lines, 2, "maximum requests", authorization.maxRequests);
  field(lines, 2, "maximum concurrency", authorization.maxConcurrency);
  lines.push(
    `${pad(2)}${members.length} exact child action${members.length === 1 ? "" : "s"}`,
  );
  const memberCustody = asList(authorization.memberCustody);
  if (memberCustody.length !== members.length) {
    lines.push(`${pad(3)}Member custody unavailable: joined child status is incomplete.`);
  } else {
    for (const entry of memberCustody) {
      const custody = asRecord(entry);
      if (!custody) continue;
      const ordinal = asScalar(custody.ordinal);
      const semanticTaskId = asScalar(custody.semanticTaskId);
      const nativeTaskId = asScalar(custody.nativeTaskId);
      const approvalRequestId = asScalar(custody.approvalRequestId);
      const status = asScalar(custody.status);
      lines.push(
        `${pad(3)}${ordinal === null ? "?" : ordinal}: ${semanticTaskId ?? nativeTaskId ?? "unknown task"}`
        + `${approvalRequestId === null ? "" : ` -> ${approvalRequestId}`}`
        + `${status === null ? "" : ` (${status})`}`,
      );
    }
  }

  const confirmation = asRecord(payload.liveExecutionAuthorizationConfirmation);
  const digest = asScalar(confirmation?.confirmation);
  if (
    authorizationId === "(unidentified execution authorization)"
    || !confirmation
    || asScalar(confirmation.authorizationId) !== authorizationId
    || asScalar(confirmation.status) !== authorizationStatus
    || (authorizationStatus !== "issued" && authorizationStatus !== "claimed")
    || digest === null
    || !CONFIRMATION_DIGEST.test(digest)
  ) {
    return true;
  }
  lines.push(`${pad(2)}approve all exact live actions with:`);
  command(
    lines,
    3,
    `fn prd approve-execution ${shellArgument(idempotencyKey)} ${shellArgument(authorizationId)} --confirm ${digest}`,
  );
  return true;
}

function approvalLines(
  lines: string[],
  status: Record<string, unknown>,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  sealedAuthorizationPresent: boolean,
): void {
  const approvals = asList(status.approvals);
  if (approvals.length === 0) return;
  const mergeConfirmations = asList(payload.mergeApprovalConfirmations);
  const executionConfirmations = sealedAuthorizationPresent
    ? []
    : asList(payload.liveExecutionApprovalConfirmations);
  lines.push(`Approvals (${approvals.length})`);
  for (const entry of approvals) {
    const approval = asRecord(entry);
    if (!approval) continue;
    const id = asScalar(approval.id) ?? "(unidentified approval)";
    const approvalStatus = asScalar(approval.status) ?? "unknown status";
    const campaign = asRecord(approval.campaign) ?? {};
    const expiresAt = asScalar(campaign.expiresAt);
    const taskId = asScalar(approval.taskId);
    lines.push(
      `${pad(1)}${id} - ${approvalStatus}${expiresAt === null ? "" : `, expires ${expiresAt}`}${taskId === null ? "" : `, task ${taskId}`}`,
    );
    const mergeDigest = confirmationFor(mergeConfirmations, id);
    if (mergeDigest !== null) {
      lines.push(`${pad(2)}approve the merge with:`);
      command(
        lines,
        3,
        `fn prd approve-merge ${shellArgument(idempotencyKey)} ${shellArgument(id)} --confirm ${mergeDigest}`,
      );
    }
    const executionDigest = confirmationFor(executionConfirmations, id);
    if (executionDigest !== null) {
      lines.push(`${pad(2)}approve live execution with:`);
      command(
        lines,
        3,
        `fn prd approve-execution ${shellArgument(idempotencyKey)} ${shellArgument(id)} --confirm ${executionDigest}`,
      );
    }
  }
}

function landingLines(
  lines: string[],
  landing: Record<string, unknown> | null,
): void {
  if (!landing) return;
  const intents = asList(landing.intents).length;
  const materializations = asList(landing.materializations).length;
  const terminals = asList(landing.terminals).length;
  if (intents === 0 && materializations === 0 && terminals === 0) return;
  lines.push("Git landing audit");
  lines.push(
    `${pad(1)}${intents} intent(s), ${materializations} materialization(s), ${terminals} terminal receipt(s)`,
  );
}

function operatorControlLines(
  lines: string[],
  controls: readonly unknown[],
  idempotencyKey: string,
): void {
  if (controls.length === 0) return;
  lines.push("Operator controls");
  for (const entry of controls) {
    const control = asRecord(entry);
    if (!control) continue;
    const action = asScalar(control.action) ?? "unknown";
    const allowed = control.allowed === true;
    const reason = asScalar(control.reason);
    lines.push(
      `${pad(1)}${action} - ${allowed ? "available" : `unavailable${reason === null ? "" : `: ${reason}`}`}`,
    );
    prose(lines, 2, "Consequence", control.consequence);
    prose(lines, 2, "Recovery", control.recovery);
    if (!allowed) continue;
    const digest = asScalar(control.confirmation);
    if (digest === null || !CONFIRMATION_DIGEST.test(digest)) continue;
    const key = shellArgument(idempotencyKey);
    command(
      lines,
      2,
      action === "stop"
        ? `fn prd stop ${key} --reason ${STOP_REASON_PLACEHOLDER} --confirm ${digest}`
        : `fn prd ${action} ${key} --confirm ${digest}`,
    );
  }
}

function diagnosticLines(lines: string[], diagnostics: readonly unknown[]): void {
  if (diagnostics.length === 0) return;
  for (const entry of diagnostics) {
    const diagnostic = asRecord(entry);
    if (!diagnostic) {
      const scalar = asScalar(entry);
      if (scalar !== null) lines.push(`${pad(1)}${scalar}`);
      continue;
    }
    const code = asScalar(diagnostic.code);
    const message = asScalar(diagnostic.message);
    if (code !== null || message !== null) {
      lines.push(`${pad(1)}${[code, message].filter((part) => part !== null).join(": ")}`);
      for (const [key, value] of Object.entries(diagnostic)) {
        if (key === "code" || key === "message") continue;
        flattenSection(lines, 2, key, value);
      }
      continue;
    }
    flattenSection(lines, 1, "diagnostic", diagnostic);
  }
}

function verifierConfinementLines(
  lines: string[],
  confinement: Record<string, unknown> | null,
): void {
  if (!confinement) return;
  const ready = confinement.ready === true ? "ready" : "not ready";
  const backend = asScalar(confinement.backend);
  lines.push(
    `Verifier confinement: ${ready}${backend === null ? "" : ` (backend ${backend})`}`,
  );
  prose(lines, 1, "Detail", confinement.message);
  prose(lines, 1, "Safe state", confinement.safeState);
  prose(lines, 1, "Decision owner", confinement.decisionOwner);
  prose(lines, 1, "Consequence", confinement.consequence);
  bulletList(lines, 1, "Recovery options", confinement.recoveryOptions);
  prose(lines, 1, "Next safe action", confinement.nextSafeAction);
}

function requestBudgetLines(
  lines: string[],
  budget: Record<string, unknown> | null,
): void {
  if (!budget) return;
  const scope = asScalar(budget.scope);
  lines.push(`Request budget${scope === null ? "" : ` (${scope})`}`);
  field(lines, 1, "maximum reservation slots", budget.maximum);
  field(lines, 1, "used reservation slots", budget.used);
  field(lines, 1, "remaining reservation slots", budget.remaining);
  field(lines, 1, "provider tasks", budget.providerTasks);
  field(lines, 1, "static admission floor", budget.deterministicMinimum);
  field(lines, 1, "headroom above floor", budget.headroomAboveMinimum);
  field(lines, 1, "completion adequacy", budget.completionAdequacy);
  lines.push(
    `${pad(1)}Reservation-slot accounting: each first-time provider-attempt reservation spends one slot; exact idempotent replay is free, while proved-not-dispatched and unknown attempts remain spent.`,
  );
  lines.push(
    `${pad(1)}Slots are campaign-global and are not reserved per task; earlier tasks may exhaust the cap.`,
  );
  prose(lines, 1, "Meaning", budget.explanation);
}

function refusalLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = ["Refused. Fusion did not complete this operation."];
  diagnosticLines(lines, asList(payload.diagnostics));
  verifierConfinementLines(lines, asRecord(payload.verifierConfinement));
  prose(lines, 0, "Safe state", payload.safeState);
  prose(lines, 0, "Decision owner", payload.decisionOwner);
  prose(lines, 0, "Consequence", payload.consequence);
  prose(lines, 0, "Approval expires at", payload.approvalExpiresAt);
  bulletList(lines, 0, "Recovery options", payload.recoveryOptions);
  prose(lines, 0, "Next safe action", payload.nextSafeAction);
  return lines;
}

function previewLines(
  value: unknown,
  options: PreviewRenderOptions,
): string[] {
  const preview = asRecord(value);
  if (!preview) return payloadLines(value);
  const lines: string[] = ["CCC PRD product preview"];
  field(lines, 1, "project", preview.projectId);
  field(lines, 1, "project path", preview.projectPath);
  const target = asScalar(preview.targetRepository);
  const base = asScalar(preview.targetBase);
  const head = asScalar(preview.targetHead);
  if (target !== null) {
    lines.push(
      `${pad(1)}target: ${target}${base === null ? "" : ` at base ${base}`}${head === null ? "" : ` (current head ${head})`}`,
    );
  }
  field(lines, 1, "bundle hash", preview.bundleHash);
  field(lines, 1, "packet hash", preview.packetHash);
  field(lines, 1, "sidecar hash", preview.sidecarHash);
  lines.push(
    `${pad(1)}scope: ${asList(preview.requirements).length} requirement(s), ${asList(preview.tasks).length} task(s), ${asList(preview.proofs).length} proof(s)`,
  );
  bulletList(lines, 1, "admitted write roots", preview.admittedWriteRoots);
  bulletList(lines, 1, "non-goals", preview.nonGoals);
  requestBudgetLines(lines, asRecord(preview.requestBudget));
  verifierConfinementLines(lines, asRecord(preview.verifierConfinement));

  const digest = asScalar(preview.confirmationDigest);
  if (digest === null) return lines;
  lines.push(`Confirmation digest: ${digest}`);
  lines.push(
    "Import this exact preview with a fresh idempotency key (this candidate key does not change the digest):",
  );
  const packetArgs = options.packetArgs.map(shellArgument).join(" ");
  command(
    lines,
    1,
    `fn prd import ${packetArgs} ${shellArgument(options.candidateIdempotencyKey)} --confirm ${digest}`,
  );
  lines.push(
    "  Re-run preview and use its fresh digest if the packet, plan, or target head changes.",
  );
  return lines;
}

function followUpCommandLines(lines: string[], idempotencyKey: string): void {
  if (idempotencyKey.length === 0) return;
  const key = shellArgument(idempotencyKey);
  lines.push("Follow this campaign with:");
  command(lines, 1, `fn prd status ${key}`);
  lines.push("Pause or stop it using a fresh digest from that status command:");
  command(lines, 1, `fn prd pause ${key} --confirm ${STATUS_DIGEST_PLACEHOLDER}`);
  command(
    lines,
    1,
    `fn prd stop ${key} --reason ${STOP_REASON_PLACEHOLDER} --confirm ${STATUS_DIGEST_PLACEHOLDER}`,
  );
}

function importedLines(payload: Record<string, unknown>): string[] {
  const result = asRecord(payload.result) ?? {};
  const idempotencyKey = asScalar(result.idempotencyKey) ?? "";
  const lines: string[] = ["CCC PRD campaign imported"];
  if (idempotencyKey.length > 0) {
    lines.push(`Idempotency key: ${idempotencyKey}`);
  }
  field(lines, 1, "import", result.importId);
  const state = asScalar(result.state);
  if (state !== null) {
    const runnable = result.runnable === true ? "runnable" : "not runnable";
    lines.push(`${pad(1)}state: ${state} (${runnable})`);
  }
  lines.push(
    `${pad(1)}replayed an earlier import: ${result.replayed === true ? "yes" : "no"}`,
  );
  const target = asScalar(result.targetRepository);
  const base = asScalar(result.targetBase);
  if (target !== null) {
    lines.push(`${pad(1)}target: ${target}${base === null ? "" : ` at base ${base}`}`);
  }
  field(lines, 1, "staging path", result.stagingRelativePath);
  field(lines, 1, "confirmation digest", payload.confirmationDigest);
  const directCounts = asRecord(result.directCounts);
  if (directCounts) {
    const counted = Object.entries(directCounts)
      .map(([key, count]) => {
        const scalar = asScalar(count);
        return scalar === null ? null : `${scalar} ${key}`;
      })
      .filter((part): part is string => part !== null);
    if (counted.length > 0) {
      lines.push(`${pad(1)}imported: ${counted.join(", ")}`);
    }
  }
  followUpCommandLines(lines, idempotencyKey);
  return lines;
}

function inspectionLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = ["CCC PRD import inspection"];
  if (payload.found !== true) {
    lines.push("  No import was found for that idempotency key.");
    return lines;
  }
  flattenSection(lines, 1, "import", payload.inspection);
  return lines;
}

function reconciledLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = ["CCC PRD import reconciled"];
  flattenSection(lines, 1, "result", payload.result);
  const result = asRecord(payload.result);
  followUpCommandLines(lines, asScalar(result?.idempotencyKey) ?? "");
  return lines;
}

function approvalAppliedLines(
  payload: Record<string, unknown>,
  heading: string,
  detailKey: string,
): string[] {
  const lines: string[] = [heading];
  field(lines, 1, "approval request", payload.approvalRequestId);
  flattenSection(lines, 1, detailKey, payload[detailKey]);
  const status = asRecord(payload.status);
  if (status) statusBody(lines, status, payload);
  return lines;
}

function campaignControlLines(
  payload: Record<string, unknown>,
  heading: string,
): string[] {
  const lines: string[] = [heading];
  flattenSection(lines, 1, "result", payload.result);
  const status = asRecord(payload.status);
  if (status) statusBody(lines, status, payload);
  return lines;
}

function resolutionPreviewLines(
  payload: Record<string, unknown>,
  heading: string,
): string[] {
  const lines: string[] = [heading];
  field(lines, 1, "attempt", payload.attemptKey);
  field(lines, 1, "decision", payload.decision);
  field(lines, 1, "outcome", payload.outcome);
  field(lines, 1, "observer", payload.observerId);
  field(lines, 1, "evidence summary", payload.evidenceSummary);
  field(lines, 1, "evidence digest", payload.evidenceDigest);
  field(lines, 1, "confirmation digest", payload.confirmation);
  prose(lines, 1, "Consequence", payload.consequence);
  prose(lines, 1, "Safe state", payload.safeState);
  prose(lines, 1, "Decision owner", payload.decisionOwner);
  prose(lines, 1, "Approval expires at", payload.approvalExpiresAt);
  prose(lines, 1, "Rollback", payload.rollback);
  prose(lines, 1, "Next safe action", payload.nextSafeAction);
  return lines;
}

function resolvedLines(
  payload: Record<string, unknown>,
  heading: string,
): string[] {
  const lines: string[] = [heading];
  flattenSection(lines, 1, "attempt", payload.attempt);
  prose(lines, 0, "Next safe action", payload.nextSafeAction);
  const status = asRecord(payload.status);
  if (status) statusBody(lines, status, payload);
  return lines;
}
