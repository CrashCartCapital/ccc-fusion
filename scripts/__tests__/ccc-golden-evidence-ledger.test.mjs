import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  writeCliCandidate,
  writeContractCandidate,
  writeCoreCandidate,
} from "./helpers/ccc-golden-evidence-ledger-candidate.mjs";
const baselineFiles = [
  ".gitignore",
  "Taskfile.yml",
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
  "package.json",
  "verify/project-verifier.mjs",
].sort((left, right) => left.localeCompare(right));
const workerOwnedFiles = [
  "README.md",
  "bin/evidence-ledger.mjs",
  "src/ledger.mjs",
  "src/record.mjs",
  "src/report.mjs",
  "src/validation.mjs",
];
async function loadBuilder() {
  try {
    return await import("../lib/ccc-golden-evidence-ledger.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}
async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
const verifierPhaseInputs = { contract: ["src/record.mjs", "src/validation.mjs"], core: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"], cli: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"], project: ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"] };
function runVerifier(root, phase, options = {}) {
  return spawnSync(process.execPath, ["verify/project-verifier.mjs", ...verifierPhaseInputs[phase]], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...options.env },
  });
}
test("PRD:GOLDEN-1 baseline builder creates only trusted Evidence Ledger files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-red-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    if (typeof createEvidenceLedgerBaseline === "function") {
      await createEvidenceLedgerBaseline(root);
    }

    const files = await listFiles(root);
    assert.deepEqual(files, baselineFiles);
    for (const workerOwnedFile of workerOwnedFiles) {
      assert.equal(files.includes(workerOwnedFile), false, `${workerOwnedFile} must remain worker-owned and absent`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 baseline bytes are deterministic and encode the frozen phase contract", async () => {
  const leftRoot = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-left-"));
  const rightRoot = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-right-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    assert.equal(typeof createEvidenceLedgerBaseline, "function");
    await createEvidenceLedgerBaseline(leftRoot);
    await createEvidenceLedgerBaseline(rightRoot);

    const leftFiles = await listFiles(leftRoot);
    const rightFiles = await listFiles(rightRoot);
    assert.deepEqual(leftFiles, baselineFiles);
    assert.deepEqual(rightFiles, baselineFiles);
    for (const relativePath of baselineFiles) {
      assert.equal(
        await readFile(path.join(leftRoot, relativePath), "utf8"),
        await readFile(path.join(rightRoot, relativePath), "utf8"),
        `${relativePath} must be byte-stable`,
      );
    }
    const verifierSource = await readFile(path.join(leftRoot, "verify/project-verifier.mjs"), "utf8");
    assert.equal(verifierSource.trimEnd().split("\n").length <= 300, true, "generated verifier must stay within the reviewable line cap");

    const packageJson = JSON.parse(await readFile(path.join(leftRoot, "package.json"), "utf8"));
    assert.deepEqual(packageJson, {
      name: "ccc-golden-evidence-ledger",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        "verify:contract": "node verify/project-verifier.mjs src/record.mjs src/validation.mjs",
        "verify:core": "node verify/project-verifier.mjs src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs",
        "verify:cli": "node verify/project-verifier.mjs src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs README.md bin/evidence-ledger.mjs",
        "verify:project": "node verify/project-verifier.mjs README.md bin/evidence-ledger.mjs src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs",
        test: "node verify/project-verifier.mjs README.md bin/evidence-ledger.mjs src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs",
      },
    });

    const taskfile = await readFile(path.join(leftRoot, "Taskfile.yml"), "utf8");
    const phaseInputs = {
      contract: "src/record.mjs src/validation.mjs",
      core: "src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs",
      cli: "src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs README.md bin/evidence-ledger.mjs",
      project: "README.md bin/evidence-ledger.mjs src/record.mjs src/validation.mjs src/ledger.mjs src/report.mjs",
    };
    for (const phase of ["contract", "core", "cli", "project"]) {
      assert.match(taskfile, new RegExp(`verify:${phase}:`));
      assert.match(taskfile, new RegExp(`node verify/project-verifier\\.mjs ${phaseInputs[phase]}`));
    }

    const valid = (await readFile(path.join(leftRoot, "fixtures/valid.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const shuffled = (await readFile(path.join(leftRoot, "fixtures/valid-shuffled.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(valid.length, 4);
    assert.deepEqual(
      valid.map(({ id }) => id).sort(),
      shuffled.map(({ id }) => id).sort(),
    );
    assert.notDeepEqual(valid.map(({ id }) => id), shuffled.map(({ id }) => id));
    for (const record of valid) {
      assert.deepEqual(
        Object.keys(record).sort(),
        ["claim", "confidence", "id", "observedAt", "source", "subject", ...(record.tags ? ["tags"] : [])].sort(),
      );
    }
  } finally {
    await Promise.all([
      rm(leftRoot, { recursive: true, force: true }),
      rm(rightRoot, { recursive: true, force: true }),
    ]);
  }
});

test("PRD:GOLDEN-1 contract verifier rejects worker modules that do not enforce the record contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-contract-red-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    await createEvidenceLedgerBaseline(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/record.mjs"),
      "export const parseEvidenceLine = (line) => JSON.parse(line);\n",
    );
    await writeFile(
      path.join(root, "src/validation.mjs"),
      "export const validateEvidenceRecords = (records) => records;\n",
    );

    const result = runVerifier(root, "contract");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.schema, "ccc-golden.project-proof.v1");
    assert.equal(evidence.phase, "contract");
    assert.equal(evidence.passed, false);
    assert.equal(evidence.clauseResults.some(({ passed }) => passed === false), true);
    assert.deepEqual(
      evidence.clauseResults.map(({ clauseId }) => clauseId),
      [
        "CONTRACT-DUPLICATE-ID",
        "CONTRACT-INVALID-CALENDAR-DATE",
        "CONTRACT-INVALID-CONFIDENCE",
        "CONTRACT-INVALID-JSON",
        "CONTRACT-INVALID-TIMESTAMP",
        "CONTRACT-MISSING-REQUIRED",
        "CONTRACT-STATIC-BOUNDARY",
        "CONTRACT-UNKNOWN-FIELD",
        "CONTRACT-VALID",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 core verifier rejects non-canonical aggregation and rendering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-core-red-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    await writeFile(path.join(root, "src/ledger.mjs"), "export const buildLedger = (records) => ({ records });\n");
    await writeFile(path.join(root, "src/report.mjs"), [
      "export const renderJsonReport = () => '{}\\n';",
      "export const renderTextReport = () => 'Evidence Ledger Report\\n';",
      "",
    ].join("\n"));

    const result = runVerifier(root, "core");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.phase, "core");
    assert.equal(evidence.passed, false);
    assert.deepEqual(
      evidence.clauseResults.filter(({ clauseId }) => clauseId.startsWith("CORE-")).map(({ clauseId }) => clauseId),
      [
        "CORE-HARDCODE-CONTROL",
        "CORE-JSON-CANONICAL",
        "CORE-MUTATION-ORACLE",
        "CORE-SHUFFLED-INVARIANT",
        "CORE-STATIC-BOUNDARY",
        "CORE-SUBJECT-AGGREGATION",
        "CORE-TEXT-CANONICAL",
      ],
    );
    assert.equal(evidence.clauseResults.some(({ clauseId, passed }) => clauseId.startsWith("CORE-") && passed === false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 CLI verifier rejects a command that violates help, output, and exit contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-cli-red-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    await createEvidenceLedgerBaseline(root);
    await writeCoreCandidate(root);
    assert.equal(runVerifier(root, "core").status, 0, "test candidate must satisfy the core phase");
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin/evidence-ledger.mjs"), "process.stdout.write('not a ledger\\n');\n");
    await writeFile(path.join(root, "README.md"), "# Placeholder\n");

    const result = runVerifier(root, "cli");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.phase, "cli");
    assert.equal(evidence.passed, false);
    assert.deepEqual(
      evidence.clauseResults.filter(({ clauseId }) => clauseId.startsWith("CLI-")).map(({ clauseId }) => clauseId),
      [
        "CLI-HELP",
        "CLI-INVALID-EXIT",
        "CLI-IO-EXIT",
        "CLI-JSON",
        "CLI-MUTATION-ORACLE",
        "CLI-NO-RESIDUE",
        "CLI-README",
        "CLI-STATIC-BOUNDARY",
        "CLI-TEXT",
        "CLI-USAGE-EXIT",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 project verifier accepts a real multi-module candidate and every mutation control", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-project-green-"));
  try {
    const { createEvidenceLedgerBaseline } = await loadBuilder();
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);

    const result = runVerifier(root, "project");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.schema, "ccc-golden.project-proof.v1");
    assert.equal(evidence.phase, "project");
    assert.equal(evidence.passed, true);
    assert.equal(evidence.clauseResults.length, 27);
    assert.equal(evidence.clauseResults.every(({ passed }) => passed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
