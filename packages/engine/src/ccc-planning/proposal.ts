import { createHash } from "node:crypto";
import {
  CCC_PRD_AUTHORING_PROPOSAL_V2_SCHEMA_VERSION,
  CCC_PRD_PROOF_V2_SCHEMA_VERSION,
  CccPlanningRefusal,
  canonicalCccPrdJson,
  deepFreezeCccPlanningConstant,
  type CccPlanningArtifactEnvelopeV1,
  type CccPlanningArtifactKind,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringProposalV2,
  type CccPrdExecutableIdentity,
  type CccPrdImportIntent,
  type CccPrdProposalProofV2,
  type CccPrdProposalProtectedAction,
  type CccPrdProposalRequirementV2,
  type CccPrdProposalTask,
  type CccPrdSourceReferenceProposal,
  type CccPrdVerifierClosureEntry,
} from "@fusion/core";
import {
  CCC_PLANNING_LINES,
  assertCccPlanningRunRevision,
  cccPlanningGraphRefusal,
  cccPlanningPacketSourcePath,
  cccPlanningSourceVersion,
  deriveCccPlanningRequirementModel,
  deriveCccPlanningTaskModel,
  renderCccPlanningAdmissionFacts,
  renderCccPlanningFinalPrd,
  renderCccPlanningTechnicalAnnex,
  type CccPlanningAdmissionFacts,
  type CccPlanningPacketSourceKey,
  type CccPlanningPacketSources,
  type CccPlanningProofView,
  type CccPlanningTaskView,
} from "./packet.js";

/*
FNXC:CccPlanningProposal 2026-10-14-19:30:
Card IB1 (CONTRACT-v3.3 section 2.17, ADR B Q2, test T2.5): the converter from the reviewed artifacts to the authoring proposal, and the adapter that hands it to `authorCccPrdPacket`. The proposal is built, never generated: every id, quote and relation comes from the requirement map, the task plan and the verifier bundle, so the same artifacts always give the same bytes and the same hash. Every source reference is an exact quote of a line the packet renderers wrote (or of a request quote the map cites), and a builder self-check demands that each quote occurs exactly once in the real source bytes; request quotes that are absent or repeated carry the two request-quote codes, everything else the graph code.
FNXC:CccPlanningProposal 2026-10-14-19:31:
Truthful authorship (T2.5). The adapter id is the profile, the run and the revision (`ccc-planning.full-v2:<run>:r<n>`), the same string the packet's source version carries. The model label is NOT a constant: it is the sorted, de-duplicated, plus-joined set of the `resolvedModel` of every producer envelope, so one envelope that resolved to a different model changes the label and a label written by hand could not. Every producer must be a model with a requested and a resolved model, belong to this run and revision, and the five authoring kinds must all be present; anything else cannot support a truthful label and is refused before an adapter exists. The authorship receipt pairs the proposal hash with one row per producer, and `assertCccPlanningAuthorshipReceiptMatches` is the single check a later card runs: a sidecar whose proposal hash differs from the receipt is reviewed bytes that drifted, and a sidecar whose adapter id or model label is not what the receipt rows derive is an envelope mismatch.
FNXC:CccPlanningProposal 2026-10-14-19:32:
What this proposal leaves to later cards, on purpose. Verifier closure entries and the execution toolchain carry the model-untrusted placeholders (zero digests, `/model-untrusted/*` paths) because only the controller may hydrate a proof from the target repository; the authoring path then keeps the proofs review-only until it is given toolchain paths. Protected actions come from the task plan and are cited in the annex; the operator-admitted actions in the admission facts are written for the record and are not bound here. A task is cited for its decision line, its custody lines, its proof command lines and its protected-action lines; the first task by id also carries the lines nothing else owns (the non-goal request quotes and any protected action no task names), so no quote is left uncited.
*/

const REQUIREMENT_PRODUCER = "campaign-coding-agent";
const TASK_PRODUCER = "campaign-coding-agent";
const WORKFLOW_ID = "WORKFLOW-PLANNING";
const CAMPAIGN_ID = "CAMPAIGN-PLANNING";
const SOURCE_ID = "SOURCE-PLANNING";
const ZERO_GIT_OID = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);
const TASKFILE_PATH = "Taskfile.yml";

const SOURCE_KEYS: readonly CccPlanningPacketSourceKey[] = ["originalRequest", "admissionFacts", "finalPrd", "technicalAnnex"];

type Ref = CccPrdSourceReferenceProposal;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function dedupeRefs(refs: readonly Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.path}\0${ref.exactQuote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How many times `quote` occurs in `source`, overlapping occurrences included (the authoring path refuses a second one). */
function occurrences(source: Buffer, quote: string): number {
  const needle = Buffer.from(quote, "utf8");
  if (needle.byteLength === 0) return 0;
  let count = 0;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) count += 1;
  return count;
}

function expectSameBytes(label: string, actual: Buffer, expected: Buffer): void {
  if (!Buffer.isBuffer(actual) || !actual.equals(expected)) {
    cccPlanningGraphRefusal(`the ${label} source is not what the packet renderer writes for these reviewed artifacts`, label);
  }
}

// ---------------------------------------------------------------- the proposal

function placeholderExecutable(name: string): CccPrdExecutableIdentity {
  return { executablePath: `/model-untrusted/${name}`, executableSha256: ZERO_SHA256, version: "model-untrusted", versionOutputSha256: ZERO_SHA256 };
}

/** The Taskfile is always the task runner; the harness is the proof's only other file, or else `test/<proof id>.test.mjs`; the rest are fixtures. */
function verifierClosureFor(proof: CccPlanningProofView): CccPrdVerifierClosureEntry[] {
  const others = [...new Set(proof.files)].filter((file) => file !== TASKFILE_PATH);
  const named = `test/${proof.id}.test.mjs`;
  let harness: string;
  if (others.length === 1) harness = others[0]!;
  else if (others.includes(named)) harness = named;
  else {
    return cccPlanningGraphRefusal(
      others.length === 0
        ? `proof ${proof.id} names no harness file`
        : `proof ${proof.id} names ${others.length} files and none is ${named}, so its harness is ambiguous`,
      "proofs.files",
    );
  }
  const entry = (role: CccPrdVerifierClosureEntry["role"], path: string): CccPrdVerifierClosureEntry => (
    { role, path, baseGitBlobOid: ZERO_GIT_OID, sha256: ZERO_SHA256 }
  );
  return [entry("task_runner", TASKFILE_PATH), entry("harness", harness), ...others.filter((file) => file !== harness).map((file) => entry("fixture", file))];
}

/** One entry and one exit, and no cycle: the shape the supported product path compiles. */
function singleEntryAndExit(tasks: readonly CccPlanningTaskView[]): Readonly<{ entry: string; exit: string }> {
  const dependencies = new Map(tasks.map((task) => [task.id, new Set(task.dependencyTaskIds)] as const));
  const remaining = new Map([...dependencies].map(([id, set]) => [id, set.size] as const));
  const ready = tasks.filter((task) => remaining.get(task.id) === 0).map((task) => task.id);
  const entries = [...ready];
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited += 1;
    for (const [other, set] of dependencies) {
      if (!set.has(id)) continue;
      const left = remaining.get(other)! - 1;
      remaining.set(other, left);
      if (left === 0) ready.push(other);
    }
  }
  if (visited !== tasks.length) return cccPlanningGraphRefusal("the task dependencies contain a cycle", "tasks.dependencyTaskIds");
  const exits = tasks.filter((task) => ![...dependencies.values()].some((set) => set.has(task.id))).map((task) => task.id);
  if (entries.length !== 1 || exits.length !== 1) {
    return cccPlanningGraphRefusal(
      `the supported product path needs exactly one entry task and one terminal task; the plan has entries [${entries.join(", ")}] and terminals [${exits.join(", ")}]`,
      "tasks.dependencyTaskIds",
    );
  }
  return { entry: entries[0]!, exit: exits[0]! };
}

export type CccPlanningAuthorshipRole = Readonly<{
  roleId: string; artifactKey: string; outputDigest: string;
  requestedModel: string; resolvedModel: string; instanceId: string;
}>;

export type CccPlanningAuthorshipReceiptContent = Readonly<{
  proposalHash: string;
  roles: readonly CccPlanningAuthorshipRole[];
}>;

/**
 * Converts the reviewed requirement map, task plan and verifier bundle, together with the packet sources written from
 * them, into the V2 authoring proposal. Refuses with `CCC_PLANNING_GRAPH_INADMISSIBLE` anything it cannot quote exactly.
 */
export function buildCccPlanningAuthoringProposal(input: Readonly<{
  sources: CccPlanningPacketSources;
  requirementMap: CccPlanningRequirementMapV1;
  taskPlan: CccPlanningTaskPlanV1;
  verifierBundle: CccPlanningVerifierBundleV1;
  facts: CccPlanningAdmissionFacts;
}>): CccPrdAuthoringProposalV2 {
  const { sources, requirementMap, taskPlan, verifierBundle, facts } = input;
  const L = CCC_PLANNING_LINES;
  const requirementModel = deriveCccPlanningRequirementModel(requirementMap, verifierBundle);
  const taskModel = deriveCccPlanningTaskModel(taskPlan);
  expectSameBytes("admission facts", sources.admissionFacts, renderCccPlanningAdmissionFacts(facts));
  expectSameBytes("final PRD", sources.finalPrd, renderCccPlanningFinalPrd({ requirementMap, verifierBundle }));
  expectSameBytes("technical annex", sources.technicalAnnex, renderCccPlanningTechnicalAnnex({ taskPlan }));
  if (!Buffer.isBuffer(sources.originalRequest)) return cccPlanningGraphRefusal("the original request source must be bytes", "originalRequest");

  // ---- the plan against the map and the bundle
  const requirementIds = new Set(requirementModel.requirements.map((requirement) => requirement.id));
  const proofById = new Map(requirementModel.proofs.map((proof) => [proof.id, proof] as const));
  const claimedRequirements = new Set(taskModel.tasks.flatMap((task) => task.requirementIds));
  for (const id of claimedRequirements) {
    if (!requirementIds.has(id)) return cccPlanningGraphRefusal(`a task names requirement ${id}, which the requirement map does not declare`, "tasks.requirementIds");
  }
  for (const requirement of requirementModel.requirements) {
    if (!claimedRequirements.has(requirement.id)) {
      return cccPlanningGraphRefusal(`requirement ${requirement.id} is claimed by no task`, "tasks.requirementIds");
    }
  }
  const ownersByProof = new Map<string, CccPlanningTaskView[]>();
  for (const task of taskModel.tasks) {
    for (const proofId of task.proofIds) {
      if (!proofById.has(proofId)) return cccPlanningGraphRefusal(`task ${task.id} names proof ${proofId}, which the verifier bundle does not declare`, "tasks.proofIds");
      ownersByProof.set(proofId, [...(ownersByProof.get(proofId) ?? []), task]);
    }
  }
  for (const proof of requirementModel.proofs) {
    if ((ownersByProof.get(proof.id) ?? []).length === 0) return cccPlanningGraphRefusal(`proof ${proof.id} is claimed by no task`, "tasks.proofIds");
  }
  if (!verifierBundle.files.some((file) => file.path === TASKFILE_PATH)) {
    return cccPlanningGraphRefusal(`the verifier bundle has no ${TASKFILE_PATH}, so no proof command can run`, "verifierBundle.files");
  }
  const { entry, exit } = singleEntryAndExit(taskModel.tasks);
  const decisionLines = new Map(taskModel.tasks.map((task) => [task.decisionId, L.decision(task.id, task.decisionText)] as const));
  const sortedTasks = [...taskModel.tasks].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const firstTaskId = sortedTasks[0]!.id;

  const ref = (key: CccPlanningPacketSourceKey, exactQuote: string): Ref => ({ path: cccPlanningPacketSourcePath(key), exactQuote });

  // ---- requirements and their clauses
  const requirements = requirementModel.requirements.map((requirement): CccPrdProposalRequirementV2 => {
    const refs: Ref[] = [ref("finalPrd", L.requirementStatement(requirement.statement))];
    for (const clause of requirement.clauses) refs.push(ref("finalPrd", L.clause(clause.id, clause.text)));
    for (const clause of requirement.clauses) {
      if (clause.derivation.kind === "request") {
        for (const quote of clause.derivation.requestQuotes) refs.push(ref("originalRequest", quote));
      } else {
        for (const decisionId of clause.derivation.decisionIds) {
          const line = decisionLines.get(decisionId);
          if (line === undefined) {
            throw new CccPlanningRefusal("CCC_PLANNING_ANNEX_DECISION_UNKNOWN", `clause ${clause.id} cites ${decisionId}, which the annex does not declare`, "clauses.derivation");
          }
          refs.push(ref("technicalAnnex", line));
        }
      }
    }
    return {
      id: requirement.id,
      statement: requirement.statement,
      acceptance: requirement.clauses[0]!.text,
      acceptanceClauses: requirement.clauses.map((clause) => ({
        id: clause.id, requirementId: requirement.id, text: clause.text,
        proofIds: sortedUnique(requirement.proofIds), sourceRefs: [ref("finalPrd", clause.text)],
      })),
      acceptanceDispositions: [],
      accountableProducer: REQUIREMENT_PRODUCER,
      dependencies: [],
      proofIds: sortedUnique(requirement.proofIds),
      sourceRefs: dedupeRefs(refs),
      confidence: "high",
    };
  });

  // ---- proofs
  const clauseIdsOf = (requirementId: string): string[] => (
    requirementModel.requirements.find((requirement) => requirement.id === requirementId)!.clauses.map((clause) => clause.id)
  );
  const proofs = requirementModel.proofs.map((proof): CccPrdProposalProofV2 => {
    const owners = ownersByProof.get(proof.id)!;
    return {
      schema: CCC_PRD_PROOF_V2_SCHEMA_VERSION,
      id: proof.id,
      requirementIds: [...proof.requirementIds],
      clauseIds: sortedUnique(proof.requirementIds.flatMap(clauseIdsOf)),
      phases: owners.length === 1 ? ["task", "final_integrated"] : ["final_integrated"],
      command: proof.command,
      positiveOracle: proof.oracle,
      positiveCases: [{ id: `case-${proof.id}`, description: proof.oracle }],
      negativeControls: proof.controls.map((control) => ({ id: control.id, description: control.text })),
      verifierClosure: verifierClosureFor(proof),
      candidateInputs: sortedUnique(owners.flatMap((task) => task.ownedPaths)),
      executionToolchain: {
        task: placeholderExecutable("task"),
        node: placeholderExecutable("node"),
        proofHost: { id: "model-untrusted-proof-host", ...placeholderExecutable("proof-host") },
        linkedRuntime: [],
      },
      sourceRefs: dedupeRefs([
        ref("finalPrd", L.proofCommand(proof.id, proof.command)),
        ref("finalPrd", L.proofOracle(proof.id, proof.oracle)),
        ...proof.controls.map((control) => ref("finalPrd", L.proofControl(proof.id, control.id, control.text))),
      ]),
      confidence: "high",
    };
  });

  // ---- protected actions and tasks
  const actionLine = (action: { id: string; kind: string; target: string }) => L.protectedAction(action.id, action.kind, action.target);
  const protectedActions = taskModel.protectedActions.map((action): CccPrdProposalProtectedAction => ({
    id: action.id, kind: action.kind, target: action.target, sourceRefs: [ref("technicalAnnex", actionLine(action))],
  }));
  const referencedActions = new Set(taskModel.tasks.flatMap((task) => task.protectedActionIds));
  const actionById = new Map(taskModel.protectedActions.map((action) => [action.id, action] as const));
  const tasks = taskModel.tasks.map((task): CccPrdProposalTask => {
    const refs: Ref[] = [
      ref("technicalAnnex", decisionLines.get(task.decisionId)!),
      ...task.ownedPaths.map((path) => ref("technicalAnnex", L.ownedPath(task.id, path))),
      ...task.allowedWriteRoots.map((path) => ref("technicalAnnex", L.writeRoot(task.id, path))),
      ...task.proofIds.map((proofId) => ref("finalPrd", L.proofCommand(proofId, proofById.get(proofId)!.command))),
      ...task.protectedActionIds.map((actionId) => ref("technicalAnnex", actionLine(actionById.get(actionId)!))),
    ];
    if (task.id === firstTaskId) {
      for (const nonGoal of requirementModel.nonGoals) for (const quote of nonGoal.requestQuotes) refs.push(ref("originalRequest", quote));
      for (const action of taskModel.protectedActions) if (!referencedActions.has(action.id)) refs.push(ref("technicalAnnex", actionLine(action)));
    }
    return {
      id: task.id, title: task.title, description: task.description,
      accountableProducer: TASK_PRODUCER,
      requirementIds: [...task.requirementIds], dependencyTaskIds: [...task.dependencyTaskIds], proofIds: [...task.proofIds],
      workflowId: WORKFLOW_ID, documentIds: [], artifactIds: [], protectedActionIds: [...task.protectedActionIds],
      ownedPaths: [...task.ownedPaths], allowedWriteRoots: [...task.allowedWriteRoots],
      sourceRefs: dedupeRefs(refs),
    };
  });

  // ---- the rest of the declaration
  const finalPrdPath = cccPlanningPacketSourcePath("finalPrd");
  const importIntents: CccPrdImportIntent[] = [
    ...taskModel.tasks.map((task): CccPrdImportIntent => ({ id: `IMPORT-TASK-${task.id}`, entityType: "task", entityId: task.id, operation: "create", target: "project.tasks" })),
    ...taskModel.edges.map((edge): CccPrdImportIntent => ({ id: `IMPORT-EDGE-${edge.id}`, entityType: "dependency_edge", entityId: edge.id, operation: "create", target: "project.tasks.dependencies" })),
    { id: "IMPORT-WORKFLOW", entityType: "workflow", entityId: WORKFLOW_ID, operation: "create", target: "project.workflow_work_items" },
    { id: "IMPORT-WORK-ITEM", entityType: "work_item", entityId: WORKFLOW_ID, operation: "create", target: "project.workflow_work_items" },
    { id: "IMPORT-CAMPAIGN", entityType: "campaign", entityId: CAMPAIGN_ID, operation: "create", target: "project.missions" },
    { id: "IMPORT-SOURCE", entityType: "source", entityId: SOURCE_ID, operation: "create", target: "project.ccc_prd_import_sources" },
    { id: "IMPORT-AUDIT", entityType: "run_audit", entityId: CAMPAIGN_ID, operation: "create", target: "project.run_audit_events" },
  ];
  const proposal: CccPrdAuthoringProposalV2 = {
    schema: CCC_PRD_AUTHORING_PROPOSAL_V2_SCHEMA_VERSION,
    authorityRoles: [
      { id: "AUTHORITY-PLANNING-PRD", role: "root", sourcePaths: [finalPrdPath], accountableProducer: "planning-spec-author" },
      {
        id: "AUTHORITY-PLANNING-SUPPORT", role: "support",
        sourcePaths: [cccPlanningPacketSourcePath("technicalAnnex"), cccPlanningPacketSourcePath("admissionFacts"), cccPlanningPacketSourcePath("originalRequest")],
        accountableProducer: "planning-controller",
      },
    ],
    requirements,
    proofs,
    tasks,
    edges: taskModel.edges.map((edge) => ({ id: edge.id, fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind })),
    workflows: [{
      id: WORKFLOW_ID, title: "Request-to-code planning slice",
      taskIds: taskModel.tasks.map((task) => task.id), entryTaskIds: [entry], terminalTaskIds: [exit],
      sourceRefs: taskModel.tasks.map((task) => ref("technicalAnnex", decisionLines.get(task.decisionId)!)),
    }],
    documents: [],
    artifacts: [],
    importIntents,
    protectedActions,
    bounds: { maxRequests: facts.bounds.maxRequests, maxDurationMs: facts.bounds.maxDurationMs, maxConcurrency: facts.bounds.maxConcurrency },
    admittedWriteRoots: facts.admittedWriteRoots.map((root) => ({ path: root.path, purpose: root.purpose })),
    targetRepository: { path: facts.targetRepository.path, baseCommit: facts.targetRepository.baseCommit },
    nonGoals: requirementModel.nonGoals.map((nonGoal) => nonGoal.text),
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };

  // ---- self-check: every quote occurs exactly once in the real source bytes
  const sourceBytes = new Map(SOURCE_KEYS.map((key) => [cccPlanningPacketSourcePath(key), sources[key]] as const));
  const requestPath = cccPlanningPacketSourcePath("originalRequest");
  const cited = [
    ...proposal.requirements.flatMap((requirement) => [...requirement.sourceRefs, ...requirement.acceptanceClauses.flatMap((clause) => clause.sourceRefs)]),
    ...proposal.proofs.flatMap((proof) => proof.sourceRefs),
    ...proposal.tasks.flatMap((task) => task.sourceRefs),
    ...proposal.workflows.flatMap((workflow) => workflow.sourceRefs),
    ...proposal.protectedActions.flatMap((action) => action.sourceRefs),
  ];
  for (const reference of cited) {
    const count = occurrences(sourceBytes.get(reference.path)!, reference.exactQuote);
    if (count === 1) continue;
    if (reference.path === requestPath) {
      throw new CccPlanningRefusal(
        count === 0 ? "CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED" : "CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS",
        `request quote ${JSON.stringify(reference.exactQuote)} occurs ${count} times in the original request`,
        "requestQuotes",
      );
    }
    return cccPlanningGraphRefusal(`quote ${JSON.stringify(reference.exactQuote)} occurs ${count} times in ${reference.path}, not exactly once`, "sourceRefs");
  }
  return proposal;
}

// ---------------------------------------------------------------- truthful authorship

const AUTHORING_KINDS: readonly CccPlanningArtifactKind[] = ["requirement_map", "final_prd", "technical_annex", "task_plan", "verifier_bundle"];

function invalidEnvelope(detail: string, field: string): never {
  throw new CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", detail, field);
}

/**
 * The producers that can support a truthful label: this run and revision, models only, exactly one complete envelope of each
 * authoring kind and nothing else. FNXC:CccPlanningProposal 2026-10-14-21:01: ADR B Q2 derives the label from the envelopes of the
 * requirement map, PRD, annex, plan and verifier bundle only. A review envelope, an older version of one kind or an envelope that
 * is not complete would put a model in the label (and a row in the receipt) that wrote nothing in the packet (errata E9, IB1).
 */
function assertAuthoringProducers(producers: readonly CccPlanningArtifactEnvelopeV1[], runId: string, runRevision: number): void {
  assertCccPlanningRunRevision(runId, runRevision);
  if (!Array.isArray(producers) || producers.length === 0) invalidEnvelope("authorship needs the producer envelopes of the authoring artifacts", "producers");
  const seenKinds = new Set<CccPlanningArtifactKind>();
  for (const envelope of producers) {
    if (!AUTHORING_KINDS.includes(envelope.kind)) {
      invalidEnvelope(`envelope ${envelope.artifactKey} is a ${envelope.kind} artifact, which authored nothing in the packet`, "producers");
    }
    if (seenKinds.has(envelope.kind)) invalidEnvelope(`more than one producer envelope for the ${envelope.kind} artifact`, "producers");
    seenKinds.add(envelope.kind);
    if (envelope.status !== "complete") invalidEnvelope(`envelope ${envelope.artifactKey} has status ${envelope.status}, not complete`, "producers");
    if (envelope.runId !== runId || envelope.runRevision !== runRevision) {
      throw new CccPlanningRefusal(
        "CCC_PLANNING_ARTIFACT_RUN_MISMATCH",
        `envelope ${envelope.artifactKey} belongs to ${envelope.runId} revision ${envelope.runRevision}, not ${runId} revision ${runRevision}`,
        "producers",
      );
    }
    const producer = envelope.producer;
    if (producer.kind !== "model") invalidEnvelope(`envelope ${envelope.artifactKey} was not produced by a model`, "producers");
    if (typeof producer.resolvedModel !== "string" || producer.resolvedModel.length === 0) {
      invalidEnvelope(`envelope ${envelope.artifactKey} records no resolved model`, "producers");
    }
    if (typeof producer.requestedModel !== "string" || producer.requestedModel.length === 0) {
      invalidEnvelope(`envelope ${envelope.artifactKey} records no requested model`, "producers");
    }
  }
  for (const kind of AUTHORING_KINDS) {
    if (!producers.some((envelope) => envelope.kind === kind)) invalidEnvelope(`no producer envelope for the ${kind} artifact`, "producers");
  }
}

/** The sorted, de-duplicated, plus-joined set of resolved models. */
function modelLabel(resolvedModels: readonly string[]): string {
  return sortedUnique(resolvedModels).join("+");
}

export function createCccPlanningAuthoringAdapter(input: Readonly<{
  proposal: CccPrdAuthoringProposalV2;
  producers: readonly CccPlanningArtifactEnvelopeV1[];
  runId: string;
  runRevision: number;
}>): CccPrdAuthoringAdapter {
  assertAuthoringProducers(input.producers, input.runId, input.runRevision);
  const frozen = deepFreezeCccPlanningConstant(structuredClone(input.proposal));
  return {
    id: cccPlanningSourceVersion(input.runId, input.runRevision),
    model: modelLabel(input.producers.map((envelope) => envelope.producer.resolvedModel!)),
    generateCandidate: async () => structuredClone(frozen),
  };
}

export function computeCccPlanningProposalHash(proposal: CccPrdAuthoringProposalV2): string {
  return createHash("sha256").update(canonicalCccPrdJson(proposal)).digest("hex");
}

export function buildCccPlanningAuthorshipReceipt(input: Readonly<{
  proposal: CccPrdAuthoringProposalV2;
  producers: readonly CccPlanningArtifactEnvelopeV1[];
  runId: string;
  runRevision: number;
}>): CccPlanningAuthorshipReceiptContent {
  assertAuthoringProducers(input.producers, input.runId, input.runRevision);
  const roles = input.producers
    .map((envelope): CccPlanningAuthorshipRole => ({
      roleId: envelope.producer.roleId,
      artifactKey: envelope.artifactKey,
      outputDigest: envelope.outputDigest,
      requestedModel: envelope.producer.requestedModel!,
      resolvedModel: envelope.producer.resolvedModel!,
      instanceId: envelope.producer.instanceId,
    }))
    .sort((left, right) => (
      left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1
        : left.artifactKey < right.artifactKey ? -1 : left.artifactKey > right.artifactKey ? 1 : 0
    ));
  return { proposalHash: computeCccPlanningProposalHash(input.proposal), roles };
}

/**
 * The one check a later card runs between an authored sidecar and the authorship receipt. A proposal hash that differs is
 * reviewed bytes that drifted (`CCC_PLANNING_REVIEWED_BYTES_DRIFT`); an adapter id or model label that the receipt rows do
 * not derive is `CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH`. The hash is compared first, so a changed proposal is never excused
 * by labels that still match.
 */
export function assertCccPlanningAuthorshipReceiptMatches(input: Readonly<{
  receipt: CccPlanningAuthorshipReceiptContent;
  provenance: Readonly<{ authoringAdapterId: string; authoringModel?: string; proposalHash: string; packetHash: string }>;
  runId: string;
  runRevision: number;
}>): void {
  assertCccPlanningRunRevision(input.runId, input.runRevision);
  const { receipt, provenance } = input;
  if (provenance.proposalHash !== receipt.proposalHash) {
    throw new CccPlanningRefusal(
      "CCC_PLANNING_REVIEWED_BYTES_DRIFT",
      `the sidecar's proposal hash ${provenance.proposalHash} is not the receipt's ${receipt.proposalHash}`,
      "proposalHash",
    );
  }
  if (receipt.roles.length === 0) {
    throw new CccPlanningRefusal("CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH", "the authorship receipt names no producer role", "roles");
  }
  const expectedId = cccPlanningSourceVersion(input.runId, input.runRevision);
  const expectedModel = modelLabel(receipt.roles.map((role) => role.resolvedModel));
  if (provenance.authoringAdapterId !== expectedId) {
    throw new CccPlanningRefusal(
      "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH",
      `the sidecar's adapter id ${provenance.authoringAdapterId} is not ${expectedId}`,
      "authoringAdapterId",
    );
  }
  if (provenance.authoringModel !== expectedModel) {
    throw new CccPlanningRefusal(
      "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH",
      `the sidecar's model label ${String(provenance.authoringModel)} is not ${expectedModel}, the set the receipt rows resolved`,
      "authoringModel",
    );
  }
}
