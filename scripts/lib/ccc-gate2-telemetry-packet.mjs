import path from "node:path";

import {
  gate2TelemetryContract,
  gate2TelemetryTaskSpecs,
} from "./ccc-gate2-telemetry-contract.mjs";
import { buildSemanticProof } from "./ccc-golden-semantic-proof.mjs";

const {
  projectName,
  prdFileName,
  supportRelativePath,
  workflowId,
  integratedProofId,
  fixturePaths,
} = gate2TelemetryContract;
const frozenPrdPath = `sources/${prdFileName}`;
const frozenContextPath = "sources/__fusion__/REF-HUM-FusionOperatorContext.md";
const taskSpecs = gate2TelemetryTaskSpecs;

const prdRef = (exactQuote) => ({ path: frozenPrdPath, exactQuote });
const contextRef = (exactQuote) => ({ path: frozenContextPath, exactQuote });
const requirementLine = (spec) => `Requirement statement: ${spec.statement}`;
const proofLine = (spec) => `For this task, ${spec.command} establishes ${spec.clauseId}. Positive oracle: ${spec.positiveOracle} Negative control: ${spec.negativeControl}`;
const actionLine = (spec) => `- Protected action: live_execution provider://gate2/${spec.taskId} requires explicit campaign approval.`;
const integratedPositiveOracle = "The installed service passes the complete binary project rubric on one joined commit.";
const integratedNegativeControl = "Partial joins, duplicate audit records, rejected-event broadcasts, and unavailable-service probe success are rejected.";
const integratedLine = `The final command task verify:integrated proves every admitted clause on the joined candidate commit. Positive oracle: ${integratedPositiveOracle} Negative control: ${integratedNegativeControl}`;
const runtimeContract = "Start the service with node --experimental-strip-types src/app.ts --port <port> --audit <path>. It must expose GET /health, POST /events, and GET /stream. The stream uses server-sent events and emits only accepted events. Every HTTP request must use the same long-lived createApp service instance. Pass the inbound GET /stream request to that shared instance so its subscriber is registered before calling response.flushHeaders(), then flush those headers before awaiting the first event. Do not create a throwaway startup stream or a second per-route service instance.";
const nonGoals = [
  "Remote delivery by ordinary workers",
  "Writes outside admitted telemetry project paths",
  "Global filesystem discovery or dependency-cache template hunting by ordinary workers",
];

function buildPrd() {
  return [
    "---", "type: prd", "status: active", "version: 1.0.0", "---", "",
    "# Gate 2 Telemetry Service", "",
    "## Product request", "",
    "Build a small local telemetry service with typed HTTP event ingest, append-only JSONL audit storage, live server-sent event broadcast, and a CLI health probe.", "",
    "The service must be runnable from the documented commands, preserve accepted events across restart, and provide tests and operator guidance. Choose a clear implementation within the admitted paths; the behavioral contract is authoritative.", "",
    "## Public runtime contract", "",
    runtimeContract, "",
    "This project executes TypeScript source directly with Node 24 and has no transpile step, so local source imports must use .ts specifiers rather than .js specifiers.", "",
    "Discovery commands must stay inside the project root.",
    "Do not search /, /tmp, /private/tmp, parent directories, home directories, or dependency caches for templates, tsconfig.json, examples, or tooling.",
    "Do not create tsconfig.json; this project deliberately runs TypeScript directly with Node 24 --experimental-strip-types.", "",
    "Run the health probe with node --experimental-strip-types src/health-cli.ts <base-url>. It exits zero only when GET /health reports a healthy running service and exits nonzero when the service is unavailable.", "",
    "## Protected actions", "", ...taskSpecs.map(actionLine),
    "- Protected action: merge refs/heads/main requires separate campaign approval and does not authorize remote delivery.", "",
    "## Requirements and proofs", "",
    ...taskSpecs.flatMap((spec) => [
      `### Requirement ${spec.requirementId}`,
      requirementLine(spec),
      "#### Acceptance clauses",
      `- [${spec.clauseId}] ${spec.acceptance}`,
      "#### Proof declaration",
      proofLine(spec),
      "",
    ]),
    "## Final integrated proof", "", integratedLine, "",
    "## Non-goals", "", ...nonGoals.map((value) => `- ${value}`), "",
    "## Supporting context", "", `[[${supportRelativePath}]] documents the baseline-owned behavioral verifier.`, "",
  ].join("\n");
}

function candidateInputsFor(spec) {
  const byTask = new Map(taskSpecs.map((entry) => [entry.taskId, entry]));
  const visited = new Set();
  const visit = (taskId) => {
    if (visited.has(taskId)) return;
    const task = byTask.get(taskId);
    if (!task) throw new Error(`unknown Gate 2 task dependency: ${taskId}`);
    for (const dependency of task.dependencyTaskIds) visit(dependency);
    visited.add(taskId);
  };
  visit(spec.taskId);
  return taskSpecs.filter(({ taskId }) => visited.has(taskId)).flatMap(({ ownedPaths }) => ownedPaths);
}

function sourceRefsFor(spec, input) {
  const references = [
    contextRef(`- Target repository: ${input.targetRoot}`),
    contextRef(`- Baseline commit: ${input.targetBase}`),
    contextRef(`- Maximum requests: ${input.maxRequests}`),
    contextRef(`- Maximum duration in milliseconds: ${input.maxDurationMs}`),
    contextRef(`- Maximum concurrency: ${input.maxConcurrency}`),
    ...spec.ownedPaths.flatMap((ownedPath) => [
      contextRef(`- Task owned path: ${ownedPath}`),
      contextRef(`- Task allowed write root: ${ownedPath}`),
      contextRef(`- Allowed write root: ${path.join(input.targetRoot, ownedPath)}`),
    ]),
    prdRef(requirementLine(spec)),
    prdRef(spec.acceptance),
    prdRef(proofLine(spec)),
    prdRef(actionLine(spec)),
  ];
  if (spec.taskId === "TASK-TELEMETRY-INTEGRATE") {
    references.push(
      prdRef("Build a small local telemetry service with typed HTTP event ingest, append-only JSONL audit storage, live server-sent event broadcast, and a CLI health probe."),
      prdRef(runtimeContract),
      prdRef(integratedLine),
      prdRef(`[[${supportRelativePath}]] documents the baseline-owned behavioral verifier.`),
    );
  }
  return references;
}

export function buildGate2TelemetryPacketDefinition(input) {
  const requiredRouteKeys = ["minimax", "glm", "gemini"];
  if (!requiredRouteKeys.every((key) => input.routes?.[key])) {
    throw new Error("Gate 2 telemetry routes must define minimax, glm, and gemini");
  }
  const allOwnedPaths = taskSpecs.flatMap(({ ownedPaths }) => ownedPaths);
  const prd = buildPrd();
  const requirements = taskSpecs.map((spec) => ({
    id: spec.requirementId,
    statement: spec.statement,
    acceptance: spec.acceptance,
    acceptanceClauses: [{
      id: spec.clauseId,
      requirementId: spec.requirementId,
      text: spec.acceptance,
      proofIds: [spec.proofId, integratedProofId],
      sourceRefs: [prdRef(spec.acceptance)],
    }],
    acceptanceDispositions: [],
    accountableProducer: "campaign-coding-agent",
    dependencies: [...spec.dependencyRequirementIds],
    proofIds: [spec.proofId, integratedProofId],
    sourceRefs: [prdRef(requirementLine(spec)), prdRef(spec.acceptance)],
    confidence: "high",
  }));
  const proofs = taskSpecs.map((spec) => buildSemanticProof({
    id: spec.proofId,
    requirementIds: [spec.requirementId],
    clauseIds: [spec.clauseId],
    phases: ["task"],
    command: spec.command,
    positiveOracle: spec.positiveOracle,
    positiveCases: [{ id: `CASE-${spec.taskId.slice(5)}`, description: spec.positiveOracle }],
    negativeControls: [{ id: `CONTROL-${spec.taskId.slice(5)}`, description: spec.negativeControl }],
    fixturePaths,
    candidateInputs: candidateInputsFor(spec),
    sourceRefs: [prdRef(proofLine(spec))],
  }));
  proofs.push(buildSemanticProof({
    id: integratedProofId,
    requirementIds: taskSpecs.map(({ requirementId }) => requirementId),
    clauseIds: taskSpecs.map(({ clauseId }) => clauseId),
    phases: ["final_integrated"],
    command: "task verify:integrated",
    positiveOracle: integratedPositiveOracle,
    positiveCases: [{ id: "CASE-TELEMETRY-INTEGRATED", description: "HTTP, audit, restart, SSE, CLI, build, test, and documentation checks pass." }],
    negativeControls: [{ id: "CONTROL-TELEMETRY-INTEGRATED", description: integratedNegativeControl }],
    fixturePaths,
    candidateInputs: allOwnedPaths,
    sourceRefs: [prdRef(integratedLine)],
  }));
  const tasks = taskSpecs.map((spec) => ({
    id: spec.taskId,
    title: spec.title,
    description: `Implement the observable requirement within only ${spec.ownedPaths.join(" and ")}; run ${spec.command} and repair failures before completing the phase. Discovery commands must stay inside ./ only. Do not search /, /tmp, /private/tmp, parent directories, home directories, or dependency caches for templates, tsconfig.json, examples, or tooling. Do not create tsconfig.json; use the files and commands already present in this project.`,
    ownedPaths: [...spec.ownedPaths],
    allowedWriteRoots: [...spec.ownedPaths],
    accountableProducer: "campaign-coding-agent",
    requirementIds: [spec.requirementId],
    dependencyTaskIds: [...spec.dependencyTaskIds],
    proofIds: [spec.proofId],
    workflowId,
    documentIds: [],
    artifactIds: [],
    protectedActionIds: [
      `ACTION-${spec.taskId.slice(5)}-LIVE`,
      ...(spec.taskId === "TASK-TELEMETRY-INTEGRATE" ? ["ACTION-TELEMETRY-MERGE"] : []),
    ],
    sourceRefs: sourceRefsFor(spec, input),
  }));
  const edges = taskSpecs.flatMap((spec) => spec.dependencyTaskIds.map((dependencyTaskId) => ({
    id: `EDGE-${spec.taskId.slice(5)}-${dependencyTaskId.slice(5)}`,
    fromTaskId: spec.taskId,
    toTaskId: dependencyTaskId,
    kind: "depends_on",
  })));
  const bounds = {
    maxRequests: input.maxRequests,
    maxDurationMs: input.maxDurationMs,
    maxConcurrency: input.maxConcurrency,
  };
  const proposal = {
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [
      { id: "AUTHORITY-TELEMETRY", role: "root", sourcePaths: [frozenPrdPath], accountableProducer: "product-owner" },
      { id: "AUTHORITY-TELEMETRY-CONTEXT", role: "support", sourcePaths: [frozenContextPath], accountableProducer: "operator" },
    ],
    requirements,
    proofs,
    tasks,
    edges,
    workflows: [{
      id: workflowId,
      title: "Gate 2 Telemetry Service",
      taskIds: taskSpecs.map(({ taskId }) => taskId),
      entryTaskIds: ["TASK-TELEMETRY-CONTRACT"],
      terminalTaskIds: ["TASK-TELEMETRY-INTEGRATE"],
      sourceRefs: requirements[0].sourceRefs,
    }],
    documents: [],
    artifacts: [],
    importIntents: [
      ...tasks.map(({ id }) => ({ id: `IMPORT-${id.slice(5)}-TASK`, entityType: "task", entityId: id, operation: "create", target: "project.tasks" })),
      ...edges.map(({ id }) => ({ id: `IMPORT-${id.slice(5)}`, entityType: "dependency_edge", entityId: id, operation: "create", target: "project.tasks.dependencies" })),
      { id: "IMPORT-TELEMETRY-WORKFLOW", entityType: "workflow", entityId: workflowId, operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-TELEMETRY-WORK-ITEM", entityType: "work_item", entityId: workflowId, operation: "create", target: "project.workflow_work_items" },
      { id: "IMPORT-TELEMETRY-CAMPAIGN", entityType: "campaign", entityId: "CAMPAIGN-TELEMETRY", operation: "create", target: "project.missions" },
      { id: "IMPORT-TELEMETRY-SOURCE", entityType: "source", entityId: "SOURCE-TELEMETRY", operation: "create", target: "project.ccc_prd_import_sources" },
      { id: "IMPORT-TELEMETRY-AUDIT", entityType: "run_audit", entityId: "CAMPAIGN-TELEMETRY", operation: "create", target: "project.run_audit_events" },
    ],
    protectedActions: [
      ...taskSpecs.map((spec) => ({
        id: `ACTION-${spec.taskId.slice(5)}-LIVE`,
        kind: "live_execution",
        target: `provider://gate2/${spec.taskId}`,
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        sourceRefs: [prdRef(actionLine(spec))],
      })),
      {
        id: "ACTION-TELEMETRY-MERGE",
        kind: "merge",
        target: "refs/heads/main",
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge",
        sourceRefs: [prdRef("- Protected action: merge refs/heads/main requires separate campaign approval and does not authorize remote delivery.")],
      },
    ],
    bounds,
    admittedWriteRoots: [
      { path: path.join(input.targetRoot, ".fusion"), purpose: "Fusion-managed campaign state and artifacts" },
      ...allOwnedPaths.map((ownedPath) => ({ path: path.join(input.targetRoot, ownedPath), purpose: "disposable Gate 2 telemetry project" })),
    ],
    targetRepository: { path: input.targetRoot, baseCommit: input.targetBase },
    nonGoals,
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };
  const routesByTask = Object.fromEntries(
    [...taskSpecs]
      .sort(({ taskId: left }, { taskId: right }) => left.localeCompare(right))
      .map((spec) => [spec.taskId, input.routes[spec.routeKey]]),
  );
  return {
    projectName,
    prdFileName,
    supportRelativePath,
    prd,
    support: "# Gate 2 Telemetry Verifier\n\nThe baseline-owned verifier checks observable service behavior independently from worker-authored tests.\n",
    proposal,
    routes: { schema: "ccc-prd.routes-by-task.v1", routes: routesByTask },
    operatorContext: {
      schema: "ccc-prd.operator-context.v1",
      targetRepository: { path: input.targetRoot, baseCommit: input.targetBase },
      taskCustody: { ownedPaths: allOwnedPaths, allowedWriteRoots: allOwnedPaths },
      writeRootPurpose: "disposable Gate 2 telemetry project",
      bounds,
    },
  };
}
