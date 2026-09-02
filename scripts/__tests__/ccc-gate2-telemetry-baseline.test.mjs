import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadBaselineBuilder() {
  try {
    return await import("../lib/ccc-gate2-telemetry-baseline.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

async function filesBelow(root, relativeRoot = "") {
  const entries = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

test("PRD:GATE2-02 telemetry baseline owns only config, fixtures, and the external verifier", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  assert.equal(typeof createGate2TelemetryBaseline, "function");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-baseline-test-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    assert.deepEqual(await filesBelow(target), [
      ".gitignore",
      "Taskfile.yml",
      "fixtures/events.json",
      "package.json",
      "verify/project-verifier.mjs",
    ]);
    const packageJson = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    assert.equal(packageJson.name, "gate2-telemetry-service");
    assert.deepEqual(Object.keys(packageJson.scripts).sort(), [
      "build",
      "test",
      "verify:audit",
      "verify:broadcast",
      "verify:candidate",
      "verify:cli",
      "verify:contract",
      "verify:ingest",
      "verify:integrated",
    ]);
    const verifier = await readFile(path.join(target, "verify/project-verifier.mjs"), "utf8");
    for (const marker of [
      "valid event POST",
      "invalid event returns 4xx",
      "audit survives restart",
      "SSE client receives event",
      "health probe unavailable exit",
      "README operator sections",
      "audit survives restart",
      "health-cli.ts",
    ]) {
      assert.match(verifier, new RegExp(marker, "i"));
    }
    for (const literal of [
      "parseTelemetryEvent",
      "handleIngest",
      "AuditStore",
      "SseHub",
      "probeHealth",
      "createApp",
      "new Request(",
    ]) {
      assert.ok(verifier.includes(literal), `verifier must independently exercise ${literal}`);
    }
    assert.match(verifier, /mkdtemp/);
    assert.match(verifier, /node:net/);
    assert.match(verifier, /spawn\(process\.execPath/);
    assert.match(verifier, /fetch\(baseUrl \+ "\/stream"\)/);
    assert.match(verifier, /fetch\(baseUrl \+ "\/events"/);
    assert.doesNotMatch(verifier, /node:(?:http|https)|response\.writeHead|response\.flushHeaders/);
    assert.doesNotMatch(verifier, /src\/contract\.ts[\s\S]*export /);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("PRD:GATE2-03 telemetry verifier emits semantic v2 proof evidence in campaign mode", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  assert.equal(typeof createGate2TelemetryBaseline, "function");
  assert.equal(typeof candidateModule.writeGate2TelemetryCandidate, "function");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-proof-test-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const sourceCommit = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const result = spawnSync(process.execPath, ["verify/project-verifier.mjs", "src/contract.ts"], {
      cwd: target,
      encoding: "utf8",
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-CONTRACT",
        CCC_PROOF_PHASE: "task",
        CCC_PROOF_SOURCE_COMMIT: sourceCommit,
        CCC_PROOF_SOURCE_TREE: sourceTree,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(evidence, {
      clauseResults: [{ clauseId: "AC-REQ-TELEMETRY-CONTRACT-001", passed: true }],
      negativeControlResults: [{ controlId: "CONTROL-TELEMETRY-CONTRACT", passed: true }],
      passed: true,
      phase: "task",
      positiveCaseResults: [{ caseId: "CASE-TELEMETRY-CONTRACT", passed: true }],
      proofId: "PROOF-TELEMETRY-CONTRACT",
      schema: "ccc-prd.proof-evidence.v2",
      sourceCommit,
      sourceTree,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("PRD:GATE2-06 integrated verifier independently proves a known-good telemetry service", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs").catch((error) => {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  });
  assert.equal(typeof candidateModule.writeGate2TelemetryCandidate, "function");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-integrated-test-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const inputs = [
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ];
    const result = spawnSync(process.execPath, ["verify/project-verifier.mjs", ...inputs], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "c".repeat(40),
        CCC_PROOF_SOURCE_TREE: "d".repeat(40),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.schema, "ccc-prd.proof-evidence.v2");
    assert.equal(evidence.passed, true);
    assert.equal(evidence.clauseResults.length, 6);
    assert.ok(evidence.clauseResults.every(({ passed }) => passed));
    assert.deepEqual(evidence.positiveCaseResults, [{ caseId: "CASE-TELEMETRY-INTEGRATED", passed: true }]);
    assert.deepEqual(evidence.negativeControlResults, [{ controlId: "CONTROL-TELEMETRY-INTEGRATED", passed: true }]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("PRD:GATE2-06 integrated verifier accepts SSE comment and control preambles", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-sse-preamble-test-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    const withPreamble = appSource.replace(
      "        return new Response(new ReadableStream<Uint8Array>({\n          async pull(controller) {",
      "        return new Response(new ReadableStream<Uint8Array>({\n"
        + "          start(controller) {\n"
        + "            controller.enqueue(new TextEncoder().encode(\": connected\\r\\n\\r\\nretry: 1000\\r\\n\\r\\n\"));\n"
        + "          },\n"
        + "          async pull(controller) {",
    );
    assert.notEqual(withPreamble, appSource, "preamble fixture did not patch the SSE stream");
    await writeFile(appPath, withPreamble);

    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "e".repeat(40),
        CCC_PROOF_SOURCE_TREE: "f".repeat(40),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("RED-G2-USEFULNESS-CLI: integrated verifier rejects an executable that ignores --audit", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-cli-audit-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    assert.match(appSource, /argument\("--audit"\)/u);
    await writeFile(
      appPath,
      appSource.replace('argument("--audit")', '"data/events.jsonl"'),
    );
    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "3".repeat(40),
        CCC_PROOF_SOURCE_TREE: "4".repeat(40),
      },
    });
    assert.notEqual(result.status, 0, "verifier accepted an executable that ignored --audit");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("RED-G2-USEFULNESS-SSE: integrated verifier rejects a server that does not flush stream headers", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-sse-flush-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    assert.match(appSource, /response\.flushHeaders\(\)/u);
    await writeFile(appPath, appSource.replace("    response.flushHeaders();\n", ""));
    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "5".repeat(40),
        CCC_PROOF_SOURCE_TREE: "6".repeat(40),
      },
    });
    assert.notEqual(result.status, 0, "verifier accepted an SSE server that never flushed headers");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("RED-G2-USEFULNESS-SSE-RACE: integrated verifier rejects headers flushed before subscriber registration", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-sse-order-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    const handleBlock = `    const handled = await app.handle(new Request("http://127.0.0.1" + (request.url ?? "/"), {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    }));
`;
    assert.ok(appSource.includes(handleBlock), "known-good candidate handle block drifted");
    const withoutHandle = appSource.replace(handleBlock, "");
    const raceCandidate = withoutHandle.replace(
      "    response.flushHeaders();\n",
      `    response.flushHeaders();\n${handleBlock}`,
    );
    assert.notEqual(raceCandidate, appSource, "race fixture did not reorder the handle call");
    await writeFile(appPath, raceCandidate);

    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "7".repeat(40),
        CCC_PROOF_SOURCE_TREE: "8".repeat(40),
      },
    });
    assert.notEqual(result.status, 0, "verifier accepted headers flushed before SSE subscriber registration");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("RED-G2-USEFULNESS-SSE-ADAPTER: integrated verifier rejects a stream wired to a different service instance", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-sse-adapter-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    const sharedHandler = "    const handled = await app.handle(new Request(\"http://127.0.0.1\" + (request.url ?? \"/\"), {\n";
    const disconnectedHandler = `    const requestApp = request.url === "/stream"
      ? await createApp({ auditPath: argument("--audit") })
      : app;
    const handled = await requestApp.handle(new Request("http://127.0.0.1" + (request.url ?? "/"), {
`;
    assert.ok(appSource.includes(sharedHandler), "known-good candidate shared handler drifted");
    const disconnectedCandidate = appSource.replace(sharedHandler, disconnectedHandler);
    assert.notEqual(disconnectedCandidate, appSource, "disconnected adapter fixture did not patch the server handler");
    await writeFile(appPath, disconnectedCandidate);

    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "b".repeat(40),
        CCC_PROOF_SOURCE_TREE: "c".repeat(40),
      },
    });
    assert.notEqual(result.status, 0, "verifier accepted an SSE adapter disconnected from event ingest");
    assert.match(
      result.stderr,
      /worker executable SSE event timed out/u,
      "disconnected adapter was not rejected by the executable SSE proof",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("RED-G2-USEFULNESS-SSE-ROUTE: integrated verifier rejects SSE exposed anywhere except GET /stream", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-sse-route-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const appPath = path.join(target, "src/app.ts");
    const appSource = await readFile(appPath, "utf8");
    const wrongRoute = appSource.replace(
      'request.method === "GET" && url.pathname === "/stream"',
      'request.method === "GET" && url.pathname === "/events"',
    );
    assert.notEqual(wrongRoute, appSource, "route fixture did not replace GET /stream");
    await writeFile(appPath, wrongRoute);

    const result = spawnSync(process.execPath, [
      "verify/project-verifier.mjs",
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "9".repeat(40),
        CCC_PROOF_SOURCE_TREE: "a".repeat(40),
      },
    });
    assert.notEqual(result.status, 0, "verifier accepted SSE on the wrong HTTP route");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("PRD:GATE2-06 integrated verifier executes the worker-authored telemetry test file", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-test-execution-red-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    await writeFile(
      path.join(target, "tests/telemetry.test.ts"),
      'throw new Error("worker-authored-test-sentinel");\n',
    );
    const direct = spawnSync(process.execPath, ["--test", "--experimental-strip-types", "tests/telemetry.test.ts"], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    });
    assert.notEqual(direct.status, 0, direct.stderr || direct.stdout);
    const inputs = [
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ];
    const result = spawnSync(process.execPath, ["verify/project-verifier.mjs", ...inputs], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-INTEGRATED",
        CCC_PROOF_PHASE: "final_integrated",
        CCC_PROOF_SOURCE_COMMIT: "1".repeat(40),
        CCC_PROOF_SOURCE_TREE: "2".repeat(40),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /worker-authored-test-sentinel/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("PRD:GATE2-08 candidate verifier emits the integrate task case and control identities", async () => {
  const { createGate2TelemetryBaseline } = await loadBaselineBuilder();
  const candidateModule = await import("./helpers/ccc-gate2-telemetry-candidate.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "ccc-gate2-candidate-proof-test-"));
  const target = path.join(scratch, "target");
  try {
    await createGate2TelemetryBaseline(target);
    await candidateModule.writeGate2TelemetryCandidate(target);
    const inputs = [
      "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
      "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
    ];
    const result = spawnSync(process.execPath, ["verify/project-verifier.mjs", ...inputs], {
      cwd: target,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CCC_PROOF_ID: "PROOF-TELEMETRY-CANDIDATE",
        CCC_PROOF_PHASE: "task",
        CCC_PROOF_SOURCE_COMMIT: "e".repeat(40),
        CCC_PROOF_SOURCE_TREE: "f".repeat(40),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(evidence.positiveCaseResults, [{ caseId: "CASE-TELEMETRY-INTEGRATE", passed: true }]);
    assert.deepEqual(evidence.negativeControlResults, [{ controlId: "CONTROL-TELEMETRY-INTEGRATE", passed: true }]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
