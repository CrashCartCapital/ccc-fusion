import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "vitest";
import {
  CentralCore,
  GlobalSettingsStore,
  __resetWorkflowExtensionRegistryForTests,
  createCccPrdProductExecutionPlan,
  drizzleSql as sql,
  queryRunAuditEvents,
  resolveGlobalDirForHome,
  type CccPrdProductStatus,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  runPrdCommand,
  type PrdCommandDependencies,
} from "../../../cli/src/commands/prd.js";
import type { CliAgentAdapter } from "../cli-agent/adapter.js";
import type { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-campaign-proof-host.js";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

const execFile = promisify(execFileCallback);
const pgTest = pgDescribe;
const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const engineDistRoot = join(repoRoot, "packages/engine/dist");

type CommandResult = Readonly<{
  exitCode: number;
  values: readonly unknown[];
}>;

type ProductStatusOutput = Readonly<{
  kind: "product-status";
  found: true;
  status: CccPrdProductStatus;
  liveExecutionApprovalConfirmations?: readonly Readonly<{
    approvalRequestId: string;
    confirmation: string;
  }>[];
  liveExecutionAuthorizationConfirmation?: Readonly<{
    authorizationId: string;
    confirmation: string;
    expiresAt: string;
    status: string;
  }>;
  mergeApprovalConfirmations?: readonly Readonly<{
    approvalRequestId: string;
    confirmation: string;
  }>[];
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshotNonGitFilesystem(
  rootDir: string,
): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (relativeRoot: string): Promise<void> => {
    const absoluteRoot = relativeRoot ? join(rootDir, relativeRoot) : rootDir;
    const entries = (await readdir(absoluteRoot, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? join(relativeRoot, entry.name)
        : entry.name;
      if (relativePath === ".git") continue;
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        await visit(relativePath);
        continue;
      }
      if (entry.isFile()) {
        snapshot[relativePath] = sha256(
          await readFile(join(rootDir, relativePath)),
        );
        continue;
      }
      snapshot[relativePath] = "non-file";
    }
  };
  await visit("");
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  diagnose?: () => Promise<unknown>,
  terminal?: (value: T) => unknown | null,
): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < 800; attempt += 1) {
    latest = await read();
    if (accept(latest)) return latest;
    const terminalDiagnostic = terminal?.(latest);
    if (terminalDiagnostic !== null && terminalDiagnostic !== undefined) {
      throw new Error(
        `${label} became impossible; diagnostic=${JSON.stringify(terminalDiagnostic)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = diagnose ? await diagnose() : undefined;
  throw new Error(
    `${label} timed out; latest=${JSON.stringify(latest)}`
    + (diagnostic === undefined
      ? ""
      : `; diagnostic=${JSON.stringify(diagnostic)}`),
  );
}

async function initializeTarget(rootDir: string): Promise<string> {
  await writeFile(
    join(rootDir, ".gitignore"),
    [".fusion/", ".fusion-global-settings/", ".worktrees/", ""].join("\n"),
  );
  await mkdir(join(rootDir, "src"), { recursive: true });
  await writeFile(join(rootDir, "src/value.txt"), "bad\n");
  await writeFile(
    join(rootDir, "verify.cjs"),
    [
      "const fs = require('node:fs');",
      "const candidatePath = process.argv[2];",
      "const value = fs.readFileSync(candidatePath, 'utf8').trim();",
      "const accepts = candidate => candidate === 'good';",
      "const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value);",
      "if (process.env.CCC_PROOF_ID) {",
      "  const passed = accepts(value) && process.env.CCC_PROOF_ID === 'PROOF-VERTICAL' && ['task', 'final_integrated'].includes(process.env.CCC_PROOF_PHASE);",
      "  const evidence = { schema: 'ccc-prd.proof-evidence.v2', proofId: process.env.CCC_PROOF_ID, phase: process.env.CCC_PROOF_PHASE, sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT, sourceTree: process.env.CCC_PROOF_SOURCE_TREE, passed, clauseResults: [{ clauseId: 'AC-REQ-VERTICAL-001', passed }], positiveCaseResults: [{ caseId: 'POS-VERTICAL-001', passed }], negativeControlResults: [{ controlId: 'NEG-VERTICAL-001', passed }] };",
      "  process.stdout.write(canonicalJson(evidence) + '\\n');",
      "  process.exit(passed ? 0 : 1);",
      "}",
      "if (accepts('bad')) {",
      "  console.error('NEGATIVE_CONTROL_FAIL');",
      "  process.exit(2);",
      "}",
      "console.log('NEGATIVE_CONTROL_PASS: planted bad value is rejected');",
      "if (!accepts(value)) {",
      "  console.error(`POSITIVE_ORACLE_FAIL:${value}`);",
      "  process.exit(1);",
      "}",
      "console.log('POSITIVE_ORACLE_PASS: campaign value is good');",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "Taskfile.yml"),
    [
      "version: '3'",
      "",
      "tasks:",
      "  verify:vertical:",
      "    cmds:",
      "      - node verify.cjs src/value.txt",
      "",
    ].join("\n"),
  );
  await git(rootDir, "init", "-q", "-b", "main");
  await git(rootDir, "config", "user.name", "CCC Product Acceptance");
  await git(
    rootDir,
    "config",
    "user.email",
    "ccc-product-acceptance@example.invalid",
  );
  await git(
    rootDir,
    "add",
    "--",
    ".gitignore",
    "Taskfile.yml",
    "src/value.txt",
    "verify.cjs",
  );
  await git(rootDir, "commit", "-q", "-m", "frozen product baseline");
  return git(rootDir, "rev-parse", "HEAD");
}

async function createPacket(
  targetRoot: string,
  targetBase: string,
): Promise<Readonly<{
  packetRoot: string;
  manifestPath: string;
  proposalPath: string;
  sidecarPath: string;
  policyPath: string;
  providerScriptPath: string;
  providerMarkerPath: string;
}>> {
  const packetRoot = await mkdtemp(join(tmpdir(), "ccc-product-packet-"));
  const requirementLine = [
    "- REQ-VERTICAL: Change src/value.txt from bad to good in an isolated worktree.",
    "Acceptance: The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.",
    "Proof command: task verify:vertical.",
    "Positive oracle: The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
    "Negative control: The same verifier exits nonzero for the frozen planted bad value.",
  ].join(" ");
  const liveActionLine =
    "- Protected action: live_execution provider://vertical-fixture/TASK-VERTICAL requires explicit human approval.";
  const mergeActionLine =
    "- Protected action: merge refs/heads/main requires separate explicit human approval.";
  const acceptanceClauseText =
    "The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.";
  const acceptanceClauseBulletLine = `- [AC-REQ-VERTICAL-001] ${acceptanceClauseText}`;
  const prd = [
    "# CCC Fusion Product Vertical Slice",
    `- Target repository: ${targetRoot}`,
    `- Baseline commit: ${targetBase}`,
    `- Allowed write root: ${targetRoot}`,
    "- Allowed write root purpose: disposable product acceptance repository",
    "- Max requests: 2",
    "- Max duration ms: 120000",
    "- Max concurrency: 1",
    "- Non-goal: Modify any path outside src/value.txt.",
    liveActionLine,
    mergeActionLine,
    requirementLine,
    "",
    "### Requirement REQ-VERTICAL",
    "",
    "#### Acceptance clauses",
    acceptanceClauseBulletLine,
    "",
  ].join("\n");
  const prdPath = join(packetRoot, "vertical-slice-prd.md");
  const manifestPath = join(packetRoot, "manifest.json");
  const proposalPath = join(packetRoot, "authoring-proposal.json");
  const sidecarPath = join(packetRoot, "candidate.sidecar.json");
  const policyPath = join(packetRoot, "execution-policy.json");
  const providerScriptPath = join(packetRoot, "fixture-provider.cjs");
  const providerMarkerPath = join(packetRoot, "provider-effect.json");
  const sourceRefs = [{
    path: "vertical-slice-prd.md",
    exactQuote: requirementLine,
  }];
  const liveActionRefs = [{
    path: "vertical-slice-prd.md",
    exactQuote: liveActionLine,
  }];
  const mergeActionRefs = [{
    path: "vertical-slice-prd.md",
    exactQuote: mergeActionLine,
  }];
  const acceptanceClauseRefs = [{
    path: "vertical-slice-prd.md",
    exactQuote: acceptanceClauseText,
  }];
  const acceptanceClauseBulletRefs = [{
    path: "vertical-slice-prd.md",
    exactQuote: acceptanceClauseBulletLine,
  }];

  await writeFile(prdPath, prd);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "vertical-slice.v1",
    entries: [{
      relative_path: "vertical-slice-prd.md",
      role: "root",
      authoritative: true,
      sha256: sha256(prd),
    }],
  }, null, 2)}\n`);
  await writeFile(proposalPath, `${JSON.stringify({
    schema: "ccc-prd.authoring-proposal.v2",
    authorityRoles: [{
      id: "AUTHORITY-VERTICAL",
      role: "root",
      sourcePaths: ["vertical-slice-prd.md"],
      accountableProducer: "product-owner",
    }],
    requirements: [{
      id: "REQ-VERTICAL",
      statement:
        "Change src/value.txt from bad to good in an isolated worktree and commit the change.",
      acceptance:
        "The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.",
      accountableProducer: "campaign-coding-agent",
      dependencies: [],
      proofIds: ["PROOF-VERTICAL"],
      acceptanceClauses: [{
        id: "AC-REQ-VERTICAL-001",
        requirementId: "REQ-VERTICAL",
        text: acceptanceClauseText,
        proofIds: ["PROOF-VERTICAL"],
        sourceRefs: acceptanceClauseRefs,
      }],
      acceptanceDispositions: [],
      sourceRefs,
      confidence: "high",
    }],
    proofs: [{
      id: "PROOF-VERTICAL",
      requirementIds: ["REQ-VERTICAL"],
      command: "task verify:vertical",
      positiveOracle:
        "The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
      schema: "ccc-prd.proof.v2",
      clauseIds: ["AC-REQ-VERTICAL-001"],
      phases: ["task", "final_integrated"],
      positiveCases: [{
        id: "POS-VERTICAL-001",
        description:
          "The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
      }],
      negativeControls: [{
        id: "NEG-VERTICAL-001",
        description: "The same verifier exits nonzero for the frozen planted bad value.",
      }],
      verifierClosure: [
        { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
        { role: "harness", path: "verify.cjs", baseGitBlobOid: "0".repeat(40), sha256: "0".repeat(64) },
      ],
      candidateInputs: ["src/value.txt"],
      executionToolchain: {
        task: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        node: { executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        proofHost: { id: "", executablePath: "", executableSha256: "0".repeat(64), version: "", versionOutputSha256: "0".repeat(64) },
        linkedRuntime: [],
      },
      sourceRefs,
      confidence: "high",
    }],
    tasks: [{
      id: "TASK-VERTICAL",
      title: "Implement the admitted value change",
      description:
        "Edit only src/value.txt so the exact verifier passes; the Fusion controller creates the campaign commit.",
      accountableProducer: "campaign-coding-agent",
      requirementIds: ["REQ-VERTICAL"],
      dependencyTaskIds: [],
      proofIds: ["PROOF-VERTICAL"],
      workflowId: "WORKFLOW-VERTICAL",
      documentIds: [],
      artifactIds: [],
      protectedActionIds: ["ACTION-VERTICAL-LIVE", "ACTION-VERTICAL-MERGE"],
      /*
       * Constrained authoring requires every task to declare source-owned
       * custody (`validateTaskCustodyProvenance`, ccc-prd/authoring.ts): both
       * lists must be non-empty AND each path must appear as a whole path
       * inside the task's own exact source evidence. `requirementLine` quotes
       * "src/value.txt" between spaces, so this custody is provable from the
       * packet rather than asserted by the fixture, and it matches the write
       * custody the execution-policy route below already declares.
       */
      ownedPaths: ["src/value.txt"],
      allowedWriteRoots: ["src/value.txt"],
      /*
       * Also quotes the "#### Acceptance clauses" bullet so this task's
       * resolved source span overlaps that heading's material-coverage
       * section (`analyzeCccPrdMaterialCoverage`, ccc-prd/material-coverage.ts);
       * otherwise `validate` refuses with CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED
       * because nothing disposes of the new v2 acceptance-clause section.
       */
      sourceRefs: [...sourceRefs, ...acceptanceClauseBulletRefs],
    }],
    edges: [],
    workflows: [{
      id: "WORKFLOW-VERTICAL",
      title: "CCC Fusion product vertical slice",
      taskIds: ["TASK-VERTICAL"],
      entryTaskIds: ["TASK-VERTICAL"],
      terminalTaskIds: ["TASK-VERTICAL"],
      sourceRefs,
    }],
    documents: [],
    artifacts: [],
    importIntents: [
      {
        id: "IMPORT-VERTICAL-TASK",
        entityType: "task",
        entityId: "TASK-VERTICAL",
        operation: "create",
        target: "project.tasks",
      },
      {
        id: "IMPORT-VERTICAL-WORKFLOW",
        entityType: "workflow",
        entityId: "WORKFLOW-VERTICAL",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-VERTICAL-WORK-ITEM",
        entityType: "work_item",
        entityId: "WORKFLOW-VERTICAL",
        operation: "create",
        target: "project.workflow_work_items",
      },
      {
        id: "IMPORT-VERTICAL-CAMPAIGN",
        entityType: "campaign",
        entityId: "CAMPAIGN-VERTICAL",
        operation: "create",
        target: "project.missions",
      },
      {
        id: "IMPORT-VERTICAL-SOURCE",
        entityType: "source",
        entityId: "SOURCE-VERTICAL",
        operation: "create",
        target: "project.ccc_prd_import_sources",
      },
      {
        id: "IMPORT-VERTICAL-AUDIT",
        entityType: "run_audit",
        entityId: "CAMPAIGN-VERTICAL",
        operation: "create",
        target: "project.run_audit_events",
      },
    ],
    protectedActions: [
      {
        id: "ACTION-VERTICAL-LIVE",
        kind: "live_execution",
        target: "provider://vertical-fixture/TASK-VERTICAL",
        requiresOperatorDecision: true,
        operatorDecision: "approve_live_execution",
        sourceRefs: liveActionRefs,
      },
      {
        id: "ACTION-VERTICAL-MERGE",
        kind: "merge",
        target: "refs/heads/main",
        requiresOperatorDecision: true,
        operatorDecision: "approve_merge",
        sourceRefs: mergeActionRefs,
      },
    ],
    bounds: {
      maxRequests: 2,
      maxDurationMs: 120_000,
      maxConcurrency: 1,
    },
    admittedWriteRoots: [{
      path: targetRoot,
      purpose: "disposable product acceptance repository",
    }],
    targetRepository: {
      path: targetRoot,
      baseCommit: targetBase,
    },
    nonGoals: ["Modify any path outside src/value.txt."],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  }, null, 2)}\n`);
  await writeFile(policyPath, `${JSON.stringify({
    schema: "ccc-campaign.execution-policy.v2",
    routes: [{
      taskId: "TASK-VERTICAL",
      providerId: "vertical-fixture-provider",
      modelId: "vertical-fixture-model",
      transport: "cli",
      executor: "cli-agent",
      cliAdapterId: "ccc-product-vertical-fixture",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src/value.txt"],
      allowedWriteRoots: ["src/value.txt"],
      commitPolicy: "required",
    }],
  }, null, 2)}\n`);
  await writeFile(providerScriptPath, [
    "const fs = require('node:fs');",
    "const marker = process.argv[2];",
    "let handled = false;",
    "process.stdout.write('READY\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', () => {",
    "  if (!handled) {",
    "    handled = true;",
    "    fs.writeFileSync('src/value.txt', 'good\\n');",
    "    fs.writeFileSync(marker, JSON.stringify({ kind: 'source-edited', cwd: process.cwd() }));",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return {
    packetRoot,
    manifestPath,
    proposalPath,
    sidecarPath,
    policyPath,
    providerScriptPath,
    providerMarkerPath,
  };
}

type ProseMaterialDisposition = "task" | "explicit_deferral" | "out_of_scope";

type ProseMaterialSpec = Readonly<{
  source: "selected" | "context";
  materialKind: "section" | "requirement";
  anchor: string;
  disposition: ProseMaterialDisposition;
}>;

type ProseCase = Readonly<{
  label: string;
  prdFile: string;
  markdown: string;
  requirementStatement: string;
  acceptanceQuote: string;
  nonGoal: string;
  proofCommand: string;
  positiveOracle: string;
  negativeControl: string;
  proofEvidenceQuote: string;
  custodyQuote: string;
  protectedActionQuote: string;
  protectedActionTarget: string;
  materials: readonly ProseMaterialSpec[];
}>;

type FrozenProsePacket = Readonly<{
  packetRoot: string;
  cleanupRoot: string;
  manifestPath: string;
  receiptPath: string;
  proposalPath: string;
  sidecarPath: string;
  policyPath: string;
  selectedPrdPath: string;
  selectedSourcePath: string;
  contextSourcePath: string;
  originalSelectedBytes: Buffer;
  packetHash: string;
}>;

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const CONTEXT_MATERIALS: readonly ProseMaterialSpec[] = [
  {
    source: "context",
    materialKind: "section",
    anchor: "# Fusion Reviewed Operator Context",
    disposition: "task",
  },
  {
    source: "context",
    materialKind: "section",
    anchor: "## Target repository and baseline",
    disposition: "task",
  },
  {
    source: "context",
    materialKind: "section",
    anchor: "## Task custody",
    disposition: "task",
  },
  {
    source: "context",
    materialKind: "section",
    anchor: "## Admitted write roots",
    disposition: "task",
  },
  {
    source: "context",
    materialKind: "section",
    anchor: "## Execution bounds",
    disposition: "task",
  },
];

const GUIDED_WRITE_PURPOSE =
  "disposable product acceptance repository; task verify:vertical";

const PROSE_CASES: readonly ProseCase[] = [
  {
    label: "ordinary prose feature brief",
    prdFile: "ordinary-feature.md",
    markdown: [
      "# Feature brief",
      "",
      "A small safe change should update the value in the admitted source file.",
      "",
      "## Requested change",
      "The campaign may change the repository path src/value.txt from the planted value to the corrected value.",
      "",
      "### Acceptance",
      "The verifier should reject the planted value and accept the corrected value after the change.",
      "",
      "### Validation",
      "The repository verification step demonstrates that the verifier accepts the corrected value and rejects the planted value.",
      "",
      "## Non-goals",
      "Non-goal: the request leaves every path outside src/value.txt unchanged.",
      "",
      "## Approval boundary",
      "A promotion of the accepted change to the shared branch requires operator approval.",
      "",
    ].join("\n"),
    requirementStatement:
      "Update the value file at src/value.txt from its planted value to the corrected value.",
    acceptanceQuote:
      "The verifier should reject the planted value and accept the corrected value after the change.",
    nonGoal: "the request leaves every path outside src/value.txt unchanged.",
    proofCommand: "task verify:vertical",
    positiveOracle: "the verifier accepts the corrected value",
    negativeControl: "the verifier rejects the planted value",
    proofEvidenceQuote:
      "The repository verification step demonstrates that the verifier accepts the corrected value and rejects the planted value.",
    custodyQuote:
      "The campaign may change the repository path src/value.txt from the planted value to the corrected value.",
    protectedActionQuote:
      "A promotion of the accepted change to the shared branch requires operator approval.",
    protectedActionTarget: "the accepted change to the shared branch",
    materials: [
      { source: "selected", materialKind: "section", anchor: "# Feature brief", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "## Requested change", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "### Acceptance", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "### Validation", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "## Non-goals", disposition: "out_of_scope" },
      { source: "selected", materialKind: "section", anchor: "## Approval boundary", disposition: "task" },
    ],
  },
  {
    label: "optional-heading prose boundary brief",
    prdFile: "optional-heading-boundary.md",
    markdown: [
      "# Boundary feature brief",
      "",
      "This brief exercises an optional empty heading and a deferred follow-up in ordinary prose.",
      "",
      "## Requested change",
      "The campaign may change the repository path src/value.txt from the planted value to the corrected value.",
      "",
      "### Acceptance",
      "The verifier should reject the planted value and accept the corrected value after the change.",
      "",
      "### Validation",
      "The repository verification step demonstrates that the verifier accepts the corrected value and rejects the planted value.",
      "",
      "### Optional notes",
      "## Deferred work",
      "A later intake refinement remains explicitly deferred.",
      "",
      "## Additional context",
      "The same task also owns this additional explanatory material.",
      "",
      "## Non-goals",
      "Non-goal: the request leaves every path outside src/value.txt unchanged.",
      "",
      "## Approval boundary",
      "A promotion of the accepted change to the shared branch requires operator approval.",
      "",
    ].join("\n"),
    requirementStatement:
      "Update the value file at src/value.txt from its planted value to the corrected value.",
    acceptanceQuote:
      "The verifier should reject the planted value and accept the corrected value after the change.",
    nonGoal: "the request leaves every path outside src/value.txt unchanged.",
    proofCommand: "task verify:vertical",
    positiveOracle: "the verifier accepts the corrected value",
    negativeControl: "the verifier rejects the planted value",
    proofEvidenceQuote:
      "The repository verification step demonstrates that the verifier accepts the corrected value and rejects the planted value.",
    custodyQuote:
      "The campaign may change the repository path src/value.txt from the planted value to the corrected value.",
    protectedActionQuote:
      "A promotion of the accepted change to the shared branch requires operator approval.",
    protectedActionTarget: "the accepted change to the shared branch",
    materials: [
      { source: "selected", materialKind: "section", anchor: "# Boundary feature brief", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "## Requested change", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "### Acceptance", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "### Validation", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "## Deferred work", disposition: "explicit_deferral" },
      { source: "selected", materialKind: "section", anchor: "## Additional context", disposition: "task" },
      { source: "selected", materialKind: "section", anchor: "## Non-goals", disposition: "out_of_scope" },
      { source: "selected", materialKind: "section", anchor: "## Approval boundary", disposition: "task" },
    ],
  },
];

function asJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function asJsonArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function sourceReference(path: string, exactQuote: string): JsonObject {
  return { path, exactQuote };
}

function rewriteProposalSourceRefs(
  value: JsonValue,
  selectedPath: string,
  selectedQuote: string,
  contextPath: string,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteProposalSourceRefs(
      item,
      selectedPath,
      selectedQuote,
      contextPath,
    ));
  }
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "sourceRefs" && Array.isArray(child)) {
      output[key] = child.map(() => sourceReference(selectedPath, selectedQuote));
      continue;
    }
    if (key === "sourcePaths" && Array.isArray(child)) {
      output[key] = [selectedPath, contextPath];
      continue;
    }
    output[key] = rewriteProposalSourceRefs(
      child,
      selectedPath,
      selectedQuote,
      contextPath,
    );
  }
  return output;
}

function findUniqueByteAnchor(bytes: Buffer, anchor: string): {
  byteStart: number;
  byteEnd: number;
} {
  const quote = Buffer.from(anchor, "utf8");
  const byteStart = bytes.indexOf(quote);
  if (byteStart < 0 || bytes.indexOf(quote, byteStart + 1) >= 0) {
    throw new Error(`expected unique prose material anchor: ${anchor}`);
  }
  return { byteStart, byteEnd: byteStart + quote.byteLength };
}

function assertProposalSourceRefs(
  value: JsonValue,
  sourceBytes: ReadonlyMap<string, Buffer>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertProposalSourceRefs(item, sourceBytes);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "sourceRefs" && Array.isArray(child)) {
      for (const reference of child) {
        const entry = asJsonObject(reference, "proposal source reference");
        const path = entry.path;
        const exactQuote = entry.exactQuote;
        if (typeof path !== "string" || typeof exactQuote !== "string") {
          throw new Error("proposal source reference must contain path and exactQuote");
        }
        const source = sourceBytes.get(path);
        if (!source) throw new Error(`proposal source path is not in the manifest: ${path}`);
        findUniqueByteAnchor(source, exactQuote);
      }
      continue;
    }
    if (key === "sourcePaths" && Array.isArray(child)) {
      for (const path of child) {
        if (typeof path !== "string" || !sourceBytes.has(path)) {
          throw new Error(`proposal source path is not in the manifest: ${String(path)}`);
        }
      }
      continue;
    }
    assertProposalSourceRefs(child, sourceBytes);
  }
}

async function createFrozenProsePacket(
  targetRoot: string,
  targetBase: string,
  proseCase: ProseCase,
): Promise<FrozenProsePacket> {
  const scaffold = await createPacket(targetRoot, targetBase);
  try {
    const activeProjectsRoot = join(scaffold.packetRoot, "active-projects");
    const selectedPrdPath = join(
      activeProjectsRoot,
      "prose-intake",
      proseCase.prdFile,
    );
    await mkdir(dirname(selectedPrdPath), { recursive: true });
    await writeFile(selectedPrdPath, proseCase.markdown);
    const originalSelectedBytes = await readFile(selectedPrdPath);
    const packetRoot = join(scaffold.packetRoot, "frozen-prose-packet");
    const frozen = await runProductCommand([
      "freeze",
      activeProjectsRoot,
      selectedPrdPath,
      packetRoot,
      "--target",
      targetRoot,
      "--base",
      targetBase,
      "--owned-path",
      "src/value.txt",
      "--write-root",
      ".",
      "--write-purpose",
      GUIDED_WRITE_PURPOSE,
      "--max-requests",
      "2",
      "--max-duration-ms",
      "120000",
      "--max-concurrency",
      "1",
    ], {});
    if (frozen.exitCode !== 0 || frozen.values.length !== 1) {
      throw new Error(`prose packet freeze failed: ${JSON.stringify(frozen)}`);
    }
    const freezeResult = frozen.values[0] as {
      rootDir: string;
      manifestPath: string;
      receiptPath: string;
      selectedPrdPath: string;
      packet: { packetHash: string };
    };
    const manifest = JSON.parse(
      await readFile(freezeResult.manifestPath, "utf8"),
    ) as {
      entries: Array<{
        relative_path: string;
        role: string;
        authoritative: boolean;
        sha256: string;
      }>;
    };
    const selectedEntry = manifest.entries.find(({ role, authoritative }) =>
      role === "root" && authoritative);
    const contextEntry = manifest.entries.find(({ relative_path, role, authoritative }) =>
      relative_path.endsWith("REF-HUM-FusionOperatorContext.md")
      && role === "support"
      && authoritative);
    if (!selectedEntry || !contextEntry) {
      throw new Error("frozen prose packet did not contain selected and authoritative operator-context sources");
    }
    const selectedSourcePath = selectedEntry.relative_path;
    const contextSourcePath = contextEntry.relative_path;
    const selectedFrozenBytes = await readFile(join(packetRoot, selectedSourcePath));
    if (!selectedFrozenBytes.equals(originalSelectedBytes)) {
      throw new Error("freeze changed the selected prose bytes");
    }
    if (!(await readFile(selectedPrdPath)).equals(originalSelectedBytes)) {
      throw new Error("freeze changed the original selected prose input");
    }
    const sourceBytes = new Map<string, Buffer>();
    for (const entry of manifest.entries.filter(({ authoritative }) => authoritative)) {
      sourceBytes.set(
        entry.relative_path,
        await readFile(join(packetRoot, entry.relative_path)),
      );
    }
    const selectedQuote = sourceBytes.get(selectedSourcePath)!.toString("utf8");
    const baseProposal = JSON.parse(
      await readFile(scaffold.proposalPath, "utf8"),
    ) as JsonObject;
    const proposal = asJsonObject(
      rewriteProposalSourceRefs(
        baseProposal,
        selectedSourcePath,
        selectedQuote,
        contextSourcePath,
      ),
      "parameterized proposal",
    );
    const selectedTaskRefs = proseCase.materials
      .filter((material) => material.source === "selected" && material.disposition === "task")
      .map((material) => sourceReference(selectedSourcePath, material.anchor));
    selectedTaskRefs.push(
      sourceReference(selectedSourcePath, proseCase.custodyQuote),
      sourceReference(selectedSourcePath, proseCase.acceptanceQuote),
      sourceReference(selectedSourcePath, proseCase.proofEvidenceQuote),
    );
    const contextTaskRefs = CONTEXT_MATERIALS.map((material) =>
      sourceReference(contextSourcePath, material.anchor));
    const contextProofQuote = `- Allowed write root purpose: ${GUIDED_WRITE_PURPOSE}`;
    const taskRefs = [
      ...selectedTaskRefs,
      ...contextTaskRefs,
      sourceReference(contextSourcePath, contextProofQuote),
    ];
    const requirements = asJsonArray(proposal.requirements, "requirements");
    const requirement = asJsonObject(requirements[0], "first requirement");
    requirement.statement = proseCase.requirementStatement;
    requirement.acceptance = proseCase.acceptanceQuote;
    requirement.sourceRefs = selectedTaskRefs;
    const admittedWriteRoots = asJsonArray(
      proposal.admittedWriteRoots,
      "admitted write roots",
    );
    const admittedWriteRoot = asJsonObject(admittedWriteRoots[0], "first admitted write root");
    admittedWriteRoot.purpose = GUIDED_WRITE_PURPOSE;
    proposal.nonGoals = [proseCase.nonGoal];
    const acceptanceClauses = asJsonArray(
      requirement.acceptanceClauses,
      "acceptance clauses",
    );
    const acceptanceClause = asJsonObject(acceptanceClauses[0], "first acceptance clause");
    acceptanceClause.text = proseCase.acceptanceQuote;
    acceptanceClause.sourceRefs = [
      sourceReference(selectedSourcePath, proseCase.acceptanceQuote),
    ];
    const tasks = asJsonArray(proposal.tasks, "tasks");
    const task = asJsonObject(tasks[0], "first task");
    task.sourceRefs = taskRefs;
    task.protectedActionIds = ["ACTION-VERTICAL-LIVE"];
    const proofs = asJsonArray(proposal.proofs, "proofs");
    const proof = asJsonObject(proofs[0], "first proof");
    proof.command = proseCase.proofCommand;
    proof.positiveOracle = proseCase.positiveOracle;
    const negativeControls = asJsonArray(proof.negativeControls, "negative controls");
    asJsonObject(negativeControls[0], "first negative control").description = proseCase.negativeControl;
    proof.sourceRefs = taskRefs;
    const workflows = asJsonArray(proposal.workflows, "workflows");
    asJsonObject(workflows[0], "first workflow").sourceRefs = taskRefs;
    const protectedActions = asJsonArray(proposal.protectedActions, "protected actions");
    const protectedAction = asJsonObject(protectedActions[0], "first protected action");
    protectedAction.kind = "promotion";
    protectedAction.target = proseCase.protectedActionTarget;
    protectedAction.operatorDecision = "approve_promotion";
    protectedAction.sourceRefs = [
      sourceReference(selectedSourcePath, proseCase.protectedActionQuote),
    ];
    proposal.protectedActions = [protectedAction];
    assertProposalSourceRefs(proposal, sourceBytes);
    const proposalPath = join(packetRoot, "authoring-proposal.json");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    return {
      packetRoot,
      cleanupRoot: scaffold.packetRoot,
      manifestPath: freezeResult.manifestPath,
      receiptPath: freezeResult.receiptPath,
      proposalPath,
      sidecarPath: join(packetRoot, "candidate.sidecar.json"),
      policyPath: join(packetRoot, "execution-plan.json"),
      selectedPrdPath,
      selectedSourcePath,
      contextSourcePath,
      originalSelectedBytes,
      packetHash: freezeResult.packet.packetHash,
    };
  } catch (error) {
    await rm(scaffold.packetRoot, { recursive: true, force: true });
    throw error;
  }
}

function fixtureAdapter(
  providerScriptPath: string,
  providerMarkerPath: string,
  hub: Pick<TelemetryHub, "getStateMachine" | "ingest">,
): CliAgentAdapter {
  return {
    id: "ccc-product-vertical-fixture",
    name: "CCC product vertical fixture",
    defaultCommand: process.execPath,
    capabilities: {
      nativeDone: true,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: false,
    },
    buildLaunch: () => ({
      command: process.execPath,
      args: [providerScriptPath, providerMarkerPath],
    }),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({
      observe: (chunk: string) => chunk.includes("READY"),
    }),
    formatInjection: (text: string) => ({ payload: `${text}\n` }),
    wireTelemetry: ({ sessionId }) => {
      let reading = false;
      let completed = false;
      const timer = setInterval(() => {
        if (
          reading
          || completed
          || hub.getStateMachine(sessionId)?.getState() !== "busy"
        ) {
          return;
        }
        reading = true;
        void readFile(providerMarkerPath, "utf8")
          .then(() => {
            completed = true;
            hub.ingest(sessionId, { kind: "done" });
          })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") completed = true;
          })
          .finally(() => {
            reading = false;
          });
      }, 5);
      return () => clearInterval(timer);
    },
  };
}

async function runProductCommand(
  args: string[],
  dependencies: PrdCommandDependencies,
): Promise<CommandResult> {
  const output: string[] = [];
  const exitCode = await runPrdCommand(
    [...args, "--json"],
    { write: (line) => output.push(line) },
    dependencies,
    { projectName: "ccc-product-vertical" },
  );
  return {
    exitCode,
    values: output.map((line) => JSON.parse(line) as unknown),
  };
}

function productStatus(result: CommandResult): ProductStatusOutput {
  expect(result.exitCode).toBe(0);
  expect(result.values).toHaveLength(1);
  return result.values[0] as ProductStatusOutput;
}

function mergeApprovalTerminalDiagnostic(
  value: ProductStatusOutput,
): unknown | null {
  const failedProof = value.status.proofs
    .flatMap(({ definition, attempts }) => attempts.map((attempt) => ({
      definition,
      attempt,
    })))
    .find(({ attempt }) => attempt.state === "proved_failed");
  if (failedProof) {
    return {
      reason: "proof-terminal-before-merge-approval",
      proofId: failedProof.definition.id,
      attemptKey: failedProof.attempt.attemptKey,
      state: failedProof.attempt.state,
      sourceCommit: failedProof.attempt.sourceCommit,
      result: failedProof.attempt.result && {
        success: failedProof.attempt.result.success,
        exitCode: failedProof.attempt.result.exitCode,
        timedOut: failedProof.attempt.result.timedOut,
        killed: failedProof.attempt.result.killed,
        stderrSha256: failedProof.attempt.result.stderrSha256,
        confinementWarnings: failedProof.attempt.result.warnings?.filter((warning) =>
          /bubblewrap|sandbox-exec|confinement|sandbox|namespace/iu.test(warning),
        ),
      },
      nextAction: value.status.nextAction,
    };
  }

  const terminalWorkItem = value.status.workItems.find(({ state }) =>
    ["failed", "cancelled", "exhausted"].includes(state),
  );
  if (terminalWorkItem) {
    return {
      reason: "workflow-terminal-before-merge-approval",
      workItem: {
        id: terminalWorkItem.id,
        state: terminalWorkItem.state,
        lastError: terminalWorkItem.lastError,
        blockedReason: terminalWorkItem.blockedReason,
      },
      nextAction: value.status.nextAction,
    };
  }

  if (["blocked", "abandoned", "resolve-manual-required"].includes(
    value.status.nextAction.kind,
  )) {
    return {
      reason: "product-terminal-before-merge-approval",
      nextAction: value.status.nextAction,
      workItems: value.status.workItems.map((item) => ({
        id: item.id,
        state: item.state,
        lastError: item.lastError,
        blockedReason: item.blockedReason,
      })),
      providerAttempts: value.status.providerAttempts.map((attempt) => ({
        attemptKey: attempt.attemptKey,
        state: attempt.state,
      })),
    };
  }
  return null;
}

pgTest("CCC PRD product vertical acceptance", { timeout: 60_000 }, () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_product_vertical",
    poolMax: 4,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  it.each([
    {
      label: "duplicate workflow work-item intent",
      expectedCode: "CCC_PRD_IMPORT_INTENT_CARDINALITY",
      mutate: (
        sidecar: {
          importIntents: Array<Record<string, string>>;
        },
      ) => {
        const workItem = sidecar.importIntents.find(
          ({ entityType }) => entityType === "work_item",
        )!;
        sidecar.importIntents.push({
          ...workItem,
          id: "IMPORT-VERTICAL-WORK-ITEM-DUPLICATE",
        });
      },
    },
    {
      label: "multi-task workflow",
      expectedCode: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
      mutate: (
        sidecar: {
          importIntents: Array<Record<string, string>>;
          tasks: Array<Record<string, unknown> & { id: string }>;
          workflows: Array<Record<string, unknown> & {
            id: string;
            taskIds: string[];
            terminalTaskIds: string[];
          }>;
        },
      ) => {
        const secondTaskId = "TASK-VERTICAL-SECOND";
        const firstTask = sidecar.tasks[0]!;
        sidecar.tasks.push({
          ...firstTask,
          id: secondTaskId,
          title: "A second task that the current product path cannot integrate",
        });
        sidecar.workflows[0]!.taskIds.push(secondTaskId);
        sidecar.workflows[0]!.terminalTaskIds = [secondTaskId];
        sidecar.importIntents.push({
          id: "IMPORT-VERTICAL-TASK-SECOND",
          entityType: "task",
          entityId: secondTaskId,
          operation: "create",
          target: "project.tasks",
        });
      },
    },
  ])(
    "refuses $label before project resolution with zero database or filesystem residue",
    async ({ expectedCode, mutate }) => {
      const targetRoot = await mkdtemp(
        join(tmpdir(), "ccc-product-admission-refusal-"),
      );
      const baseCommit = await initializeTarget(targetRoot);
      const packet = await createPacket(targetRoot, baseCommit);
      let projectResolutions = 0;
      try {
        const dependencies: PrdCommandDependencies = {
          bootstrapProofAdmission: () =>
            bootstrapCccCampaignProofAdmissionHost({
              builtRootPath: engineDistRoot,
            }),
          resolveProject: async () => {
            projectResolutions += 1;
            return {
              projectId: h.layer().projectId ?? "ccc-product-admission-refusal",
              projectPath: targetRoot,
              projectName: "CCC Product Admission Refusal",
              isRegistered: true,
              store: h.store(),
            };
          },
          closeProjectStore: async () => undefined,
          readTargetHead: async () =>
            git(targetRoot, "rev-parse", "refs/heads/main"),
        };
        const authored = await runProductCommand([
          "author",
          packet.packetRoot,
          packet.manifestPath,
          packet.proposalPath,
          packet.sidecarPath,
        ], dependencies);
        expect(authored.exitCode).toBe(0);

        const sidecar = JSON.parse(
          await readFile(packet.sidecarPath, "utf8"),
        ) as Parameters<typeof mutate>[0];
        mutate(sidecar);
        await writeFile(
          packet.sidecarPath,
          `${JSON.stringify(sidecar)}\n`,
        );

        const databaseSnapshot = async () => {
          const rows = (
            await h.layer().db.execute(sql.raw(`
            SELECT 'ccc_prd_import_entities' AS table_name, count(*)::int AS row_count
              FROM project.ccc_prd_import_entities
            UNION ALL SELECT 'ccc_prd_import_sources', count(*)::int
              FROM project.ccc_prd_import_sources
            UNION ALL SELECT 'ccc_prd_imports', count(*)::int
              FROM project.ccc_prd_imports
            UNION ALL SELECT 'missions', count(*)::int FROM project.missions
            UNION ALL SELECT 'run_audit_events', count(*)::int
              FROM project.run_audit_events
            UNION ALL SELECT 'tasks', count(*)::int FROM project.tasks
            UNION ALL SELECT 'workflow_work_items', count(*)::int
              FROM project.workflow_work_items
            UNION ALL SELECT 'workflows', count(*)::int FROM project.workflows
          `))
          ) as unknown as Array<{ table_name: string; row_count: number }>;
          return [...rows].sort((left, right) =>
            left.table_name < right.table_name
              ? -1
              : left.table_name > right.table_name
                ? 1
                : 0);
        };
        const databaseBefore = await databaseSnapshot();
        expect(databaseBefore).toEqual([
          { table_name: "ccc_prd_import_entities", row_count: 0 },
          { table_name: "ccc_prd_import_sources", row_count: 0 },
          { table_name: "ccc_prd_imports", row_count: 0 },
          { table_name: "missions", row_count: 0 },
          { table_name: "run_audit_events", row_count: 0 },
          { table_name: "tasks", row_count: 0 },
          { table_name: "workflow_work_items", row_count: 0 },
          { table_name: "workflows", row_count: 0 },
        ]);
        const filesystemBefore = await snapshotNonGitFilesystem(targetRoot);

        const compilerArgs = [
          packet.packetRoot,
          packet.manifestPath,
          packet.sidecarPath,
          targetRoot,
          baseCommit,
        ];
        const productArgs = [
          packet.packetRoot,
          packet.manifestPath,
          packet.sidecarPath,
          packet.policyPath,
          targetRoot,
          baseCommit,
        ];
        const preview = await runProductCommand(
          ["preview", ...productArgs],
          dependencies,
        );
        const previewDigest = preview.exitCode === 0
          ? (preview.values[0] as { confirmationDigest: string })
            .confirmationDigest
          : "0".repeat(64);
        const results = [
          await runProductCommand(
            ["validate", ...compilerArgs],
            dependencies,
          ),
          await runProductCommand(
            ["compile", ...compilerArgs],
            dependencies,
          ),
          preview,
          await runProductCommand([
            "import",
            ...productArgs,
            "ccc-product-admission-refusal-v1",
            "--confirm",
            previewDigest,
          ], dependencies),
        ];

        for (const result of results) {
          expect(result.exitCode).toBe(1);
          expect(result.values).toEqual([
            expect.objectContaining({
              diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: expectedCode }),
              ]),
            }),
          ]);
        }
        expect(projectResolutions).toBe(0);
        expect(await databaseSnapshot()).toEqual(databaseBefore);
        expect(await snapshotNonGitFilesystem(targetRoot))
          .toEqual(filesystemBefore);
      } finally {
        __resetWorkflowExtensionRegistryForTests();
        await rm(packet.packetRoot, { recursive: true, force: true });
        await rm(targetRoot, { recursive: true, force: true });
      }
    },
  );

  const runProseAcceptance = async (
    proseCase: ProseCase,
    refusalOnly: boolean,
  ): Promise<void> => {
    const targetRoot = await mkdtemp(
      join(tmpdir(), "ccc-product-prose-target-"),
    );
    const baseCommit = await initializeTarget(targetRoot);
    let packet: FrozenProsePacket;
    try {
      packet = await createFrozenProsePacket(targetRoot, baseCommit, proseCase);
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true });
      throw error;
    }
    const store = h.store();
    let projectResolutions = 0;
    let authoringServer: Server | undefined;
    try {
      const authoringRequests: Array<Record<string, unknown>> = [];
      const proposalText = await readFile(packet.proposalPath, "utf8");
      authoringServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const body = rawBody.length > 0
            ? JSON.parse(rawBody) as Record<string, unknown>
            : {};
          authoringRequests.push({
            method: request.method,
            url: request.url,
            body,
          });
          if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
              object: "list",
              data: [{
                id: "vertical-authoring-model",
                object: "model",
                owned_by: "ccc-product-authoring",
              }],
            }));
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-ccc-product-author",
            object: "chat.completion.chunk",
            model: "vertical-authoring-model",
            choices: [{
              index: 0,
              delta: { role: "assistant", content: proposalText },
              finish_reason: null,
            }],
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-ccc-product-author",
            object: "chat.completion.chunk",
            model: "vertical-authoring-model",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          })}\n\n`);
          response.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve, reject) => {
        authoringServer!.once("error", reject);
        authoringServer!.listen(0, "127.0.0.1", resolve);
      });
      const authoringAddress = authoringServer.address() as AddressInfo;
      const authoringProvider = {
        id: "ccc-product-authoring",
        name: "CCC Product Authoring",
        apiType: "openai-compatible" as const,
        baseUrl: `http://127.0.0.1:${authoringAddress.port}/v1`,
        apiKey: "fixture-key",
        models: [{
          id: "vertical-authoring-model",
          name: "Vertical Authoring Model",
          verbatimCapable: true,
        }],
      };
      const authoringSettings = new GlobalSettingsStore(
        resolveGlobalDirForHome(process.env.HOME!),
      );
      await authoringSettings.updateSettings({
        customProviders: [authoringProvider],
      });
      const currentSettings = await store.getSettings();
      await store.updateGlobalSettings({
        experimentalFeatures: {
          ...(currentSettings.experimentalFeatures ?? {}),
          cliAgentExecutor: true,
        },
        customProviders: [authoringProvider],
      });
      await store.updateSettings({
        pollIntervalMs: 60_000,
        maxConcurrent: 1,
        maxWorktrees: 1,
      });

      const dependencies: PrdCommandDependencies = {
        bootstrapProofAdmission: () =>
          bootstrapCccCampaignProofAdmissionHost({
            builtRootPath: engineDistRoot,
          }),
        resolveProject: async () => {
          projectResolutions += 1;
          return {
            projectId: h.layer().projectId ?? "ccc-product-prose",
            projectPath: targetRoot,
            projectName: "CCC Product Prose",
            isRegistered: true,
            store,
          };
        },
        closeProjectStore: async () => undefined,
        readTargetHead: async () =>
          git(targetRoot, "rev-parse", "refs/heads/main"),
      };
      const manifest = JSON.parse(
        await readFile(packet.manifestPath, "utf8"),
      ) as {
        entries: Array<{
          relative_path: string;
          role: string;
          authoritative: boolean;
          sha256: string;
        }>;
      };
      const receipt = JSON.parse(
        await readFile(packet.receiptPath, "utf8"),
      ) as {
        entries: Array<{
          relativePath: string;
          sha256: string;
          byteLength: number;
        }>;
      };
      const sourceBytes = new Map<string, Buffer>();
      for (const entry of manifest.entries.filter(({ authoritative }) => authoritative)) {
        sourceBytes.set(
          entry.relative_path,
          await readFile(join(packet.packetRoot, entry.relative_path)),
        );
      }
      const assertFrozenSourceIntegrity = async (): Promise<void> => {
        expect(await readFile(packet.selectedPrdPath))
          .toEqual(packet.originalSelectedBytes);
        expect(await readFile(join(packet.packetRoot, packet.selectedSourcePath)))
          .toEqual(packet.originalSelectedBytes);
        for (const entry of manifest.entries) {
          const bytes = await readFile(join(packet.packetRoot, entry.relative_path));
          expect(sha256(bytes)).toBe(entry.sha256);
          const frozen = receipt.entries.find(({ relativePath }) =>
            relativePath === entry.relative_path);
          expect(frozen).toBeDefined();
          expect(frozen!.sha256).toBe(entry.sha256);
          expect(frozen!.byteLength).toBe(bytes.byteLength);
        }
      };
      await assertFrozenSourceIntegrity();

      const authored = await runProductCommand([
        "author",
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        "--target",
        targetRoot,
        "--base",
        baseCommit,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        "--max-requests",
        "2",
        "--max-duration-ms",
        "120000",
        "--max-concurrency",
        "1",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        "--max-review-items",
        "4",
      ], dependencies);
      expect(authored).toMatchObject({
        exitCode: 0,
        values: [{
          kind: "candidate",
          sidecarPath: packet.sidecarPath,
        }],
      });
      const emittedProposal = JSON.parse(proposalText) as JsonObject;
      expect(emittedProposal.schema).toBe("ccc-prd.authoring-proposal.v2");
      expect(asJsonArray(emittedProposal.requirements, "emitted requirements")).toHaveLength(1);
      expect(asJsonArray(emittedProposal.proofs, "emitted proofs")).toHaveLength(1);
      expect(asJsonArray(emittedProposal.tasks, "emitted tasks")).toHaveLength(1);
      expect(asJsonArray(emittedProposal.workflows, "emitted workflows")).toHaveLength(1);
      expect(authoringRequests.filter(({ method }) => method === "POST"))
        .toHaveLength(1);
      await assertFrozenSourceIntegrity();

      const sidecar = JSON.parse(
        await readFile(packet.sidecarPath, "utf8"),
      ) as {
        requirements: unknown[];
        tasks: unknown[];
        unresolvedDecisions: unknown[];
        materialCoverage?: unknown[];
      };
      const analysis = analyzeCccPrdMaterialCoverage({
        sourceBytes,
        requirements: sidecar.requirements as Parameters<
          typeof analyzeCccPrdMaterialCoverage
        >[0]["requirements"],
        tasks: sidecar.tasks as Parameters<
          typeof analyzeCccPrdMaterialCoverage
        >[0]["tasks"],
        unresolvedDecisions: sidecar.unresolvedDecisions as Parameters<
          typeof analyzeCccPrdMaterialCoverage
        >[0]["unresolvedDecisions"],
      });
      const materialKey = (value: unknown) => {
        const item = value as {
          sourcePath: string;
          materialKind: string;
          title: string;
          spans: Array<{
            byteStart: number;
            byteEnd: number;
            sha256: string;
          }>;
          disposition?: { kind: string };
        };
        if (!Array.isArray(item.spans) || item.spans.length !== 1) {
          throw new Error("each material inventory item must have exactly one source span");
        }
        const span = item.spans[0]!;
        return {
          sourcePath: item.sourcePath,
          materialKind: item.materialKind,
          title: item.title,
          spans: [{
            byteStart: span.byteStart,
            byteEnd: span.byteEnd,
            sha256: span.sha256,
          }],
          ...(item.disposition ? { disposition: item.disposition.kind } : {}),
        };
      };
      const expectedSpecs = [
        ...proseCase.materials,
        ...CONTEXT_MATERIALS,
      ];
      const expectedKeys = expectedSpecs.map((spec) => {
        const sourcePath = spec.source === "selected"
          ? packet.selectedSourcePath
          : packet.contextSourcePath;
        const bytes = sourceBytes.get(sourcePath);
        if (!bytes) throw new Error(`missing source bytes for ${sourcePath}`);
        const span = findUniqueByteAnchor(bytes, spec.anchor);
        return {
          sourcePath,
          materialKind: spec.materialKind,
          title: spec.materialKind === "requirement"
            ? "REQ-VERTICAL"
            : spec.anchor.replace(/^#+\s+/u, ""),
          spans: [{
            byteStart: span.byteStart,
            byteEnd: span.byteEnd,
            sha256: sha256(bytes),
          }],
          disposition: spec.disposition,
        };
      });
      const expectedInventoryKeys = expectedKeys.map((value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "disposition"),
        ));
      const sortedKeys = (values: unknown[]) => values
        .map(materialKey)
        .sort((left, right) => String(JSON.stringify(left))
          .localeCompare(String(JSON.stringify(right))));
      expect(analysis.missing).toHaveLength(0);
      expect(analysis.conflicts).toHaveLength(0);
      expect(analysis.inventory.every(({ spans }) => spans.length === 1)).toBe(true);
      expect(expectedKeys.every(({ spans }) => spans.length === 1)).toBe(true);
      expect(sortedKeys(analysis.inventory)).toEqual(sortedKeys(expectedInventoryKeys));
      expect(sortedKeys(analysis.coverage)).toEqual(sortedKeys(expectedKeys));
      expect(sidecar.materialCoverage).toBeDefined();
      expect(sortedKeys(sidecar.materialCoverage!)).toEqual(sortedKeys(analysis.coverage));
      expect(analysis.inventory.some(({ title }) => title === "Optional empty heading"))
        .toBe(false);

      const compilerArgs = [
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        baseCommit,
      ];
      const validated = await runProductCommand(
        ["validate", ...compilerArgs],
        dependencies,
      );
      expect(validated).toMatchObject({
        exitCode: 0,
        values: [{ kind: "diagnostics", valid: true }],
      });
      await assertFrozenSourceIntegrity();
      const compiled = await runProductCommand(
        ["compile", ...compilerArgs],
        dependencies,
      );
      expect(compiled).toMatchObject({
        exitCode: 0,
        values: [{
          kind: "bundle",
          tasks: [expect.objectContaining({
            id: "TASK-VERTICAL",
            ownedPaths: ["src/value.txt"],
            allowedWriteRoots: ["src/value.txt"],
          })],
          workflows: [expect.objectContaining({
            taskIds: ["TASK-VERTICAL"],
            entryTaskIds: ["TASK-VERTICAL"],
            terminalTaskIds: ["TASK-VERTICAL"],
          })],
        }],
      });
      const bundle = compiled.values[0] as {
        kind: "bundle";
        sourceHash: string;
        sidecarHash: string;
        bundleHash: string;
        provenance: { packetHash: string };
        tasks: Array<{
          id: string;
          ownedPaths: string[];
          allowedWriteRoots: string[];
        }>;
        workflows: Array<{
          taskIds: string[];
          entryTaskIds: string[];
          terminalTaskIds: string[];
        }>;
      };
      expect(bundle.tasks).toHaveLength(1);
      expect(bundle.workflows).toHaveLength(1);
      expect(bundle.sourceHash).toBe(packet.packetHash);
      expect(bundle.provenance.packetHash).toBe(packet.packetHash);
      expect(bundle.sidecarHash).toBe(
        sha256(await readFile(packet.sidecarPath)),
      );
      expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      await assertFrozenSourceIntegrity();
      const policy = await runProductCommand([
        "policy",
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        baseCommit,
        packet.policyPath,
        "--provider",
        "vertical-fixture-provider",
        "--model",
        "vertical-fixture-model",
        "--transport",
        "cli",
        "--cli-adapter",
        "ccc-product-vertical-fixture",
      ], dependencies);
      expect(policy).toMatchObject({
        exitCode: 0,
        values: [{ kind: "execution-plan" }],
      });
      const policyValue = policy.values[0] as {
        kind: "execution-plan";
        path: string;
        sha256: string;
        packetHash: string;
        sidecarHash: string;
        bundleHash: string;
      };
      expect(policyValue.path).toBe(packet.policyPath);
      expect(policyValue.sha256).toBe(
        sha256(await readFile(packet.policyPath)),
      );
      expect(policyValue.packetHash).toBe(bundle.sourceHash);
      expect(policyValue.sidecarHash).toBe(bundle.sidecarHash);
      expect(policyValue.bundleHash).toBe(bundle.bundleHash);
      const executionPlan = JSON.parse(
        await readFile(packet.policyPath, "utf8"),
      ) as {
        schema: string;
        packetHash: string;
        sidecarHash: string;
        bundleHash: string;
        policy: unknown;
      };
      expect(executionPlan).toMatchObject({
        schema: "ccc-prd.execution-plan.v1",
        packetHash: bundle.sourceHash,
        sidecarHash: bundle.sidecarHash,
        bundleHash: bundle.bundleHash,
        policy: expect.any(Object),
      });
      await assertFrozenSourceIntegrity();

      const productArgs = [
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        packet.policyPath,
        targetRoot,
        baseCommit,
      ];
      const filesystemBeforeRefusal = await snapshotNonGitFilesystem(targetRoot);
      const databaseSnapshot = async () => {
        const tables = [
          "ccc_prd_imports",
          "ccc_prd_import_entities",
          "ccc_prd_import_sources",
          "missions",
          "tasks",
          "workflows",
          "task_workflow_selection",
          "task_documents",
          "artifacts",
          "workflow_work_items",
          "run_audit_events",
        ] as const;
        const snapshot: Record<string, string> = {};
        for (const table of tables) {
          const rows = await h.layer().db.execute(sql.raw(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM project.${table} AS t`,
          )) as unknown as Array<{ rows: unknown }>;
          snapshot[table] = JSON.stringify(rows[0]?.rows ?? []);
        }
        return snapshot;
      };

      if (!refusalOnly) {
        const preview = await runProductCommand(
          ["preview", ...productArgs],
          dependencies,
        );
        expect(preview).toMatchObject({
          exitCode: 0,
          values: [{
            kind: "preview",
            confirmationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }],
        });
        await assertFrozenSourceIntegrity();
        const previewValue = preview.values[0] as {
          confirmationDigest: string;
          packetHash: string;
          sidecarHash: string;
          bundleHash: string;
        };
        expect(previewValue.packetHash).toBe(bundle.sourceHash);
        expect(previewValue.sidecarHash).toBe(bundle.sidecarHash);
        expect(previewValue.bundleHash).toBe(bundle.bundleHash);
        const imported = await runProductCommand([
          "import",
          ...productArgs,
          `ccc-product-prose-${proseCase.prdFile}`,
          "--confirm",
          previewValue.confirmationDigest,
        ], dependencies);
        expect(imported).toMatchObject({
          exitCode: 0,
          values: [{
            kind: "imported",
            result: expect.objectContaining({ state: "active" }),
          }],
        });
        await assertFrozenSourceIntegrity();
        const importedValue = imported.values[0] as {
          result: {
            bundleHash: string;
            directCounts: {
              campaigns: number;
              tasks: number;
              workflows: number;
              workItems: number;
            };
          };
        };
        expect(importedValue.result.bundleHash).toBe(bundle.bundleHash);
        expect(importedValue.result.directCounts).toEqual(expect.objectContaining({
          campaigns: 1,
          tasks: 1,
          workflows: 1,
          workItems: 1,
        }));
        const importedTables = await databaseSnapshot();
        const importRows = JSON.parse(importedTables.ccc_prd_imports) as Array<{
          packet_hash: string;
          sidecar_hash: string;
          bundle_hash: string;
          state: string;
        }>;
        expect(importRows).toHaveLength(1);
        expect(importRows[0]).toMatchObject({
          packet_hash: bundle.sourceHash,
          sidecar_hash: bundle.sidecarHash,
          bundle_hash: bundle.bundleHash,
          state: "active",
        });
        const sourceRows = JSON.parse(importedTables.ccc_prd_import_sources) as Array<{
          path: string;
          raw_sha256: string;
          byte_length: number;
        }>;
        expect(sourceRows).toHaveLength(manifest.entries.length);
        for (const entry of manifest.entries) {
          const sourceRow = sourceRows.find(({ path }) => path === entry.relative_path);
          expect(sourceRow).toMatchObject({
            path: entry.relative_path,
            raw_sha256: entry.sha256,
            byte_length: (sourceBytes.get(entry.relative_path) ?? Buffer.alloc(0)).byteLength,
          });
        }
        const entityRows = JSON.parse(importedTables.ccc_prd_import_entities) as Array<{
          entity_type: string;
          entity_id: string;
          native_id: string;
        }>;
        const taskEntities = entityRows.filter(({ entity_type }) => entity_type === "task");
        const workflowEntities = entityRows.filter(({ entity_type }) => entity_type === "workflow");
        const workItemEntities = entityRows.filter(({ entity_type }) => entity_type === "work_item");
        expect(taskEntities).toHaveLength(1);
        expect(taskEntities[0]).toMatchObject({
          entity_id: "TASK-VERTICAL",
          native_id: expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
        });
        expect(workflowEntities).toHaveLength(1);
        expect(workflowEntities[0]).toMatchObject({
          entity_id: "WORKFLOW-VERTICAL",
          native_id: expect.stringContaining("--WORKFLOW-VERTICAL"),
        });
        expect(workItemEntities).toHaveLength(1);
        expect(workItemEntities[0]).toMatchObject({
          entity_id: "WORKFLOW-VERTICAL",
          native_id: expect.stringContaining("--IMPORT-VERTICAL-WORK-ITEM"),
        });
        return;
      }

      const damagedSidecar = JSON.parse(
        await readFile(packet.sidecarPath, "utf8"),
      ) as { materialCoverage?: unknown[] };
      damagedSidecar.materialCoverage = damagedSidecar.materialCoverage?.slice(0, -1);
      await writeFile(packet.sidecarPath, `${JSON.stringify(damagedSidecar)}\n`);
      const packetBeforeRefusal = await snapshotNonGitFilesystem(packet.packetRoot);
      const databaseBeforeRefusal = await databaseSnapshot();
      const refusalResults = [
        await runProductCommand(["validate", ...compilerArgs], dependencies),
        await runProductCommand(["compile", ...compilerArgs], dependencies),
        await runProductCommand(["preview", ...productArgs], dependencies),
        await runProductCommand([
          "import",
          ...productArgs,
          "ccc-product-prose-refusal",
          "--confirm",
          "0".repeat(64),
        ], dependencies),
      ];
      for (const result of refusalResults) {
        expect(result.exitCode).toBe(1);
        expect(result.values).toEqual([
          expect.objectContaining({
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "CCC_PRD_MATERIAL_COVERAGE_INVALID" }),
            ]),
          }),
        ]);
      }
      await assertFrozenSourceIntegrity();
      expect(projectResolutions).toBe(0);
      expect(await snapshotNonGitFilesystem(packet.packetRoot))
        .toEqual(packetBeforeRefusal);
      expect(await snapshotNonGitFilesystem(targetRoot))
        .toEqual(filesystemBeforeRefusal);
      expect(await databaseSnapshot()).toEqual(databaseBeforeRefusal);
    } finally {
      __resetWorkflowExtensionRegistryForTests();
      if (authoringServer) {
        authoringServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          authoringServer!.close((error) => error ? reject(error) : resolve());
        });
      }
      await rm(packet.cleanupRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  };

  it.each(PROSE_CASES)(
    "imports $label from guided freeze through generated author and disposable PostgreSQL",
    async (proseCase) => {
      await runProseAcceptance(proseCase, false);
    },
  );

  it("refuses damaged prose coverage with zero packet, target, or importer residue", async () => {
    await runProseAcceptance(PROSE_CASES[0]!, true);
  });

  it("takes a frozen packet through CLI admission, real runtime coding, executed proof, and exact human landing approval", async () => {
    const rootDir = h.rootDir();
    const baseCommit = await initializeTarget(rootDir);
    const packet = await createPacket(rootDir, baseCommit);
    const store = h.store();
    const projectId = h.layer().projectId ?? "ccc-product-vertical";
    let runtime: InProcessRuntime | undefined;
    let central: CentralCore | undefined;
    let authoringServer: Server | undefined;

    try {
      let plantedFailure = "";
      try {
        await execFile(process.execPath, ["verify.cjs", "src/value.txt"], {
          cwd: rootDir,
          encoding: "utf8",
        });
      } catch (error) {
        plantedFailure = String(
          (error as { stderr?: unknown }).stderr ?? error,
        );
      }
      expect(plantedFailure).toContain("POSITIVE_ORACLE_FAIL:bad");

      const authoringRequests: Array<Record<string, unknown>> = [];
      const proposalText = await readFile(packet.proposalPath, "utf8");
      authoringServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const body = rawBody.length > 0
            ? JSON.parse(rawBody) as Record<string, unknown>
            : {};
          authoringRequests.push({
            method: request.method,
            url: request.url,
            body,
          });
          if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
              object: "list",
              data: [{
                id: "vertical-authoring-model",
                object: "model",
                owned_by: "ccc-product-authoring",
              }],
            }));
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-ccc-product-author",
            object: "chat.completion.chunk",
            model: "vertical-authoring-model",
            choices: [{
              index: 0,
              delta: { role: "assistant", content: proposalText },
              finish_reason: null,
            }],
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-ccc-product-author",
            object: "chat.completion.chunk",
            model: "vertical-authoring-model",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          })}\n\n`);
          response.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve, reject) => {
        authoringServer!.once("error", reject);
        authoringServer!.listen(0, "127.0.0.1", resolve);
      });
      const authoringAddress = authoringServer.address() as AddressInfo;
      const authoringProvider = {
        id: "ccc-product-authoring-fixture",
        name: "CCC Product Authoring",
        apiType: "openai-compatible" as const,
        baseUrl: `http://127.0.0.1:${authoringAddress.port}/v1`,
        apiKey: "fixture-key",
        models: [{
          id: "vertical-authoring-model",
          name: "Vertical Authoring Model",
          // Byte-exact echo fixture: it must preserve the proposal text verbatim.
          verbatimCapable: true,
        }],
      };
      const authoringSettings = new GlobalSettingsStore(
        resolveGlobalDirForHome(process.env.HOME!),
      );
      await authoringSettings.updateSettings({
        customProviders: [authoringProvider],
      });
      const currentSettings = await store.getSettings();
      await store.updateGlobalSettings({
        experimentalFeatures: {
          ...(currentSettings.experimentalFeatures ?? {}),
          cliAgentExecutor: true,
        },
        customProviders: [authoringProvider],
      });
      await store.updateSettings({
        pollIntervalMs: 60_000,
        maxConcurrent: 1,
        maxWorktrees: 1,
      });
      expect((await store.getSettings()).experimentalFeatures?.cliAgentExecutor)
        .toBe(true);

      const bootstrapProofAdmission = () =>
        bootstrapCccCampaignProofAdmissionHost({
          builtRootPath: engineDistRoot,
        });
      const dependencies: PrdCommandDependencies = {
        bootstrapProofAdmission,
        resolveProject: async () => ({
          projectId,
          projectPath: rootDir,
          projectName: "CCC Product Vertical",
          isRegistered: true,
          store,
        }),
        closeProjectStore: async () => undefined,
        readTargetHead: async () => git(rootDir, "rev-parse", "refs/heads/main"),
      };

      const authored = await runProductCommand([
        "author",
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        "--target",
        rootDir,
        "--base",
        baseCommit,
        "--provider",
        "ccc-product-authoring",
        "--model",
        "vertical-authoring-model",
        "--max-requests",
        "2",
        "--max-duration-ms",
        "120000",
        "--max-concurrency",
        "1",
        "--max-prompt-bytes",
        "262144",
        "--max-response-bytes",
        "262144",
        "--max-review-items",
        "4",
      ], dependencies);
      expect(authored).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({ kind: "candidate" })],
      });
      const generationRequests = authoringRequests.filter(
        ({ method }) => method === "POST",
      );
      expect(generationRequests).toHaveLength(1);
      expect(generationRequests[0]).toMatchObject({
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: "vertical-authoring-model",
          messages: [expect.objectContaining({
            role: "user",
            content: expect.stringContaining(
              "Every implementation-changing fact must be source-bound",
            ),
          })],
        },
      });
      const authoredSidecar = JSON.parse(
        await readFile(packet.sidecarPath, "utf8"),
      ) as { implementationFactProvenance?: { schema?: string } };
      expect(authoredSidecar.implementationFactProvenance).toMatchObject({
        schema: "ccc-prd.implementation-fact-provenance.v1",
      });
      const validated = await runProductCommand([
        "validate",
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        rootDir,
        baseCommit,
      ], dependencies);
      expect(validated).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({ kind: "diagnostics", valid: true })],
      });
      const compiled = await runProductCommand([
        "compile",
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        rootDir,
        baseCommit,
      ], dependencies);
      expect(compiled).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({
          kind: "bundle",
          requirements: [expect.objectContaining({ id: "REQ-VERTICAL" })],
          tasks: [expect.objectContaining({ id: "TASK-VERTICAL" })],
          proofs: [expect.objectContaining({ id: "PROOF-VERTICAL" })],
        })],
      });

      /*
       * `preview` consumes an execution PLAN (schema, packetHash, sidecarHash,
       * bundleHash, policy), not a bare execution policy. Build it from the
       * bundle the compile step just produced so the three hashes come from
       * that bundle rather than being hand-copied, and so the per-task
       * ownedPaths/allowedWriteRoots are derived from admitted custody. The
       * route selection is exactly what the packet fixture's routes intended.
       */
      const plan = createCccPrdProductExecutionPlan({
        bundle: compiled.values[0] as Parameters<
          typeof createCccPrdProductExecutionPlan
        >[0]["bundle"],
        route: {
          providerId: "vertical-fixture-provider",
          modelId: "vertical-fixture-model",
          transport: "cli",
          cliAdapterId: "ccc-product-vertical-fixture",
        },
      });
      await writeFile(packet.policyPath, `${JSON.stringify(plan, null, 2)}\n`);

      const common = [
        packet.packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        packet.policyPath,
        rootDir,
        baseCommit,
      ];
      const preview = await runProductCommand(["preview", ...common], dependencies);
      expect(preview.exitCode).toBe(0);
      const previewValue = preview.values[0] as {
        kind: string;
        confirmationDigest: string;
      };
      expect(previewValue).toMatchObject({
        kind: "preview",
        confirmationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const idempotencyKey = "ccc-product-vertical-v1";
      const imported = await runProductCommand([
        "import",
        ...common,
        idempotencyKey,
        "--confirm",
        previewValue.confirmationDigest,
      ], dependencies);
      expect(imported).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({
          kind: "imported",
          result: expect.objectContaining({ state: "active", runnable: true }),
        })],
      });
      expect(await git(rootDir, "status", "--porcelain")).toBe("");
      expect(await readFile(join(rootDir, "src/value.txt"), "utf8")).toBe("bad\n");

      central = new CentralCore(h.globalDir(), { asyncLayer: h.layer() });
      await central.init();
      runtime = new InProcessRuntime({
        projectId,
        workingDirectory: rootDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
        externalTaskStore: store,
      }, central);
      await runtime.start();
      const cliRuntime = runtime.getCliAgentRuntime();
      if (!cliRuntime) {
        throw new Error("real runtime did not initialize the CLI coding executor");
      }
      cliRuntime.bundle.registry.register(
        fixtureAdapter(
          packet.providerScriptPath,
          packet.providerMarkerPath,
          cliRuntime.bundle.hub,
        ),
      );

      const runtimeControl = runtime as unknown as {
        drainWorkflowContinuations(): Promise<void>;
      };
      await runtimeControl.drainWorkflowContinuations();
      const firstHold = await waitFor(
        async () => productStatus(await runProductCommand(
          ["status", idempotencyKey],
          dependencies,
        )),
        (value) => value.status.workItems.some(
          (item) => item.state === "manual-required",
        ),
        "first campaign hold",
      );
      const verticalTask = firstHold.status.tasks.find(
        (task) => task.semanticTaskId === "TASK-VERTICAL",
      );
      expect(verticalTask).toMatchObject({
        semanticTaskId: "TASK-VERTICAL",
        nativeTaskId: expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
      });
      const verticalNativeTaskId = verticalTask!.nativeTaskId;
      expect(verticalNativeTaskId).not.toBe("TASK-VERTICAL");
      /*
       * Deliberately unasserted here: this DB round-trip preserves the same
       * settling delay the original (pre-migration) proof-admission check at
       * this point provided before `liveExecutionApprovalConfirmations` is
       * read below. The gate itself only exists downstream of
       * approve-execution (packages/engine/src/ccc-campaign-proof-workflow.ts),
       * so the actual strict assertion now runs after `executionDrain`.
       */
      await queryRunAuditEvents(h.layer().db, { taskId: verticalNativeTaskId });
      const liveHold = firstHold;
      const liveAuthorization = liveHold.liveExecutionAuthorizationConfirmation;
      expect(liveAuthorization).toMatchObject({
        status: "issued",
        confirmation: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(liveHold.status.workItems).toEqual([
        expect.objectContaining({
          state: "manual-required",
          lastError:
            `ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED: `
              + `CCC campaign CAMPAIGN-VERTICAL is awaiting exact human live-execution authorization ${liveAuthorization!.authorizationId}`,
          blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
        }),
      ]);
      expect(liveHold.status.nextAction.kind).toBe("approve-execution");
      /*
       * This campaign runs under `executionAuthorizationMode: "sealed_bundle_v1"`
       * (packages/cli/src/commands/prd.ts ~2203-2218), under which the legacy
       * plural `liveExecutionApprovalConfirmations` is unconditionally `[]` by
       * design; the real live-execution confirmation lives in the singular
       * `liveExecutionAuthorizationConfirmation` field instead, keyed by
       * `authorizationId` (not `approvalRequestId`) -- the same shape the live
       * V12-V15 runbook approves against.
       */
      await expect(readFile(packet.providerMarkerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(rootDir, "src/value.txt"), "utf8")).toBe("bad\n");

      const liveConfirmation =
        liveHold.liveExecutionAuthorizationConfirmation!;
      const executionApproved = await runProductCommand([
        "approve-execution",
        idempotencyKey,
        liveConfirmation.authorizationId,
        "--confirm",
        liveConfirmation.confirmation,
      ], dependencies);
      expect(executionApproved).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({
          kind: "execution-approved",
          approval: expect.objectContaining({ status: "claimed" }),
        })],
      });

      const executionDrain = runtimeControl.drainWorkflowContinuations();
      const providerObservation = await waitFor(
        async () => {
          let effect: { kind: string; cwd?: string; head?: string } | null = null;
          try {
            effect = JSON.parse(
              await readFile(packet.providerMarkerPath, "utf8"),
            ) as { kind: string; cwd?: string; head?: string };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return { effect };
        },
        (value) => value.effect?.kind === "source-edited",
        "provider source edit",
      );
      const providerEffect = providerObservation.effect;
      if (!providerEffect) {
        throw new Error("campaign provider did not edit source");
      }
      expect(providerEffect).toMatchObject({
        kind: "source-edited",
        cwd: expect.not.stringMatching(new RegExp(`^${rootDir}/?$`)),
      });
      await executionDrain;

      const mergeHold = await waitFor(
        async () => productStatus(await runProductCommand(
          ["status", idempotencyKey],
          dependencies,
        )),
        (value) => value.status.nextAction.kind === "approve-merge",
        "exact merge approval hold",
        undefined,
        mergeApprovalTerminalDiagnostic,
      );
      const proofAdmissionAudits = (
        await queryRunAuditEvents(h.layer().db, { taskId: verticalNativeTaskId })
      ).filter((event) =>
        event.mutationType === "ccc-campaign:proof-admission");
      expect(proofAdmissionAudits).toHaveLength(2);
      expect(proofAdmissionAudits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ proofId: "PROOF-VERTICAL", outcome: "pass" }),
        }),
      ]));
      expect(proofAdmissionAudits.every((event) => event.metadata?.outcome === "pass")).toBe(true);
      const campaignSourceCommit =
        mergeHold.status.proofs[0]?.attempts[0]?.sourceCommit;
      expect(campaignSourceCommit).toEqual(
        expect.stringMatching(/^[a-f0-9]{40}$/u),
      );
      expect(await git(rootDir, "rev-parse", "refs/heads/main")).toBe(baseCommit);
      expect(mergeHold.status.proofs).toHaveLength(1);
      const verticalProof = mergeHold.status.proofs[0]!;
      expect(verticalProof.definition).toEqual(expect.objectContaining({ id: "PROOF-VERTICAL" }));
      expect(verticalProof.attempts).toHaveLength(2);
      expect(verticalProof.attempts.map(({ phase }) => phase).sort()).toEqual(["final_integrated", "task"]);
      expect(verticalProof.attempts.every((attempt) =>
        attempt.sourceCommit === campaignSourceCommit
        && attempt.state === "committed"
        && attempt.result?.success === true
        && attempt.result.exitCode === 0
        && attempt.result.stdoutTail.includes('"NEG-VERTICAL-001"'))).toBe(true);
      expect(mergeHold.mergeApprovalConfirmations).toHaveLength(1);
      const mergeConfirmation = mergeHold.mergeApprovalConfirmations![0]!;
      const mergeApproved = await runProductCommand([
        "approve-merge",
        idempotencyKey,
        mergeConfirmation.approvalRequestId,
        "--confirm",
        mergeConfirmation.confirmation,
      ], dependencies);
      expect(mergeApproved).toMatchObject({
        exitCode: 0,
        values: [expect.objectContaining({
          kind: "merge-approved",
          result: expect.objectContaining({ merged: true, noOp: false }),
          status: expect.objectContaining({
            nextAction: expect.objectContaining({ kind: "complete" }),
          }),
        })],
      });

      const landingEvents = await queryRunAuditEvents(h.layer().db, {
        taskId: verticalNativeTaskId,
        domain: "git",
        mutationType: "ccc-campaign-git-landing:terminal",
      });
      const landingMetadata = landingEvents[0]?.metadata as {
        commitObject?: unknown;
      } | null | undefined;
      expect(landingMetadata?.commitObject).toEqual(
        expect.stringMatching(/^[a-f0-9]{40}$/u),
      );
      const landedCommit = landingMetadata!.commitObject as string;
      expect(await git(rootDir, "rev-parse", "refs/heads/main"))
        .toBe(landedCommit);
      expect(landedCommit).not.toBe(campaignSourceCommit);
      expect(await git(rootDir, "rev-parse", `${landedCommit}^{tree}`))
        .toBe(await git(rootDir, "rev-parse", `${campaignSourceCommit}^{tree}`));
      expect(await git(rootDir, "diff", "--name-only", baseCommit, "refs/heads/main"))
        .toBe("src/value.txt");
      const approvedStatus = (
        mergeApproved.values[0] as { status?: CccPrdProductStatus }
      ).status;
      expect(approvedStatus).toBeDefined();
      const approvedLanding = approvedStatus!.landing;
      const canonicalTargetRoot = await realpath(rootDir);
      expect(approvedLanding.intents).toHaveLength(1);
      expect(approvedLanding.intents[0]!.metadata).toMatchObject({
        sourceCommit: campaignSourceCommit,
        mutationPaths: ["src/value.txt"],
        admittedWriteRoots: [join(canonicalTargetRoot, "src/value.txt")],
        targetCheckoutMode: "target-root",
      });
      expect(approvedLanding.materializations).toHaveLength(1);
      expect(approvedLanding.materializations[0]!.metadata).toMatchObject({
        sourceCommit: campaignSourceCommit,
        commitObject: landedCommit,
        mutationPaths: ["src/value.txt"],
        targetCheckoutMode: "target-root",
      });
      expect(approvedLanding.terminals).toHaveLength(1);
      expect(approvedLanding.terminals[0]!.metadata).toMatchObject({
        sourceCommit: campaignSourceCommit,
        mutationPaths: ["src/value.txt"],
        admittedWriteRoots: [join(canonicalTargetRoot, "src/value.txt")],
        targetCheckoutMode: "target-root",
      });
    } finally {
      await runtime?.stop();
      await central?.close();
      if (authoringServer) {
        authoringServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          authoringServer!.close((error) => error ? reject(error) : resolve());
        });
      }
      __resetWorkflowExtensionRegistryForTests();
      await rm(packet.packetRoot, { recursive: true, force: true });
    }
  });
});
