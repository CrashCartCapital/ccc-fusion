import path from "node:path";

import { buildSemanticProof } from "./ccc-golden-semantic-proof.mjs";

const prdFileName = "PRJ-HUM-CCCGoldenEvidenceLedger-PRD-v1.0.0.md";
const supportRelativePath = "support/REF-HUM-EvidenceLedgerVerifier.md";
const frozenPrdPath = `sources/${prdFileName}`;
const frozenContextPath = "sources/__fusion__/REF-HUM-FusionOperatorContext.md";
const integratedProofId = "PROOF-LEDGER-INTEGRATED";
const workflowId = "WORKFLOW-LEDGER";
const supportingContextLine = `[[${supportRelativePath}]] documents the baseline-owned verifier.`;
const verifierFixturePaths = [
  "fixtures/duplicate-id.ndjson",
  "fixtures/hardcode-control.ndjson",
  "fixtures/invalid-calendar-date.ndjson",
  "fixtures/invalid-confidence.ndjson",
  "fixtures/invalid-json.ndjson",
  "fixtures/invalid-timestamp.ndjson",
  "fixtures/missing-required-field.ndjson",
  "fixtures/unknown-field.ndjson",
  "fixtures/valid-shuffled.ndjson",
  "fixtures/valid.ndjson",
];
const integratedCandidateInputs = ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"];

const taskSpecs = [
  {
    requirementId: "REQ-LEDGER-CONTRACT",
    taskId: "TASK-LEDGER-CONTRACT",
    proofId: "PROOF-LEDGER-CONTRACT",
    clauseId: "AC-REQ-LEDGER-CONTRACT-001",
    title: "Implement the Evidence Ledger record contract",
    statement: "Create src/record.mjs and src/validation.mjs with the exact strict record contract.",
    acceptance: "The contract verifier proves strict parsing, field, timestamp, confidence, tag, and duplicate-ID behavior.",
    command: "task verify:contract",
    positiveOracle: "The baseline-owned contract verifier accepts every valid fixture behavior.",
    negativeControl: "The baseline-owned contract verifier rejects malformed, unknown, missing, duplicate, timestamp, and confidence fixtures.",
    ownedPaths: ["src/record.mjs", "src/validation.mjs"],
    implementationBrief: [
      "Public API: export parseEvidenceLine(line, lineNumber) from src/record.mjs and validateEvidenceRecords(records) from src/validation.mjs.",
      "Record schema: each record is a plain object with exactly the required string fields id, subject, claim, observedAt, source, confidence and optional tags; confidence is low, medium, or high; observedAt is a real UTC timestamp at exact second precision; tags is an optional array of unique non-empty strings returned in sorted order; duplicate record IDs are rejected.",
      "Static boundary: do not use new Date, Date.now, randomUUID, network APIs, child processes, native modules, dynamic import, require, eval, or Function; validate the UTC calendar fields arithmetically.",
      "Execution: inspect the target and fixtures on request 1, write both owned files by request 2, run task verify:contract by request 3, and use remaining requests only to repair proof failures. Do not read the verifier unless the first proof fails.",
    ].join(" "),
    dependencyRequirementIds: [],
    dependencyTaskIds: [],
  },
  {
    requirementId: "REQ-LEDGER-CORE",
    taskId: "TASK-LEDGER-CORE",
    proofId: "PROOF-LEDGER-CORE",
    clauseId: "AC-REQ-LEDGER-CORE-001",
    title: "Implement canonical ledger aggregation and reports",
    statement: "Create src/ledger.mjs and src/report.mjs against the frozen contract module signatures.",
    acceptance: "The core verifier proves canonical order, subject aggregation, JSON and text rendering, shuffled-input invariance, and hardcode controls.",
    command: "task verify:core",
    positiveOracle: "The baseline-owned core verifier emits canonical report evidence for valid and shuffled fixtures.",
    negativeControl: "The baseline-owned hardcode control changes semantic output while preserving the public schema.",
    ownedPaths: ["src/ledger.mjs", "src/report.mjs"],
    implementationBrief: [
      "Public API: export buildLedger(records) from src/ledger.mjs and export renderJsonReport(ledger) and renderTextReport(ledger) from src/report.mjs.",
      "Behavior: return a new canonical ledger with schema evidence-ledger.report.v1; sort records by observedAt then id, sort tags, group subjects lexically, preserve canonical subject record order, emit stable pretty JSON with one trailing newline, and emit the frozen plain-text report with one trailing newline.",
      "Static boundary: do not use clocks, randomness, network APIs, child processes, native modules, dynamic import, require, eval, or Function; do not hardcode visible fixture output.",
      "Execution: inspect the dependency exports and target fixtures on request 1, write both owned files by request 2, run task verify:core by request 3, and use remaining requests only to repair proof failures. Do not read the verifier unless the first proof fails.",
    ].join(" "),
    dependencyRequirementIds: ["REQ-LEDGER-CONTRACT"],
    dependencyTaskIds: ["TASK-LEDGER-CONTRACT"],
  },
  {
    requirementId: "REQ-LEDGER-CLI",
    taskId: "TASK-LEDGER-CLI",
    proofId: "PROOF-LEDGER-CLI",
    clauseId: "AC-REQ-LEDGER-CLI-001",
    title: "Implement the Evidence Ledger CLI and README",
    statement: "Create bin/evidence-ledger.mjs and README.md against the frozen CLI, output, and exit-code contract.",
    acceptance: "The CLI verifier proves help, usage and validation exits, canonical JSON and text, README guidance, and forbidden-surface refusal.",
    command: "task verify:cli",
    positiveOracle: "The baseline-owned CLI verifier accepts the complete command and documentation contract.",
    negativeControl: "Invalid fixtures return exit 2 with empty stdout while usage and IO errors return exit 1.",
    ownedPaths: ["README.md", "bin/evidence-ledger.mjs"],
    implementationBrief: [
      "Public CLI: node bin/evidence-ledger.mjs report <input> --format json|text and node bin/evidence-ledger.mjs --help; README.md must document both formats and the report command.",
      "Behavior: help exits 0; missing or malformed usage and unsupported formats exit 1; input IO errors exit 1 with empty stdout; invalid records exit 2 with empty stdout and a concise validation error; valid output is exactly the canonical report from the dependency modules.",
      "Static boundary: do not write files or leave residue, use clocks, randomness, network APIs, child processes, native modules, dynamic import, require, eval, or Function.",
      "Execution: inspect the dependency exports and target fixtures on request 1, write both owned files by request 2, run task verify:cli by request 3, and use remaining requests only to repair proof failures. Do not read the verifier unless the first proof fails.",
    ].join(" "),
    dependencyRequirementIds: ["REQ-LEDGER-CORE"],
    dependencyTaskIds: ["TASK-LEDGER-CORE"],
  },
];

const prdRef = (exactQuote) => ({ path: frozenPrdPath, exactQuote });
const contextRef = (exactQuote) => ({ path: frozenContextPath, exactQuote });
const requirementLine = (spec) => `Requirement statement: ${spec.statement}`;
const proofLine = (spec) => `For this task, ${spec.command} establishes ${spec.clauseId}. Positive oracle: ${spec.positiveOracle} Negative control: ${spec.negativeControl}`;
const liveActionLine = (spec) => `- Protected action: live_execution provider://golden/${spec.taskId} requires explicit human approval.`;

function buildPrd(specs, integratedProofLine, mergeActionLine, nonGoalLine) {
  return [
    "---", "type: prd", "status: active", "version: 1.0.0", "---", "",
    "# CCC Golden Evidence Ledger", "", "## Implementation contract", "", nonGoalLine, "",
    "## Protected actions", "", ...specs.map(liveActionLine), mergeActionLine, "",
    "## Requirement and proof", "",
    ...specs.flatMap((spec) => [
      `### Requirement ${spec.requirementId}`,
      requirementLine(spec),
      "#### Acceptance clauses",
      `- [${spec.clauseId}] ${spec.acceptance}`,
      "#### Proof declaration",
      proofLine(spec),
      "",
    ]),
    "## Final integrated proof", "", integratedProofLine, "",
    "## Supporting context", "", supportingContextLine, "",
  ].join("\n");
}

function taskSourceRefs(spec, input) {
  const generalContext = [
    `- Target repository: ${input.targetRoot}`,
    `- Baseline commit: ${input.targetBase}`,
    `- Allowed write root: ${path.join(input.targetRoot, ".fusion")}`,
    "- Allowed write root purpose: Fusion-managed campaign state and artifacts",
    "- Allowed write root purpose: disposable golden campaign repository",
    `- Maximum requests: ${input.maxRequests}`,
    `- Maximum duration in milliseconds: ${input.maxDurationMs}`,
    "- Maximum concurrency: 1",
  ].map(contextRef);
  const custody = spec.ownedPaths.flatMap((ownedPath) => [
    contextRef(`- Task owned path: ${ownedPath}`),
    contextRef(`- Task allowed write root: ${ownedPath}`),
    contextRef(`- Allowed write root: ${path.join(input.targetRoot, ownedPath)}`),
  ]);
  return [
    ...generalContext,
    ...custody,
    prdRef(input.nonGoalLine),
    prdRef(requirementLine(spec)),
    prdRef(spec.acceptance),
    prdRef(proofLine(spec)),
    prdRef(liveActionLine(spec)),
    prdRef(input.integratedProofLine),
    prdRef(supportingContextLine),
  ];
}

function buildProposal(input) {
  const specs = input.taskSpecs;
  const integratedClauseIds = specs.map(({ clauseId }) => clauseId);
  const allOwnedPaths = specs.flatMap(({ ownedPaths }) => ownedPaths);
  const cumulativeOwnedPathsByTask = new Map(specs.map((spec, index) => [
    spec.taskId,
    specs.slice(0, index + 1).flatMap(({ ownedPaths }) => ownedPaths),
  ]));
  const finalProofId = specs.length === 1 ? specs[0].proofId : integratedProofId;
  const sourceRefsByTask = new Map(specs.map((spec) => [spec.taskId, taskSourceRefs(spec, input)]));
  const requirements = specs.map((spec) => ({
    id: spec.requirementId,
    statement: spec.statement,
    acceptance: spec.acceptance,
    acceptanceClauses: [{
      id: spec.clauseId,
      requirementId: spec.requirementId,
      text: spec.acceptance,
      proofIds: [...new Set([spec.proofId, finalProofId])],
      sourceRefs: [prdRef(spec.acceptance)],
    }],
    acceptanceDispositions: [],
    accountableProducer: "campaign-coding-agent",
    dependencies: [...spec.dependencyRequirementIds],
    proofIds: [...new Set([spec.proofId, finalProofId])],
    sourceRefs: [prdRef(requirementLine(spec)), prdRef(spec.acceptance)],
    confidence: "high",
  }));
  const proofs = specs.map((spec) => buildSemanticProof({
    id: spec.proofId,
    requirementIds: [spec.requirementId],
    clauseIds: [spec.clauseId],
    phases: specs.length === 1 ? ["task", "final_integrated"] : ["task"],
    command: spec.command,
    positiveOracle: spec.positiveOracle,
    positiveCases: [{ id: `CASE-${spec.taskId.slice(5)}`, description: spec.positiveOracle }],
    negativeControls: [{ id: `CONTROL-${spec.taskId.slice(5)}`, description: spec.negativeControl }],
    fixturePaths: verifierFixturePaths,
    candidateInputs: cumulativeOwnedPathsByTask.get(spec.taskId),
    sourceRefs: [prdRef(proofLine(spec))],
  }));
  if (specs.length > 1) {
    proofs.push(buildSemanticProof({
      id: integratedProofId,
      requirementIds: specs.map(({ requirementId }) => requirementId),
      clauseIds: integratedClauseIds,
      phases: ["final_integrated"],
      command: input.finalProofCommand,
      positiveOracle: input.integratedPositiveOracle,
      positiveCases: [{ id: "CASE-LEDGER-INTEGRATED", description: input.integratedPositiveOracle }],
      negativeControls: [{ id: "CONTROL-LEDGER-INTEGRATED", description: input.integratedNegativeControl }],
      fixturePaths: verifierFixturePaths,
      candidateInputs: integratedCandidateInputs,
      sourceRefs: [prdRef(input.integratedProofLine)],
    }));
  }

  const tasks = specs.map((spec, index) => ({
    id: spec.taskId,
    title: spec.title,
    description: [
      `Create only ${spec.ownedPaths.join(" and ")} before reading unrelated paths; call the phase completion tool only after ${spec.command} passes.`,
      spec.implementationBrief,
    ].filter(Boolean).join(" "),
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
      ...(index === specs.length - 1 ? ["ACTION-LEDGER-MERGE"] : []),
    ],
    sourceRefs: sourceRefsByTask.get(spec.taskId),
  }));
  const selectedTaskIds = new Set(specs.map(({ taskId }) => taskId));
  const edges = [
    { id: "EDGE-LEDGER-CORE-CONTRACT", fromTaskId: "TASK-LEDGER-CORE", toTaskId: "TASK-LEDGER-CONTRACT", kind: "depends_on" },
    { id: "EDGE-LEDGER-CLI-CORE", fromTaskId: "TASK-LEDGER-CLI", toTaskId: "TASK-LEDGER-CORE", kind: "depends_on" },
  ].filter(({ fromTaskId, toTaskId }) => selectedTaskIds.has(fromTaskId) && selectedTaskIds.has(toTaskId));
  const importIntents = [
    ...tasks.map(({ id }) => ({ id: `IMPORT-${id.slice(5)}-TASK`, entityType: "task", entityId: id, operation: "create", target: "project.tasks" })),
    ...edges.map(({ id }) => ({ id: `IMPORT-${id.slice(5)}`, entityType: "dependency_edge", entityId: id, operation: "create", target: "project.tasks.dependencies" })),
    { id: "IMPORT-LEDGER-WORKFLOW", entityType: "workflow", entityId: workflowId, operation: "create", target: "project.workflow_work_items" },
    { id: "IMPORT-LEDGER-WORK-ITEM", entityType: "work_item", entityId: workflowId, operation: "create", target: "project.workflow_work_items" },
    { id: "IMPORT-LEDGER-CAMPAIGN", entityType: "campaign", entityId: "CAMPAIGN-LEDGER", operation: "create", target: "project.missions" },
    { id: "IMPORT-LEDGER-SOURCE", entityType: "source", entityId: "SOURCE-LEDGER", operation: "create", target: "project.ccc_prd_import_sources" },
    { id: "IMPORT-LEDGER-AUDIT", entityType: "run_audit", entityId: "CAMPAIGN-LEDGER", operation: "create", target: "project.run_audit_events" },
  ];

  return {
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [
      { id: "AUTHORITY-LEDGER", role: "root", sourcePaths: [frozenPrdPath], accountableProducer: "product-owner" },
      { id: "AUTHORITY-LEDGER-CONTEXT", role: "support", sourcePaths: [frozenContextPath], accountableProducer: "operator" },
    ],
    requirements,
    proofs,
    tasks,
    edges,
    workflows: [{ id: workflowId, title: "CCC Golden Evidence Ledger", taskIds: tasks.map(({ id }) => id), entryTaskIds: [tasks[0].id], terminalTaskIds: [tasks.at(-1).id], sourceRefs: requirements[0].sourceRefs }],
    documents: [],
    artifacts: [],
    importIntents,
    protectedActions: [
      ...specs.map((spec) => ({ id: `ACTION-${spec.taskId.slice(5)}-LIVE`, kind: "live_execution", target: `provider://golden/${spec.taskId}`, requiresOperatorDecision: true, operatorDecision: "approve_live_execution", sourceRefs: [prdRef(liveActionLine(spec))] })),
      { id: "ACTION-LEDGER-MERGE", kind: "merge", target: "refs/heads/main", requiresOperatorDecision: true, operatorDecision: "approve_merge", sourceRefs: [prdRef(input.mergeActionLine)] },
    ],
    bounds: { maxRequests: input.maxRequests, maxDurationMs: input.maxDurationMs, maxConcurrency: 1 },
    admittedWriteRoots: [
      { path: path.join(input.targetRoot, ".fusion"), purpose: "Fusion-managed campaign state and artifacts" },
      ...allOwnedPaths.map((ownedPath) => ({ path: path.join(input.targetRoot, ownedPath), purpose: "disposable golden campaign repository" })),
    ],
    targetRepository: { path: input.targetRoot, baseCommit: input.targetBase },
    nonGoals: [input.nonGoal],
    unresolvedDecisions: [], ambiguities: [], exceptions: [], confidence: "high",
  };
}

export function buildEvidenceLedgerPacketDefinition(input) {
  const taskCount = input.taskCount ?? taskSpecs.length;
  if (![1, taskSpecs.length].includes(taskCount)) throw new Error("taskCount must be 1 or 3");
  const selectedTaskSpecs = taskSpecs.slice(0, taskCount);
  const allOwnedPaths = selectedTaskSpecs.flatMap(({ ownedPaths }) => ownedPaths);
  const countLabel = allOwnedPaths.length === 6 ? "six" : String(allOwnedPaths.length);
  const nonGoal = `Modify any path outside the ${countLabel} admitted worker write roots.`;
  const nonGoalLine = `- Non-goal: ${nonGoal}`;
  const mergeActionLine = "- Protected action: merge refs/heads/main requires separate explicit human approval.";
  const integratedPositiveOracle = "The baseline-owned project verifier emits all required passing canonical clauses on one integrated commit.";
  const integratedNegativeControl = "Malformed, shuffled, hardcode, forbidden-surface, usage, and validation controls prevent a hardcoded or partial project from passing.";
  const finalProofCommand = selectedTaskSpecs.length === 1 ? selectedTaskSpecs[0].command : "task verify:project";
  const integratedProofLine = `For the combined result, ${finalProofCommand} establishes every admitted clause. Positive oracle: ${integratedPositiveOracle} Negative control: ${integratedNegativeControl}`;
  const proposalInput = { ...input, taskSpecs: selectedTaskSpecs, finalProofCommand, nonGoal, nonGoalLine, mergeActionLine, integratedPositiveOracle, integratedNegativeControl, integratedProofLine };
  const proposal = buildProposal(proposalInput);
  const routes = Object.fromEntries([...selectedTaskSpecs].map(({ taskId }) => taskId).sort().map((taskId) => [taskId, { ...input.route }]));
  return {
    projectName: "golden-evidence-ledger",
    prdFileName,
    supportRelativePath,
    prd: buildPrd(selectedTaskSpecs, integratedProofLine, mergeActionLine, nonGoalLine),
    support: "# Evidence Ledger verifier\n\nThe baseline-owned verifier proves each task phase and the integrated project without granting worker write authority.\n",
    proposal,
    routes: { schema: "ccc-prd.routes-by-task.v1", routes },
    operatorContext: {
      schema: "ccc-prd.operator-context.v1",
      targetRepository: { path: input.targetRoot, baseCommit: input.targetBase },
      taskCustody: { ownedPaths: allOwnedPaths, allowedWriteRoots: allOwnedPaths },
      writeRootPurpose: "disposable golden campaign repository",
      bounds: { maxRequests: input.maxRequests, maxDurationMs: input.maxDurationMs, maxConcurrency: 1 },
    },
  };
}
