import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import { CccPlanningRefusal } from "./errors.js";
import {
  CCC_PLANNING_STAGE_IDS,
  type CccPlanningExactModelId,
  type CccPlanningRoleId,
  type CccPlanningStageId,
} from "./types.js";

/*
FNXC:CccPlanningArtifacts 2026-10-14-09:20:
The pure half of request-to-code artifacts (CONTRACT-v2 sections 2.4 and 2.6): the key grammar, the stage-to-kind table, content encoding and the two digests. Keys are `cccplan-r<3 digits>-<stage>-<slot>-v<2 digits>` and decode from the right, because stage ids such as `design-review` contain hyphens. Stored text and its digest are byte-exact: JSON is stored as canonical JSON, and text is fatal-decoded UTF-8 with any byte-order mark kept, so migration 0043 can recompute the digest from the stored text and a text artifact used as a packet source hashes to its manifest sha256. NUL is refused because PostgreSQL text cannot hold it.
*/

export const CCC_PLANNING_ARTIFACT_KEY_PREFIX = "cccplan-" as const;
export const CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA = "ccc-planning.artifact-envelope.v1" as const;
export const CCC_PLANNING_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export const CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH = 51;
export type CccPlanningArtifactKind =
  | "original_request" | "admission_grant" | "authority_receipt" | "tool_fidelity_receipt"
  | "confinement_qualification" | "decision_request" | "operator_answer" | "acceptance_cases"
  | "acceptance_review" | "repository_snapshot" | "research_evidence" | "citation" | "extraction"
  | "extraction_review" | "source_verification" | "design_alternative" | "design_review"
  | "decision_record" | "objection" | "requirement_map" | "final_prd" | "technical_annex" | "task_plan"
  | "routing_plan" | "verifier_bundle" | "verifier_audit" | "oracle_observation" | "oracle_review"
  | "product_review" | "technical_review" | "adjudication" | "model_receipt" | "budget_receipt"
  | "spec_ready" | "build_grant" | "budget_amendment" | "build_transition" | "admission_facts"
  | "packet_manifest" | "sidecar" | "bundle" | "execution_plan" | "authorship_receipt" | "import_intent"
  | "import_receipt" | "live_execution_release" | "task_review" | "final_judgment" | "proof_results" | "invalidation";
export const CCC_PLANNING_STAGE_KINDS: Readonly<Record<CccPlanningStageId, readonly CccPlanningArtifactKind[]>> = Object.freeze({
  admission: ["original_request", "admission_grant", "authority_receipt"],
  preflight: ["tool_fidelity_receipt", "confinement_qualification", "model_receipt"],
  intent: ["acceptance_cases", "acceptance_review", "objection", "decision_request", "model_receipt"],
  research: ["repository_snapshot", "research_evidence", "citation", "extraction", "extraction_review", "source_verification",
    "objection", "model_receipt"],
  design: ["design_alternative", "model_receipt"],
  "design-review": ["design_review", "objection", "model_receipt"],
  spec: ["requirement_map", "final_prd", "technical_annex", "decision_record", "model_receipt"],
  plan: ["task_plan", "routing_plan", "model_receipt"],
  verifier: ["verifier_bundle", "verifier_audit", "oracle_observation", "oracle_review", "objection", "model_receipt"],
  review: ["product_review", "technical_review", "adjudication", "objection", "budget_receipt", "model_receipt"],
  repair: ["decision_record", "requirement_map", "final_prd", "technical_annex", "task_plan", "routing_plan", "verifier_bundle",
    "model_receipt"],
  specready: ["spec_ready"],
  import: ["build_transition", "admission_facts", "packet_manifest", "sidecar", "bundle", "execution_plan", "authorship_receipt",
    "import_intent", "import_receipt", "live_execution_release"],
  operator: ["operator_answer", "build_grant", "budget_amendment"],
  invalidate: ["invalidation"],
  g7: ["task_review", "proof_results", "model_receipt"],
  g8: ["final_judgment", "proof_results", "model_receipt"],
});
export type CccPlanningArtifactSlot = Readonly<{ runRevision: number; stageId: CccPlanningStageId; slot: string; version: number }>;
export type CccPlanningArtifactRef = Readonly<{ artifactKey: string; digest: string }>;
export type CccPlanningArtifactStatus = "complete" | "infeasible" | "blocked" | "refused";
export type CccPlanningArtifactProducer = Readonly<{
  kind: "model" | "controller" | "operator";
  roleId: CccPlanningRoleId | "controller" | "operator";
  instanceId: string;
  attemptRef?: string;
  requestedModel?: CccPlanningExactModelId;
  resolvedModel?: string;
  routeReceiptDigest?: string;
}>;
export type CccPlanningArtifactPolicy = Readonly<{
  promptVersion: string; promptDigest: string;
  toolPolicyVersion: string; toolPolicyDigest: string;
}>;
export type CccPlanningPublicationFence =
  | Readonly<{ kind: "admission" }>
  | Readonly<{ kind: "work_item_lease"; workItemId: string; leaseOwner: string; attempt: number; runId: string }>
  | Readonly<{ kind: "campaign_work_item_lease"; workItemId: string; leaseOwner: string; attempt: number; runId: `ccc-prd:${string}` }>
  | Readonly<{ kind: "operator"; runRevision: number; controlSeq: number }>;
export type CccPlanningArtifactEnvelopeV1 = Readonly<{
  schema: typeof CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA;
  artifactKey: string; runId: string; runRevision: number; stageId: CccPlanningStageId; slot: string; version: number;
  kind: CccPlanningArtifactKind;
  contentType: "application/json" | "text/markdown; charset=utf-8";
  contentSchema: string;
  inputs: readonly CccPlanningArtifactRef[];
  producer: CccPlanningArtifactProducer;
  policy: CccPlanningArtifactPolicy;
  outputDigest: string;
  status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence;
  identityDigest: string;
  publishedAt: string;
}>;
export type CccPlanningArtifactContent =
  | Readonly<{ type: "json"; value: unknown }>
  | Readonly<{ type: "text"; bytes: Uint8Array }>;

const STAGE_IDS: ReadonlySet<string> = new Set(CCC_PLANNING_STAGE_IDS);
const SLOT_PATTERN = /^[a-z0-9]{1,20}$/u;
/** Greedy stage group: the slot and version bind to the right-most hyphens, so a hyphenated stage id stays whole. */
const KEY_PATTERN = /^cccplan-r([0-9]{3})-(.+)-([a-z0-9]{1,20})-v([0-9]{2})$/u;

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function slotProblem(slot: CccPlanningArtifactSlot): string | null {
  if (!Number.isSafeInteger(slot.runRevision) || slot.runRevision < 1 || slot.runRevision > 999) return "run revision must be 1..999";
  if (!STAGE_IDS.has(slot.stageId)) return `unknown stage ${JSON.stringify(slot.stageId)}`;
  if (typeof slot.slot !== "string" || !SLOT_PATTERN.test(slot.slot)) return `slot ${JSON.stringify(slot.slot)} must match [a-z0-9]{1,20}`;
  if (!Number.isSafeInteger(slot.version) || slot.version < 1 || slot.version > 99) return "version must be 1..99";
  return null;
}

export function encodeCccPlanningArtifactKey(slot: CccPlanningArtifactSlot): string {
  const problem = slotProblem(slot);
  if (problem !== null) throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", `artifact key: ${problem}`, "slot");
  const key = `${CCC_PLANNING_ARTIFACT_KEY_PREFIX}r${String(slot.runRevision).padStart(3, "0")}-${slot.stageId}-${slot.slot}-v${String(slot.version).padStart(2, "0")}`;
  if (key.length > CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", `artifact key ${key} is longer than ${CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH}`, "slot");
  }
  return key;
}

/** Right-to-left decode; null for any key that `encodeCccPlanningArtifactKey` would not produce. */
export function decodeCccPlanningArtifactKey(key: string): CccPlanningArtifactSlot | null {
  if (typeof key !== "string" || key.length > CCC_PLANNING_ARTIFACT_KEY_MAX_LENGTH) return null;
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const slot: CccPlanningArtifactSlot = {
    runRevision: Number(match[1]), stageId: match[2] as CccPlanningStageId, slot: match[3]!, version: Number(match[4]),
  };
  return slotProblem(slot) === null ? slot : null;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function refuseOversize(byteLength: number): void {
  if (byteLength > CCC_PLANNING_ARTIFACT_MAX_BYTES) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_TOO_LARGE",
      `artifact content is ${byteLength} bytes, over the ${CCC_PLANNING_ARTIFACT_MAX_BYTES}-byte limit`, "content");
  }
}

export function encodeCccPlanningArtifactContent(content: CccPlanningArtifactContent):
  Readonly<{ text: string; outputDigest: string; contentType: CccPlanningArtifactEnvelopeV1["contentType"] }> {
  if (content.type === "json") {
    const text = canonicalCccPrdJson(content.value);
    const bytes = Buffer.from(text, "utf8");
    refuseOversize(bytes.byteLength);
    return { text, outputDigest: sha256Hex(bytes), contentType: "application/json" };
  }
  refuseOversize(content.bytes.byteLength);
  if (content.bytes.includes(0)) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_NOT_UTF8", "artifact text contains a NUL byte", "content");
  }
  let text: string;
  try {
    text = UTF8_FATAL.decode(content.bytes);
  } catch {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_NOT_UTF8", "artifact text is not valid UTF-8", "content");
  }
  return { text, outputDigest: sha256Hex(content.bytes), contentType: "text/markdown; charset=utf-8" };
}

/** Drops keys whose value is undefined, at any depth, so an absent optional field and an undefined one digest the same. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = withoutUndefined(entry);
    return result;
  }
  return value;
}

/** sha256(canonical(envelope minus fence, publishedAt and identityDigest)); a full envelope may be passed. */
export function computeCccPlanningEnvelopeIdentityDigest(
  envelope: Omit<CccPlanningArtifactEnvelopeV1, "fence" | "publishedAt" | "identityDigest">): string {
  const identity: Record<string, unknown> = { ...envelope };
  delete identity.fence;
  delete identity.publishedAt;
  delete identity.identityDigest;
  return sha256Hex(canonicalCccPrdJson(withoutUndefined(identity)));
}

/** sha256(canonical(refs sorted by key, duplicates removed)); one key with two digests is refused. */
export function computeCccPlanningClosureDigest(closure: readonly CccPlanningArtifactRef[]): string {
  const byKey = new Map<string, string>();
  for (const ref of closure) {
    const seen = byKey.get(ref.artifactKey);
    if (seen !== undefined && seen !== ref.digest) {
      throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
        `closure names ${ref.artifactKey} with two digests ${seen} and ${ref.digest}`, "inputs");
    }
    byKey.set(ref.artifactKey, ref.digest);
  }
  const refs = [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([artifactKey, digest]) => ({ artifactKey, digest }));
  return sha256Hex(canonicalCccPrdJson(refs));
}
