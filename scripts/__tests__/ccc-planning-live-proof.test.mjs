// port-4040-allowlist: this file only asserts that a serve lane refuses a 4040 binding in a fixture log; it never binds, kills or probes that port.
/*
FNXC:CccPlanningLiveProof 2026-10-15-00:45:
Card LV (CONTRACT-v3.5 section 4.2 step 5, section 2.20, section 4.5, D23, D52; errata E9 rulings 2 and 4): the live and installed proof scripts. Every test drives a fake `fn` executable written into the test's temp dir; the Pueue, lsof and pgrep the serve lane calls are fake executables on a PATH the test controls. Nothing spawns the real fn, a real serve, a real provider or the network, and nothing binds or probes port 4040.

What is proved (RED item -> test):
- no `--confirm-authority` -> exit 1 `CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED` before any spawn, write or Pueue call (the flag with no value, an empty value and a following flag all count as missing);
- a wrong digest -> the exact typed bytes reach `fn plan start` (the fake fn logs its argv) and the downstream `CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED` refusal is reported unchanged; awkward bytes (case, spaces, tab, non-ASCII) arrive unchanged, so nothing trims, folds or validates them;
- the script never writes, confirms or hashes an authority receipt: a file-system spy covers writes (only the report is written) and a `crypto` spy matches hash input equal to the receipt file's bytes (item 52). The spy is narrowed, not "every hash": the drift case recomputes the dist digest for real, which the spy sees (`hashUpdates > 0`) and allows (`matches` empty). The spy also matches the digest preimage (the receipt body without `operatorConfirmation`), because that is what a script would hash to compute the digest; this is stricter than the specification. A "spy has teeth" test hashes the receipt bytes on purpose and must be matched;
- `--profile adaptive|lean` -> `CCC_PLANNING_PROFILE_NOT_IMPLEMENTED`; the installed proof always exits 1 and lists every NOT RUN item, a perfect candidate included;
- a candidate with a one-byte dist drift, or with a `keepaliveModelSource` other than `fusion-receipt-adapter`, is refused (IP's verifier, called by LV), each with an untouched twin that verifies;
- the report lists `notEnforced` (D52) and the section 4.5 NOT RUN items; the positive control is a correct receipt and digest passing through to a fake fn that returns `run_admitted`, polled to `accepted`, with serve stopped.
Non-vacuity is proved with mutants: each mutant is a copy of the real script text with one edit (its anchor must match exactly once, so a reformatted script fails loudly instead of passing untouched), run against the same property function as the real script; the property must pass on the real script and fail on the mutant. The mutants are: a script that "helpfully" hashes the receipt to fill in the digest (file bytes, and the digest preimage), one that rewrites the receipt, one that trims and folds the typed digest, one that spawns before checking the digest, one that accepts adaptive, one that skips candidate verification, one that never stops serve, one that trusts a driver's own verdict for the keepalive arm, one that drops `notEnforced`, and (installed) one that exits 0 for a valid candidate.
The fn-path keepalive arm (E9 ruling 4) is NOT RUN by default (no installed fn command drives a bound session offline and card SF is not integrated); the tests prove it is reported `not_run` with the reason, never `passed`, and that a supplied driver is judged by the script.
The installed keepalive lane (`ccc-planning-installed-keepalive.test.mjs`) is parent-run and must stay out of every inventory card (E9 ruling 2); a test checks that.
*/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCccPlanningServeLaunch } from "../lib/ccc-planning-serve-lane.mjs";
import { captureCccPlanningInstalledRuntimeReceipt } from "../lib/ccc-planning-installed-runtime.mjs";
import * as live from "../ccc-planning-live-proof.mjs";
import * as installed from "../ccc-planning-installed-proof.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SCRIPT = path.join(repoRoot, "scripts/ccc-planning-live-proof.mjs");
const INSTALLED_SCRIPT = path.join(repoRoot, "scripts/ccc-planning-installed-proof.mjs");
const TYPES_TS = path.join(repoRoot, "packages/core/src/ccc-planning/types.ts");

const PROJECT_ID = "proj_lvfixture01";
const RUN_ID = "r2c-lvfixture00000000000001";
const DATABASE_URL = "postgresql://postgres@127.0.0.1:55432/fusion";
const START_MS = Date.parse("2026-10-16T00:00:00.000Z");
const HOURS_48_MS = 48 * 3_600_000;
const AUTO_REGISTERED_LOG = [
  "ccc-planning-serve-lane pid=4242",
  `[serve] Auto-registered project "target" at /scratch/target`,
  `[serve] HTTP layer bound to project ccc-r2c-i2 (${PROJECT_ID}) [source: --project]`,
  "  → http://127.0.0.1:55123",
].join("\n");
const FORBIDDEN_PORT_LOG = [
  "ccc-planning-serve-lane pid=4242",
  `[serve] HTTP layer bound to project ccc-r2c-i2 (${PROJECT_ID}) [source: --project]`,
  `  → http://127.0.0.1:${4040}`,
].join("\n");
const UNCONFIRMED_DETAIL = "--confirm-authority does not equal the receipt's operatorConfirmation";
const NOT_RUN_IDS = [
  "g9-delivery-and-landing",
  "flash-extraction-leaves",
  "coding-repair",
  "observed-acceptance-auditor",
  "live-spec-mode",
  "plan-build-budget-amendments-escalation-pause-resume",
  "adaptive-v2-and-lean-v2",
  "dashboard-and-mail-surfaces",
  "multi-root-concurrency-resource-ramp",
  "qualification-certificate-held-out-admitted-repositories",
  "linux-confinement-backend",
  "macos-ci-evidence",
  "verify-ccc-planning-installed",
  "raw-m3-tool-call-probe",
  "unlinked-campaign-turn-key-retry-index",
];
const NOT_ENFORCED_IDS = ["authority-digest-typed-by-operator", "fn-plan-answer", "fn-plan-pause-cancel-resume"];
const INSTALLED_NOT_RUN_IDS = [
  "neutral-directory-cli-journeys",
  "neutral-directory-dashboard-journeys",
  "twelve-criterion-release-matrix",
  "held-out-results",
  "fn-path-keepalive-arm",
];

// ------------------------------------------------------------------ fixtures

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Source of the fake installed `fn`. It is stringified into a file, so it may only use what a CommonJS script has. */
function fakeFnMain(ROOT) {
  const fileSystem = require("node:fs");
  const nodePath = require("node:path");
  const argv = process.argv.slice(2);
  const readJson = (name, fallback) => {
    try {
      return JSON.parse(fileSystem.readFileSync(nodePath.join(ROOT, name), "utf8"));
    } catch {
      return fallback;
    }
  };
  const scenario = readJson("fn-scenario.json", {});
  const env = {};
  for (const name of ["HOME", "FUSION_HOME", "DATABASE_URL", "TMPDIR", "PI_OFFLINE", "NO_COLOR", "OMNIROUTE_API_KEY", "PORT"]) env[name] = process.env[name] ?? null;
  fileSystem.appendFileSync(nodePath.join(ROOT, "fn-calls.jsonl"), `${JSON.stringify({ argv, cwd: process.cwd(), env })}\n`);
  const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const refusal = (code, detail) => {
    line({ schema: "ccc-planning.cli.v1", kind: "refusal", code, detail });
    process.exitCode = 1;
  };
  if (argv[0] === "--version") {
    process.stdout.write("fake-fn 0.0.0-lv\n");
    return;
  }
  if (argv[0] === "plan" && argv.length === 1) {
    process.stderr.write("usage: fn plan <subcommand>\n");
    process.exitCode = 2;
    return;
  }
  if (argv[0] === "plan" && argv[1] === "--help") {
    process.stdout.write("fn plan help\n");
    return;
  }
  if (argv[0] === "plan" && argv[1] === "start") {
    const flags = {};
    for (let index = 2; index < argv.length; index += 1) {
      if (argv[index] === "--json") continue;
      flags[argv[index]] = argv[index + 1];
      index += 1;
    }
    if (scenario.startOutput === "garbage") {
      process.stdout.write("this is not json\n");
      return;
    }
    if (scenario.startOutput === "two_lines") {
      refusal("CCC_PLANNING_FIXTURE_REFUSAL", "first");
      line({ schema: "ccc-planning.cli.v1", kind: "refusal", code: "CCC_PLANNING_FIXTURE_REFUSAL", detail: "second" });
      return;
    }
    let receipt;
    try {
      receipt = JSON.parse(fileSystem.readFileSync(flags["--authority-receipt"], "utf8"));
    } catch {
      refusal("CCC_PLANNING_AUTHORITY_RECEIPT_INVALID", "the receipt cannot be read");
      return;
    }
    if (typeof flags["--confirm-authority"] !== "string" || flags["--confirm-authority"] === "") {
      refusal("CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED", "--confirm-authority is required");
      return;
    }
    if (flags["--confirm-authority"] !== receipt.operatorConfirmation) {
      refusal("CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", "--confirm-authority does not equal the receipt's operatorConfirmation");
      return;
    }
    line({
      schema: "ccc-planning.cli.v1",
      kind: "run_admitted",
      runId: scenario.runId,
      projectId: flags["--project"],
      planningTaskId: "FN-1",
      state: "admitted",
      deadlineAt: scenario.deadlineAt,
      receiptSha256: "a".repeat(64),
      allocations: { planning: 1536, implementation: 3072, reviewProof: 1536 },
      plannedPlanningNodes: scenario.plannedPlanningNodes,
    });
    return;
  }
  if (argv[0] === "plan" && argv[1] === "status") {
    const countFile = nodePath.join(ROOT, "fn-status-count");
    let count = 0;
    try {
      count = Number(fileSystem.readFileSync(countFile, "utf8")) || 0;
    } catch {
      count = 0;
    }
    fileSystem.writeFileSync(countFile, String(count + 1));
    const states = scenario.statusStates;
    const state = states[Math.min(count, states.length - 1)];
    line({
      schema: "ccc-planning.cli.v1",
      kind: "status",
      status: { schema: "ccc-planning.run-status.v1", runId: argv[2], projectId: "fixture", state, stateCode: (scenario.stateCodes ?? {})[state] ?? null, notRun: [] },
    });
    return;
  }
  process.stderr.write("unexpected fake fn invocation\n");
  process.exitCode = 99;
}

/** Source of the fake pueue, lsof and pgrep: one script, three wrappers. */
function fakeHostMain(ROOT, PROJECT) {
  const fileSystem = require("node:fs");
  const nodePath = require("node:path");
  const [tool, ...args] = process.argv.slice(2);
  const statePath = nodePath.join(ROOT, "host-state.json");
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fileSystem.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  const state = readJson(statePath, { calls: [], killed: [], added: [] });
  const scenario = readJson(nodePath.join(ROOT, "host-scenario.json"), {});
  state.calls.push([tool, ...args]);
  const reply = (stdout, code) => {
    fileSystem.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(stdout);
    process.exitCode = code ?? 0;
  };
  const bound = `[serve] HTTP layer bound to project ccc-r2c-i2 (${PROJECT}) [source: --project]`;
  const cleanLog = ["ccc-planning-serve-lane pid=4242", "[serve] hybrid executor gate: enabled=false reason=none", bound, "", "  Fusion Node", "  → http://127.0.0.1:55123", ""].join("\n");
  if (tool === "pueue" && args[0] === "group" && args[1] === "--json") {
    reply(JSON.stringify({ default: { status: "Paused", parallel_tasks: 2 }, "ccc-r2c-i2": { status: "Running", parallel_tasks: 1 } }));
    return;
  }
  if (tool === "pueue" && args[0] === "add") {
    state.added.push(args);
    reply("41\n");
    return;
  }
  if (tool === "pueue" && args[0] === "log") {
    const done = state.killed.length > 0;
    const status = done ? { Done: { result: "Success" } } : { Running: { enqueued_at: "x", start: "y" } };
    reply(JSON.stringify({ 41: { task: { id: 41, status }, output: scenario.log ?? cleanLog } }));
    return;
  }
  if (tool === "pueue" && args[0] === "kill") {
    state.killed.push(args);
    reply("");
    return;
  }
  if (tool === "lsof") {
    reply(`p4242\n${(scenario.listeners ?? ["127.0.0.1:55123"]).map((address) => `n${address}`).join("\n")}\n`);
    return;
  }
  if (tool === "pgrep") {
    const descendants = scenario.descendants ?? [];
    if (descendants.length > 0) reply(`${descendants.join("\n")}\n`);
    else reply("", 1);
    return;
  }
  state.calls.push(["unexpected host command"]);
  reply("", 127);
}

async function makeWorld(options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ccc-lv-world-")));
  const paths = {
    root,
    fn: path.join(root, "install/node_modules/.bin/fn"),
    installedRoot: path.join(root, "install/node_modules/@runfusion/fusion"),
    piAiRoot: path.join(root, "install/node_modules/@earendil-works/pi-ai"),
    tarball: path.join(root, "evidence/pack/runfusion-fusion-0.0.0-lv.tgz"),
    candidate: path.join(root, "evidence/installed-runtime.json"),
    report: path.join(root, "evidence/live-proof-report.json"),
    target: path.join(root, "target"),
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    request: path.join(root, "request/request.md"),
    approval: path.join(root, "authority/receipt.json"),
    authorityDir: path.join(root, "authority"),
    bin: path.join(root, "bin"),
    hostScript: path.join(root, "fake-host.cjs"),
  };
  for (const directory of [
    path.dirname(paths.fn), path.join(paths.installedRoot, "dist"), path.join(paths.piAiRoot, "dist/api"), path.dirname(paths.tarball),
    paths.target, paths.home, paths.tmp, path.dirname(paths.request), paths.authorityDir, paths.bin,
  ]) await mkdir(directory, { recursive: true });

  await writeFile(paths.fn, `#!/usr/bin/env node\n(${fakeFnMain.toString()})(${JSON.stringify(root)});\n`);
  await chmod(paths.fn, 0o755);
  await writeFile(paths.hostScript, `(${fakeHostMain.toString()})(${JSON.stringify(root)}, ${JSON.stringify(PROJECT_ID)});\n`);
  for (const tool of ["pueue", "lsof", "pgrep"]) {
    await writeFile(path.join(paths.bin, tool), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(paths.hostScript)} ${tool} "$@"\n`);
    await chmod(path.join(paths.bin, tool), 0o755);
  }
  await writeFile(path.join(paths.installedRoot, "package.json"), `${JSON.stringify({ name: "@runfusion/fusion", version: "0.0.0-lv", dependencies: { "@earendil-works/pi-ai": "0.81.1" } })}\n`);
  await writeFile(path.join(paths.installedRoot, "dist/bin.js"), options.binJs ?? "// fixture bin A\n");
  await writeFile(
    path.join(paths.installedRoot, "dist/ccc-route-receipt-adapter.js"),
    'import "@earendil-works/pi-ai";\nexport const CCC_TERMINAL_ROUTE_RECEIPT_API = "ccc-terminal-route-receipt.v1";\nconst commentPrefix = ": x-omniroute-";\n',
  );
  await writeFile(path.join(paths.piAiRoot, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.81.1" })}\n`);
  await writeFile(path.join(paths.piAiRoot, "dist/api/openai-completions.js"), "// registry copy without the workspace patch marker\n");
  await writeFile(paths.tarball, "fixture tarball bytes\n");
  await writeFile(paths.request, "# sealed request fixture\n");

  const body = { schema: "ccc-planning.live-authority-receipt.v1", project: { projectId: PROJECT_ID }, profile: "full-v2", budgetProfile: "standard", note: "fixture authority receipt for the LV tests" };
  const typedDigest = sha256Hex(canonicalJson(body));
  const receiptBytes = Buffer.from(`${canonicalJson({ ...body, operatorConfirmation: typedDigest })}\n`);
  await writeFile(paths.approval, receiptBytes);
  const bodyBytes = Buffer.from(canonicalJson(body));
  const preimages = [receiptBytes, receiptBytes.subarray(0, receiptBytes.length - 1), bodyBytes, Buffer.concat([bodyBytes, Buffer.from("\n")])];

  const world = {
    paths, typedDigest, receiptBytes, preimages, candidateText: "",
    async prepare(scenario = {}) {
      for (const name of ["fn-calls.jsonl", "fn-status-count", "host-state.json", "fn-scenario.json", "host-scenario.json"]) await rm(path.join(root, name), { force: true });
      await rm(paths.report, { force: true });
      await writeFile(paths.approval, receiptBytes);
      if (world.candidateText !== "") await writeFile(paths.candidate, world.candidateText);
      await writeFile(path.join(root, "fn-scenario.json"), JSON.stringify({
        runId: RUN_ID, deadlineAt: new Date(START_MS + HOURS_48_MS).toISOString(), plannedPlanningNodes: 14, statusStates: ["accepted"], ...scenario.fn,
      }));
      await writeFile(path.join(root, "host-scenario.json"), JSON.stringify(scenario.host ?? {}));
    },
    async fnCalls() {
      try {
        return (await readFile(path.join(root, "fn-calls.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async hostState() {
      try {
        return JSON.parse(await readFile(path.join(root, "host-state.json"), "utf8"));
      } catch {
        return { calls: [], killed: [], added: [] };
      }
    },
  };
  const receipt = await captureCccPlanningInstalledRuntimeReceipt({
    source: { gitHead: "a".repeat(40), gitTree: "b".repeat(40), workingTreeDirty: false, capturedBeforeBuild: true },
    toolchain: { node: "v0.0.0", npm: "0.0.0", pnpm: "0.0.0" },
    tarballPath: paths.tarball,
    installedRoot: paths.installedRoot,
    executablePath: paths.fn,
    home: paths.home,
    noExternal: [],
  });
  world.candidateText = `${JSON.stringify(receipt, null, 2)}\n`;
  world.receipt = receipt;
  await world.prepare();
  return world;
}

const worlds = [];
const worldCache = new Map();
function sharedWorld(key = "shared", options = {}) {
  if (!worldCache.has(key)) {
    worldCache.set(key, makeWorld(options).then((world) => {
      worlds.push(world);
      return world;
    }));
  }
  return worldCache.get(key);
}

after(async () => {
  for (const world of worlds) await rm(world.paths.root, { recursive: true, force: true });
  await rm(mutantDir, { recursive: true, force: true });
});

function liveArgs(world, { omit = [], set = {}, extra = [] } = {}) {
  const pairs = [
    ["--profile", "full"],
    ["--candidate", world.paths.candidate],
    ["--approval-receipt", world.paths.approval],
    ["--confirm-authority", world.typedDigest],
    ["--project", PROJECT_ID],
    ["--database-url", DATABASE_URL],
  ];
  const args = [];
  for (const [flag, value] of pairs) {
    if (omit.includes(flag)) continue;
    args.push(flag, Object.hasOwn(set, flag) ? set[flag] : value);
  }
  return [...args, ...extra];
}

const collector = () => {
  const chunks = [];
  return { write(chunk) { chunks.push(String(chunk)); return true; }, text: () => chunks.join(""), lines: () => chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
};

// ------------------------------------------------------------------ spies (in-process, armed around one run)

const toBytes = (data, encoding) => {
  if (typeof data === "string") return Buffer.from(data, encoding ?? "utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
};
const describePath = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return `fd:${value}`;
  if (value && typeof value.href === "string") return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return String(value);
};

/** Patches the public fs, crypto and child_process functions for the duration of one run and syncs the ESM views. Reads are not recorded. */
function installSpies(preimages) {
  const originals = [];
  const log = { hashUpdates: 0, matches: [], contentWrites: [], metaEvents: [], spawns: [] };
  const patch = (object, key, replacement) => {
    originals.push([object, key, object[key]]);
    object[key] = replacement;
  };
  const record = (bytes, how) => {
    log.hashUpdates += 1;
    if (preimages.some((preimage) => preimage.equals(bytes))) log.matches.push({ how, length: bytes.length });
  };
  const wrapHash = (original) => function wrappedHash(...args) {
    const hash = original.apply(this, args);
    const chunks = [];
    const update = hash.update;
    hash.update = function wrappedUpdate(data, encoding) {
      const bytes = toBytes(data, encoding);
      chunks.push(bytes);
      record(bytes, "update");
      return update.call(this, data, encoding);
    };
    const digest = hash.digest;
    hash.digest = function wrappedDigest(...digestArgs) {
      if (chunks.length > 1) record(Buffer.concat(chunks), "accumulated");
      return digest.apply(this, digestArgs);
    };
    return hash;
  };
  patch(crypto, "createHash", wrapHash(crypto.createHash));
  patch(crypto, "createHmac", wrapHash(crypto.createHmac));
  if (typeof crypto.hash === "function") {
    const original = crypto.hash;
    patch(crypto, "hash", function wrappedOneShot(algorithm, data, ...rest) {
      record(toBytes(data), "hash");
      return original.call(this, algorithm, data, ...rest);
    });
  }
  const subtle = crypto.webcrypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const original = subtle.digest;
    patch(subtle, "digest", function wrappedDigest(algorithm, data) {
      record(toBytes(data), "subtle");
      return original.call(this, algorithm, data);
    });
  }
  const contentNames = ["writeFile", "appendFile", "copyFile", "cp", "rename", "truncate", "symlink", "link"];
  const metaNames = ["mkdir", "mkdtemp", "rm", "rmdir", "unlink", "chmod", "chown", "utimes", "lutimes", "lchown"];
  const twoPath = new Set(["copyFile", "cp", "rename", "symlink", "link"]);
  const wrapFs = (target, key, kind, label) => {
    const original = target[key];
    if (typeof original !== "function") return;
    patch(target, key, function wrappedFs(...args) {
      const event = { api: `${label}.${key}`, target: describePath(args[0]), target2: twoPath.has(key.replace(/Sync$/u, "")) ? describePath(args[1]) : null };
      (kind === "content" ? log.contentWrites : log.metaEvents).push(event);
      return original.apply(this, args);
    });
  };
  for (const name of contentNames) {
    wrapFs(fsp, name, "content", "fs.promises");
    wrapFs(fs, name, "content", "fs");
    wrapFs(fs, `${name}Sync`, "content", "fs");
  }
  for (const name of metaNames) {
    wrapFs(fsp, name, "meta", "fs.promises");
    wrapFs(fs, name, "meta", "fs");
    wrapFs(fs, `${name}Sync`, "meta", "fs");
  }
  wrapFs(fs, "createWriteStream", "content", "fs");
  for (const [target, key, label] of [[fsp, "open", "fs.promises"], [fs, "open", "fs"], [fs, "openSync", "fs"]]) {
    const original = target[key];
    patch(target, key, function wrappedOpen(...args) {
      const flags = typeof args[1] === "string" ? args[1] : "r";
      if (/[wa+]/u.test(flags)) log.contentWrites.push({ api: `${label}.${key}`, target: describePath(args[0]), target2: null });
      return original.apply(this, args);
    });
  }
  for (const key of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[key];
    patch(childProcess, key, function wrappedSpawn(...args) {
      log.spawns.push({ api: key, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
      return original.apply(this, args);
    });
  }
  syncBuiltinESMExports();
  return {
    log,
    restore() {
      for (const [object, key, original] of originals.reverse()) object[key] = original;
      syncBuiltinESMExports();
    },
  };
}

// ------------------------------------------------------------------ run harness

async function runLive(world, args, options = {}) {
  const stdout = collector();
  const stderr = collector();
  const clock = { now: options.startMs ?? START_MS };
  const sleeps = [];
  const deps = {
    stdout,
    stderr,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      if (options.onSleep) options.onSleep(sleeps.length);
    },
    ...(options.driver ? { fnPathKeepaliveDriver: options.driver } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.serveHost ? { serveHost: options.serveHost } : {}),
  };
  const previousPath = process.env.PATH;
  const sealedPath = `${world.paths.bin}${path.delimiter}${previousPath}`;
  process.env.PATH = sealedPath;
  const spies = options.spies ? installSpies(world.preimages) : null;
  try {
    const result = await (options.module ?? live).runCccPlanningLiveProof(args, deps);
    return { result, stdoutLines: stdout.lines(), stderrLines: stderr.lines(), sleeps, spies: spies ? spies.log : null, sealedPath };
  } finally {
    if (spies) spies.restore();
    process.env.PATH = previousPath;
  }
}

async function assertNothingStarted(world, run) {
  assert.deepEqual(run.stdoutLines, [], "an early refusal prints nothing on stdout");
  assert.equal(run.stderrLines.length, 1, "and exactly one refusal line on stderr");
  assert.equal(run.stderrLines[0].schema, "ccc-planning.proof-refusal.v1");
  assert.equal(run.stderrLines[0].passed, false);
  assert.deepEqual((await world.hostState()).calls, [], "no Pueue, lsof or pgrep call");
  assert.deepEqual(await world.fnCalls(), [], "no fn was spawned, not even for a version probe");
  if (run.spies) {
    assert.deepEqual(run.spies.spawns, [], "the child_process spy saw no spawn");
    assert.deepEqual(run.spies.contentWrites, [], "the file-system spy saw no write");
  }
}

// ------------------------------------------------------------------ mutants

const mutantDir = path.join(tmpdir(), `ccc-lv-mutants-${process.pid}-${Date.now()}`);

function replaceOnce(text, anchor, replacement) {
  const first = text.indexOf(anchor);
  assert.ok(first !== -1, `mutation anchor not found (the script was reformatted?): ${anchor}`);
  assert.equal(text.indexOf(anchor, first + 1), -1, `mutation anchor is not unique: ${anchor}`);
  return text.replace(anchor, () => replacement);
}

/** Copy a real script with one edit and import it. Relative imports are rewritten to the real files, so the mutant shares IP's module instances. */
async function loadMutant(name, scriptPath, mutate) {
  const original = await readFile(scriptPath, "utf8");
  const scriptsUrl = pathToFileURL(path.join(repoRoot, "scripts")).href;
  const rewritten = original.replaceAll('from "./lib/', `from "${scriptsUrl}/lib/`).replaceAll('from "./ccc-planning-live-proof.mjs"', `from "${scriptsUrl}/ccc-planning-live-proof.mjs"`);
  const mutated = mutate(rewritten);
  assert.notEqual(mutated, rewritten, `mutation ${name} changed nothing`);
  await mkdir(mutantDir, { recursive: true });
  const file = path.join(mutantDir, `${name}.mjs`);
  await writeFile(file, mutated);
  return import(`${pathToFileURL(file).href}?mutant=${name}`);
}

/** The property must hold for the real script and must fail for the mutant. */
async function assertKillsMutant(property, mutant, real = live) {
  await property(real);
  let failure = null;
  try {
    await property(mutant);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null, "the mutant must fail the property that the real script passes");
  assert.equal(failure.code, "ERR_ASSERTION", `the mutant must fail on an assertion about behaviour, not crash: ${failure.stack}`);
}

// ------------------------------------------------------------------ properties shared by the tests and the mutants

const propertyRefusesMissingDigest = async (module) => {
  const world = await sharedWorld();
  await world.prepare();
  const run = await runLive(world, liveArgs(world, { omit: ["--confirm-authority"] }), { module, spies: true });
  assert.equal(run.result.exitCode, 1);
  assert.ok(run.result.refusal, "an early refusal, not a run");
  assert.equal(run.result.refusal.code, "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED");
  await assertNothingStarted(world, run);
};

const propertyTypedBytesReachFn = async (module) => {
  const world = await sharedWorld();
  const typed = " AbC 123\té ";
  await world.prepare();
  const run = await runLive(world, liveArgs(world, { set: { "--confirm-authority": typed } }), { module });
  assert.equal(run.result.exitCode, 1);
  const start = (await world.fnCalls()).find((call) => call.argv[0] === "plan" && call.argv[1] === "start");
  assert.ok(start, "fn plan start was called");
  assert.equal(start.argv.filter((arg) => arg === "--confirm-authority").length, 1);
  assert.equal(start.argv[start.argv.indexOf("--confirm-authority") + 1], typed, "the exact typed bytes");
  assert.equal(run.result.report.code, "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED");
};

const propertyNeverHashesOrWritesReceipt = async (module) => {
  const world = await sharedWorld();
  await world.prepare();
  const run = await runLive(world, liveArgs(world), { module, spies: true });
  assert.ok(run.spies.hashUpdates > 0, "the spy saw the real dist and executable hashing, so it is not idle");
  assert.deepEqual(run.spies.matches, [], "no hash input equals the authority receipt bytes or its digest preimage");
  assert.deepEqual(run.spies.contentWrites.map((event) => event.target), [world.paths.report], "the report is the only file written");
  const touched = [...run.spies.contentWrites, ...run.spies.metaEvents].filter((event) => [event.target, event.target2].some((target) => target && path.resolve(target).startsWith(`${world.paths.authorityDir}${path.sep}`)));
  assert.deepEqual(touched, [], "nothing under the authority directory was touched");
  assert.deepEqual(await readFile(world.paths.approval), world.receiptBytes, "the receipt bytes are unchanged");
  assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.report?.code));
};

const propertyProfileAdaptiveRefused = async (module) => {
  const world = await sharedWorld();
  for (const profile of ["adaptive", "lean"]) {
    for (const omit of [[], ["--confirm-authority"]]) {
      await world.prepare();
      const label = `${profile}${omit.length === 0 ? "" : " without a digest"}`;
      const run = await runLive(world, liveArgs(world, { set: { "--profile": profile }, omit }), { module, spies: true });
      assert.equal(run.result.exitCode, 1, label);
      assert.ok(run.result.refusal, `${label}: an early refusal, not a run`);
      assert.equal(run.result.refusal.code, "CCC_PLANNING_PROFILE_NOT_IMPLEMENTED", label);
      await assertNothingStarted(world, run);
    }
  }
};

const propertyDriftRefusedBeforeServe = async (module) => {
  const world = await sharedWorld("drift");
  await world.prepare();
  const original = await readFile(path.join(world.paths.installedRoot, "dist/bin.js"), "utf8");
  await writeFile(path.join(world.paths.installedRoot, "dist/bin.js"), original.replace("bin A", "bin B"));
  try {
    const run = await runLive(world, liveArgs(world), { module, spies: true });
    assert.equal(run.result.exitCode, 1);
    assert.ok(run.result.refusal, "an early refusal, not a run");
    assert.equal(run.result.refusal.code, "CCC_PLANNING_INSTALLED_RUNTIME_INVALID");
    assert.equal(run.result.refusal.field, "distManifestSha256");
    assert.ok(run.spies.hashUpdates > 0, "the dist digest was recomputed for real");
    assert.deepEqual(run.spies.matches, [], "and the narrowed hash spy allows that recomputation");
    assert.deepEqual((await world.hostState()).calls, [], "serve was never started");
    assert.equal((await world.fnCalls()).filter((call) => call.argv[1] === "start").length, 0, "fn plan start was never called");
  } finally {
    await writeFile(path.join(world.paths.installedRoot, "dist/bin.js"), original);
  }
};

const propertyServeStoppedWhenFinished = async (module) => {
  const world = await sharedWorld();
  await world.prepare();
  const run = await runLive(world, liveArgs(world), { module });
  assert.equal(run.result.exitCode, 0);
  assert.equal((await world.hostState()).killed.length, 1, "the serve task is killed once");
  assert.equal(run.result.report.serve.stopped, true);
};

const propertyKeepaliveArmJudgedByScript = async (module) => {
  const world = await sharedWorld();
  await world.prepare();
  const degenerate = async () => ({
    customProvider: "omniroute-fixture", defaultProvider: "omniroute-fixture", receiptAdapterId: "terminal-route-sse-comments.v1",
    placeholderModel: "same-model", expectedModel: "same-model", observedModel: "same-model", status: "passed",
  });
  const run = await runLive(world, liveArgs(world), { module, driver: degenerate });
  assert.equal(run.result.exitCode, 1);
  assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_KEEPALIVE_ARM_FAILED");
  assert.equal(run.result.report.keepaliveArm.status, "failed");
};

const propertyReportListsNotEnforced = async (module) => {
  const world = await sharedWorld();
  await world.prepare();
  const run = await runLive(world, liveArgs(world), { module });
  assert.ok(Array.isArray(run.result.report.notEnforced), "the report carries a notEnforced list");
  assert.deepEqual(run.result.report.notEnforced.map((item) => item.id), NOT_ENFORCED_IDS);
};

// ------------------------------------------------------------------ live: refusals before anything is spawned

describe("live proof refusals before any spawn", () => {
  test("without --confirm-authority exits 1 with CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED before any spawn, write or Pueue call; the twin with a typed digest runs", async () => {
    await propertyRefusesMissingDigest(live);
    const world = await sharedWorld();
    await world.prepare();
    const twin = await runLive(world, liveArgs(world), { spies: true });
    assert.equal(twin.result.exitCode, 0, "the same arguments with the digest run to accepted");
    assert.ok(twin.spies.spawns.length > 0, "and the spawn spy is not blind");
  });

  test("a flag with no value, an empty value, an empty = value, a flag followed by another flag and no arguments at all are all a missing digest", async () => {
    const world = await sharedWorld();
    const base = liveArgs(world, { omit: ["--confirm-authority"] });
    const variants = [
      [],
      ["--profile", "full"],
      [...base, "--confirm-authority"],
      [...base, "--confirm-authority", ""],
      [...base, "--confirm-authority="],
      ["--profile", "full", "--candidate", world.paths.candidate, "--approval-receipt", world.paths.approval, "--confirm-authority", "--project", PROJECT_ID, "--database-url", DATABASE_URL],
    ];
    for (const args of variants) {
      await world.prepare();
      const run = await runLive(world, args, { spies: true });
      assert.equal(run.result.exitCode, 1, JSON.stringify(args));
      assert.equal(run.result.refusal.code, "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED", JSON.stringify(args));
      await assertNothingStarted(world, run);
    }
  });

  test("--profile adaptive and --profile lean exit 1 with CCC_PLANNING_PROFILE_NOT_IMPLEMENTED before any spawn, with or without a digest; full runs; a missing or unknown profile is a usage error", async () => {
    await propertyProfileAdaptiveRefused(live);
    const world = await sharedWorld();
    for (const args of [liveArgs(world, { omit: ["--profile"] }), liveArgs(world, { set: { "--profile": "bogus" } })]) {
      await world.prepare();
      const run = await runLive(world, args, { spies: true });
      assert.equal(run.result.exitCode, 2);
      assert.equal(run.result.refusal.code, "CCC_PLANNING_PROOF_USAGE");
      await assertNothingStarted(world, run);
    }
    await world.prepare();
    assert.equal((await runLive(world, liveArgs(world))).result.exitCode, 0, "--profile full runs");
  });

  test("usage errors exit 2: unknown flag, duplicate flag, stray argument, missing required value, a candidate outside <ROOT>/evidence; one leading -- is dropped", async () => {
    const world = await sharedWorld();
    const cases = [
      liveArgs(world, { extra: ["--surprise", "1"] }),
      liveArgs(world, { extra: ["--project", PROJECT_ID] }),
      liveArgs(world, { extra: ["stray"] }),
      liveArgs(world, { omit: ["--database-url"] }),
      liveArgs(world, { omit: ["--project"] }),
      liveArgs(world, { omit: ["--candidate"] }),
      liveArgs(world, { set: { "--project": "" } }),
      liveArgs(world, { set: { "--candidate": path.join(world.paths.root, "elsewhere/installed-runtime.json") } }),
    ];
    for (const args of cases) {
      await world.prepare();
      const run = await runLive(world, args, { spies: true });
      assert.equal(run.result.exitCode, 2, JSON.stringify(args));
      assert.equal(run.result.refusal.code, "CCC_PLANNING_PROOF_USAGE", JSON.stringify(args));
      await assertNothingStarted(world, run);
    }
    await world.prepare();
    const dropped = await runLive(world, ["--", ...liveArgs(world)]);
    assert.equal(dropped.result.exitCode, 0, "one leading -- is dropped, so the twin runs");
  });

  test("a candidate with a one-byte dist drift is refused by a real recomputation that the narrowed hash spy allows; the untouched twin verifies", async () => {
    await propertyDriftRefusedBeforeServe(live);
    const world = await sharedWorld("drift");
    await world.prepare();
    const twin = await runLive(world, liveArgs(world), { spies: true });
    assert.equal(twin.result.exitCode, 0, "the same candidate, untouched, runs");
    assert.ok(twin.spies.hashUpdates > 0 && twin.spies.matches.length === 0);
  });

  test("a candidate whose keepaliveModelSource is not fusion-receipt-adapter is refused; the untouched twin verifies", async () => {
    const world = await sharedWorld("source");
    await world.prepare();
    const receipt = JSON.parse(world.candidateText);
    receipt.piAi.keepaliveModelSource = "pi-ai-workspace-patch";
    await writeFile(world.paths.candidate, `${JSON.stringify(receipt, null, 2)}\n`);
    const refused = await runLive(world, liveArgs(world), { spies: true });
    assert.equal(refused.result.exitCode, 1);
    assert.equal(refused.result.refusal.code, "CCC_PLANNING_INSTALLED_RUNTIME_INVALID");
    assert.equal(refused.result.refusal.field, "piAi.keepaliveModelSource");
    assert.deepEqual(refused.spies.spawns, []);
    assert.deepEqual((await world.hostState()).calls, []);
    await world.prepare();
    assert.equal((await runLive(world, liveArgs(world))).result.exitCode, 0, "the untouched receipt runs");
  });

  test("refuses when the approval receipt, the request or the target is missing, or a report already exists, before any serve call; the twin runs", async () => {
    const world = await sharedWorld();
    const hide = async (file, body) => {
      await rename(file, `${file}.hidden`);
      try {
        await body();
      } finally {
        await rename(`${file}.hidden`, file);
      }
    };
    for (const [file, label] of [[world.paths.approval, "authority receipt"], [world.paths.request, "sealed request"], [world.paths.target, "disposable target"]]) {
      await world.prepare();
      await hide(file, async () => {
        const run = await runLive(world, liveArgs(world));
        assert.equal(run.result.exitCode, 1, label);
        assert.equal(run.result.refusal.code, "CCC_PLANNING_LIVE_INPUT_MISSING", label);
        assert.match(run.result.refusal.detail, new RegExp(label, "u"));
        assert.deepEqual((await world.hostState()).calls, [], `${label}: serve was not started`);
        assert.equal((await world.fnCalls()).filter((call) => call.argv[0] === "plan").length, 0);
      });
    }
    await world.prepare();
    await writeFile(world.paths.report, "{}\n");
    const existing = await runLive(world, liveArgs(world));
    assert.equal(existing.result.exitCode, 1);
    assert.equal(existing.result.refusal.code, "CCC_PLANNING_LIVE_INPUT_MISSING");
    assert.match(existing.result.refusal.detail, /already exists/u);
    await world.prepare();
    assert.equal((await runLive(world, liveArgs(world))).result.exitCode, 0, "with everything present it runs");
  });

  test("a serve lane refusal is reported with the lane's code before fn plan start is ever called; the lane stops its own task", async () => {
    const world = await sharedWorld();
    for (const [log, code] of [[AUTO_REGISTERED_LOG, "CCC_PLANNING_SERVE_AUTO_REGISTERED"], [FORBIDDEN_PORT_LOG, "CCC_PLANNING_SERVE_PORT_FORBIDDEN"]]) {
      await world.prepare({ host: { log } });
      const run = await runLive(world, liveArgs(world));
      assert.equal(run.result.exitCode, 1, code);
      assert.equal(run.result.report.code, code);
      assert.equal(run.result.report.serve, null, "no lane was handed back");
      assert.equal((await world.fnCalls()).filter((call) => call.argv[1] === "start").length, 0, "fn plan start never ran");
      assert.equal((await world.hostState()).killed.length, 1, "the lane killed its own task once");
    }
    await world.prepare();
    assert.equal((await runLive(world, liveArgs(world))).result.exitCode, 0, "the clean log runs");
  });

  test("a database url that is shared or carries a password is refused before anything starts, through the serve lane's own builder", async () => {
    const world = await sharedWorld();
    for (const url of ["postgresql://postgres@127.0.0.1:5432/fusion", "postgresql://postgres:secret@127.0.0.1:55432/fusion", "postgresql://postgres@db.example.com:55432/fusion"]) {
      await world.prepare();
      const run = await runLive(world, liveArgs(world, { set: { "--database-url": url } }));
      assert.equal(run.result.exitCode, 1, url);
      assert.equal(run.result.refusal.code, "CCC_PLANNING_SERVE_LAUNCH_INVALID", url);
      assert.deepEqual((await world.hostState()).calls, [], url);
      assert.equal((await world.fnCalls()).filter((call) => call.argv[0] === "plan").length, 0);
    }
  });
});

// ------------------------------------------------------------------ live: the typed digest

describe("live proof typed digest", () => {
  test("a wrong digest reaches fn plan start byte for byte, the downstream UNCONFIRMED refusal is reported unchanged, and serve is stopped", async () => {
    const world = await sharedWorld();
    const wrong = `${"0".repeat(63)}1`;
    assert.notEqual(wrong, world.typedDigest);
    await world.prepare();
    const run = await runLive(world, liveArgs(world, { set: { "--confirm-authority": wrong } }), { spies: true });
    assert.equal(run.result.exitCode, 1);
    const calls = await world.fnCalls();
    const start = calls.find((call) => call.argv[0] === "plan" && call.argv[1] === "start");
    assert.deepEqual(start.argv, [
      "plan", "start", "--project", PROJECT_ID, "--request-file", world.paths.request, "--mode", "build", "--budget-profile", "standard",
      "--authority-receipt", world.paths.approval, "--confirm-authority", wrong, "--json",
    ], "the argv spy: the exact typed bytes in the contract's order");
    const downstream = { schema: "ccc-planning.cli.v1", kind: "refusal", code: "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED", detail: UNCONFIRMED_DETAIL };
    const report = run.result.report;
    assert.equal(report.passed, false);
    assert.equal(report.code, downstream.code, "the downstream code, unchanged");
    assert.equal(report.detail, downstream.detail);
    assert.equal(report.source, "fn plan start");
    assert.deepEqual(report.refusal, downstream, "the downstream line, verbatim");
    assert.deepEqual(report.planStart, { exitCode: 1, lines: [downstream] });
    assert.deepEqual(run.stdoutLines, [JSON.parse(JSON.stringify(report))], "stdout carries the same report");
    assert.equal(calls.filter((call) => call.argv[1] === "status").length, 0, "no status poll after a refusal");
    assert.equal((await world.hostState()).killed.length, 1, "serve is stopped");
    assert.equal(report.serve.stopped, true);
    assert.deepEqual(run.spies.matches, []);
    assert.deepEqual(await readFile(world.paths.report, "utf8"), `${JSON.stringify(report)}\n`, "the report file holds the same report");
  });

  test("awkward typed bytes (case, spaces, a tab, non-ASCII) reach fn unchanged, so nothing trims, folds or validates them", async () => {
    await propertyTypedBytesReachFn(live);
  });

  test("positive control: a correct receipt and digest pass through to the fake fn, which returns run_admitted, and the run is polled to accepted with serve stopped", async () => {
    const world = await sharedWorld();
    await world.prepare({ fn: { statusStates: ["running", "building", "building", "accepted"], stateCodes: { building: "CCC_PLANNING_FIXTURE_BUILDING" } } });
    const previous = { key: process.env.OMNIROUTE_API_KEY, port: process.env.PORT };
    process.env.OMNIROUTE_API_KEY = "canary-lv-credential";
    process.env.PORT = "4999";
    let run;
    try {
      run = await runLive(world, liveArgs(world), { spies: true });
    } finally {
      if (previous.key === undefined) delete process.env.OMNIROUTE_API_KEY;
      else process.env.OMNIROUTE_API_KEY = previous.key;
      if (previous.port === undefined) delete process.env.PORT;
      else process.env.PORT = previous.port;
    }
    assert.equal(run.result.exitCode, 0);
    const report = run.result.report;
    assert.equal(report.schema, "ccc-planning.live-proof-report.v1");
    assert.equal(report.passed, true);
    assert.equal(report.profile, "full");
    assert.equal(report.planStart.exitCode, 0);
    assert.equal(report.planStart.lines[0].kind, "run_admitted");
    assert.equal(report.planStart.lines[0].plannedPlanningNodes, 14);
    assert.equal(report.run.runId, RUN_ID);
    assert.equal(report.run.polls, 4);
    assert.deepEqual(report.run.transitions.map((entry) => entry.state), ["running", "building", "accepted"]);
    assert.equal(report.run.transitions[1].stateCode, "CCC_PLANNING_FIXTURE_BUILDING");
    assert.equal(report.run.finalState, "accepted");
    assert.equal(report.run.stoppedBecause, "resting");
    assert.deepEqual(run.sleeps, [60_000, 60_000, 60_000], "polled every 60 s, with an injected timer and never a shell sleep");
    assert.deepEqual(run.stdoutLines, [JSON.parse(JSON.stringify(report))]);
    const progress = run.stderrLines.filter((line) => line.schema === "ccc-planning.live-proof-progress.v1").map((line) => line.event);
    assert.deepEqual(progress, ["keepalive-arm", "serve-started", "run-admitted", "state", "state", "state"]);

    const calls = await world.fnCalls();
    const plan = calls.filter((call) => call.argv[0] === "plan");
    assert.deepEqual(plan.map((call) => call.argv.slice(0, 2).join(" ")), ["plan start", "plan status", "plan status", "plan status", "plan status"]);
    assert.deepEqual(plan[1].argv, ["plan", "status", RUN_ID, "--json"], "no --project: it is resolved from the run row");
    for (const call of plan) {
      assert.equal(call.cwd, world.paths.target, "run from the target");
      assert.equal(call.env.HOME, world.paths.home);
      assert.equal(call.env.FUSION_HOME, path.join(world.paths.home, ".fusion"));
      assert.equal(call.env.DATABASE_URL, DATABASE_URL);
      assert.equal(call.env.TMPDIR, world.paths.tmp);
      assert.equal(call.env.PI_OFFLINE, "1");
      assert.equal(call.env.OMNIROUTE_API_KEY, null, "no credential reaches the installed fn");
      assert.equal(call.env.PORT, null);
    }
    const host = await world.hostState();
    const expectedLaunch = buildCccPlanningServeLaunch({
      executablePath: world.paths.fn, targetDir: world.paths.target, home: world.paths.home, databaseUrl: DATABASE_URL, projectId: PROJECT_ID,
      pathEnv: run.sealedPath, tmpDir: world.paths.tmp, group: "ccc-r2c-i2", label: "ccc-planning-i2-serve",
    });
    assert.deepEqual(host.added, [expectedLaunch.argv.slice(1)], "serve is launched by IP's builder with the installed fn, the target and the owned database");
    assert.deepEqual(host.killed, [["kill", "41"]], "only that task id is killed, once");
    assert.equal(report.serve.pueueTaskId, 41);
    assert.equal(report.serve.port, 55123);
    assert.equal(report.serve.stopped, true);
    assert.equal(report.serve.leftRunning, false);
    assert.equal(report.keepaliveArm.status, "not_run");
    assert.equal(report.step0.status, "parent_run");
    assert.equal(report.step0.command, "PI_OFFLINE=1 node --test scripts/__tests__/ccc-planning-installed-keepalive.test.mjs");
    assert.equal(report.candidate.distManifestSha256, world.receipt.distManifestSha256);
    assert.equal(report.candidate.piAi.keepaliveModelSource, "fusion-receipt-adapter");
    assert.equal(report.reportPath, world.paths.report);
    assert.ok(!JSON.stringify(report).includes(world.typedDigest), "the report never records the typed digest");
  });
});

// ------------------------------------------------------------------ live: authority receipt custody

describe("live proof authority receipt custody", () => {
  test("never writes, confirms or hashes an authority receipt: only the report is written, the receipt bytes are unchanged, and the narrowed hash spy sees real hashing but no match", async () => {
    await propertyNeverHashesOrWritesReceipt(live);
  });

  test("the hash and file-system spies have teeth: they match the receipt bytes, its digest preimage and a chunked hash of it, record writes, and ignore other hashing", async () => {
    const world = await sharedWorld();
    const spies = installSpies(world.preimages);
    const probe = path.join(world.paths.authorityDir, "spy-probe.txt");
    try {
      createHash("sha256").update(world.receiptBytes).digest("hex");
      assert.equal(spies.log.matches.length, 1, "the receipt file bytes");
      createHash("sha256").update(world.preimages[2]).digest("hex");
      assert.equal(spies.log.matches.length, 2, "the digest preimage (body without operatorConfirmation)");
      const half = Math.floor(world.receiptBytes.length / 2);
      createHash("sha256").update(world.receiptBytes.subarray(0, half)).update(world.receiptBytes.subarray(half)).digest("hex");
      assert.equal(spies.log.matches.length, 3, "a chunked hash whose pieces add up to the receipt");
      const before = spies.log.hashUpdates;
      createHash("sha256").update("unrelated bytes").digest("hex");
      crypto.hash("sha256", "other unrelated bytes");
      assert.equal(spies.log.hashUpdates, before + 2, "other hashing is counted");
      assert.equal(spies.log.matches.length, 3, "and is not a match");
      await writeFile(probe, "probe\n");
      assert.deepEqual(spies.log.contentWrites.map((event) => event.target), [probe], "a write through fs.promises is recorded");
      spawnSync(process.execPath, ["-e", "0"]);
      assert.equal(spies.log.spawns.length, 1, "a spawn is recorded");
    } finally {
      spies.restore();
      await rm(probe, { force: true });
    }
    const after = installSpies(world.preimages);
    after.restore();
    createHash("sha256").update(world.receiptBytes).digest("hex");
    assert.equal(after.log.matches.length, 0, "restored: nothing is recorded any more");
  });

  test("mutants: a script that helpfully hashes the receipt (file bytes or digest preimage) to fill in the digest, and one that rewrites the receipt, fail the custody property", async () => {
    const hashFile = await loadMutant("hash-file", LIVE_SCRIPT, (text) => replaceOnce(
      text,
      'const typedDigest = values.get("--confirm-authority");',
      `let typedDigest = values.get("--confirm-authority");
  {
    const { createHash } = await import("node:crypto");
    const computed = createHash("sha256").update(await readFile(path.resolve(values.get("--approval-receipt")))).digest("hex");
    if (typeof typedDigest !== "string" || typedDigest === "" || typedDigest !== computed) typedDigest = computed;
  }`,
    ));
    await assertKillsMutant(propertyNeverHashesOrWritesReceipt, hashFile);
    const hashPreimage = await loadMutant("hash-preimage", LIVE_SCRIPT, (text) => replaceOnce(
      text,
      'const typedDigest = values.get("--confirm-authority");',
      `let typedDigest = values.get("--confirm-authority");
  {
    const { createHash } = await import("node:crypto");
    const sort = (value) => (Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value);
    const body = JSON.parse(await readFile(path.resolve(values.get("--approval-receipt")), "utf8"));
    delete body.operatorConfirmation;
    typedDigest = createHash("sha256").update(JSON.stringify(sort(body))).digest("hex");
  }`,
    ));
    await assertKillsMutant(propertyNeverHashesOrWritesReceipt, hashPreimage);
    const rewrite = await loadMutant("rewrite-receipt", LIVE_SCRIPT, (text) => replaceOnce(
      text,
      "const candidate = verified.receipt;",
      'const candidate = verified.receipt;\n  await writeFile(approvalPath, "{}\\n");',
    ));
    await assertKillsMutant(propertyNeverHashesOrWritesReceipt, rewrite);
    await assert.rejects(() => propertyRefusesMissingDigest(hashFile), { code: "ERR_ASSERTION" }, "the hashing mutant also no longer refuses a missing digest");
  });

  test("mutants: a script that trims and folds the typed digest fails the byte-for-byte property, and one that spawns before it checks the digest fails the missing-digest property", async () => {
    const fold = await loadMutant("fold-digest", LIVE_SCRIPT, (text) => replaceOnce(text, '"--confirm-authority", context.typedDigest,', '"--confirm-authority", context.typedDigest.trim().toLowerCase(),'));
    await assertKillsMutant(propertyTypedBytesReachFn, fold);
    const early = await loadMutant("spawn-before-digest", LIVE_SCRIPT, (text) => replaceOnce(
      text,
      'const typedDigest = values.get("--confirm-authority");',
      'await verifyCccPlanningCandidate(path.resolve(values.get("--candidate") ?? ""));\n  const typedDigest = values.get("--confirm-authority");',
    ));
    await assertKillsMutant(propertyRefusesMissingDigest, early);
  });
});

// ------------------------------------------------------------------ live: profile and candidate mutants

describe("live proof mutants for the profile, the candidate and teardown", () => {
  test("a script that accepts adaptive, one that skips candidate verification and one that never stops serve each fail their property", async () => {
    const adaptive = await loadMutant("accept-adaptive", LIVE_SCRIPT, (text) => replaceOnce(text, 'if (typeof profile === "string" && profile !== "full" && PROFILES.includes(profile)) {', "if (false) {"));
    await assertKillsMutant(propertyProfileAdaptiveRefused, adaptive);
    const skipVerify = await loadMutant("skip-verify", LIVE_SCRIPT, (text) => replaceOnce(
      text,
      "const verified = await verifyCccPlanningCandidate(candidatePath);",
      'const verified = { ok: true, receipt: JSON.parse(await readFile(candidatePath, "utf8")) };',
    ));
    await assertKillsMutant(propertyDriftRefusedBeforeServe, skipVerify);
    const noTeardown = await loadMutant("no-teardown", LIVE_SCRIPT, (text) => replaceOnce(text, "if (leaveServeRunning) {", "if (true) {"));
    await assertKillsMutant(propertyServeStoppedWhenFinished, noTeardown);
  });
});

// ------------------------------------------------------------------ live: sequence, poll and teardown

describe("live proof sequence poll and teardown", () => {
  test("stops polling on every operator-wait state and leaves serve running; the report says so and names the Pueue task", async () => {
    const world = await sharedWorld();
    const expectedWaitStates = ["awaiting_intent", "awaiting_budget", "awaiting_execution_authority", "paused", "blocked_prerequisite", "blocked_provider", "budget_exhausted", "unknown_effect"];
    assert.deepEqual([...live.CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES].sort(), [...expectedWaitStates].sort(), "the loop below is not empty");
    for (const state of live.CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES) {
      await world.prepare({ fn: { statusStates: [state] } });
      const run = await runLive(world, liveArgs(world));
      assert.equal(run.result.exitCode, 1, state);
      assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_OPERATOR_WAIT", state);
      assert.equal(run.result.report.run.finalState, state);
      assert.equal(run.result.report.run.stoppedBecause, "operator_wait");
      assert.equal(run.result.report.serve.leftRunning, true, state);
      assert.equal(run.result.report.serve.stopped, false, state);
      assert.equal(run.result.report.serve.pueueTaskId, 41);
      assert.deepEqual((await world.hostState()).killed, [], `${state}: serve is left running for the parent's step 6`);
      assert.deepEqual(run.sleeps, [], "no further poll");
    }
  });

  test("verification_failed and the terminal states fail the proof with CCC_PLANNING_LIVE_RUN_NOT_ACCEPTED and stop serve; accepted is the only pass", async () => {
    const world = await sharedWorld();
    for (const state of ["verification_failed", "cancelled", "failed", "delivered"]) {
      await world.prepare({ fn: { statusStates: [state], stateCodes: { verification_failed: "CCC_PLANNING_CODING_REPAIR_NOT_RUN" } } });
      const run = await runLive(world, liveArgs(world));
      assert.equal(run.result.exitCode, 1, state);
      assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_RUN_NOT_ACCEPTED", state);
      assert.equal(run.result.report.serve.stopped, true);
      assert.equal((await world.hostState()).killed.length, 1);
      if (state === "verification_failed") assert.match(run.result.report.detail, /CCC_PLANNING_CODING_REPAIR_NOT_RUN/u);
    }
    await world.prepare({ fn: { statusStates: ["accepted"] } });
    assert.equal((await runLive(world, liveArgs(world))).result.exitCode, 0);
  });

  test("a poll past the run deadline plus its margin fails with CCC_PLANNING_LIVE_POLL_DEADLINE and stops serve; an unknown state is invalid output", async () => {
    const world = await sharedWorld();
    await world.prepare({ fn: { statusStates: ["building"], deadlineAt: new Date(START_MS + 120_000).toISOString() } });
    const run = await runLive(world, liveArgs(world));
    assert.equal(run.result.exitCode, 1);
    assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_POLL_DEADLINE");
    assert.equal(run.result.report.run.polls, 13, "polled every 60 s until 10 minutes past the 2 minute deadline");
    assert.equal(run.sleeps.length, 12);
    assert.equal((await world.hostState()).killed.length, 1);
    await world.prepare({ fn: { statusStates: ["exploded"] } });
    const garbled = await runLive(world, liveArgs(world));
    assert.equal(garbled.result.report.code, "CCC_PLANNING_LIVE_FN_OUTPUT_INVALID");
    assert.equal((await world.hostState()).killed.length, 1);
  });

  test("an abort while polling stops the poll and serve with CCC_PLANNING_LIVE_ABORTED", async () => {
    const world = await sharedWorld();
    await world.prepare({ fn: { statusStates: ["building"] } });
    const controller = new AbortController();
    const run = await runLive(world, liveArgs(world), { signal: controller.signal, onSleep: (count) => { if (count === 2) controller.abort(); } });
    assert.equal(run.result.exitCode, 1);
    assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_ABORTED");
    assert.equal(run.result.report.run.polls, 2);
    assert.equal((await world.hostState()).killed.length, 1);
  });

  test("fn plan start output that is not exactly one run_admitted line, or that names another node count, fails and stops serve", async () => {
    const world = await sharedWorld();
    const cases = [
      [{ startOutput: "garbage" }, "CCC_PLANNING_LIVE_FN_OUTPUT_INVALID"],
      [{ startOutput: "two_lines" }, "CCC_PLANNING_LIVE_FN_OUTPUT_INVALID"],
      [{ plannedPlanningNodes: 15 }, "CCC_PLANNING_LIVE_PLAN_START_UNEXPECTED"],
    ];
    for (const [fn, code] of cases) {
      await world.prepare({ fn });
      const run = await runLive(world, liveArgs(world));
      assert.equal(run.result.exitCode, 1, JSON.stringify(fn));
      assert.equal(run.result.report.code, code, JSON.stringify(fn));
      assert.equal((await world.hostState()).killed.length, 1, "serve is stopped");
      assert.equal((await world.fnCalls()).filter((call) => call.argv[1] === "status").length, 0, "no poll after a bad start");
    }
  });

  test("a serve task that cannot be stopped cleanly fails the proof with CCC_PLANNING_SERVE_DESCENDANTS_REMAIN and records the teardown error", async () => {
    const world = await sharedWorld();
    await world.prepare({ host: { descendants: ["99"] } });
    const run = await runLive(world, liveArgs(world), { serveHost: { stopTimeoutMs: 300 } });
    assert.equal(run.result.exitCode, 1);
    assert.equal(run.result.report.passed, false);
    assert.equal(run.result.report.code, "CCC_PLANNING_SERVE_DESCENDANTS_REMAIN");
    assert.equal(run.result.report.serve.teardownError.code, "CCC_PLANNING_SERVE_DESCENDANTS_REMAIN");
    assert.equal(run.result.report.run.finalState, "accepted", "the run itself was accepted; the teardown failed");
  });
});

// ------------------------------------------------------------------ live: the fn-path keepalive arm (E9 ruling 4)

describe("live proof fn-path keepalive arm", () => {
  const trueModelDriver = (extra = {}) => async () => ({
    customProvider: "omniroute-fixture",
    defaultProvider: "omniroute-fixture",
    receiptAdapterId: "terminal-route-sse-comments.v1",
    placeholderModel: "keepalive-placeholder-model",
    expectedModel: "upstream/true-model",
    observedModel: "upstream/true-model",
    ...extra,
  });

  test("is reported NOT RUN with the reason when no installed fn command drives it, never passed, and is listed in notRun", async () => {
    const world = await sharedWorld();
    await world.prepare();
    const run = await runLive(world, liveArgs(world));
    const arm = run.result.report.keepaliveArm;
    assert.equal(arm.status, "not_run");
    assert.notEqual(arm.status, "passed");
    assert.match(arm.reason, /no planning session factory \(card SF is not integrated\)/u);
    assert.equal(run.result.report.passed, true, "a declared NOT RUN item does not fail the run");
    const listed = run.result.report.notRun.find((item) => item.id === "fn-path-keepalive-arm");
    assert.ok(listed, "the report lists the arm among its NOT RUN items");
    assert.equal(listed.reason, arm.reason);
    assert.match(listed.detail, /terminal-route-sse-comments\.v1/u);
    const factory = await sharedWorld("factory", { binJs: "// ../engine/src/ccc-planning/session-factory.ts\n" });
    await factory.prepare();
    const bundled = await runLive(factory, liveArgs(factory));
    assert.match(bundled.result.report.keepaliveArm.reason, /carries the planning session factory, but no installed fn command drives/u, "the reason follows the installed bytes");
    assert.equal(bundled.result.report.keepaliveArm.status, "not_run");
  });

  test("a driver that reports the true model passes the arm; it runs before serve starts and before fn plan start, and the arm leaves notRun", async () => {
    const world = await sharedWorld();
    await world.prepare();
    const seen = [];
    const driver = async (input) => {
      seen.push({ input, host: (await world.hostState()).calls.length, plan: (await world.fnCalls()).filter((call) => call.argv[0] === "plan").length });
      return trueModelDriver()();
    };
    const run = await runLive(world, liveArgs(world), { driver });
    assert.equal(run.result.exitCode, 0);
    assert.equal(run.result.report.keepaliveArm.status, "passed");
    assert.equal(run.result.report.keepaliveArm.evidence.observedModel, "upstream/true-model");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].input, { installedRoot: world.paths.installedRoot, executablePath: world.paths.fn, home: world.paths.home });
    assert.equal(seen[0].host, 0, "no Pueue call had happened yet");
    assert.equal(seen[0].plan, 0, "fn plan start had not run yet");
    assert.ok(!run.result.report.notRun.some((item) => item.id === "fn-path-keepalive-arm"));
  });

  test("a driver that reports the placeholder, another provider, another adapter, missing evidence or an error fails the arm before anything starts", async () => {
    const world = await sharedWorld();
    const cases = [
      ["placeholder", trueModelDriver({ observedModel: "keepalive-placeholder-model" }), /placeholder/u],
      ["wrong model", trueModelDriver({ observedModel: "some/other-model" }), /not the true model/u],
      ["custom provider is not defaultProvider", trueModelDriver({ customProvider: "another-provider" }), /not defaultProvider/u],
      ["another adapter", trueModelDriver({ receiptAdapterId: "none" }), /receipt adapter/u],
      ["missing evidence", async () => ({ observedModel: "upstream/true-model" }), /did not report/u],
      ["driver error", async () => { throw new Error("loopback fake could not start"); }, /driver threw/u],
      ["claims a pass with the placeholder", trueModelDriver({ observedModel: "keepalive-placeholder-model", status: "passed", passed: true }), /placeholder/u],
    ];
    for (const [label, driver, reason] of cases) {
      await world.prepare();
      const run = await runLive(world, liveArgs(world), { driver });
      assert.equal(run.result.exitCode, 1, label);
      assert.equal(run.result.report.code, "CCC_PLANNING_LIVE_KEEPALIVE_ARM_FAILED", label);
      assert.equal(run.result.report.keepaliveArm.status, "failed", label);
      assert.match(run.result.report.keepaliveArm.reason, reason, label);
      assert.equal(run.result.report.serve, null, `${label}: serve never started`);
      assert.deepEqual((await world.hostState()).calls, [], label);
      assert.equal((await world.fnCalls()).filter((call) => call.argv[1] === "start").length, 0, label);
    }
  });

  test("a script that trusts the driver instead of judging its observations fails the property", async () => {
    const trusting = await loadMutant("trust-driver", LIVE_SCRIPT, (text) => replaceOnce(text, "if (evidence.observedModel === evidence.placeholderModel) {", "if (false) {"));
    await assertKillsMutant(propertyKeepaliveArmJudgedByScript, trusting);
  });
});

// ------------------------------------------------------------------ live: report

describe("live proof report", () => {
  test("lists notEnforced (D52) and the declared NOT RUN items of section 4.5, on a pass and on a refusal alike; a script that drops notEnforced fails", async () => {
    const world = await sharedWorld();
    await world.prepare();
    const pass = await runLive(world, liveArgs(world));
    await world.prepare();
    const refused = await runLive(world, liveArgs(world, { set: { "--confirm-authority": "f".repeat(64) } }));
    for (const run of [pass, refused]) {
      const report = run.result.report;
      assert.deepEqual(report.notEnforced.map((item) => item.id), NOT_ENFORCED_IDS);
      for (const item of report.notEnforced) assert.ok(typeof item.detail === "string" && item.detail.length > 40, item.id);
      assert.match(report.notEnforced[0].detail, /typed|types/u);
      assert.match(report.notEnforced[0].detail, /any local process can compute/u);
      assert.deepEqual(report.notRun.map((item) => item.id), [...NOT_RUN_IDS, "fn-path-keepalive-arm"]);
      assert.deepEqual(report.authorityConfirmation, { source: "operator-typed", passedThroughUnchanged: true, scriptComputedOrRecordedIt: false });
    }
    const dropped = await loadMutant("drop-not-enforced", LIVE_SCRIPT, (text) => replaceOnce(text, "notEnforced: CCC_PLANNING_NOT_ENFORCED,", ""));
    await assertKillsMutant(propertyReportListsNotEnforced, dropped);
  });

  test("the state sets are pinned to packages/core/src/ccc-planning/types.ts, so a state added there cannot make the poll hang", async () => {
    const source = await readFile(TYPES_TS, "utf8");
    const listOf = (pattern) => {
      const match = pattern.exec(source);
      assert.ok(match, `types.ts no longer matches ${pattern}`);
      return [...match[1].matchAll(/"([a-z_]+)"/gu)].map((entry) => entry[1]);
    };
    const runStates = listOf(/export const CCC_PLANNING_RUN_STATES = \[([^\]]*)\]/u);
    assert.equal(runStates.length, 20);
    assert.deepEqual([...listOf(/export const CCC_PLANNING_TERMINAL_STATES = \[([^\]]*)\]/u)].sort(), [...live.CCC_PLANNING_LIVE_TERMINAL_STATES].sort());
    assert.deepEqual([...listOf(/export const CCC_PLANNING_OPERATOR_WAIT_STATES = \[([^\]]*)\]/u)].sort(), [...live.CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES].sort());
    assert.deepEqual(listOf(/return mode === "spec" \? \["spec_ready"\] : \[([^\]]*)\]/u), [...live.CCC_PLANNING_LIVE_RESTING_STATES], "cccPlanningRestingStates(\"build\")");
    const union = [...live.CCC_PLANNING_LIVE_RESTING_STATES, ...live.CCC_PLANNING_LIVE_TERMINAL_STATES, ...live.CCC_PLANNING_LIVE_OPERATOR_WAIT_STATES, ...live.CCC_PLANNING_LIVE_IN_PROGRESS_STATES];
    assert.equal(new Set(union).size, union.length, "no state is in two sets");
    assert.deepEqual([...union].sort(), [...runStates].sort(), "every run state is in exactly one set");
  });
});

// ------------------------------------------------------------------ installed proof

describe("installed proof", () => {
  async function runInstalled(args) {
    const stdout = collector();
    const stderr = collector();
    const result = await installed.runCccPlanningInstalledProof(args, { stdout, stderr });
    return { result, stdout, stderr };
  }

  test("always exits 1 and lists every NOT RUN item, including the fn-path keepalive arm, with no arguments and with a perfect candidate", async () => {
    const world = await sharedWorld();
    await world.prepare();
    const bare = await runInstalled([]);
    assert.equal(bare.result.exitCode, 1);
    assert.equal(bare.stdout.text(), "", "nothing on stdout");
    const [refusal] = bare.stderr.lines();
    assert.equal(bare.stderr.lines().length, 1, "one JSON line on stderr");
    assert.equal(refusal.schema, "ccc-planning.proof-refusal.v1");
    assert.equal(refusal.command, "verify:ccc-planning-installed");
    assert.equal(refusal.passed, false);
    assert.equal(refusal.code, "CCC_PLANNING_PROOF_NOT_IMPLEMENTED");
    assert.deepEqual(refusal.notRun.map((item) => item.id), INSTALLED_NOT_RUN_IDS);
    assert.match(refusal.notRun[4].detail, /terminal-route-sse-comments\.v1/u);

    const perfect = await runInstalled(["--candidate", world.paths.candidate, "--approval-receipt", world.paths.approval]);
    assert.equal(perfect.result.exitCode, 1, "even a candidate that verifies exits 1 before I6");
    const [verified] = perfect.stderr.lines();
    assert.equal(verified.candidate.distManifestSha256, world.receipt.distManifestSha256, "the verified candidate is summarized");
    assert.deepEqual(verified.notRun.map((item) => item.id), INSTALLED_NOT_RUN_IDS);
    assert.deepEqual(await readFile(world.paths.approval), world.receiptBytes, "the approval receipt is neither read back nor changed");
  });

  test("refuses a drifted candidate and a candidate with another keepalive source, and still lists every NOT RUN item; usage errors exit 2", async () => {
    const world = await sharedWorld("installed-refusals");
    await world.prepare();
    const binJs = path.join(world.paths.installedRoot, "dist/bin.js");
    const original = await readFile(binJs, "utf8");
    await writeFile(binJs, original.replace("bin A", "bin B"));
    try {
      const drifted = await runInstalled(["--candidate", world.paths.candidate]);
      assert.equal(drifted.result.exitCode, 1);
      const [line] = drifted.stderr.lines();
      assert.equal(line.code, "CCC_PLANNING_INSTALLED_RUNTIME_INVALID");
      assert.equal(line.field, "distManifestSha256");
      assert.deepEqual(line.notRun.map((item) => item.id), INSTALLED_NOT_RUN_IDS);
    } finally {
      await writeFile(binJs, original);
    }
    const receipt = JSON.parse(world.candidateText);
    receipt.piAi.keepaliveModelSource = "pi-ai-workspace-patch";
    await writeFile(world.paths.candidate, `${JSON.stringify(receipt, null, 2)}\n`);
    const wrongSource = await runInstalled(["--candidate", world.paths.candidate]);
    const [sourceLine] = wrongSource.stderr.lines();
    assert.equal(sourceLine.field, "piAi.keepaliveModelSource");
    assert.equal(wrongSource.result.exitCode, 1);
    for (const args of [["--surprise"], ["stray"], ["--candidate"]]) {
      const usage = await runInstalled(args);
      assert.equal(usage.result.exitCode, 2, JSON.stringify(args));
      assert.equal(usage.stderr.lines()[0].code, "CCC_PLANNING_PROOF_USAGE");
    }
  });

  test("a script that exits 0 for a verified candidate fails the property that it always exits 1", async () => {
    const property = async (module) => {
      const world = await sharedWorld();
      await world.prepare();
      const stderr = collector();
      const result = await module.runCccPlanningInstalledProof(["--candidate", world.paths.candidate], { stdout: collector(), stderr });
      assert.equal(result.exitCode, 1);
    };
    const mutant = await loadMutant("installed-exit-zero", INSTALLED_SCRIPT, (text) => replaceOnce(text, "return { exitCode: 1, refusal };", "return { exitCode: candidateSummary ? 0 : 1, refusal };"));
    await assertKillsMutant(property, mutant, installed);
  });
});

// ------------------------------------------------------------------ the entry points as child processes

describe("proof script entry points", () => {
  const childEnv = (world) => ({ PATH: `${world.paths.bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, LANG: "C" });
  const runScript = (script, args, world) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: childEnv(world), cwd: world.paths.tmp });

  test("node scripts/ccc-planning-live-proof.mjs runs end to end against the fake fn and fake Pueue: one report on stdout and in the file, progress on stderr, exit 0, serve stopped", async () => {
    const world = await sharedWorld();
    await world.prepare({ fn: { statusStates: ["accepted"] } });
    const result = runScript(LIVE_SCRIPT, liveArgs(world), world);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(result.stdout.trim().split("\n").length, 1, "one JSON line on stdout");
    assert.equal(report.schema, "ccc-planning.live-proof-report.v1");
    assert.equal(report.passed, true);
    assert.equal(report.run.finalState, "accepted");
    assert.deepEqual(JSON.parse(await readFile(world.paths.report, "utf8")), report, "the file holds the same report");
    for (const line of result.stderr.trim().split("\n")) assert.equal(JSON.parse(line).schema, "ccc-planning.live-proof-progress.v1");
    assert.equal((await world.hostState()).killed.length, 1);
  });

  test("the entry point refuses without --confirm-authority (exit 1, nothing on stdout, one refusal line on stderr) and exits 2 on a usage error", async () => {
    const world = await sharedWorld();
    await world.prepare();
    const refused = runScript(LIVE_SCRIPT, liveArgs(world, { omit: ["--confirm-authority"] }), world);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(JSON.parse(refused.stderr.trim()).code, "CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED");
    assert.deepEqual(await world.fnCalls(), []);
    const usage = runScript(LIVE_SCRIPT, ["--bogus"], world);
    assert.equal(usage.status, 2);
    assert.equal(JSON.parse(usage.stderr.trim()).code, "CCC_PLANNING_PROOF_USAGE");
  });

  test("node scripts/ccc-planning-installed-proof.mjs exits 1 with one stderr line, an empty stdout and its NOT RUN list for any arguments", async () => {
    const world = await sharedWorld();
    await world.prepare();
    for (const args of [[], ["--candidate", world.paths.candidate, "--approval-receipt", world.paths.approval]]) {
      const result = runScript(INSTALLED_SCRIPT, args, world);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(result.stdout, "");
      const line = JSON.parse(result.stderr.trim());
      assert.equal(line.code, "CCC_PLANNING_PROOF_NOT_IMPLEMENTED");
      assert.deepEqual(line.notRun.map((item) => item.id), INSTALLED_NOT_RUN_IDS);
    }
  });
});

// ------------------------------------------------------------------ the inventory

describe("proof inventory and the installed keepalive lane", () => {
  test("the installed keepalive lane is parent-run and sits in no inventory card (E9 ruling 2); this file is listed file-closed and name-closed by cards/lv.mjs", async () => {
    const inventory = await import("../lib/ccc-planning-proof-inventory/index.mjs");
    const commands = [...inventory.CCC_PLANNING_TARGETED_COMMANDS, ...inventory.CCC_PLANNING_OFFLINE_COMMANDS];
    for (const command of commands) {
      assert.ok(!command.files.some((file) => file.includes("ccc-planning-installed-keepalive")), `${command.id} lists the installed keepalive lane`);
    }
    const own = "scripts/__tests__/ccc-planning-live-proof.test.mjs";
    const targeted = inventory.CCC_PLANNING_TARGETED_COMMANDS.find((command) => command.id === "lv-live-proof-scripts");
    const offline = inventory.CCC_PLANNING_OFFLINE_COMMANDS.find((command) => command.id === "lv-live-proof-scripts-names");
    assert.deepEqual(targeted?.files, [own]);
    assert.equal(targeted?.closure, "files");
    assert.deepEqual(offline?.files, [own]);
    assert.equal(offline?.closure, "names");
    assert.equal(offline?.needsPostgres, false);
    assert.equal(offline?.platform, "any");
  });
});
