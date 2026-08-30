import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  writeCliCandidate,
  writeContractCandidate,
} from "./helpers/ccc-golden-evidence-ledger-candidate.mjs";
import { createEvidenceLedgerBaseline } from "../lib/ccc-golden-evidence-ledger.mjs";

const phaseInputs = {
  contract: ["src/record.mjs", "src/validation.mjs"],
  core: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
  cli: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
  project: ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
};

function runVerifier(root, phase, env = {}) {
  return spawnSync(process.execPath, ["verify/project-verifier.mjs", ...phaseInputs[phase]], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

function canonicalJson(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol"
    || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("not canonical JSON");
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function campaignEnv(overrides = {}) {
  const env = {
    CCC_PROOF_ID: "PROOF-LEDGER-CONTRACT",
    CCC_PROOF_PHASE: "task",
    CCC_PROOF_SOURCE_COMMIT: "a".repeat(40),
    CCC_PROOF_SOURCE_TREE: "b".repeat(40),
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

function semanticEvidence(result, label) {
  assert.equal(result.status, 1, `${label}: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${label} must not emit non-JSON diagnostics`);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schema, "ccc-prd.proof-evidence.v2");
  assert.equal(evidence.passed, false, label);
  assert.equal(result.stdout, `${canonicalJson(evidence)}\n`, `${label} must be canonical JSON`);
  return evidence;
}

test("PRD:GOLDEN-1 baseline ignores every Fusion-owned runtime directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-ignore-"));
  try {
    await createEvidenceLedgerBaseline(root);
    assert.equal(
      await readFile(path.join(root, ".gitignore"), "utf8"),
      ".fusion/\n.fusion-global-settings/\n.worktrees/\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 campaign mode requires complete proof identity and emits canonical failure JSON", async () => {
  const cases = [
    ["missing proof ID", { CCC_PROOF_ID: undefined }],
    ["missing phase", { CCC_PROOF_PHASE: undefined }],
    ["invalid phase", { CCC_PROOF_PHASE: "verify" }],
    ["invalid source commit", { CCC_PROOF_SOURCE_COMMIT: "not-a-git-object" }],
    ["short source tree", { CCC_PROOF_SOURCE_TREE: "b".repeat(39) }],
  ];
  for (const [label, overrides] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-identity-red-"));
    try {
      await createEvidenceLedgerBaseline(root);
      await writeContractCandidate(root);
      semanticEvidence(runVerifier(root, "contract", campaignEnv(overrides)), label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("PRD:GOLDEN-1 campaign mode accepts canonical 40- and 64-hex source identities", async () => {
  for (const length of [40, 64]) {
    const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-identity-green-"));
    try {
      await createEvidenceLedgerBaseline(root);
      await writeContractCandidate(root);
      const result = runVerifier(root, "contract", campaignEnv({
        CCC_PROOF_SOURCE_COMMIT: "a".repeat(length),
        CCC_PROOF_SOURCE_TREE: "b".repeat(length),
      }));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.passed, true);
      assert.equal(result.stdout, `${canonicalJson(evidence)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("PRD:GOLDEN-4 contract proof can rerun as the one-task final integrated gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-contract-final-green-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeContractCandidate(root);
    const result = runVerifier(root, "contract", campaignEnv({
      CCC_PROOF_PHASE: "final_integrated",
    }));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      clauseResults: [{ clauseId: "AC-REQ-LEDGER-CONTRACT-001", passed: true }],
      negativeControlResults: [{ controlId: "CONTROL-LEDGER-CONTRACT", passed: true }],
      passed: true,
      phase: "final_integrated",
      positiveCaseResults: [{ caseId: "CASE-LEDGER-CONTRACT", passed: true }],
      proofId: "PROOF-LEDGER-CONTRACT",
      schema: "ccc-prd.proof-evidence.v2",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 integrated campaign custody admits only its controller-owned OpenSSL config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-openssl-green-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const opensslConfig = path.join(root, ".ccc-empty-openssl.cnf");
    await writeFile(opensslConfig, "");
    const result = runVerifier(root, "project", campaignEnv({
      CCC_PROOF_ID: "PROOF-LEDGER-INTEGRATED",
      CCC_PROOF_PHASE: "final_integrated",
      OPENSSL_CONF: opensslConfig,
    }));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.passed, true);
    assert.deepEqual(evidence.clauseResults.map(({ clauseId }) => clauseId), [
      "AC-REQ-LEDGER-CLI-001",
      "AC-REQ-LEDGER-CONTRACT-001",
      "AC-REQ-LEDGER-CORE-001",
    ]);
    const unbound = runVerifier(root, "project", campaignEnv({
      CCC_PROOF_ID: "PROOF-LEDGER-INTEGRATED",
      CCC_PROOF_PHASE: "final_integrated",
    }));
    assert.equal(unbound.status, 1);
    assert.equal(JSON.parse(unbound.stdout).passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 explicit local phase keeps CLI proof distinct from project custody", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-phase-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    await writeFile(path.join(root, "worker-note.txt"), "outside project custody\n");

    const cli = spawnSync(process.execPath, ["verify/project-verifier.mjs", ...phaseInputs.cli], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    assert.equal(JSON.parse(cli.stdout).phase, "cli");

    const project = spawnSync(process.execPath, ["verify/project-verifier.mjs", ...phaseInputs.project], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(project.status, 1, project.stdout);
    assert.equal(JSON.parse(project.stdout).phase, "project");

    const mismatchedExplicitPhase = spawnSync(
      process.execPath,
      ["verify/project-verifier.mjs", "cli", ...phaseInputs.project],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    assert.equal(mismatchedExplicitPhase.status, 2);
    assert.match(mismatchedExplicitPhase.stderr, /usage:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const forbiddenModules = ["child_process", "vm", "worker_threads"];
const forbiddenSpecifiers = forbiddenModules.flatMap((name) => [name, `node:${name}`]);
const forbiddenLoaderForms = [
  (specifier) => `if (false) module["require"]("${specifier}");`,
  (specifier) => `if (false) importModuleDynamically("${specifier}");`,
];

test("PRD:GOLDEN-1 static boundary rejects process loaders for child_process, vm, and worker_threads", async () => {
  for (const specifier of forbiddenSpecifiers) {
    for (const buildForbiddenSource of [
      (value) => `import "${value}";`,
      ...forbiddenLoaderForms,
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-static-red-"));
      try {
        await createEvidenceLedgerBaseline(root);
        await writeContractCandidate(root);
        const recordPath = path.join(root, "src/record.mjs");
        await writeFile(recordPath, `${buildForbiddenSource(specifier)}\n${await readFile(recordPath, "utf8")}`);

        const result = runVerifier(root, "contract");
        assert.equal(result.status, 1, `${specifier}: ${buildForbiddenSource(specifier)}`);
        const evidence = JSON.parse(result.stdout);
        assert.deepEqual(
          evidence.clauseResults.find(({ clauseId }) => clauseId === "CONTRACT-STATIC-BOUNDARY"),
          { clauseId: "CONTRACT-STATIC-BOUNDARY", passed: false },
          `${specifier}: ${buildForbiddenSource(specifier)}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("PRD:GOLDEN-1 CLI proof checks residue after every successful invocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-verifier-success-residue-red-"));
  try {
    await createEvidenceLedgerBaseline(root);
    await writeCliCandidate(root);
    const cliPath = path.join(root, "bin/evidence-ledger.mjs");
    const source = (await readFile(cliPath, "utf8"))
      .replace('import { readFileSync } from "node:fs";', 'import { readFileSync, writeFileSync } from "node:fs";')
      .replace('process.stdout.write(usage);', 'writeFileSync("success-help-residue.txt", "leak\\n");\n    process.stdout.write(usage);')
      .replace(
        'process.stdout.write(args[3] === "json" ? renderJsonReport(ledger) : renderTextReport(ledger));',
        'writeFileSync("success-report-residue.txt", "leak\\n");\n      process.stdout.write(args[3] === "json" ? renderJsonReport(ledger) : renderTextReport(ledger));',
      );
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
