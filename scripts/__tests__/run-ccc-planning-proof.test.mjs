/*
FNXC:CccPlanningProof 2026-10-14-08:20:
Behavioural proof for the closed-inventory planning proof runner (request-to-code v3 card P0; CONTRACT-v2 section 2.20, D25, D50, D51). Every refusal case has a positive control that differs by the one offending field, so a runner that refuses everything cannot pass.

The runner is exercised through its injected dependencies (platform, sandbox readiness, supervised execution, Git snapshots, inventory), so no case here starts PostgreSQL, vitest, or a network connection. The two real-process cases are a small `node --test` fixture for the node:test result reporter, and real temporary Git repositories for the foreign-Git-mutation guard.
*/
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideDarwinProofLaneOutcome } from "../ci-darwin-proof-lane.mjs";
import {
  CCC_PLANNING_PACKAGE_DIRS,
  assertClosedNamedResults,
  assertCccPlanningSuiteSkipPolicy,
  assertFileClosedResults,
  assertMachineResultInventory,
  assertMachineResultJson,
} from "../lib/ccc-closed-vitest-results.mjs";
import {
  CCC_PLANNING_OFFLINE_COMMANDS,
  CCC_PLANNING_TARGETED_COMMANDS,
  cccPlanningInventorySha256,
  loadCccPlanningInventory,
} from "../lib/ccc-planning-proof-inventory/index.mjs";
import {
  buildCccPlanningCommandArgv,
  parseCccPlanningProofArgs,
  runCccPlanningProof,
  runSupervisedProofCommands,
} from "../run-ccc-planning-proof.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const realRepoRoot = path.resolve(here, "..", "..");
const guardPath = path.join(realRepoRoot, "scripts", "lib", "ccc-planning-offline-network-guard.mjs");
const reporterPath = path.join(realRepoRoot, "scripts", "lib", "ccc-closed-vitest-results.mjs");

const CODE = {
  RESULTS: "CCC_PLANNING_PROOF_RESULTS_NOT_CLOSED",
  INVENTORY: "CCC_PLANNING_PROOF_INVENTORY_INVALID",
  PG_SKIP: "CCC_PLANNING_PROOF_PG_SKIP_REFUSED",
  PLATFORM: "CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED",
  SANDBOX: "CCC_PLANNING_OFFLINE_SANDBOX_UNAVAILABLE",
  SUPERVISOR: "CCC_PLANNING_PROOF_SUPERVISOR_FAILED",
  FOREIGN_GIT: "CCC_PLANNING_PROOF_FOREIGN_GIT_MUTATION",
  NETWORK: "CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT",
  USAGE: "CCC_PLANNING_PROOF_USAGE",
};

let workDir;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "ccc-planning-proof-test-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let uniqueCounter = 0;
function uniqueDir(label) {
  uniqueCounter += 1;
  const dir = path.join(workDir, `${label}-${uniqueCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function codeOf(expected) {
  return (error) => {
    assert.equal(error?.code, expected, `expected ${expected}, got ${error?.code}: ${error?.message}`);
    return true;
  };
}

function makeCommand(overrides = {}) {
  return {
    id: "fixture-engine",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: ["src/__tests__/a.test.ts"],
    closure: "names",
    expectedNames: ["suite > a", "suite > b"],
    platform: "any",
    needsPostgres: false,
    timeoutMs: 60_000,
    ...overrides,
  };
}

function splitName(name) {
  const parts = name.split(" > ");
  return { ancestorTitles: parts.slice(0, -1), title: parts[parts.length - 1] };
}

/** A vitest JSON report whose counters are derived from the statuses, the way vitest derives them. */
function vitestReport(packageRoot, fileAssertions) {
  const testResults = Object.entries(fileAssertions).map(([relative, assertions]) => ({
    name: path.join(packageRoot, relative),
    status: assertions.every((a) => a.status === "passed") ? "passed" : "failed",
    assertionResults: assertions,
  }));
  const all = testResults.flatMap((result) => result.assertionResults);
  const count = (...statuses) => all.filter((a) => statuses.includes(a.status)).length;
  return {
    numTotalTests: all.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("pending", "skipped"),
    numTodoTests: count("todo"),
    testResults,
  };
}

function assertionsFor(names, status = "passed") {
  return names.map((name) => ({ ...splitName(name), status }));
}

const DEFAULT_TEST_FILE = `import { describe, it } from "vitest";\ndescribe("suite", () => { it("a", () => {}); it("b", () => {}); });\n`;

function makeFixtureRepo(extraFiles = {}) {
  const root = uniqueDir("repo");
  const files = {
    "package.json": "{\"name\":\"fixture\"}\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/engine/src/__tests__/a.test.ts": DEFAULT_TEST_FILE,
    "packages/core/src/__tests__/pg.test.ts": DEFAULT_TEST_FILE,
    "scripts/__tests__/n.test.mjs": `import { describe, it } from "node:test";\ndescribe("suite", () => { it("a", () => {}); it("b", () => {}); });\n`,
    ...extraFiles,
  };
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return root;
}

function makeGitRepo() {
  const root = makeFixtureRepo();
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=ccc-planning-test", "-c", "user.email=ccc-planning-test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  return { root, git };
}

/** A runSupervised double. It writes a closed all-passed report per command unless told otherwise. */
function makeSupervisor(repoRoot, behaviour = {}) {
  const calls = [];
  const fn = async (commands, options) => {
    calls.push({ commands, options });
    if (behaviour.before) await behaviour.before(commands, options);
    const results = [];
    mkdirSync(options.resultRoot, { recursive: true });
    for (const command of commands) {
      const packageRoot = path.join(repoRoot, CCC_PLANNING_PACKAGE_DIRS[command.packageFilter]);
      const names = command.closure === "names" ? command.expectedNames : ["suite > only"];
      let assertions = assertionsFor(names);
      if (behaviour.transform) assertions = behaviour.transform(assertions, command) ?? assertions;
      const report = vitestReport(packageRoot, { [command.files[0]]: assertions, ...Object.fromEntries(command.files.slice(1).map((file) => [file, assertionsFor(["suite > extra"])])) });
      const outputFile = path.join(options.resultRoot, `${command.id}.json`);
      if (!behaviour.skipWritingResults) writeFileSync(outputFile, JSON.stringify(behaviour.reportOverride ? behaviour.reportOverride(report, command) : report));
      results.push({ id: command.id, code: 0, signal: null, timedOut: false, outputFile, ...(behaviour.row?.(command) ?? {}) });
    }
    const rows = behaviour.rows ? behaviour.rows(results) : results;
    return { results: rows, stopError: behaviour.stopError ?? null };
  };
  fn.calls = calls;
  return fn;
}

/** The first runSupervised call, asserted to exist so a runner that never spawned fails on an assertion. */
function firstCall(outcome) {
  assert.ok(outcome.runSupervised.calls.length >= 1, "runSupervised was never called");
  return outcome.runSupervised.calls[0];
}

const FIXED_SNAPSHOT = Object.freeze({
  head: "1".repeat(40),
  tree: "2".repeat(40),
  trackedDirtyPaths: 0,
  statusPorcelain: "",
  worktrees: "worktree /repo\nbranch refs/heads/agent/x\n",
});

async function run({ mode = "targeted", platform = "darwin", env = {}, targeted = [makeCommand()], offline = [], readiness, supervisor, root, extra = {} } = {}) {
  const repoRoot = root ?? makeFixtureRepo();
  const runSupervised = supervisor ?? makeSupervisor(repoRoot);
  const readinessCalls = [];
  const outcome = await runCccPlanningProof({
    mode,
    repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    platform,
    inspectSandboxReadiness:
      readiness ??
      (async () => {
        readinessCalls.push(1);
        return { ready: true, detail: "ready" };
      }),
    runSupervised,
    loadInventory: async () => ({ targeted, offline, sha256: "a".repeat(64) }),
    scratchParent: workDir,
    gitSnapshot: async () => FIXED_SNAPSHOT,
    log: () => {},
    ...extra,
  });
  return { ...outcome, repoRoot, runSupervised, readinessCalls };
}

describe("closed named results", () => {
  const expected = ["suite > required", "suite > nested > other"];
  const good = assertionsFor(expected);

  it("accepts a report that holds exactly the expected names, all passed", () => {
    assertClosedNamedResults(expected, good, "control");
  });

  it("refuses one skipped name, and also pending, todo, failed, missing, extra and duplicate names", () => {
    for (const [label, assertions] of [
      ["skipped", [{ ...good[0], status: "skipped" }, good[1]]],
      ["pending", [{ ...good[0], status: "pending" }, good[1]]],
      ["todo", [{ ...good[0], status: "todo" }, good[1]]],
      ["failed", [{ ...good[0], status: "failed" }, good[1]]],
      ["missing", [good[0]]],
      ["extra", [...good, { ancestorTitles: ["suite"], title: "unlisted", status: "passed" }]],
      ["duplicate", [...good, good[0]]],
    ]) {
      assert.throws(() => assertClosedNamedResults(expected, assertions, label), codeOf(CODE.RESULTS), label);
    }
  });

  it("joins ancestor titles and the title with a greater-than sign, never with spaces", () => {
    assertClosedNamedResults(["a > b > c"], [{ ancestorTitles: ["a", "b"], title: "c", status: "passed" }], "join");
    assert.throws(
      () => assertClosedNamedResults(["a b c"], [{ ancestorTitles: ["a", "b"], title: "c", status: "passed" }], "space-join"),
      codeOf(CODE.RESULTS),
    );
  });

  it("refuses an expected-name list that itself holds a duplicate", () => {
    assert.throws(() => assertClosedNamedResults(["x", "x"], assertionsFor(["x"]), "dup-list"), codeOf(CODE.RESULTS));
  });
});

describe("machine result json", () => {
  const packageRoot = path.join("/virtual", "packages", "engine");
  const command = makeCommand();

  it("passes a closed all-passed report and returns its counts", () => {
    const report = vitestReport(packageRoot, { "src/__tests__/a.test.ts": assertionsFor(command.expectedNames) });
    assert.deepEqual(assertMachineResultJson(report, command, { packageRoot }), { passed: 2, skipped: 0, failed: 0, files: 1 });
  });

  it("refuses a counter that disagrees with the assertions, an empty report and a stray unlisted file", () => {
    const report = vitestReport(packageRoot, { "src/__tests__/a.test.ts": assertionsFor(command.expectedNames) });
    assert.throws(() => assertMachineResultJson({ ...report, numPassedTests: 3 }, command, { packageRoot }), codeOf(CODE.RESULTS));
    assert.throws(
      () => assertMachineResultJson({ ...report, numPassedTests: 0, numTotalTests: 0, testResults: [{ name: report.testResults[0].name, assertionResults: [] }] }, command, { packageRoot }),
      codeOf(CODE.RESULTS),
    );
    const stray = vitestReport(packageRoot, {
      "src/__tests__/a.test.ts": assertionsFor(command.expectedNames),
      "src/__tests__/unlisted.test.ts": assertionsFor(["other > t"]),
    });
    assert.throws(() => assertMachineResultJson(stray, command, { packageRoot }), codeOf(CODE.RESULTS));
  });

  it("refuses a skipped test even when the counter says pending is zero", () => {
    const report = vitestReport(packageRoot, { "src/__tests__/a.test.ts": [...assertionsFor(["suite > a"]), { ...splitName("suite > b"), status: "skipped" }] });
    assert.throws(() => assertMachineResultJson({ ...report, numPendingTests: 0 }, command, { packageRoot }), codeOf(CODE.RESULTS));
  });
});

describe("file-closed results", () => {
  const packageRoot = path.join("/virtual", "packages", "engine");
  const command = makeCommand({ closure: "files", expectedNames: [], files: ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"] });
  const passedBoth = () => ({
    "src/__tests__/a.test.ts": assertionsFor(["s > one", "s > two"]),
    "src/__tests__/b.test.ts": assertionsFor(["s > three"]),
  });

  it("accepts a report where every listed file ran at least one test and nothing else ran", () => {
    assert.deepEqual(assertFileClosedResults(command, vitestReport(packageRoot, passedBoth()), { packageRoot }), { files: 2, executed: 3 });
  });

  it("refuses a listed file that executed zero tests", () => {
    const files = passedBoth();
    files["src/__tests__/b.test.ts"] = [];
    assert.throws(() => assertFileClosedResults(command, vitestReport(packageRoot, files), { packageRoot }), codeOf(CODE.RESULTS));
  });

  it("refuses a listed file with one skipped test, one failed test, or one todo", () => {
    for (const status of ["skipped", "pending", "failed", "todo"]) {
      const files = passedBoth();
      files["src/__tests__/b.test.ts"] = [...files["src/__tests__/b.test.ts"], { ...splitName("s > extra"), status }];
      assert.throws(() => assertFileClosedResults(command, vitestReport(packageRoot, files), { packageRoot }), codeOf(CODE.RESULTS), status);
    }
  });

  it("refuses an unlisted file in the report and a listed file missing from it", () => {
    const withStray = { ...passedBoth(), "src/__tests__/c.test.ts": assertionsFor(["s > c"]) };
    assert.throws(() => assertFileClosedResults(command, vitestReport(packageRoot, withStray), { packageRoot }), codeOf(CODE.RESULTS));
    const missing = passedBoth();
    delete missing["src/__tests__/b.test.ts"];
    assert.throws(() => assertFileClosedResults(command, vitestReport(packageRoot, missing), { packageRoot }), codeOf(CODE.RESULTS));
  });

  it("refuses a report whose counters lie about the assertions", () => {
    const report = vitestReport(packageRoot, passedBoth());
    assert.throws(() => assertFileClosedResults(command, { ...report, numPassedTests: 99 }, { packageRoot }), codeOf(CODE.RESULTS));
  });
});

describe("command inventory shape", () => {
  it("accepts every package and project pairing the contract admits", () => {
    for (const command of [
      makeCommand(),
      makeCommand({ id: "slow", project: "engine-slow" }),
      makeCommand({ id: "core", packageFilter: "@fusion/core", project: null }),
      makeCommand({ id: "core-pg", packageFilter: "@fusion/core", project: null, config: "vitest.pg.config.ts", needsPostgres: true }),
      makeCommand({ id: "cli", packageFilter: "@runfusion/fusion", project: null }),
      makeCommand({ id: "dash", packageFilter: "@fusion/dashboard", project: "dashboard-api-quality-backfill" }),
      makeCommand({ id: "node", packageFilter: "node-test", project: null, files: ["scripts/__tests__/n.test.mjs"] }),
      makeCommand({ id: "files-mode", closure: "files", expectedNames: [] }),
      makeCommand({ id: "darwin-entry", platform: "darwin" }),
    ]) {
      assertMachineResultInventory(command);
    }
  });

  it("refuses every malformed field, each against the valid control above", () => {
    const refusals = {
      "uppercase id": { id: "Bad_Id" },
      "empty id": { id: "" },
      "unknown package": { packageFilter: "@fusion/other" },
      "engine without a pinned project": { project: null },
      "core with an engine project": { packageFilter: "@fusion/core" },
      "dashboard with an engine project": { packageFilter: "@fusion/dashboard" },
      "unknown project": { project: "engine-core" },
      "absolute file": { files: ["/etc/passwd"] },
      "parent-directory file": { files: ["../x.test.ts"] },
      "flag-shaped file": { files: ["--run-everything"] },
      "empty files": { files: [] },
      "duplicate files": { files: ["src/__tests__/a.test.ts", "src/__tests__/a.test.ts"] },
      "names closure with no names": { expectedNames: [] },
      "names closure with duplicate names": { expectedNames: ["a > b", "a > b"] },
      "files closure that lists names": { closure: "files", expectedNames: ["a > b"] },
      "unknown closure": { closure: "all" },
      "config with a path": { config: "../vitest.pg.config.ts" },
      "config shaped like a flag": { config: "--root" },
      "platform typo": { platform: "linux" },
      "needsPostgres as a string": { needsPostgres: "false" },
      "needsPg spelling": { needsPostgres: undefined, needsPg: false },
      "zero timeout": { timeoutMs: 0 },
      "fractional timeout": { timeoutMs: 1.5 },
      "unknown extra key": { retries: 3 },
    };
    for (const [label, overrides] of Object.entries(refusals)) {
      assert.throws(() => assertMachineResultInventory(makeCommand(overrides)), codeOf(CODE.INVENTORY), label);
    }
  });
});

describe("static skip policy", () => {
  const plain = { file: "src/__tests__/x.test.ts", platform: "any", needsPostgres: false };
  const darwin = { ...plain, platform: "darwin" };
  const policy = (text, input = plain) => assertCccPlanningSuiteSkipPolicy(text, input);

  it("accepts ordinary tests", () => {
    policy(`import { describe, it, expect } from "vitest";\ndescribe("s", () => { it("a", () => { expect(1).toBe(1); }); });\n`);
  });

  it("refuses it.skip, describe.skip, test.skip, todo, x-prefixed tests and a dynamic skip in a body", () => {
    for (const text of [
      `it.skip("a", () => {});`,
      `describe.skip("a", () => {});`,
      `test.skip("a", () => {});`,
      `it.todo("a");`,
      `xit("a", () => {});`,
      `xdescribe("a", () => {});`,
      `it("a", (ctx) => { ctx.skip(); });`,
      `it.concurrent.skip("a", () => {});`,
    ]) {
      assert.throws(() => policy(text), codeOf(CODE.INVENTORY), text);
    }
  });

  it("refuses an inverse platform skipIf, an arbitrary skipIf and any runIf", () => {
    for (const text of [
      `it.skipIf(process.platform === "darwin")("a", () => {});`,
      `describe.skipIf(!process.env.FLAG)("a", () => {});`,
      `it.runIf(process.platform === "darwin")("a", () => {});`,
    ]) {
      assert.throws(() => policy(text, darwin), codeOf(CODE.INVENTORY), text);
    }
  });

  it("allows the Darwin skipIf form only in a file tagged darwin", () => {
    const text = `describe.skipIf(process.platform !== "darwin")("confined", () => { it("a", () => {}); });`;
    policy(text, darwin);
    policy(text.replace(/"darwin"/, "'darwin'").replace("!== ", "!==  "), darwin);
    assert.throws(() => policy(text, plain), codeOf(CODE.INVENTORY));
  });

  it("refuses pgDescribe in a file that is not tagged needsPostgres and allows it in one that is", () => {
    const text = `import { pgDescribe } from "../harness";\npgDescribe("store", () => { it("a", () => {}); });`;
    assert.throws(() => policy(text, plain), codeOf(CODE.INVENTORY));
    policy(text, { ...plain, needsPostgres: true });
  });

  it("ignores skip-shaped text inside comments, strings, template literals and regular expressions", () => {
    policy(
      [
        `// never write it.skip("a") in this suite`,
        `/* describe.skip("b") and pgDescribe("c") */`,
        `const text = 'describe.skipIf(process.platform === "darwin")';`,
        'const template = `it.todo("x") ${1 + 1} pgDescribe`;',
        `const pattern = /it\\.skip\\(|pgDescribe/;`,
        `expect(content).toContain("describe.skipIf(!SHOULD_RUN)");`,
      ].join("\n"),
    );
  });

  it("still sees a real skip that follows a regular expression holding a quote character", () => {
    assert.throws(() => policy(`const quotes = /["']/;\nit.skip("a", () => {});`), codeOf(CODE.INVENTORY));
    assert.throws(() => policy("const t = `${(() => \"x\")()}`;\nit.skip(\"a\", () => {});"), codeOf(CODE.INVENTORY));
  });

  it("fails closed on text it cannot read to the end", () => {
    for (const text of [`const open = "never closed;\nit("a", () => {});`, "const open = `never closed", `/* never closed`]) {
      assert.throws(() => policy(text), codeOf(CODE.INVENTORY), text);
    }
  });
});

describe("planning proof inventory", () => {
  function writeCards(cards) {
    const dir = uniqueDir("cards");
    for (const [file, text] of Object.entries(cards)) writeFileSync(path.join(dir, file), text);
    return dir;
  }
  const commandSource = (id, name = "suite > a") =>
    `Object.freeze({ id: ${JSON.stringify(id)}, packageFilter: "@fusion/engine", project: "engine-default", config: null, files: ["src/__tests__/a.test.ts"], closure: "names", expectedNames: [${JSON.stringify(name)}], platform: "any", needsPostgres: false, timeoutMs: 60000 })`;
  const cardSource = (targetedIds, offlineIds = [], name) =>
    `export const TARGETED = [${targetedIds.map((id) => commandSource(id, name)).join(",")}];\nexport const OFFLINE = [${offlineIds.map((id) => commandSource(id, name)).join(",")}];\n`;

  it("loads the shipped b2, b4, c6b and p0 modules as they are, in sorted filename order", async () => {
    const inventory = await loadCccPlanningInventory();
    for (const card of ["b2.mjs", "b4.mjs", "c6b.mjs", "p0.mjs"]) assert.ok(inventory.cards.includes(card), card);
    assert.deepEqual(inventory.cards, [...inventory.cards].sort());
    const ids = [...inventory.targeted, ...inventory.offline].map((command) => command.id);
    for (const id of ["b2-graph-admission", "b2-graph-admission-names", "b4-packet-writer", "b4-intake-regression", "c6b-custom-provider-model-sync"]) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(CCC_PLANNING_TARGETED_COMMANDS, inventory.targeted);
    assert.deepEqual(CCC_PLANNING_OFFLINE_COMMANDS, inventory.offline);
    for (const command of [...inventory.targeted, ...inventory.offline]) assertMachineResultInventory(command);
  });

  it("documents which closure applies where: c6b is name-closed in targeted, b2 is file-closed in targeted and name-closed in offline", async () => {
    const inventory = await loadCccPlanningInventory();
    const byId = new Map([...inventory.targeted, ...inventory.offline].map((command) => [command.id, command]));
    assert.equal(byId.get("c6b-custom-provider-model-sync").closure, "names");
    assert.equal(byId.get("b2-graph-admission").closure, "files");
    assert.equal(byId.get("b2-graph-admission-names").closure, "names");
    assert.ok(inventory.offline.every((command) => command.closure === "names"));
  });

  it("gives a stable 64-hex digest that changes when one expected-name byte changes", async () => {
    const a = await loadCccPlanningInventory({ cardsDir: writeCards({ "one.mjs": cardSource(["one"]) }) });
    const again = await loadCccPlanningInventory({ cardsDir: writeCards({ "one.mjs": cardSource(["one"]) }) });
    const changed = await loadCccPlanningInventory({ cardsDir: writeCards({ "one.mjs": cardSource(["one"], [], "suite > b") }) });
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.sha256, again.sha256);
    assert.notEqual(a.sha256, changed.sha256);
    assert.match(cccPlanningInventorySha256(), /^[0-9a-f]{64}$/);
  });

  it("rejects two card modules that declare the same command id, and accepts them once the id differs", async () => {
    await assert.rejects(
      loadCccPlanningInventory({ cardsDir: writeCards({ "a.mjs": cardSource(["same"]), "b.mjs": cardSource([], ["same"]) }) }),
      codeOf(CODE.INVENTORY),
    );
    const ok = await loadCccPlanningInventory({ cardsDir: writeCards({ "a.mjs": cardSource(["first"]), "b.mjs": cardSource([], ["second"]) }) });
    assert.equal(ok.targeted.length + ok.offline.length, 2);
  });

  it("rejects a card without the two exports, a non-array export, a malformed command and a files-closed offline entry", async () => {
    const filesClosedOffline = `export const TARGETED = [];\nexport const OFFLINE = [Object.freeze({ id: "f", packageFilter: "@fusion/engine", project: "engine-default", config: null, files: ["src/__tests__/a.test.ts"], closure: "files", expectedNames: [], platform: "any", needsPostgres: false, timeoutMs: 1000 })];\n`;
    for (const [label, cards] of Object.entries({
      "missing OFFLINE": { "x.mjs": `export const TARGETED = [];\n` },
      "non-array TARGETED": { "x.mjs": `export const TARGETED = {};\nexport const OFFLINE = [];\n` },
      "malformed command": { "x.mjs": `export const TARGETED = [{ id: "x" }];\nexport const OFFLINE = [];\n` },
      "files-closed offline entry": { "x.mjs": filesClosedOffline },
    })) {
      await assert.rejects(loadCccPlanningInventory({ cardsDir: writeCards(cards) }), codeOf(CODE.INVENTORY), label);
    }
    await loadCccPlanningInventory({ cardsDir: writeCards({ "x.mjs": `export const TARGETED = [];\nexport const OFFLINE = [];\n` }) });
  });

  it("passes the static skip policy over every real file the shipped inventory lists", async () => {
    const inventory = await loadCccPlanningInventory();
    let checked = 0;
    for (const command of [...inventory.targeted, ...inventory.offline]) {
      for (const file of command.files) {
        const absolute = path.join(realRepoRoot, CCC_PLANNING_PACKAGE_DIRS[command.packageFilter], file);
        assert.ok(existsSync(absolute), `${command.id}: missing listed file ${file}`);
        assertCccPlanningSuiteSkipPolicy(readFileSync(absolute, "utf8"), { file, platform: command.platform, needsPostgres: command.needsPostgres });
        checked += 1;
      }
    }
    assert.ok(checked >= 6, `expected to check the shipped files, checked ${checked}`);
  });
});

describe("argument parsing", () => {
  it("accepts a mode as two arguments or one, with or without a leading --", () => {
    assert.deepEqual(parseCccPlanningProofArgs(["--mode", "targeted"]), { mode: "targeted" });
    assert.deepEqual(parseCccPlanningProofArgs(["--mode=offline"]), { mode: "offline" });
    assert.deepEqual(parseCccPlanningProofArgs(["--", "--mode", "ci-linux"]), { mode: "ci-linux" });
  });

  it("returns a usage error for a missing, unknown, repeated or extra argument", () => {
    for (const argv of [[], ["--mode"], ["--mode", "bogus"], ["--mode", "targeted", "--extra"], ["--mode", "targeted", "--mode", "offline"], ["targeted"], ["--mode=", "x"], ["--", "--"]]) {
      const parsed = parseCccPlanningProofArgs(argv);
      assert.equal(typeof parsed.usageError, "string", JSON.stringify(argv));
      assert.equal(parsed.mode, undefined);
    }
  });

  it("exits 2 with the usage code when asked to run an unknown mode", async () => {
    const outcome = await run({ mode: "everything" });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.report.refusal?.code, CODE.USAGE);
    assert.equal(outcome.runSupervised.calls.length, 0);
  });
});

describe("refusals before anything is spawned", () => {
  it("refuses FUSION_PG_TEST_SKIP=1 and never calls runSupervised; without it the same run calls it once", async () => {
    const refused = await run({ env: { FUSION_PG_TEST_SKIP: "1" } });
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.report.passed, false);
    assert.equal(refused.report.refusal?.code, CODE.PG_SKIP);
    assert.equal(refused.runSupervised.calls.length, 0);
    const control = await run({ env: {} });
    assert.equal(control.exitCode, 0);
    assert.equal(control.runSupervised.calls.length, 1);
  });

  it("refuses FUSION_PG_TEST_SKIP=1 in every mode, because a skipped PostgreSQL test is a failed proof", async () => {
    for (const mode of ["targeted", "offline", "ci-linux"]) {
      const outcome = await run({ mode, env: { FUSION_PG_TEST_SKIP: "1" }, offline: [makeCommand({ id: "o" })] });
      assert.equal(outcome.report.refusal?.code, CODE.PG_SKIP, mode);
      assert.equal(outcome.runSupervised.calls.length, 0, mode);
    }
  });

  it("refuses offline mode on an injected linux platform before probing the sandbox or spawning; darwin with a ready sandbox runs once", async () => {
    const offline = [makeCommand({ id: "off" })];
    const linux = await run({ mode: "offline", platform: "linux", offline });
    assert.equal(linux.exitCode, 1);
    assert.equal(linux.report.refusal?.code, CODE.PLATFORM);
    assert.equal(linux.runSupervised.calls.length, 0);
    assert.equal(linux.readinessCalls.length, 0);
    const darwin = await run({ mode: "offline", platform: "darwin", offline });
    assert.equal(darwin.exitCode, 0);
    assert.equal(darwin.runSupervised.calls.length, 1);
    assert.equal(darwin.readinessCalls.length, 1);
  });

  it("refuses offline mode on darwin when the sandbox is not ready", async () => {
    const outcome = await run({ mode: "offline", offline: [makeCommand({ id: "off" })], readiness: async () => ({ ready: false, detail: "sandbox-exec missing" }) });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.SANDBOX);
    assert.match(outcome.report.refusal?.detail, /sandbox-exec missing/);
    assert.equal(outcome.runSupervised.calls.length, 0);
  });

  it("refuses targeted mode on a non-darwin host only when a selected entry is darwin-only", async () => {
    const withDarwin = await run({ platform: "linux", targeted: [makeCommand(), makeCommand({ id: "confined", platform: "darwin" })] });
    assert.equal(withDarwin.report.refusal?.code, CODE.PLATFORM);
    assert.equal(withDarwin.runSupervised.calls.length, 0);
    const anyOnly = await run({ platform: "linux", targeted: [makeCommand()] });
    assert.equal(anyOnly.exitCode, 0);
    assert.equal(anyOnly.runSupervised.calls.length, 1);
  });

  it("selects only platform-any, PostgreSQL-free entries in ci-linux and runs on a linux host without the sandbox probe", async () => {
    const outcome = await run({
      mode: "ci-linux",
      platform: "linux",
      targeted: [makeCommand({ id: "keep-targeted" }), makeCommand({ id: "darwin-only", platform: "darwin" }), makeCommand({ id: "needs-pg", packageFilter: "@fusion/core", project: null, needsPostgres: true, files: ["src/__tests__/pg.test.ts"] })],
      offline: [makeCommand({ id: "keep-offline" })],
    });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(firstCall(outcome).commands.map((command) => command.id), ["keep-targeted", "keep-offline"]);
    assert.equal(firstCall(outcome).options.needsPostgres, false);
    assert.equal(outcome.readinessCalls.length, 0);
  });

  it("fails ci-linux on an empty selection, and the same for an empty targeted or offline list", async () => {
    const onlyExcluded = await run({ mode: "ci-linux", platform: "linux", targeted: [makeCommand({ platform: "darwin" })] });
    assert.equal(onlyExcluded.exitCode, 1);
    assert.equal(onlyExcluded.report.refusal?.code, CODE.INVENTORY);
    assert.equal(onlyExcluded.runSupervised.calls.length, 0);
    assert.equal((await run({ targeted: [] })).report.refusal?.code, CODE.INVENTORY);
    assert.equal((await run({ mode: "offline", offline: [] })).report.refusal?.code, CODE.INVENTORY);
  });

  it("refuses an inventory that does not load, a listed file that does not exist, and a listed file that breaks the skip policy", async () => {
    const failedLoad = await run({ extra: { loadInventory: async () => { throw Object.assign(new Error("duplicate id x"), { code: CODE.INVENTORY }); } } });
    assert.equal(failedLoad.report.refusal?.code, CODE.INVENTORY);
    assert.match(failedLoad.report.refusal?.detail, /duplicate id x/);
    assert.equal(failedLoad.runSupervised.calls.length, 0);

    const missing = await run({ targeted: [makeCommand({ files: ["src/__tests__/not-there.test.ts"] })] });
    assert.equal(missing.report.refusal?.code, CODE.INVENTORY);
    assert.equal(missing.runSupervised.calls.length, 0);

    const skipRoot = makeFixtureRepo({ "packages/engine/src/__tests__/a.test.ts": `describe.skip("suite", () => { it("a", () => {}); });\n` });
    const skipped = await run({ root: skipRoot });
    assert.equal(skipped.report.refusal?.code, CODE.INVENTORY);
    assert.match(skipped.report.refusal?.detail, /a\.test\.ts/);
    assert.equal(skipped.runSupervised.calls.length, 0);
    assert.equal((await run({ root: makeFixtureRepo() })).exitCode, 0);
  });
});

describe("environment handed to the supervised children", () => {
  it("sets PI_OFFLINE=1 and preloads the network guard with --import, keeping any NODE_OPTIONS the caller had", async () => {
    const outcome = await run({ env: { NODE_OPTIONS: "--max-old-space-size=1234" } });
    const { env } = firstCall(outcome).options;
    assert.equal(env.PI_OFFLINE, "1");
    const expectedImport = /\s/.test(guardPath) ? `--import "${guardPath}"` : `--import ${guardPath}`;
    assert.ok(env.NODE_OPTIONS.includes(expectedImport), env.NODE_OPTIONS);
    assert.ok(env.NODE_OPTIONS.includes("--max-old-space-size=1234"), env.NODE_OPTIONS);
    assert.ok(path.isAbsolute(env.CCC_PLANNING_OFFLINE_GUARD_REPORT));
  });

  it("quotes a guard path that holds a space so NODE_OPTIONS still parses", async () => {
    const outcome = await run({ extra: { guardPath: "/tmp/with space/guard.mjs" } });
    assert.ok(firstCall(outcome).options.env.NODE_OPTIONS.includes(`--import "/tmp/with space/guard.mjs"`));
  });

  it("points scratch, TMPDIR and the proof environment at the owned scratch root", async () => {
    const outcome = await run();
    const { env, scratchRoot } = firstCall(outcome).options;
    assert.equal(env.CCC_PLANNING_PROOF_SCRATCH, scratchRoot);
    assert.equal(env.TMPDIR, scratchRoot);
    assert.ok(scratchRoot.startsWith(workDir));
  });

  it("drops every caller PostgreSQL setting, so no address of the shared host server survives into the children", async () => {
    const outcome = await run({
      env: {
        FUSION_PG_TEST_URL_BASE: "postgresql://postgres@localhost:5432",
        CCC_PG_URL_BASE: "postgresql://postgres@localhost:5432",
        FUSION_PG_TEST_AVAILABLE: "1",
        PGHOST: "localhost",
        PGPORT: "5432",
        PGPASSWORD: "x",
        DATABASE_URL: "postgresql://localhost:5432/x",
        POSTGRES_URL: "postgresql://localhost:5432/y",
        UNRELATED_SETTING: "kept",
      },
    });
    const { env, supervisorEnv } = firstCall(outcome).options;
    for (const key of ["FUSION_PG_TEST_URL_BASE", "CCC_PG_URL_BASE", "FUSION_PG_TEST_AVAILABLE", "PGHOST", "PGPORT", "PGPASSWORD", "DATABASE_URL", "POSTGRES_URL"]) {
      assert.equal(env[key], undefined, key);
      assert.equal(supervisorEnv[key], undefined, `supervisor ${key}`);
    }
    assert.equal(env.UNRELATED_SETTING, "kept");
    assert.ok(!Object.values(env).some((value) => value.includes(":5432")), "no value may still name the shared server port");
  });

  it("keeps the offline guard out of the supervisor's own environment while the children get it", async () => {
    const outcome = await run({ env: { NODE_OPTIONS: "--max-old-space-size=1234" } });
    const { env, supervisorEnv } = firstCall(outcome).options;
    assert.ok(env.NODE_OPTIONS.includes("ccc-planning-offline-network-guard"));
    assert.equal(supervisorEnv.NODE_OPTIONS, "--max-old-space-size=1234");
    assert.equal(supervisorEnv.CCC_PLANNING_OFFLINE_GUARD_REPORT, undefined);
  });

  it("asks the supervisor to own PostgreSQL only when a selected command needs it", async () => {
    const pgCommand = makeCommand({ id: "pg-cmd", packageFilter: "@fusion/core", project: null, needsPostgres: true, files: ["src/__tests__/pg.test.ts"], config: "vitest.pg.config.ts" });
    const withPg = await run({ targeted: [makeCommand(), pgCommand] });
    assert.equal(firstCall(withPg).options.needsPostgres, true);
    assert.equal(withPg.report.postgres?.owned, true);
    assert.match(withPg.report.postgres?.database, /^[a-z0-9_]+$/);
    const without = await run({ targeted: [makeCommand()] });
    assert.equal(firstCall(without).options.needsPostgres, false);
    assert.deepEqual(without.report.postgres, { owned: false });
  });
});

describe("command argv", () => {
  const options = { repoRoot: "/repo", outputFile: "/proof/results/x.json" };

  it("pins the engine project and passes the output file and files after the flags", () => {
    const argv = buildCccPlanningCommandArgv(makeCommand({ files: ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"] }), options);
    assert.equal(argv.file, "pnpm");
    assert.equal(argv.cwd, "/repo");
    assert.deepEqual(argv.args, [
      "--filter", "@fusion/engine", "exec", "vitest", "run",
      "--project=engine-default",
      "--silent=passed-only", "--reporter=dot", "--reporter=json", "--outputFile", "/proof/results/x.json",
      "src/__tests__/a.test.ts", "src/__tests__/b.test.ts",
    ]);
  });

  it("maps core with a config, cli, and the dashboard project that card C6b needs", () => {
    const core = buildCccPlanningCommandArgv(makeCommand({ packageFilter: "@fusion/core", project: null, config: "vitest.pg.config.ts" }), options);
    assert.ok(core.args.includes("--config") && core.args.includes("vitest.pg.config.ts"));
    assert.ok(!core.args.some((arg) => arg.startsWith("--project")));
    const cli = buildCccPlanningCommandArgv(makeCommand({ packageFilter: "@runfusion/fusion", project: null }), options);
    assert.deepEqual(cli.args.slice(0, 2), ["--filter", "@runfusion/fusion"]);
    const dashboard = buildCccPlanningCommandArgv(makeCommand({ packageFilter: "@fusion/dashboard", project: "dashboard-api-quality-backfill" }), options);
    assert.deepEqual(dashboard.args.slice(0, 2), ["--filter", "@fusion/dashboard"]);
    assert.ok(dashboard.args.includes("--project=dashboard-api-quality-backfill"));
    const slow = buildCccPlanningCommandArgv(makeCommand({ project: "engine-slow" }), options);
    assert.ok(slow.args.includes("--project=engine-slow"));
  });

  it("runs node-test commands through node --test with the closed-results reporter", () => {
    const argv = buildCccPlanningCommandArgv(makeCommand({ packageFilter: "node-test", project: null, files: ["scripts/__tests__/n.test.mjs"] }), options);
    assert.equal(argv.file, process.execPath);
    assert.equal(argv.cwd, "/repo");
    assert.deepEqual(argv.args.slice(0, 1), ["--test"]);
    assert.ok(argv.args.includes(`--test-reporter=${reporterPath}`));
    assert.ok(argv.args.includes("--test-reporter-destination=/proof/results/x.json"));
    assert.equal(argv.args[argv.args.length - 1], "scripts/__tests__/n.test.mjs");
  });
});

describe("verdicts", () => {
  it("passes a closed all-passed run and reports per-command counts, a digest and provenance fields", async () => {
    const outcome = await run({ targeted: [makeCommand(), makeCommand({ id: "files-mode", closure: "files", expectedNames: [] })] });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.report.schema, "ccc-planning.proof-report.v1");
    assert.equal(outcome.report.passed, true);
    assert.equal(outcome.report.refusal, null);
    assert.equal(outcome.report.mode, "targeted");
    assert.equal(outcome.report.platform, "darwin");
    assert.equal(outcome.report.inventorySha256, "a".repeat(64));
    assert.deepEqual(outcome.report.perCommand.map((row) => [row.id, row.passed, row.expected, row.skipped, row.failed, row.timedOut]), [
      ["fixture-engine", 2, 2, 0, 0, false],
      ["files-mode", 1, null, 0, 0, false],
    ]);
    assert.deepEqual(Object.keys(outcome.report.manifestHashes).sort(), ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    assert.match(outcome.report.manifestHashes["package.json"], /^[0-9a-f]{64}$/);
    assert.equal(outcome.report.gitHead, FIXED_SNAPSHOT.head);
    assert.equal(outcome.report.workingTreeDirty, false);
  });

  it("fails with RESULTS_NOT_CLOSED when one expected name was skipped, and counts it", async () => {
    const control = await run();
    assert.equal(control.exitCode, 0);
    const repoRoot = makeFixtureRepo();
    const skipped = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, { transform: (assertions) => [{ ...assertions[0], status: "skipped" }, assertions[1]] }) });
    assert.equal(skipped.exitCode, 1);
    assert.equal(skipped.report.passed, false);
    assert.equal(skipped.report.refusal?.code, CODE.RESULTS);
    assert.equal(skipped.report.perCommand[0]?.skipped, 1);
  });

  it("fails on a failed test, a missing name and a renamed test, each with RESULTS_NOT_CLOSED", async () => {
    const repoRoot = makeFixtureRepo();
    for (const [label, transform] of Object.entries({
      failed: (assertions) => [{ ...assertions[0], status: "failed" }, assertions[1]],
      "missing name": (assertions) => [assertions[0]],
      renamed: (assertions) => [assertions[0], { ...assertions[1], title: "renamed" }],
    })) {
      const outcome = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, { transform }) });
      assert.equal(outcome.exitCode, 1, label);
      assert.equal(outcome.report.refusal?.code, CODE.RESULTS, label);
    }
  });

  it("fails a file-closed command whose listed file executed zero tests", async () => {
    const repoRoot = makeFixtureRepo();
    const targeted = [makeCommand({ closure: "files", expectedNames: [] })];
    const outcome = await run({ root: repoRoot, targeted, supervisor: makeSupervisor(repoRoot, { transform: () => [] }) });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.RESULTS);
  });

  it("fails an empty suite exactly as decideDarwinProofLaneOutcome decides it", async () => {
    const decision = decideDarwinProofLaneOutcome([{ suite: "fixture-engine", numTotalTests: 0, numPendingTests: 0, numFailedTests: 0, exitStatus: 0 }]);
    assert.equal(decision.ok, false);
    const repoRoot = makeFixtureRepo();
    const outcome = await run({
      root: repoRoot,
      targeted: [makeCommand({ closure: "files", expectedNames: [] })],
      supervisor: makeSupervisor(repoRoot, { transform: () => [], reportOverride: (report) => ({ ...report, testResults: [] }) }),
    });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.RESULTS);
    assert.match(outcome.report.refusal?.detail, /executed 0 test/);
  });

  it("fails with SUPERVISOR_FAILED on a timeout, a signal, a nonzero exit after a closed pass, a stop error, and a missing, duplicate or unknown result row", async () => {
    const repoRoot = makeFixtureRepo();
    const cases = {
      timeout: { row: () => ({ code: 1, signal: "SIGTERM", timedOut: true }) },
      signal: { row: () => ({ signal: "SIGKILL" }) },
      "nonzero exit": { row: () => ({ code: 1 }) },
      "stop error": { stopError: "embedded PostgreSQL stop timed out" },
      "missing row": { rows: () => [] },
      "duplicate row": { rows: (rows) => [...rows, ...rows] },
      "unknown row": { rows: (rows) => [...rows, { id: "not-in-inventory", code: 0, signal: null, timedOut: false, outputFile: null }] },
    };
    for (const [label, behaviour] of Object.entries(cases)) {
      const outcome = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, behaviour) });
      assert.equal(outcome.exitCode, 1, label);
      assert.equal(outcome.report.refusal?.code, CODE.SUPERVISOR, label);
    }
    const timedOut = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, cases.timeout) });
    assert.equal(timedOut.report.perCommand[0]?.timedOut, true);
  });

  it("fails with RESULTS_NOT_CLOSED when a command wrote no machine result, and refuses a result path the runner did not choose", async () => {
    const repoRoot = makeFixtureRepo();
    const none = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, { skipWritingResults: true }) });
    assert.equal(none.report.refusal?.code, CODE.RESULTS);
    const elsewhere = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, { row: () => ({ outputFile: "/etc/hosts" }) }) });
    assert.equal(elsewhere.report.refusal?.code, CODE.SUPERVISOR);
  });

  it("keeps the report, and removes the scratch directories, when the run passes; preserves everything when it fails", async () => {
    const passed = await run();
    assert.equal(passed.report.scratch.cleanup, "removed-on-pass");
    assert.ok(existsSync(path.join(passed.report.scratch.root, "report.json")));
    assert.equal(existsSync(path.join(passed.report.scratch.root, "scratch")), false);
    assert.equal(JSON.parse(readFileSync(path.join(passed.report.scratch.root, "report.json"), "utf8")).passed, true);

    const repoRoot = makeFixtureRepo();
    const failed = await run({ root: repoRoot, supervisor: makeSupervisor(repoRoot, { transform: (assertions) => [assertions[0]] }) });
    assert.equal(failed.report.scratch.cleanup, "preserved-on-failure");
    assert.ok(existsSync(path.join(failed.report.scratch.root, "scratch")));
  });
});

describe("foreign Git mutation", () => {
  it("fails when the Git snapshot taken after the run differs from the one before it, and passes when they match", async () => {
    let calls = 0;
    const changing = await run({
      extra: {
        gitSnapshot: async () => {
          calls += 1;
          return calls === 1 ? FIXED_SNAPSHOT : { ...FIXED_SNAPSHOT, worktrees: `${FIXED_SNAPSHOT.worktrees}worktree /elsewhere\nbranch refs/heads/other\n` };
        },
      },
    });
    assert.equal(changing.exitCode, 1);
    assert.equal(changing.report.refusal?.code, CODE.FOREIGN_GIT);
    const same = await run();
    assert.equal(same.exitCode, 0);
  });

  it("fails when a command adds a worktree to the real repository, and passes when it writes only under the scratch root", async () => {
    const { root } = makeGitRepo();
    const addWorktree = makeSupervisor(root, {
      before: async () => {
        execFileSync("git", ["worktree", "add", "-q", path.join(uniqueDir("elsewhere"), "wt"), "-b", "foreign-branch"], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
    });
    const mutated = await run({ root, supervisor: addWorktree, extra: { gitSnapshot: undefined } });
    assert.equal(mutated.exitCode, 1);
    assert.equal(mutated.report.refusal?.code, CODE.FOREIGN_GIT);

    const control = makeGitRepo();
    const scratchOnly = makeSupervisor(control.root, { before: async (_commands, options) => writeFileSync(path.join(options.scratchRoot, "note.txt"), "inside the scratch root") });
    const clean = await run({ root: control.root, supervisor: scratchOnly, extra: { gitSnapshot: undefined } });
    assert.equal(clean.exitCode, 0, JSON.stringify(clean.report.refusal));
    assert.match(clean.report.gitHead, /^[0-9a-f]{40}$/);
    assert.match(clean.report.gitTree, /^[0-9a-f]{40}$/);
  });

  it("fails when a command leaves a new untracked file or commits to the repository, and records a tracked-dirty tree honestly without failing", async () => {
    const untracked = makeGitRepo();
    const dirtied = await run({
      root: untracked.root,
      supervisor: makeSupervisor(untracked.root, { before: async () => writeFileSync(path.join(untracked.root, "stray.txt"), "left behind") }),
      extra: { gitSnapshot: undefined },
    });
    assert.equal(dirtied.report.refusal?.code, CODE.FOREIGN_GIT);

    const committing = makeGitRepo();
    const moved = await run({
      root: committing.root,
      supervisor: makeSupervisor(committing.root, { before: async () => committing.git("commit", "-q", "--allow-empty", "-m", "foreign commit") }),
      extra: { gitSnapshot: undefined },
    });
    assert.equal(moved.report.refusal?.code, CODE.FOREIGN_GIT);

    const preDirty = makeGitRepo();
    writeFileSync(path.join(preDirty.root, "package.json"), "{\"name\":\"fixture\",\"dirty\":true}\n");
    const honest = await run({ root: preDirty.root, extra: { gitSnapshot: undefined } });
    assert.equal(honest.exitCode, 0, JSON.stringify(honest.report.refusal));
    assert.equal(honest.report.workingTreeDirty, true);
  });
});

describe("offline network denial through the runner", () => {
  const attempt = `try { require("node:net").connect(9, "192.0.2.1").on("error", () => {}).destroy(); process.stdout.write("returned"); } catch (error) { process.stdout.write(error.code); }`;

  it("fails the run with NETWORK_ATTEMPT when a child under the handed-over environment connects to TEST-NET-1, with one report line", async () => {
    const repoRoot = makeFixtureRepo();
    let reportFile;
    let childOutput;
    const supervisor = makeSupervisor(repoRoot, {
      before: async (_commands, options) => {
        reportFile = options.env.CCC_PLANNING_OFFLINE_GUARD_REPORT;
        childOutput = spawnSync(process.execPath, ["-e", attempt], { env: options.env, encoding: "utf8", timeout: 30_000 }).stdout;
      },
    });
    const outcome = await run({ root: repoRoot, supervisor });
    assert.equal(childOutput, CODE.NETWORK);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.NETWORK);
    assert.equal(outcome.report.offlineGuard?.attempts, 1);
    assert.equal(readFileSync(reportFile, "utf8").split("\n").filter(Boolean).length, 1);
  });

  it("passes when the child makes no outside connection, and reports zero attempts", async () => {
    const repoRoot = makeFixtureRepo();
    const supervisor = makeSupervisor(repoRoot, {
      before: async (_commands, options) => {
        spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(0, "127.0.0.1", function () { this.close(); });`], { env: options.env, encoding: "utf8", timeout: 30_000 });
      },
    });
    const outcome = await run({ root: repoRoot, supervisor });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.report.offlineGuard?.attempts, 0);
  });
});

/*
FNXC:CccPlanningProof 2026-10-14-10:50:
These cases run the REAL supervisor, the real `node --test` child, the real closed-results reporter and the real guard preload, against a fixture repository, with no PostgreSQL. They exist because every case above injects `runSupervised`: a smoke run of the real runner showed that an environment which looks right to a test double (a dead PostgreSQL address) made the real vitest global setup throw. The owned-PostgreSQL branch of the supervisor needs the embedded server binary and `tsx`, so it is covered by the card's manual smoke, not here.
*/
describe("real supervisor without PostgreSQL", () => {
  const nodeTest = (body) => `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport net from "node:net";\n${body}\n`;
  const nodeCommand = (overrides = {}) =>
    makeCommand({
      id: "real-node",
      packageFilter: "node-test",
      project: null,
      files: ["scripts/__tests__/n.test.mjs"],
      expectedNames: ["env > is offline and skips PostgreSQL"],
      timeoutMs: 60_000,
      ...overrides,
    });
  const envTest = nodeTest(`describe("env", () => { it("is offline and skips PostgreSQL", () => {
  assert.equal(process.env.PI_OFFLINE, "1");
  assert.equal(process.env.FUSION_PG_TEST_SKIP, "1");
  assert.equal(process.env.FUSION_PG_TEST_URL_BASE, undefined);
  assert.equal(process.env.CCC_PG_URL_BASE, undefined);
  assert.match(process.env.NODE_OPTIONS, /ccc-planning-offline-network-guard/);
  assert.equal(process.env.TMPDIR, process.env.CCC_PLANNING_PROOF_SCRATCH);
}); });`);
  const realRun = (repoRoot, command) => run({ root: repoRoot, targeted: [command], supervisor: runSupervisedProofCommands });

  it("passes a fixture test that sees PI_OFFLINE, the guard preload, the scratch TMPDIR and no PostgreSQL address", async () => {
    const outcome = await realRun(makeFixtureRepo({ "scripts/__tests__/n.test.mjs": envTest }), nodeCommand());
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.report.failures));
    assert.deepEqual(outcome.report.perCommand.map((row) => [row.id, row.passed, row.expected, row.skipped, row.failed, row.timedOut, row.exitCode]), [["real-node", 1, 1, 0, 0, false, 0]]);
    assert.equal(outcome.report.offlineGuard.attempts, 0);
    assert.equal(existsSync(path.join(outcome.report.scratch.root, "scratch")), false);
    assert.ok(existsSync(path.join(outcome.report.scratch.root, "logs", "real-node.log")));
  });

  it("fails a fixture test that throws with RESULTS_NOT_CLOSED, not with the generic exit-code refusal", async () => {
    const failing = nodeTest(`describe("env", () => { it("is offline and skips PostgreSQL", () => { assert.equal(1, 2); }); });`);
    const outcome = await realRun(makeFixtureRepo({ "scripts/__tests__/n.test.mjs": failing }), nodeCommand());
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.RESULTS);
    assert.equal(outcome.report.perCommand[0].failed, 1);
    assert.equal(outcome.report.perCommand[0].exitCode, 1);
    assert.match(outcome.report.perCommand[0].failureDetails[0], /env > is offline and skips PostgreSQL: .*1 !== 2|Expected values to be strictly equal/s);
  });

  it("fails a fixture test that swallows its own refused network attempt, because the guard report is not empty", async () => {
    const swallowing = nodeTest(`describe("env", () => { it("is offline and skips PostgreSQL", () => {
  try { net.connect(9, "192.0.2.1").on("error", () => {}).destroy(); } catch { /* the test hides the refusal */ }
}); });`);
    const outcome = await realRun(makeFixtureRepo({ "scripts/__tests__/n.test.mjs": swallowing }), nodeCommand());
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.NETWORK);
    assert.equal(outcome.report.offlineGuard.attempts, 1);
    assert.equal(outcome.report.offlineGuard.entries[0].host, "192.0.2.1");
    assert.equal(outcome.report.perCommand[0].passed, 1, "the test itself passed; only the tripwire caught it");
  });

  it("stops a command that exceeds its timeout and reports it as timed out", async () => {
    const hanging = nodeTest(`describe("env", () => { it("is offline and skips PostgreSQL", async () => { await new Promise((resolve) => setTimeout(resolve, 60000)); }); });`);
    const outcome = await realRun(makeFixtureRepo({ "scripts/__tests__/n.test.mjs": hanging }), nodeCommand({ timeoutMs: 1500 }));
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.report.refusal?.code, CODE.SUPERVISOR);
    assert.equal(outcome.report.perCommand[0].timedOut, true);
    assert.match(outcome.report.refusal?.detail, /1500 ms timeout/);
  });
});

describe("node:test result reporter", () => {
  it("writes a vitest-shaped report with ancestor titles, so node-test commands close the same way", () => {
    const dir = uniqueDir("node-reporter");
    const fixture = path.join(dir, "fixture.test.mjs");
    writeFileSync(
      fixture,
      [
        `import { describe, it } from "node:test";`,
        `describe("outer", () => {`,
        `  describe("inner", () => {`,
        `    it("passes", () => {});`,
        `    it("is skipped", { skip: true }, () => {});`,
        `    it("is todo", { todo: true }, () => {});`,
        `    it("fails", () => { throw new Error("boom"); });`,
        `  });`,
        `});`,
        `it("top level", () => {});`,
      ].join("\n"),
    );
    const out = path.join(dir, "result.json");
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, `--test-reporter-destination=${out}`, fixture], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 1, "the fixture has one failing test, so node exits 1");
    const report = JSON.parse(readFileSync(out, "utf8"));
    const byName = Object.fromEntries(report.testResults.flatMap((file) => file.assertionResults).map((a) => [[...a.ancestorTitles, a.title].join(" > "), a.status]));
    assert.deepEqual(byName, {
      "outer > inner > passes": "passed",
      "outer > inner > is skipped": "skipped",
      "outer > inner > is todo": "todo",
      "outer > inner > fails": "failed",
      "top level": "passed",
    });
    const failedAssertion = report.testResults.flatMap((file) => file.assertionResults).find((a) => a.status === "failed");
    assert.match(failedAssertion.failureMessages[0], /boom/, "a failed test carries its message, so the run report can say why");
    assert.equal(report.testResults.length, 1, "node reports one file under two spellings of its path; they must collapse to one entry");
    assert.equal(realpathSync(report.testResults[0].name), realpathSync(fixture));
    assert.deepEqual(
      [report.numTotalTests, report.numPassedTests, report.numFailedTests, report.numPendingTests, report.numTodoTests],
      [5, 2, 1, 1, 1],
    );
  });

  it("produces a report that a names-closed command accepts when everything passed", () => {
    const dir = uniqueDir("node-reporter-pass");
    const fixture = path.join(dir, "fixture.test.mjs");
    writeFileSync(fixture, `import { describe, it } from "node:test";\ndescribe("suite", () => { it("a", () => {}); it("b", () => {}); });\n`);
    const out = path.join(dir, "result.json");
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, `--test-reporter-destination=${out}`, fixture], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0);
    const command = makeCommand({ packageFilter: "node-test", project: null, files: ["fixture.test.mjs"] });
    assert.deepEqual(assertMachineResultJson(JSON.parse(readFileSync(out, "utf8")), command, { packageRoot: dir }), { passed: 2, skipped: 0, failed: 0, files: 1 });
  });
});

describe("node:test result reporter: failures outside a test", () => {
  it("marks a module that crashes at load as a failed file, and records a suite body that throws as a failed test", () => {
    const dir = uniqueDir("node-reporter-crash");
    writeFileSync(path.join(dir, "ok.test.mjs"), `import { describe, it } from "node:test";\ndescribe("suite", () => { it("a", () => {}); });\n`);
    writeFileSync(path.join(dir, "crash.test.mjs"), `import { it } from "node:test";\nit("never registered", () => {});\nthrow new Error("module-level crash");\n`);
    writeFileSync(path.join(dir, "body.test.mjs"), `import { describe, it } from "node:test";\ndescribe("broken suite", () => { throw new Error("suite boom"); });\n`);
    const out = path.join(dir, "result.json");
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, `--test-reporter-destination=${out}`, "ok.test.mjs", "crash.test.mjs", "body.test.mjs"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const byBase = Object.fromEntries(report.testResults.map((file) => [path.basename(file.name), file]));
    assert.equal(byBase["crash.test.mjs"].status, "failed");
    assert.deepEqual(byBase["crash.test.mjs"].assertionResults, []);
    assert.deepEqual(byBase["body.test.mjs"].assertionResults.map((a) => [a.title, a.status]), [["broken suite", "failed"]]);
    assert.equal(byBase["ok.test.mjs"].status, "passed");

    // The positive control is the clean file alone: it closes. With the crashing file listed, the same command refuses.
    const clean = makeCommand({ packageFilter: "node-test", project: null, files: ["ok.test.mjs"], expectedNames: ["suite > a"] });
    const cleanReport = { ...report, testResults: [byBase["ok.test.mjs"]], numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
    assert.deepEqual(assertMachineResultJson(cleanReport, clean, { packageRoot: dir }), { passed: 1, skipped: 0, failed: 0, files: 1 });
    const withCrash = makeCommand({ packageFilter: "node-test", project: null, files: ["ok.test.mjs", "crash.test.mjs"], expectedNames: ["suite > a"] });
    const crashReport = { ...cleanReport, testResults: [byBase["ok.test.mjs"], byBase["crash.test.mjs"]] };
    assert.throws(() => assertMachineResultJson(crashReport, withCrash, { packageRoot: dir }), codeOf(CODE.RESULTS));
  });
});

describe("package scripts and entry points", () => {
  const rootPackage = JSON.parse(readFileSync(path.join(realRepoRoot, "package.json"), "utf8"));

  it("adds exactly the four contract keys with their exact commands", () => {
    assert.equal(rootPackage.scripts["test:ccc-planning"], "node scripts/run-ccc-planning-proof.mjs --mode targeted");
    assert.equal(rootPackage.scripts["verify:ccc-planning-offline"], "node scripts/run-ccc-planning-proof.mjs --mode offline");
    assert.equal(rootPackage.scripts["verify:ccc-planning-live"], "node scripts/ccc-planning-live-proof.mjs");
    assert.equal(rootPackage.scripts["verify:ccc-planning-installed"], "node scripts/ccc-planning-installed-proof.mjs");
    assert.deepEqual(Object.keys(rootPackage.scripts).filter((key) => /ccc-planning/.test(key)).sort(), [
      "test:ccc-planning",
      "verify:ccc-planning-installed",
      "verify:ccc-planning-live",
      "verify:ccc-planning-offline",
    ]);
  });

  it("keeps the planning suites out of test:gate, test:ccc-prd-safety, pretest and test:pg-gate", () => {
    const enginePackage = JSON.parse(readFileSync(path.join(realRepoRoot, "packages/engine/package.json"), "utf8"));
    const corePackage = JSON.parse(readFileSync(path.join(realRepoRoot, "packages/core/package.json"), "utf8"));
    for (const script of [rootPackage.scripts["test:gate"], rootPackage.scripts["test:ccc-prd-safety"], rootPackage.scripts.pretest, corePackage.scripts["test:pg-gate"], enginePackage.scripts["test:core"]]) {
      assert.ok(typeof script === "string" && script.length > 0);
      assert.ok(!/ccc-planning/.test(script), script);
    }
  });

  it("makes the live and installed commands exit 1 with a NOT_IMPLEMENTED refusal for any arguments", () => {
    for (const [script, extraArgs] of [
      ["scripts/ccc-planning-live-proof.mjs", ["--profile", "full", "--confirm-authority", "typed-by-ryan"]],
      ["scripts/ccc-planning-live-proof.mjs", []],
      ["scripts/ccc-planning-installed-proof.mjs", []],
    ]) {
      const result = spawnSync(process.execPath, [path.join(realRepoRoot, script), ...extraArgs], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 1, script);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr.trim()).code, "CCC_PLANNING_PROOF_NOT_IMPLEMENTED");
    }
    const installed = JSON.parse(spawnSync(process.execPath, [path.join(realRepoRoot, "scripts/ccc-planning-installed-proof.mjs")], { encoding: "utf8" }).stderr);
    assert.ok(installed.notRun.length > 0);
  });

  it("exits 2 with a usage refusal when the runner is started with a bad argument list", () => {
    for (const args of [[], ["--mode", "nonsense"], ["--mode", "targeted", "--surprise"]]) {
      const result = spawnSync(process.execPath, [path.join(realRepoRoot, "scripts/run-ccc-planning-proof.mjs"), ...args], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, new RegExp(CODE.USAGE));
    }
  });
});
