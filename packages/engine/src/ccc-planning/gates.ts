import { createHash } from "node:crypto";
import {
  CCC_PLANNING_BUDGET_POLICY_V1,
  createCccPrdSpanFromBytes,
  validateCccPlanningAcceptanceCasesV1,
  validateCccPlanningRequirementMapV1,
  validateCccPlanningTaskPlanV1,
  validateCccPlanningVerifierBundleV1,
  type CccPlanningAcceptanceCasesV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAuthoringProposalV2,
  type CccPrdDiagnostic,
  type CccPrdRequirement,
  type CccPrdSourceReferenceProposal,
  type CccPrdSourceSpan,
  type CccPrdTask,
  type CccPrdUnresolvedDecision,
} from "@fusion/core";
import { validateTaskCustodyProvenance } from "../ccc-prd/authoring.js";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";
import {
  diagnoseCccPlanningImportEntityIds,
  diagnoseCccPlanningImportShape,
  diagnoseCccPlanningProofGraph,
  diagnoseCccPlanningTaskPlanGraph,
} from "./graph-gate.js";
import { CCC_PLANNING_PACKET_SOURCES, cccPlanningPacketSourcePath, type CccPlanningPacketSourceKey } from "./packet.js";
import { checkCccPlanningProofCommands, type CccPlanningProofDefinition } from "./proof-command-policy.js";
import { simulateCccPlanningSchedule, type CccPlanningSchedulePolicy } from "./schedule-simulation.js";
import { checkCccPlanningSourceFidelity } from "./source-fidelity.js";

/*
FNXC:CccPlanningG4 2026-10-14-18:58:
Card GG, G4 (D19, ADR B Q3, T3.2 and T3.3, verify-v2 item 41). G4 is pure and deterministic and runs before any review is reserved, so a plan the compiler, the importer or the custody check would refuse costs no review spend. It runs, in layers, the checks section 2.17 names: the four content schemas; then the graph (the compiler's own product-graph admission, through B2, plus the importer's merge-landing rule), the importer's write-root and bounds admission on the proposal, and the agreement of the proposal with the reviewed task plan; then source-reference resolution and custody provenance; and last material coverage, source fidelity, the schedule simulation and the proof-command policy. A layer that fails ends G4 with its own diagnostics, because every later layer reads what it establishes: a proposal that is not the reviewed plan, or a task whose source evidence does not resolve, would only produce secondary diagnostics that hide the real refusal.
FNXC:CccPlanningG4 2026-10-14-18:58:
The frozen signature takes only the task plan, the proposal, the four sources, the acceptance cases and the requirement map, which cannot reach the request anchor, the proof commands or the schedule. G4's input therefore also carries the request artifact's digest (the anchor G1 recorded), the verifier bundle (the proof-command policy's other operand) and an optional schedule policy (defaulting to K1's budget policy estimates). The packet's request digest is the SHA-256 of `sources.originalRequest`, the bytes B4 wrote to the packet. Material coverage mirrors the compiler (`compiler.ts:2085-2170`): the same analysis over the same four packet sources, and the same codes for conflicts, undispositioned sections and requirements, and an implausibly shallow extraction; the compiler's comparison against a sidecar's declared coverage has no counterpart here because G4 runs before any sidecar exists. Acceptance-clause reconciliation stays with the compile at preparation (IB1), not G4.
FNXC:CccPlanningG4 2026-10-14-23:14:
Errata E12 items 2 to 4 and 7 (card GGz). The shape layer also runs the importer's entity-id admission over the plan's and the proposal's ids and the importer's semantic proof plan over the proposal (both in graph-gate.ts), so a plan G4 admits is not refused by `assertCccPrdImportBundle` or `semanticV2WorkflowProofPlan` after review. The source paths are derived from IB1's `CCC_PLANNING_PACKET_SOURCES` through `cccPlanningPacketSourcePath` (packet.ts:29-41), under the same exported name, so the paths G4 resolves quotes against are the paths IB1 writes and cites; the parity test pins the two key by key.
*/

export const CCC_PLANNING_G4_SOURCE_PATHS: Readonly<Record<CccPlanningPacketSourceKey, string>> = Object.freeze(Object.fromEntries(
  (Object.keys(CCC_PLANNING_PACKET_SOURCES) as CccPlanningPacketSourceKey[]).map((key) => [key, cccPlanningPacketSourcePath(key)]),
) as Record<CccPlanningPacketSourceKey, string>);

export type CccPlanningG4Sources = Readonly<{
  originalRequest: Buffer; admissionFacts: Buffer; finalPrd: Buffer; technicalAnnex: Buffer;
}>;

export type CccPlanningG4Input = Readonly<{
  taskPlan: CccPlanningTaskPlanV1;
  proposal: CccPrdAuthoringProposalV2;
  sources: CccPlanningG4Sources;
  acceptanceCases: CccPlanningAcceptanceCasesV1;
  requirementMap: CccPlanningRequirementMapV1;
  /** The SHA-256 G1 recorded for the request artifact (the anchor). */
  requestArtifactDigest: string;
  verifierBundle: CccPlanningVerifierBundleV1;
  policy?: CccPlanningSchedulePolicy;
}>;

function inadmissible(message: string): CccPrdDiagnostic {
  return { code: "CCC_PLANNING_GRAPH_INADMISSIBLE", message };
}

function schemaDiagnostics(i: CccPlanningG4Input): CccPrdDiagnostic[] {
  return [
    ...validateCccPlanningTaskPlanV1(i.taskPlan).map((problem) => inadmissible(`task plan: ${problem}`)),
    ...validateCccPlanningRequirementMapV1(i.requirementMap).map((problem) => inadmissible(`requirement map: ${problem}`)),
    ...validateCccPlanningAcceptanceCasesV1(i.acceptanceCases).map((problem) => inadmissible(`acceptance cases: ${problem}`)),
    ...validateCccPlanningVerifierBundleV1(i.verifierBundle).map((problem) => inadmissible(`verifier bundle: ${problem}`)),
  ];
}

function sorted(values: readonly string[] | undefined): string {
  return JSON.stringify([...(values ?? [])].sort());
}

/** The proposal IB1 built must carry exactly the reviewed plan's tasks, custody, dependencies, proofs and actions. */
function agreementDiagnostics(taskPlan: CccPlanningTaskPlanV1, proposal: CccPrdAuthoringProposalV2, requirementMap: CccPlanningRequirementMapV1): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const planIds = taskPlan.tasks.map(({ id }) => id);
  const proposalTasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
  const proposalIds = proposalTasks.map(({ id }) => id);
  if (sorted(planIds) !== sorted(proposalIds)) {
    diagnostics.push(inadmissible(`proposal tasks ${proposalIds.join(", ") || "none"} differ from the task plan's tasks ${planIds.join(", ")}`));
  }
  const byId = new Map(proposalTasks.map((task) => [task.id, task]));
  const fields = ["requirementIds", "dependencyTaskIds", "proofIds", "ownedPaths", "allowedWriteRoots", "protectedActionIds"] as const;
  for (const planned of taskPlan.tasks) {
    const proposed = byId.get(planned.id);
    if (!proposed) continue;
    for (const field of fields) {
      const want = planned[field];
      const got = proposed[field] as readonly string[] | undefined;
      if (sorted(want) !== sorted(got)) {
        diagnostics.push(inadmissible(`proposal task ${planned.id} ${field} ${sorted(got)} differ from task ${planned.id} in the task plan ${sorted(want)}`));
      }
    }
  }
  const mapIds = requirementMap.requirements.map(({ id }) => id);
  const proposalRequirementIds = (Array.isArray(proposal.requirements) ? proposal.requirements : []).map(({ id }) => id);
  if (sorted(mapIds) !== sorted(proposalRequirementIds)) {
    diagnostics.push(inadmissible(`proposal requirements ${proposalRequirementIds.join(", ") || "none"} differ from the requirement map's ${mapIds.join(", ")}`));
  }
  return diagnostics;
}

/** The authoring resolver's rule (authoring.ts resolveSourceRefs), as diagnostics instead of a throw. */
function resolveRefs(
  refs: readonly CccPrdSourceReferenceProposal[] | undefined,
  sourceBytes: ReadonlyMap<string, Buffer>,
  entity: string,
  diagnostics: CccPrdDiagnostic[],
): CccPrdSourceSpan[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    diagnostics.push({ code: "CCC_PRD_SOURCE_SPAN_MISSING", message: `${entity} has no source reference` });
    return [];
  }
  const spans: CccPrdSourceSpan[] = [];
  for (const reference of refs) {
    if (!reference || typeof reference.path !== "string" || typeof reference.exactQuote !== "string" || reference.exactQuote.length === 0) {
      diagnostics.push({ code: "CCC_PRD_SOURCE_SPAN_INVALID", message: `${entity} has a malformed source reference` });
      continue;
    }
    const source = sourceBytes.get(reference.path);
    if (!source) {
      diagnostics.push({ code: "CCC_PRD_SOURCE_SPAN_FOREIGN", message: `${entity} references an unadmitted source: ${reference.path}` });
      continue;
    }
    const quote = Buffer.from(reference.exactQuote, "utf8");
    const byteStart = source.indexOf(quote);
    if (byteStart < 0) {
      diagnostics.push({ code: "CCC_PRD_SOURCE_QUOTE_MISSING", message: `${entity} quote is absent in ${reference.path}` });
      continue;
    }
    if (source.indexOf(quote, byteStart + 1) >= 0) {
      diagnostics.push({ code: "CCC_PRD_SOURCE_QUOTE_AMBIGUOUS", message: `${entity} quote is not unique in ${reference.path}` });
      continue;
    }
    spans.push(createCccPrdSpanFromBytes(reference.path, source, byteStart, byteStart + quote.byteLength));
  }
  return spans;
}

type ResolvedProposal = Readonly<{
  requirements: CccPrdRequirement[];
  tasks: CccPrdTask[];
  unresolvedDecisions: CccPrdUnresolvedDecision[];
}>;

function resolveProposal(proposal: CccPrdAuthoringProposalV2, sourceBytes: ReadonlyMap<string, Buffer>, diagnostics: CccPrdDiagnostic[]): ResolvedProposal {
  // Coverage reads only ids, requirement ids, questions and spans; the casts carry the rest of each row unchanged.
  return {
    requirements: proposal.requirements.map((row) => ({ ...row, spans: resolveRefs(row.sourceRefs, sourceBytes, `requirement ${row.id}`, diagnostics) }) as unknown as CccPrdRequirement),
    tasks: proposal.tasks.map((row) => ({ ...row, spans: resolveRefs(row.sourceRefs, sourceBytes, `task ${row.id}`, diagnostics) }) as unknown as CccPrdTask),
    unresolvedDecisions: proposal.unresolvedDecisions.map((row) => ({
      id: row.id, question: row.question, state: "unresolved" as const,
      spans: resolveRefs(row.sourceRefs, sourceBytes, `unresolved decision ${row.id}`, diagnostics),
    })),
  };
}

function coverageDiagnostics(sourceBytes: ReadonlyMap<string, Buffer>, resolved: ResolvedProposal): CccPrdDiagnostic[] {
  const analysis = analyzeCccPrdMaterialCoverage({
    sourceBytes: new Map(sourceBytes),
    requirements: resolved.requirements,
    tasks: resolved.tasks,
    unresolvedDecisions: resolved.unresolvedDecisions,
  });
  const where = (item: (typeof analysis.missing)[number]) => `${item.sourcePath}:${item.spans[0]!.line} ${item.title}`;
  const diagnostics: CccPrdDiagnostic[] = [];
  if (analysis.conflicts.length > 0) {
    diagnostics.push({
      code: "CCC_PRD_MATERIAL_COVERAGE_INVALID",
      message: `material items have conflicting task, deferral, out-of-scope, or unresolved dispositions (${analysis.conflicts.length}): ${analysis.conflicts.slice(0, 5).map(where).join("; ")}`,
    });
  }
  const sections = analysis.missing.filter(({ materialKind }) => materialKind === "section");
  if (sections.length > 0) {
    diagnostics.push({
      code: "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED",
      message: `material source sections need a task, explicit deferral, out-of-scope decision, or unresolved question (${sections.length}): ${sections.slice(0, 5).map(where).join("; ")}`,
    });
  }
  const requirements = analysis.missing.filter(({ materialKind }) => materialKind === "requirement");
  if (requirements.length > 0) {
    diagnostics.push({
      code: "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED",
      message: `explicit source requirements need a task, explicit deferral, out-of-scope decision, or unresolved question (${requirements.length}): ${requirements.slice(0, 8).map(where).join("; ")}`,
    });
  }
  const materialCount = analysis.inventory.length;
  if (materialCount >= 4 && (analysis.missing.length > 0 || analysis.conflicts.length > 0) && analysis.coverage.length / materialCount < 0.8) {
    diagnostics.push({
      code: "CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW",
      message: `material extraction disposed ${analysis.coverage.length} of ${materialCount} deterministic source items`,
    });
  }
  return diagnostics;
}

function proposalProofs(proposal: CccPrdAuthoringProposalV2): CccPlanningProofDefinition[] {
  return (Array.isArray(proposal.proofs) ? proposal.proofs : []).map((proof) => ({
    id: proof.id,
    command: proof.command,
    verifierClosure: (Array.isArray(proof.verifierClosure) ? proof.verifierClosure : []).map(({ role, path }) => ({ role, path })),
    candidateInputs: Array.isArray(proof.candidateInputs) ? [...proof.candidateInputs] : [],
  }));
}

/** G4: pure; empty when the plan, its proposal and its sources are admissible. */
export function runCccPlanningG4(i: CccPlanningG4Input): readonly CccPrdDiagnostic[] {
  const schemas = schemaDiagnostics(i);
  if (schemas.length > 0) return schemas;

  const shape = [
    ...diagnoseCccPlanningTaskPlanGraph(i.taskPlan),
    ...diagnoseCccPlanningImportShape(i.proposal),
    ...diagnoseCccPlanningImportEntityIds(i.taskPlan, i.proposal),
    ...diagnoseCccPlanningProofGraph(i.proposal),
    ...agreementDiagnostics(i.taskPlan, i.proposal, i.requirementMap),
  ];
  if (shape.length > 0) return shape;

  const P = CCC_PLANNING_G4_SOURCE_PATHS;
  const sourceBytes: ReadonlyMap<string, Buffer> = new Map([
    [P.originalRequest, i.sources.originalRequest],
    [P.admissionFacts, i.sources.admissionFacts],
    [P.finalPrd, i.sources.finalPrd],
    [P.technicalAnnex, i.sources.technicalAnnex],
  ]);
  const custody: CccPrdDiagnostic[] = [];
  const resolved = resolveProposal(i.proposal, sourceBytes, custody);
  custody.push(...validateTaskCustodyProvenance(i.proposal));
  if (custody.length > 0) return custody;

  return [
    ...coverageDiagnostics(sourceBytes, resolved),
    ...checkCccPlanningSourceFidelity({
      requestBytes: i.sources.originalRequest,
      requestArtifactDigest: i.requestArtifactDigest,
      packetRequestSha256: createHash("sha256").update(i.sources.originalRequest).digest("hex"),
      acceptanceCases: i.acceptanceCases,
      requirementMap: i.requirementMap,
      annexBytes: i.sources.technicalAnnex,
    }),
    ...simulateCccPlanningSchedule(i.taskPlan, i.policy ?? CCC_PLANNING_BUDGET_POLICY_V1).diagnostics,
    ...checkCccPlanningProofCommands(i.taskPlan, i.verifierBundle, proposalProofs(i.proposal)),
  ];
}
