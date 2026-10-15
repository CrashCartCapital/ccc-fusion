import { join } from "node:path";
import {
  CCC_PRD_PROTECTED_ACTION_KINDS,
  CccPlanningRefusal,
  isCccPlanningRunId,
  normalizeCccPlanningTaskPlanV1,
  validateCccPlanningRequirementMapV1,
  validateCccPlanningTaskPlanV1,
  validateCccPlanningVerifierBundleV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAdmittedWriteRoot,
  type CccPrdExecutionBounds,
  type CccPrdProtectedActionKind,
  type CccPrdTargetRepository,
} from "@fusion/core";
import { writeCccPrdPacketFiles } from "../ccc-prd/intake.js";

/*
FNXC:CccPlanningPacket 2026-10-14-19:20:
Card IB1 (CONTRACT-v3.3 section 2.17, ADR B Q2): the four authoritative packet sources of a request-to-code run and the controller-written lines every quote in the authoring proposal points at. The original request is the operator's bytes, untouched. The other three are rendered here from reviewed artifacts: the admission facts (the labelled lines the implementation-fact binder reads), the final PRD (the V2 acceptance grammar plus one proof block per verifier proof) and the technical annex (one decision, one custody block and the protected actions per task). Model text is collapsed to a single line and every fixed word, id and label is controller text, so a model can never open a heading, a clause or a label of its own. The line shapes live in `CCC_PLANNING_LINES` and nowhere else: `proposal.ts` imports them, so the quote it cites and the line this file writes cannot drift apart.
FNXC:CccPlanningPacket 2026-10-14-19:21:
The admission facts carry no heading on purpose. A heading with a body is a material-coverage item, and nothing in the plan owns the operator's facts, so the compiler would later refuse the packet as uncovered material. Labelled bullet lines under plain text are not material items and the binder reads them all the same. Target path, baseline commit and bounds are written only here: the PRD and the annex never repeat them.
FNXC:CccPlanningPacket 2026-10-14-19:22:
Every refusal here is `CCC_PLANNING_GRAPH_INADMISSIBLE`: a plan, map or bundle the packet cannot carry exactly. K1's validators run first, so the packet never renders something K1 itself would refuse. The id and path rules below are the packet grammar's own: the acceptance grammar's canonical id, the token-bounded path rule the task-custody check applies, and single-line values for anything the fact binder compares to a whole line.
*/

export const CCC_PLANNING_PACKET_SOURCES = {
  originalRequest: { projectRelativePath: "__fusion__/planning/original-request.md", role: "original_request" },
  admissionFacts: { projectRelativePath: "__fusion__/planning/admission-facts.md", role: "support" },
  finalPrd: { projectRelativePath: "__fusion__/planning/final-prd.md", role: "prd" },
  technicalAnnex: { projectRelativePath: "__fusion__/planning/technical-annex.md", role: "technical_annex" },
} as const;

export type CccPlanningPacketSourceKey = keyof typeof CCC_PLANNING_PACKET_SOURCES;

/** The packet-relative path a source reference or a span uses (`sources/` plus the project-relative path). */
export function cccPlanningPacketSourcePath(key: CccPlanningPacketSourceKey): string {
  return `sources/${CCC_PLANNING_PACKET_SOURCES[key].projectRelativePath}`;
}

export type CccPlanningAdmissionFacts = Readonly<{
  targetRepository: CccPrdTargetRepository;
  admittedWriteRoots: readonly CccPrdAdmittedWriteRoot[];
  bounds: CccPrdExecutionBounds;
  protectedActions: readonly Readonly<{ id: string; kind: CccPrdProtectedActionKind; target: string }>[];
}>;

export type CccPlanningPacketSources = Readonly<{
  originalRequest: Buffer;
  admissionFacts: Buffer;
  finalPrd: Buffer;
  technicalAnnex: Buffer;
}>;

// ---------------------------------------------------------------- the line shapes

export const CCC_PLANNING_ACCEPTANCE_CLAUSES_HEADING = "#### Acceptance clauses";

export const CCC_PLANNING_LINES = Object.freeze({
  // admission facts: the labels `computeCccPrdImplementationFactProvenance` reads
  targetRepository: (path: string) => `- Target repository: ${path}`,
  baselineCommit: (oid: string) => `- Baseline commit: ${oid}`,
  maxRequests: (value: number) => `- Max requests: ${value}`,
  maxDurationMs: (value: number) => `- Max duration ms: ${value}`,
  maxConcurrency: (value: number) => `- Max concurrency: ${value}`,
  admittedWriteRoot: (path: string) => `- Allowed write root: ${path}`,
  admittedWriteRootPurpose: (purpose: string) => `- Allowed write root purpose: ${purpose}`,
  protectedAction: (id: string, kind: string, target: string) => `- Protected action ${id}: ${kind} ${target}`,
  // final PRD: the V2 acceptance grammar and one proof block per verifier proof
  requirementHeading: (id: string) => `### Requirement ${id}`,
  requirementStatement: (text: string) => `Requirement statement: ${text}`,
  clause: (id: string, text: string) => `- [${id}] ${text}`,
  proofHeading: (id: string) => `### Proof ${id}`,
  proofCommand: (id: string, command: string) => `- Proof ${id} command: ${command}`,
  proofOracle: (id: string, text: string) => `- Proof ${id} positive oracle: ${text}`,
  proofControl: (id: string, controlId: string, text: string) => `- Proof ${id} negative control ${controlId}: ${text}`,
  nonGoal: (text: string) => `- Non-goal: ${text}`,
  // technical annex
  decision: (taskId: string, text: string) => `- [DEC-${taskId}] ${text}`,
  taskHeading: (taskId: string) => `## Task ${taskId}`,
  taskField: (taskId: string, field: string, value: string) => `- Task ${taskId} ${field}: ${value}`,
  ownedPath: (taskId: string, path: string) => `- Task ${taskId} owned path: \`${path}\``,
  writeRoot: (taskId: string, path: string) => `- Task ${taskId} write root: \`${path}\``,
});

// ---------------------------------------------------------------- refusals and text rules

export function cccPlanningGraphRefusal(detail: string, field?: string): never {
  throw new CccPlanningRefusal("CCC_PLANNING_GRAPH_INADMISSIBLE", detail, field);
}

/** Why a problem list refuses a whole artifact: the first four problems, then a count. */
export function cccPlanningRefuseProblems(subject: string, problems: readonly string[]): void {
  if (problems.length === 0) return;
  const more = problems.length > 4 ? ` (+${problems.length - 4} more)` : "";
  cccPlanningGraphRefusal(`${subject} is not admissible: ${problems.slice(0, 4).join("; ")}${more}`);
}

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const LONG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const CLAUSE_ID = /^AC-[A-Za-z0-9][A-Za-z0-9._:-]{0,188}$/u;
const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Anything that could end or bend a line: a C0 or C1 control character, DEL, or a Unicode line or paragraph separator. */
function hasLineBreakingCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Model text as one trimmed line; empty text and control characters are refused. */
export function cccPlanningOneLine(text: unknown, field: string): string {
  if (typeof text !== "string") return cccPlanningGraphRefusal(`${field} must be text`, field);
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return cccPlanningGraphRefusal(`${field} is empty`, field);
  if (hasLineBreakingCharacter(collapsed)) return cccPlanningGraphRefusal(`${field} carries a control character`, field);
  return collapsed;
}

/** A value the binder or the custody check compares to a whole line: kept verbatim, so it must already be one clean line. */
export function cccPlanningExactLine(value: unknown, field: string, options: Readonly<{ noBacktick?: boolean }> = {}): string {
  if (typeof value !== "string" || value.length === 0) return cccPlanningGraphRefusal(`${field} must be non-empty text`, field);
  if (value !== value.trim()) return cccPlanningGraphRefusal(`${field} has leading or trailing whitespace`, field);
  if (hasLineBreakingCharacter(value)) return cccPlanningGraphRefusal(`${field} carries a newline or control character`, field);
  if (options.noBacktick === true && value.includes("`")) return cccPlanningGraphRefusal(`${field} carries a backtick`, field);
  return value;
}

function canonicalId(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    return cccPlanningGraphRefusal(`${field} ${JSON.stringify(value)} is not a canonical id`, field);
  }
  return value;
}

// ---------------------------------------------------------------- the requirement model (final PRD)

type RequirementMapRequirement = CccPlanningRequirementMapV1["requirements"][number];
export type CccPlanningClauseDerivation = RequirementMapRequirement["clauses"][number]["derivation"];

export type CccPlanningClauseView = Readonly<{
  /** The full clause id as the PRD writes it: `AC-<requirement id>-<suffix>`. */
  id: string;
  requirementId: string;
  text: string;
  derivation: CccPlanningClauseDerivation;
}>;
export type CccPlanningRequirementView = Readonly<{
  id: string;
  statement: string;
  proofIds: readonly string[];
  clauses: readonly CccPlanningClauseView[];
}>;
export type CccPlanningProofView = Readonly<{
  id: string;
  taskfileTask: string;
  command: string;
  requirementIds: readonly string[];
  /** The bundle files this proof names, in the order the bundle lists them. */
  files: readonly string[];
  oracle: string;
  controls: readonly Readonly<{ id: string; text: string }>[];
}>;
export type CccPlanningNonGoalView = Readonly<{ id: string; text: string; requestQuotes: readonly string[] }>;
export type CccPlanningRequirementModel = Readonly<{
  requirements: readonly CccPlanningRequirementView[];
  proofs: readonly CccPlanningProofView[];
  nonGoals: readonly CccPlanningNonGoalView[];
}>;

function fullClauseId(requirementId: string, clauseId: string): string {
  const prefix = `AC-${requirementId}-`;
  const id = clauseId.startsWith(prefix) ? clauseId : `${prefix}${clauseId}`;
  const suffix = id.slice(prefix.length);
  if (!CLAUSE_ID.test(id) || !LONG_ID.test(suffix)) {
    return cccPlanningGraphRefusal(`clause id ${JSON.stringify(clauseId)} of requirement ${requirementId} cannot be carried by the acceptance grammar`, "clauses.id");
  }
  return id;
}

/**
 * Validates the requirement map and the verifier bundle together and derives everything the final PRD says about them.
 * Refuses a requirement id the acceptance grammar cannot carry, a requirement and a proof that do not name each other,
 * and clause text that is not unique (a clause is quoted by its text, so two equal texts could not be told apart).
 */
export function deriveCccPlanningRequirementModel(
  requirementMap: CccPlanningRequirementMapV1,
  verifierBundle: CccPlanningVerifierBundleV1,
): CccPlanningRequirementModel {
  cccPlanningRefuseProblems("requirement map", validateCccPlanningRequirementMapV1(requirementMap));
  cccPlanningRefuseProblems("verifier bundle", validateCccPlanningVerifierBundleV1(verifierBundle));

  const clauseIds = new Set<string>();
  const clauseTexts = new Set<string>();
  const requirements = requirementMap.requirements.map((requirement): CccPlanningRequirementView => {
    const id = canonicalId(requirement.id, "requirement id", LONG_ID);
    if (id.startsWith("AC-")) {
      return cccPlanningGraphRefusal(`requirement id ${id} starts with AC-, which the acceptance grammar reserves for clauses`, "requirements.id");
    }
    const clauses = requirement.clauses.map((clause): CccPlanningClauseView => {
      const clauseId = fullClauseId(id, clause.id);
      if (clauseIds.has(clauseId)) return cccPlanningGraphRefusal(`clause id ${clauseId} is declared more than once`, "clauses.id");
      clauseIds.add(clauseId);
      const text = cccPlanningOneLine(clause.text, `clause ${clauseId} text`);
      if (clauseTexts.has(text)) {
        return cccPlanningGraphRefusal(`clause ${clauseId} repeats the text of another clause; a clause is quoted by its text, so it must be unique`, "clauses.text");
      }
      clauseTexts.add(text);
      return { id: clauseId, requirementId: id, text, derivation: clause.derivation };
    });
    return { id, statement: cccPlanningOneLine(requirement.statement, `requirement ${id} statement`), proofIds: [...requirement.proofIds], clauses };
  });
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement] as const));

  for (const file of verifierBundle.files) cccPlanningExactLine(file.path, "verifier file path");
  for (const control of verifierBundle.controls) {
    canonicalId(control.id, "control id", SHORT_ID);
    for (const file of control.files) cccPlanningExactLine(file.path, `control ${control.id} file path`);
  }
  const proofs = verifierBundle.proofs.map((proof): CccPlanningProofView => {
    const command = `task ${proof.taskfileTask}`;
    const requirementIds = [...proof.requirementIds];
    const matching = verifierBundle.controls.filter((control) => requirementIds.includes(control.requirementId));
    const controls = matching.length > 0
      ? matching.map((control) => ({
          id: control.id,
          text: `Control ${control.id} replaces ${control.files.map((file) => file.path).join(", ")} and ${command} must fail.`,
        }))
      : [{ id: "baseline", text: `On the unmodified baseline ${command} must fail.` }];
    return {
      id: proof.id, taskfileTask: proof.taskfileTask, command, requirementIds, files: [...proof.files],
      oracle: `Running ${command} on the candidate exits 0 for ${requirementIds.join(", ")}.`, controls,
    };
  });
  const proofById = new Map(proofs.map((proof) => [proof.id, proof] as const));

  for (const requirement of requirements) {
    for (const proofId of requirement.proofIds) {
      const proof = proofById.get(proofId);
      if (proof === undefined) {
        return cccPlanningGraphRefusal(`requirement ${requirement.id} names proof ${proofId}, which the verifier bundle does not declare`, "proofs");
      }
      if (!proof.requirementIds.includes(requirement.id)) {
        return cccPlanningGraphRefusal(`requirement ${requirement.id} names proof ${proofId}, but that proof does not name the requirement back`, "proofs");
      }
    }
  }
  for (const proof of proofs) {
    for (const requirementId of proof.requirementIds) {
      const requirement = requirementById.get(requirementId);
      if (requirement === undefined) {
        return cccPlanningGraphRefusal(`proof ${proof.id} names requirement ${requirementId}, which the requirement map does not declare`, "proofs");
      }
      if (!requirement.proofIds.includes(proof.id)) {
        return cccPlanningGraphRefusal(`proof ${proof.id} names requirement ${requirementId}, but that requirement does not name the proof back`, "proofs");
      }
    }
  }

  const nonGoals = requirementMap.nonGoals.map((nonGoal): CccPlanningNonGoalView => ({
    id: nonGoal.id, text: cccPlanningOneLine(nonGoal.text, `non-goal ${nonGoal.id} text`), requestQuotes: [...nonGoal.requestQuotes],
  }));
  return { requirements, proofs, nonGoals };
}

// ---------------------------------------------------------------- the task model (technical annex)

export type CccPlanningTaskView = Readonly<{
  id: string;
  title: string;
  description: string;
  requirementIds: readonly string[];
  dependencyTaskIds: readonly string[];
  proofIds: readonly string[];
  ownedPaths: readonly string[];
  allowedWriteRoots: readonly string[];
  protectedActionIds: readonly string[];
  /** `DEC-<task id>`: the annex decision line that attributes this task. */
  decisionId: string;
  decisionText: string;
}>;
export type CccPlanningTaskModel = Readonly<{
  tasks: readonly CccPlanningTaskView[];
  edges: CccPlanningTaskPlanV1["edges"];
  protectedActions: CccPlanningTaskPlanV1["protectedActions"];
}>;

/**
 * Validates the task plan, writes its paths in canonical form and derives the lines the annex says about each task.
 * A path is written between backticks, so it must be one clean line without a backtick.
 */
export function deriveCccPlanningTaskModel(taskPlan: CccPlanningTaskPlanV1): CccPlanningTaskModel {
  cccPlanningRefuseProblems("task plan", validateCccPlanningTaskPlanV1(taskPlan));
  const plan = normalizeCccPlanningTaskPlanV1(taskPlan);
  const tasks = plan.tasks.map((task): CccPlanningTaskView => {
    const id = canonicalId(task.id, "task id", SHORT_ID);
    const ownedPaths = task.ownedPaths.map((path) => cccPlanningExactLine(path, `task ${id} owned path`, { noBacktick: true }));
    const allowedWriteRoots = task.allowedWriteRoots.map((path) => cccPlanningExactLine(path, `task ${id} write root`, { noBacktick: true }));
    for (const requirementId of task.requirementIds) canonicalId(requirementId, `task ${id} requirement id`, LONG_ID);
    for (const actionId of task.protectedActionIds) canonicalId(actionId, `task ${id} protected action id`, SHORT_ID);
    for (const dependencyId of task.dependencyTaskIds) canonicalId(dependencyId, `task ${id} dependency id`, SHORT_ID);
    return {
      id,
      title: cccPlanningOneLine(task.title, `task ${id} title`),
      description: cccPlanningOneLine(task.description, `task ${id} description`),
      requirementIds: [...task.requirementIds], dependencyTaskIds: [...task.dependencyTaskIds], proofIds: [...task.proofIds],
      ownedPaths, allowedWriteRoots, protectedActionIds: [...task.protectedActionIds],
      decisionId: `DEC-${id}`,
      decisionText: `Task ${id} delivers ${task.requirementIds.join(", ")} and is proven by ${task.proofIds.join(", ")}.`,
    };
  });
  const protectedActions = plan.protectedActions.map((action) => ({
    id: canonicalId(action.id, "protected action id", SHORT_ID),
    kind: action.kind,
    target: cccPlanningExactLine(action.target, `protected action ${action.id} target`),
  }));
  return { tasks, edges: plan.edges, protectedActions };
}

// ---------------------------------------------------------------- the three renderers

function toBuffer(lines: readonly string[]): Buffer {
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return cccPlanningGraphRefusal(`${field} must be a positive whole number`, field);
  }
  return value;
}

export function renderCccPlanningAdmissionFacts(facts: CccPlanningAdmissionFacts): Buffer {
  const L = CCC_PLANNING_LINES;
  const baseCommit = cccPlanningExactLine(facts.targetRepository.baseCommit, "baseline commit");
  if (!GIT_OID.test(baseCommit)) return cccPlanningGraphRefusal(`baseline commit ${baseCommit} is not a full git object id`, "baseCommit");
  const lines = [
    "Admission facts for this planning run.",
    "",
    L.targetRepository(cccPlanningExactLine(facts.targetRepository.path, "target repository path")),
    L.baselineCommit(baseCommit),
    L.maxRequests(positiveInteger(facts.bounds.maxRequests, "maxRequests")),
    L.maxDurationMs(positiveInteger(facts.bounds.maxDurationMs, "maxDurationMs")),
    L.maxConcurrency(positiveInteger(facts.bounds.maxConcurrency, "maxConcurrency")),
  ];
  const rootPaths = new Set<string>();
  for (const root of facts.admittedWriteRoots) {
    const path = cccPlanningExactLine(root.path, "allowed write root");
    if (rootPaths.has(path)) return cccPlanningGraphRefusal(`allowed write root ${path} is listed more than once`, "admittedWriteRoots");
    rootPaths.add(path);
    lines.push(L.admittedWriteRoot(path), L.admittedWriteRootPurpose(cccPlanningExactLine(root.purpose, `allowed write root purpose of ${path}`)));
  }
  const actionIds = new Set<string>();
  for (const action of facts.protectedActions) {
    const id = canonicalId(action.id, "protected action id", SHORT_ID);
    if (actionIds.has(id)) return cccPlanningGraphRefusal(`protected action ${id} is listed more than once`, "protectedActions");
    actionIds.add(id);
    if (!CCC_PRD_PROTECTED_ACTION_KINDS.includes(action.kind)) {
      return cccPlanningGraphRefusal(`protected action ${id} has the unknown kind ${JSON.stringify(action.kind)}`, "protectedActions");
    }
    lines.push(L.protectedAction(id, action.kind, cccPlanningExactLine(action.target, `protected action ${id} target`)));
  }
  return toBuffer(lines);
}

export function renderCccPlanningFinalPrd(input: Readonly<{
  requirementMap: CccPlanningRequirementMapV1;
  verifierBundle: CccPlanningVerifierBundleV1;
}>): Buffer {
  const L = CCC_PLANNING_LINES;
  const model = deriveCccPlanningRequirementModel(input.requirementMap, input.verifierBundle);
  const lines = ["# Product requirements", "", "## Requirements", ""];
  for (const requirement of model.requirements) {
    lines.push(L.requirementHeading(requirement.id), "", L.requirementStatement(requirement.statement), "", CCC_PLANNING_ACCEPTANCE_CLAUSES_HEADING, "");
    for (const clause of requirement.clauses) lines.push(L.clause(clause.id, clause.text));
    lines.push("");
  }
  lines.push("## Proof declarations", "");
  for (const proof of model.proofs) {
    lines.push(L.proofHeading(proof.id), "", L.proofCommand(proof.id, proof.command), L.proofOracle(proof.id, proof.oracle));
    for (const control of proof.controls) lines.push(L.proofControl(proof.id, control.id, control.text));
    lines.push("");
  }
  if (model.nonGoals.length > 0) {
    lines.push("## Non-goals", "");
    for (const nonGoal of model.nonGoals) lines.push(L.nonGoal(nonGoal.text));
    lines.push("");
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

export function renderCccPlanningTechnicalAnnex(input: Readonly<{ taskPlan: CccPlanningTaskPlanV1 }>): Buffer {
  const L = CCC_PLANNING_LINES;
  const model = deriveCccPlanningTaskModel(input.taskPlan);
  const lines = ["# Technical annex", "", "## Engineering decisions", ""];
  for (const task of model.tasks) lines.push(L.decision(task.id, task.decisionText));
  lines.push("");
  for (const task of model.tasks) {
    lines.push(
      L.taskHeading(task.id), "",
      L.taskField(task.id, "title", task.title),
      L.taskField(task.id, "description", task.description),
      L.taskField(task.id, "requirements", task.requirementIds.join(", ")),
      L.taskField(task.id, "depends on", task.dependencyTaskIds.length === 0 ? "none" : task.dependencyTaskIds.join(", ")),
      L.taskField(task.id, "proofs", task.proofIds.join(", ")),
    );
    for (const path of task.ownedPaths) lines.push(L.ownedPath(task.id, path));
    for (const path of task.allowedWriteRoots) lines.push(L.writeRoot(task.id, path));
    lines.push("");
  }
  if (model.protectedActions.length > 0) {
    lines.push("## Protected actions", "");
    for (const action of model.protectedActions) lines.push(L.protectedAction(action.id, action.kind, action.target));
    lines.push("");
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------- the packet

/** The source version, and the adapter id, of one revision of one run: the profile, the run and the revision. */
export function cccPlanningSourceVersion(runId: string, runRevision: number): string {
  return `ccc-planning.full-v2:${runId}:r${runRevision}`;
}

/** Throws the typed refusal for a run id or a revision that cannot name an artifact key. */
export function assertCccPlanningRunRevision(runId: unknown, runRevision: unknown): asserts runId is string {
  if (!isCccPlanningRunId(runId)) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", `run id ${JSON.stringify(runId)} is not a planning run id`, "runId");
  }
  if (typeof runRevision !== "number" || !Number.isSafeInteger(runRevision) || runRevision < 1 || runRevision > 999) {
    throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", `run revision ${String(runRevision)} must be a whole number from 1 to 999`, "runRevision");
  }
}

/**
 * Writes the four sources as one packet under `scratchRoot`, in a directory named for the run and the revision.
 * The packet writer refuses a directory that already exists, so one revision of one run can never be written twice.
 */
export async function materializeCccPlanningPacket(input: Readonly<{
  scratchRoot: string;
  runId: string;
  runRevision: number;
  sources: CccPlanningPacketSources;
}>): Promise<Readonly<{ rootDir: string; manifestPath: string; packetHash: string }>> {
  assertCccPlanningRunRevision(input.runId, input.runRevision);
  const written = writeCccPrdPacketFiles({
    outputDir: join(input.scratchRoot, `${input.runId.replace(":", "-")}-r${String(input.runRevision).padStart(3, "0")}`),
    sourceVersion: cccPlanningSourceVersion(input.runId, input.runRevision),
    sources: (Object.keys(CCC_PLANNING_PACKET_SOURCES) as CccPlanningPacketSourceKey[]).map((key) => ({
      projectRelativePath: CCC_PLANNING_PACKET_SOURCES[key].projectRelativePath,
      bytes: input.sources[key], role: CCC_PLANNING_PACKET_SOURCES[key].role, authoritative: true,
    })),
  });
  return { rootDir: written.rootDir, manifestPath: written.manifestPath, packetHash: written.packetHash };
}
