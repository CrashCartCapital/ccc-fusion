#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliBin = path.join(repoRoot, "packages/cli/bin.mjs");
const expectedChecks = Object.freeze([
  "built-cli-current-run",
  "current-prd-discovered-and-frozen",
  "guided-operator-context-frozen",
  "planted-defect-rejected",
  "native-local-authoring",
  "frozen-packet-validated",
  "product-owned-execution-plan",
  "forged-provenance-refused-without-residue",
  "exact-preview-confirmed",
  "wrong-confirmation-refused-without-residue",
  "operator-lifecycle-controls",
  "campaign-import-admitted",
  "import-restart-recovery",
  "live-execution-human-hold",
  "coding-route-and-worktree-custody",
  "campaign-created-commit",
  "commit-bound-proof-executed",
  "merge-human-hold",
  "controlled-landing",
  "terminal-restart-recovery",
]);
const commandTimeoutMs = 180_000;
const productTimeoutMs = 120_000;
const shutdownTimeoutMs = 15_000;

class AcceptanceLedger {
  constructor(expected) {
    this.expected = [...expected];
    this.expectedSet = new Set(expected);
    this.entries = new Map();
  }

  pass(id, evidence) {
    if (!this.expectedSet.has(id)) {
      throw new Error(`CCC_PRODUCT_EXTRA_CHECK: ${id}`);
    }
    if (this.entries.has(id)) {
      throw new Error(`CCC_PRODUCT_DUPLICATE_CHECK: ${id}`);
    }
    this.entries.set(id, {
      id,
      observedAt: new Date().toISOString(),
      evidence,
    });
  }

  finalize() {
    const missing = this.expected.filter((id) => !this.entries.has(id));
    const extra = [...this.entries.keys()].filter((id) => !this.expectedSet.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `CCC_PRODUCT_CHECK_SET_MISMATCH: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
      );
    }
    const ordered = this.expected.map((id) => this.entries.get(id));
    if (ordered.some((entry) => !entry)) {
      throw new Error("CCC_PRODUCT_SKIPPED_CHECK: ordered proof ledger is incomplete");
    }
    return ordered;
  }
}

class CommandFailure extends Error {
  constructor(command, result) {
    super(
      `${command} exited ${result.code ?? `signal ${result.signal}`}`
      + `\nstdout:\n${tail(result.stdout)}`
      + `\nstderr:\n${tail(result.stderr)}`,
    );
    this.name = "CommandFailure";
    this.result = result;
  }
}

function tail(value, lines = 120) {
  return String(value ?? "").split("\n").slice(-lines).join("\n");
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, code, detail) {
  if (!condition) {
    throw new Error(`${code}: ${detail}`);
  }
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directorySnapshot(root, relativeRoot = "") {
  const entries = [];
  const names = await readdir(path.join(root, relativeRoot), {
    withFileTypes: true,
  });
  names.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of names) {
    const relativePath = relativeRoot
      ? path.join(relativeRoot, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      entries.push(...await directorySnapshot(root, relativePath));
      continue;
    }
    assert(
      entry.isFile(),
      "CCC_PRODUCT_RESIDUE_SNAPSHOT_UNSUPPORTED_ENTRY",
      relativePath,
    );
    entries.push(
      `file:${relativePath}:sha256:${sha256(await readFile(path.join(root, relativePath)))}`,
    );
  }
  return entries;
}

function exactArray(actual, expected, code) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    code,
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

async function run(command, args, options = {}) {
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, timedOut };
      if (timedOut || code === null || !allowedExitCodes.has(code)) {
        reject(new CommandFailure(`${command} ${args.join(" ")}`, result));
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, ...args) {
  const result = await run("/usr/bin/git", args, { cwd });
  return result.stdout.trim();
}

async function repositorySnapshot() {
  const [headCommit, headTree, status] = await Promise.all([
    git(repoRoot, "rev-parse", "HEAD^{commit}"),
    git(repoRoot, "rev-parse", "HEAD^{tree}"),
    git(
      repoRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
  ]);
  return { headCommit, headTree, status };
}

function assertRepositoryClean(snapshot, phase) {
  assert(
    snapshot.status === "",
    "CCC_PRODUCT_REPOSITORY_DIRTY",
    `${phase} repository status is not clean:\n${snapshot.status}`,
  );
}

function assertRepositoryUnchanged(start, end) {
  assert(
    end.status === "",
    "CCC_PRODUCT_REPOSITORY_STATUS_DRIFT",
    `ending repository status is not clean:\n${end.status}`,
  );
  assert(
    start.headCommit === end.headCommit && start.headTree === end.headTree,
    "CCC_PRODUCT_REPOSITORY_DRIFT",
    JSON.stringify({ start, end }),
  );
}

function jsonOutput(result, label) {
  const candidates = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  assert(
    candidates.length === 1,
    "CCC_PRODUCT_JSON_OUTPUT_AMBIGUOUS",
    `${label} emitted ${candidates.length} JSON objects\n${tail(result.stdout)}`,
  );
  try {
    return JSON.parse(candidates[0]);
  } catch (error) {
    throw new Error(
      `CCC_PRODUCT_JSON_OUTPUT_INVALID: ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function availablePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createNetServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
    if (port !== 4040) return port;
  }
  throw new Error("CCC_PRODUCT_PORT_UNAVAILABLE");
}

async function poll(label, read, accept, diagnose, timeoutMs = productTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastError;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      lastError = undefined;
      if (accept(latest)) return latest;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const diagnostic = diagnose ? await diagnose().catch((error) => String(error)) : undefined;
  throw new Error(
    `CCC_PRODUCT_POLL_TIMEOUT: ${label}; latest=${JSON.stringify(latest)}`
    + `; error=${lastError instanceof Error ? lastError.message : String(lastError ?? "")}`
    + `; diagnostic=${JSON.stringify(diagnostic)}`,
  );
}

function cleanEnvironment(isolatedHome, fakeBin) {
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, ".codex"),
    PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    FUSION_SKIP_ONBOARDING: "1",
  };
  for (const key of [
    "DATABASE_URL",
    "FUSION_NO_EMBEDDED_PG",
    "PORT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "DATABASE_MIGRATION_URL",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (
      key === "VITEST"
      || key.startsWith("VITEST_")
      || key === "NODE_ENV" && env[key] === "test"
      || key.startsWith("FUSION_TEST_")
    ) {
      delete env[key];
    }
  }
  return env;
}

async function startNativeAuthoringServer(proposalText) {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
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
      if (
        request.method !== "POST"
        || request.url !== "/v1/chat/completions"
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (body.stream !== true) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: "CCC_PRODUCT_NATIVE_AUTHORING_STREAM_REQUIRED",
        }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    address && typeof address === "object",
    "CCC_PRODUCT_AUTHORING_SERVER_ADDRESS_INVALID",
    JSON.stringify(address),
  );
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

async function stopNativeAuthoringServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function assertExactImplementationFactProvenance(
  sidecar,
  packetRoot,
  sourcePath,
  expected,
) {
  const provenance = sidecar.implementationFactProvenance;
  assert(
    provenance?.schema === "ccc-prd.implementation-fact-provenance.v1",
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROVENANCE_MISSING",
    JSON.stringify(provenance),
  );
  assert(
    Array.isArray(provenance.admittedWriteRoots)
      && provenance.admittedWriteRoots.length === 2
      && Array.isArray(provenance.nonGoals)
      && provenance.nonGoals.length === 1
      && Array.isArray(provenance.requirements)
      && provenance.requirements.length === 1
      && Array.isArray(provenance.proofs)
      && provenance.proofs.length === 1
      && Array.isArray(provenance.proofs[0]?.negativeControls)
      && provenance.proofs[0].negativeControls.length === 1
      && Array.isArray(provenance.protectedActions)
      && provenance.protectedActions.length === 2,
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROVENANCE_CARDINALITY",
    JSON.stringify(provenance),
  );
  exactArray(
    provenance.requirements.map(({ id }) => id),
    ["REQ-VERTICAL"],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_REQUIREMENT_DRIFT",
  );
  exactArray(
    provenance.proofs.map(({ id }) => id),
    ["PROOF-VERTICAL"],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_PROOF_DRIFT",
  );
  exactArray(
    provenance.protectedActions.map(({ id }) => id),
    ["ACTION-VERTICAL-LIVE", "ACTION-VERTICAL-MERGE"],
    "CCC_PRODUCT_IMPLEMENTATION_FACT_ACTION_DRIFT",
  );
  const actionBindings = new Map(
    provenance.protectedActions.map((action) => [action.id, action]),
  );
  const bindings = [
    ["targetRepository.path", provenance.targetRepository?.path, expected.targetRoot],
    ["targetRepository.baseCommit", provenance.targetRepository?.baseCommit, expected.targetBase],
    ["bounds.maxRequests", provenance.bounds?.maxRequests, 1],
    ["bounds.maxDurationMs", provenance.bounds?.maxDurationMs, 120_000],
    ["bounds.maxConcurrency", provenance.bounds?.maxConcurrency, 1],
    [
      "admittedWriteRoots[0].path",
      provenance.admittedWriteRoots[0]?.path,
      expected.fusionStateWriteRoot,
    ],
    [
      "admittedWriteRoots[0].purpose",
      provenance.admittedWriteRoots[0]?.purpose,
      "Fusion-managed campaign state and artifacts",
    ],
    [
      "admittedWriteRoots[1].path",
      provenance.admittedWriteRoots[1]?.path,
      expected.admittedWriteRoot,
    ],
    [
      "admittedWriteRoots[1].purpose",
      provenance.admittedWriteRoots[1]?.purpose,
      "disposable product acceptance repository",
    ],
    [
      "nonGoals[0]",
      provenance.nonGoals[0],
      "Modify any path outside src/value.txt.",
    ],
    [
      "requirements[0].acceptance",
      provenance.requirements[0]?.acceptance,
      "The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.",
    ],
    ["proofs[0].command", provenance.proofs[0]?.command, "task verify:vertical"],
    [
      "proofs[0].positiveOracle",
      provenance.proofs[0]?.positiveOracle,
      "The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
    ],
    [
      "proofs[0].negativeControls[0]",
      provenance.proofs[0]?.negativeControls?.[0],
      "The same verifier exits nonzero for the frozen planted bad value.",
    ],
    [
      "protectedActions[ACTION-VERTICAL-LIVE].kind",
      actionBindings.get("ACTION-VERTICAL-LIVE")?.kind,
      "live_execution",
    ],
    [
      "protectedActions[ACTION-VERTICAL-LIVE].target",
      actionBindings.get("ACTION-VERTICAL-LIVE")?.target,
      "provider://openai/TASK-VERTICAL",
    ],
    [
      "protectedActions[ACTION-VERTICAL-MERGE].kind",
      actionBindings.get("ACTION-VERTICAL-MERGE")?.kind,
      "merge",
    ],
    [
      "protectedActions[ACTION-VERTICAL-MERGE].target",
      actionBindings.get("ACTION-VERTICAL-MERGE")?.target,
      "refs/heads/main",
    ],
  ];
  const contextFacts = new Set([
    "targetRepository.path",
    "targetRepository.baseCommit",
    "bounds.maxRequests",
    "bounds.maxDurationMs",
    "bounds.maxConcurrency",
    "admittedWriteRoots[0].path",
    "admittedWriteRoots[0].purpose",
    "admittedWriteRoots[1].path",
    "admittedWriteRoots[1].purpose",
  ]);
  const sources = new Map();
  const sourceFor = async (sourceRelativePath) => {
    if (!sources.has(sourceRelativePath)) {
      sources.set(
        sourceRelativePath,
        await readFile(path.join(packetRoot, sourceRelativePath)),
      );
    }
    return sources.get(sourceRelativePath);
  };
  const displayPosition = (source, byteOffset) => {
    const lines = source.subarray(0, byteOffset).toString("utf8").split("\n");
    return {
      line: lines.length,
      column: Array.from(lines.at(-1) ?? "").length + 1,
    };
  };
  const spans = [];
  for (const [label, binding, value] of bindings) {
    assert(
      binding?.value === value
        && Array.isArray(binding.spans)
        && binding.spans.length === 1,
      "CCC_PRODUCT_IMPLEMENTATION_FACT_BINDING_INVALID",
      `${label}: ${JSON.stringify(binding)}`,
    );
    const [span] = binding.spans;
    const expectedSourcePath = contextFacts.has(label)
      ? expected.contextSourcePath
      : sourcePath;
    const source = await sourceFor(expectedSourcePath);
    const sourceSha256 = sha256(source);
    const excerpt = source.subarray(span.byteStart, span.byteEnd);
    const expectedStart = displayPosition(source, span.byteStart);
    const expectedEnd = displayPosition(source, span.byteEnd);
    assert(
      span.path === expectedSourcePath
        && Number.isSafeInteger(span.byteStart)
        && Number.isSafeInteger(span.byteEnd)
        && span.byteStart >= 0
        && span.byteEnd > span.byteStart
        && span.byteEnd <= source.length
        && Number.isSafeInteger(span.line)
        && span.line > 0
        && Number.isSafeInteger(span.column)
        && span.column > 0
        && Number.isSafeInteger(span.endLine)
        && Number.isSafeInteger(span.endColumn)
        && span.line === expectedStart.line
        && span.column === expectedStart.column
        && span.endLine === expectedEnd.line
        && span.endColumn === expectedEnd.column
        && span.sha256 === sourceSha256
        && span.excerptSha256 === sha256(excerpt)
        && excerpt.toString("utf8") === String(value),
      "CCC_PRODUCT_IMPLEMENTATION_FACT_SPAN_INVALID",
      `${label}: ${JSON.stringify({ span, excerpt: excerpt.toString("utf8") })}`,
    );
    spans.push({
      fact: label,
      value,
      path: span.path,
      byteStart: span.byteStart,
      byteEnd: span.byteEnd,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
      excerptSha256: span.excerptSha256,
    });
  }
  return {
    schema: provenance.schema,
    sourcePaths: [...sources.keys()],
    sourceSha256ByPath: Object.fromEntries(
      [...sources].map(([path, source]) => [path, sha256(source)]),
    ),
    bindingCount: spans.length,
    spans,
  };
}

async function buildCurrentCli(ledger) {
  const startedAt = Date.now();
  const builds = [
    ["@fusion/core", "build"],
    ["@fusion/engine", "build"],
    ["@fusion/dashboard", "build"],
    ["@runfusion/fusion", "build"],
  ];
  for (const [workspace, script] of builds) {
    process.stdout.write(`ccc-prd-product-acceptance: building ${workspace}\n`);
    await run("pnpm", ["--filter", workspace, script], {
      cwd: repoRoot,
      timeoutMs: 300_000,
    });
  }
  const outputs = [
    "packages/core/dist/index.js",
    "packages/engine/dist/cli-agent/task-session.js",
    "packages/dashboard/dist/routes/cli-agent-hooks.js",
    "packages/cli/dist/bin.js",
  ];
  const evidence = [];
  for (const relativePath of outputs) {
    const absolutePath = path.join(repoRoot, relativePath);
    const metadata = await stat(absolutePath);
    const bytes = await readFile(absolutePath);
    evidence.push({
      path: relativePath,
      sha256: sha256(bytes),
      mtime: metadata.mtime.toISOString(),
    });
  }
  const engineTaskSession = await readFile(
    path.join(repoRoot, "packages/engine/dist/cli-agent/task-session.js"),
    "utf8",
  );
  const dashboardHooks = await readFile(
    path.join(repoRoot, "packages/dashboard/dist/routes/cli-agent-hooks.js"),
    "utf8",
  );
  assert(
    engineTaskSession.includes("notifyProgram: notifyScriptPath"),
    "CCC_PRODUCT_STALE_ENGINE_BUILD",
    "built task-session lacks the session-scoped Codex notify binding",
  );
  assert(
    dashboardHooks.includes('body.type === "agent-turn-complete"'),
    "CCC_PRODUCT_STALE_DASHBOARD_BUILD",
    "built hook route lacks Codex positive-completion parsing",
  );
  const prdHelp = await run(
    process.execPath,
    [cliBin, "prd", "--help"],
    { cwd: repoRoot },
  );
  const prdProductUsage = await run(
    process.execPath,
    [cliBin, "prd", "preview"],
    { cwd: repoRoot, allowedExitCodes: [2] },
  );
  const prdUsage = `${prdHelp.stdout}\n${prdProductUsage.stdout}`;
  for (const command of [
    "fn prd author",
    "fn prd discover",
    "fn prd freeze",
    "fn prd policy",
    "fn prd validate",
    "fn prd compile",
    "fn prd preview",
    "fn prd import",
    "fn prd inspect",
    "fn prd reconcile",
    "fn prd status",
    "fn prd pause",
    "fn prd resume",
    "fn prd stop",
    "fn prd resolve-proof",
    "fn prd resolve-provider",
    "fn prd approve-execution",
    "fn prd approve-merge",
  ]) {
    assert(
      prdUsage.includes(command),
      "CCC_PRODUCT_STALE_CLI_BUILD",
      `built CLI usage is missing ${command}`,
    );
  }
  const [headCommit, headTree] = (
    await run("/usr/bin/git", ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"], {
      cwd: repoRoot,
    })
  ).stdout.trim().split("\n");
  ledger.pass("built-cli-current-run", {
    startedAt,
    completedAt: Date.now(),
    headCommit,
    headTree,
    outputs: evidence,
    publicPrdCommands: [
      "author",
      "discover",
      "freeze",
      "policy",
      "validate",
      "compile",
      "preview",
      "import",
      "inspect",
      "reconcile",
      "status",
      "pause",
      "resume",
      "stop",
      "resolve-proof",
      "resolve-provider",
      "approve-execution",
      "approve-merge",
    ],
  });
}

async function initializeTarget(targetRoot) {
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(
    path.join(targetRoot, ".gitignore"),
    [".fusion/", ".fusion-global-settings/", ".worktrees/", ""].join("\n"),
  );
  await writeFile(path.join(targetRoot, "src/value.txt"), "bad\n");
  await writeFile(
    path.join(targetRoot, "verify.cjs"),
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
    path.join(targetRoot, "Taskfile.yml"),
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
  await git(targetRoot, "init", "-q", "-b", "main");
  await git(targetRoot, "config", "user.name", "CCC Product Acceptance");
  await git(
    targetRoot,
    "config",
    "user.email",
    "ccc-product-acceptance@example.invalid",
  );
  await git(
    targetRoot,
    "add",
    "--",
    ".gitignore",
    "Taskfile.yml",
    "src/value.txt",
    "verify.cjs",
  );
  await git(targetRoot, "commit", "-q", "-m", "frozen product baseline");
  return await git(targetRoot, "rev-parse", "HEAD");
}

async function createPacket(packetRoot, targetRoot, targetBase, env) {
  const activeProjectsRoot = path.join(path.dirname(packetRoot), "active-projects");
  const projectName = "vertical-slice";
  const projectRoot = path.join(activeProjectsRoot, projectName);
  const prdFileName = "PRJ-HUM-CCCProductVerticalSlice-PRD-v1.0.0.md";
  const prdSourcePath = path.join(projectRoot, prdFileName);
  const supportRelativePath = "support/REF-HUM-VerticalVerifier.md";
  const supportSourcePath = path.join(projectRoot, supportRelativePath);
  const requirementLine = [
    "- REQ-VERTICAL: Change src/value.txt from bad to good in an isolated worktree.",
    "Acceptance: The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.",
    "Proof command: task verify:vertical.",
    "Positive oracle: The verifier prints POSITIVE_ORACLE_PASS and exits zero for the campaign commit.",
    "Negative control: The same verifier exits nonzero for the frozen planted bad value.",
  ].join(" ");
  const targetRepositoryLine = "- Target repository: " + targetRoot;
  const baselineLine = "- Baseline commit: " + targetBase;
  const taskOwnedPathLine = "- Task owned path: src/value.txt";
  const taskAllowedWriteRootLine = "- Task allowed write root: src/value.txt";
  const fusionStateWriteRoot = path.join(targetRoot, ".fusion");
  const admittedWriteRoot = path.join(targetRoot, "src/value.txt");
  const fusionStateWriteRootLine =
    "- Allowed write root: " + fusionStateWriteRoot;
  const allowedWriteRootLine = "- Allowed write root: " + admittedWriteRoot;
  const fusionStateWriteRootPurposeLine =
    "- Allowed write root purpose: Fusion-managed campaign state and artifacts";
  const allowedWriteRootPurposeLine =
    "- Allowed write root purpose: disposable product acceptance repository";
  const maxRequestsLine = "- Maximum requests: 1";
  const maxDurationLine = "- Maximum duration in milliseconds: 120000";
  const maxConcurrencyLine = "- Maximum concurrency: 1";
  const nonGoalLine =
    "- Non-goal: Modify any path outside src/value.txt.";
  const liveActionLine =
    "- Protected action: live_execution provider://openai/TASK-VERTICAL requires explicit human approval.";
  const mergeActionLine =
    "- Protected action: merge refs/heads/main requires separate explicit human approval.";
  const supportingContextLine =
    "[[support/REF-HUM-VerticalVerifier]] documents the disposable verifier.";
  const prd = [
    "---",
    "type: prd",
    "status: active",
    "version: 1.0.0",
    "---",
    "",
    "# CCC Fusion Product Vertical Slice",
    "",
    "## Implementation contract",
    "",
    nonGoalLine,
    "",
    "## Protected actions",
    "",
    liveActionLine,
    mergeActionLine,
    "",
    "## Requirement and proof",
    "",
    requirementLine,
    "",
    "## Supporting context",
    "",
    supportingContextLine,
    "",
  ].join("\n");
  const support = [
    "# Vertical verifier",
    "",
    "The owned verifier reads src/value.txt and accepts only the value good.",
    "",
  ].join("\n");
  await mkdir(path.dirname(supportSourcePath), { recursive: true });
  await writeFile(prdSourcePath, prd);
  await writeFile(supportSourcePath, support);
  const prdSourceSha256 = sha256(await readFile(prdSourcePath));

  const discovery = jsonOutput(
    await run(
      process.execPath,
      [cliBin, "prd", "discover", activeProjectsRoot],
      { cwd: targetRoot, env },
    ),
    "prd discover",
  );
  const discoveredProject = discovery.projects?.find(
    ({ project }) => project === projectName,
  );
  assert(
    discoveredProject?.selection?.kind === "selected"
    && discoveredProject.selection.selectedPrdPath === prdSourcePath,
    "CCC_PRODUCT_CURRENT_PRD_DISCOVERY_FAILED",
    JSON.stringify(discoveredProject),
  );

  const frozen = jsonOutput(
    await run(
      process.execPath,
      [
        cliBin,
        "prd",
        "freeze",
        activeProjectsRoot,
        prdSourcePath,
        packetRoot,
        "--target",
        targetRoot,
        "--base",
        targetBase,
        "--owned-path",
        "src/value.txt",
        "--write-root",
        "src/value.txt",
        "--write-purpose",
        "disposable product acceptance repository",
        "--max-requests",
        "1",
        "--max-duration-ms",
        "120000",
        "--max-concurrency",
        "1",
      ],
      { cwd: targetRoot, env },
    ),
    "prd freeze",
  );
  assert(
    frozen.schema === "ccc-prd.freeze-result.v1"
    && frozen.packet?.fileCount === 3
    && frozen.packet?.unresolvedReferenceCount === 0
    && frozen.unresolvedReferences?.length === 0,
    "CCC_PRODUCT_CURRENT_PRD_FREEZE_FAILED",
    JSON.stringify(frozen),
  );
  const freezeReceipt = JSON.parse(await readFile(frozen.receiptPath, "utf8"));
  exactArray(
    freezeReceipt.entries?.map(({ projectRelativePath }) => projectRelativePath),
    [
      prdFileName,
      "__fusion__/REF-HUM-FusionOperatorContext.md",
      supportRelativePath,
    ],
    "CCC_PRODUCT_FROZEN_SOURCE_SET_DRIFT",
  );
  const operatorContextReceipt = freezeReceipt.entries?.find(
    ({ projectRelativePath }) =>
      projectRelativePath === "__fusion__/REF-HUM-FusionOperatorContext.md",
  );
  assert(
    operatorContextReceipt?.originPath
      === "operator-context://ccc-prd.operator-context.v1"
      && operatorContextReceipt.role === "support"
      && operatorContextReceipt.authoritative === true,
    "CCC_PRODUCT_GUIDED_CONTEXT_RECEIPT_INVALID",
    JSON.stringify(operatorContextReceipt),
  );
  assert(
    sha256(await readFile(prdSourcePath)) === prdSourceSha256,
    "CCC_PRODUCT_GUIDED_FREEZE_CHANGED_PRD",
    prdSourcePath,
  );

  const manifestPath = frozen.manifestPath;
  const proposalPath = path.join(packetRoot, "authoring-proposal.json");
  const sidecarPath = path.join(packetRoot, "candidate.sidecar.json");
  const executionPlanPath = path.join(packetRoot, "execution-plan.json");
  const frozenPrdRelativePath = `sources/${prdFileName}`;
  const frozenContextRelativePath =
    "sources/__fusion__/REF-HUM-FusionOperatorContext.md";
  const sourceRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: requirementLine,
  }];
  const implementationRefs = [
    targetRepositoryLine,
    baselineLine,
    taskOwnedPathLine,
    taskAllowedWriteRootLine,
    fusionStateWriteRootLine,
    allowedWriteRootLine,
    fusionStateWriteRootPurposeLine,
    allowedWriteRootPurposeLine,
    maxRequestsLine,
    maxDurationLine,
    maxConcurrencyLine,
  ].map((exactQuote) => ({
    path: frozenContextRelativePath,
    exactQuote,
  }));
  const nonGoalRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: nonGoalLine,
  }];
  const liveActionRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: liveActionLine,
  }];
  const mergeActionRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: mergeActionLine,
  }];
  const supportingRefs = [{
    path: frozenPrdRelativePath,
    exactQuote: supportingContextLine,
  }];
  const proposal = {
    schema: "ccc-prd.authoring-proposal.v1",
    authorityRoles: [
      {
        id: "AUTHORITY-VERTICAL",
        role: "root",
        sourcePaths: [frozenPrdRelativePath],
        accountableProducer: "product-owner",
      },
      {
        id: "AUTHORITY-VERTICAL-CONTEXT",
        role: "support",
        sourcePaths: [frozenContextRelativePath],
        accountableProducer: "operator",
      },
    ],
    requirements: [{
      id: "REQ-VERTICAL",
      statement:
        "Change src/value.txt from bad to good in an isolated worktree.",
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
      ownedPaths: ["src/value.txt"],
      allowedWriteRoots: ["src/value.txt"],
      accountableProducer: "campaign-coding-agent",
      requirementIds: ["REQ-VERTICAL"],
      dependencyTaskIds: [],
      proofIds: ["PROOF-VERTICAL"],
      workflowId: "WORKFLOW-VERTICAL",
      documentIds: [],
      artifactIds: [],
      protectedActionIds: [
        "ACTION-VERTICAL-LIVE",
        "ACTION-VERTICAL-MERGE",
      ],
      sourceRefs: [
        ...implementationRefs,
        ...nonGoalRefs,
        ...sourceRefs,
        ...liveActionRefs,
        ...mergeActionRefs,
        ...supportingRefs,
      ],
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
        target: "provider://openai/TASK-VERTICAL",
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
    admittedWriteRoots: [
      {
        path: fusionStateWriteRoot,
        purpose: "Fusion-managed campaign state and artifacts",
      },
      {
        path: admittedWriteRoot,
        purpose: "disposable product acceptance repository",
      },
    ],
    targetRepository: { path: targetRoot, baseCommit: targetBase },
    nonGoals: ["Modify any path outside src/value.txt."],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    confidence: "high",
  };
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  return {
    manifestPath,
    proposalPath,
    sidecarPath,
    executionPlanPath,
    sourcePath: frozenPrdRelativePath,
    contextSourcePath: frozenContextRelativePath,
    operatorContext: {
      originPath: operatorContextReceipt.originPath,
      sha256: operatorContextReceipt.sha256,
      prdSourceSha256,
      sourceUnchanged: true,
    },
    discovery: {
      project: projectName,
      selectedPrdPath: discoveredProject.selection.selectedPrdPath,
    },
    freeze: {
      packetHash: frozen.packet.packetHash,
      manifestSha256: frozen.packet.manifestSha256,
      receiptSha256: frozen.packet.receiptSha256,
      fileCount: frozen.packet.fileCount,
      entries: freezeReceipt.entries.map((entry) => ({
        relativePath: entry.relativePath,
        role: entry.role,
        authoritative: entry.authoritative,
        sha256: entry.sha256,
      })),
      unresolvedReferenceCount: frozen.packet.unresolvedReferenceCount,
    },
  };
}

async function writeFakeCodex(fakeBin) {
  await mkdir(fakeBin, { recursive: true });
  const fakeCodexPath = path.join(fakeBin, "codex");
  await writeFile(
    fakeCodexPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "let notifyProgram;",
      "for (let index = 0; index < args.length - 1; index += 1) {",
      "  if (args[index] !== '-c' || !args[index + 1].startsWith('notify=')) continue;",
      "  const parsed = JSON.parse(args[index + 1].slice('notify='.length));",
      "  notifyProgram = Array.isArray(parsed) ? parsed[0] : undefined;",
      "}",
      "if (!notifyProgram) {",
      "  process.stderr.write('FAKE_CODEX_NOTIFY_PROGRAM_MISSING\\n');",
      "  process.exit(9);",
      "}",
      "let handled = false;",
      "let injectedPrompt = '';",
      "if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {",
      "  process.stdin.setRawMode(true);",
      "}",
      "process.stdout.write('\\u001b[?2004h>\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  if (handled) return;",
      "  injectedPrompt += chunk;",
      "  if (!injectedPrompt.includes('\\u001b[201~\\r')) return;",
      "  handled = true;",
      "  const requiredPromptFacts = [",
      "    'Change src/value.txt from bad to good in an isolated worktree.',",
      "    'The exact verifier node verify.cjs must reject the planted bad value and accept the corrected good value.',",
      "    'Allowed write roots:\\n- src/value.txt',",
      "    'Modify any path outside src/value.txt.',",
      "    'requires human decision approve_merge',",
      "    'Do not run git add, git commit, or mutate Git refs',",
      "  ];",
      "  const missingPromptFacts = requiredPromptFacts.filter((fact) => !injectedPrompt.includes(fact));",
      "  if (missingPromptFacts.length > 0) {",
      "    process.stderr.write(`FAKE_CODEX_SEALED_PROMPT_MISSING:${JSON.stringify(missingPromptFacts)}\\n`);",
      "    process.exit(10);",
      "  }",
      "  fs.writeFileSync('src/value.txt', 'good\\n');",
      "  const payload = JSON.stringify({",
      "    type: 'agent-turn-complete',",
      "    'thread-id': `acceptance-${process.pid}`,",
      "    'turn-id': 'turn-1',",
      "    cwd: process.cwd(),",
      "    'last-assistant-message': 'admitted source edit ready for controller commit',",
      "  });",
      "  const notified = spawnSync(notifyProgram, [payload], { encoding: 'utf8' });",
      "  if (notified.status !== 0) {",
      "    process.stderr.write(`FAKE_CODEX_NOTIFY_FAILED:${JSON.stringify(notified)}\\n`);",
      "    process.exit(8);",
      "  }",
      "  process.stdout.write('CAMPAIGN_SOURCE_EDIT_READY\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o700);
}

async function startServe(targetRoot, env, port) {
  const child = spawn(
    process.execPath,
    [
      cliBin,
      "serve",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: targetRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const server = {
    child,
    exited,
    output: () => output,
  };
  const health = `http://127.0.0.1:${port}/api/health`;
  try {
    await poll(
      "fn serve health",
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
          const response = await fetch(health, { signal: controller.signal });
          const body = await response.json();
          return { httpStatus: response.status, body };
        } finally {
          clearTimeout(timer);
        }
      },
      (result) =>
        result.httpStatus === 200
        && result.body?.status === "ok"
        && result.body?.holding !== true
        && result.body?.engine?.available === true
        && result.body?.database?.healthy === true
        && result.body?.taskIdIntegrity?.status === "ok",
      async () => ({ output: tail(output), exit: await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve("still-running"), 10)),
      ]) }),
      180_000,
    );
  } catch (error) {
    await stopServe(server);
    throw error;
  }
  return server;
}

async function stopServe(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const result = await Promise.race([
    server.exited,
    new Promise((resolve) => setTimeout(() => resolve(null), shutdownTimeoutMs)),
  ]);
  if (result === null && server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await server.exited;
  }
}

async function main() {
  const ledger = new AcceptanceLedger(expectedChecks);
  const startedAt = new Date();
  let tempRoot;
  let server;
  let restartedServer;
  let authoringServer;
  let repositoryStart;
  try {
    repositoryStart = await repositorySnapshot();
    assertRepositoryClean(repositoryStart, "starting");
    await buildCurrentCli(ledger);
    tempRoot = await mkdtemp(path.join(tmpdir(), "ccc-prd-product-acceptance-"));
    const targetRoot = await realpath(
      await mkdir(path.join(tempRoot, "target"), { recursive: true })
        .then(() => path.join(tempRoot, "target")),
    );
    const packetRoot = path.join(tempRoot, "packet");
    const isolatedHome = await realpath(
      await mkdir(path.join(tempRoot, "home"), { recursive: true })
        .then(() => path.join(tempRoot, "home")),
    );
    const fakeBin = path.join(tempRoot, "fake-bin");
    const worktreesRoot = path.join(tempRoot, "worktrees");
    await writeFakeCodex(fakeBin);
    const env = cleanEnvironment(isolatedHome, fakeBin);
    const targetBase = await initializeTarget(targetRoot);
    const packet = await createPacket(packetRoot, targetRoot, targetBase, env);
    ledger.pass("current-prd-discovered-and-frozen", {
      discovery: packet.discovery,
      freeze: packet.freeze,
    });
    ledger.pass("guided-operator-context-frozen", {
      sourcePath: packet.contextSourcePath,
      ...packet.operatorContext,
    });
    const idempotencyKey = `ccc-product-${randomUUID()}`;

    const planted = await run(process.execPath, ["verify.cjs"], {
      cwd: targetRoot,
      env,
      allowedExitCodes: [1],
    });
    assert(
      planted.stderr.includes("POSITIVE_ORACLE_FAIL:bad"),
      "CCC_PRODUCT_NEGATIVE_CONTROL_MISSING",
      tail(planted.stderr),
    );
    ledger.pass("planted-defect-rejected", {
      exitCode: planted.code,
      stderrSha256: sha256(planted.stderr),
      signature: "POSITIVE_ORACLE_FAIL:bad",
    });

    const prd = async (args, allowedExitCodes = [0]) => {
      return await run(process.execPath, [cliBin, "prd", ...args], {
        cwd: targetRoot,
        env,
        allowedExitCodes,
      });
    };
    const commonPacketArgs = [
      packetRoot,
      packet.manifestPath,
      packet.sidecarPath,
      packet.executionPlanPath,
      targetRoot,
      targetBase,
    ];

    const proposalText = await readFile(packet.proposalPath, "utf8");
    const nativeAuthoring = await startNativeAuthoringServer(proposalText);
    authoringServer = nativeAuthoring.server;
    const loopbackAuthoringApiKey = "ccc-local-loopback-non-secret";
    const globalSettingsDir = path.join(isolatedHome, ".fusion");
    const globalSettingsPath = path.join(globalSettingsDir, "settings.json");
    await mkdir(globalSettingsDir, { recursive: true });
    await writeFile(globalSettingsPath, `${JSON.stringify({
      customProviders: [{
        id: "550e8400-e29b-41d4-a716-446655440004",
        name: "CCC Product Authoring",
        apiType: "openai-compatible",
        baseUrl: nativeAuthoring.baseUrl,
        apiKey: loopbackAuthoringApiKey,
        models: [{
          id: "vertical-authoring-model",
          name: "Vertical Authoring Model",
        }],
      }],
    }, null, 2)}\n`);
    const authored = jsonOutput(
      await prd([
        "author",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        "--target",
        targetRoot,
        "--base",
        targetBase,
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
      ]),
      "prd native local author",
    );
    assert(
      authored.kind === "candidate",
      "CCC_PRODUCT_NATIVE_AUTHORING_FAILED",
      JSON.stringify(authored),
    );
    const generationRequests = nativeAuthoring.requests.filter(
      ({ method }) => method === "POST",
    );
    assert(
      generationRequests.length === 1
        && generationRequests[0].url === "/v1/chat/completions"
        && generationRequests[0].body?.model === "vertical-authoring-model"
        && generationRequests[0].body?.stream === true
        && generationRequests[0].headers?.authorization
          === `Bearer ${loopbackAuthoringApiKey}`
        && JSON.stringify(generationRequests[0].body?.messages).includes(
          "Every implementation-changing fact must be source-bound",
        )
        && JSON.stringify(generationRequests[0].body?.messages).includes(
          "CCC Fusion Product Vertical Slice",
        )
        && JSON.stringify(generationRequests[0].body?.messages).includes(
          "Fusion Reviewed Operator Context",
        ),
      "CCC_PRODUCT_NATIVE_AUTHORING_REQUEST_INVALID",
      JSON.stringify(generationRequests),
    );
    const authoredSidecar = JSON.parse(
      await readFile(packet.sidecarPath, "utf8"),
    );
    assert(
      authoredSidecar.provenance?.authoringAdapterId
        === "fusion-native-model-runtime-v1"
        && authoredSidecar.provenance?.authoringModel
          === "ccc-product-authoring/vertical-authoring-model",
      "CCC_PRODUCT_NATIVE_AUTHORING_PROVENANCE_INVALID",
      JSON.stringify(authoredSidecar.provenance),
    );
    const taskSpanPaths = [...new Set(
      authoredSidecar.tasks?.[0]?.spans?.map(({ path }) => path) ?? [],
    )].sort();
    assert(
      taskSpanPaths.includes(packet.sourcePath)
        && taskSpanPaths.includes(packet.contextSourcePath),
      "CCC_PRODUCT_TASK_CUSTODY_SOURCE_BINDING_MISSING",
      JSON.stringify(taskSpanPaths),
    );
    const implementationFactProvenance =
      await assertExactImplementationFactProvenance(
        authoredSidecar,
        packetRoot,
        packet.sourcePath,
        {
          targetRoot,
          targetBase,
          fusionStateWriteRoot: path.join(targetRoot, ".fusion"),
          admittedWriteRoot: path.join(targetRoot, "src/value.txt"),
          contextSourcePath: packet.contextSourcePath,
        },
      );
    const nativeAuthoringEvidence = {
      mode: "native-local-loopback",
      normalCli: true,
      proposalCompatibilityArgumentUsed: false,
      externalProviderCalled: false,
      secretConfigured: false,
      credentialMode: "fixed-disposable-non-secret-sentinel",
      provider: "ccc-product-authoring",
      model: "vertical-authoring-model",
      requestCount: generationRequests.length,
      requestSha256: sha256(JSON.stringify(generationRequests[0].body)),
      promptContractObserved: true,
      taskSpanPaths,
      provenance: authoredSidecar.provenance,
      implementationFactProvenance,
    };
    ledger.pass("native-local-authoring", nativeAuthoringEvidence);
    await stopNativeAuthoringServer(authoringServer);
    authoringServer = undefined;
    const validated = jsonOutput(
      await prd([
        "validate",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd validate",
    );
    const compiled = jsonOutput(
      await prd([
        "compile",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
      ]),
      "prd compile",
    );
    assert(
      validated.kind === "diagnostics" && validated.valid === true,
      "CCC_PRODUCT_PACKET_VALIDATION_FAILED",
      JSON.stringify(validated),
    );
    exactArray(
      compiled.requirements?.map(({ id }) => id),
      ["REQ-VERTICAL"],
      "CCC_PRODUCT_REQUIREMENT_SET_DRIFT",
    );
    exactArray(
      compiled.tasks?.map(({ id }) => id),
      ["TASK-VERTICAL"],
      "CCC_PRODUCT_TASK_SET_DRIFT",
    );
    exactArray(
      compiled.proofs?.map(({ id }) => id),
      ["PROOF-VERTICAL"],
      "CCC_PRODUCT_PROOF_SET_DRIFT",
    );
    ledger.pass("frozen-packet-validated", {
      packetHash: compiled.sourceHash,
      sidecarHash: compiled.sidecarHash,
      bundleHash: compiled.bundleHash,
      requirementIds: ["REQ-VERTICAL"],
      taskIds: ["TASK-VERTICAL"],
      proofIds: ["PROOF-VERTICAL"],
    });

    const generatedExecutionPlan = jsonOutput(
      await prd([
        "policy",
        packetRoot,
        packet.manifestPath,
        packet.sidecarPath,
        targetRoot,
        targetBase,
        packet.executionPlanPath,
        "--provider",
        "openai",
        "--model",
        "gpt-5.6-sol",
        "--transport",
        "cli",
        "--cli-adapter",
        "codex",
      ]),
      "prd policy",
    );
    const executionPlanBytes = await readFile(packet.executionPlanPath);
    const executionPlan = JSON.parse(executionPlanBytes.toString("utf8"));
    const executionRoute = executionPlan.policy?.routes?.[0];
    assert(
      generatedExecutionPlan.kind === "execution-plan"
        && generatedExecutionPlan.path === packet.executionPlanPath
        && generatedExecutionPlan.sha256 === sha256(executionPlanBytes)
        && generatedExecutionPlan.routeCount === 1
        && executionPlan.schema === "ccc-prd.execution-plan.v1"
        && executionPlan.packetHash === compiled.sourceHash
        && executionPlan.sidecarHash === compiled.sidecarHash
        && executionPlan.bundleHash === compiled.bundleHash
        && executionRoute?.taskId === "TASK-VERTICAL"
        && executionRoute.providerId === "openai"
        && executionRoute.modelId === "gpt-5.6-sol"
        && executionRoute.transport === "cli"
        && executionRoute.cliAdapterId === "codex"
        && executionRoute.executor === "cli-agent"
        && executionRoute.toolMode === "coding"
        && executionRoute.worktreeMode === "isolated"
        && executionRoute.commitPolicy === "required",
      "CCC_PRODUCT_EXECUTION_PLAN_INVALID",
      JSON.stringify(executionPlan),
    );
    exactArray(
      executionRoute.ownedPaths,
      ["src/value.txt"],
      "CCC_PRODUCT_EXECUTION_PLAN_OWNERSHIP_DRIFT",
    );
    exactArray(
      executionRoute.allowedWriteRoots,
      ["src/value.txt"],
      "CCC_PRODUCT_EXECUTION_PLAN_WRITE_ROOT_DRIFT",
    );
    ledger.pass("product-owned-execution-plan", {
      path: generatedExecutionPlan.path,
      sha256: generatedExecutionPlan.sha256,
      packetHash: executionPlan.packetHash,
      sidecarHash: executionPlan.sidecarHash,
      bundleHash: executionPlan.bundleHash,
      route: executionRoute,
    });

    const globalSettingsBeforeForgedPreview =
      await directorySnapshot(globalSettingsDir);
    const forgedSidecarPath = path.join(packetRoot, "forged.sidecar.json");
    await cp(packet.sidecarPath, forgedSidecarPath);
    const forged = JSON.parse(await readFile(forgedSidecarPath, "utf8"));
    forged.proofs[0].admission.definitionSha256 = "0".repeat(64);
    await writeFile(forgedSidecarPath, `${JSON.stringify(forged, null, 2)}\n`);
    const forgedPreview = jsonOutput(
      await prd([
        "preview",
        packetRoot,
        packet.manifestPath,
        forgedSidecarPath,
        packet.executionPlanPath,
        targetRoot,
        targetBase,
      ], [1]),
      "forged prd preview",
    );
    assert(
      forgedPreview.kind === "refusal",
      "CCC_PRODUCT_FORGED_PROVENANCE_ACCEPTED",
      JSON.stringify(forgedPreview),
    );
    assert(
      forgedPreview.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_PROOF_ADMISSION_STALE",
      ),
      "CCC_PRODUCT_FORGED_PROVENANCE_DIAGNOSTIC_MISSING",
      JSON.stringify(forgedPreview),
    );
    exactArray(
      await directorySnapshot(globalSettingsDir),
      globalSettingsBeforeForgedPreview,
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_DATABASE_RESIDUE",
    );
    assert(
      !await pathExists(path.join(targetRoot, ".fusion")),
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_PROJECT_RESIDUE",
      path.join(targetRoot, ".fusion"),
    );
    assert(
      await git(targetRoot, "status", "--porcelain") === "",
      "CCC_PRODUCT_FORGED_PREVIEW_LEFT_GIT_RESIDUE",
      await git(targetRoot, "status", "--porcelain"),
    );
    assert(
      await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "bad\n",
      "CCC_PRODUCT_FORGED_PREVIEW_MUTATED_SOURCE",
      "src/value.txt changed",
    );
    ledger.pass("forged-provenance-refused-without-residue", {
      diagnostics: forgedPreview.diagnostics,
      targetHead: await git(targetRoot, "rev-parse", "HEAD"),
    });

    const settingsPath = path.join(packetRoot, "settings.json");
    await writeFile(settingsPath, `${JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      global: {
        experimentalFeatures: { cliAgentExecutor: true },
      },
      project: {
        maxConcurrent: 1,
        maxWorktrees: 1,
        pollIntervalMs: 500,
        worktreesDir: worktreesRoot,
      },
    }, null, 2)}\n`);
    await run(
      process.execPath,
      [
        cliBin,
        "settings",
        "import",
        settingsPath,
        "--scope",
        "both",
        "--merge",
        "--yes",
      ],
      { cwd: targetRoot, env, timeoutMs: 240_000 },
    );

    const port = await availablePort();
    server = await startServe(targetRoot, env, port);

    const preview = jsonOutput(
      await prd(["preview", ...commonPacketArgs]),
      "prd preview",
    );
    assert(
      preview.kind === "preview"
      && /^[0-9a-f]{64}$/.test(preview.confirmationDigest),
      "CCC_PRODUCT_PREVIEW_INVALID",
      JSON.stringify(preview),
    );
    exactArray(
      preview.requirements?.map(({ id }) => id),
      ["REQ-VERTICAL"],
      "CCC_PRODUCT_PREVIEW_REQUIREMENTS_DRIFT",
    );
    ledger.pass("exact-preview-confirmed", {
      confirmationDigest: preview.confirmationDigest,
      packetHash: preview.packetHash,
      sidecarHash: preview.sidecarHash,
      bundleHash: preview.bundleHash,
      targetHead: preview.targetHead,
    });

    const wrongConfirmation = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        idempotencyKey,
        "--confirm",
        "0".repeat(64),
      ], [1]),
      "wrong-confirmation import",
    );
    assert(
      wrongConfirmation.kind === "refusal"
      && wrongConfirmation.diagnostics?.some(
        ({ code }) => code === "CCC_PRD_CONFIRMATION_MISMATCH",
      ),
      "CCC_PRODUCT_WRONG_CONFIRMATION_ACCEPTED",
      JSON.stringify(wrongConfirmation),
    );
    const missingStatus = jsonOutput(
      await prd(["status", idempotencyKey], [1]),
      "status after wrong confirmation",
    );
    assert(
      missingStatus.kind === "product-status" && missingStatus.found === false,
      "CCC_PRODUCT_WRONG_CONFIRMATION_LEFT_DATABASE_RESIDUE",
      JSON.stringify(missingStatus),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "bad\n",
      "CCC_PRODUCT_WRONG_CONFIRMATION_LEFT_SOURCE_RESIDUE",
      await git(targetRoot, "status", "--porcelain"),
    );
    ledger.pass("wrong-confirmation-refused-without-residue", {
      diagnosticCode: "CCC_PRD_CONFIRMATION_MISMATCH",
      statusFound: false,
      targetHead: targetBase,
    });

    const importedServer = server;
    await stopServe(importedServer);
    server = undefined;
    const readStatusFor = async (key) => {
      return jsonOutput(
        await prd(["status", key]),
        `prd status ${key}`,
      );
    };
    const lifecycleKey = `${idempotencyKey}-lifecycle`;
    const lifecycleImport = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        lifecycleKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd lifecycle import",
    );
    assert(
      lifecycleImport.kind === "imported"
      && lifecycleImport.result?.state === "active"
      && lifecycleImport.result?.runnable === true,
      "CCC_PRODUCT_LIFECYCLE_IMPORT_NOT_RUNNABLE",
      JSON.stringify(lifecycleImport),
    );
    const lifecycleReady = await readStatusFor(lifecycleKey);
    const pauseControl = lifecycleReady.operatorControls?.find(
      ({ action }) => action === "pause",
    );
    assert(
      pauseControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(pauseControl.confirmation),
      "CCC_PRODUCT_PAUSE_CONFIRMATION_MISSING",
      JSON.stringify(lifecycleReady.operatorControls),
    );
    const paused = jsonOutput(
      await prd([
        "pause",
        lifecycleKey,
        "--confirm",
        pauseControl.confirmation,
      ]),
      "prd campaign pause",
    );
    assert(
      paused.kind === "campaign-paused"
      && paused.result?.workItemState === "held"
      && paused.status?.workItems?.[0]?.state === "held",
      "CCC_PRODUCT_CAMPAIGN_PAUSE_FAILED",
      JSON.stringify(paused),
    );
    const stalePause = jsonOutput(
      await prd([
        "pause",
        lifecycleKey,
        "--confirm",
        pauseControl.confirmation,
      ], [1]),
      "stale campaign pause",
    );
    assert(
      stalePause.kind === "refusal"
      && stalePause.diagnostics?.some(
        ({ code }) =>
          code === "CCC_CAMPAIGN_OPERATOR_CONTROL_CONFIRMATION_REFUSED",
      ),
      "CCC_PRODUCT_STALE_PAUSE_CONFIRMATION_ACCEPTED",
      JSON.stringify(stalePause),
    );
    const resumeControl = paused.operatorControls?.find(
      ({ action }) => action === "resume",
    );
    assert(
      resumeControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(resumeControl.confirmation),
      "CCC_PRODUCT_RESUME_CONFIRMATION_MISSING",
      JSON.stringify(paused.operatorControls),
    );
    const resumed = jsonOutput(
      await prd([
        "resume",
        lifecycleKey,
        "--confirm",
        resumeControl.confirmation,
      ]),
      "prd campaign resume",
    );
    assert(
      resumed.kind === "campaign-resumed"
      && resumed.result?.workItemState === "runnable"
      && resumed.status?.workItems?.[0]?.state === "runnable",
      "CCC_PRODUCT_CAMPAIGN_RESUME_FAILED",
      JSON.stringify(resumed),
    );
    const stopControl = resumed.operatorControls?.find(
      ({ action }) => action === "stop",
    );
    const stopReason =
      "Acceptance canary stops before dispatch and preserves every durable receipt.";
    assert(
      stopControl?.allowed === true
      && /^[0-9a-f]{64}$/u.test(stopControl.confirmation),
      "CCC_PRODUCT_STOP_CONFIRMATION_MISSING",
      JSON.stringify(resumed.operatorControls),
    );
    const stopped = jsonOutput(
      await prd([
        "stop",
        lifecycleKey,
        "--reason",
        stopReason,
        "--confirm",
        stopControl.confirmation,
      ]),
      "prd campaign stop",
    );
    assert(
      stopped.kind === "campaign-stopped"
      && stopped.result?.workItemState === "cancelled"
      && stopped.status?.nextAction?.kind === "abandoned"
      && stopped.status?.workItems?.[0]?.state === "cancelled"
      && stopped.status?.tasks?.every((task) => task.state?.paused === true),
      "CCC_PRODUCT_CAMPAIGN_STOP_FAILED",
      JSON.stringify(stopped),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await readFile(path.join(targetRoot, "src/value.txt"), "utf8")
        === "bad\n",
      "CCC_PRODUCT_LIFECYCLE_CONTROL_CHANGED_SOURCE",
      await git(targetRoot, "status", "--porcelain"),
    );
    ledger.pass("operator-lifecycle-controls", {
      importId: lifecycleImport.result.importId,
      pause: paused.result,
      stalePauseDiagnostic: stalePause.diagnostics[0],
      resume: resumed.result,
      stop: stopped.result,
      nextAction: stopped.status.nextAction,
      targetHead: targetBase,
    });

    const imported = jsonOutput(
      await prd([
        "import",
        ...commonPacketArgs,
        idempotencyKey,
        "--confirm",
        preview.confirmationDigest,
      ]),
      "prd import",
    );
    assert(
      imported.kind === "imported"
      && imported.result?.state === "active"
      && imported.result?.runnable === true,
      "CCC_PRODUCT_IMPORT_NOT_RUNNABLE",
      JSON.stringify(imported),
    );
    ledger.pass("campaign-import-admitted", {
      importId: imported.result.importId,
      state: imported.result.state,
      idempotencyKey,
    });

    const readStatus = async () => readStatusFor(idempotencyKey);
    server = await startServe(targetRoot, env, port);
    assert(
      (
        importedServer.child.exitCode !== null
        || importedServer.child.signalCode !== null
      )
      && importedServer.child.pid !== server.child.pid,
      "CCC_PRODUCT_IMPORT_RESTART_PROCESS_INVALID",
      JSON.stringify({
        stoppedPid: importedServer.child.pid,
        stoppedExitCode: importedServer.child.exitCode,
        stoppedSignal: importedServer.child.signalCode,
        restartedPid: server.child.pid,
      }),
    );
    const postRestartInspection = jsonOutput(
      await prd(["inspect", idempotencyKey]),
      "prd import inspection after restart",
    );
    const postImportRestart = await poll(
      "live execution approval hold after import restart",
      readStatus,
      (value) => value.status?.nextAction?.kind === "approve-execution",
      async () => ({ serve: tail(server.output()), status: await readStatus() }),
    );
    const restartedTask = postImportRestart.status.tasks[0];
    const restartedWorkItem = postImportRestart.status.workItems[0];
    assert(
      postRestartInspection.kind === "inspection"
      && postRestartInspection.found === true
      && postRestartInspection.inspection?.importId === imported.result.importId
      && postRestartInspection.inspection.identityHash === imported.result.identityHash
      && postRestartInspection.inspection.transactionWitness?.transactionId
        === imported.result.transactionWitness?.transactionId
      && postRestartInspection.inspection.state === "active"
      && postRestartInspection.inspection.runnable === true
      && postRestartInspection.inspection.directCounts?.tasks === 1
      && postRestartInspection.inspection.directCounts?.workItems === 1
      && postImportRestart.status.import.importId === imported.result.importId
      && postImportRestart.status.import.identityHash === imported.result.identityHash
      && postImportRestart.status.tasks.length === 1
      && restartedTask?.semanticTaskId === "TASK-VERTICAL"
      && /^[A-Z][A-Z0-9]*-\d+$/u.test(restartedTask.nativeTaskId)
      && restartedTask.nativeTaskId !== restartedTask.semanticTaskId
      && postImportRestart.status.workItems.length === 1
      && restartedWorkItem?.taskId === restartedTask.nativeTaskId
      && restartedWorkItem.runId === `ccc-prd:${imported.result.importId}`
      && restartedWorkItem.stableWorkflowRunId === restartedWorkItem.runId,
      "CCC_PRODUCT_IMPORT_RESTART_RESIDUE_OR_MAPPING_DRIFT",
      JSON.stringify({
        inspection: postRestartInspection,
        import: postImportRestart.status.import,
        tasks: postImportRestart.status.tasks,
        workItems: postImportRestart.status.workItems,
      }),
    );
    ledger.pass("import-restart-recovery", {
      stoppedPid: importedServer.child.pid,
      restartedPid: server.child.pid,
      importId: imported.result.importId,
      identityHash: imported.result.identityHash,
      transactionId: postRestartInspection.inspection.transactionWitness.transactionId,
      importIdentityPersisted: true,
      nativeTaskMapping: {
        semanticTaskId: restartedTask.semanticTaskId,
        nativeTaskId: restartedTask.nativeTaskId,
      },
      counts: {
        tasks: postImportRestart.status.tasks.length,
        workItems: postImportRestart.status.workItems.length,
      },
      nextAction: postImportRestart.status.nextAction,
    });

    const liveHold = postImportRestart;
    assert(
      liveHold.status.workItems.length === 1
      && liveHold.status.workItems[0].state === "manual-required"
      && liveHold.status.workItems[0].lastError
        === "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      "CCC_PRODUCT_LIVE_EXECUTION_HOLD_INVALID",
      JSON.stringify(liveHold.status.workItems),
    );
    assert(
      await git(targetRoot, "rev-parse", "HEAD") === targetBase
      && await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "bad\n",
      "CCC_PRODUCT_EXECUTED_BEFORE_APPROVAL",
      await git(targetRoot, "status", "--porcelain"),
    );
    const liveConfirmation = liveHold.liveExecutionApprovalConfirmations?.find(
      ({ approvalRequestId, status }) =>
        approvalRequestId === liveHold.status.nextAction.approvalRequestId
        && status === "issued",
    );
    assert(
      liveConfirmation
      && /^[0-9a-f]{64}$/.test(liveConfirmation.confirmation),
      "CCC_PRODUCT_LIVE_CONFIRMATION_MISSING",
      JSON.stringify(liveHold.liveExecutionApprovalConfirmations),
    );
    ledger.pass("live-execution-human-hold", {
      approvalRequestId: liveConfirmation.approvalRequestId,
      expiresAt: liveConfirmation.expiresAt,
      targetHead: targetBase,
      workItemState: liveHold.status.workItems[0].state,
    });

    const executionApproved = jsonOutput(
      await prd([
        "approve-execution",
        idempotencyKey,
        liveConfirmation.approvalRequestId,
        "--confirm",
        liveConfirmation.confirmation,
      ]),
      "approve execution",
    );
    assert(
      executionApproved.kind === "execution-approved"
      && executionApproved.approval?.status === "claimed",
      "CCC_PRODUCT_EXECUTION_APPROVAL_FAILED",
      JSON.stringify(executionApproved),
    );

    const mergeHold = await poll(
      "merge approval hold",
      readStatus,
      (value) => value.status?.nextAction?.kind === "approve-merge",
      async () => ({ serve: tail(server.output()), status: await readStatus() }),
    );
    const task = mergeHold.status.tasks[0];
    assert(
      mergeHold.status.tasks.length === 1
      && task.semanticTaskId === "TASK-VERTICAL"
      && task.route?.providerId === "openai"
      && task.route?.modelId === "gpt-5.6-sol"
      && task.route?.transport === "cli"
      && task.route?.executor === "cli-agent"
      && task.route?.cliAdapterId === "codex"
      && task.route?.toolMode === "coding"
      && task.route?.worktreeMode === "isolated",
      "CCC_PRODUCT_CODING_ROUTE_DRIFT",
      JSON.stringify(task),
    );
    exactArray(
      task.route.ownedPaths,
      ["src/value.txt"],
      "CCC_PRODUCT_OWNED_PATH_DRIFT",
    );
    exactArray(
      task.route.allowedWriteRoots,
      ["src/value.txt"],
      "CCC_PRODUCT_WRITE_ROOT_DRIFT",
    );
    const canonicalWorktree = task.worktree
      ? await realpath(task.worktree)
      : null;
    const canonicalWorktreesRoot = await realpath(worktreesRoot);
    const worktreeRelative = canonicalWorktree
      ? path.relative(canonicalWorktreesRoot, canonicalWorktree)
      : "";
    assert(
      canonicalWorktree
      && canonicalWorktree !== targetRoot
      && worktreeRelative.length > 0
      && worktreeRelative !== ".."
      && !worktreeRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(worktreeRelative),
      "CCC_PRODUCT_WORKTREE_CUSTODY_INVALID",
      JSON.stringify({
        worktree: canonicalWorktree,
        worktreesRoot: canonicalWorktreesRoot,
        relative: worktreeRelative,
      }),
    );
    ledger.pass("coding-route-and-worktree-custody", {
      route: task.route,
      worktree: canonicalWorktree,
      branch: task.branch,
      baseCommit: task.baseCommit,
    });

    const proof = mergeHold.status.proofs[0];
    assert(
      mergeHold.status.proofs.length === 1
      && proof.definition.id === "PROOF-VERTICAL"
      && proof.attempts.length === 1,
      "CCC_PRODUCT_PROOF_SET_INVALID",
      JSON.stringify(mergeHold.status.proofs),
    );
    const attempt = proof.attempts[0];
    const sourceCommit = attempt.sourceCommit;
    assert(
      /^[0-9a-f]{40}$/.test(sourceCommit) && sourceCommit !== targetBase,
      "CCC_PRODUCT_CAMPAIGN_COMMIT_INVALID",
      sourceCommit,
    );
    exactArray(
      (await git(targetRoot, "diff", "--name-only", targetBase, sourceCommit))
        .split("\n")
        .filter(Boolean),
      ["src/value.txt"],
      "CCC_PRODUCT_CAMPAIGN_MUTATION_SCOPE_DRIFT",
    );
    assert(
      await git(targetRoot, "show", `${sourceCommit}:src/value.txt`) === "good",
      "CCC_PRODUCT_CAMPAIGN_COMMIT_CONTENT_INVALID",
      sourceCommit,
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === targetBase,
      "CCC_PRODUCT_LANDED_BEFORE_MERGE_APPROVAL",
      await git(targetRoot, "rev-parse", "refs/heads/main"),
    );
    ledger.pass("campaign-created-commit", {
      sourceCommit,
      sourceTree: await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`),
      mutationPaths: ["src/value.txt"],
      targetHeadStill: targetBase,
    });

    assert(
      attempt.state === "committed"
      && attempt.result?.success === true
      && attempt.result?.exitCode === 0
      && attempt.result?.stdoutTail?.includes("NEGATIVE_CONTROL_PASS")
      && attempt.result?.stdoutTail?.includes("POSITIVE_ORACLE_PASS")
      && attempt.sourceTree
        === await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`)
      && new Date(attempt.createdAt).getTime()
        >= new Date(mergeHold.status.import.createdAt).getTime()
      && new Date(attempt.settledAt).getTime()
        >= new Date(attempt.dispatchedAt).getTime(),
      "CCC_PRODUCT_EXECUTED_PROOF_INVALID_OR_STALE",
      JSON.stringify(attempt),
    );
    assert(
      attempt.packetHash === mergeHold.status.import.packetHash
      && attempt.sidecarHash === mergeHold.status.import.sidecarHash
      && attempt.bundleHash === mergeHold.status.import.bundleHash
      && attempt.manifestHash === mergeHold.status.import.manifestHash,
      "CCC_PRODUCT_PROOF_PROVENANCE_MISMATCH",
      JSON.stringify(attempt),
    );
    ledger.pass("commit-bound-proof-executed", {
      attemptKey: attempt.attemptKey,
      sourceCommit,
      sourceTree: attempt.sourceTree,
      definitionSha256: attempt.definitionSha256,
      commandSha256: attempt.commandSha256,
      result: attempt.result,
      dispatchedAt: attempt.dispatchedAt,
      settledAt: attempt.settledAt,
    });

    const mergeConfirmation = mergeHold.mergeApprovalConfirmations?.find(
      ({ approvalRequestId, status }) =>
        approvalRequestId === mergeHold.status.nextAction.approvalRequestId
        && status === "issued",
    );
    assert(
      mergeHold.status.workItems[0].state === "manual-required"
      && mergeHold.status.workItems[0].lastError
        === "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED"
      && mergeConfirmation
      && /^[0-9a-f]{64}$/.test(mergeConfirmation.confirmation),
      "CCC_PRODUCT_MERGE_HOLD_INVALID",
      JSON.stringify(mergeHold),
    );
    ledger.pass("merge-human-hold", {
      approvalRequestId: mergeConfirmation.approvalRequestId,
      expiresAt: mergeConfirmation.expiresAt,
      sourceCommit,
      targetHead: targetBase,
      proofAttemptKey: attempt.attemptKey,
    });

    const merged = jsonOutput(
      await prd([
        "approve-merge",
        idempotencyKey,
        mergeConfirmation.approvalRequestId,
        "--confirm",
        mergeConfirmation.confirmation,
      ]),
      "approve merge",
    );
    assert(
      merged.kind === "merge-approved"
      && merged.result?.merged === true
      && merged.result?.noOp === false
      && merged.status?.nextAction?.kind === "complete",
      "CCC_PRODUCT_CONTROLLED_LANDING_FAILED",
      JSON.stringify(merged),
    );
    const landedCommit = await git(targetRoot, "rev-parse", "refs/heads/main");
    assert(
      landedCommit !== targetBase
      && landedCommit !== sourceCommit
      && await git(targetRoot, "rev-parse", `${landedCommit}^{tree}`)
        === await git(targetRoot, "rev-parse", `${sourceCommit}^{tree}`),
      "CCC_PRODUCT_LANDING_OBJECT_INVALID",
      JSON.stringify({ targetBase, sourceCommit, landedCommit }),
    );
    exactArray(
      (await git(targetRoot, "diff", "--name-only", targetBase, landedCommit))
        .split("\n")
        .filter(Boolean),
      ["src/value.txt"],
      "CCC_PRODUCT_LANDING_SCOPE_DRIFT",
    );
    assert(
      await git(targetRoot, "status", "--porcelain") === ""
      && await readFile(path.join(targetRoot, "src/value.txt"), "utf8") === "good\n",
      "CCC_PRODUCT_LANDING_CHECKOUT_DIRTY",
      await git(targetRoot, "status", "--porcelain"),
    );
    assert(
      merged.status.landing.intents.length === 1
      && merged.status.landing.materializations.length === 1
      && merged.status.landing.terminals.length === 1
      && merged.status.landing.intents[0].metadata.sourceCommit === sourceCommit
      && merged.status.landing.materializations[0].metadata.commitObject
        === landedCommit
      && merged.status.landing.terminals[0].metadata.sourceCommit === sourceCommit,
      "CCC_PRODUCT_LANDING_RECEIPTS_INVALID",
      JSON.stringify(merged.status.landing),
    );
    ledger.pass("controlled-landing", {
      targetBase,
      sourceCommit,
      landedCommit,
      landing: merged.status.landing,
      mutationPaths: ["src/value.txt"],
    });

    await stopServe(server);
    server = undefined;
    restartedServer = await startServe(targetRoot, env, port);
    const recovered = await poll(
      "terminal status after restart",
      readStatus,
      (value) => value.status?.nextAction?.kind === "complete",
      async () => ({
        serve: tail(restartedServer.output()),
        targetHead: await git(targetRoot, "rev-parse", "refs/heads/main"),
      }),
    );
    assert(
      await git(targetRoot, "rev-parse", "refs/heads/main") === landedCommit
      && recovered.status.proofs[0].attempts.length === 1
      && recovered.status.landing.intents.length === 1
      && recovered.status.landing.materializations.length === 1
      && recovered.status.landing.terminals.length === 1
      && recovered.status.orphanProofAttempts.length === 0
      && await git(targetRoot, "status", "--porcelain") === "",
      "CCC_PRODUCT_TERMINAL_RESTART_REPLAYED_EFFECT",
      JSON.stringify(recovered.status),
    );
    ledger.pass("terminal-restart-recovery", {
      targetHead: landedCommit,
      proofAttempts: recovered.status.proofs[0].attempts.length,
      landingReceiptCounts: {
        intents: recovered.status.landing.intents.length,
        materializations: recovered.status.landing.materializations.length,
        terminals: recovered.status.landing.terminals.length,
      },
      nextAction: recovered.status.nextAction,
    });

    const repositoryEnd = await repositorySnapshot();
    assertRepositoryUnchanged(repositoryStart, repositoryEnd);
    const checks = ledger.finalize();
    const report = {
      schema: "ccc-prd-product-acceptance.v1",
      result: "pass",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      productBoundary:
        "Frozen reviewed PRD packet through native local authoring and normal built CLI/serve coding, proof, recovery, and exact merge approval.",
      authoringBoundary: nativeAuthoringEvidence,
      fixtureBoundary:
        "native local authoring was exercised through one OpenAI-compatible loopback SSE request with a sanitized deterministic model response; no proposal-file compatibility argument, secret, or live external provider was used.",
      repository: {
        start: repositoryStart,
        end: repositoryEnd,
        unchanged: true,
      },
      target: {
        baseCommit: targetBase,
        campaignCommit: sourceCommit,
        landedCommit,
      },
      exactChecks: checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("ccc-prd-product-acceptance: PASS\n");
  } catch (error) {
    const diagnostic = {
      schema: "ccc-prd-product-acceptance.failure.v1",
      result: "fail",
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
      serveTail: server ? tail(server.output()) : undefined,
      restartedServeTail: restartedServer ? tail(restartedServer.output()) : undefined,
      tempRoot,
    };
    process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await stopNativeAuthoringServer(authoringServer).catch(() => undefined);
    await stopServe(restartedServer).catch(() => undefined);
    await stopServe(server).catch(() => undefined);
    if (tempRoot && process.env.CCC_PRD_PRODUCT_KEEP_TMP !== "1") {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

await main();
