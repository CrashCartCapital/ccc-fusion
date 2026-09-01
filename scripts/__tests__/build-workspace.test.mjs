import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  BUILD_CACHE_VERSION,
  DEFAULT_BUILD_WORKSPACE_CONCURRENCY,
  PLUGIN_BUILD_GLOBAL_INPUT_PATHS,
  computePluginSourceHash,
  discoverWorkspacePackages,
  ensureFullPackageCliPlanned,
  planWorkspaceBuild,
  readPluginBuildCache,
  requiredPluginOutputs,
  resolveBuildWorkspaceConcurrency,
  runPlannedBuilds,
  wantsFullCliPackage,
} from "../build-workspace.mjs";
import { workItemHasCccPermanentReason } from "../lib/ccc-permanent-reason.mjs";

function createWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "fn-7290-build-workspace-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'plugins/*'\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "workspace-root", private: true }, null, 2));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }, null, 2));
  writeFileSync(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  writeFileSync(path.join(root, "plugins", "tsconfig.base.json"), JSON.stringify({ extends: "../tsconfig.base.json" }, null, 2));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-workspace.mjs"), "export {};\n");
  writeFileSync(path.join(root, "scripts", "lib", "content-hash.mjs"), "export {};\n");
  writePackage(root, "packages/core", {
    name: "@fusion/core",
    scripts: { build: "tsc" },
  });
  mkdirSync(path.join(root, "packages/core", "src"), { recursive: true });
  writeFileSync(path.join(root, "packages/core", "src", "index.ts"), "export const core = 1;\n");
  writePackage(root, "packages/desktop", {
    name: "@fusion/desktop",
    scripts: { build: "tsc" },
  });
  writePackage(root, "plugins/fusion-plugin-alpha", {
    name: "@fusion-plugin-examples/alpha",
    scripts: { build: "tsc" },
    dependencies: { "@fusion/core": "workspace:*" },
    exports: { ".": { types: "./src/index.ts", import: "./dist/index.js" } },
  });
  mkdirSync(path.join(root, "plugins/fusion-plugin-alpha", "src"), { recursive: true });
  writeFileSync(path.join(root, "plugins/fusion-plugin-alpha", "src", "index.ts"), "export const alpha = 1;\n");
  return root;
}

function writePackage(root, dir, manifest) {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest, null, 2));
}

function withWorkspace(fn) {
  const root = createWorkspace();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initGit(root) {
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
}

function packageByName(packages, name) {
  return packages.find((pkg) => pkg.name === name);
}

function writePluginDist(root, dir = "plugins/fusion-plugin-alpha") {
  mkdirSync(path.join(root, dir, "dist"), { recursive: true });
  writeFileSync(path.join(root, dir, "dist", "index.js"), "export const alpha = 1;\n");
}

function extractFunctionSource(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart === -1 ? source.indexOf(`function ${name}(`) : asyncStart;
  assert.notEqual(start, -1, `expected to find ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `expected to find ${name} body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`expected to close ${name} body`);
}

test("discovers workspace packages and classifies plugin directories", () => {
  withWorkspace((root) => {
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");

    assert.equal(plugin.isPlugin, true);
    assert.equal(core.isPlugin, false);
    assert.deepEqual(plugin.requiredOutputs, ["plugins/fusion-plugin-alpha/dist/index.js"]);
    assert.deepEqual(plugin.inputPaths, [
      ...PLUGIN_BUILD_GLOBAL_INPUT_PATHS,
      "packages/core",
      "plugins/fusion-plugin-alpha",
    ].sort((a, b) => a.localeCompare(b)));
  });
});

test("unchanged packages with outputs and cache are skipped (plugins and non-plugins)", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    // Core required outputs from src/index.ts → packages/core/dist/index.js
    mkdirSync(path.join(root, "packages/core", "dist"), { recursive: true });
    writeFileSync(path.join(root, "packages/core", "dist", "index.js"), "export const core = 1;\n");
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");
    const pluginHash = computePluginSourceHash(plugin, root);
    const coreHash = computePluginSourceHash(core, root);
    const cache = {
      version: BUILD_CACHE_VERSION,
      entries: {
        [plugin.name]: { sourceHash: pluginHash },
        [core.name]: { sourceHash: coreHash },
      },
    };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache });

    assert.deepEqual(plan.plannedPackages.map((pkg) => pkg.name), []);
    assert.deepEqual(
      (plan.skippedPackages ?? plan.skippedPlugins).map((pkg) => pkg.name).sort(),
      ["@fusion-plugin-examples/alpha", "@fusion/core"].sort(),
    );
    assert.deepEqual(plan.excludedPackages.map((pkg) => pkg.name), ["@fusion/desktop"]);
  });
});

test("force rebuilds packages even when cache matches", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    mkdirSync(path.join(root, "packages/core", "dist"), { recursive: true });
    writeFileSync(path.join(root, "packages/core", "dist", "index.js"), "export const core = 1;\n");
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");
    const cache = {
      version: BUILD_CACHE_VERSION,
      entries: {
        [plugin.name]: { sourceHash: computePluginSourceHash(plugin, root) },
        [core.name]: { sourceHash: computePluginSourceHash(core, root) },
      },
    };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache, force: true });
    assert.ok(plan.plannedPackages.some((pkg) => pkg.name === "@fusion/core"));
    assert.ok(plan.plannedPackages.some((pkg) => pkg.name === "@fusion-plugin-examples/alpha"));
    assert.equal(packageByName(plan.plannedPackages, "@fusion/core").buildReason, "force");
  });
});

test("plugin packages build when required outputs are missing even with a matching cache", () => {
  withWorkspace((root) => {
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const hash = computePluginSourceHash(plugin, root);
    const cache = { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: hash } } };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "missing-output");
  });
});

test("plugin packages build when no successful-build cache entry exists", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache: { version: BUILD_CACHE_VERSION, entries: {} } });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "no-cache");
  });
});

test("plugin packages build when tracked source files change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, plugin.dir, "src", "index.ts"), "export const alpha = 2;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when untracked plugin source files are present", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, plugin.dir, "src", "extra.ts"), "export const extra = true;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when declared workspace dependency files change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, "packages/core", "src", "index.ts"), "export const core = 2;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when root TypeScript/build-tooling inputs change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: false } }, null, 2));

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("invalid cache versions are ignored so plugins rebuild once", () => {
  withWorkspace((root) => {
    mkdirSync(path.join(root, ".fusion", "cache"), { recursive: true });
    writeFileSync(path.join(root, ".fusion", "cache", "plugin-build-cache.json"), JSON.stringify({ version: -1, entries: { stale: {} } }));

    assert.deepEqual(readPluginBuildCache(root), { version: BUILD_CACHE_VERSION, entries: {} });
  });
});

test("required outputs include source-export dist counterparts", () => {
  withWorkspace((root) => {
    mkdirSync(path.join(root, "plugins/fusion-plugin-beta", "src", "nested"), { recursive: true });
    writeFileSync(path.join(root, "plugins/fusion-plugin-beta", "src", "index.ts"), "export {};\n");
    writeFileSync(path.join(root, "plugins/fusion-plugin-beta", "src", "nested", "view.tsx"), "export {};\n");
    const outputs = requiredPluginOutputs(root, "plugins/fusion-plugin-beta", {
      exports: {
        ".": { types: "./src/index.d.ts", import: "./src/index.ts" },
        "./view": { types: "./src/nested/view.d.ts", import: "./src/nested/view.tsx" },
      },
    });

    assert.deepEqual(outputs, [
      "plugins/fusion-plugin-beta/dist/index.js",
      "plugins/fusion-plugin-beta/dist/nested/view.js",
    ]);
  });
});

test("root package build script points at the workspace build wrapper", () => {
  const rootPackage = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

  assert.equal(rootPackage.scripts.build, "node scripts/build-workspace.mjs");
});

test("CCC product acceptance recognizes permanent holds by stable machine code", () => {
  const reasonCode = "CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
  const machineReason = `ccc-permanent:${reasonCode}`;
  const source = readFileSync(path.resolve("scripts/ccc-prd-product-acceptance.mjs"), "utf8");

  assert.equal(
    workItemHasCccPermanentReason(
      { blockedReason: machineReason, lastError: machineReason },
      reasonCode,
    ),
    true,
  );
  assert.equal(
    workItemHasCccPermanentReason(
      {
        blockedReason: machineReason,
        lastError: `${machineReason}: exact human diagnostic`,
      },
      reasonCode,
    ),
    true,
  );
  assert.equal(
    workItemHasCccPermanentReason(
      {
        blockedReason: `${machineReason}_OTHER`,
        lastError: `${machineReason}: exact human diagnostic`,
      },
      reasonCode,
    ),
    false,
  );
  assert.equal(workItemHasCccPermanentReason(undefined, reasonCode), false);
  assert.doesNotMatch(
    source,
    /lastError\s*\n\s*=== "ccc-permanent:CCC_CAMPAIGN_(?:LIVE_EXECUTION|MERGE)_APPROVAL_REQUIRED"/,
  );
  assert.equal(
    source.match(/workItemHasCccPermanentReason\(/g)?.length,
    5,
    "all five approval-hold assertions must use the stable reason predicate",
  );
});

test("CCC product acceptance builds the current CLI through the root workspace build", () => {
  const source = readFileSync(path.resolve("scripts/ccc-prd-product-acceptance.mjs"), "utf8");
  const buildCurrentCli = extractFunctionSource(source, "buildCurrentCli");

  assert.match(
    buildCurrentCli,
    /await run\(\s*"pnpm",\s*\[\s*"build"\s*\],\s*\{\s*cwd: repoRoot,\s*timeoutMs: 300_000,\s*\}\s*\)/,
  );
  assert.doesNotMatch(
    buildCurrentCli,
    /"@fusion\/dashboard"/,
    "product acceptance must not bypass the root workspace build with a direct dashboard build",
  );
  assert.match(
    buildCurrentCli,
    /packages\/dashboard\/dist\/routes\/cli-agent-hooks\.js/,
    "dashboard server output assertion must remain part of the current-build proof",
  );
  assert.match(buildCurrentCli, /CCC_PRODUCT_STALE_DASHBOARD_BUILD/);
  assert.match(buildCurrentCli, /body\.type === "agent-turn-complete"/);
});

test("CCC product acceptance binds proof cutpoint markers to its owned temp root", () => {
  const source = readFileSync(path.resolve("scripts/ccc-prd-product-acceptance.mjs"), "utf8");
  const cleanEnvironment = extractFunctionSource(source, "cleanEnvironment");
  const readMarkers = extractFunctionSource(source, "readOwnedProofCutpointMarkers");
  const cleanupMarkers = extractFunctionSource(source, "cleanupOwnedProofCutpointMarkers");

  assert.doesNotMatch(
    cleanEnvironment,
    /TMPDIR/,
    "one-shot CLI commands must not share the served runtime's engine-socket temp root",
  );
  assert.match(
    source,
    /const serveEnv = Object\.freeze\(\{ \.\.\.env, TMPDIR: proofExecutionTmpRoot \}\)/,
    "served runtime must create semantic proof temp roots under the acceptance-owned temp root",
  );
  assert.match(
    source,
    /mkdtemp\(path\.join\(shortProofTmpParent, "ccc-prd-proof-"\)\)/,
    "the owned proof temp root must stay short enough for the macOS engine socket path",
  );
  assert.match(
    source,
    /cleanupOwnedProofExecutionTmpRoot\(proofExecutionTmpRoot\)/,
    "the separately owned short proof temp root must be removed on every exit",
  );
  assert.doesNotMatch(
    source,
    /await startServe\(targetRoot, env,/,
    "every served runtime must use the isolated server-only temp root",
  );
  assert.match(
    source,
    /readOwnedProofCutpointMarkers\(proofCutpointToken,\s*proofExecutionTmpRoot\)/,
    "proof cutpoint marker polling must read from the same temp root given to the served runtime",
  );
  assert.match(
    source,
    /cleanupOwnedProofCutpointMarkers\(\s*ownedProofCutpointToken,\s*proofExecutionTmpRoot,\s*\)/,
    "proof cutpoint cleanup must use the same owned temp root",
  );
  assert.match(
    readMarkers,
    /ccc-semantic-proof-execution-/,
    "proof cutpoint marker polling must discover the semantic proof execution root",
  );
  assert.match(
    readMarkers,
    /path\.join\(scratchRoot, "home"\)/,
    "semantic proof markers must come from the proof sandbox's scratch home",
  );
  assert.doesNotMatch(
    readMarkers,
    /fusion-verifier-sandbox-/,
    "semantic proof marker polling must not look in the ordinary readiness-verifier sandbox",
  );
  assert.match(
    source,
    /semanticProofId === 'PROOF-VERTICAL-VALUE-TASK'/,
    "the cutpoint hang must arm only inside the semantic proof process",
  );
  assert.match(
    source,
    /!semanticProofId && candidates\['src\/value\.txt'\]/,
    "the ordinary readiness verifier must accept the planted cutpoint candidate without hanging",
  );
  assert.doesNotMatch(
    cleanupMarkers,
    /\brm\(/,
    "marker cleanup must leave semantic proof roots for the final owned-root cleanup",
  );
});

test("CCC product acceptance gives the four-task fanout generous execution headroom", () => {
  const source = readFileSync(path.resolve("scripts/ccc-prd-product-acceptance.mjs"), "utf8");

  assert.match(
    source,
    /const fanoutCampaignMaxRequests = fanTasks\.length \* 4;/,
    "fanout request budget must provide four requests per provider task",
  );
  assert.match(
    source,
    /const fanoutCampaignMaxDurationMs = 480_000;/,
    "fanout campaign must have enough time for four sequential task and proof phases",
  );
  assert.match(
    source,
    /const fanoutCampaignMaxConcurrency = 2;/,
    "the two admitted branch tasks must be allowed to dispatch together",
  );
  assert.doesNotMatch(
    source,
    /const maxRequests = String\(fanTasks\.length\)/,
    "one request per fanout task is below the structural mutate-plus-repair floor",
  );
  assert.match(
    source,
    /"--max-requests",\s*String\(fanoutCampaignMaxRequests\),\s*"--max-duration-ms",\s*String\(fanoutCampaignMaxDurationMs\)/,
    "fanout authoring must use the same generous bounds as freeze and preview",
  );
  assert.match(
    source,
    /"--max-concurrency",\s*String\(fanoutCampaignMaxConcurrency\)/,
    "fanout freeze and authoring must share the admitted branch-width concurrency",
  );
});

test("CCC fanout verifier supports both readiness and semantic proof execution", () => {
  const source = readFileSync(path.resolve("scripts/ccc-prd-product-acceptance.mjs"), "utf8");
  const fanoutStart = source.indexOf('path.join(targetRoot, "verify-fanout.cjs")');
  const fanoutEnd = source.indexOf('path.join(targetRoot, "Taskfile.yml")', fanoutStart);
  const fanoutVerifier = source.slice(fanoutStart, fanoutEnd);

  assert.match(
    fanoutVerifier,
    /const semanticProofId = process\.env\.CCC_PROOF_ID;/,
    "semantic proof execution must keep using the controller-supplied proof identity",
  );
  assert.match(
    fanoutVerifier,
    /const proofId = semanticProofId \|\| localProofId;/,
    "ordinary required-commit readiness must infer the exact task proof from candidate paths",
  );
});

test("real CLI serial tsup build is recognized as bundled output only", () => {
  const packages = discoverWorkspacePackages(path.resolve("."));
  const cli = packageByName(packages, "@runfusion/fusion");

  assert.ok(cli, "expected to discover @runfusion/fusion");
  assert.ok(cli.requiredOutputs.includes("packages/cli/dist/bin.js"));
  assert.ok(cli.requiredOutputs.includes("packages/cli/dist/extension.js"));
  assert.equal(
    cli.requiredOutputs.includes("packages/cli/dist/commands/chat.js"),
    false,
    `serial tsup CLI build must not be treated as tsc source mirroring: ${cli.requiredOutputs.join(", ")}`,
  );
  assert.ok(
    cli.requiredOutputs.length < 20,
    `serial tsup CLI build should require only canonical bundled outputs, got ${cli.requiredOutputs.length}: ${cli.requiredOutputs.join(", ")}`,
  );
});

test("full package mode force-includes CLI even when content-hash would skip it", () => {
  const skipped = [
    { name: "@runfusion/fusion", isPlugin: false, buildReason: "unchanged", sourceHash: "abc" },
    { name: "@fusion/core", isPlugin: false, buildReason: "unchanged", sourceHash: "def" },
  ];
  const { plannedPackages, skippedPackages } = ensureFullPackageCliPlanned([], skipped, { fullPackage: true });
  assert.equal(plannedPackages.length, 1);
  assert.equal(plannedPackages[0].name, "@runfusion/fusion");
  assert.equal(plannedPackages[0].buildReason, "full-package");
  assert.deepEqual(skippedPackages.map((p) => p.name), ["@fusion/core"]);
});

test("full package mode is a no-op when CLI already planned", () => {
  const planned = [{ name: "@runfusion/fusion", buildReason: "changed-inputs" }];
  const skipped = [{ name: "@fusion/core", buildReason: "unchanged" }];
  const result = ensureFullPackageCliPlanned(planned, skipped, { fullPackage: true });
  assert.equal(result.plannedPackages.length, 1);
  assert.equal(result.plannedPackages[0].buildReason, "changed-inputs");
});

/*
FNXC:WorkspaceBuild 2026-08-06-00:00:
Regression coverage for the CI exit-137 build death. pnpm defaults to 4 concurrent workspace
package builds and nothing in this repo overrode that, so two `tsc` processes started at the same
timestamp inside a 2560 MiB runner container and the kernel OOM-killed one -- surfacing only as
exit 137 and a one-word "Killed". Pin the invariant at the point it broke: the spawned pnpm argv
MUST carry an explicit --workspace-concurrency, defaulting to serial, ahead of the `build` command.
*/
test("runPlannedBuilds caps pnpm workspace concurrency at 1 by default", () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };

  const result = runPlannedBuilds(
    [{ name: "@fusion/engine" }, { name: "@fusion/plugin-sdk" }],
    "/repo",
    spawnFn,
    { env: {} },
  );

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.ok(
    calls[0].args.includes("--workspace-concurrency=1"),
    `expected an explicit workspace-concurrency cap, got: ${calls[0].args.join(" ")}`,
  );
  // The flag is a pnpm option, not an argument to the package's build script.
  assert.ok(
    calls[0].args.indexOf("--workspace-concurrency=1") < calls[0].args.indexOf("build"),
    "workspace-concurrency must precede the build command",
  );
});

test("runPlannedBuilds honors FUSION_BUILD_WORKSPACE_CONCURRENCY and rejects unusable values", () => {
  const argvFor = (env) => {
    const calls = [];
    runPlannedBuilds([{ name: "@fusion/engine" }], "/repo", (command, args) => {
      calls.push(args);
      return { status: 0 };
    }, { env });
    return calls[0];
  };

  assert.ok(argvFor({ FUSION_BUILD_WORKSPACE_CONCURRENCY: "4" }).includes("--workspace-concurrency=4"));
  // Garbage degrades to the safe serial default rather than being forwarded to pnpm.
  for (const bad of ["", "0", "-2", "abc", "2.5"]) {
    assert.ok(
      argvFor({ FUSION_BUILD_WORKSPACE_CONCURRENCY: bad }).includes("--workspace-concurrency=1"),
      `expected fallback to serial for ${JSON.stringify(bad)}`,
    );
  }
});

test("resolveBuildWorkspaceConcurrency defaults to serial", () => {
  assert.equal(resolveBuildWorkspaceConcurrency({}), DEFAULT_BUILD_WORKSPACE_CONCURRENCY);
  assert.equal(DEFAULT_BUILD_WORKSPACE_CONCURRENCY, 1);
});

test("wantsFullCliPackage matches CLI packaging env rules", () => {
  assert.equal(wantsFullCliPackage({}, { fullFlag: false }), false);
  assert.equal(wantsFullCliPackage({}, { fullFlag: true }), true);
  assert.equal(wantsFullCliPackage({ CI: "true" }, { fullFlag: false }), true);
  assert.equal(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "1" }, { fullFlag: false }), true);
  assert.equal(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "0", CI: "true" }, { fullFlag: true }), false);
  assert.equal(wantsFullCliPackage({ npm_lifecycle_event: "prepack" }, { fullFlag: false }), true);
});
