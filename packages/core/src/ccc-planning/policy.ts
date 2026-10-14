import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import { CCC_PLANNING_BUDGET_POLICY_V1 } from "./budget-fit.js";
import { CCC_PLANNING_RUN_ID_PATTERN } from "./marker.js";
import type {
  CccModelFamily,
  CccModelIdentityReason,
  CccPlanningAuditMutationType,
  CccPlanningExactModelId,
  CccPlanningGrantV1,
  CccPlanningRoleClass,
  CccPlanningRoleId,
  CccPlanningRoleSpec,
  CccPlanningRouteBinding,
  CccPlanningStageId,
} from "./types.js";

/*
FNXC:CccPlanningPolicy 2026-10-14-08:55:
The FULL-v2 role policy and every derived identifier of a request-to-code run (CONTRACT-v2 sections 2.1, 2.7 and 2.9). Identifiers are a prefix plus SHA-256 over a domain tag, a NUL byte and canonical JSON, so two different kinds of identity can never collide and the same inputs always give the same key on replay. The policy digest covers everything that decides what a run may spend or call, including the planning-linked writer toolset with `fn_complete_phase` (leader adjudication item 37), so a policy change can never pass as the admitted one.
*/

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function domainDigest(tag: string, value: unknown): string {
  return sha256Hex(`${tag}\0${canonicalCccPrdJson(value)}`);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function requireRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999) {
    throw new TypeError(`${label}: run revision must be an integer from 1 to 999, got ${String(revision)}`);
  }
}

function requireRunId(runId: string, label: string): void {
  if (!CCC_PLANNING_RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(`${label}: run id must match ccc-plan:<24 hex>, got ${JSON.stringify(runId)}`);
  }
}

function withoutKey<T extends object, K extends string>(value: T, key: K): Omit<T, K> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy as Omit<T, K>;
}

// ---------------------------------------------------------------- derived identifiers (section 2.1)

export function cccPlanningRunId(i: { projectId: string; requestDigest: string; receiptSha256: string }): string {
  return `ccc-plan:${domainDigest("ccc-plan-run/v1", i).slice(0, 24)}`;
}

export function cccPlanningTurnKey(i: { projectId: string; runId: string; revision: number; stageId: CccPlanningStageId;
  roleId: CccPlanningRoleId; lineageId: string; nodeAttemptOrdinal: 1 | 2 | 3 }): string {
  return `ccc-plan-turn-${domainDigest("ccc-plan-turn/v1", i)}`;
}

/** The fence is metadata, not identity: a re-leased work item replays the same attempt key. */
export function cccPlanningAttemptKey(i: { projectId: string; runId: string; turnKey: string; dispatchKey: string }): string {
  return `ccc-plan-attempt-${domainDigest("ccc-plan-attempt/v1", i)}`;
}

/** `baseTurnKey` is the campaign key from createProviderAttemptTurnKey, which carries no retry index (challenge 18). */
export function cccPlanningLinkedWriterTurnKey(i: { baseTurnKey: string; dispatchAttemptOrdinal: 1 | 2 | 3 }): string {
  return `ccc-plan-writer-${domainDigest("ccc-plan-writer-turn/v1", i)}`;
}

export function cccPlanningEventId(i: { projectId: string; runId: string; mutationType: CccPlanningAuditMutationType; subject: string }): string {
  return `ccc-plan-event-${domainDigest("ccc-plan-event/v1", i)}`;
}

export function cccPlanningDecisionId(i: { revision: number; questionDigest: string }): string {
  requireRevision(i.revision, "cccPlanningDecisionId");
  if (!/^[0-9a-f]{64}$/u.test(i.questionDigest)) {
    throw new TypeError("cccPlanningDecisionId: questionDigest must be a lowercase sha256");
  }
  return `ccc-plan-decision-r${pad(i.revision, 3)}-${i.questionDigest.slice(0, 16)}`;
}

/** Matches the anchor CHECK `^ccc-plan:[0-9a-f]{24}:r[1-9][0-9]{0,2}$` (decision 0.5). */
export function cccPlanningImportKey(runId: string, revision: number): string {
  requireRunId(runId, "cccPlanningImportKey");
  requireRevision(revision, "cccPlanningImportKey");
  return `${runId}:r${revision}`;
}

export function cccPlanningGrantDigest(g: CccPlanningGrantV1): string {
  return sha256Hex(canonicalCccPrdJson(g));
}

/** Hashes every binding field except `bindingHash`, even when a caller passes a full binding. */
export function cccPlanningBindingHash(b: Omit<CccPlanningRouteBinding, "bindingHash">): string {
  return sha256Hex(canonicalCccPrdJson(withoutKey(b as CccPlanningRouteBinding, "bindingHash")));
}

export function cccPlanningBaselineBranchRef(runId: string, revision: number): string {
  requireRunId(runId, "cccPlanningBaselineBranchRef");
  requireRevision(revision, "cccPlanningBaselineBranchRef");
  return `refs/heads/fusion/r2c-${runId.slice("ccc-plan:".length)}-r${pad(revision, 3)}-baseline`;
}

// ---------------------------------------------------------------- FULL-v2 role policy (section 2.7)

const GLM = "glm/glm-5.3" as const;
const FLASH = "glm/glm-5.3-flash" as const;
const M3 = "minimax/MiniMax-M3" as const;

function role(
  roleId: CccPlanningRoleId, modelId: CccPlanningExactModelId, roleClass: CccPlanningRoleClass,
  stageId: CccPlanningRoleSpec["stageId"], phase: CccPlanningRoleSpec["phase"],
  reviewedBy: CccPlanningRoleId | null, counting: CccPlanningRoleSpec["counting"],
): CccPlanningRoleSpec {
  return Object.freeze({ roleId, modelId, family: CCC_PLANNING_MODEL_FAMILIES[modelId], roleClass, stageId, phase, reviewedBy, counting });
}

export const CCC_PLANNING_MODEL_FAMILIES: Readonly<Record<CccPlanningExactModelId, CccModelFamily>> = Object.freeze({
  "glm/glm-5.3": "glm", "glm/glm-5.3-flash": "glm", "minimax/MiniMax-M3": "minimax" });

export const CCC_PLANNING_ROLE_POLICY_FULL_V2: Readonly<{ policyId: "ccc-planning.role-policy.full-v2"; roles: readonly CccPlanningRoleSpec[] }> =
  Object.freeze({
    policyId: "ccc-planning.role-policy.full-v2",
    roles: Object.freeze([
      role("intent-assessor", GLM, "author", "intent", "planning", "acceptance-reviewer", "fixed"),
      role("acceptance-reviewer", M3, "critic", "intent", "planning", null, "fixed"),
      role("researcher", M3, "researcher", "research", "planning", "source-verifier", "fixed"),
      role("extraction-leaf", FLASH, "researcher", "research", "planning", "leaf-reviewer", "per-leaf"),
      role("leaf-reviewer", M3, "critic", "research", "planning", null, "once-if-leaves"),
      // The source verifier is a researcher-class role that is itself the review of the M3 researcher.
      role("source-verifier", GLM, "researcher", "research", "planning", null, "fixed"),
      role("designer-a", M3, "author", "design", "planning", "design-a-reviewer", "fixed"),
      role("designer-b", GLM, "author", "design", "planning", "design-b-reviewer", "fixed"),
      role("design-a-reviewer", GLM, "critic", "design-review", "planning", null, "fixed"),
      role("design-b-reviewer", M3, "critic", "design-review", "planning", null, "fixed"),
      role("spec-author", GLM, "author", "spec", "planning", "product-adversary", "fixed"),
      role("execution-planner", GLM, "author", "plan", "planning", "technical-critic", "fixed"),
      role("verifier-author", GLM, "writer", "verifier", "planning", "verifier-auditor", "fixed"),
      role("verifier-auditor", M3, "critic", "verifier", "planning", null, "fixed"),
      role("product-adversary", M3, "critic", "review", "planning", null, "fixed"),
      role("technical-critic", M3, "critic", "review", "planning", null, "fixed"),
      role("preflight-writer", FLASH, "writer", "preflight", "planning", null, "probe"),
      role("preflight-critic", M3, "critic", "preflight", "planning", null, "probe"),
      role("preflight-researcher", M3, "researcher", "preflight", "planning", null, "probe"),
      role("implementation-writer", FLASH, "writer", "campaign", "implementation", "task-reviewer", "per-task"),
      role("task-reviewer", M3, "critic", "g7", "review_proof", null, "per-task"),
      role("final-judge", M3, "critic", "g8", "review_proof", null, "once"),
    ]),
  });

const ROLES_BY_ID: ReadonlyMap<CccPlanningRoleId, CccPlanningRoleSpec> =
  new Map(CCC_PLANNING_ROLE_POLICY_FULL_V2.roles.map((spec) => [spec.roleId, spec]));

export function cccPlanningRole(roleId: CccPlanningRoleId): CccPlanningRoleSpec {
  const spec = ROLES_BY_ID.get(roleId);
  if (!spec) throw new TypeError(`unknown request-to-code role ${JSON.stringify(roleId)}`);
  return spec;
}

// ---------------------------------------------------------------- closed toolsets (section 2.7, D11)

export const CCC_PLANNING_TOOLSETS: Readonly<Record<CccPlanningRoleClass, readonly string[]>> = Object.freeze({
  author: Object.freeze(["ccc_submit_artifact", "find", "grep", "ls", "read"]),
  researcher: Object.freeze(["ccc_citation_read", "ccc_research_fetch", "ccc_submit_artifact", "find", "grep", "ls", "read"]),
  critic: Object.freeze(["ccc_submit_verdict", "find", "grep", "ls", "read"]),
  writer: Object.freeze(["bash", "edit", "find", "grep", "ls", "read", "write"]),
}); // "grep" is always the Fusion-owned confined grep (D11), never Pi's
export const CCC_PLANNING_PROBE_TOOL = "ccc_probe_echo" as const;

/*
FNXC:CccPlanningLinkedWriterTools 2026-10-14-08:55:
A planning-linked campaign writer must call `fn_complete_phase` to finish its phase (engine executor prompt, tool and policy exemption; ccc-campaign-ready.ts), and the session tool set must equal the policy exactly (D11). So the linked writer's closed toolset is the writer class plus `fn_complete_phase`, and only that scope gets it: the planning-stage writers (verifier author, preflight writer) never run a campaign phase (leader adjudication item 37).
*/
export const CCC_PLANNING_COMPLETE_PHASE_TOOL = "fn_complete_phase" as const;
export const CCC_PLANNING_LINKED_WRITER_TOOLSET =
  Object.freeze(["bash", "edit", "find", "fn_complete_phase", "grep", "ls", "read", "write"] as const);

/** The exact, sorted final tool names for one session: role class, plus the probe tool in probe mode, plus the completion tool for a linked writer. */
export function cccPlanningSessionToolNames(i: Readonly<{
  roleClass: CccPlanningRoleClass; scopeKind: "planning" | "planning-linked-writer"; probe?: boolean }>): readonly string[] {
  if (i.scopeKind === "planning-linked-writer") {
    if (i.roleClass !== "writer") throw new TypeError(`a planning-linked session is always a writer, not ${i.roleClass}`);
    if (i.probe === true) throw new TypeError("a planning-linked writer is never a probe session");
    return CCC_PLANNING_LINKED_WRITER_TOOLSET;
  }
  const base = CCC_PLANNING_TOOLSETS[i.roleClass];
  return i.probe === true ? Object.freeze([...base, CCC_PLANNING_PROBE_TOOL].sort()) : base;
}

export const CCC_PLANNING_PREFLIGHT_LINEAGES = [
  { lineageId: "preflight:writer", roleId: "preflight-writer", probes: ["identity", "strict-echo", "exact-edit"] },
  { lineageId: "preflight:critic", roleId: "preflight-critic", probes: ["identity", "strict-echo", "verdict-shape"] },
  { lineageId: "preflight:researcher", roleId: "preflight-researcher", probes: ["identity", "strict-echo", "citation-read"] },
] as const;
export const CCC_PLANNING_DENIED_NAMES = [".agentsecrets", ".env", ".env.*", ".npmrc", "_secrets"] as const;

// ---------------------------------------------------------------- exact model identity (section 2.7)

const EXACT_PINS: ReadonlySet<string> = new Set(Object.keys(CCC_PLANNING_MODEL_FAMILIES));

/*
FNXC:CccPlanningModelIdentity 2026-10-14-08:55:
Only the three exact pins are admitted, compared case-sensitively. Every refusal is classified case-insensitively in the frozen order: 1 exact pin admits; 2 any glm-5.2 form ("glm-5.2", "*\/glm-5.2", "glm/glm-5.2-*") is excluded-model; 3 a -latest, :latest or @latest suffix is floating-alias; 4 a "combo/" prefix is combo-route; 5 no "/" is unqualified-id; 6 anything else is not-in-pin-registry. The live OmniRoute catalog still serves `glm/glm-5.2` and the lookalike `glm/glm-5.3-flashx`; both refuse (rules 2 and 6).
*/
export function classifyCccModelIdentity(modelId: string):
  | Readonly<{ admitted: true; modelId: CccPlanningExactModelId; family: CccModelFamily }>
  | Readonly<{ admitted: false; reason: CccModelIdentityReason }> {
  if (EXACT_PINS.has(modelId)) {
    const exact = modelId as CccPlanningExactModelId;
    return { admitted: true, modelId: exact, family: CCC_PLANNING_MODEL_FAMILIES[exact] };
  }
  const lower = modelId.toLowerCase();
  if (lower === "glm-5.2" || lower.endsWith("/glm-5.2") || lower.startsWith("glm/glm-5.2-")) {
    return { admitted: false, reason: "excluded-model" };
  }
  if (lower.endsWith("-latest") || lower.endsWith(":latest") || lower.endsWith("@latest")) {
    return { admitted: false, reason: "floating-alias" };
  }
  if (lower.startsWith("combo/")) return { admitted: false, reason: "combo-route" };
  if (!lower.includes("/")) return { admitted: false, reason: "unqualified-id" };
  return { admitted: false, reason: "not-in-pin-registry" };
}

// ---------------------------------------------------------------- counters and constants (section 2.9)

export const CCC_PLANNING_MAX_CALLS_PER_ATTEMPT = 11 as const;            // 1 initial + 10 feedback-processing calls
export const CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE = 3 as const; // counted at first reservation of a turn key
export const CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT = 3 as const;   // per preflight attempt (turn key)
export const CCC_PLANNING_MAX_REPAIR_CHUNKS = 4 as const;                 // one global epoch, shared planning + coding
export const CCC_PLANNING_MAX_REPAIR_EPOCHS = 1 as const;
export const CCC_PLANNING_STAGNATION_EPOCHS = 2 as const;                 // stop after 2 consecutive non-improving epochs
export const CCC_PLANNING_LAUNCH_HEADROOM_MS = 30_000 as const;
export const CCC_PLANNING_AUDIT_STRING_MAX = 256 as const;
export const CCC_PRD_IMPORT_MAX_REQUESTS = 10_000 as const;               // mirrors import-admission.ts
export const CCC_PRD_IMPORT_MAX_DURATION_MS = 86_400_000 as const;        // mirrors import-admission.ts
export const CCC_PLANNING_I2_MAX_CONCURRENCY = 1 as const;
export const CCC_PLANNING_SOURCE_POLICY_I2 = {
  policyId: "ccc-planning.source-policy.i2.v1",
  allow: [
    { host: "nodejs.org", pathPrefix: "/docs/latest-v24.x/api/" },
    { host: "developer.mozilla.org", pathPrefix: "/en-US/docs/Web/JavaScript/" },
  ],
  maxFetchesPerNode: 8, maxFetchesPerRun: 24, maxRawBytesPerFetch: 1_048_576, maxRawBytesPerRun: 16_777_216,
  timeoutMs: 20_000, maxRedirects: 3, mimeTypes: ["text/html", "text/plain", "text/markdown", "application/json"],
} as const;

/** policySha256 = sha256(canonical(source policy)); must equal receipt.sourceToolPolicy.sha256 at G0. */
export function cccPlanningSourcePolicySha256(): string {
  return sha256Hex(canonicalCccPrdJson(CCC_PLANNING_SOURCE_POLICY_I2));
}

/** Exactly what `cccPlanningPolicyDigest` hashes; exported so a reviewer can see and re-derive it. */
export function cccPlanningPolicyDigestMaterial(): Readonly<Record<string, unknown>> {
  return {
    roles: CCC_PLANNING_ROLE_POLICY_FULL_V2.roles,
    toolsets: CCC_PLANNING_TOOLSETS,
    linkedWriterToolset: CCC_PLANNING_LINKED_WRITER_TOOLSET,
    probeTool: CCC_PLANNING_PROBE_TOOL,
    preflightLineages: CCC_PLANNING_PREFLIGHT_LINEAGES,
    deniedNames: CCC_PLANNING_DENIED_NAMES,
    budgetPolicy: CCC_PLANNING_BUDGET_POLICY_V1,
    sourcePolicy: CCC_PLANNING_SOURCE_POLICY_I2,
    counters: {
      maxCallsPerAttempt: CCC_PLANNING_MAX_CALLS_PER_ATTEMPT,
      maxDispatchAttemptsPerLineage: CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE,
      preflightMaxCallsPerAttempt: CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT,
      maxRepairChunks: CCC_PLANNING_MAX_REPAIR_CHUNKS,
      maxRepairEpochs: CCC_PLANNING_MAX_REPAIR_EPOCHS,
      stagnationEpochs: CCC_PLANNING_STAGNATION_EPOCHS,
      launchHeadroomMs: CCC_PLANNING_LAUNCH_HEADROOM_MS,
      auditStringMax: CCC_PLANNING_AUDIT_STRING_MAX,
      importMaxRequests: CCC_PRD_IMPORT_MAX_REQUESTS,
      importMaxDurationMs: CCC_PRD_IMPORT_MAX_DURATION_MS,
      i2MaxConcurrency: CCC_PLANNING_I2_MAX_CONCURRENCY,
    },
  };
}

/** sha256(canonical({roles, toolsets, linked writer toolset, probe tool, preflight lineages, deniedNames, budget policy, source policy, counters})). */
export function cccPlanningPolicyDigest(): string {
  return sha256Hex(canonicalCccPrdJson(cccPlanningPolicyDigestMaterial()));
}
