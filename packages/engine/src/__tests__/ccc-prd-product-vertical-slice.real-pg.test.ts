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
): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < 800; attempt += 1) {
    latest = await read();
    if (accept(latest)) return latest;
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
      "const value = fs.readFileSync('src/value.txt', 'utf8').trim();",
      "const accepts = candidate => candidate === 'good';",
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
      "      - node verify.cjs",
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
  const prd = [
    "# CCC Fusion Product Vertical Slice",
    `- Target repository: ${targetRoot}`,
    `- Baseline commit: ${targetBase}`,
    `- Allowed write root: ${targetRoot}`,
    "- Allowed write root purpose: disposable product acceptance repository",
    "- Max requests: 1",
    "- Max duration ms: 120000",
    "- Max concurrency: 1",
    "- Non-goal: Modify any path outside src/value.txt.",
    liveActionLine,
    mergeActionLine,
    requirementLine,
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
    schema: "ccc-prd.authoring-proposal.v1",
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
      sourceRefs,
      confidence: "high",
    }],
    proofs: [{
      id: "PROOF-VERTICAL",
      requirementIds: ["REQ-VERTICAL"],
      command: "task verify:vertical",
      positiveOracle:
        "The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
      negativeControls: [
        "The same verifier exits nonzero for the frozen planted bad value.",
      ],
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
      sourceRefs,
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
      maxRequests: 1,
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
    args,
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
        await execFile(process.execPath, ["verify.cjs"], {
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
        "1",
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
      const proofAdmissionAudits = (
        await queryRunAuditEvents(h.layer().db, { taskId: verticalNativeTaskId })
      ).filter((event) =>
        event.mutationType === "ccc-campaign:proof-admission");
      expect(proofAdmissionAudits).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            proofId: "PROOF-VERTICAL",
            outcome: "pass",
          }),
        }),
      ]);
      const liveHold = firstHold;
      expect(liveHold.status.workItems).toEqual([
        expect.objectContaining({
          state: "manual-required",
          lastError:
            "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
        }),
      ]);
      expect(liveHold.status.nextAction.kind).toBe("approve-execution");
      expect(liveHold.liveExecutionApprovalConfirmations).toHaveLength(1);
      await expect(readFile(packet.providerMarkerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(rootDir, "src/value.txt"), "utf8")).toBe("bad\n");

      const liveConfirmation =
        liveHold.liveExecutionApprovalConfirmations![0]!;
      const executionApproved = await runProductCommand([
        "approve-execution",
        idempotencyKey,
        liveConfirmation.approvalRequestId,
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
      );
      const campaignSourceCommit =
        mergeHold.status.proofs[0]?.attempts[0]?.sourceCommit;
      expect(campaignSourceCommit).toEqual(
        expect.stringMatching(/^[a-f0-9]{40}$/u),
      );
      expect(await git(rootDir, "rev-parse", "refs/heads/main")).toBe(baseCommit);
      expect(mergeHold.status.proofs).toEqual([
        expect.objectContaining({
          definition: expect.objectContaining({ id: "PROOF-VERTICAL" }),
          attempts: [expect.objectContaining({
            sourceCommit: campaignSourceCommit,
            state: "committed",
            result: expect.objectContaining({
              success: true,
              exitCode: 0,
              stdoutTail: expect.stringContaining("NEGATIVE_CONTROL_PASS"),
            }),
          })],
        }),
      ]);
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
