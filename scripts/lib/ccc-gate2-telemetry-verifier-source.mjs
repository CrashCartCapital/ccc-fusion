export function buildGate2TelemetryVerifierSource(phaseCandidateInputs) {
  const phaseEntries = Object.entries(phaseCandidateInputs);
  return `#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const phaseInputs = ${JSON.stringify(Object.fromEntries(phaseEntries), null, 2)};

const proofByPhase = {
  contract: {
    proofId: "PROOF-TELEMETRY-CONTRACT",
    clauseId: "AC-REQ-TELEMETRY-CONTRACT-001",
    caseId: "CASE-TELEMETRY-CONTRACT",
    controlId: "CONTROL-TELEMETRY-CONTRACT",
    positive: "valid event POST",
    negative: "malformed, missing-field, and unknown-field events are rejected"
  },
  ingest: {
    proofId: "PROOF-TELEMETRY-INGEST",
    clauseId: "AC-REQ-TELEMETRY-INGEST-001",
    caseId: "CASE-TELEMETRY-INGEST",
    controlId: "CONTROL-TELEMETRY-INGEST",
    positive: "valid event POST",
    negative: "invalid event returns 4xx"
  },
  audit: {
    proofId: "PROOF-TELEMETRY-AUDIT",
    clauseId: "AC-REQ-TELEMETRY-AUDIT-001",
    caseId: "CASE-TELEMETRY-AUDIT",
    controlId: "CONTROL-TELEMETRY-AUDIT",
    positive: "audit survives restart",
    negative: "duplicate append attempts do not create duplicate accepted records"
  },
  broadcast: {
    proofId: "PROOF-TELEMETRY-BROADCAST",
    clauseId: "AC-REQ-TELEMETRY-BROADCAST-001",
    caseId: "CASE-TELEMETRY-BROADCAST",
    controlId: "CONTROL-TELEMETRY-BROADCAST",
    positive: "SSE client receives event",
    negative: "rejected events are not broadcast"
  },
  cli: {
    proofId: "PROOF-TELEMETRY-CLI",
    clauseId: "AC-REQ-TELEMETRY-CLI-001",
    caseId: "CASE-TELEMETRY-CLI",
    controlId: "CONTROL-TELEMETRY-CLI",
    positive: "README operator sections",
    negative: "health probe unavailable exit"
  },
  candidate: {
    proofId: "PROOF-TELEMETRY-CANDIDATE",
    clauseId: "AC-REQ-TELEMETRY-INTEGRATE-001",
    caseId: "CASE-TELEMETRY-INTEGRATE",
    controlId: "CONTROL-TELEMETRY-INTEGRATE",
    positive: "one joined candidate commit contains every admitted leaf and passes the project rubric",
    negative: "partial joins are rejected"
  },
  integrated: {
    proofId: "PROOF-TELEMETRY-INTEGRATED",
    clauseId: "AC-REQ-TELEMETRY-INTEGRATE-001",
    caseId: "CASE-TELEMETRY-INTEGRATED",
    controlId: "CONTROL-TELEMETRY-INTEGRATED",
    positive: "HTTP, audit, restart, SSE, CLI, build, test, and documentation checks pass.",
    negative: "partial joins, duplicate audit records, rejected-event broadcasts, and unavailable-service probe success are rejected"
  }
};

function currentPhase(argv) {
  const campaignProofId = process.env.CCC_PROOF_ID;
  if (campaignProofId) {
    const campaignPhase = Object.entries(proofByPhase).find(([, proof]) => proof.proofId === campaignProofId)?.[0];
    if (campaignPhase) return campaignPhase;
  }
  const received = argv.slice(2).sort();
  for (const [phase, inputs] of Object.entries(phaseInputs)) {
    if (JSON.stringify([...inputs].sort()) === JSON.stringify(received)) return phase;
  }
  throw new Error("unknown verifier input set: " + received.join(","));
}

async function loadModule(relativePath) {
  return import(pathToFileURL(path.resolve(relativePath)).href + "?t=" + Date.now());
}

function unwrapParsed(value) {
  if (value && typeof value === "object" && "ok" in value) {
    if (value.ok !== true) throw new Error("parseTelemetryEvent returned non-ok for a valid event");
    return value.value;
  }
  return value;
}

async function mustReject(fn, label) {
  let rejected = false;
  try {
    const value = await fn();
    if (value && typeof value === "object" && "ok" in value && value.ok === false) rejected = true;
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(label + " was accepted");
}

function validEvent(id = "evt-001") {
  return { id, type: "temperature", observedAt: "2026-09-01T12:00:00Z", payload: { celsius: 21.5 } };
}

async function checkContract() {
  const contract = await loadModule("src/contract.ts");
  assert.equal(typeof contract.parseTelemetryEvent, "function", "parseTelemetryEvent must be exported");
  const parsed = unwrapParsed(await contract.parseTelemetryEvent(validEvent()));
  assert.deepEqual(parsed, validEvent(), "parseTelemetryEvent must preserve valid declared fields");
  await mustReject(() => contract.parseTelemetryEvent({ ...validEvent(), extra: true }), "unknown-field event");
  await mustReject(() => contract.parseTelemetryEvent({ id: "evt-missing", observedAt: "2026-09-01T12:00:00Z", payload: {} }), "missing-field event");
  await mustReject(() => contract.parseTelemetryEvent({ ...validEvent(), observedAt: "not-a-timestamp" }), "malformed timestamp event");
}

async function checkIngest() {
  await checkContract();
  const ingest = await loadModule("src/ingest.ts");
  assert.equal(typeof ingest.handleIngest, "function", "handleIngest must be exported");
  const accepted = [];
  const broadcast = [];
  const dependencies = {
    audit: { append: async (event) => { accepted.push(event); return true; } },
    broadcast: { publish: (event) => { broadcast.push(event); } }
  };
  const ok = await ingest.handleIngest(validEvent("evt-ingest"), dependencies);
  assert.equal(ok?.status, 202, "valid event POST must return 202");
  assert.equal(ok?.body?.accepted, true, "valid event POST must mark accepted");
  assert.deepEqual(accepted.map(({ id }) => id), ["evt-ingest"]);
  assert.deepEqual(broadcast.map(({ id }) => id), ["evt-ingest"]);
  const bad = await ingest.handleIngest({ ...validEvent("evt-bad"), payload: null }, dependencies);
  assert.ok(bad?.status >= 400 && bad?.status < 500, "invalid event returns 4xx");
  assert.deepEqual(accepted.map(({ id }) => id), ["evt-ingest"], "invalid event must not persist");
  assert.deepEqual(broadcast.map(({ id }) => id), ["evt-ingest"], "invalid event must not broadcast");
}

async function checkAudit() {
  await checkContract();
  const auditModule = await loadModule("src/audit.ts");
  assert.equal(typeof auditModule.AuditStore?.open, "function", "AuditStore.open must be exported");
  const scratch = await mkdtemp(path.join(tmpdir(), "gate2-audit-"));
  try {
    const auditPath = path.join(scratch, "events.jsonl");
    const first = await auditModule.AuditStore.open(auditPath);
    assert.equal(await first.append(validEvent("evt-audit")), true);
    assert.equal(await first.append(validEvent("evt-audit")), false, "duplicate append attempts do not create duplicate accepted records");
    const reopened = await auditModule.AuditStore.open(auditPath);
    assert.deepEqual((await reopened.readAll()).map(({ id }) => id), ["evt-audit"], "audit survives restart");
    const raw = await readFile(auditPath, "utf8");
    assert.equal(raw.trim().split("\\n").length, 1, "audit must be append-only JSONL with one accepted identifier");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readOne(asyncIterable) {
  const iterator = asyncIterable[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("SSE client receives event timed out")), 1_000))
  ]);
  await iterator.return?.();
  return result.value;
}

async function checkBroadcast() {
  await checkContract();
  const broadcastModule = await loadModule("src/broadcast.ts");
  assert.equal(typeof broadcastModule.SseHub, "function", "SseHub must be exported");
  const hub = new broadcastModule.SseHub();
  assert.equal(typeof hub.subscribe, "function", "SseHub.subscribe must be exported");
  assert.equal(typeof hub.publish, "function", "SseHub.publish must be exported");
  const stream = hub.subscribe();
  hub.publish(validEvent("evt-sse"));
  const frame = await readOne(stream);
  assert.equal(typeof frame, "string", "SSE frame must be a string");
  assert.match(frame, /^data: /, "SSE frame must use data field");
  assert.match(frame, /evt-sse/, "SSE client receives event identifier");
}

async function checkCli() {
  const cli = await loadModule("src/health-cli.ts");
  assert.equal(typeof cli.probeHealth, "function", "probeHealth must be exported");
  const healthy = await cli.probeHealth(async (url) => {
    assert.match(String(url), /\\/health$/);
    return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
  }, "http://example.invalid");
  assert.equal(healthy, 0, "healthy probe must exit zero");
  const unavailable = await cli.probeHealth(async () => { throw new Error("unavailable"); }, "http://example.invalid");
  assert.notEqual(unavailable, 0, "health probe unavailable exit");
  const readme = await readFile("README.md", "utf8");
  for (const marker of ["Quickstart", "Persistence", "Verification"]) {
    assert.match(readme, new RegExp(marker, "i"), "README operator sections must include " + marker);
  }
}

async function checkExecutableArguments() {
  const scratch = await mkdtemp(path.join(tmpdir(), "gate2-cli-args-"));
  try {
    const auditPath = path.join(scratch, "events.jsonl");
    const auditSentinel = "AUDIT_FLAG_SENTINEL";
    await writeFile(auditPath, auditSentinel + "\\n", "utf8");
    const executableEnvironment = { ...process.env };
    delete executableEnvironment.NODE_TEST_CONTEXT;
    const executable = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "src/app.ts",
      "--port",
      "70000",
      "--audit",
      auditPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: executableEnvironment,
      timeout: 5_000,
    });
    assert.notEqual(executable.status, 0, "out-of-range probe port must refuse before network bind");
    assert.doesNotMatch(
      executable.stderr,
      /(?:EPERM|EACCES)[^\\n]*(?:mkdir|open)[^\\n]*data/u,
      "guarded executable ignored --audit and attempted a checkout-local data path",
    );
    assert.ok(
      executable.stderr.includes(auditSentinel),
      "guarded executable did not route --audit to createApp before refusing the probe port",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function requestBody(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

async function checkCandidate() {
  await checkIngest();
  await checkAudit();
  await checkBroadcast();
  await checkCli();
  const appSource = await readFile("src/app.ts", "utf8");
  assert.match(appSource, /import\\.meta\\.url/, "real server entry must be behind an import.meta.url main guard");
  assert.ok(appSource.includes("." + "listen("), "guarded executable must serve the documented HTTP contract");
  assert.ok(appSource.includes("." + "flushHeaders("), "GET /stream must flush response headers before awaiting the first event");
  const executableSource = appSource.slice(appSource.lastIndexOf("import.meta.url"));
  const handleIndex = executableSource.indexOf("." + "handle(");
  const flushIndex = executableSource.indexOf("." + "flushHeaders(");
  assert.ok(handleIndex >= 0, "guarded executable must obtain the service response");
  assert.ok(
    handleIndex < flushIndex,
    "GET /stream must register its SSE subscriber before flushing response headers",
  );
  await checkExecutableArguments();
  const app = await loadModule("src/app.ts");
  assert.equal(typeof app.createApp, "function", "createApp must be exported");
  const scratch = await mkdtemp(path.join(tmpdir(), "gate2-app-"));
  try {
    const auditPath = path.join(scratch, "events.jsonl");
    const service = await app.createApp({ auditPath });
    assert.equal(typeof service.handle, "function", "createApp must return a Request handler");
    assert.equal(typeof service.close, "function", "createApp must return a close hook");
    const health = await service.handle(new Request("http://local.test/health"));
    assert.equal(health.status, 200, "GET /health must succeed");
    const accepted = await service.handle(new Request("http://local.test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validEvent("evt-http"))
    }));
    assert.equal(accepted.status, 202, "valid event POST must be accepted");
    assert.equal((await requestBody(accepted)).id, "evt-http");
    const rejected = await service.handle(new Request("http://local.test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validEvent("evt-reject"), extra: true })
    }));
    assert.ok(rejected.status >= 400 && rejected.status < 500, "invalid event returns 4xx");
    const missing = await service.handle(new Request("http://local.test/missing"));
    assert.equal(missing.status, 404, "unknown route must be 404");
    await service.close();
    const restarted = await app.createApp({ auditPath });
    assert.deepEqual((await restarted.audit.readAll()).map(({ id }) => id), ["evt-http"], "audit survives restart");
    await restarted.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const workerTestEnvironment = { ...process.env };
  delete workerTestEnvironment.NODE_TEST_CONTEXT;
  const workerTests = spawnSync(process.execPath, ["--test", "--experimental-strip-types", "tests/telemetry.test.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: workerTestEnvironment
  });
  assert.equal(
    workerTests.status,
    0,
    "worker-authored tests/telemetry.test.ts failed:\\n" + workerTests.stdout + "\\n" + workerTests.stderr
  );
}

async function main() {
  const phase = currentPhase(process.argv);
  const checks = {
    contract: checkContract,
    ingest: checkIngest,
    audit: checkAudit,
    broadcast: checkBroadcast,
    cli: checkCli,
    candidate: checkCandidate,
    integrated: checkCandidate
  };
  await checks[phase]();
  const proof = proofByPhase[phase];
  const campaignProofId = process.env.CCC_PROOF_ID || proof.proofId;
  const campaignPhase = process.env.CCC_PROOF_PHASE || (phase === "integrated" ? "final_integrated" : "task");
  const integrated = campaignProofId === "PROOF-TELEMETRY-INTEGRATED";
  const clauseIds = integrated
    ? ["AC-REQ-TELEMETRY-CONTRACT-001", "AC-REQ-TELEMETRY-INGEST-001", "AC-REQ-TELEMETRY-AUDIT-001", "AC-REQ-TELEMETRY-BROADCAST-001", "AC-REQ-TELEMETRY-CLI-001", "AC-REQ-TELEMETRY-INTEGRATE-001"]
    : [proof.clauseId];
  const caseIds = [proof.caseId];
  const controlIds = [proof.controlId];
  const evidence = {
    clauseResults: clauseIds.map((clauseId) => ({ clauseId, passed: true })),
    negativeControlResults: controlIds.map((controlId) => ({ controlId, passed: true })),
    passed: true,
    phase: campaignPhase,
    positiveCaseResults: caseIds.map((caseId) => ({ caseId, passed: true })),
    proofId: campaignProofId,
    schema: "ccc-prd.proof-evidence.v2",
    ...(process.env.CCC_PROOF_SOURCE_COMMIT ? { sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT } : {}),
    ...(process.env.CCC_PROOF_SOURCE_TREE ? { sourceTree: process.env.CCC_PROOF_SOURCE_TREE } : {})
  };
  if (process.env.CCC_PROOF_ID) {
    process.stdout.write(JSON.stringify(evidence) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({
      inputs: process.argv.slice(2),
      phase,
      rubric: ["valid event POST", "invalid event returns 4xx", "audit survives restart", "SSE client receives event", "health probe unavailable exit", "README operator sections"],
      schema: "gate2-telemetry-proof.v1",
      sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
    }) + "\\n");
  }
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\\n");
  process.exit(1);
});
`;
}
