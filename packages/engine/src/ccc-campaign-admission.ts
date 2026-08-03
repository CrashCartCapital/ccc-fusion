/*
FNXC:CCCAdmissionAuthority 2026-08-01-17:30:
DEPRECATED — designed unification helper, never wired into production. No
provider-capable call site invokes admitCccCampaignAction; the authoritative
admission enforcement for campaign execution is
cli-agent/ccc-native-cli-production-resolver.ts (wired in cli-agent/runtime.ts)
plus the per-seam route/identity checks in provider-attempt, store, binding,
and workflow-graph-executor. Do not write new policy against this module and do
not treat its checks as runtime-enforced. Removal is operator-approval-gated;
until then this module exists only for its focused unit tests.
*/
import {
  assertCccCampaignAuthorityBinding,
  assertCccCampaignActionLease,
  createCccCampaignAuthorityBinding,
  type CccCampaignActionLease,
  type CccCampaignActionLookup,
  type CccCampaignAuthorityBinding,
  type CccCampaignTaskContext,
  type CccCampaignTransport,
} from "@fusion/core";

export type CccCampaignAdmissionReason =
  | "aborted"
  | "missing-imported-marker"
  | "imported-custody-missing"
  | "imported-custody-unavailable"
  | "task-drift"
  | "provider-drift"
  | "route-drift"
  | "action-drift"
  | "git-target-root-drift"
  | "git-base-drift"
  | "git-foreign-head"
  | "git-dirty"
  | "git-inspection-failed"
  | "proof-refused"
  | "approval-refused";

export class CccCampaignAdmissionError extends Error {
  public readonly code = "CCC_CAMPAIGN_ADMISSION_REFUSED";

  public constructor(
    public readonly reason: CccCampaignAdmissionReason,
    message: string,
  ) {
    super(message);
    this.name = "CccCampaignAdmissionError";
  }
}

export type CccCampaignImportedMarker =
  | Readonly<{ state: "ordinary" }>
  | Readonly<{ state: "imported" }>;

export type CccCampaignAdmissionTask = Readonly<{
  id: string;
  semanticTaskId?: string | null;
  targetRoot?: string | null;
  baseCommitSha?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
}>;

export type CccCampaignAdmissionRoute = Readonly<{
  transport: CccCampaignTransport;
  providerId: string;
  modelId: string;
}>;

export type CccCampaignAdmissionStore = Readonly<{
  getCccCampaignContextForTask(
    taskId: string,
  ): CccCampaignTaskContext | null | Promise<CccCampaignTaskContext | null>;
}>;

export type CccCampaignAdmissionProofFn = (
  context: CccCampaignTaskContext,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export type CccCampaignLiveGitInspection = Readonly<{
  targetRoot: string;
  expectedBaseObject: string;
  head: string;
  headDescendsFromExpectedBase: boolean;
  dirty: boolean;
}>;

export type CccCampaignLiveGitInspectionFn = (
  input: Readonly<{
    targetRoot: string;
    expectedBaseObject: string;
    nativeTaskId: string;
    semanticTaskId: string;
  }>,
  signal: AbortSignal,
) => CccCampaignLiveGitInspection | Promise<CccCampaignLiveGitInspection>;

export type CccCampaignProtectedActionClaimResult = Readonly<{
  binding: CccCampaignAuthorityBinding;
  lease: CccCampaignActionLease;
}>;

export type CccCampaignProtectedActionClaimFn = (
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
  signal: AbortSignal,
) => CccCampaignProtectedActionClaimResult | Promise<CccCampaignProtectedActionClaimResult>;

export type AdmitCccCampaignActionInput = Readonly<{
  store: CccCampaignAdmissionStore;
  task: CccCampaignAdmissionTask;
  importedMarker: CccCampaignImportedMarker;
  action: CccCampaignActionLookup;
  route: CccCampaignAdmissionRoute;
  signal: AbortSignal;
  admitProofs: CccCampaignAdmissionProofFn;
  claimProtectedAction: CccCampaignProtectedActionClaimFn;
  inspectLiveGit: CccCampaignLiveGitInspectionFn;
}>;

export type CccCampaignAdmittedAction =
  | Readonly<{ kind: "ordinary" }>
  | Readonly<{
    kind: "campaign";
    authority: Readonly<{
      context: CccCampaignTaskContext;
      binding: CccCampaignAuthorityBinding;
      approval: CccCampaignActionLease | null;
    }>;
  }>;

export async function admitCccCampaignAction(
  input: AdmitCccCampaignActionInput,
): Promise<CccCampaignAdmittedAction> {
  assertLiveSignal(input.signal);
  const marker = requireImportedMarker(input.importedMarker);
  if (marker.state === "ordinary") return Object.freeze({ kind: "ordinary" as const });

  const context = frozenPlainDataSnapshot(await lookupImportedContext(input));
  assertLiveSignal(input.signal);
  assertTaskMatchesContext(input.task, context);
  assertRouteMatchesContext(input.route, context);

  await inspectAndAssertLiveGit(input, context);
  assertLiveSignal(input.signal);

  try {
    await input.admitProofs(context, input.signal);
  } catch (error) {
    assertLiveSignal(input.signal);
    throw new CccCampaignAdmissionError(
      "proof-refused",
      `CCC campaign proof admission refused before provider use: ${errorMessage(error)}`,
    );
  }
  assertLiveSignal(input.signal);

  const protectedAction = declaredProtectedAction(input.action, context);
  const authority = protectedAction
    ? await claimProtectedAction(input, context, protectedAction)
    : {
      binding: createCccCampaignAuthorityBinding(context, actionLookup(input.action)),
      approval: null,
    };

  assertLiveSignal(input.signal);
  const bindingSnapshot = frozenPlainDataSnapshot(authority.binding);
  const approvalSnapshot = authority.approval
    ? frozenPlainDataSnapshot(authority.approval)
    : null;
  return Object.freeze({
    kind: "campaign" as const,
    authority: Object.freeze({
      context,
      binding: bindingSnapshot,
      approval: approvalSnapshot,
    }),
  });
}

function requireImportedMarker(marker: CccCampaignImportedMarker | undefined): CccCampaignImportedMarker {
  if (marker?.state === "ordinary" || marker?.state === "imported") return marker;
  throw new CccCampaignAdmissionError(
    "missing-imported-marker",
    "CCC campaign admission requires an explicit imported-marker snapshot before provider use",
  );
}

async function lookupImportedContext(
  input: AdmitCccCampaignActionInput,
): Promise<CccCampaignTaskContext> {
  try {
    const context = await input.store.getCccCampaignContextForTask(input.task.id);
    if (!context) {
      throw new CccCampaignAdmissionError(
        "imported-custody-missing",
        `CCC campaign imported task ${input.task.id} has no persisted campaign custody`,
      );
    }
    return context;
  } catch (error) {
    if (error instanceof CccCampaignAdmissionError) throw error;
    throw new CccCampaignAdmissionError(
      "imported-custody-unavailable",
      `CCC campaign custody lookup failed before provider use: ${errorMessage(error)}`,
    );
  }
}

function assertTaskMatchesContext(
  task: CccCampaignAdmissionTask,
  context: CccCampaignTaskContext,
): void {
  if (
    task.id !== context.taskId
    || task.semanticTaskId !== context.semanticTaskId
    || task.targetRoot !== context.targetRepository.path
    || task.baseCommitSha !== context.targetRepository.baseCommit
  ) {
    throw new CccCampaignAdmissionError(
      "task-drift",
      `CCC campaign task identity drift for ${task.id}`,
    );
  }
  if (
    task.modelProvider !== context.route.providerId
    || task.modelId !== context.route.modelId
  ) {
    throw new CccCampaignAdmissionError(
      "provider-drift",
      `CCC campaign provider/model drift for ${task.id}`,
    );
  }
}

function assertRouteMatchesContext(
  route: CccCampaignAdmissionRoute,
  context: CccCampaignTaskContext,
): void {
  if (
    route.transport !== context.route.transport
    || route.providerId !== context.route.providerId
    || route.modelId !== context.route.modelId
  ) {
    throw new CccCampaignAdmissionError(
      "route-drift",
      `CCC campaign route drift for ${context.taskId}`,
    );
  }
}

async function inspectAndAssertLiveGit(
  input: AdmitCccCampaignActionInput,
  context: CccCampaignTaskContext,
): Promise<void> {
  const expected = {
    targetRoot: context.targetRepository.path,
    expectedBaseObject: context.targetRepository.baseCommit,
    nativeTaskId: context.taskId,
    semanticTaskId: context.semanticTaskId,
  };
  let inspection: unknown;
  try {
    inspection = await input.inspectLiveGit(expected, input.signal);
  } catch (error) {
    assertLiveSignal(input.signal);
    throw new CccCampaignAdmissionError(
      "git-inspection-failed",
      `CCC campaign live Git inspection failed before provider use: ${errorMessage(error)}`,
    );
  }
  assertLiveSignal(input.signal);
  if (!isInspectionRecord(inspection)) {
    throw new CccCampaignAdmissionError(
      "git-inspection-failed",
      `CCC campaign live Git inspection returned malformed state for ${context.taskId}`,
    );
  }
  if (inspection.targetRoot !== expected.targetRoot) {
    throw new CccCampaignAdmissionError(
      "git-target-root-drift",
      `CCC campaign target root drift for ${context.taskId}`,
    );
  }
  if (inspection.expectedBaseObject !== expected.expectedBaseObject) {
    throw new CccCampaignAdmissionError(
      "git-base-drift",
      `CCC campaign expected base object drift for ${context.taskId}`,
    );
  }
  if (!isCanonicalObservedHead(inspection.head) || inspection.headDescendsFromExpectedBase !== true) {
    throw new CccCampaignAdmissionError(
      "git-foreign-head",
      `CCC campaign HEAD is outside expected base ancestry for ${context.taskId}`,
    );
  }
  if (inspection.dirty !== false) {
    throw new CccCampaignAdmissionError(
      "git-dirty",
      `CCC campaign target repository is dirty for ${context.taskId}`,
    );
  }
}

function declaredProtectedAction(
  action: CccCampaignActionLookup,
  context: CccCampaignTaskContext,
): CccCampaignActionLookup | null {
  const protectedAction = context.protectedActions.find((candidate) =>
    candidate.id === action.actionId);
  if (!protectedAction) return null;
  if (protectedAction.target !== action.actionTarget) {
    throw new CccCampaignAdmissionError(
      "action-drift",
      `CCC campaign protected action ${action.actionId} target drift before provider use`,
    );
  }
  return actionLookup(action);
}

function actionLookup(action: CccCampaignActionLookup): CccCampaignActionLookup {
  return {
    actionId: action.actionId,
    actionTarget: action.actionTarget,
  };
}

async function claimProtectedAction(
  input: AdmitCccCampaignActionInput,
  context: CccCampaignTaskContext,
  action: CccCampaignActionLookup,
): Promise<Readonly<{ binding: CccCampaignAuthorityBinding; approval: CccCampaignActionLease }>> {
  const expectedBinding = createCccCampaignAuthorityBinding(context, action);
  try {
    const result = await input.claimProtectedAction(
      context,
      action,
      input.signal,
    );
    assertLiveSignal(input.signal);
    const binding = assertCccCampaignAuthorityBinding(result.binding);
    const lease = assertCccCampaignActionLease(
      result.lease,
      action.actionId,
      context.campaignDeadlineAt,
    );
    if (binding.bindingHash !== expectedBinding.bindingHash) {
      throw new Error("protected claim binding hash does not match expected campaign authority");
    }
    if (
      lease.actionTarget !== action.actionTarget
      || lease.bindingHash !== expectedBinding.bindingHash
    ) {
      throw new Error("protected claim lease does not match expected campaign authority");
    }
    return Object.freeze({
      binding: Object.freeze({ ...binding }),
      approval: Object.freeze({ ...lease }),
    });
  } catch (error) {
    assertLiveSignal(input.signal);
    throw new CccCampaignAdmissionError(
      "approval-refused",
      `CCC campaign protected action claim refused before provider use: ${errorMessage(error)}`,
    );
  }
}

function assertLiveSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CccCampaignAdmissionError(
      "aborted",
      "CCC campaign action admission aborted before provider use",
    );
  }
}

function isCanonicalObservedHead(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isInspectionRecord(value: unknown): value is Record<keyof CccCampaignLiveGitInspection, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frozenPlainDataSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => frozenPlainDataSnapshot(item))) as T;
  }
  if (!isPlainDataObject(value)) return value;
  const snapshot: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    snapshot[key] = frozenPlainDataSnapshot(child);
  }
  return Object.freeze(snapshot) as T;
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
