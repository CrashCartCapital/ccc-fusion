import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalCccPrdJson } from "../../../core/src/ccc-prd/contract.js";

/*
 * W3-T2 Lane A: harness tests for the ccc-python-proof-adapter template.
 *
 * These tests exec the real python3 adapter (stdlib only) on fixture inputs
 * and assert its fail-closed refusal contract. The adapter MUST refuse —
 * never pass — any run whose evidence would be vacuous or malformed.
 *
 * Conventions follow run-verification-command.test.ts / ccc-campaign-proof-execution.test.ts:
 * exec external tooling via node:child_process, resolve workspace paths from import.meta.url.
 */

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const adapterDir = `${workspaceRoot}templates/ccc-python-proof-adapter`;
const adapterPath = `${adapterDir}/verify_wrapper.py`;
const fixturesDir = `${adapterDir}/fixtures`;

const python3 = process.platform === "win32" ? "python" : "python3";

interface AdapterRun {
  status: number;
  stdout: string;
  stderr: string;
}

const tempTargets: string[] = [];

function runAdapter(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): AdapterRun {
  try {
    const stdout = execFileSync(python3, [adapterPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        ...extraEnv,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf8",
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function adapterArgs(proofId: string, target: string): string[] {
  return [
    "--proof-id", proofId,
    "--source-commit", "5".repeat(40),
    "--source-tree", "6".repeat(40),
    "--target", target,
  ];
}

function expectRefusal(run: AdapterRun, code: string): void {
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(`REFUSED ${code}:`);
  expect(run.stderr).not.toContain("ccc-prd.proof-terminal-envelope.v2");
}

function validReport(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clauseResults: [{ clauseId: "clause.valid", passed: true }],
    positiveCaseResults: [{ caseId: "case.valid", passed: true }],
    negativeControlResults: [{ controlId: "control.invalid", passed: true }],
    ...extra,
  };
}

function tempTarget(): string {
  const target = mkdtempSync(join(tmpdir(), "ccc-python-proof-adapter-"));
  tempTargets.push(target);
  return target;
}

function writeManifest(target: string, reportCommand: readonly string[]): void {
  writeFileSync(join(target, "verify_manifest.json"), JSON.stringify({
    report_command: reportCommand,
    report_file: "verify-report.json",
  }));
}

function writeReportGenerator(target: string, report: Record<string, unknown>, exitCode = 0): void {
  const reportJson = JSON.stringify(report);
  writeFileSync(join(target, "gen_report.py"), [
    "from pathlib import Path",
    `Path('verify-report.json').write_text(${JSON.stringify(reportJson)}, encoding='utf-8')`,
    `raise SystemExit(${exitCode})`,
    "",
  ].join("\n"));
  writeManifest(target, [python3, "gen_report.py"]);
}

function writeRawReportGenerator(target: string, rawReport: string): void {
  writeFileSync(join(target, "gen_report.py"), [
    "from pathlib import Path",
    `Path('verify-report.json').write_text(${JSON.stringify(rawReport)}, encoding='utf-8')`,
    "",
  ].join("\n"));
  writeManifest(target, [python3, "gen_report.py"]);
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

const EVIDENCE_KEYS = [
  "clauseResults",
  "negativeControlResults",
  "passed",
  "phase",
  "positiveCaseResults",
  "proofId",
  "schema",
  "sourceCommit",
  "sourceTree",
] as const;

describe("ccc-python-proof-adapter fail-closed evidence contract", () => {
  afterEach(() => {
    for (const target of tempTargets.splice(0)) rmSync(target, { recursive: true, force: true });
  });

  it("passes a healthy fixture target emitting exact ccc-prd.proof-evidence.v2 evidence", () => {
    const run = runAdapter(adapterArgs("PROOF-W3T2-FIXTURE", fixturesDir));

    expect(run.status).toBe(0);
    const evidence = parseJsonOutput(run.stdout);
    expect(Object.keys(evidence).sort()).toEqual([...EVIDENCE_KEYS]);
    expect(evidence.schema).toBe("ccc-prd.proof-evidence.v2");
    expect(evidence.phase).toBe("task");
    expect(evidence.passed).toBe(true);
    expect(run.stdout).toBe(`${canonicalCccPrdJson(evidence)}\n`);
    expect(existsSync(`${fixturesDir}/verify-report.json`)).toBe(false);
  });

  it("RED-R1-python-semantic-v2-controller-env: consumes controller proof identity when CLI identity flags are absent", () => {
    const run = runAdapter([
      "--target", fixturesDir,
    ], {
      CCC_PROOF_ID: "PROOF-W3T2-ENV",
      CCC_PROOF_PHASE: "final_integrated",
      CCC_PROOF_SOURCE_COMMIT: "5".repeat(40),
      CCC_PROOF_SOURCE_TREE: "6".repeat(40),
    });

    expect(run.status).toBe(0);
    const evidence = parseJsonOutput(run.stdout);
    expect(evidence.proofId).toBe("PROOF-W3T2-ENV");
    expect(evidence.phase).toBe("final_integrated");
    expect(evidence.sourceCommit).toBe("5".repeat(40));
    expect(evidence.sourceTree).toBe("6".repeat(40));
  });

  it("refuses a newline-terminated git object instead of emitting invalid evidence", () => {
    const args = adapterArgs("PROOF-W3T2-GIT-NEWLINE", fixturesDir);
    args[3] = `${"5".repeat(40)}\n`;

    expectRefusal(runAdapter(args), "malformed_evidence_json");
  });

  it("keeps pytest and explicit-unittest evidence equivalent", () => {
    const pytestRun = runAdapter(adapterArgs("PROOF-W3T2-PYTEST", fixturesDir));
    const unittestTarget = tempTarget();
    writeFileSync(
      join(unittestTarget, "run_target.py"),
      readFileSync(join(fixturesDir, "run_target.py"), "utf8"),
    );
    writeFileSync(
      join(unittestTarget, "test_fixture_target.py"),
      readFileSync(join(fixturesDir, "test_fixture_target.py"), "utf8"),
    );
    writeManifest(unittestTarget, [python3, "run_target.py", "--runner", "unittest"]);
    execFileSync(python3, ["run_target.py", "--runner", "unittest"], {
      cwd: unittestTarget,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf8" },
    });
    const rawUnittest = JSON.parse(
      readFileSync(join(unittestTarget, "verify-report.json"), "utf8"),
    ) as { _runner: string };
    expect(rawUnittest._runner).toBe("unittest");
    rmSync(join(unittestTarget, "verify-report.json"));
    const unittestRun = runAdapter(adapterArgs("PROOF-W3T2-UNITTEST", unittestTarget));

    expect(pytestRun.status).toBe(0);
    expect(unittestRun.status).toBe(0);
    const pytestEvidence = parseJsonOutput(pytestRun.stdout);
    const unittestEvidence = parseJsonOutput(unittestRun.stdout);
    expect({ ...pytestEvidence, proofId: "same" }).toEqual({ ...unittestEvidence, proofId: "same" });
  });

  it("refuses-mock-zero-proof-output: zero positive cases is a refusal, never a pass", () => {
    const run = runAdapter(adapterArgs("PROOF-W3T2-MOCKZERO", `${fixturesDir}/../mock-zero-target`));

    expectRefusal(run, "mock_zero_positive_cases");
  });

  it("refuses-missing-clause-result: evidence with no clause results must fail closed", () => {
    const run = runAdapter(adapterArgs("PROOF-W3T2-NOCLAUSE", `${fixturesDir}/../no-clause-target`));

    expectRefusal(run, "missing_clause_results");
  });

  it("refuses-malformed-evidence-json: unparseable upstream report JSON is a refusal", () => {
    const run = runAdapter(adapterArgs("PROOF-W3T2-MALFORMED", `${fixturesDir}/../malformed-target`));

    expectRefusal(run, "malformed_evidence_json");
  });

  it("refuses a failing negative control: aggregate passed must be false and exit nonzero", () => {
    const run = runAdapter(adapterArgs("PROOF-W3T2-NEGCTRL", `${fixturesDir}/../broken-negative-control-target`));

    expectRefusal(run, "negative_control_not_closed");
  });

  it("refuses a failed report command and cannot reuse stale passing evidence", () => {
    const target = tempTarget();
    writeReportGenerator(target, validReport(), 7);
    writeFileSync(join(target, "verify-report.json"), JSON.stringify(validReport()));

    const run = runAdapter(adapterArgs("PROOF-W3T2-STALE", target));

    expectRefusal(run, "target_execution_failed");
    expect(existsSync(join(target, "verify-report.json"))).toBe(false);
  });

  it("refuses unknown raw report fields instead of silently dropping them", () => {
    const target = tempTarget();
    writeReportGenerator(target, validReport({ unexpected: true }));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-EXTRA", target)), "malformed_evidence_json");
  });

  it("refuses duplicate raw report keys instead of accepting the last value", () => {
    const target = tempTarget();
    writeRawReportGenerator(target, [
      "{",
      "  \"clauseResults\": [{\"clauseId\":\"clause.valid\",\"passed\":false}],",
      "  \"clauseResults\": [{\"clauseId\":\"clause.valid\",\"passed\":true}],",
      "  \"positiveCaseResults\": [{\"caseId\":\"case.valid\",\"passed\":true}],",
      "  \"negativeControlResults\": [{\"controlId\":\"control.invalid\",\"passed\":true}]",
      "}",
    ].join("\n"));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-REPORT-DUP", target)), "malformed_evidence_json");
  });

  it("refuses unknown manifest fields instead of treating them as runner input", () => {
    const target = tempTarget();
    writeFileSync(join(target, "verify_manifest.json"), JSON.stringify({
      report_command: [python3, "gen_report.py"],
      report_file: "verify-report.json",
      shell: true,
    }));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-MANIFEST-EXTRA", target)), "malformed_evidence_json");
  });

  it("refuses duplicate manifest keys instead of accepting the last value", () => {
    const target = tempTarget();
    writeReportGenerator(target, validReport());
    writeFileSync(join(target, "verify_manifest.json"), [
      "{",
      `  "report_command": [${JSON.stringify(python3)}, "gen_report.py"],`,
      "  \"report_file\": \"ignored.json\",",
      "  \"report_file\": \"verify-report.json\"",
      "}",
    ].join("\n"));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-MANIFEST-DUP", target)), "malformed_evidence_json");
  });

  it("refuses an oversized manifest before parsing it", () => {
    const target = tempTarget();
    writeFileSync(join(target, "verify_manifest.json"), " ".repeat(65_537));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-MANIFEST-SIZE", target)), "malformed_evidence_json");
  });

  it("refuses report paths with either platform separator", () => {
    const target = tempTarget();
    for (const [proofId, reportFile] of [
      ["PROOF-W3T2-PATH-SLASH", "../verify-report.json"],
      ["PROOF-W3T2-PATH-BACKSLASH", "..\\verify-report.json"],
    ] as const) {
      writeFileSync(join(target, "verify_manifest.json"), JSON.stringify({
        report_command: [python3, "gen_report.py"],
        report_file: reportFile,
      }));
      expectRefusal(runAdapter(adapterArgs(proofId, target)), "malformed_evidence_json");
    }
  });

  it("refuses a NUL report filename without leaking a traceback", () => {
    const target = tempTarget();
    writeFileSync(join(target, "verify_manifest.json"), JSON.stringify({
      report_command: [python3, "gen_report.py"],
      report_file: "verify-report.json\0ignored",
    }));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-PATH-NUL", target)), "malformed_evidence_json");
  });

  it("refuses shell and traversal report commands", () => {
    const target = tempTarget();
    for (const [proofId, command] of [
      ["PROOF-W3T2-COMMAND-SHELL", ["sh", "-c", "true"]],
      ["PROOF-W3T2-COMMAND-TRAVERSAL", [python3, "../outside.py"]],
    ] as const) {
      writeManifest(target, command);
      expectRefusal(runAdapter(adapterArgs(proofId, target)), "malformed_evidence_json");
    }
  });

  it("refuses a nonzero target-suite report even when every listed result passes", () => {
    const target = tempTarget();
    writeReportGenerator(target, validReport({ _exit_code: 1, _runner: "pytest" }));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-EXIT", target)), "target_failed");
  });

  it("formats an oversized canonical evidence refusal without a traceback", () => {
    const target = tempTarget();
    writeReportGenerator(target, validReport({
      positiveCaseResults: Array.from({ length: 550 }, (_, index) => ({
        caseId: `case.${String(index).padStart(4, "0")}.${"x".repeat(200)}`,
        passed: true,
      })),
    }));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-EVIDENCE-SIZE", target)), "malformed_evidence_json");
  });

  it.runIf(process.platform !== "win32")("refuses a symlink report without touching its target", () => {
    const target = tempTarget();
    const outside = join(tempTarget(), "outside-report.json");
    writeFileSync(outside, JSON.stringify(validReport()));
    writeFileSync(join(target, "noop.py"), "raise SystemExit(0)\n");
    writeManifest(target, [python3, "noop.py"]);
    symlinkSync(outside, join(target, "verify-report.json"));

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-SYMLINK", target)), "malformed_evidence_json");
    expect(existsSync(outside)).toBe(true);
  });

  it.runIf(process.platform !== "win32")("refuses a symlink target directory", () => {
    const parent = tempTarget();
    const targetLink = join(parent, "target-link");
    symlinkSync(fixturesDir, targetLink);

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-TARGET-SYMLINK", targetLink)), "malformed_evidence_json");
  });

  it.runIf(process.platform !== "win32")("refuses a symlink target with a trailing separator", () => {
    const parent = tempTarget();
    const targetLink = join(parent, "target-link");
    symlinkSync(fixturesDir, targetLink);

    expectRefusal(
      runAdapter(adapterArgs("PROOF-W3T2-TARGET-SYMLINK-SLASH", `${targetLink}/`)),
      "malformed_evidence_json",
    );
  });

  it("AND-merges duplicate pytest method names instead of overwriting a failure", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_duplicate_target.py"), [
      "class TestFirst:",
      "    def test_case_duplicate(self): assert False",
      "class TestSecond:",
      "    def test_case_duplicate(self): assert True",
      "",
    ].join("\n"));

    execFileSync(python3, ["run_target.py"], {
      cwd: target,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf8" },
    });
    const report = JSON.parse(readFileSync(join(target, "verify-report.json"), "utf8")) as {
      positiveCaseResults: Array<{ caseId: string; passed: boolean }>;
    };

    expect(report.positiveCaseResults).toContainEqual({ caseId: "case.duplicate", passed: false });
  });

  it.runIf(process.platform !== "win32")("kills runner descendants and removes late reports on timeout", () => {
    const target = tempTarget();
    writeFileSync(join(target, "spawn_late.py"), [
      "import subprocess, sys, time",
      "child = \"import pathlib,time; time.sleep(0.4); pathlib.Path('verify-report.json').write_text('{}', encoding='utf-8')\"",
      "subprocess.Popen([sys.executable, '-c', child])",
      "time.sleep(5)",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "spawn_late.py"]);
    const probe = [
      "import importlib.util, pathlib, sys, time",
      "sys.dont_write_bytecode = True",
      "spec = importlib.util.spec_from_file_location('adapter', sys.argv[1])",
      "adapter = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(adapter)",
      "target = pathlib.Path(sys.argv[2])",
      "adapter.RUNNER_TIMEOUT_SECONDS = 0.1",
      "try:",
      "    adapter.run_target(target)",
      "except adapter.Refusal as refusal:",
      "    print(refusal.code)",
      "time.sleep(0.8)",
      "print((target / 'verify-report.json').exists())",
      "",
    ].join("\n");

    const stdout = execFileSync(python3, ["-c", probe, adapterPath, target], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf8" },
    });

    expect(stdout).toBe("runner_timeout\nFalse\n");
  });

  it.runIf(process.platform !== "win32")("kills runner descendants after a successful parent exit", async () => {
    const target = tempTarget();
    writeFileSync(join(target, "spawn_after_success.py"), [
      "import json, subprocess, sys",
      "report = {",
      "  'clauseResults': [{'clauseId': 'clause.success', 'passed': True}],",
      "  'positiveCaseResults': [{'caseId': 'case.success', 'passed': True}],",
      "  'negativeControlResults': [{'controlId': 'control.success', 'passed': True}],",
      "}",
      "with open('verify-report.json', 'w', encoding='utf-8') as handle: json.dump(report, handle)",
      "child = \"import pathlib,time; time.sleep(0.4); pathlib.Path('verify-report.json').write_text('{}', encoding='utf-8')\"",
      "subprocess.Popen([sys.executable, '-c', child])",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "spawn_after_success.py"]);

    const run = runAdapter(adapterArgs("PROOF-W3T2-SUCCESS-DESCENDANT", target));
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(run.status).toBe(0);
    expect(existsSync(join(target, "verify-report.json"))).toBe(false);
  });

  it("runs the report command with a closed environment", () => {
    const target = tempTarget();
    writeFileSync(join(target, "gen_report.py"), [
      "import json, os",
      "closed = os.environ.get('UNTRUSTED_PARENT_VALUE') is None and os.environ.get('CCC_PYTHON_PROOF_FORCE_UNITTEST') is None and os.environ.get('PYTHONHOME') is None and os.environ.get('PYTHONPATH') is None and os.environ.get('PYTEST_DISABLE_PLUGIN_AUTOLOAD') == '1'",
      "report = {",
      "  'clauseResults': [{'clauseId': 'clause.environment', 'passed': closed}],",
      "  'positiveCaseResults': [{'caseId': 'case.environment', 'passed': closed}],",
      "  'negativeControlResults': [{'controlId': 'control.environment', 'passed': closed}],",
      "}",
      "with open('verify-report.json', 'w', encoding='utf-8') as handle: json.dump(report, handle)",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "gen_report.py"]);

    const run = runAdapter(
      adapterArgs("PROOF-W3T2-CLOSED-ENV", target),
      {
        CCC_PYTHON_PROOF_FORCE_UNITTEST: "1",
        UNTRUSTED_PARENT_VALUE: "must-not-cross",
      },
    );

    expect(run.status).toBe(0);
  });

  it("treats skipped target tests as failed evidence, never as absent evidence", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_skipped_target.py"), [
      "import unittest",
      "class Target(unittest.TestCase):",
      "    def test_clause_required(self): self.assertTrue(True)",
      "    def test_case_positive(self): self.assertTrue(True)",
      "    @unittest.skip('planted skip')",
      "    def test_case_skipped(self): self.assertTrue(True)",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "run_target.py"]);

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-SKIP", target)), "target_failed");
  });

  it("treats unittest expected failures as failed evidence", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_expected_failure.py"), [
      "import unittest",
      "class Target(unittest.TestCase):",
      "    def test_clause_required(self): self.assertTrue(True)",
      "    @unittest.expectedFailure",
      "    def test_case_expected_failure(self): self.assertTrue(False)",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "run_target.py", "--runner", "unittest"]);

    expectRefusal(
      runAdapter(adapterArgs("PROOF-W3T2-EXPECTED-FAILURE", target)),
      "target_failed",
    );
  });

  it("makes explicit unittest mode fail closed on pytest-only tests", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_mixed_target.py"), [
      "import unittest",
      "class UnitTarget(unittest.TestCase):",
      "    def test_clause_required(self): self.assertTrue(True)",
      "    def test_case_unit(self): self.assertTrue(True)",
      "    def test_negctrl_closed(self): self.assertTrue(True)",
      "def test_case_pytest_only(): assert False",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "run_target.py", "--runner", "unittest"]);

    execFileSync(python3, ["run_target.py", "--runner", "unittest"], {
      cwd: target,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf8" },
    });
    const report = JSON.parse(readFileSync(join(target, "verify-report.json"), "utf8")) as {
      _runner: string;
      positiveCaseResults: Array<{ caseId: string; passed: boolean }>;
    };

    expect(report._runner).toBe("unittest");
    expect(report.positiveCaseResults).toContainEqual({ caseId: "case.pytest_only", passed: false });
    rmSync(join(target, "verify-report.json"));
    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-MIXED", target)), "target_failed");
  });

  it("makes explicit unittest mode fail closed on nested pytest-only tests", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_unit_target.py"), [
      "import unittest",
      "class UnitTarget(unittest.TestCase):",
      "    def test_clause_required(self): self.assertTrue(True)",
      "    def test_case_unit(self): self.assertTrue(True)",
      "    def test_negctrl_closed(self): self.assertTrue(True)",
      "",
    ].join("\n"));
    const nested = join(target, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "test_pytest_only.py"), "def test_case_nested_pytest_only(): assert False\n");
    writeManifest(target, [python3, "run_target.py", "--runner", "unittest"]);

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-MIXED-NESTED", target)), "target_failed");
  });

  it("treats pytest collection-level skips as failed evidence", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_passing_target.py"), [
      "def test_clause_required(): assert True",
      "def test_case_positive(): assert True",
      "",
    ].join("\n"));
    writeFileSync(join(target, "test_skipped_module.py"), [
      "import pytest",
      "pytest.skip('planted module skip', allow_module_level=True)",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "run_target.py"]);

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-COLLECTION-SKIP", target)), "target_failed");
  });

  it("treats pytest unexpected successes as failed evidence", () => {
    const target = tempTarget();
    writeFileSync(join(target, "run_target.py"), readFileSync(join(fixturesDir, "run_target.py"), "utf8"));
    writeFileSync(join(target, "test_unexpected_success.py"), [
      "import pytest",
      "def test_clause_required(): assert True",
      "@pytest.mark.xfail(reason='planted xpass')",
      "def test_case_unexpected_success(): assert True",
      "",
    ].join("\n"));
    writeManifest(target, [python3, "run_target.py"]);

    expectRefusal(runAdapter(adapterArgs("PROOF-W3T2-PYTEST-XPASS", target)), "target_failed");
  });
});
