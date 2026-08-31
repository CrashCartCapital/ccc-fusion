import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeCliCandidate, writeContractCandidate, writeCoreCandidate } from "./helpers/ccc-golden-evidence-ledger-candidate.mjs";
import { createEvidenceLedgerBaseline } from "../lib/ccc-golden-evidence-ledger.mjs";

function runVerifier(root, phase = "project") {
  const phaseInputs = {
    contract: ["src/record.mjs", "src/validation.mjs"],
    core: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
    cli: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
    project: ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
  };
  return spawnSync(process.execPath, ["verify/project-verifier.mjs", ...phaseInputs[phase]], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

function expectedLedger(records) {
  const canonicalRecords = records
    .map((record) => ({ ...record, ...(record.tags ? { tags: [...record.tags].sort() } : {}) }))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const bySubject = new Map();
  for (const record of canonicalRecords) {
    bySubject.set(record.subject, [...(bySubject.get(record.subject) ?? []), record.id]);
  }
  return {
    schema: "evidence-ledger.report.v1",
    recordCount: canonicalRecords.length,
    subjects: [...bySubject].sort(([left], [right]) => left.localeCompare(right))
      .map(([subject, recordIds]) => ({ subject, count: recordIds.length, recordIds })),
    records: canonicalRecords,
  };
}

async function fixtureRecords(root, name) {
  return (await readFile(path.join(root, `fixtures/${name}.ndjson`), "utf8"))
    .trimEnd().split("\n").map(JSON.parse);
}

test("PRD:GOLDEN-1 project proof rejects baseline drift and extra worker files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-custody-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    assert.equal(runVerifier(root).status, 0, "test candidate must satisfy the project proof before custody drift");

    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(path.join(root, "Taskfile.yml"), "version: '3'\n");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/unauthorized.mjs"), "export const escaped = true;\n");

    const result = runVerifier(root);
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.passed, false);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "PROJECT-CUSTODY"),
      { clauseId: "PROJECT-CUSTODY", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 project proof rejects implementations hardcoded to visible fixtures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-hardcode-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const validLedger = expectedLedger(await fixtureRecords(root, "valid"));
    const controlLedger = expectedLedger(await fixtureRecords(root, "hardcode-control"));
    await writeFile(path.join(root, "src/ledger.mjs"), [
      `const validLedger = ${JSON.stringify(validLedger)};`,
      `const controlLedger = ${JSON.stringify(controlLedger)};`,
      "export function buildLedger(records) {",
      "  return structuredClone(records.length === 2 ? controlLedger : validLedger);",
      "}",
      "",
    ].join("\n"));

    const result = runVerifier(root);
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CORE-MUTATION-ORACLE"),
      { clauseId: "CORE-MUTATION-ORACLE", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 project proof rejects CLIs hardcoded to visible fixture paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-cli-hardcode-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const validLedger = expectedLedger(await fixtureRecords(root, "valid"));
    const controlLedger = expectedLedger(await fixtureRecords(root, "hardcode-control"));
    const cliPath = path.join(root, "bin/evidence-ledger.mjs");
    const source = (await readFile(cliPath, "utf8")).replace(
      "const ledger = buildLedger(validateEvidenceRecords(records));",
      `validateEvidenceRecords(records);\n      const ledger = args[1].includes("hardcode-control") ? ${JSON.stringify(controlLedger)} : ${JSON.stringify(validLedger)};`,
    );
    await writeFile(cliPath, source);

    const result = runVerifier(root);
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CLI-MUTATION-ORACLE"),
      { clauseId: "CLI-MUTATION-ORACLE", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 CLI proof rejects validation handling that leaves filesystem residue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-residue-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const cliPath = path.join(root, "bin/evidence-ledger.mjs");
    const source = (await readFile(cliPath, "utf8"))
      .replace('import { readFileSync } from "node:fs";', 'import { readFileSync, writeFileSync } from "node:fs";')
      .replace('process.stderr.write(error.message + "\\n");', 'writeFileSync("residue.txt", "leak\\n");\n      process.stderr.write(error.message + "\\n");');
    await writeFile(cliPath, source);

    const result = runVerifier(root, "cli");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CLI-NO-RESIDUE"),
      { clauseId: "CLI-NO-RESIDUE", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 CLI proof includes hidden campaign directories in no-residue checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-hidden-residue-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const cliPath = path.join(root, "bin/evidence-ledger.mjs");
    const source = (await readFile(cliPath, "utf8"))
      .replace('import { readFileSync } from "node:fs";', 'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";')
      .replace('process.stderr.write(error.message + "\\n");', 'mkdirSync(".fusion", { recursive: true });\n      writeFileSync(".fusion/residue.txt", "leak\\n");\n      process.stderr.write(error.message + "\\n");');
    await writeFile(cliPath, source);

    const result = runVerifier(root, "cli");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CLI-NO-RESIDUE"),
      { clauseId: "CLI-NO-RESIDUE", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 CLI proof enforces input IO and invalid-format exit contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-cli-io-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const cliPath = path.join(root, "bin/evidence-ledger.mjs");
    const source = (await readFile(cliPath, "utf8")).replace(
      'process.stderr.write("input error: " + error.code + "\\n");\n    process.exitCode = 1;',
      'process.stderr.write("input error: " + error.code + "\\n");\n    process.exitCode = 2;',
    );
    await writeFile(cliPath, source);

    const result = runVerifier(root, "cli");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CLI-IO-EXIT"),
      { clauseId: "CLI-IO-EXIT", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 contract proof rejects forbidden runtime imports before downstream tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-contract-static-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    const recordPath = path.join(root, "src/record.mjs");
    await writeFile(recordPath, `import "node:http";\n${await readFile(recordPath, "utf8")}`);

    const result = runVerifier(root, "contract");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CONTRACT-STATIC-BOUNDARY"),
      { clauseId: "CONTRACT-STATIC-BOUNDARY", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 contract proof rejects split dynamic runtime imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-contract-dynamic-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    const recordPath = path.join(root, "src/record.mjs");
    await writeFile(recordPath, `const forbiddenRuntime = "node:" + "http";\nawait import(forbiddenRuntime);\n${await readFile(recordPath, "utf8")}`);

    const result = runVerifier(root, "contract");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CONTRACT-STATIC-BOUNDARY"),
      { clauseId: "CONTRACT-STATIC-BOUNDARY", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 contract proof rejects Node builtin-loader backdoors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-contract-builtin-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    const recordPath = path.join(root, "src/record.mjs");
    await writeFile(recordPath, `const http = process.getBuiltinModule("node:" + "http");\nvoid http;\n${await readFile(recordPath, "utf8")}`);

    const result = runVerifier(root, "contract");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CONTRACT-STATIC-BOUNDARY"),
      { clauseId: "CONTRACT-STATIC-BOUNDARY", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 core proof rejects forbidden runtime imports before the CLI task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-core-static-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCoreCandidate(root);
    const ledgerPath = path.join(root, "src/ledger.mjs");
    await writeFile(ledgerPath, `import "node:http";\n${await readFile(ledgerPath, "utf8")}`);

    const result = runVerifier(root, "core");
    assert.equal(result.status, 1, result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(
      evidence.clauseResults.find(({ clauseId }) => clauseId === "CORE-STATIC-BOUNDARY"),
      { clauseId: "CORE-STATIC-BOUNDARY", passed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
