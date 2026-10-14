import { posix } from "node:path";
import { CCC_PRD_PROTECTED_ACTION_KINDS } from "../ccc-prd/contract.js";
import type { CccPrdProtectedActionKind } from "../ccc-prd/types.js";
import { decodeCccPlanningArtifactKey, type CccPlanningArtifactRef } from "./artifacts.js";
import { isCccPlanningRunId } from "./marker.js";
import { classifyCccModelIdentity, cccPlanningRole, CCC_PLANNING_DENIED_NAMES } from "./policy.js";
import {
  CCC_PLANNING_STAGE_IDS,
  type CccPlanningExactModelId,
  type CccPlanningRoleId,
  type CccPlanningStageId,
  type CccReviewFindingRef,
} from "./types.js";

/*
FNXC:CccPlanningSchemas 2026-10-14-09:35:
The content schemas a request-to-code run publishes as JSON artifacts (CONTRACT-v2 section 2.17) and one validator per schema. Every validator is pure, checks exact keys at every level and returns a list of plain-language problems, empty when the value is admissible. The task-plan validator is the gate G4 runs before the compiler's graph admission, which under-refuses (carry-forward GG): it refuses duplicate task ids, duplicate or undeclared protected-action ids, dependencies on undeclared tasks, edges that are not `depends_on` or disagree with the declared dependencies, and owned paths that overlap only after normalization (`./src/a.mjs`, `src/../src/a.mjs`). ADR B fixes the requirement-map and spec-ready shapes; the other shapes here are the smallest ones the later cards need, because no ADR froze them.
FNXC:CccPlanningSchemas 2026-10-14-09:21:
Errata E1 tightens three shapes. Proof results follow CONTRACT-v3 section 2.17 (item 46): one settled proof attempt per proof id, with its attempt key, state and stored terminal digests (E1-8). Owned paths are compared on a case- and normalization-folded key because the I2 host's APFS volume folds both, and a task may not list a path twice, own anything inside `.git` or own an `.env` file (E1-10). A verifier proof id is its Taskfile name and each proof names its own `verify:<id>` target; the bundle has no root-level task (E1-12, item 41).
FNXC:CccPlanningSchemas 2026-10-14-13:26:
Errata E2 (the K1 final repair). The path key folds case fully, as APFS does (E2-40), and also decides write-root containment (E2-46). Owned paths, write roots, verifier files and control files refuse every denied name as well as `.git` and `.env` (E2-41, E2-42), and bundle and control files are de-duplicated on the key (E2-41). Proof ids in a task plan and in proof results match the Taskfile proof-id pattern, and a committed proof result has exit code 0, as the proof-attempt store requires (E2-43).
FNXC:CccPlanningSchemas 2026-10-14-15:05:
Card K1b (errata E4-K, the K1 residual). The path key lower-cases before it upper-cases, so the capital sharp s keys with the sharp s and `ss` (E2-40a). A control file may not equal or lie inside a verifier bundle file on that key, so a control can never replace the verifier (item 4). The spec-ready baseline files get the verifier-file refusals and key de-duplication, and a requirement's proof ids must be Taskfile-safe proof ids, as defence in depth (item 5).
*/

export const CCC_PLANNING_CONTENT_SCHEMAS = {
  acceptanceCases: "ccc-planning.acceptance-cases.v1",
  requirementMap: "ccc-planning.requirement-map.v1",
  taskPlan: "ccc-planning.task-plan.v1",
  routingPlan: "ccc-planning.routing-plan.v1",
  verifierBundle: "ccc-planning.verifier-bundle.v1",
  adjudication: "ccc-planning.adjudication.v1",
  specReady: "ccc-planning.spec-ready.v1",
  decisionRequest: "ccc-planning.decision-request.v1",
  objection: "ccc-planning.objection.v1",
  decisionRecord: "ccc-planning.decision-record.v1",
  buildTransition: "ccc-planning.build-transition.v1",
  proofResults: "ccc-planning.proof-results.v1",
} as const;

export type CccPlanningAcceptanceCasesV1 = Readonly<{
  schema: "ccc-planning.acceptance-cases.v1";
  cases: readonly Readonly<{ id: string; statement: string; requestQuotes: readonly string[] }>[];
  exclusions: readonly Readonly<{ id: string; statement: string; requestQuotes: readonly string[] }>[];
}>;

export type CccPlanningRequirementMapV1 = Readonly<{
  schema: "ccc-planning.requirement-map.v1";
  requirements: readonly Readonly<{
    id: string; title: string; statement: string; proofIds: readonly string[];
    clauses: readonly Readonly<{
      id: string; text: string;
      derivation:
        | Readonly<{ kind: "request"; requestQuotes: readonly string[]; acceptanceCaseIds: readonly string[] }>
        | Readonly<{ kind: "annex"; decisionIds: readonly string[] }>;
    }>[];
  }>[];
  nonGoals: readonly Readonly<{ id: string; text: string; requestQuotes: readonly string[]; exclusionIds: readonly string[] }>[];
}>;

export type CccPlanningTaskPlanTaskV1 = Readonly<{
  id: string; title: string; description: string;
  requirementIds: readonly string[]; dependencyTaskIds: readonly string[]; proofIds: readonly string[];
  ownedPaths: readonly string[]; allowedWriteRoots: readonly string[]; protectedActionIds: readonly string[];
}>;
export type CccPlanningTaskPlanEdgeV1 = Readonly<{ id: string; fromTaskId: string; toTaskId: string; kind: "depends_on" }>;
export type CccPlanningTaskPlanProtectedActionV1 = Readonly<{ id: string; kind: CccPrdProtectedActionKind; target: string }>;
export type CccPlanningTaskPlanV1 = Readonly<{
  schema: "ccc-planning.task-plan.v1";
  tasks: readonly CccPlanningTaskPlanTaskV1[];
  edges: readonly CccPlanningTaskPlanEdgeV1[];
  protectedActions: readonly CccPlanningTaskPlanProtectedActionV1[];
}>;

export type CccPlanningRoutingPlanV1 = Readonly<{
  schema: "ccc-planning.routing-plan.v1";
  routes: readonly Readonly<{ taskId: string; providerId: string; modelId: CccPlanningExactModelId; transport: "pi" }>[];
}>;

/** A proof id is its Taskfile name: `taskfileTask` is always `verify:${id}` (errata E1-12, v3 item 41). */
export type CccPlanningVerifierProofV1 = Readonly<{
  id: string; requirementIds: readonly string[]; files: readonly string[]; taskfileTask: `verify:${string}`;
}>;
export type CccPlanningVerifierBundleV1 = Readonly<{
  schema: "ccc-planning.verifier-bundle.v1";
  files: readonly Readonly<{ path: string; mode: "100644" | "100755"; content: string }>[];
  proofs: readonly CccPlanningVerifierProofV1[];
  controls: readonly Readonly<{ id: string; requirementId: string; files: readonly Readonly<{ path: string; content: string }>[] }>[];
}>;

export type CccPlanningAdjudicationV1 = Readonly<{
  schema: "ccc-planning.adjudication.v1";
  epoch: number;
  candidate: readonly CccPlanningArtifactRef[];
  reviews: readonly CccPlanningArtifactRef[];
  objections: readonly CccPlanningArtifactRef[];
  blockingFindings: number;
  verdict: "approve" | "repair" | "reject";
  approved: null | Readonly<{ finalPrd: CccPlanningArtifactRef; technicalAnnex: CccPlanningArtifactRef; taskPlan: CccPlanningArtifactRef }>;
}>;

export type CccPlanningDecisionRequestV1 = Readonly<{
  schema: "ccc-planning.decision-request.v1";
  question: string;
  options: readonly string[];
  context: readonly CccPlanningArtifactRef[];
}>;

export type CccPlanningSpecReadyV1 = Readonly<{
  schema: "ccc-planning.spec-ready.v1";
  runId: string;
  runRevision: number;
  mode: "spec" | "build";
  target: Readonly<{ projectId: string; repositoryPath: string; admittedBase: string }>;
  closure: readonly CccPlanningArtifactRef[];
  closureDigest: string;
  reviewed: Readonly<{
    originalRequest: CccPlanningArtifactRef; acceptanceCases: CccPlanningArtifactRef;
    requirementMap: CccPlanningArtifactRef; finalPrd: CccPlanningArtifactRef;
    technicalAnnex: CccPlanningArtifactRef; taskPlan: CccPlanningArtifactRef;
    routingPlan: CccPlanningArtifactRef; verifierBundle: CccPlanningArtifactRef;
    oracleAudit: CccPlanningArtifactRef; finalAdjudication: CccPlanningArtifactRef;
  }>;
  gates: readonly Readonly<{
    gate: "G0" | "G1" | "G2" | "G3" | "G4" | "G5";
    verdict: "pass";
    evidence: readonly CccPlanningArtifactRef[];
    inputClosureDigest: string;
  }>[];
  verifierBaseline: Readonly<{
    parent: string;
    files: readonly Readonly<{ path: string; mode: "100644" | "100755"; blobOid: string; sha256: string }>[];
    treeOid: string;
    author: Readonly<{ name: string; email: string; date: string }>;
    committer: Readonly<{ name: string; email: string; date: string }>;
    message: string;
    predictedCommitOid: string;
  }>;
  preparationCompile: Readonly<{
    targetKind: "disposable_clone";
    packetHash: string; sidecarHash: string; bundleHash: string;
    toolchainDigest: string;
    diagnostics: readonly [];
  }>;
  graphAdmission: Readonly<{ graphDigest: string; diagnostics: readonly [] }>;
  spend: Readonly<{
    planningCallsIssued: number; planningAllocation: number;
    implementationReserved: 0; reviewProofReserved: 0;
  }>;
  campaignAdmission: "pending";
  repositoryMutation: "none";
}>;

export type CccPlanningObjectionV1 = Readonly<{
  stageId: CccPlanningStageId;
  reviewerRoleId: CccPlanningRoleId;
  severity: "blocking" | "advisory";
  ref: CccReviewFindingRef;
  summary: string;
  reviewedRef: CccPlanningArtifactRef;
}>;

export type CccPlanningDecisionRecordV1 = Readonly<{
  objectionKey: string;
  proposal: string;
  evidence: readonly CccReviewFindingRef[];
  objection: string;
  discriminatingObservation: string;
  disposition: "accepted" | "rejected" | "deferred";
  remainingUncertainty: string;
}>;

export type CccPlanningBuildTransitionV1 = Readonly<{
  schema: "ccc-planning.build-transition.v1";
  b0: string;
  predictedCommitOid: string;
  branchRef: string;
  verifierBundle: CccPlanningArtifactRef;
  specReady: CccPlanningArtifactRef;
}>;

/**
 * One settled proof attempt, read from `listCccCampaignProofAttemptsForCommit` (v3 section 2.17, item 46; errata E1-8).
 * `state` is `committed` exactly when `resultSuccess` is true; `exitCode` is null when the process left none (killed).
 */
export type CccPlanningProofResultV1 = Readonly<{
  proofId: string;
  attemptKey: string;
  state: "committed" | "proved_failed";
  resultSuccess: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
  terminalEnvelopeSha256: string;
}>;
export type CccPlanningProofResultsV1 = Readonly<{
  sourceCommit: string;
  sourceTree: string;
  proofIds: readonly string[];
  phase: "task" | "final_integrated";
  results: readonly CccPlanningProofResultV1[];
}>;

export type CccPlanningContentValidator = (value: unknown) => readonly string[];

// ---------------------------------------------------------------- owned path normalization

/** One canonical spelling for a worktree-relative path, or null when the path is absolute, escapes, names the root or is not portable. */
export function normalizeCccPlanningRelativePath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.includes("\\") || path.includes("\0")) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return null;
  let normalized = posix.normalize(path);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}

function normalizePathList(paths: readonly string[], label: string): string[] {
  return paths.map((path) => {
    const normalized = normalizeCccPlanningRelativePath(path);
    if (normalized === null) throw new TypeError(`${label} ${JSON.stringify(path)} is not a relative path inside the worktree`);
    return normalized;
  });
}

/** Rewrites every owned path and write root into canonical form; throws TypeError on a path that cannot be owned. */
export function normalizeCccPlanningTaskPlanV1(plan: CccPlanningTaskPlanV1): CccPlanningTaskPlanV1 {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      ownedPaths: normalizePathList(task.ownedPaths, `task ${task.id} owned path`),
      allowedWriteRoots: normalizePathList(task.allowedWriteRoots, `task ${task.id} write root`),
    })),
  };
}

/*
FNXC:CccPlanningOwnedPaths 2026-10-14-09:21:
The I2 host is Darwin, whose default APFS volume ignores letter case and Unicode composed-versus-decomposed form, so `src/A.mjs` and `src/a.mjs`, or `café` in NFC and in NFD, are one file there (errata E1-10). Ownership is therefore compared on a folded key of the path. This is stricter than a case-sensitive Linux volume needs, which only refuses more plans, never fewer.
FNXC:CccPlanningOwnedPaths 2026-10-14-13:26:
Errata E2-40 replaces the E1-10 formula. APFS folds case fully, so `straße`/`strasse`, final/medial sigma and the `ﬁ` ligature/`fi` are also one file there, and simple lower-casing missed all three. The key is now the posix-normalized `p.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")`, without a trailing slash: upper-casing first expands ß to SS and ﬁ to FI and maps both sigmas to Σ, and lower-casing then lands every APFS-equal spelling on one string. Its one over-refusal is capital I against dotless ı, which APFS keeps apart; that is accepted as fail-closed. The key normalizes the spelling itself (`./`, `..`, `//`, a trailing slash), so every card that compares paths (GG under E2-13, for one) gets the same identity from any spelling.
*/
/*
FNXC:CccPlanningOwnedPaths 2026-10-14-15:05:
Card K1b (errata E4-K item 2, E2-40a) amends the E2-40 formula. U+1E9E (capital sharp s) is already upper case, so upper-casing first left it alone and the following lower-casing turned it into the sharp s, while the sharp s and `ss` both came out as `ss`: the three spellings open one file on APFS but had two keys. The key now lower-cases first, so the capital sharp s becomes the sharp s before the upper-casing expands it: `p.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC")`, posix-normalized. The extra pass keeps the rest of E2-40 as it was (ß/ss, ς/σ, ﬁ/fi, Kelvin K/k, İ/i̇, NFC/NFD, A/a) and the key is still idempotent; I against dotless ı remains the accepted over-refusal.
*/
/** The one comparison key of a worktree path on the I2 host's case- and normalization-insensitive volume. */
export function cccPlanningPathComparisonKey(path: string): string {
  let key = posix.normalize(path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC"));
  while (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

/** a and b (relative paths) overlap when their comparison keys are equal or one is a directory prefix of the other. */
export function cccPlanningPathsOverlap(a: string, b: string): boolean {
  const left = cccPlanningPathComparisonKey(a);
  const right = cccPlanningPathComparisonKey(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** The policy's denied names, folded like paths; an entry ending in `.*` matches by the prefix before the `*` (policy.ts). */
const DENIED_NAME_RULES: readonly Readonly<{ name: string; folded: string; prefix: boolean }>[] = Object.freeze(
  CCC_PLANNING_DENIED_NAMES.map((name) => {
    const prefix = name.endsWith(".*");
    return Object.freeze({ name, folded: cccPlanningPathComparisonKey(prefix ? name.slice(0, -1) : name), prefix });
  }));

/*
FNXC:CccPlanningOwnedPaths 2026-10-14-13:26:
Errata E2-41 and E2-42: one reason helper refuses a path a task may never own or write, and a verifier or control file may never be: a `.git` segment, an `.env` or `.env.*` file, or any segment that folds to a `CCC_PLANNING_DENIED_NAMES` entry (`.npmrc`, `_secrets/x`, `.agentsecrets`, `.envrc`, ...). Names that merely mention one, such as `src/env.mjs` or `docs/secrets-guide.md`, stay admissible.
FNXC:CccPlanningOwnedPaths 2026-10-14-15:05:
Accepted residual (card K1b, errata E4-K item 6; no test pins it): a denied name matches a whole path segment, or the part before the `*` of an `.env.*` entry, so `.envrc.bak` is admitted. A writer can create such a file, but no tool reads it by that name (direnv reads `.envrc` itself, which is refused).
*/
/** Why a relative path can never be owned or written by a task, or carried by a verifier bundle, or null. */
function forbiddenOwnedPathReason(path: string): string | null {
  const segments = cccPlanningPathComparisonKey(path).split("/");
  if (segments.includes(".git")) return "has a .git path segment";
  const basename = segments[segments.length - 1]!;
  if (basename === ".env" || basename.startsWith(".env.")) return "names an .env file";
  for (const segment of segments) {
    for (const rule of DENIED_NAME_RULES) {
      if (rule.prefix ? segment.startsWith(rule.folded) : segment === rule.folded) {
        return `has the denied name ${rule.name} as a path segment`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- shared checks

/** A proof id is its Taskfile name (errata E1-12): lowercase, digits and hyphens, at most 63 characters. */
export const CCC_PLANNING_PROOF_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const PROOF_ID = "a proof id of lowercase letters, digits and hyphens, at most 63 characters, not starting with a hyphen";
const HEX64 = /^[0-9a-f]{64}$/u;
const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const COUNTEREXAMPLE_MAX = 600;
const STAGE_IDS: ReadonlySet<string> = new Set(CCC_PLANNING_STAGE_IDS);

type Json = Record<string, unknown>;

class Problems {
  readonly list: string[] = [];

  add(problem: string): void {
    this.list.push(problem);
  }

  /** An object with exactly these keys (optional ones may be absent); null when it is not an object. */
  object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Json | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.add(`${path} must be an object`);
      return null;
    }
    const record = value as Json;
    for (const key of Object.keys(record)) {
      if (!required.includes(key) && !optional.includes(key)) this.add(`${path}: unexpected key ${key}`);
    }
    for (const key of required) if (!(key in record)) this.add(`${path}.${key} is required`);
    return record;
  }

  text(value: unknown, path: string, max?: number): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      this.add(`${path} must be a non-empty string`);
      return null;
    }
    if (max !== undefined && value.length > max) {
      this.add(`${path} must be at most ${max} characters`);
      return null;
    }
    return value;
  }

  pattern(value: unknown, path: string, regex: RegExp, what: string): string | null {
    if (typeof value !== "string" || !regex.test(value)) {
      this.add(`${path} must be ${what}`);
      return null;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | null {
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      this.add(`${path} must be one of ${options.join(", ")}`);
      return null;
    }
    return value as T;
  }

  integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      this.add(`${path} must be an integer from ${min} to ${max}`);
      return null;
    }
    return value;
  }

  array(value: unknown, path: string, min = 0): readonly unknown[] {
    if (!Array.isArray(value)) {
      this.add(`${path} must be an array`);
      return [];
    }
    if (value.length < min) this.add(min === 1 ? `${path} must have at least one entry` : `${path} must have at least ${min} entries`);
    return value;
  }

  /** Non-empty strings, each listed once. */
  texts(value: unknown, path: string, min = 0): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    this.array(value, path, min).forEach((entry, index) => {
      const text = this.text(entry, `${path}[${index}]`);
      if (text === null) return;
      if (seen.has(text)) this.add(`${path} lists ${text} more than once`);
      seen.add(text);
      result.push(text);
    });
    return result;
  }

  /** Proof ids (Taskfile names, errata E1-12 and E2-43), each listed once. */
  proofIds(value: unknown, path: string, min = 0): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    this.array(value, path, min).forEach((entry, index) => {
      const id = this.pattern(entry, `${path}[${index}]`, CCC_PLANNING_PROOF_ID_PATTERN, PROOF_ID);
      if (id === null) return;
      if (seen.has(id)) this.add(`${path} lists ${id} more than once`);
      seen.add(id);
      result.push(id);
    });
    return result;
  }

  ref(value: unknown, path: string): CccPlanningArtifactRef | null {
    const record = this.object(value, path, ["artifactKey", "digest"]);
    if (!record) return null;
    const key = typeof record.artifactKey === "string" && decodeCccPlanningArtifactKey(record.artifactKey) !== null
      ? record.artifactKey : null;
    if (key === null) this.add(`${path}.artifactKey must be a planning artifact key`);
    const digest = this.pattern(record.digest, `${path}.digest`, HEX64, "a lowercase sha256");
    return key !== null && digest !== null ? { artifactKey: key, digest } : null;
  }

  refs(value: unknown, path: string, min = 0): CccPlanningArtifactRef[] {
    const result: CccPlanningArtifactRef[] = [];
    const seen = new Set<string>();
    this.array(value, path, min).forEach((entry, index) => {
      const ref = this.ref(entry, `${path}[${index}]`);
      if (!ref) return;
      if (seen.has(ref.artifactKey)) this.add(`${path} names ${ref.artifactKey} more than once`);
      seen.add(ref.artifactKey);
      result.push(ref);
    });
    return result;
  }

  findingRef(value: unknown, path: string): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.add(`${path} must be an object`);
      return;
    }
    const kind = this.oneOf((value as Json).kind, `${path}.kind`, ["requirement", "source", "artifact", "counterexample"] as const);
    if (kind === "requirement") {
      const record = this.object(value, path, ["kind", "requirementId"]);
      if (record) this.text(record.requirementId, `${path}.requirementId`);
    } else if (kind === "source" || kind === "artifact") {
      const record = this.object(value, path, ["kind", "artifactKey"], kind === "source" ? ["quote"] : []);
      if (record) {
        if (typeof record.artifactKey !== "string" || decodeCccPlanningArtifactKey(record.artifactKey) === null) {
          this.add(`${path}.artifactKey must be a planning artifact key`);
        }
        if (record.quote !== undefined) this.text(record.quote, `${path}.quote`);
      }
    } else if (kind === "counterexample") {
      const record = this.object(value, path, ["kind", "text"]);
      if (record) this.text(record.text, `${path}.text`, COUNTEREXAMPLE_MAX);
    }
  }
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) (seen.has(id) ? repeated : seen).add(id);
  return [...repeated];
}

function validated(build: (p: Problems) => void): readonly string[] {
  const problems = new Problems();
  build(problems);
  return problems.list;
}

// ---------------------------------------------------------------- acceptance cases

function acceptanceEntries(p: Problems, value: unknown, path: string, min: number): string[] {
  const ids: string[] = [];
  p.array(value, path, min).forEach((entry, index) => {
    const at = `${path}[${index}]`;
    const record = p.object(entry, at, ["id", "statement", "requestQuotes"]);
    if (!record) return;
    const id = p.text(record.id, `${at}.id`);
    if (id !== null) ids.push(id);
    p.text(record.statement, `${at}.statement`);
    p.texts(record.requestQuotes, `${at}.requestQuotes`, 1);
  });
  return ids;
}

export const validateCccPlanningAcceptanceCasesV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "acceptance cases", ["schema", "cases", "exclusions"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.acceptanceCases) p.add(`acceptance cases schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.acceptanceCases}`);
  const ids = [...acceptanceEntries(p, root.cases, "cases", 1), ...acceptanceEntries(p, root.exclusions, "exclusions", 0)];
  for (const id of duplicates(ids)) p.add(`acceptance id ${id} is declared more than once`);
});

// ---------------------------------------------------------------- requirement map (ADR B)

export const validateCccPlanningRequirementMapV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "requirement map", ["schema", "requirements", "nonGoals"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.requirementMap) p.add(`requirement map schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.requirementMap}`);
  const requirementIds: string[] = [];
  p.array(root.requirements, "requirements", 1).forEach((entry, index) => {
    const at = `requirements[${index}]`;
    const requirement = p.object(entry, at, ["id", "title", "statement", "proofIds", "clauses"]);
    if (!requirement) return;
    const id = p.text(requirement.id, `${at}.id`);
    if (id !== null) requirementIds.push(id);
    p.text(requirement.title, `${at}.title`);
    p.text(requirement.statement, `${at}.statement`);
    p.proofIds(requirement.proofIds, `${at}.proofIds`, 1); // Taskfile names like every proof id (card K1b, errata E4-K item 5)
    const clauseIds: string[] = [];
    p.array(requirement.clauses, `${at}.clauses`, 1).forEach((clauseEntry, clauseIndex) => {
      const clauseAt = `${at}.clauses[${clauseIndex}]`;
      const clause = p.object(clauseEntry, clauseAt, ["id", "text", "derivation"]);
      if (!clause) return;
      const clauseId = p.text(clause.id, `${clauseAt}.id`);
      if (clauseId !== null) clauseIds.push(clauseId);
      p.text(clause.text, `${clauseAt}.text`);
      const derivationAt = `${clauseAt}.derivation`;
      const derivation = clause.derivation;
      if (derivation === null || typeof derivation !== "object" || Array.isArray(derivation)) {
        p.add(`${derivationAt} must be an object`);
        return;
      }
      const kind = p.oneOf((derivation as Json).kind, `${derivationAt}.kind`, ["request", "annex"] as const);
      if (kind === "request") {
        const request = p.object(derivation, derivationAt, ["kind", "requestQuotes", "acceptanceCaseIds"]);
        if (request) {
          p.texts(request.requestQuotes, `${derivationAt}.requestQuotes`, 1);
          p.texts(request.acceptanceCaseIds, `${derivationAt}.acceptanceCaseIds`, 1);
        }
      } else if (kind === "annex") {
        const annex = p.object(derivation, derivationAt, ["kind", "decisionIds"]);
        if (annex) p.texts(annex.decisionIds, `${derivationAt}.decisionIds`, 1);
      }
    });
    for (const clauseId of duplicates(clauseIds)) p.add(`requirement ${id ?? index} clause id ${clauseId} is declared more than once`);
  });
  for (const id of duplicates(requirementIds)) p.add(`requirement id ${id} is declared more than once`);
  const nonGoalIds: string[] = [];
  p.array(root.nonGoals, "nonGoals").forEach((entry, index) => {
    const at = `nonGoals[${index}]`;
    const nonGoal = p.object(entry, at, ["id", "text", "requestQuotes", "exclusionIds"]);
    if (!nonGoal) return;
    const id = p.text(nonGoal.id, `${at}.id`);
    if (id !== null) nonGoalIds.push(id);
    p.text(nonGoal.text, `${at}.text`);
    p.texts(nonGoal.requestQuotes, `${at}.requestQuotes`, 1);
    p.texts(nonGoal.exclusionIds, `${at}.exclusionIds`);
  });
  for (const id of duplicates(nonGoalIds)) p.add(`non-goal id ${id} is declared more than once`);
});

// ---------------------------------------------------------------- task plan (G4 prerequisite)

type PlanTask = Readonly<{ id: string; deps: string[]; protectedActionIds: string[]; owned: string[]; roots: string[] }>;

function ownedPathList(p: Problems, value: unknown, label: string, min: number): string[] {
  const result: string[] = [];
  p.array(value, `${label}s`, min).forEach((entry) => {
    const normalized = typeof entry === "string" ? normalizeCccPlanningRelativePath(entry) : null;
    if (normalized === null) {
      p.add(`${label} ${JSON.stringify(entry)} must be a relative path inside the worktree`);
      return;
    }
    const forbidden = forbiddenOwnedPathReason(normalized);
    if (forbidden !== null) p.add(`${label} ${JSON.stringify(entry)} ${forbidden}`);
    result.push(normalized);
  });
  return result;
}

export const validateCccPlanningTaskPlanV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "task plan", ["schema", "tasks", "edges", "protectedActions"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.taskPlan) p.add(`task plan schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.taskPlan}`);

  const tasks: PlanTask[] = [];
  const rawTasks = p.array(root.tasks, "tasks");
  if (Array.isArray(root.tasks) && root.tasks.length === 0) p.add("task plan must have at least one task");
  rawTasks.forEach((entry, index) => {
    const at = `tasks[${index}]`;
    const task = p.object(entry, at, ["id", "title", "description", "requirementIds", "dependencyTaskIds", "proofIds",
      "ownedPaths", "allowedWriteRoots", "protectedActionIds"]);
    if (!task) return;
    const id = p.text(task.id, `${at}.id`);
    const name = id ?? at;
    p.text(task.title, `${at}.title`);
    p.text(task.description, `${at}.description`);
    p.texts(task.requirementIds, `${at}.requirementIds`, 1);
    p.proofIds(task.proofIds, `${at}.proofIds`, 1);
    const deps = p.texts(task.dependencyTaskIds, `${at}.dependencyTaskIds`);
    const protectedActionIds = p.texts(task.protectedActionIds, `${at}.protectedActionIds`);
    const owned = ownedPathList(p, task.ownedPaths, `task ${name} owned path`, 1);
    const roots = ownedPathList(p, task.allowedWriteRoots, `task ${name} write root`, 1);
    const ownedByKey = new Map<string, string>();
    for (const path of owned) {
      const key = cccPlanningPathComparisonKey(path);
      const first = ownedByKey.get(key);
      if (first !== undefined) p.add(`task ${name} owns the same path twice: ${first} and ${path}`);
      else ownedByKey.set(key, path);
    }
    if (id !== null) tasks.push({ id, deps, protectedActionIds, owned, roots });
  });

  const taskIds = new Set(tasks.map((task) => task.id));
  for (const id of duplicates(tasks.map((task) => task.id))) p.add(`task id ${id} is declared more than once`);

  const actionIds: string[] = [];
  p.array(root.protectedActions, "protectedActions").forEach((entry, index) => {
    const at = `protectedActions[${index}]`;
    const action = p.object(entry, at, ["id", "kind", "target"]);
    if (!action) return;
    const id = p.text(action.id, `${at}.id`);
    if (id !== null) actionIds.push(id);
    p.oneOf(action.kind, `${at}.kind`, CCC_PRD_PROTECTED_ACTION_KINDS);
    p.text(action.target, `${at}.target`);
  });
  for (const id of duplicates(actionIds)) p.add(`protected action id ${id} is declared more than once`);
  const declaredActions = new Set(actionIds);

  const declaredEdges = new Set<string>();
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) p.add(`task ${task.id} depends on itself`);
      else if (!taskIds.has(dep)) p.add(`task ${task.id} depends on undeclared task ${dep}`);
      declaredEdges.add(`${task.id}\0${dep}`);
    }
    for (const actionId of task.protectedActionIds) {
      if (!declaredActions.has(actionId)) p.add(`task ${task.id} names undeclared protected action ${actionId}`);
    }
    // Containment compares on the ownership key (errata E2-46): `SRC/a.mjs` is inside an owned `src/a.mjs` on the I2 volume.
    const ownedKeys = task.owned.map(cccPlanningPathComparisonKey);
    for (const writeRoot of task.roots) {
      const rootKey = cccPlanningPathComparisonKey(writeRoot);
      if (!ownedKeys.some((owned) => rootKey === owned || rootKey.startsWith(`${owned}/`))) {
        p.add(`task ${task.id} write root ${writeRoot} is outside its owned paths`);
      }
    }
  }

  const edgeIds: string[] = [];
  const seenEdges = new Set<string>();
  p.array(root.edges, "edges").forEach((entry, index) => {
    const at = `edges[${index}]`;
    const edge = p.object(entry, at, ["id", "fromTaskId", "toTaskId", "kind"]);
    if (!edge) return;
    const id = p.text(edge.id, `${at}.id`) ?? at;
    edgeIds.push(id);
    if (edge.kind !== "depends_on") p.add(`edge ${id} kind must be depends_on`);
    const from = p.text(edge.fromTaskId, `${at}.fromTaskId`);
    const to = p.text(edge.toTaskId, `${at}.toTaskId`);
    for (const taskId of [from, to]) if (taskId !== null && !taskIds.has(taskId)) p.add(`edge ${id} names undeclared task ${taskId}`);
    if (from === null || to === null) return;
    const pair = `${from}\0${to}`;
    if (seenEdges.has(pair)) p.add(`edge ${id} repeats ${from} -> ${to}`);
    seenEdges.add(pair);
    if (!declaredEdges.has(pair)) p.add(`edge ${id} ${from} -> ${to} is not in task ${from}'s dependencyTaskIds`);
  });
  for (const id of duplicates(edgeIds)) p.add(`edge id ${id} is declared more than once`);
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!seenEdges.has(`${task.id}\0${dep}`)) p.add(`task ${task.id} depends on ${dep} but no edge declares it`);
    }
  }

  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      const a = tasks[left]!;
      const b = tasks[right]!;
      for (const pathA of a.owned) {
        for (const pathB of b.owned) {
          if (cccPlanningPathsOverlap(pathA, pathB)) p.add(`tasks ${a.id} and ${b.id} own overlapping paths ${pathA} and ${pathB}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- routing plan

export const validateCccPlanningRoutingPlanV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "routing plan", ["schema", "routes"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.routingPlan) p.add(`routing plan schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.routingPlan}`);
  const taskIds: string[] = [];
  p.array(root.routes, "routes", 1).forEach((entry, index) => {
    const at = `routes[${index}]`;
    const route = p.object(entry, at, ["taskId", "providerId", "modelId", "transport"]);
    if (!route) return;
    const taskId = p.text(route.taskId, `${at}.taskId`);
    if (taskId !== null) taskIds.push(taskId);
    p.text(route.providerId, `${at}.providerId`);
    if (typeof route.modelId !== "string") {
      p.add(`${at}.modelId must be a string`);
    } else {
      const identity = classifyCccModelIdentity(route.modelId);
      if (!identity.admitted) p.add(`${at}.modelId ${route.modelId} is not an exact pinned model (${identity.reason})`);
    }
    if (route.transport !== "pi") p.add(`${at}.transport must be pi`);
  });
  for (const id of duplicates(taskIds)) p.add(`route for task ${id} is declared more than once`);
});

// ---------------------------------------------------------------- verifier bundle

const FILE_MODES = ["100644", "100755"] as const;

function canonicalPath(p: Problems, value: unknown, path: string): string | null {
  const normalized = typeof value === "string" ? normalizeCccPlanningRelativePath(value) : null;
  if (normalized === null || normalized !== value) {
    p.add(`${path} ${JSON.stringify(value)} must be a canonical relative path inside the worktree`);
    return null;
  }
  return normalized;
}

/*
FNXC:CccPlanningSchemas 2026-10-14-13:26:
Errata E2-41: verifier bundle files become the baseline commit and a control's files are written over the implementation, so their paths get the owned-path refusals (`.git` segment, `.env` file, denied names), and they are de-duplicated on the comparison key: `Taskfile.yml` and `taskfile.yml` would check out as one file on the I2 volume, so the Taskfile on disk could differ from the blob the custody check reads. A control's files are de-duplicated within that control; two controls may each replace the same implementation file.
*/
function bundleFilePath(p: Problems, value: unknown, path: string): string | null {
  const normalized = canonicalPath(p, value, path);
  if (normalized === null) return null;
  const forbidden = forbiddenOwnedPathReason(normalized);
  if (forbidden !== null) p.add(`${path} ${JSON.stringify(value)} ${forbidden}`);
  return normalized;
}

/** Records `path` under its comparison key; returns the first spelling already recorded there, or null. */
function firstSpelling(byKey: Map<string, string>, path: string): string | null {
  const key = cccPlanningPathComparisonKey(path);
  const first = byKey.get(key);
  if (first !== undefined) return first;
  byKey.set(key, path);
  return null;
}

function samePathProblem(label: string, path: string, first: string): string {
  return first === path ? `${label} ${path} is declared more than once` : `${label} ${path} is the same path as ${first}`;
}

/*
FNXC:CccPlanningSchemas 2026-10-14-15:05:
Card K1b (errata E4-K item 4): a control is written over the baseline to prove the verifier fails a defective implementation, so it may replace an implementation file and never the verifier. This finds the verifier bundle file, if any, whose comparison key equals the control path's key or is a directory prefix of it (`Taskfile.yml/x` lies below `taskfile.yml`), walking the key's ancestors from the full path upward so the nearest match is reported first.
*/
/** The bundle file a control path equals or lies inside, on the comparison key, and which of the two; null when the path is outside the bundle. */
function bundleFileAtOrAbove(bundleKeys: ReadonlyMap<string, string>, path: string): Readonly<{ file: string; inside: boolean }> | null {
  let key = cccPlanningPathComparisonKey(path);
  let inside = false;
  for (;;) {
    const file = bundleKeys.get(key);
    if (file !== undefined) return { file, inside };
    const slash = key.lastIndexOf("/");
    if (slash < 0) return null;
    key = key.slice(0, slash);
    inside = true;
  }
}

export const validateCccPlanningVerifierBundleV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "verifier bundle", ["schema", "files", "proofs", "controls"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.verifierBundle) p.add(`verifier bundle schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.verifierBundle}`);
  const filePaths: string[] = [];
  const fileKeys = new Map<string, string>();
  p.array(root.files, "files", 1).forEach((entry, index) => {
    const at = `files[${index}]`;
    const file = p.object(entry, at, ["path", "mode", "content"]);
    if (!file) return;
    const path = bundleFilePath(p, file.path, `${at}.path`);
    if (path !== null) {
      filePaths.push(path);
      const first = firstSpelling(fileKeys, path);
      if (first !== null) p.add(samePathProblem("verifier file", path, first));
    }
    p.oneOf(file.mode, `${at}.mode`, FILE_MODES);
    if (typeof file.content !== "string") p.add(`${at}.content must be a string`);
  });
  const bundled = new Set(filePaths);
  const proofIds: string[] = [];
  const coveredRequirements = new Set<string>();
  p.array(root.proofs, "proofs", 1).forEach((entry, index) => {
    const at = `proofs[${index}]`;
    const proof = p.object(entry, at, ["id", "requirementIds", "files", "taskfileTask"]);
    if (!proof) return;
    const validId = p.pattern(proof.id, `${at}.id`, CCC_PLANNING_PROOF_ID_PATTERN, PROOF_ID);
    const id = validId ?? at;
    proofIds.push(id);
    if (validId !== null && "taskfileTask" in proof && proof.taskfileTask !== `verify:${validId}`) {
      p.add(`${at}.taskfileTask must be verify:${validId}`);
    }
    for (const requirementId of p.texts(proof.requirementIds, `${at}.requirementIds`, 1)) coveredRequirements.add(requirementId);
    for (const file of p.texts(proof.files, `${at}.files`, 1)) {
      if (!bundled.has(file)) p.add(`proof ${id} names file ${file} that is not in the bundle`);
    }
  });
  for (const id of duplicates(proofIds)) p.add(`proof id ${id} is declared more than once`);
  const controlIds: string[] = [];
  p.array(root.controls, "controls").forEach((entry, index) => {
    const at = `controls[${index}]`;
    const control = p.object(entry, at, ["id", "requirementId", "files"]);
    if (!control) return;
    const id = p.text(control.id, `${at}.id`) ?? at;
    controlIds.push(id);
    const requirementId = p.text(control.requirementId, `${at}.requirementId`);
    if (requirementId !== null && !coveredRequirements.has(requirementId)) {
      p.add(`control ${id} names requirement ${requirementId} that no proof covers`);
    }
    const controlKeys = new Map<string, string>();
    p.array(control.files, `${at}.files`, 1).forEach((fileEntry, fileIndex) => {
      const fileAt = `${at}.files[${fileIndex}]`;
      const file = p.object(fileEntry, fileAt, ["path", "content"]);
      if (!file) return;
      const path = bundleFilePath(p, file.path, `${fileAt}.path`);
      if (path !== null) {
        const first = firstSpelling(controlKeys, path);
        if (first !== null) p.add(samePathProblem(`control ${id} file`, path, first));
        const verifier = bundleFileAtOrAbove(fileKeys, path);
        if (verifier !== null) p.add(`control ${id} file ${path} ${verifier.inside ? "lies inside" : "replaces"} verifier file ${verifier.file}`);
      }
      if (typeof file.content !== "string") p.add(`${fileAt}.content must be a string`);
    });
  });
  for (const id of duplicates(controlIds)) p.add(`control id ${id} is declared more than once`);
});

// ---------------------------------------------------------------- adjudication

export const validateCccPlanningAdjudicationV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "adjudication",
    ["schema", "epoch", "candidate", "reviews", "objections", "blockingFindings", "verdict", "approved"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.adjudication) p.add(`adjudication schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.adjudication}`);
  p.integer(root.epoch, "epoch", 1);
  p.refs(root.candidate, "candidate", 1);
  p.refs(root.reviews, "reviews", 1);
  p.refs(root.objections, "objections");
  const blocking = p.integer(root.blockingFindings, "blockingFindings", 0);
  const verdict = p.oneOf(root.verdict, "verdict", ["approve", "repair", "reject"] as const);
  if (root.approved !== null) {
    const approved = p.object(root.approved, "approved", ["finalPrd", "technicalAnnex", "taskPlan"]);
    if (approved) for (const key of ["finalPrd", "technicalAnnex", "taskPlan"]) p.ref(approved[key], `approved.${key}`);
  }
  if (verdict === "approve") {
    if (blocking !== null && blocking > 0) p.add(`an approve verdict must have no blocking findings, got ${blocking}`);
    if (root.approved === null) p.add("an approve verdict must name the approved finalPrd, technicalAnnex and taskPlan");
  } else if (verdict !== null && root.approved !== null) {
    p.add(`a ${verdict} verdict must have approved null`);
  }
});

// ---------------------------------------------------------------- spec ready (ADR B)

const SPEC_READY_REVIEWED_KEYS = ["originalRequest", "acceptanceCases", "requirementMap", "finalPrd", "technicalAnnex", "taskPlan",
  "routingPlan", "verifierBundle", "oracleAudit", "finalAdjudication"] as const;

function signature(p: Problems, value: unknown, path: string): void {
  const record = p.object(value, path, ["name", "email", "date"]);
  if (!record) return;
  p.text(record.name, `${path}.name`);
  p.text(record.email, `${path}.email`);
  p.text(record.date, `${path}.date`);
}

function emptyDiagnostics(p: Problems, value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length !== 0) p.add(`${path} must be an empty array`);
}

export const validateCccPlanningSpecReadyV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "spec ready", ["schema", "runId", "runRevision", "mode", "target", "closure", "closureDigest",
    "reviewed", "gates", "verifierBaseline", "preparationCompile", "graphAdmission", "spend", "campaignAdmission", "repositoryMutation"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.specReady) p.add(`spec ready schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.specReady}`);
  if (!isCccPlanningRunId(root.runId)) p.add("runId must be a planning run id");
  p.integer(root.runRevision, "runRevision", 1, 999);
  p.oneOf(root.mode, "mode", ["spec", "build"] as const);
  const target = p.object(root.target, "target", ["projectId", "repositoryPath", "admittedBase"]);
  if (target) {
    p.text(target.projectId, "target.projectId");
    p.pattern(target.repositoryPath, "target.repositoryPath", /^\/\S/u, "an absolute path");
    p.pattern(target.admittedBase, "target.admittedBase", GIT_OID, "a git object id");
  }
  p.refs(root.closure, "closure", 1);
  p.pattern(root.closureDigest, "closureDigest", HEX64, "a lowercase sha256");
  const reviewed = p.object(root.reviewed, "reviewed", SPEC_READY_REVIEWED_KEYS);
  if (reviewed) for (const key of SPEC_READY_REVIEWED_KEYS) p.ref(reviewed[key], `reviewed.${key}`);
  const gates: string[] = [];
  p.array(root.gates, "gates", 1).forEach((entry, index) => {
    const at = `gates[${index}]`;
    const gate = p.object(entry, at, ["gate", "verdict", "evidence", "inputClosureDigest"]);
    if (!gate) return;
    const name = p.oneOf(gate.gate, `${at}.gate`, ["G0", "G1", "G2", "G3", "G4", "G5"] as const);
    if (name !== null) gates.push(name);
    if (gate.verdict !== "pass") p.add(`${at}.verdict must be pass`);
    p.refs(gate.evidence, `${at}.evidence`);
    p.pattern(gate.inputClosureDigest, `${at}.inputClosureDigest`, HEX64, "a lowercase sha256");
  });
  for (const gate of duplicates(gates)) p.add(`gate ${gate} is recorded more than once`);
  const baseline = p.object(root.verifierBaseline, "verifierBaseline",
    ["parent", "files", "treeOid", "author", "committer", "message", "predictedCommitOid"]);
  if (baseline) {
    p.pattern(baseline.parent, "verifierBaseline.parent", GIT_OID, "a git object id");
    // Defence in depth (card K1b, errata E4-K item 5): the baseline files are the verifier bundle's files, so they get the same
    // refusals (`.git`, `.env`, denied names) and the same de-duplication on the comparison key (E2-41).
    const baselineKeys = new Map<string, string>();
    p.array(baseline.files, "verifierBaseline.files", 1).forEach((entry, index) => {
      const at = `verifierBaseline.files[${index}]`;
      const file = p.object(entry, at, ["path", "mode", "blobOid", "sha256"]);
      if (!file) return;
      const path = bundleFilePath(p, file.path, `${at}.path`);
      if (path !== null) {
        const first = firstSpelling(baselineKeys, path);
        if (first !== null) p.add(samePathProblem("verifier baseline file", path, first));
      }
      p.oneOf(file.mode, `${at}.mode`, FILE_MODES);
      p.pattern(file.blobOid, `${at}.blobOid`, GIT_OID, "a git object id");
      p.pattern(file.sha256, `${at}.sha256`, HEX64, "a lowercase sha256");
    });
    p.pattern(baseline.treeOid, "verifierBaseline.treeOid", GIT_OID, "a git object id");
    signature(p, baseline.author, "verifierBaseline.author");
    signature(p, baseline.committer, "verifierBaseline.committer");
    p.text(baseline.message, "verifierBaseline.message");
    p.pattern(baseline.predictedCommitOid, "verifierBaseline.predictedCommitOid", GIT_OID, "a git object id");
  }
  const compile = p.object(root.preparationCompile, "preparationCompile",
    ["targetKind", "packetHash", "sidecarHash", "bundleHash", "toolchainDigest", "diagnostics"]);
  if (compile) {
    if (compile.targetKind !== "disposable_clone") p.add("preparationCompile.targetKind must be disposable_clone");
    for (const key of ["packetHash", "sidecarHash", "bundleHash", "toolchainDigest"]) {
      p.pattern(compile[key], `preparationCompile.${key}`, HEX64, "a lowercase sha256");
    }
    emptyDiagnostics(p, compile.diagnostics, "preparationCompile.diagnostics");
  }
  const graph = p.object(root.graphAdmission, "graphAdmission", ["graphDigest", "diagnostics"]);
  if (graph) {
    p.pattern(graph.graphDigest, "graphAdmission.graphDigest", HEX64, "a lowercase sha256");
    emptyDiagnostics(p, graph.diagnostics, "graphAdmission.diagnostics");
  }
  const spend = p.object(root.spend, "spend", ["planningCallsIssued", "planningAllocation", "implementationReserved", "reviewProofReserved"]);
  if (spend) {
    p.integer(spend.planningCallsIssued, "spend.planningCallsIssued", 0);
    p.integer(spend.planningAllocation, "spend.planningAllocation", 0);
    if (spend.implementationReserved !== 0) p.add("spend.implementationReserved must be 0");
    if (spend.reviewProofReserved !== 0) p.add("spend.reviewProofReserved must be 0");
  }
  if (root.campaignAdmission !== "pending") p.add("campaignAdmission must be pending");
  if (root.repositoryMutation !== "none") p.add("repositoryMutation must be none");
});

// ---------------------------------------------------------------- decision request

export const validateCccPlanningDecisionRequestV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "decision request", ["schema", "question", "options", "context"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.decisionRequest) p.add(`decision request schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.decisionRequest}`);
  p.text(root.question, "question");
  p.texts(root.options, "options");
  p.refs(root.context, "context");
});

// ---------------------------------------------------------------- objection (D47)

export const validateCccPlanningObjectionV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "objection", ["stageId", "reviewerRoleId", "severity", "ref", "summary", "reviewedRef"]);
  if (!root) return;
  if (typeof root.stageId !== "string" || !STAGE_IDS.has(root.stageId)) p.add("stageId must be a planning stage id");
  if (typeof root.reviewerRoleId !== "string") {
    p.add("reviewerRoleId must be a role id");
  } else {
    try {
      cccPlanningRole(root.reviewerRoleId as CccPlanningRoleId);
    } catch {
      p.add(`reviewerRoleId ${root.reviewerRoleId} is not a FULL-v2 role`);
    }
  }
  p.oneOf(root.severity, "severity", ["blocking", "advisory"] as const);
  p.findingRef(root.ref, "ref");
  p.text(root.summary, "summary");
  p.ref(root.reviewedRef, "reviewedRef");
});

// ---------------------------------------------------------------- decision record (D47)

export const validateCccPlanningDecisionRecordV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "decision record",
    ["objectionKey", "proposal", "evidence", "objection", "discriminatingObservation", "disposition", "remainingUncertainty"]);
  if (!root) return;
  if (typeof root.objectionKey !== "string" || decodeCccPlanningArtifactKey(root.objectionKey) === null) {
    p.add("objectionKey must be a planning artifact key");
  }
  p.text(root.proposal, "proposal");
  p.array(root.evidence, "evidence").forEach((entry, index) => p.findingRef(entry, `evidence[${index}]`));
  p.text(root.objection, "objection");
  p.text(root.discriminatingObservation, "discriminatingObservation");
  p.oneOf(root.disposition, "disposition", ["accepted", "rejected", "deferred"] as const);
  p.text(root.remainingUncertainty, "remainingUncertainty");
});

// ---------------------------------------------------------------- build transition (D20)

const BASELINE_BRANCH_REF = /^refs\/heads\/fusion\/r2c-[0-9a-f]{24}-r(?!000)[0-9]{3}-baseline$/u;

export const validateCccPlanningBuildTransitionV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "build transition", ["schema", "b0", "predictedCommitOid", "branchRef", "verifierBundle", "specReady"]);
  if (!root) return;
  if (root.schema !== CCC_PLANNING_CONTENT_SCHEMAS.buildTransition) p.add(`build transition schema must be ${CCC_PLANNING_CONTENT_SCHEMAS.buildTransition}`);
  p.pattern(root.b0, "b0", GIT_OID, "a git object id");
  p.pattern(root.predictedCommitOid, "predictedCommitOid", GIT_OID, "a git object id");
  p.pattern(root.branchRef, "branchRef", BASELINE_BRANCH_REF, "a planning baseline branch ref");
  p.ref(root.verifierBundle, "verifierBundle");
  p.ref(root.specReady, "specReady");
});

// ---------------------------------------------------------------- proof results (v3 section 2.17, item 46)

/** Mirrors ATTEMPT_KEY_PATTERN, the int4 exit-code rule and the success-means-exit-0 rule of ccc-campaign/proof-attempt.ts. */
const PROOF_ATTEMPT_KEY = /^ccc-proof-attempt-[0-9a-f]{64}$/u;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export const validateCccPlanningProofResultsV1: CccPlanningContentValidator = (value) => validated((p) => {
  const root = p.object(value, "proof results", ["sourceCommit", "sourceTree", "proofIds", "phase", "results"]);
  if (!root) return;
  p.pattern(root.sourceCommit, "sourceCommit", GIT_OID, "a git object id");
  p.pattern(root.sourceTree, "sourceTree", GIT_OID, "a git object id");
  const proofIds = new Set(p.proofIds(root.proofIds, "proofIds", 1));
  p.oneOf(root.phase, "phase", ["task", "final_integrated"] as const);
  const resulted: string[] = [];
  p.array(root.results, "results", 1).forEach((entry, index) => {
    const at = `results[${index}]`;
    const result = p.object(entry, at, ["proofId", "attemptKey", "state", "resultSuccess", "exitCode", "durationMs",
      "stdoutSha256", "stderrSha256", "terminalEnvelopeSha256"]);
    if (!result) return;
    const proofId = p.pattern(result.proofId, `${at}.proofId`, CCC_PLANNING_PROOF_ID_PATTERN, PROOF_ID);
    if (proofId !== null) {
      resulted.push(proofId);
      if (!proofIds.has(proofId)) p.add(`result for proof ${proofId} is not in proofIds`);
    }
    p.pattern(result.attemptKey, `${at}.attemptKey`, PROOF_ATTEMPT_KEY, "a proof attempt key");
    const state = p.oneOf(result.state, `${at}.state`, ["committed", "proved_failed"] as const);
    if (typeof result.resultSuccess !== "boolean") {
      p.add(`${at}.resultSuccess must be a boolean`);
    } else if (state !== null && result.resultSuccess !== (state === "committed")) {
      p.add(`${at} state ${state} needs resultSuccess ${String(state === "committed")}`);
    }
    if (result.exitCode !== null) p.integer(result.exitCode, `${at}.exitCode`, INT4_MIN, INT4_MAX);
    // The store refuses a successful result unless its exit code is 0 (proof-attempt.ts prepareTerminalResult), and only a
    // successful result settles committed; a failed one may carry any int4 exit code or none (errata E2-43).
    if (state === "committed" && result.exitCode !== 0) p.add(`${at} state committed needs exitCode 0, as the proof-attempt store requires`);
    p.integer(result.durationMs, `${at}.durationMs`, 0);
    for (const key of ["stdoutSha256", "stderrSha256", "terminalEnvelopeSha256"] as const) {
      p.pattern(result[key], `${at}.${key}`, HEX64, "a lowercase sha256");
    }
  });
  for (const id of duplicates(resulted)) p.add(`proof ${id} has more than one result`);
  const covered = new Set(resulted);
  for (const id of proofIds) if (!covered.has(id)) p.add(`proof ${id} has no result`);
});

export const CCC_PLANNING_CONTENT_VALIDATORS: Readonly<Record<string, CccPlanningContentValidator>> = Object.freeze({
  [CCC_PLANNING_CONTENT_SCHEMAS.acceptanceCases]: validateCccPlanningAcceptanceCasesV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.requirementMap]: validateCccPlanningRequirementMapV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.taskPlan]: validateCccPlanningTaskPlanV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.routingPlan]: validateCccPlanningRoutingPlanV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.verifierBundle]: validateCccPlanningVerifierBundleV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.adjudication]: validateCccPlanningAdjudicationV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.specReady]: validateCccPlanningSpecReadyV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.decisionRequest]: validateCccPlanningDecisionRequestV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.objection]: validateCccPlanningObjectionV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.decisionRecord]: validateCccPlanningDecisionRecordV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.buildTransition]: validateCccPlanningBuildTransitionV1,
  [CCC_PLANNING_CONTENT_SCHEMAS.proofResults]: validateCccPlanningProofResultsV1,
});
