const PROJECT_VERIFIER_SOURCE_TEMPLATE = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const phaseInputs = { contract: ["src/record.mjs", "src/validation.mjs"], core: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"], cli: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"], project: ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"] };
const explicitPhase = Object.hasOwn(phaseInputs, process.argv[2]) ? process.argv[2] : undefined;
const requestedInputs = process.argv.slice(explicitPhase ? 3 : 2);
const explicitInputsValid = explicitPhase && (requestedInputs.length === 0 || JSON.stringify(requestedInputs) === JSON.stringify(phaseInputs[explicitPhase]));
const localPhase = explicitPhase ? (explicitInputsValid ? explicitPhase : undefined) : Object.entries(phaseInputs).find(([, inputs]) => JSON.stringify(requestedInputs) === JSON.stringify(inputs))?.[0];
const phaseByProofId = { "PROOF-LEDGER-CONTRACT": "contract", "PROOF-LEDGER-CORE": "core", "PROOF-LEDGER-CLI": "cli", "PROOF-LEDGER-INTEGRATED": "project" };
const phase = phaseByProofId[process.env.CCC_PROOF_ID] ?? localPhase;
const admittedPhases = new Set(Object.keys(phaseInputs));
const expectedBaselineHashes = __CCC_BASELINE_HASHES__;
const campaignEnvKeys = ["CCC_PROOF_ID", "CCC_PROOF_PHASE", "CCC_PROOF_SOURCE_COMMIT", "CCC_PROOF_SOURCE_TREE"];
async function fixture(name) { return await readFile(new URL(\`../fixtures/\${name}.ndjson\`, import.meta.url), "utf8"); }
function lines(source) { return source.trimEnd().split("\\n"); }
function canonicalJson(value) { if (value === undefined || ["function", "symbol", "bigint"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new TypeError("value is not canonical JSON");
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") { const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value is not canonical JSON"); return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}"; } const serialized = JSON.stringify(value); if (serialized === undefined) throw new TypeError("value is not canonical JSON"); return serialized; }
function oracleLedger(records) {
  const canonicalRecords = records.map((record) => ({ ...record, ...(record.tags ? { tags: [...record.tags].sort() } : {}) }))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const grouped = new Map();
  for (const record of canonicalRecords) grouped.set(record.subject, [...(grouped.get(record.subject) ?? []), record.id]);
  return { schema: "evidence-ledger.report.v1", recordCount: canonicalRecords.length, subjects: [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([subject, recordIds]) => ({ subject, count: recordIds.length, recordIds })), records: canonicalRecords };
}
function oracleText(ledger) {
  const byId = new Map(ledger.records.map((record) => [record.id, record]));
  const output = ["Evidence Ledger Report", "Records: " + ledger.recordCount];
  for (const subject of ledger.subjects) {
    output.push("Subject: " + subject.subject + " (" + subject.count + ")");
    for (const recordId of subject.recordIds) { const record = byId.get(recordId); output.push("- " + record.observedAt + " [" + record.confidence + "] " + record.id + " | " + record.claim + " | source=" + record.source + " | tags=" + (record.tags?.join(",") ?? "none")); }
  }
  return output.join("\\n") + "\\n";
}
async function rejects(action) { try { await action(); return false; } catch { return true; } }
async function contractClauses() {
  const { parseEvidenceLine } = await import("../src/record.mjs");
  const { validateEvidenceRecords } = await import("../src/validation.mjs");
  assert.equal(typeof parseEvidenceLine, "function");
  assert.equal(typeof validateEvidenceRecords, "function");
  const parse = async (name) => {
    const inputLines = lines(await fixture(name));
    const records = [];
    for (let index = 0; index < inputLines.length; index += 1) records.push(await parseEvidenceLine(inputLines[index], index + 1));
    return records;
  };
  let validPassed = false;
  try {
    const valid = await validateEvidenceRecords(await parse("valid"));
    assert.equal(valid.length, 4);
    assert.deepEqual(valid.find(({ id }) => id === "ev-003")?.tags, ["pressure", "variance"]);
    assert.deepEqual(valid.find(({ id }) => id === "ev-002")?.tags, undefined);
    validPassed = true;
  } catch { validPassed = false; }
  const invalidFixture = async (name) => await rejects(async () => await validateEvidenceRecords(await parse(name)));
  return [
    { clauseId: "CONTRACT-DUPLICATE-ID", passed: await invalidFixture("duplicate-id") },
    { clauseId: "CONTRACT-INVALID-CALENDAR-DATE", passed: await invalidFixture("invalid-calendar-date") },
    { clauseId: "CONTRACT-INVALID-CONFIDENCE", passed: await invalidFixture("invalid-confidence") },
    { clauseId: "CONTRACT-INVALID-JSON", passed: await invalidFixture("invalid-json") },
    { clauseId: "CONTRACT-INVALID-TIMESTAMP", passed: await invalidFixture("invalid-timestamp") },
    { clauseId: "CONTRACT-MISSING-REQUIRED", passed: await invalidFixture("missing-required-field") },
    await staticBoundaryClause("CONTRACT-STATIC-BOUNDARY", ["../src/record.mjs", "../src/validation.mjs"]),
    { clauseId: "CONTRACT-UNKNOWN-FIELD", passed: await invalidFixture("unknown-field") },
    { clauseId: "CONTRACT-VALID", passed: validPassed },
  ];
}
const coreClauseIds = ["CORE-HARDCODE-CONTROL", "CORE-JSON-CANONICAL", "CORE-MUTATION-ORACLE", "CORE-SHUFFLED-INVARIANT", "CORE-STATIC-BOUNDARY", "CORE-SUBJECT-AGGREGATION", "CORE-TEXT-CANONICAL"];
async function coreClauses() {
  const { parseEvidenceLine } = await import("../src/record.mjs");
  const { validateEvidenceRecords } = await import("../src/validation.mjs");
  const { buildLedger } = await import("../src/ledger.mjs");
  const { renderJsonReport, renderTextReport } = await import("../src/report.mjs");
  assert.equal(typeof buildLedger, "function");
  assert.equal(typeof renderJsonReport, "function");
  assert.equal(typeof renderTextReport, "function");
  const parse = async (name) => {
    const inputLines = lines(await fixture(name));
    const records = [];
    for (let index = 0; index < inputLines.length; index += 1) records.push(await parseEvidenceLine(inputLines[index], index + 1));
    return await validateEvidenceRecords(records);
  };
  const validRecords = await parse("valid");
  const validLedger = await buildLedger(validRecords);
  const shuffledLedger = await buildLedger(await parse("valid-shuffled"));
  const hardcodeLedger = await buildLedger(await parse("hardcode-control"));
  const mutationSeed = createHash("sha256").update(await readFile(new URL("../src/ledger.mjs", import.meta.url))).digest("hex");
  const mutationRecords = [...validRecords, { id: "mutation-" + mutationSeed.slice(0, 8), subject: "subject-" + mutationSeed.slice(8, 16), claim: "Derived claim " + mutationSeed.slice(16, 24), observedAt: "2026-08-29T10:04:00Z", source: "source-" + mutationSeed.slice(24, 32), confidence: "medium", tags: ["derived", mutationSeed.slice(32, 40)] }];
  const mutationLedger = await buildLedger(mutationRecords);
  const expectedMutationLedger = oracleLedger(mutationRecords);
  const canonicalRecords = [{ id: "ev-001", subject: "pump-a", claim: "Pressure nominal", observedAt: "2026-08-29T10:01:00Z", source: "sensor-alpha", confidence: "high", tags: ["pressure"] }, { id: "ev-002", subject: "pump-b", claim: "Temperature nominal", observedAt: "2026-08-29T10:02:00Z", source: "sensor-alpha", confidence: "high" }, { id: "ev-004", subject: "pump-a", claim: "Maintenance ticket opened", observedAt: "2026-08-29T10:02:00Z", source: "ops-console", confidence: "low", tags: ["maintenance", "ticket"] }, { id: "ev-003", subject: "pump-a", claim: "Pressure variance observed", observedAt: "2026-08-29T10:03:00Z", source: "sensor-beta", confidence: "medium", tags: ["pressure", "variance"] }];
  const canonicalSubjects = [{ subject: "pump-a", count: 3, recordIds: ["ev-001", "ev-004", "ev-003"] }, { subject: "pump-b", count: 1, recordIds: ["ev-002"] }];
  const canonicalLedger = { schema: "evidence-ledger.report.v1", recordCount: 4, subjects: canonicalSubjects, records: canonicalRecords };
  const canonicalJson = JSON.stringify(canonicalLedger, null, 2) + "\\n";
  const canonicalText = ["Evidence Ledger Report", "Records: 4", "Subject: pump-a (3)", "- 2026-08-29T10:01:00Z [high] ev-001 | Pressure nominal | source=sensor-alpha | tags=pressure", "- 2026-08-29T10:02:00Z [low] ev-004 | Maintenance ticket opened | source=ops-console | tags=maintenance,ticket", "- 2026-08-29T10:03:00Z [medium] ev-003 | Pressure variance observed | source=sensor-beta | tags=pressure,variance", "Subject: pump-b (1)", "- 2026-08-29T10:02:00Z [high] ev-002 | Temperature nominal | source=sensor-alpha | tags=none", ""].join("\\n");
  const validJson = await renderJsonReport(validLedger);
  const shuffledJson = await renderJsonReport(shuffledLedger);
  const hardcodeJson = await renderJsonReport(hardcodeLedger);
  return [
    {
      clauseId: "CORE-HARDCODE-CONTROL",
      passed: hardcodeLedger?.recordCount === 2
        && JSON.stringify(hardcodeLedger?.subjects?.map(({ subject }) => subject)) === JSON.stringify(["router-x", "router-y"])
        && hardcodeJson !== canonicalJson,
    },
    { clauseId: "CORE-JSON-CANONICAL", passed: validJson === canonicalJson },
    { clauseId: "CORE-MUTATION-ORACLE", passed: await renderJsonReport(mutationLedger) === JSON.stringify(expectedMutationLedger, null, 2) + "\\n" && await renderTextReport(mutationLedger) === oracleText(expectedMutationLedger) },
    { clauseId: "CORE-SHUFFLED-INVARIANT", passed: shuffledJson === validJson },
    await staticBoundaryClause("CORE-STATIC-BOUNDARY", ["../src/record.mjs", "../src/validation.mjs", "../src/ledger.mjs", "../src/report.mjs"]),
    { clauseId: "CORE-SUBJECT-AGGREGATION", passed: JSON.stringify(validLedger?.subjects) === JSON.stringify(canonicalSubjects) },
    { clauseId: "CORE-TEXT-CANONICAL", passed: await renderTextReport(validLedger) === canonicalText },
  ];
}
const cliClauseIds = ["CLI-HELP", "CLI-INVALID-EXIT", "CLI-IO-EXIT", "CLI-JSON", "CLI-MUTATION-ORACLE", "CLI-NO-RESIDUE", "CLI-README", "CLI-STATIC-BOUNDARY", "CLI-TEXT", "CLI-USAGE-EXIT"];
const projectRoot = fileURLToPath(new URL("..", import.meta.url)); const cliPath = fileURLToPath(new URL("../bin/evidence-ledger.mjs", import.meta.url)); const controllerOpenSslConfig = process.env.OPENSSL_CONF ? await realpath(process.env.OPENSSL_CONF).then((value) => value === path.join(projectRoot, ".ccc-empty-openssl.cnf"), () => false) : false;
function runCli(args) { const childEnv = { PATH: process.env.PATH, ...(process.env.OPENSSL_CONF ? { OPENSSL_CONF: process.env.OPENSSL_CONF } : {}) };
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: projectRoot, encoding: "utf8", env: childEnv });
}
async function runCliChecked(args) { const before = await projectSnapshot(); const result = runCli(args); return { ...result, noResidue: JSON.stringify(await projectSnapshot()) === JSON.stringify(before) }; }
async function cliClauses() {
  const validPath = fileURLToPath(new URL("../fixtures/valid.ndjson", import.meta.url));
  const shuffledPath = fileURLToPath(new URL("../fixtures/valid-shuffled.ndjson", import.meta.url));
  const hardcodePath = fileURLToPath(new URL("../fixtures/hardcode-control.ndjson", import.meta.url));
  const help = await runCliChecked(["--help"]);
  const usage = await runCliChecked([]);
  const invalidFormat = await runCliChecked(["report", validPath, "--format", "yaml"]);
  const missingInput = await runCliChecked(["report", path.join(projectRoot, "fixtures/does-not-exist.ndjson"), "--format", "json"]);
  const validJson = await runCliChecked(["report", validPath, "--format", "json"]);
  const shuffledJson = await runCliChecked(["report", shuffledPath, "--format", "json"]);
  const hardcodeJson = await runCliChecked(["report", hardcodePath, "--format", "json"]);
  const validText = await runCliChecked(["report", validPath, "--format", "text"]);
  const mutationSeed = createHash("sha256").update(await readFile(new URL("../bin/evidence-ledger.mjs", import.meta.url))).digest("hex");
  const mutationRecords = [...lines(await fixture("valid")).map(JSON.parse), { id: "cli-mutation-" + mutationSeed.slice(0, 8), subject: "cli-subject-" + mutationSeed.slice(8, 16), claim: "CLI derived claim " + mutationSeed.slice(16, 24), observedAt: "2026-08-29T10:04:00Z", source: "cli-source-" + mutationSeed.slice(24, 32), confidence: "low", tags: ["cli-derived", mutationSeed.slice(32, 40)] }];
  const expectedMutationLedger = oracleLedger(mutationRecords);
  const mutationRoot = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-"));
  const mutationPath = path.join(mutationRoot, "mutation.ndjson");
  let mutationJson;
  let mutationText;
  try {
    await writeFile(mutationPath, mutationRecords.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    mutationJson = await runCliChecked(["report", mutationPath, "--format", "json"]);
    mutationText = await runCliChecked(["report", mutationPath, "--format", "text"]);
  } finally { await rm(mutationRoot, { recursive: true, force: true }); }
  const expectedText = ["Evidence Ledger Report", "Records: 4", "Subject: pump-a (3)", "- 2026-08-29T10:01:00Z [high] ev-001 | Pressure nominal | source=sensor-alpha | tags=pressure", "- 2026-08-29T10:02:00Z [low] ev-004 | Maintenance ticket opened | source=ops-console | tags=maintenance,ticket", "- 2026-08-29T10:03:00Z [medium] ev-003 | Pressure variance observed | source=sensor-beta | tags=pressure,variance", "Subject: pump-b (1)", "- 2026-08-29T10:02:00Z [high] ev-002 | Temperature nominal | source=sensor-alpha | tags=none", ""].join("\\n");
  let jsonPassed = validJson.status === 0 && validJson.stderr === "" && shuffledJson.status === 0 && shuffledJson.stdout === validJson.stdout && hardcodeJson.status === 0 && hardcodeJson.stdout !== validJson.stdout;
  try {
    const validValue = JSON.parse(validJson.stdout);
    const hardcodeValue = JSON.parse(hardcodeJson.stdout);
    jsonPassed = jsonPassed
      && validValue.schema === "evidence-ledger.report.v1"
      && validValue.recordCount === 4
      && hardcodeValue.recordCount === 2;
  } catch {
    jsonPassed = false;
  }
  const invalidCases = [["duplicate-id", "duplicate id"], ["invalid-calendar-date", "timestamp"], ["invalid-confidence", "confidence"], ["invalid-json", "invalid json"], ["invalid-timestamp", "timestamp"], ["missing-required-field", "missing"], ["unknown-field", "unknown field"]];
  let invalidPassed = true;
  let noResiduePassed = [help, usage, invalidFormat, missingInput, validJson, shuffledJson, hardcodeJson, validText, mutationJson, mutationText].every(({ noResidue }) => noResidue);
  for (const [name, message] of invalidCases) {
    const before = await projectSnapshot();
    const inputPath = fileURLToPath(new URL(\`../fixtures/\${name}.ndjson\`, import.meta.url));
    const result = await runCliChecked(["report", inputPath, "--format", "json"]);
    invalidPassed = invalidPassed
      && result.status === 2
      && result.stdout === ""
      && result.stderr.toLowerCase().includes(message);
    noResiduePassed = noResiduePassed
      && result.noResidue
      && JSON.stringify(await projectSnapshot()) === JSON.stringify(before);
  }

  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  return [
    {
      clauseId: "CLI-HELP",
      passed: help.status === 0
        && help.stderr === ""
        && help.stdout.includes("Usage:")
        && help.stdout.includes("--format json")
        && help.stdout.includes("--format text"),
    },
    { clauseId: "CLI-INVALID-EXIT", passed: invalidPassed },
    { clauseId: "CLI-IO-EXIT", passed: missingInput.status === 1 && missingInput.stdout === "" && missingInput.stderr === "input error: ENOENT\\n" },
    { clauseId: "CLI-JSON", passed: jsonPassed },
    { clauseId: "CLI-MUTATION-ORACLE", passed: mutationJson.status === 0 && mutationJson.stderr === "" && mutationJson.stdout === JSON.stringify(expectedMutationLedger, null, 2) + "\\n" && mutationText.status === 0 && mutationText.stderr === "" && mutationText.stdout === oracleText(expectedMutationLedger) },
    { clauseId: "CLI-NO-RESIDUE", passed: noResiduePassed },
    {
      clauseId: "CLI-README",
      passed: readme.includes("node bin/evidence-ledger.mjs report")
        && readme.includes("--format json")
        && readme.includes("--format text"),
    },
    await staticBoundaryClause("CLI-STATIC-BOUNDARY", ["../src/record.mjs", "../src/validation.mjs", "../src/ledger.mjs", "../src/report.mjs", "../bin/evidence-ledger.mjs"]),
    { clauseId: "CLI-TEXT", passed: validText.status === 0 && validText.stderr === "" && validText.stdout === expectedText },
    { clauseId: "CLI-USAGE-EXIT", passed: usage.status === 1 && usage.stdout === "" && usage.stderr.includes("Usage:") && invalidFormat.status === 1 && invalidFormat.stdout === "" && invalidFormat.stderr === usage.stderr },
  ];
}

async function listProjectFiles(relative = "") {
  const entries = await readdir(path.join(projectRoot, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (relative === "" && (entry.name === ".git" || (entry.name === ".ccc-empty-openssl.cnf" && controllerOpenSslConfig))) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listProjectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function projectSnapshot() {
  const snapshot = {};
  for (const relativePath of await listProjectFiles()) {
    snapshot[relativePath] = createHash("sha256")
      .update(await readFile(path.join(projectRoot, relativePath)))
      .digest("hex");
  }
  return snapshot;
}

async function staticBoundaryClause(clauseId, sourcePaths) {
  const source = (await Promise.all(sourcePaths.map(async (relativePath) =>
    await readFile(new URL(relativePath, import.meta.url), "utf8")))).join("\\n");
  const forbidden = /(?:node:(?:http|https|net|tls|dgram|child_process|vm|worker_threads)|\\b(?:child_process|vm|worker_threads)\\b|better-sqlite|postgres|randomUUID|Date\\.now|new Date\\s*\\(|\\bfetch\\s*\\(|\\bimport\\s*\\(|\\brequire\\s*\\(|\\bcreateRequire\\b|\\bgetBuiltinModule\\b|process\\.(?:binding|_linkedBinding)\\s*\\(|\\beval\\s*\\(|\\bFunction\\s*\\()/;
  return { clauseId, passed: !forbidden.test(source) };
}

async function projectCustodyClause() {
  const workerFiles = ["README.md", "bin/evidence-ledger.mjs", "src/ledger.mjs", "src/record.mjs", "src/report.mjs", "src/validation.mjs"];
  const expectedFiles = [...Object.keys(expectedBaselineHashes), "verify/project-verifier.mjs", ...workerFiles]
    .sort((left, right) => left.localeCompare(right));
  let passed = JSON.stringify(await listProjectFiles()) === JSON.stringify(expectedFiles);
  for (const [relativePath, expectedHash] of Object.entries(expectedBaselineHashes)) {
    const content = await readFile(path.join(projectRoot, relativePath));
    passed = passed && createHash("sha256").update(content).digest("hex") === expectedHash;
  }
  return { clauseId: "PROJECT-CUSTODY", passed };
}

async function main() {
  if (!admittedPhases.has(phase)) {
    process.stderr.write("usage: node verify/project-verifier.mjs contract|core|cli|project\\n");
    process.exitCode = 2;
    return;
  }

  let clauseResults;
  try {
    clauseResults = await contractClauses();
  } catch {
    clauseResults = ["CONTRACT-DUPLICATE-ID", "CONTRACT-INVALID-CALENDAR-DATE", "CONTRACT-INVALID-CONFIDENCE", "CONTRACT-INVALID-JSON", "CONTRACT-INVALID-TIMESTAMP", "CONTRACT-MISSING-REQUIRED", "CONTRACT-STATIC-BOUNDARY", "CONTRACT-UNKNOWN-FIELD", "CONTRACT-VALID"].map((clauseId) => ({ clauseId, passed: false }));
  }

  if (phase !== "contract") {
    try {
      clauseResults.push(...await coreClauses());
    } catch {
      clauseResults.push(...coreClauseIds.map((clauseId) => ({ clauseId, passed: false })));
    }
  }

  if (phase === "cli" || phase === "project") {
    try {
      clauseResults.push(...await cliClauses());
    } catch {
      clauseResults.push(...cliClauseIds.map((clauseId) => ({ clauseId, passed: false })));
    }
  }
  if (phase === "project") {
    try {
      clauseResults.push(await projectCustodyClause());
    } catch {
      clauseResults.push({ clauseId: "PROJECT-CUSTODY", passed: false });
    }
  }

  const passed = clauseResults.every(({ passed: clausePassed }) => clausePassed);
  const semanticByPhase = { contract: { proofId: "PROOF-LEDGER-CONTRACT", phase: "task", clauseIds: ["AC-REQ-LEDGER-CONTRACT-001"], caseId: "CASE-LEDGER-CONTRACT", controlId: "CONTROL-LEDGER-CONTRACT" }, core: { proofId: "PROOF-LEDGER-CORE", phase: "task", clauseIds: ["AC-REQ-LEDGER-CORE-001"], caseId: "CASE-LEDGER-CORE", controlId: "CONTROL-LEDGER-CORE" }, cli: { proofId: "PROOF-LEDGER-CLI", phase: "task", clauseIds: ["AC-REQ-LEDGER-CLI-001"], caseId: "CASE-LEDGER-CLI", controlId: "CONTROL-LEDGER-CLI" }, project: { proofId: "PROOF-LEDGER-INTEGRATED", phase: "final_integrated", clauseIds: ["AC-REQ-LEDGER-CONTRACT-001", "AC-REQ-LEDGER-CORE-001", "AC-REQ-LEDGER-CLI-001"], caseId: "CASE-LEDGER-INTEGRATED", controlId: "CONTROL-LEDGER-INTEGRATED" } };
  const semantic = { ...semanticByPhase[phase], ...(phase === "contract" && process.env.CCC_PROOF_ID === "PROOF-LEDGER-CONTRACT" && process.env.CCC_PROOF_PHASE === "final_integrated" ? { phase: "final_integrated" } : {}) };
  const campaignMode = campaignEnvKeys.some((key) => Object.hasOwn(process.env, key));
  const proofId = process.env.CCC_PROOF_ID ?? "";
  const campaignPhase = process.env.CCC_PROOF_PHASE ?? "";
  const sourceCommit = process.env.CCC_PROOF_SOURCE_COMMIT ?? "";
  const sourceTree = process.env.CCC_PROOF_SOURCE_TREE ?? "";
  const campaignIdentityValid = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(proofId) && ["task", "final_integrated"].includes(campaignPhase) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceTree);
  const semanticPassed = passed && campaignIdentityValid && proofId === semantic.proofId && campaignPhase === semantic.phase;
  const output = campaignMode ? { schema: "ccc-prd.proof-evidence.v2", proofId, phase: campaignPhase, sourceCommit, sourceTree, passed: semanticPassed, clauseResults: [...semantic.clauseIds].sort().map((clauseId) => ({ clauseId, passed: semanticPassed })), positiveCaseResults: [{ caseId: semantic.caseId, passed: semanticPassed }], negativeControlResults: [{ controlId: semantic.controlId, passed: semanticPassed }] } : { schema: "ccc-golden.project-proof.v1", phase, passed, clauseResults };
  process.stdout.write(canonicalJson(output) + "\\n");
  process.exitCode = (campaignMode ? semanticPassed : passed) ? 0 : 1;
}

await main();
`;

export function buildProjectVerifierSource(baselineHashes) {
  return PROJECT_VERIFIER_SOURCE_TEMPLATE.replace("__CCC_BASELINE_HASHES__", JSON.stringify(baselineHashes));
}
