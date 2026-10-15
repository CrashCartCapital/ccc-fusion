/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-18:45:
Card IP (CONTRACT-v3.3 section 3.2, section 2.20, D26, D48, 0.25), offline half of the installed-runtime proof. Nothing here builds, packs or installs the real CLI and nothing touches the network or PostgreSQL: the installed tree is a small fixture, `corepack` and `npm` are fake executables, and the fake `fn` is a Node script. The receipt claims proved here are the ones the live run later relies on:
- the installed `dist` digest changes when one byte of one installed file changes;
- `piAi.workspacePatch` is read from the installed pi-ai file bytes (the `identitySubstantive` marker of patches/@earendil-works__pi-ai@0.81.1.patch), never assumed;
- `piAi.shipping` is derived from the packed manifest and the tsup noExternal rule, never written by hand;
- `piAi.keepaliveModelSource` is required, and the verifier refuses a receipt without it;
- the child environment of an installed `fn` is an allowlist, so credential canaries and PORT never reach it.
Every refusal test has the untouched twin that must pass. The installed-lane half (real pack, real npm install, real pi-ai) lives in ccc-planning-installed-keepalive.test.mjs and is run by the parent.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CCC_INSTALLED_FN_ENV_ALLOWLIST,
  buildInstalledFnEnv,
  packAndInstallFusionCli,
  runInstalledFnJsonCommand,
} from "../lib/ccc-installed-cli.mjs";
import {
  CCC_PI_AI_PATCH_MARKER,
  CCC_PLANNING_INSTALLED_RUNTIME_INVALID,
  CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA,
  captureCccPlanningInstalledRuntimeReceipt,
  classifyCccPiAiWorkspacePatch,
  computeCccInstalledDistManifestSha256,
  deriveCccPiAiShipping,
  parseCccCliNoExternalRules,
  prepareCccPlanningInstalledRuntime,
  verifyCccPlanningInstalledRuntimeReceipt,
} from "../lib/ccc-planning-installed-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/ccc-planning-install-runtime.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const UNPATCHED_COMPLETIONS = [
  "export const stream = () => {};",
  "const chunk = { model: 'keepalive' };",
  "const output = {};",
  "output.responseModel ||= chunk.model;",
  "",
].join("\n");
const PATCHED_COMPLETIONS = `${UNPATCHED_COMPLETIONS}const ${CCC_PI_AI_PATCH_MARKER} = true;\n`;
const ADAPTER_SOURCE = [
  'import { calculateCost } from "@earendil-works/pi-ai";',
  'import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";',
  'export const CCC_TERMINAL_ROUTE_RECEIPT_API = "ccc-terminal-route-receipt.v1";',
  "// parses : x-omniroute-provider= and : x-omniroute-model= trailing comments",
  "export const streamCccTerminalRouteReceipt = () => calculateCost(convertMessages);",
  "",
].join("\n");
const BIN_SOURCE = [
  'import "@earendil-works/pi-ai";',
  'const id = "terminal-route-sse-comments.v1"; const api = "ccc-terminal-route-receipt.v1";',
  "export { id, api };",
  "",
].join("\n");
const FAKE_FN = (planBehaviour) => [
  "#!/usr/bin/env node",
  'const fs = require("fs"); const path = require("path");',
  "const a = process.argv.slice(2);",
  'const versionFile = path.join(__dirname, "fn-version.txt");',
  'if (a[0] === "--version") { console.log(fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "9.8.7"); }',
  planBehaviour === "present"
    ? 'else if (a[0] === "plan" && a[1] === "--help") { console.log("usage: fn plan"); }\nelse if (a[0] === "plan" && a.length === 1) { process.exitCode = 2; }\nelse { process.exitCode = 1; }'
    : "else { process.exitCode = 1; }",
  "",
].join("\n");

/** The receipt is plain JSON, so a text round trip is an exact deep copy. */
const cloneJson = (value) => JSON.parse(JSON.stringify(value));

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A small installed tree laid out the way `npm install <tarball>` lays out the real one. */
async function makeInstall(root, options = {}) {
  const { patched = false, piAiDependency = "dependencies", adapter = true, plan = "present", piAiVersion = "0.81.1" } = options;
  const nodeModules = path.join(root, "install", "node_modules");
  const installedRoot = path.join(nodeModules, "@runfusion", "fusion");
  const manifest = { name: "@runfusion/fusion", version: "1.2.3" };
  if (piAiDependency === "dependencies") manifest.dependencies = { "@earendil-works/pi-ai": "0.81.1" };
  if (piAiDependency === "devDependencies") manifest.devDependencies = { "@earendil-works/pi-ai": "0.81.1" };
  if (piAiDependency === "range") manifest.dependencies = { "@earendil-works/pi-ai": "^0.81.1" };
  await put(path.join(installedRoot, "package.json"), `${JSON.stringify(manifest)}\n`);
  await put(path.join(installedRoot, "dist/bin.js"), BIN_SOURCE);
  await put(path.join(installedRoot, "dist/plugins/example/bundled.js"), "export const plugin = 1;\n");
  await put(path.join(installedRoot, "dist/notes.md"), "not javascript\n");
  if (adapter) await put(path.join(installedRoot, "dist/ccc-route-receipt-adapter.js"), ADAPTER_SOURCE);
  const piAiRoot = path.join(nodeModules, "@earendil-works", "pi-ai");
  await put(path.join(piAiRoot, "package.json"), `${JSON.stringify({ name: "@earendil-works/pi-ai", version: piAiVersion })}\n`);
  await put(path.join(piAiRoot, "dist/api/openai-completions.js"), patched ? PATCHED_COMPLETIONS : UNPATCHED_COMPLETIONS);
  const executablePath = path.join(nodeModules, ".bin", "fn");
  await put(executablePath, FAKE_FN(plan));
  await chmod(executablePath, 0o755);
  const tarballPath = path.join(root, "pack", "runfusion-fusion-1.2.3.tgz");
  await put(tarballPath, "fixture-tarball-bytes\n");
  return {
    root,
    installedRoot,
    piAiRoot,
    executablePath,
    tarballPath,
    home: path.join(root, "home"),
    completionsPath: path.join(piAiRoot, "dist/api/openai-completions.js"),
    manifestPath: path.join(installedRoot, "package.json"),
    adapterPath: path.join(installedRoot, "dist/ccc-route-receipt-adapter.js"),
    binPath: path.join(installedRoot, "dist/bin.js"),
  };
}

function captureInput(fixture, overrides = {}) {
  return {
    tarballPath: fixture.tarballPath,
    installedRoot: fixture.installedRoot,
    executablePath: fixture.executablePath,
    home: fixture.home,
    source: { gitHead: "a".repeat(40), gitTree: "b".repeat(40), workingTreeDirty: false, capturedBeforeBuild: true },
    toolchain: { node: "v24.0.0", npm: "11.0.0", pnpm: "10.33.0" },
    noExternal: [/^@fusion\//, /^@fusion-plugin-examples\//],
    ...overrides,
  };
}

async function withScratch(prefix, body) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function capturedReceiptFile(fixture, overrides = {}) {
  const receipt = await captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture, overrides));
  const receiptPath = path.join(fixture.root, "evidence", "installed-runtime.json");
  await put(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptPath };
}

async function rejectsWith(promise, code, field) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `error code (message: ${error?.message})`);
    if (field !== undefined) assert.equal(error.field, field, `error field (message: ${error?.message})`);
    return true;
  });
}

describe("installed dist manifest digest", () => {
  test("is stable for the same bytes and changes when one byte of one dist file changes", async () => {
    await withScratch("ccc-ip-dist-", async (root) => {
      const fixture = await makeInstall(root);
      const dist = path.join(fixture.installedRoot, "dist");
      const first = await computeCccInstalledDistManifestSha256(dist);
      assert.match(first, /^[a-f0-9]{64}$/u);
      assert.equal(await computeCccInstalledDistManifestSha256(dist), first, "same bytes, same digest");
      await writeFile(fixture.binPath, BIN_SOURCE.replace("export", "exporT"));
      assert.notEqual(await computeCccInstalledDistManifestSha256(dist), first, "one byte changed");
      await writeFile(fixture.binPath, BIN_SOURCE);
      assert.equal(await computeCccInstalledDistManifestSha256(dist), first, "restoring the byte restores the digest");
    });
  });

  test("hashes the sorted relative path and file digest pairs of every nested js file and ignores other extensions", async () => {
    await withScratch("ccc-ip-dist-shape-", async (root) => {
      const dist = path.join(root, "dist");
      await put(path.join(dist, "b.js"), "bee\n");
      await put(path.join(dist, "a/z.js"), "zed\n");
      await put(path.join(dist, "a/y.js"), "why\n");
      await put(path.join(dist, "a/readme.md"), "ignored\n");
      await put(path.join(dist, "bin.js.map"), "ignored\n");
      const reference = sha256(JSON.stringify([
        ["a/y.js", sha256("why\n")],
        ["a/z.js", sha256("zed\n")],
        ["b.js", sha256("bee\n")],
      ]));
      assert.equal(await computeCccInstalledDistManifestSha256(dist), reference);
      await put(path.join(dist, "a/extra.d.ts"), "still ignored\n");
      assert.equal(await computeCccInstalledDistManifestSha256(dist), reference, "a non-js file never moves the digest");
      await put(path.join(dist, "a/deeper/c.js"), "see\n");
      assert.notEqual(await computeCccInstalledDistManifestSha256(dist), reference, "a nested js file does");
    });
  });

  test("refuses a missing dist root and a dist root that holds no js file", async () => {
    await withScratch("ccc-ip-dist-empty-", async (root) => {
      await rejectsWith(computeCccInstalledDistManifestSha256(path.join(root, "absent")), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "distManifestSha256");
      await put(path.join(root, "dist/only.md"), "no js\n");
      await rejectsWith(computeCccInstalledDistManifestSha256(path.join(root, "dist")), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "distManifestSha256");
      await put(path.join(root, "dist/one.js"), "x\n");
      assert.match(await computeCccInstalledDistManifestSha256(path.join(root, "dist")), /^[a-f0-9]{64}$/u);
    });
  });
});

describe("installed dist manifest digest: links", () => {
  test("refuses a symbolic link inside dist, because a linked js file would be read through or skipped silently", async () => {
    await withScratch("ccc-ip-dist-link-", async (root) => {
      const dist = path.join(root, "dist");
      await put(path.join(dist, "a.js"), "alpha\n");
      assert.match(await computeCccInstalledDistManifestSha256(dist), /^[a-f0-9]{64}$/u, "the clean twin digests");
      await symlink(path.join(dist, "a.js"), path.join(dist, "b.js"));
      await rejectsWith(computeCccInstalledDistManifestSha256(dist), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "distManifestSha256");
    });
  });
});

describe("pi-ai workspace patch status from installed bytes", () => {
  test("classifies an unpatched file as not_carried and a file holding the identitySubstantive marker as carried", () => {
    assert.equal(classifyCccPiAiWorkspacePatch(UNPATCHED_COMPLETIONS), "not_carried");
    assert.equal(classifyCccPiAiWorkspacePatch(PATCHED_COMPLETIONS), "carried");
    assert.equal(classifyCccPiAiWorkspacePatch(""), "not_carried");
  });

  test("uses the marker the checked-in patch adds, so a changed patch cannot leave this check behind", async () => {
    const patch = await readFile(path.join(repoRoot, "patches/@earendil-works__pi-ai@0.81.1.patch"), "utf8");
    const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1));
    assert.ok(added.some((line) => line.includes(CCC_PI_AI_PATCH_MARKER)), "the patch adds a line with the marker");
    assert.equal(classifyCccPiAiWorkspacePatch(added.join("\n")), "carried", "the lines the patch adds classify as carried");
    assert.equal(classifyCccPiAiWorkspacePatch(patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).join("\n")), "not_carried", "the lines it removes do not");
  });
});

describe("pi-ai shipping from the packed manifest and the tsup rule", () => {
  const pinned = { name: "@runfusion/fusion", version: "1.0.0", dependencies: { "@earendil-works/pi-ai": "0.81.1" } };
  const fusionOnly = [/^@fusion\//, /^@fusion-plugin-examples\//];

  test("is external only for an exactly pinned runtime dependency that no noExternal rule matches", () => {
    assert.equal(deriveCccPiAiShipping({ packageJson: pinned, noExternal: fusionOnly }), "external");
    assert.equal(deriveCccPiAiShipping({ packageJson: { ...pinned, dependencies: {} }, noExternal: fusionOnly }), "not_declared");
    assert.equal(deriveCccPiAiShipping({ packageJson: { name: "x", version: "1", devDependencies: pinned.dependencies }, noExternal: fusionOnly }), "not_declared");
    assert.equal(deriveCccPiAiShipping({ packageJson: { ...pinned, dependencies: { "@earendil-works/pi-ai": "^0.81.1" } }, noExternal: fusionOnly }), "version_not_pinned");
    assert.equal(deriveCccPiAiShipping({ packageJson: pinned, noExternal: [...fusionOnly, /^@earendil-works\//] }), "bundled");
    assert.equal(deriveCccPiAiShipping({ packageJson: pinned, noExternal: ["@earendil-works/pi-ai"] }), "bundled");
  });

  test("reads the real CLI manifest and tsup config as external, and flips when the rule would bundle pi-ai", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"));
    const tsupText = await readFile(path.join(repoRoot, "packages/cli/tsup.config.ts"), "utf8");
    const rules = parseCccCliNoExternalRules(tsupText);
    assert.ok(rules.some((rule) => rule instanceof RegExp && rule.test("@fusion/core")), "the parser found the real @fusion rule");
    assert.equal(deriveCccPiAiShipping({ packageJson: manifest, noExternal: rules }), "external");
    const widened = tsupText.replace("noExternal: [/^@fusion\\//, /^@fusion-plugin-examples\\//],", "noExternal: [/^@fusion\\//, /^@earendil-works\\//],");
    assert.notEqual(widened, tsupText, "the mutation applied");
    assert.equal(deriveCccPiAiShipping({ packageJson: manifest, noExternal: parseCccCliNoExternalRules(widened) }), "bundled");
  });

  test("refuses a tsup config whose noExternal rule it cannot read", () => {
    assert.throws(() => parseCccCliNoExternalRules("export default { noExternal: [someRule, /^@fusion\\//] };"), (error) => error.code === CCC_PLANNING_INSTALLED_RUNTIME_INVALID);
    assert.deepEqual(parseCccCliNoExternalRules("export default { noExternal: ['a', /^@b\\//u] };").map(String), ["a", "/^@b\\//u"]);
  });
});

describe("installed runtime receipt capture", () => {
  test("captures the exact key set with piAi shipping, workspacePatch and keepaliveModelSource", async () => {
    await withScratch("ccc-ip-capture-", async (root) => {
      const fixture = await makeInstall(root);
      const receipt = await captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture));
      assert.deepEqual(Object.keys(receipt).sort(), [
        "distManifestSha256", "executablePath", "executableSha256", "installedRoot", "packageName", "packageVersion",
        "piAi", "planCommand", "runtimeBoundary", "schema", "source", "tarballPath", "tarballSha256", "toolchain",
        "versionOutput", "versionOutputSha256",
      ]);
      assert.equal(receipt.schema, CCC_PLANNING_INSTALLED_RUNTIME_SCHEMA);
      assert.equal(receipt.schema, "ccc-planning.installed-runtime.v1");
      assert.deepEqual(receipt.piAi, {
        version: "0.81.1",
        shipping: "external",
        workspacePatch: "not_carried",
        keepaliveModelSource: "fusion-receipt-adapter",
        openaiCompletionsSha256: sha256(UNPATCHED_COMPLETIONS),
      });
      assert.deepEqual(receipt.planCommand, { helpExitCode: 0, usageExitCode: 2 });
      assert.deepEqual(receipt.runtimeBoundary, { fullInstalledRuntime: "daemon_process", sourceInProcessScheduler: "not_used" });
      assert.deepEqual(receipt.source, { gitHead: "a".repeat(40), gitTree: "b".repeat(40), workingTreeDirty: false, capturedBeforeBuild: true });
      assert.equal(receipt.packageName, "@runfusion/fusion");
      assert.equal(receipt.versionOutput, "9.8.7");
      assert.equal(receipt.versionOutputSha256, sha256("9.8.7"));
      assert.equal(receipt.tarballSha256, sha256("fixture-tarball-bytes\n"));
      assert.equal(receipt.executableSha256, sha256(await readFile(fixture.executablePath)));
      assert.equal(receipt.distManifestSha256, await computeCccInstalledDistManifestSha256(path.join(fixture.installedRoot, "dist")));
    });
  });

  test("records workspacePatch carried only when the installed pi-ai file holds the marker", async () => {
    await withScratch("ccc-ip-capture-patched-", async (root) => {
      const fixture = await makeInstall(root, { patched: true });
      const receipt = await captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture));
      assert.equal(receipt.piAi.workspacePatch, "carried");
      assert.equal(receipt.piAi.openaiCompletionsSha256, sha256(PATCHED_COMPLETIONS));
    });
  });

  test("refuses to capture when pi-ai is not a pinned dependency of the packed manifest", async () => {
    for (const piAiDependency of ["devDependencies", "range", "none"]) {
      await withScratch("ccc-ip-capture-shipping-", async (root) => {
        const fixture = await makeInstall(root, { piAiDependency });
        await rejectsWith(captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture)), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.shipping");
      });
    }
    await withScratch("ccc-ip-capture-shipping-bundled-", async (root) => {
      const fixture = await makeInstall(root);
      await rejectsWith(
        captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture, { noExternal: [/^@fusion\//, /^@earendil-works\//] })),
        CCC_PLANNING_INSTALLED_RUNTIME_INVALID,
        "piAi.shipping",
      );
    });
  });

  test("refuses to capture when the installed receipt adapter is missing or bundles pi-ai instead of importing it", async () => {
    await withScratch("ccc-ip-capture-adapter-", async (root) => {
      const fixture = await makeInstall(root, { adapter: false });
      await rejectsWith(captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture)), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.keepaliveModelSource");
    });
    await withScratch("ccc-ip-capture-inlined-", async (root) => {
      const fixture = await makeInstall(root);
      await writeFile(fixture.adapterPath, ADAPTER_SOURCE.replaceAll("@earendil-works/pi-ai", "./inlined-pi-ai"));
      await rejectsWith(captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture)), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.shipping");
    });
    await withScratch("ccc-ip-capture-adapter-ok-", async (root) => {
      const fixture = await makeInstall(root);
      assert.equal((await captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture))).piAi.keepaliveModelSource, "fusion-receipt-adapter");
    });
  });

  test("refuses to capture when the installed pi-ai is not the pinned version", async () => {
    await withScratch("ccc-ip-capture-version-", async (root) => {
      const fixture = await makeInstall(root, { piAiVersion: "0.82.0" });
      await rejectsWith(captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture)), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.version");
    });
  });

  test("refuses to capture when the installed fn has no plan command, and records the observed codes when it has", async () => {
    await withScratch("ccc-ip-capture-plan-", async (root) => {
      const fixture = await makeInstall(root, { plan: "absent" });
      await rejectsWith(captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture)), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "planCommand");
    });
    await withScratch("ccc-ip-capture-plan-ok-", async (root) => {
      const fixture = await makeInstall(root);
      assert.deepEqual((await captureCccPlanningInstalledRuntimeReceipt(captureInput(fixture))).planCommand, { helpExitCode: 0, usageExitCode: 2 });
    });
  });
});

describe("installed runtime receipt verification", () => {
  test("accepts the untouched install and returns the receipt it checked", async () => {
    await withScratch("ccc-ip-verify-", async (root) => {
      const fixture = await makeInstall(root);
      const { receipt, receiptPath } = await capturedReceiptFile(fixture);
      assert.deepEqual(await verifyCccPlanningInstalledRuntimeReceipt(receiptPath), receipt);
    });
  });

  test("detects a one-byte change in one installed dist file and names distManifestSha256", async () => {
    await withScratch("ccc-ip-verify-dist-", async (root) => {
      const fixture = await makeInstall(root);
      const { receiptPath } = await capturedReceiptFile(fixture);
      await verifyCccPlanningInstalledRuntimeReceipt(receiptPath);
      const nested = path.join(fixture.installedRoot, "dist/plugins/example/bundled.js");
      await writeFile(nested, "export const plugin = 2;\n");
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "distManifestSha256");
    });
  });

  test("detects a changed fn executable, a changed tarball and a changed version output, each by field name", async () => {
    await withScratch("ccc-ip-verify-exe-", async (root) => {
      const fixture = await makeInstall(root);
      const { receiptPath } = await capturedReceiptFile(fixture);
      await writeFile(fixture.executablePath, `${FAKE_FN("present")}// one more byte\n`);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "executableSha256");
    });
    await withScratch("ccc-ip-verify-tgz-", async (root) => {
      const fixture = await makeInstall(root);
      const { receiptPath } = await capturedReceiptFile(fixture);
      await writeFile(fixture.tarballPath, "fixture-tarball-byteS\n");
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "tarballSha256");
    });
    await withScratch("ccc-ip-verify-version-", async (root) => {
      const fixture = await makeInstall(root);
      const { receiptPath } = await capturedReceiptFile(fixture);
      await writeFile(path.join(path.dirname(fixture.executablePath), "fn-version.txt"), "9.8.8\n");
      assert.equal(sha256(await readFile(fixture.executablePath)), sha256(FAKE_FN("present")), "the executable bytes are untouched, only its output moved");
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "versionOutputSha256");
    });
  });

  test("refuses a receipt without piAi.keepaliveModelSource, with another value, or without the piAi block", async () => {
    await withScratch("ccc-ip-verify-keepalive-", async (root) => {
      const fixture = await makeInstall(root);
      const { receipt, receiptPath } = await capturedReceiptFile(fixture);
      const variants = [
        ["missing", (piAi) => { delete piAi.keepaliveModelSource; }],
        ["other value", (piAi) => { piAi.keepaliveModelSource = "pi-ai-workspace-patch"; }],
        ["null", (piAi) => { piAi.keepaliveModelSource = null; }],
      ];
      for (const [label, mutate] of variants) {
        const copy = cloneJson(receipt);
        mutate(copy.piAi);
        await put(receiptPath, `${JSON.stringify(copy)}\n`);
        await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.keepaliveModelSource").catch((error) => {
          throw new Error(`${label}: ${error.message}`);
        });
      }
      const withoutBlock = cloneJson(receipt);
      delete withoutBlock.piAi;
      await put(receiptPath, `${JSON.stringify(withoutBlock)}\n`);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi");
      await put(receiptPath, `${JSON.stringify(receipt)}\n`);
      assert.deepEqual(await verifyCccPlanningInstalledRuntimeReceipt(receiptPath), receipt, "the unmodified twin still verifies");
    });
  });

  test("refuses shipping that is not derived from the packed manifest", async () => {
    await withScratch("ccc-ip-verify-shipping-", async (root) => {
      const fixture = await makeInstall(root);
      const { receipt, receiptPath } = await capturedReceiptFile(fixture);
      await writeFile(fixture.manifestPath, `${JSON.stringify({ name: "@runfusion/fusion", version: "1.2.3", dependencies: {} })}\n`);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.shipping");
      await writeFile(fixture.manifestPath, `${JSON.stringify({ name: "@runfusion/fusion", version: "1.2.3", dependencies: { "@earendil-works/pi-ai": "0.81.1" } })}\n`);
      assert.deepEqual(await verifyCccPlanningInstalledRuntimeReceipt(receiptPath), receipt, "the restored manifest verifies again");
      const claimed = cloneJson(receipt);
      claimed.piAi.shipping = "bundled";
      await put(receiptPath, `${JSON.stringify(claimed)}\n`);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.shipping");
    });
  });

  test("refuses a workspacePatch claim that disagrees with the installed pi-ai bytes", async () => {
    await withScratch("ccc-ip-verify-patch-", async (root) => {
      const fixture = await makeInstall(root);
      const { receipt, receiptPath } = await capturedReceiptFile(fixture);
      const claimed = cloneJson(receipt);
      claimed.piAi.workspacePatch = "carried";
      await put(receiptPath, `${JSON.stringify(claimed)}\n`);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.workspacePatch");
      await put(receiptPath, `${JSON.stringify(receipt)}\n`);
      await writeFile(fixture.completionsPath, PATCHED_COMPLETIONS);
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "piAi.openaiCompletionsSha256");
    });
  });

  test("refuses an unknown key, a missing key, a wrong schema and text that is not JSON", async () => {
    await withScratch("ccc-ip-verify-shape-", async (root) => {
      const fixture = await makeInstall(root);
      const { receipt, receiptPath } = await capturedReceiptFile(fixture);
      const cases = [
        ["extra top-level key", { ...cloneJson(receipt), extra: 1 }, "extra"],
        ["extra piAi key", { ...cloneJson(receipt), piAi: { ...receipt.piAi, extra: 1 } }, "piAi.extra"],
        ["missing key", (() => { const copy = cloneJson(receipt); delete copy.toolchain; return copy; })(), "toolchain"],
        ["wrong schema", { ...cloneJson(receipt), schema: "ccc-planning.installed-runtime.v2" }, "schema"],
        ["dirty source", { ...cloneJson(receipt), source: { ...receipt.source, workingTreeDirty: true } }, "source.workingTreeDirty"],
      ];
      for (const [label, value, field] of cases) {
        await put(receiptPath, `${JSON.stringify(value)}\n`);
        await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, field).catch((error) => {
          throw new Error(`${label}: ${error.message}`);
        });
      }
      await put(receiptPath, "{ not json");
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(receiptPath), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "receipt");
      await rejectsWith(verifyCccPlanningInstalledRuntimeReceipt(path.join(root, "absent.json")), CCC_PLANNING_INSTALLED_RUNTIME_INVALID, "receipt");
      await put(receiptPath, `${JSON.stringify(receipt)}\n`);
      assert.deepEqual(await verifyCccPlanningInstalledRuntimeReceipt(receiptPath), receipt);
    });
  });
});

describe("prepare refuses before building and captures provenance first", () => {
  function fakeDeps(options = {}) {
    const calls = [];
    return {
      calls,
      deps: {
        git: async (args) => {
          calls.push(`git ${args.join(" ")}`);
          if (args[0] === "status") return { stdout: options.dirty ? " M packages/cli/src/bin.ts\n" : "" };
          if (args.at(-1) === "HEAD") return { stdout: `${"c".repeat(40)}\n` };
          return { stdout: `${"d".repeat(40)}\n` };
        },
        readToolchain: async () => {
          calls.push("toolchain");
          return { node: "v24.0.0", npm: "11.0.0", pnpm: "10.33.0" };
        },
        readNoExternal: async () => {
          calls.push("noExternal");
          return [/^@fusion\//];
        },
        packAndInstall: async (input) => {
          calls.push("packAndInstall");
          calls.input = input;
          return { tarballPath: "/t.tgz", installedRoot: "/i", executablePath: "/i/fn", home: input.layout.homeDir, npmFetch: "offline-cache" };
        },
        capture: async (input) => {
          calls.push("capture");
          calls.captureInput = input;
          return { marker: "captured" };
        },
      },
    };
  }

  test("refuses a tracked-dirty source tree before the pack and install step runs", async () => {
    const dirty = fakeDeps({ dirty: true });
    await rejectsWith(
      prepareCccPlanningInstalledRuntime({ root: "/scratch/root", cliRoot: "/repo/packages/cli", repoRoot: "/repo" }, dirty.deps),
      "CCC_PLANNING_INSTALLED_SOURCE_DIRTY",
    );
    assert.ok(!dirty.calls.includes("packAndInstall"), "the build never started");
    assert.ok(!dirty.calls.includes("capture"));
    const clean = fakeDeps();
    assert.deepEqual(await prepareCccPlanningInstalledRuntime({ root: "/scratch/root", cliRoot: "/repo/packages/cli", repoRoot: "/repo" }, clean.deps), { marker: "captured" });
    assert.equal(clean.calls.filter((call) => call === "packAndInstall").length, 1);
  });

  test("reads the git status, head and tree and the toolchain before the build and hands them to the capture", async () => {
    const { calls, deps } = fakeDeps();
    await prepareCccPlanningInstalledRuntime({ root: "/scratch/root", cliRoot: "/repo/packages/cli", repoRoot: "/repo" }, deps);
    const build = calls.indexOf("packAndInstall");
    assert.ok(build > 0);
    assert.deepEqual(calls.slice(0, build).sort(), ["git rev-parse HEAD", "git rev-parse HEAD^{tree}", "git status --porcelain --untracked-files=no", "noExternal", "toolchain"].sort());
    assert.deepEqual(calls.captureInput.source, { gitHead: "c".repeat(40), gitTree: "d".repeat(40), workingTreeDirty: false, capturedBeforeBuild: true });
    assert.deepEqual(calls.captureInput.toolchain, { node: "v24.0.0", npm: "11.0.0", pnpm: "10.33.0" });
    assert.deepEqual(calls.input.layout, {
      packDir: path.join("/scratch/root", "evidence", "pack"),
      installDir: path.join("/scratch/root", "install"),
      homeDir: path.join("/scratch/root", "home"),
    });
    assert.equal(calls.input.cliRoot, "/repo/packages/cli");
  });
});

describe("shared installed CLI helpers", () => {
  const fakeFnPrinter = [
    "#!/usr/bin/env node",
    "const mode = process.argv[2];",
    'if (mode === "env") { console.log(JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) })); }',
    'else if (mode === "mixed") { console.log(JSON.stringify({ ok: 1 })); console.log("not json at all"); }',
    'else if (mode === "two") { console.log(JSON.stringify({ a: 1 })); console.log(JSON.stringify({ b: 2 })); process.exitCode = 1; }',
    'else if (mode === "hang") { console.log(JSON.stringify({ pid: process.pid })); setTimeout(() => {}, 600000); }',
    "",
  ].join("\n");

  async function printer(root) {
    const executablePath = path.join(root, "fn");
    await put(executablePath, fakeFnPrinter);
    await chmod(executablePath, 0o755);
    return executablePath;
  }

  test("passes only the allowlisted names plus the isolated home to the child, never a credential or PORT", async () => {
    await withScratch("ccc-ip-env-", async (root) => {
      const executablePath = await printer(root);
      const home = path.join(root, "home");
      await mkdir(home);
      const canaries = { OMNIROUTE_API_KEY: "canary-1", ANTHROPIC_API_KEY: "canary-2", GH_TOKEN: "canary-3", PORT: "4040", NODE_OPTIONS: "--no-warnings", VITEST: "true" };
      const previous = Object.fromEntries(Object.keys(canaries).map((key) => [key, process.env[key]]));
      Object.assign(process.env, canaries);
      try {
        const result = await runInstalledFnJsonCommand({
          executablePath,
          args: ["env", "--json"],
          cwd: root,
          home,
          extraEnv: { DATABASE_URL: "postgresql://postgres@127.0.0.1:55401/fusion", TMPDIR: path.join(root, "tmp") },
          timeoutMs: 20_000,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.values.length, 1);
        const seen = result.values[0].env;
        for (const name of Object.keys(canaries)) assert.equal(seen[name], undefined, `${name} must not reach the child`);
        assert.equal(seen.HOME, home);
        assert.equal(seen.FUSION_HOME, path.join(home, ".fusion"));
        assert.equal(seen.PI_OFFLINE, "1");
        assert.equal(seen.NO_COLOR, "1");
        assert.equal(seen.DATABASE_URL, "postgresql://postgres@127.0.0.1:55401/fusion");
        assert.ok(seen.PATH, "an allowlisted name from the parent comes through");
        assert.equal(result.values[0].cwd, await realpathOf(root));
        const names = Object.keys(seen).filter((name) => !["__CF_USER_TEXT_ENCODING"].includes(name)).sort();
        assert.ok(names.every((name) => [...CCC_INSTALLED_FN_ENV_ALLOWLIST, "HOME", "FUSION_HOME", "NO_COLOR", "PI_OFFLINE", "DATABASE_URL", "TMPDIR", "PWD", "SHLVL", "_"].includes(name)), `unexpected names: ${names.join(",")}`);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.deepEqual([...CCC_INSTALLED_FN_ENV_ALLOWLIST], ["PATH", "LANG", "LC_ALL", "TZ"]);
    });
  });

  test("refuses extra environment names that are credentials, PORT, preload hooks or the isolation variables, and accepts the names it is meant for", () => {
    const home = "/scratch/home";
    for (const name of ["OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "AWS_REGION", "OPENAI_BASE_URL", "DB_PASSWORD", "PORT", "NODE_OPTIONS", "VITEST_WORKER_ID", "HOME", "PI_OFFLINE", "NO_COLOR"]) {
      assert.throws(() => buildInstalledFnEnv({ home, extraEnv: { [name]: "x" }, parentEnv: {} }), /not allowed/u, name);
    }
    assert.throws(() => buildInstalledFnEnv({ home: "relative/home", extraEnv: {}, parentEnv: {} }), /absolute/u);
    assert.deepEqual(
      buildInstalledFnEnv({
        home,
        extraEnv: { DATABASE_URL: "postgresql://postgres@127.0.0.1:55401/fusion", FUSION_HOME: "/scratch/fusion-home", TMPDIR: "/scratch/tmp" },
        parentEnv: { PATH: "/bin", LANG: "C", SECRET_THING: "x", GH_TOKEN: "t", PORT: "4040" },
      }),
      { PATH: "/bin", LANG: "C", HOME: home, FUSION_HOME: "/scratch/fusion-home", NO_COLOR: "1", PI_OFFLINE: "1", DATABASE_URL: "postgresql://postgres@127.0.0.1:55401/fusion", TMPDIR: "/scratch/tmp" },
    );
  });

  test("returns every JSON stdout line with the exit code and refuses a line that is not JSON", async () => {
    await withScratch("ccc-ip-json-", async (root) => {
      const executablePath = await printer(root);
      const home = path.join(root, "home");
      await mkdir(home);
      const base = { executablePath, cwd: root, home, extraEnv: {}, timeoutMs: 20_000 };
      const two = await runInstalledFnJsonCommand({ ...base, args: ["two"] });
      assert.deepEqual(two, { exitCode: 1, values: [{ a: 1 }, { b: 2 }], stderr: "" });
      await assert.rejects(runInstalledFnJsonCommand({ ...base, args: ["mixed"] }), /non-JSON stdout line/u);
    });
  });

  test("stops a child that outlives its timeout and reports the timeout", async () => {
    await withScratch("ccc-ip-timeout-", async (root) => {
      const executablePath = await printer(root);
      const home = path.join(root, "home");
      await mkdir(home);
      let childPid = null;
      await assert.rejects(
        runInstalledFnJsonCommand({ executablePath, args: ["hang"], cwd: root, home, extraEnv: {}, timeoutMs: 700, onSpawn: (pid) => { childPid = pid; } }),
        /timed out after 700 ms/u,
      );
      assert.ok(Number.isInteger(childPid) && childPid > 0, "the helper reports the pid it started");
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "the timed-out child is gone");
    });
  });
});

async function realpathOf(target) {
  const { realpath } = await import("node:fs/promises");
  return realpath(target);
}

describe("pack and install sequence", () => {
  const FAKE_COREPACK = [
    "#!/usr/bin/env node",
    'const fs = require("fs"); const path = require("path");',
    "const a = process.argv.slice(2);",
    'fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "corepack", args: a, cwd: process.cwd(), home: process.env.HOME }) + "\\n");',
    'if (a[0] === "pnpm" && a[1] === "run" && a[2] === "build:package") process.exit(0);',
    'if (a[0] === "pnpm" && a[1] === "pack") { fs.writeFileSync(path.join(a[a.indexOf("--pack-destination") + 1], "runfusion-fusion-1.2.3.tgz"), "fake-tarball\\n"); process.exit(0); }',
    "process.exit(2);",
    "",
  ].join("\n");
  const FAKE_NPM = [
    "#!/usr/bin/env node",
    'const fs = require("fs"); const path = require("path");',
    "const a = process.argv.slice(2);",
    'fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "npm", args: a, cwd: process.cwd(), home: process.env.HOME, cache: process.env.npm_config_cache || null }) + "\\n");',
    'const mode = process.env.FAKE_NPM_MODE || "ok";',
    'if (mode === "enotcached-offline" && a.includes("--offline")) { console.error("npm error code ENOTCACHED"); process.exit(1); }',
    'if (mode === "broken") { console.error("npm error code E500"); process.exit(1); }',
    'const modules = path.join(process.cwd(), "node_modules"); const pkg = path.join(modules, "@runfusion", "fusion");',
    'fs.mkdirSync(path.join(pkg, "dist"), { recursive: true }); fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });',
    'fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@runfusion/fusion", version: "1.2.3" }));',
    'fs.writeFileSync(path.join(modules, ".bin", "fn"), "#!/bin/sh\\necho 1.2.3\\n", { mode: 0o755 });',
    "",
  ].join("\n");

  async function fakeToolchain(root) {
    const bin = path.join(root, "bin");
    const cliRoot = path.join(root, "cli");
    const log = path.join(root, "calls.jsonl");
    for (const [name, source] of [["corepack", FAKE_COREPACK], ["npm", FAKE_NPM]]) {
      await put(path.join(bin, name), source);
      await chmod(path.join(bin, name), 0o755);
    }
    await put(path.join(cliRoot, "scripts/prepare-publish-manifest.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "postpack", args: process.argv.slice(2) }) + "\\n");\n');
    await writeFile(log, "");
    return { bin, cliRoot, log };
  }

  const readLog = async (log) => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const childEnv = (fake, extra = {}) => ({ ...process.env, PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: fake.log, ...extra });

  test("builds, packs, restores the manifest and installs with the default arguments and the default layout", async () => {
    await withScratch("ccc-ip-pack-", async (root) => {
      const fake = await fakeToolchain(root);
      const target = path.join(root, "out");
      await mkdir(target);
      const result = await packAndInstallFusionCli({ root: target, cliRoot: fake.cliRoot, env: childEnv(fake) });
      assert.equal(result.tarballPath, path.join(target, "pack", "runfusion-fusion-1.2.3.tgz"));
      assert.equal(result.installedRoot, path.join(target, "install", "node_modules/@runfusion/fusion"));
      assert.equal(result.executablePath, path.join(target, "install", "node_modules/.bin/fn"));
      assert.equal(result.home, path.join(target, "home"));
      const calls = await readLog(fake.log);
      assert.deepEqual(calls.map((call) => `${call.tool}:${call.args.join(" ")}`), [
        "corepack:pnpm run build:package",
        `corepack:pnpm pack --pack-destination ${path.join(target, "pack")}`,
        "postpack:postpack",
        `npm:install --no-audit --no-fund --ignore-scripts ${result.tarballPath}`,
      ]);
      assert.ok(calls.filter((call) => call.tool === "npm" || call.tool === "corepack").every((call) => call.home === path.join(target, "home")), "every step runs under the isolated home");
      assert.equal(calls.at(-1).cache, process.env.npm_config_cache ?? null, "no cache override unless asked");
    });
  });

  test("refuses a root that is not empty before running any step", async () => {
    await withScratch("ccc-ip-pack-busy-", async (root) => {
      const fake = await fakeToolchain(root);
      const target = path.join(root, "out");
      await put(path.join(target, "stale.txt"), "leftover\n");
      await assert.rejects(packAndInstallFusionCli({ root: target, cliRoot: fake.cliRoot, env: childEnv(fake) }), /root is not empty/u);
      assert.deepEqual(await readLog(fake.log), [], "no tool ran");
    });
  });

  test("offline mode passes --offline and never goes online; offline-first retries online only after ENOTCACHED", async () => {
    await withScratch("ccc-ip-pack-offline-", async (root) => {
      const fake = await fakeToolchain(root);
      const npmArgs = async () => (await readLog(fake.log)).filter((call) => call.tool === "npm").map((call) => call.args);
      const layoutFor = (name) => ({ packDir: path.join(root, name, "pack"), installDir: path.join(root, name, "install"), homeDir: path.join(root, name, "home") });
      const run = (name, npmMode, mode) => packAndInstallFusionCli({
        root: path.join(root, name), cliRoot: fake.cliRoot, env: childEnv(fake, { FAKE_NPM_MODE: mode }), layout: layoutFor(name), npmMode,
        toolCaches: { npmCache: path.join(root, "real-npm-cache") },
      });

      const offline = await run("a", "offline", "ok");
      assert.equal(offline.npmFetch, "offline-cache");
      let attempts = await npmArgs();
      assert.equal(attempts.length, 1);
      assert.ok(attempts[0].includes("--offline") && attempts[0].includes("--ignore-scripts"));
      assert.deepEqual(attempts[0].slice(attempts[0].indexOf("--cache")), ["--cache", path.join(root, "real-npm-cache"), offline.tarballPath], "the real cache is passed explicitly because HOME is isolated");

      await writeFile(fake.log, "");
      await assert.rejects(run("b", "offline", "enotcached-offline"), /ENOTCACHED/u);
      attempts = await npmArgs();
      assert.equal(attempts.length, 1, "offline mode makes exactly one attempt and never retries online");

      await writeFile(fake.log, "");
      const retried = await run("c", "offline-first", "enotcached-offline");
      attempts = await npmArgs();
      assert.equal(attempts.length, 2);
      assert.ok(attempts[0].includes("--offline") && !attempts[1].includes("--offline"), "second attempt is the online one");
      assert.equal(retried.npmFetch, "registry");

      await writeFile(fake.log, "");
      await assert.rejects(run("d", "offline-first", "broken"), /E500/u);
      assert.equal((await npmArgs()).length, 1, "a failure other than ENOTCACHED is never retried online");
    });
  });
});

describe("planning install entry script", () => {
  function runScript(args, env = {}) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  }

  test("exits 2 with a usage line for no argument and for two arguments", () => {
    for (const args of [[], ["a", "b"]]) {
      const result = runScript(args);
      assert.equal(result.status, 2, `args ${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/ccc-planning-install-runtime\.mjs <install-dir>/u);
      assert.equal(result.stdout, "");
    }
  });

  test("refuses a non-empty install directory before any pnpm or npm step runs", async () => {
    await withScratch("ccc-ip-entry-", async (root) => {
      const bin = path.join(root, "bin");
      const marker = path.join(root, "marker.txt");
      for (const name of ["corepack", "npm", "pnpm"]) {
        await put(path.join(bin, name), `#!/bin/sh\necho "$0 $@" >> ${JSON.stringify(marker)}\nexit 3\n`);
        await chmod(path.join(bin, name), 0o755);
      }
      const installDir = path.join(root, "rt", "install");
      await put(path.join(installDir, "stale.txt"), "leftover\n");
      const result = runScript([installDir], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /CCC_PLANNING_INSTALLED_RUNTIME_INVALID/u);
      assert.match(result.stderr, /install/u);
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" }, "no build tool was started");
    });
  });
});
