import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const workspaceRoot = join(import.meta.dirname!, "..", "..", "..", "..");

function loadYamlFile(...pathParts: string[]): any {
  const path = join(workspaceRoot, ...pathParts);
  const content = readFileSync(path, "utf-8");
  const parsed = parse(content) as Record<string, unknown>;

  // Some YAML parsers treat the unquoted `on:` key as boolean `true`.
  // Normalize it so tests can consistently read `workflow.on`.
  if (parsed && parsed.on === undefined) {
    (parsed as any).on = (parsed as any)["on"] ?? (parsed as any).true ?? (parsed as any)["true"];
  }

  return { content, parsed };
}

function loadWorkflow(name: string): any {
  return loadYamlFile(".github", "workflows", name);
}

// Every postgres service container runs inside the M2 Colima VM next to the
// capped runner containers; without its own cap it is the only uncapped
// memory consumer in the VM. Keep every declared service pinned.
function expectPostgresServiceCapped(workflow: any) {
  const jobs = Object.entries(workflow.jobs ?? {}) as Array<[string, any]>;
  const withPostgres = jobs.filter(([, job]) => job?.services?.postgres);
  expect(withPostgres.length).toBeGreaterThan(0);
  for (const [name, job] of withPostgres) {
    const options = String(job.services.postgres.options ?? "");
    expect(options, `${name}.services.postgres.options`).toMatch(/--memory 1g\b/);
    expect(options, `${name}.services.postgres.options`).toMatch(/--cpus 1\b/);
  }
}

function findCompositeSetupStep(steps: any[]) {
  return steps.find((step) => step.uses === "./.github/actions/setup-node-pnpm");
}

function findSetupJavaStep(steps: any[]) {
  return steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-java@"));
}

function resolveCapacitorAndroidGradlePath(): string {
  const primaryPath = join(
    workspaceRoot,
    "packages",
    "mobile",
    "node_modules",
    "@capacitor",
    "android",
    "capacitor",
    "build.gradle",
  );
  if (existsSync(primaryPath)) {
    return primaryPath;
  }

  const pnpmStoreCandidates = [
    join(workspaceRoot, "node_modules", ".pnpm"),
    join(workspaceRoot, "packages", "mobile", "node_modules", ".pnpm"),
  ];

  for (const pnpmStore of pnpmStoreCandidates) {
    if (!existsSync(pnpmStore)) {
      continue;
    }

    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith("@capacitor+android@")) {
        continue;
      }

      const candidate = join(
        pnpmStore,
        entry,
        "node_modules",
        "@capacitor",
        "android",
        "capacitor",
        "build.gradle",
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Unable to resolve @capacitor/android capacitor/build.gradle from packages/mobile/node_modules or the pnpm store",
  );
}

function readCapacitorAndroidSourceCompatibilityMajor(): number {
  const gradleContent = readFileSync(resolveCapacitorAndroidGradlePath(), "utf-8");
  const match = gradleContent.match(/sourceCompatibility\s+JavaVersion\.VERSION_(\d+)/);
  if (!match) {
    throw new Error("Unable to parse @capacitor/android sourceCompatibility JavaVersion.VERSION_<major>");
  }
  return Number.parseInt(match[1], 10);
}

function expectAndroidBuildJobJavaVersionAtLeast(workflow: any, workflowName: string, minimumJavaVersion: number) {
  const buildAndroidJob = workflow.jobs?.["build-android"];
  expect(buildAndroidJob, `${workflowName} must define a build-android job`).toBeDefined();

  const setupJavaStep = findSetupJavaStep(buildAndroidJob?.steps ?? []);
  expect(setupJavaStep, `${workflowName} build-android must provision Java`).toBeDefined();
  expect(setupJavaStep.name).toBe("Setup Java 21");

  const javaVersion = setupJavaStep.with?.["java-version"];
  expect(javaVersion, `${workflowName} build-android must pin JDK 21`).toBe("21");
  expect(Number.parseInt(javaVersion, 10), `${workflowName} JDK must satisfy @capacitor/android sourceCompatibility`).toBeGreaterThanOrEqual(
    minimumJavaVersion,
  );
}

describe("Merge gate (.github/workflows/pr-checks.yml)", () => {
  let workflow: any;
  let content: string;
  let compositeAction: any;
  let contributingContent: string;
  let readmeContent: string;
  let rootPackageJson: any;
  let enginePackageJson: any;
  let cliPackageJsonContent: string;
  let engineVitestConfigContent: string;
  let extensionSuiteContent: string;
  let agentExportSuiteContent: string;
  let buildExeSuiteContent: string;

  beforeAll(() => {
    const result = loadWorkflow("pr-checks.yml");
    workflow = result.parsed;
    content = result.content;
    compositeAction = loadYamlFile(".github", "actions", "setup-node-pnpm", "action.yml").parsed;
    contributingContent = readFileSync(join(workspaceRoot, "docs", "contributing.md"), "utf-8");
    readmeContent = readFileSync(join(workspaceRoot, "README.md"), "utf-8");
    rootPackageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf-8"));
    enginePackageJson = JSON.parse(readFileSync(join(workspaceRoot, "packages", "engine", "package.json"), "utf-8"));
    cliPackageJsonContent = readFileSync(join(workspaceRoot, "packages", "cli", "package.json"), "utf-8");
    engineVitestConfigContent = readFileSync(join(workspaceRoot, "packages", "engine", "vitest.config.ts"), "utf-8");
    extensionSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "__tests__", "extension-integration.test.ts"),
      "utf-8",
    );
    agentExportSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "commands", "__tests__", "agent-export.test.ts"),
      "utf-8",
    );
    buildExeSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "__tests__", "build-exe-cross.test.ts"),
      "utf-8",
    );
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("runs on pull requests targeting main and ONLY there", () => {
    expect(workflow.on?.pull_request?.branches).toContain("main");
    // Post-merge signal lives in full-suite.yml; the gate workflow must not
    // double-run on push (that conflates blocking and non-blocking surfaces).
    expect(workflow.on?.push).toBeUndefined();
  });

  it("blocks PRs on exactly lint, typecheck, build, and gate", () => {
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(["build", "gate", "lint", "typecheck"]);
  });

  it("routes every blocking job to the dedicated local Fusion runners", () => {
    for (const jobName of ["lint", "typecheck", "build"]) {
      expect(workflow.jobs?.[jobName]?.["runs-on"]).toEqual([
        "self-hosted",
        "linux",
        "ARM64",
        "ccc-fusion",
      ]);
    }
    // The gate runs the verifier-confinement readiness probe, which needs a
    // runner whose container permits full-capability unprivileged user
    // namespaces for bubblewrap. Only the ccc-fusion-bwrap runner lane
    // provides that; the general ccc-fusion lane refuses namespace creation.
    expect(workflow.jobs?.gate?.["runs-on"]).toEqual([
      "self-hosted",
      "linux",
      "ARM64",
      "ccc-fusion-bwrap",
    ]);
    expect(content).not.toContain("ubuntu-latest");
  });

  it("keeps the Gate timeout bounded for cold constrained runners", () => {
    expect(workflow.jobs?.gate?.["timeout-minutes"]).toBe(25);
  });

  it("does not enable setup-node pnpm cache when dependency install is skipped", () => {
    const setupNodeSteps = (compositeAction.runs?.steps ?? []).filter(
      (step: any) => step.uses === "actions/setup-node@v5",
    );
    const cachedSetup = setupNodeSteps.find((step: any) => step.with?.cache === "pnpm");
    const uncachedSetup = setupNodeSteps.find((step: any) => step.with?.cache === undefined);

    expect(cachedSetup?.if).toBe("${{ inputs.skip-install != 'true' }}");
    expect(uncachedSetup?.if).toBe("${{ inputs.skip-install == 'true' }}");
    expect(uncachedSetup?.with?.["package-manager-cache"]).toBe(false);
    expect(uncachedSetup?.with?.["node-version"]).toBe("${{ inputs.node-version }}");
    expect(uncachedSetup?.with?.["registry-url"]).toBe("${{ inputs.registry-url }}");
  });

  it("contains no shard matrix or full-suite invocation (demoted to full-suite.yml)", () => {
    expect(workflow.jobs?.["test-shards"]).toBeUndefined();
    expect(workflow.jobs?.["test-slow"]).toBeUndefined();
    expect(workflow.jobs?.["test-inventory-guard"]).toBeUndefined();
    expect(content).not.toContain("test:ci:shard");
    expect(content).not.toContain("run: pnpm test\n");
    expect(content).not.toContain("pnpm verify:workspace");
  });

  it("gate job runs boot smoke and the dedicated test:gate command", () => {
    const gateSteps = workflow.jobs?.gate?.steps ?? [];
    expect(
      gateSteps.some(
        (step: any) => typeof step.run === "string" && step.run.includes("node scripts/boot-smoke.mjs"),
      ),
    ).toBe(true);
    // The gate must use the dedicated command — `pnpm test` routes through
    // scripts/test-changed.mjs whose selection semantics are for local runs.
    expect(
      gateSteps.some(
        (step: any) => typeof step.run === "string" && step.run.includes("pnpm test:gate"),
      ),
    ).toBe(true);
  });

  it("fails fast on real verifier confinement readiness after build and before acceptance", () => {
    const gateSteps = workflow.jobs?.gate?.steps ?? [];
    const buildIndex = gateSteps.findIndex((step: any) => step.name === "Build");
    const readinessIndex = gateSteps.findIndex(
      (step: any) => step.name === "Verifier confinement readiness",
    );
    const bootSmokeIndex = gateSteps.findIndex(
      (step: any) => step.name === "Boot smoke (app starts and serves)",
    );
    const gateTestsIndex = gateSteps.findIndex(
      (step: any) => step.name === "Gate tests (engine-core + CCC PRD safety + CI-shape)",
    );

    expect(readinessIndex).toBeGreaterThan(buildIndex);
    expect(readinessIndex).toBeLessThan(bootSmokeIndex);
    expect(readinessIndex).toBeLessThan(gateTestsIndex);
    expect(gateSteps[readinessIndex]?.run).toBe(
      "node scripts/check-verifier-confinement.mjs",
    );

    // The readiness probe fails closed without Go Task on PATH and bubblewrap
    // at a trusted path; the runner image ships neither, so the job must
    // install the toolchain after Build and before the probe.
    const toolchainIndex = gateSteps.findIndex(
      (step: any) => step.name === "Install verifier toolchain (Go Task + bubblewrap)",
    );
    expect(toolchainIndex).toBeGreaterThan(buildIndex);
    expect(toolchainIndex).toBeLessThan(readinessIndex);
  });

  it("caps every PostgreSQL service container's memory and CPU", () => {
    expectPostgresServiceCapped(workflow);
  });

  it("keeps the PostgreSQL service off the laptop's fixed 5432 tunnel", () => {
    expect(workflow.jobs?.gate?.services?.postgres?.ports).toEqual(["5432/tcp"]);
    const gateTestStep = (workflow.jobs?.gate?.steps ?? []).find(
      (step: any) => step.name === "Gate tests (engine-core + CCC PRD safety + CI-shape)",
    );
    expect(gateTestStep?.env?.FUSION_PG_TEST_URL_BASE).toContain(
      "host.docker.internal:${{ job.services.postgres.ports[5432] }}",
    );
  });

  /*
  FNXC:CIFastGate 2026-09-03:
  Measured ground truth (run 33738197262 on 9ed3acc02): Gate paid ~5 min of its ~8 min
  slot time on a redundant `pnpm build` because its dist-cache key missed on every PR
  whose sources differ from main, and its path list omitted packages/cli/dist anyway —
  so a HIT could never make boot-smoke's `packages/cli/bin.mjs` valid. Build already
  does the identical `pnpm build` first; publish its FULL dist set (Build's existing
  Gate-mirrored list PLUS packages/cli/dist, which boot-smoke and ensure-test-artifacts.mjs
  REQUIRED_BUILD_PACKAGES both need, PLUS plugins/fusion-plugin-compound-engineering/dist,
  which REQUIRED_BUILD_PACKAGES also needs but the OLD Gate cache list omitted) and have
  Gate restore that exact set instead of rebuilding it. Exact-match key only, no
  restore-keys (stale dist is the known failure mode, FN-4232/FN-4605).
  packages/i18n was NOT added despite the plan's initial text: it has no "build" script
  and its exports resolve straight to ./src/*.ts (source-only workspace package), so
  `pnpm build` never produces packages/i18n/dist — verified via packages/i18n/package.json.

  Adjudicated critique (2026-09-03), two corrections to the first cut:

  1. Key on ${{ github.sha }}, not a source-hash. ensure-test-artifacts.mjs's
     --print-source-hash only covers REQUIRED_BUILD_PACKAGES' source dirs, so a
     commit that changes an un-hashed path (packages/i18n, an unbundled plugin,
     etc.) would keep the SAME hash as an unrelated commit and Gate could restore
     a stale dist saved by that other commit's Build run. Keying on the literal
     commit sha makes save/restore commit-exact: within one PR-check run, Gate
     (needs: build) restores under the SAME github.sha Build just saved under, so
     the restore is guaranteed to be this exact commit's own output — never
     another commit's. A rerun of the same commit still hits; any other commit
     runs its own Build first, so Gate is never handed a save it doesn't own.
  2. Gate's `pnpm build` fallback must be conditional on a MISS, not run
     unconditionally as a harmless no-op on a HIT. Verified two independent
     reasons `pnpm build` is NOT a fast skip even with dist fully restored:
     - build-workspace.mjs's OWN skip-cache lives at
       .fusion/cache/plugin-build-cache.json (BUILD_CACHE_FILE), which is
       git-ignored (see .gitignore) and NOT the same file
       --seed-artifact-cache writes (that's ensure-test-artifacts.mjs's
       separate artifact-cache.json, consumed only by ensureTestArtifacts(),
       which none of test:gate's actual constituent package.json scripts call).
       On a fresh checkout that file doesn't exist, so evaluatePackageBuild's
       cache lookup always returns "no-cache" => shouldBuild: true for every
       package, restored dist or not.
     - wantsFullCliPackage() in packages/cli/tsup.config.ts treats CI=true as
       an implicit --full regardless of any cache state, and
       ensureFullPackageCliPlanned() then force-includes @runfusion/fusion in
       the planned build even when its own cache entry says "unchanged" — so
       the CLI's full tsup packaging pass (which is the pass that risks the
       nested desktop OOM) runs on every Gate `pnpm build` invocation
       regardless of the dist restore.
     So: the "Build" step is now `if: steps.dist-cache.outputs.cache-hit != 'true'`
     (today's full-build behavior, unchanged, on a genuine miss). A single
     unconditional `--assert-artifacts-present` step after the conditional
     Build step proves the required dist is actually present on EITHER path
     (hit or miss) before boot-smoke/gate-tests run, with a clear failure
     message instead of an opaque "file not found" deep inside boot-smoke or
     a test.
  3. Desktop OOM fix (Build job only, as of this cut) is unchanged from the
     first cut and already evidence-backed: packages/cli/tsup.config.ts line
     ~346, ensureDesktopRuntimeAssetsBuilt() — `if (existsSync(desktopRuntimeSrc)) return;`
     where desktopRuntimeSrc = packages/desktop/dist. Building desktop as its
     own standalone step before `pnpm build` makes that check true, so the
     nested `pnpm --filter @fusion/desktop build` child (which shares the 2.5
     GiB container with the still-live parent tsup process) never spawns.
     packages/desktop/scripts/build.ts (via workspace-tools.ts) is fully
     self-contained — it builds its own @fusion/core / @fusion/engine /
     dashboard-runtime dist internally — so it needs nothing pre-built to run
     standalone. Heap stays at the desktop-packaging.yml-proven-safe 1664 MB;
     it is not raised (a bigger nested child would still get OOM-killed inside
     the same shared cgroup, not rescued by a higher per-process ceiling). See
     the pre-merge review round below for why Gate later gets the same step.
  4. `needs: build` means Gate enters the shared two-slot cross-repo admission
     queue only AFTER Build releases its own slot — so worst-case wall clock
     under heavy cross-repo contention is unchanged (~15 min observed), while
     the common case (queue not contended) drops from ~15 min toward ~11 min
     (Build ~8 min + Gate ~3 min on a restore hit) and total slot-minutes fall
     by Gate's old ~5 min redundant build (~27.5 -> ~22.5 across the two jobs).

  Pre-merge review round (2026-09-03), two more corrections before merge:

  5. Gate's own `pnpm build` miss-path fallback has the SAME nested-OOM shape
     as the original Build-job bug (CI's full CLI packaging mode spawns
     `pnpm --filter @fusion/desktop build` as a child of the still-live CLI
     tsup process) — a prior cut of this PR left that unfixed on Gate as an
     "accepted, rare-path" gap. Reviewed and reversed: isolating the nested
     spawn costs nothing (the step is gated on the same cache-miss condition,
     so it doesn't run at all on the common hit path), so Gate now gets its
     own standalone "Build desktop runtime" step too, immediately before its
     conditional "Build" step, same `if` condition. Unlike Build's copy it
     carries NO NODE_OPTIONS cap: Gate runs on the ccc-fusion-bwrap lane's
     4 GiB container, not Build's 2.5 GiB, so there is no proven heap ceiling
     to pin here the way desktop-packaging.yml pins Build's 1664 MB.
  6. Dropped .fusion/cache/plugin-build-cache.json from both Build's saved and
     Gate's restored path list. It was added on the (wrong) premise that a
     restore hit would give Gate real "already built" provenance for
     build-workspace.mjs — but Gate's own `pnpm build` never runs on a hit at
     all (see point 2), so a hit never reads that file, and on a miss nothing
     restored it in the first place. Caching it only produced a false
     "already built" record for the ~9 plugin packages that are NOT in this
     10 (now 9)-path dist list — actively misleading if build-workspace.mjs
     were ever invoked again downstream of Gate. Also verified by grep
     (scripts/boot-smoke.mjs, scripts/check-verifier-confinement.mjs, and
     every test file `test:gate` actually runs — engine's engine-core
     project, core's test:pg-gate pair, and the four test:ccc-prd-safety
     suites) that nothing in Gate's own scope reads any `plugins/<name>/dist`
     outside the 5 already in this list: plugin packages resolve through
     vitest path aliases (packages/cli/vitest.config.ts,
     packages/droid-cli/vitest.config.ts) straight to `src/`, not `dist/`,
     everywhere test:gate's suites touch them; the one real dynamic
     `import("@fusion-plugin-examples/claude-runtime")` in the repo
     (packages/cli/src/__tests__/vitest-workspace-resolution.test.ts) is not
     part of test:gate's invocation chain.
  */
  it("makes Gate depend on Build and restore Build's commit-exact dist cache instead of rebuilding it", () => {
    // Canonical order matches full-suite.yml's fusion-dist-v2- list (same
    // REQUIRED_BUILD_PACKAGES-derived set) so a reader comparing both cache
    // contracts sees one consistent shape. No build-workspace.mjs skip-cache
    // file rides alongside — see point 6 above for why that was dropped.
    const requiredDistPaths = [
      "packages/core/dist",
      "packages/dashboard/dist",
      "packages/engine/dist",
      "packages/cli/dist",
      "packages/plugin-sdk/dist",
      "plugins/fusion-plugin-dependency-graph/dist",
      "plugins/fusion-plugin-hermes-runtime/dist",
      "plugins/fusion-plugin-openclaw-runtime/dist",
      "plugins/fusion-plugin-paperclip-runtime/dist",
      "plugins/fusion-plugin-compound-engineering/dist",
    ];
    const expectedKey = "fusion-pr-dist-v1-${{ runner.os }}-${{ runner.arch }}-${{ github.sha }}";

    const gateNeeds = Array.isArray(workflow.jobs?.gate?.needs)
      ? workflow.jobs.gate.needs
      : [workflow.jobs?.gate?.needs];
    expect(gateNeeds).toContain("build");

    const buildSteps = workflow.jobs?.build?.steps ?? [];
    const gateSteps = workflow.jobs?.gate?.steps ?? [];

    const buildSave = buildSteps.find((step: any) => step.uses === "actions/cache/save@v4");
    const gateRestore = gateSteps.find((step: any) => step.uses === "actions/cache/restore@v4");
    // The Gate job must no longer use the plain (restore-or-save) cache action —
    // Build owns saving now, so Gate only ever restores.
    const gatePlainCache = gateSteps.find((step: any) => step.uses === "actions/cache@v4");

    expect(buildSave, "Build must save its dist artifacts").toBeDefined();
    expect(gateRestore, "Gate must restore the dist artifacts Build saved").toBeDefined();
    expect(gatePlainCache).toBeUndefined();

    expect(buildSave.with?.path.trim().split("\n")).toEqual(requiredDistPaths);
    expect(gateRestore.with?.path.trim().split("\n")).toEqual(requiredDistPaths);
    expect(buildSave.with?.path).not.toContain("node_modules");
    expect(gateRestore.with?.path).not.toContain("node_modules");

    // Commit-exact key, not a source-hash: a source-hash key could collide
    // across two unrelated commits that happen to leave REQUIRED_BUILD_PACKAGES
    // untouched, handing Gate a stale save from a different commit.
    expect(buildSave.with?.key).toBe(expectedKey);
    expect(gateRestore.with?.key).toBe(expectedKey);
    expect(buildSave.with?.["restore-keys"]).toBeUndefined();
    expect(gateRestore.with?.["restore-keys"]).toBeUndefined();

    // Graceful degrade, not a hard failure: Gate keeps its own `pnpm build` as a
    // fallback on a genuine miss, so it must NOT set fail-on-cache-miss.
    expect(gateRestore.with?.["fail-on-cache-miss"]).not.toBe(true);

    const restoreIndex = gateSteps.indexOf(gateRestore);
    const seedIndex = gateSteps.findIndex(
      (step: any) => step.run === "node scripts/ensure-test-artifacts.mjs --seed-artifact-cache",
    );
    const gateBuildStep = gateSteps.find(
      (step: any) => step.name === "Build" && step.run === "pnpm build",
    );
    const gateBuildIndex = gateSteps.indexOf(gateBuildStep);
    const assertIndex = gateSteps.findIndex(
      (step: any) => step.run === "node scripts/ensure-test-artifacts.mjs --assert-artifacts-present",
    );
    const readinessIndex = gateSteps.findIndex(
      (step: any) => step.name === "Verifier confinement readiness",
    );

    expect(seedIndex).toBeGreaterThan(restoreIndex);
    expect(gateBuildIndex).toBeGreaterThan(seedIndex);
    expect(gateSteps[seedIndex]?.if).toBe("steps.dist-cache.outputs.cache-hit == 'true'");

    // The real fix: `pnpm build` must NOT run unconditionally on a hit — it is
    // not a fast skip (build-workspace.mjs's own cache file is empty on a
    // fresh checkout regardless of dist, and wantsFullCliPackage() force-plans
    // the CLI's full tsup pass under CI=true either way) — so it would silently
    // redo the whole Build-job build inside Gate even when dist was restored.
    expect(gateBuildStep?.if).toBe("steps.dist-cache.outputs.cache-hit != 'true'");

    // A single unconditional assertion proves the required dist is actually
    // present on EITHER path (hit or the just-ran miss-build) before the
    // verifier/boot-smoke/gate-tests steps that need it.
    expect(assertIndex).toBeGreaterThan(gateBuildIndex);
    expect(assertIndex).toBeLessThan(readinessIndex);
    expect(gateSteps[assertIndex]?.if).toBeUndefined();

    // Pre-merge review point 5: Gate's miss-path fallback build gets the SAME
    // desktop-isolation treatment as Build, gated on the identical cache-miss
    // condition, immediately before Gate's own conditional "Build" step —
    // and, unlike Build's copy, no NODE_OPTIONS cap (Gate's 4 GiB
    // ccc-fusion-bwrap container has no proven-safe ceiling to pin here).
    const gateDesktopStep = gateSteps.find(
      (step: any) => step.run === "pnpm --filter @fusion/desktop build",
    );
    const gateDesktopIndex = gateSteps.indexOf(gateDesktopStep);
    expect(gateDesktopIndex).toBeGreaterThan(-1);
    expect(gateDesktopIndex).toBeLessThan(gateBuildIndex);
    expect(gateDesktopStep?.if).toBe("steps.dist-cache.outputs.cache-hit != 'true'");
    expect(gateDesktopStep?.env?.NODE_OPTIONS).toBeUndefined();
  });

  /*
  FNXC:CITestGate 2026-06-26-06:40:
  The merge gate is the thin trusted CI surface. ci-workflow.test.ts must pin not only that the Gate job invokes `pnpm test:gate`, but also test:gate's internal composition (guards + engine test:core + cli test:ci-shape) and that engine test:core references the engine-core vitest project — otherwise a rename could hollow the gate while this CI-shape test stays green (FN-7059).
  */
  it("pins test:gate to the audited guard scripts and curated suites", () => {
    const testGateScript = rootPackageJson.scripts?.["test:gate"] ?? "";
    const cccPrdSafetyScript = rootPackageJson.scripts?.["test:ccc-prd-safety"] ?? "";

    expect(testGateScript).toContain("node scripts/check-no-" + "no" + "hup" + ".mjs"); // process-supervisor-allowlist: asserts the gate wires the checker; not a real spawn
    expect(testGateScript).toContain("node scripts/check-no-kill-" + "40" + "40" + ".mjs"); // port-4040-allowlist: asserts the gate wires the checker; not a real port bind
    expect(testGateScript).toContain("node scripts/check-no-test-timeout-appeasement.mjs");
    expect(testGateScript).toContain("node scripts/check-changeset-format.mjs");
    expect(testGateScript).toContain("pnpm --filter @fusion/engine test:core");
    expect(testGateScript).toContain("pnpm --filter @fusion/core test:pg-gate");
    expect(testGateScript).toContain("pnpm --filter @runfusion/fusion test:ci-shape");
    expect(testGateScript).toContain("pnpm test:ccc-prd-safety");
    expect(cccPrdSafetyScript).toContain("src/__tests__/process-supervisor.test.ts");
    expect(cccPrdSafetyScript).toContain("src/__tests__/run-verification-command.test.ts");
    expect(cccPrdSafetyScript).toContain("src/__tests__/ccc-campaign-proof-execution.test.ts");
    expect(cccPrdSafetyScript).toContain("src/commands/__tests__/prd.test.ts");
    expect(cccPrdSafetyScript).toContain("src/__tests__/postgres/ccc-prd-product-status.pg.test.ts");
    expect(cccPrdSafetyScript).toContain("--config vitest.pg.config.ts");
  });

  it("pins engine test:core to the engine-core vitest project", () => {
    expect(enginePackageJson.scripts?.["test:core"] ?? "").toContain("--project=engine-core");
    expect(engineVitestConfigContent).toContain('name: "engine-core"');
  });

  it("pins dependency bootstrap to frozen lockfile in every job", () => {
    for (const jobName of ["lint", "typecheck", "build", "gate"]) {
      expect(findCompositeSetupStep(workflow.jobs?.[jobName]?.steps ?? [])).toBeDefined();
    }
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
    expect(compositeAction.inputs?.["install-args"]?.default).toBe("--frozen-lockfile");
  });

  it("caps memory on Typecheck, Build, and the desktop pre-build command steps", () => {
    const heapLimit = "--max-old-space-size=1664";
    const typecheckStep = (workflow.jobs?.typecheck?.steps ?? []).find(
      (step: any) => step.name === "Typecheck" && step.run === "pnpm typecheck",
    );
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    const buildStep = buildSteps.find(
      (step: any) => step.name === "Build" && step.run === "pnpm build",
    );
    const desktopPrebuildStep = buildSteps.find(
      (step: any) => step.run === "pnpm --filter @fusion/desktop build",
    );

    expect(typecheckStep?.env?.NODE_OPTIONS).toBe(heapLimit);
    expect(buildStep?.env?.NODE_OPTIONS).toBe(heapLimit);
    // FNXC:CIFastGate 2026-09-03: the desktop pre-build step carries the SAME
    // proven-safe cap as desktop-packaging.yml (which runs this exact command
    // alone and passes) rather than a raised job-wide heap — see the OOM test
    // below for why it must run standalone instead.
    expect(desktopPrebuildStep?.env?.NODE_OPTIONS).toBe(heapLimit);
    expect(workflow.env?.NODE_OPTIONS).toBeUndefined();
    expect(workflow.jobs?.typecheck?.env?.NODE_OPTIONS).toBeUndefined();
    expect(workflow.jobs?.build?.env?.NODE_OPTIONS).toBeUndefined();

    for (const jobName of ["lint", "gate"]) {
      const job = workflow.jobs?.[jobName];
      expect(job?.env?.NODE_OPTIONS, `${jobName} must not receive the build heap cap`).toBeUndefined();
      expect(
        (job?.steps ?? []).every((step: any) => step.env?.NODE_OPTIONS === undefined),
        `${jobName} steps must not receive the build heap cap`,
      ).toBe(true);
    }
  });

  /*
  FNXC:CIFastGate 2026-09-03:
  PR Checks run 33704433491 OOMed the Build job: `[desktop:build] vite build --base ./`
  hit "Ineffective mark-compacts near heap limit" inside `@runfusion/fusion build:
  build:tsup:serial`. Root cause: CI always runs the CLI's tsup build in "full package"
  mode (wantsFullCliPackage() treats CI=true as an implicit --full), and full-package
  mode stages the desktop Electron runtime by spawning `pnpm --filter @fusion/desktop
  build` as a CHILD of the still-live CLI tsup process (packages/cli/tsup.config.ts
  ensureDesktopRuntimeAssetsBuilt, invoked from onSuccess — see
  packages/cli/scripts/ensure-desktop-runtime.ts and desktopRuntimeSrc). Both
  processes inherit NODE_OPTIONS and can be resident at once inside the runner's
  2.5 GiB container cap (whose own processes already use ~640 MiB).
  desktop-packaging.yml proves the SAME 1664 MB cap is sufficient for
  `pnpm --filter @fusion/desktop build` run ALONE. The fix is to build desktop as
  its own standalone step before `pnpm build`: ensureDesktopRuntimeAssetsBuilt()
  short-circuits on existsSync(packages/desktop/dist), so the nested spawn (and the
  two-process memory contention that caused the OOM) never happens.
  */
  it("builds the desktop runtime standalone before Build, so CLI full packaging never nests a second live Node heap", () => {
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    const desktopPrebuildIndex = buildSteps.findIndex(
      (step: any) => step.run === "pnpm --filter @fusion/desktop build",
    );
    const buildIndex = buildSteps.findIndex(
      (step: any) => step.name === "Build" && step.run === "pnpm build",
    );

    expect(desktopPrebuildIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(desktopPrebuildIndex).toBeLessThan(buildIndex);
  });

  it("keeps lint as install + lint only, without Bun/setup build coupling", () => {
    const lintSteps = workflow.jobs?.lint?.steps ?? [];
    expect(
      lintSteps.some(
        (step: any) =>
          typeof step.uses === "string" && step.uses.includes("./.github/actions/setup-node-pnpm"),
      ),
    ).toBe(true);
    expect(
      lintSteps.some((step: any) => step.name === "Lint" && typeof step.run === "string" && step.run.includes("pnpm lint")),
    ).toBe(true);
    expect(
      lintSteps.some(
        (step: any) =>
          step.name === "Install Bun" ||
          (typeof step.uses === "string" && step.uses.includes("oven-sh/setup-bun")) ||
          (typeof step.run === "string" && step.run.includes("pnpm build")),
      ),
    ).toBe(false);
  });

  it("keeps build coverage as an explicit Node/pnpm PR gate", () => {
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    expect(findCompositeSetupStep(buildSteps)).toBeDefined();
    expect(
      buildSteps.some(
        (step: any) =>
          step.name === "Install Bun" ||
          (typeof step.uses === "string" && step.uses.includes("oven-sh/setup-bun")),
      ),
    ).toBe(false);
    expect(
      buildSteps.some(
        (step: any) => step.name === "Build" && typeof step.run === "string" && step.run.includes("pnpm build"),
      ),
    ).toBe(true);
  });

  it("keeps contributing docs aligned with the gate contract", () => {
    expect(contributingContent).toContain("pnpm test:full` must be runnable in a clean worktree without requiring a prior `pnpm build`.");
    expect(contributingContent).toContain("`pnpm test:gate` is the merge gate");
    expect(contributingContent).toContain("`pnpm verify:workspace` is the deep opt-in verification (not the merge gate)");
    expect(contributingContent).toContain("1. `pnpm lint`");
    expect(contributingContent).toContain("2. `pnpm test:full`");
    expect(contributingContent).toContain("3. `pnpm build`");
    expect(contributingContent).toContain("`pnpm test` now uses a changed-only entrypoint");

    expect(contributingContent).toContain("pnpm test:slow-cli");
    expect(contributingContent).toContain("test:pre-release");
    expect(contributingContent).toContain("test:extension-integration");
  });

  it("keeps docs aligned with default and explicit build commands", () => {
    expect(readmeContent).toContain("pnpm build                    # Build default workspace packages (excludes desktop/mobile)");
    expect(readmeContent).toContain("pnpm build:all                # Build all packages (including desktop/mobile)");

    expect(contributingContent).toContain("pnpm build      # default build (excludes desktop/mobile)");
    expect(contributingContent).toContain("pnpm build:all  # full recursive build including desktop/mobile");
  });

  it("keeps explicit gating for audited CLI integration suites", () => {
    expect(cliPackageJsonContent).toContain('"test:slow-cli"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_SLOW_CLI=1");
    expect(cliPackageJsonContent).toContain('"test:extension-integration"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_EXTENSION_INTEGRATION=1");
    expect(cliPackageJsonContent).toContain("extension-integration.test.ts");
    expect(cliPackageJsonContent).toContain('"test:build-exe"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_BUILD_EXE=1");

    expect(extensionSuiteContent).toContain("describe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)");
    expect(extensionSuiteContent).toContain("FUSION_TEST_EXTENSION_INTEGRATION");
    expect(extensionSuiteContent).toContain("dist/extension.js");

    expect(agentExportSuiteContent).toContain("describe.skipIf(!SHOULD_RUN_SLOW_CLI)");
    expect(agentExportSuiteContent).toContain("FUSION_TEST_SLOW_CLI");

    expect(buildExeSuiteContent).toContain('process.env.FUSION_TEST_BUILD_EXE === "1"');
    expect(buildExeSuiteContent).toContain('process.env.FUSION_TEST_BUILD_EXE === "true"');
    expect(buildExeSuiteContent).not.toContain("Boolean(process.env.FUSION_TEST_BUILD_EXE)");
  });

  it("the deleted manual CI workflow stays deleted", () => {
    // ci.yml was the trigger-disabled (FN-1541) 3-shard manual workflow; the
    // merge-gate redesign removed it. Reintroducing it would resurrect a
    // second, drift-prone definition of the test pipeline.
    expect(() => loadWorkflow("ci.yml")).toThrow();
  });
});

describe("Canonical Fusion runner verifier contract", () => {
  let dockerfile: string;
  let readinessScript: string;

  beforeAll(() => {
    dockerfile = readFileSync(join(workspaceRoot, ".github", "runner", "Dockerfile"), "utf-8");
    readinessScript = readFileSync(
      join(workspaceRoot, "scripts", "check-verifier-confinement.mjs"),
      "utf-8",
    );
  });

  it("provisions bubblewrap and a checksum-bound ARM64 Go Task binary", () => {
    expect(dockerfile).toMatch(/apt-get install[^;]*\bbubblewrap\b/s);
    expect(dockerfile).toContain("ARG GO_TASK_VERSION=3.51.1");
    expect(dockerfile).toContain(
      "ARG GO_TASK_LINUX_ARM64_SHA256=49c58bb00eff2449a5553f3b3e694fc424e0dc04d5c669d8831126daee1000f8",
    );
    expect(dockerfile).toContain("task_linux_arm64.tar.gz");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain("task --version");
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/);
  });

  it("runs the built engine's functional readiness probe and fails closed", () => {
    expect(readinessScript).toContain('../packages/engine/dist/index.js');
    expect(readinessScript).toContain("inspectVerifierConfinementReadiness");
    expect(readinessScript).toContain("JSON.stringify");
    expect(readinessScript).toMatch(/process\.exitCode\s*=\s*1/);
    expect(readinessScript).toMatch(/slice\(0,\s*\d+\)/);
    expect(readinessScript).not.toContain("fallback");
  });

  it("functionally refuses a runner that lacks the required Go Task verifier", () => {
    const result = spawnSync(
      process.execPath,
      [join(workspaceRoot, "scripts", "check-verifier-confinement.mjs")],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: "/fusion-test-missing-verifier-toolchain" },
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      kind: "fusion.verifier-confinement-readiness.v1",
      ready: false,
      backend: null,
      code: "VERIFIER_TOOLCHAIN_UNAVAILABLE",
      message: expect.stringMatching(/Go Task.*required/i),
      taskVersion: "",
    });
  });

  it("functionally refuses malformed engine readiness even when it claims ready", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "fusion-verifier-preflight-"));
    try {
      const scriptDir = join(fixtureRoot, "scripts");
      const engineDir = join(fixtureRoot, "packages", "engine", "dist");
      const binDir = join(fixtureRoot, "bin");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(engineDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(scriptDir, "check-verifier-confinement.mjs"),
        readinessScript,
        "utf8",
      );
      writeFileSync(
        join(engineDir, "index.js"),
        "export async function inspectVerifierConfinementReadiness() { return { ready: true, backend: null, code: 'MALFORMED_READY', message: 'malformed fixture', trustedPaths: [] }; }\n",
        "utf8",
      );
      const taskPath = join(binDir, "task");
      writeFileSync(taskPath, "#!/bin/sh\necho 'Task version: v-test'\n", {
        encoding: "utf8",
        mode: 0o755,
      });

      const result = spawnSync(
        process.execPath,
        [join(scriptDir, "check-verifier-confinement.mjs")],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: { ...process.env, PATH: binDir },
          timeout: 15_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        kind: "fusion.verifier-confinement-readiness.v1",
        ready: false,
        backend: null,
        code: "MALFORMED_READY",
        message: "malformed fixture",
        taskVersion: "Task version: v-test",
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("CCC PRD product acceptance gate (.github/workflows/ccc-prd-product-gate.yml)", () => {
  let workflow: any;
  let content: string;
  let job: any;

  beforeAll(() => {
    const result = loadWorkflow("ccc-prd-product-gate.yml");
    workflow = result.parsed;
    content = result.content;
    job = workflow.jobs["product-acceptance"];
  });

  it("is valid YAML and stays workflow_dispatch-only", () => {
    expect(workflow).toBeDefined();
    expect(workflow.on).toEqual({ workflow_dispatch: {} });
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(workflow.on?.push).toBeUndefined();
  });

  it("still runs on the bwrap-capable self-hosted lane, unchanged", () => {
    expect(job?.["runs-on"]).toEqual(["self-hosted", "linux", "ARM64", "ccc-fusion-bwrap"]);
  });

  it("documents the diagnosed Linux semantic-proof sandbox gap in its header, citing the findings doc", () => {
    expect(content).toContain(
      "docs/plans/2026-09-03-semantic-proof-sandbox-linux-gap.md",
    );
    expect(content).toMatch(/semantic-v2 proof sandbox/i);
    expect(content).toMatch(/no Linux (implementation|backend)/i);
    // The header must no longer describe this as an open, undiagnosed
    // mystery -- that diagnosis now exists.
    expect(content).not.toContain("pending verifier-dispatch diagnosis");
  });

  it("does not touch FUSION_PRODUCT_TIMEOUT_MS -- the timeout was never the problem", () => {
    const acceptanceStep = (job.steps as any[]).find(
      (step) => typeof step.run === "string" && step.run.includes("verify:ccc-prd-product"),
    );
    expect(acceptanceStep?.env?.FUSION_PRODUCT_TIMEOUT_MS).toBe("600000");
  });

  it("runs a non-Darwin guard step before Checkout, naming the Linux backend gap", () => {
    const steps = job.steps as any[];
    const guardIndex = steps.findIndex(
      (step) => typeof step.if === "string" && step.if.includes("runner.os"),
    );
    const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v4");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeGreaterThan(guardIndex);

    const guard = steps[guardIndex];
    expect(guard.if).toContain("macOS");
    expect(guard.run).toContain("semantic-proof sandbox");
    expect(guard.run).toContain("docs/plans/2026-09-03-semantic-proof-sandbox-linux-gap.md");
    expect(guard.run).toMatch(/exit 1\s*$/);
  });

  it("functionally fails fast with a named cause instead of polling to timeout", () => {
    const steps = job.steps as any[];
    const guard = steps.find(
      (step) => typeof step.if === "string" && step.if.includes("runner.os"),
    );
    expect(guard).toBeDefined();

    const summaryPath = join(
      mkdtempSync(join(tmpdir(), "fusion-product-gate-guard-")),
      "summary.md",
    );
    // GitHub Actions substitutes `${{ ... }}` expressions before invoking the
    // shell -- they are not valid bash syntax on their own. Simulate that
    // substitution the same way the real runner would for a Linux job.
    const script: string = guard.run.replace(/\$\{\{\s*runner\.os\s*\}\}/g, "Linux");
    const result = spawnSync("bash", ["-c", script], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
      timeout: 15_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/semantic-proof sandbox/i);
    expect(result.stdout).toContain("docs/plans/2026-09-03-semantic-proof-sandbox-linux-gap.md");
    expect(readFileSync(summaryPath, "utf8")).toMatch(/semantic-proof sandbox/i);
  });
});

describe("Go Task npm install puts the real binary directory on PATH", () => {
  // @go-task/cli ships as an npm shim: `npm install -g --prefix <prefix>`
  // creates <prefix>/bin/task as a symlink to
  // <prefix>/lib/node_modules/@go-task/cli/run-task.js (a Node ESM launcher,
  // not an executable image). The package's own postinstall (lib.js
  // `install()`) downloads the real platform binary to
  // <prefix>/lib/node_modules/@go-task/cli/bin/task. Anything that seals and
  // execs the resolved `task` executable directly -- such as
  // ccc-prd semantic-proof custody's --version probe -- must resolve the
  // real binary, not the launcher script, or the exec fails.
  const workflowFiles = [
    "ccc-prd-product-gate.yml",
    "pr-checks.yml",
    "full-suite.yml",
  ];

  function findGoTaskInstallStep(workflow: any): any {
    const jobs = Object.values(workflow.jobs ?? {}) as any[];
    for (const job of jobs) {
      const steps = (job.steps ?? []) as any[];
      const step = steps.find(
        (s) => typeof s.run === "string" && s.run.includes("@go-task/cli@"),
      );
      if (step) return step;
    }
    return undefined;
  }

  for (const file of workflowFiles) {
    it(`${file} adds the real go-task binary directory to GITHUB_PATH, not the npm shim dir`, () => {
      const { parsed } = loadYamlFile(".github", "workflows", file);
      const step = findGoTaskInstallStep(parsed);
      expect(step, `${file}: no step installs @go-task/cli`).toBeDefined();
      const run: string = step.run;

      // Must add the directory holding the real platform binary.
      expect(run).toContain(
        '"$RUNNER_TEMP/go-task/lib/node_modules/@go-task/cli/bin" >> "$GITHUB_PATH"',
      );

      // Must never add the bare npm shim `bin/` directory -- that only
      // contains the `task` symlink to the non-executable run-task.js
      // launcher.
      expect(run).not.toMatch(
        /echo "\$RUNNER_TEMP\/go-task\/bin" >> "\$GITHUB_PATH"/,
      );

      // The sanity-check version probe must exec the same real binary that
      // was just put on PATH.
      expect(run).toContain(
        '"$RUNNER_TEMP/go-task/lib/node_modules/@go-task/cli/bin/task" --version',
      );
      expect(run).not.toMatch(
        /"\$RUNNER_TEMP\/go-task\/bin\/task" --version/,
      );
    });
  }
});

describe("Full suite workflow (.github/workflows/full-suite.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("full-suite.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("caps every PostgreSQL service container's memory and CPU", () => {
    expectPostgresServiceCapped(workflow);
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("runs ONLY on push to main — never as a PR gate", () => {
    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on?.pull_request).toBeUndefined();
  });

  it("routes every post-merge job to the dedicated local Fusion runners", () => {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {}) as [string, any][]) {
      // test-slow runs the verifier-confinement readiness probe and the
      // serialized product acceptance, so it needs the bwrap-capable lane.
      expect(job?.["runs-on"]).toEqual([
        "self-hosted",
        "linux",
        "ARM64",
        jobName === "test-slow" ? "ccc-fusion-bwrap" : "ccc-fusion",
      ]);
    }
    expect(content).not.toContain("ubuntu-latest");
  });

  it("carries the demoted tier: 4-way shards, engine slow, inventory guard", () => {
    expect(workflow.jobs?.["test-shards"]?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(content).toContain("pnpm test:ci:shard --shard ${{ matrix.shard }} --total 4");
    expect(workflow.jobs?.["test-slow"]).toBeDefined();
    expect(workflow.jobs?.["test-inventory-guard"]).toBeDefined();
  });

  it("keeps deterministic shards on random host-port PostgreSQL routing", () => {
    const shardJob = workflow.jobs?.["test-shards"];
    const shardTestStep = (shardJob?.steps ?? []).find(
      (step: { name?: string }) => step.name === "Test (deterministic shard)",
    );

    expect(shardJob?.services?.postgres?.ports).toEqual(["5432/tcp"]);
    expect(shardTestStep?.env?.FUSION_PG_TEST_URL_BASE).toContain(
      "host.docker.internal:${{ job.services.postgres.ports[5432] }}",
    );
  });

  it("preflights the slow PostgreSQL service through a fail-closed host resolver", () => {
    const slowJob = workflow.jobs?.["test-slow"];
    const slowSteps = slowJob?.steps ?? [];
    const seedIndex = slowSteps.findIndex(
      (step: { name?: string }) => step.name === "Seed artifact hash-cache",
    );
    const routeIndex = slowSteps.findIndex(
      (step: { id?: string }) => step.id === "postgres-route",
    );
    const productIndex = slowSteps.findIndex(
      (step: { name?: string }) => step.name === "Run serialized product-route acceptance",
    );
    const engineSlowIndex = slowSteps.findIndex(
      (step: { name?: string }) => step.name === "Run engine-slow with non-empty-execution assertion",
    );
    const routeStep = slowSteps[routeIndex];
    const productStep = slowSteps[productIndex];
    const engineSlowStep = slowSteps[engineSlowIndex];

    expect(slowJob?.services?.postgres?.ports).toEqual(["5432/tcp"]);
    expect(routeIndex).toBeGreaterThan(seedIndex);
    expect(routeIndex).toBeLessThan(productIndex);
    expect(routeStep?.name).toBe("Verify PostgreSQL service on runner host network");
    expect(routeStep?.run).toContain("${{ job.services.postgres.ports[5432] }}");
    expect(routeStep?.run).toContain('candidate_hosts=("127.0.0.1" "host.docker.internal")');
    expect(routeStep?.run).toContain("/proc/net/route");
    expect(routeStep?.run).toContain("selected_host=");
    expect(routeStep?.run).toContain("psql -X -w");
    expect(routeStep?.run).toContain("SELECT 1");
    expect(routeStep?.run).toContain("PGCONNECT_TIMEOUT=5");
    expect(routeStep?.run).toContain('echo "host=${selected_host}" >> "$GITHUB_OUTPUT"');
    expect(routeStep?.run).toContain('if [ -z "$selected_host" ]');
    expect(routeStep?.run).toContain("exit 1");
    expect(routeStep?.run).toContain("No reachable PostgreSQL service host candidate");
    expect(routeStep?.run).not.toContain("docker inspect");
    expect(routeStep?.run).not.toContain("docker network connect");
    expect(routeStep?.run).not.toContain("hostname");
    expect(routeStep?.env?.PGPASSWORD).toBe("postgres");
    expect(productStep?.env?.FUSION_PG_TEST_URL_BASE).not.toContain("host.docker.internal");
    expect(productStep?.env?.FUSION_PG_TEST_URL_BASE).toBe(
      "postgresql://postgres:postgres@${{ steps.postgres-route.outputs.host }}:${{ job.services.postgres.ports[5432] }}",
    );
    expect(engineSlowStep?.env?.FUSION_PG_TEST_URL_BASE).not.toContain("host.docker.internal");
    expect(engineSlowStep?.env?.FUSION_PG_TEST_URL_BASE).toBe(
      "postgresql://postgres:postgres@${{ steps.postgres-route.outputs.host }}:${{ job.services.postgres.ports[5432] }}",
    );
    expect(engineSlowIndex).toBeGreaterThan(productIndex);
  });

  it("caps full-suite fan-out to the measured shared-runner resource budget", () => {
    const shardJob = workflow.jobs?.["test-shards"];
    const shardSteps = workflow.jobs?.["test-shards"]?.steps ?? [];
    const testStep = shardSteps.find(
      (step: any) => step.name === "Test (deterministic shard)",
    );

    expect(shardJob?.strategy?.["max-parallel"]).toBe(2);
    expect(testStep?.env?.FUSION_TEST_TOTAL_WORKERS).toBe("1");
    expect(testStep?.env?.FUSION_TEST_CONCURRENCY).toBe("1");
    expect(workflow.jobs?.["test-slow"]?.needs).toEqual([
      "prepare-test-artifacts",
      "test-shards",
    ]);
    const slowCondition = String(workflow.jobs?.["test-slow"]?.if ?? "");
    expect(slowCondition).toContain("!cancelled()");
    expect(slowCondition).toContain(
      "needs.prepare-test-artifacts.result == 'success'",
    );
    expect(slowCondition).not.toContain("needs.test-shards.result");
  });

  it("caps the artifact bootstrap heap without widening the whole full suite", () => {
    const prepareJob = workflow.jobs?.["prepare-test-artifacts"];
    const buildStep = (prepareJob?.steps ?? []).find(
      (step: any) => step.name === "Build or validate test artifacts",
    );

    expect(buildStep?.env?.NODE_OPTIONS).toBe("--max-old-space-size=1792");
    expect(workflow.env?.NODE_OPTIONS).toBeUndefined();
    expect(prepareJob?.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("does not upload the pnpm store cache from the artifact producer", () => {
    const prepareSteps = workflow.jobs?.["prepare-test-artifacts"]?.steps ?? [];
    const setupIndex = prepareSteps.findIndex(
      (step: any) => step.uses === "./.github/actions/setup-node-pnpm",
    );
    const installIndex = prepareSteps.findIndex(
      (step: any) => step.run === "pnpm install --frozen-lockfile",
    );

    expect(prepareSteps[setupIndex]?.with?.["skip-install"]).toBe("true");
    expect(installIndex).toBe(setupIndex + 1);
  });

  it("runs product-route real-PG acceptance in the serialized engine job", () => {
    const slowJob = workflow.jobs?.["test-slow"];
    const productStep = (slowJob?.steps ?? []).find(
      (step: { name?: string }) => step.name === "Run serialized product-route acceptance",
    );

    expect(productStep?.run).toBe("pnpm --filter @fusion/engine test:product-route");
    expect(productStep?.env?.FUSION_PG_TEST_URL_BASE).toBe(
      "postgresql://postgres:postgres@${{ steps.postgres-route.outputs.host }}:${{ job.services.postgres.ports[5432] }}",
    );
    expect(productStep?.env?.PGPASSWORD).toBe("postgres");
  });

  it("fails fast on real verifier confinement readiness before product acceptance", () => {
    const slowSteps = workflow.jobs?.["test-slow"]?.steps ?? [];
    const seedIndex = slowSteps.findIndex(
      (step: any) => step.name === "Seed artifact hash-cache",
    );
    const readinessIndex = slowSteps.findIndex(
      (step: any) => step.name === "Verifier confinement readiness",
    );
    const productIndex = slowSteps.findIndex(
      (step: any) => step.name === "Run serialized product-route acceptance",
    );

    expect(readinessIndex).toBeGreaterThan(seedIndex);
    expect(readinessIndex).toBeLessThan(productIndex);
    expect(slowSteps[readinessIndex]?.run).toBe(
      "node scripts/check-verifier-confinement.mjs",
    );
  });

  it("keeps full clones where real-git tests need history", () => {
    const shardSteps = workflow.jobs?.["test-shards"]?.steps ?? [];
    const slowSteps = workflow.jobs?.["test-slow"]?.steps ?? [];
    for (const steps of [shardSteps, slowSteps]) {
      expect(
        steps.some((step: any) => step.uses?.includes("actions/checkout") && step.with?.["fetch-depth"] === 0),
      ).toBe(true);
    }
  });

  it("still uploads per-shard timing artifacts for snapshot refresh", () => {
    expect(content).toContain("test-timings-shard-${{ matrix.shard }}");
  });

  it("builds all required dist artifacts once before fanning out test consumers", () => {
    const requiredDistPaths = [
      "packages/core/dist",
      "packages/dashboard/dist",
      "packages/engine/dist",
      "packages/cli/dist",
      "packages/plugin-sdk/dist",
      "plugins/fusion-plugin-dependency-graph/dist",
      "plugins/fusion-plugin-hermes-runtime/dist",
      "plugins/fusion-plugin-openclaw-runtime/dist",
      "plugins/fusion-plugin-paperclip-runtime/dist",
      "plugins/fusion-plugin-compound-engineering/dist",
    ];
    const prepareJob = workflow.jobs?.["prepare-test-artifacts"];
    expect(prepareJob).toBeDefined();

    const allSteps = Object.values(workflow.jobs ?? {}).flatMap(
      (job: any) => job?.steps ?? [],
    ) as any[];
    expect(
      allSteps.filter(
        (step: any) => step.run === "node scripts/ensure-test-artifacts.mjs",
      ),
    ).toHaveLength(1);

    const prepareRestore = (prepareJob.steps ?? []).find(
      (step: any) => step.uses === "actions/cache/restore@v4",
    );
    const prepareSave = (prepareJob.steps ?? []).find(
      (step: any) => step.uses === "actions/cache/save@v4",
    );
    for (const cacheStep of [prepareRestore, prepareSave]) {
      expect(cacheStep).toBeDefined();
      expect(cacheStep.with?.path.trim().split("\n")).toEqual(requiredDistPaths);
      expect(cacheStep.with?.key).toContain("fusion-dist-v2-");
      expect(cacheStep.with?.["restore-keys"]).toBeUndefined();
      expect(cacheStep.with?.path).not.toContain("node_modules");
    }
    expect(prepareSave.with?.key).toBe(prepareRestore.with?.key);

    for (const jobName of ["test-shards", "test-inventory-guard", "test-slow"]) {
      const job = workflow.jobs?.[jobName];
      const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs];
      expect(needs).toContain("prepare-test-artifacts");

      const steps = job?.steps ?? [];
      const restore = steps.find(
        (step: any) => step.uses === "actions/cache/restore@v4",
      );
      expect(restore?.with?.path.trim().split("\n")).toEqual(requiredDistPaths);
      expect(restore?.with?.key).toBe(prepareRestore.with?.key);
      expect(restore?.with?.["fail-on-cache-miss"]).toBe(true);

      const assertIndex = steps.findIndex(
        (step: any) =>
          step.run ===
          "node scripts/ensure-test-artifacts.mjs --assert-artifacts-present",
      );
      const seedIndex = steps.findIndex(
        (step: any) =>
          step.run ===
          "node scripts/ensure-test-artifacts.mjs --seed-artifact-cache",
      );
      const consumeIndex = steps.findIndex(
        (step: any) =>
          typeof step.run === "string" &&
          (step.run.includes("pnpm test:ci:shard") ||
            step.run.includes("check-test-inventory.mjs") ||
            step.run.includes("test:product-route")),
      );
      expect(assertIndex).toBeGreaterThan(-1);
      expect(seedIndex).toBeGreaterThan(assertIndex);
      expect(consumeIndex).toBeGreaterThan(seedIndex);
      expect(
        steps.some(
          (step: any) =>
            step.name === "Build" ||
            step.run === "node scripts/ensure-test-artifacts.mjs",
        ),
      ).toBe(false);
    }

    expect(workflow.jobs?.["line-count-audit"]?.needs).toBeUndefined();
  });

  it("runs the line-count audit without installing or remotely caching the workspace", () => {
    const lineCountSteps = workflow.jobs?.["line-count-audit"]?.steps ?? [];
    expect(findCompositeSetupStep(lineCountSteps)).toBeUndefined();
    expect(
      lineCountSteps.some(
        (step: any) =>
          step.uses === "pnpm/action-setup@v4" ||
          (typeof step.uses === "string" && step.uses.startsWith("actions/cache@")) ||
          (typeof step.run === "string" && step.run.includes("pnpm install")),
      ),
    ).toBe(false);

    const setupNodeStep = lineCountSteps.find((step: any) => step.uses === "actions/setup-node@v5");
    expect(setupNodeStep?.with?.["node-version"]).toBe("24");
    expect(setupNodeStep?.with?.cache).toBeUndefined();
    expect(setupNodeStep?.with?.["package-manager-cache"]).toBe(false);

    const auditStep = lineCountSteps.find((step: any) => step.name === "Run line-count audit");
    expect(auditStep?.run).toBe("node scripts/check-file-line-count.mjs");
  });
});

describe("Desktop packaging workflow (.github/workflows/desktop-packaging.yml)", () => {
  it("uses the dedicated local Fusion runners", () => {
    const { content, parsed } = loadWorkflow("desktop-packaging.yml");

    expect(parsed.jobs?.["desktop-pack"]?.["runs-on"]).toEqual([
      "self-hosted",
      "linux",
      "ARM64",
      "ccc-fusion",
    ]);
    expect(content).not.toContain("ubuntu-latest");
  });
});

describe("Version & Release workflow (.github/workflows/version.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("version.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("uses workflow_dispatch trigger (auto release disabled)", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("does not auto-trigger on push", () => {
    expect(workflow.on.push).toBeUndefined();
  });

  it("pins release bootstrap to frozen lockfile", () => {
    expect(content).toContain("run: pnpm install --frozen-lockfile");
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
  });

  it("includes pnpm build step", () => {
    expect(content).toContain("pnpm build");
  });

  it("uses changesets/action", () => {
    expect(content).toContain("changesets/action");
  });

  it("has publish command for npm", () => {
    expect(content).toContain("pnpm -r publish");
  });

  it("uses OIDC publishing (no NPM_TOKEN secret)", () => {
    expect(content).not.toContain("secrets.NPM_TOKEN");
    expect(workflow.permissions["id-token"]).toBe("write");
  });

  it("has required permissions", () => {
    expect(workflow.permissions.contents).toBe("write");
    expect(workflow.permissions["pull-requests"]).toBe("write");
  });

  it("has id-token write permission for npm provenance", () => {
    expect(workflow.permissions["id-token"]).toBe("write");
  });

  it("publishes with --provenance flag", () => {
    expect(content).toContain("--provenance");
  });

  it("configures npm registry-url", () => {
    const steps = workflow.jobs.release.steps;
    const compositeStep = findCompositeSetupStep(steps);
    expect(compositeStep?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
  });
});

describe("Android build JDK compatibility", () => {
  let capacitorAndroidSourceCompatibility: number;

  beforeAll(() => {
    capacitorAndroidSourceCompatibility = readCapacitorAndroidSourceCompatibilityMajor();
  });

  /*
  FNXC:MobileAndroidBuild 2026-06-28-00:00:
  Android CI jobs that run Capacitor Gradle builds must provision a JDK version greater than or equal to @capacitor/android's sourceCompatibility. FN-7209 proved JDK 17 silently drifted below Capacitor 7's JavaVersion.VERSION_21 requirement and failed release builds with `invalid source release: 21`.
  */
  it("pins every Android-building workflow to a JDK compatible with Capacitor", () => {
    for (const workflowName of ["release.yml", "test-release.yml", "mobile.yml"]) {
      const workflow = loadWorkflow(workflowName).parsed;
      expectAndroidBuildJobJavaVersionAtLeast(workflow, workflowName, capacitorAndroidSourceCompatibility);
    }
  });
});

describe("Binary release workflow (.github/workflows/release.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("release.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("supports workflow_dispatch and version tag triggers", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).toHaveProperty("push");
  });

  it("auto-triggers on v* version tags", () => {
    expect(workflow.on.push.tags).toContain("v*");
  });

  it("has build-binaries job with 4-target matrix", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    expect(matrix).toHaveLength(4);
    const targets = matrix.map((m: any) => m.target);
    expect(targets).toContain("bun-linux-x64");
    expect(targets).toContain("bun-linux-arm64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-windows-x64");
    // bun-darwin-x64 dropped: macos-13 runner scarcity; CLI is Apple-Silicon-only.
    expect(targets).not.toContain("bun-darwin-x64");
  });

  it("has correct OS runners for each target", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const osMap: Record<string, string> = {};
    matrix.forEach((m: any) => { osMap[m.target] = m.os; });
    expect(osMap["bun-linux-x64"]).toBe("ubuntu-latest");
    expect(osMap["bun-linux-arm64"]).toBe("ubuntu-24.04-arm");
    expect(osMap["bun-darwin-arm64"]).toBe("macos-latest");
    expect(osMap["bun-windows-x64"]).toBe("windows-latest");
  });

  it("maps bun-linux-arm64 to fn-cli-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-cli-linux-arm64");
  });

  it("uses softprops/action-gh-release", () => {
    expect(content).toContain("softprops/action-gh-release");
  });

  it("uses frozen-lockfile install in every matrix job", () => {
    const steps = workflow.jobs["build-binaries"].steps ?? [];
    const setupSteps = steps.filter((step: any) => step.uses === "./.github/actions/setup-node-pnpm");

    const hasValidCompositeSetup = setupSteps.some((step: any) => {
      const installArgs = step.with?.["install-args"];
      return installArgs === undefined || String(installArgs).trim() === "--frozen-lockfile";
    });

    const hasInlineFrozenInstall = steps.some((step: any) =>
      typeof step.run === "string" && /\bpnpm install --frozen-lockfile\b/.test(step.run),
    );

    expect(hasValidCompositeSetup || hasInlineFrozenInstall).toBe(true);

    for (const step of setupSteps) {
      const installArgs = step.with?.["install-args"];
      if (installArgs !== undefined) {
        expect(String(installArgs).trim()).toBe("--frozen-lockfile");
      }
    }

    expect(content).not.toMatch(/run:\s*pnpm install\s*(?:\r?\n)/);
    expect(content).not.toContain("--no-frozen-lockfile");
    expect(content).not.toMatch(/install-args:\s*["']?\s*["']?\s*(?:\r?\n)/);
  });

  it("references signing scripts", () => {
    expect(content).toContain("scripts/sign-macos.sh");
    expect(content).toContain("scripts/sign-windows.ps1");
  });

  it("generates checksums on all platforms", () => {
    expect(content).toContain("sha256sum");
    expect(content).toContain("shasum -a 256");
    expect(content).toContain("Get-FileHash");
  });

  it("has contents: write permission", () => {
    expect(workflow.permissions.contents).toBe("write");
  });

  it("has github-release job that depends on binary and Android builds", () => {
    expect(workflow.jobs["github-release"].needs).toContain("build-binaries");
    expect(workflow.jobs["github-release"].needs).toContain("build-android");
  });

  it("wires signed Android AAB artifacts into release aggregation", () => {
    const androidJob = workflow.jobs["build-android"];
    const collectStep = workflow.jobs["github-release"].steps.find((step: any) => step.name === "Collect release files");

    expect(androidJob.env.ANDROID_KEYSTORE_BASE64).toBe("${{ secrets.ANDROID_KEYSTORE_BASE64 }}");
    expect(content).toContain("./gradlew assembleRelease bundleRelease");
    expect(content).toContain("fusion-android-release.aab");
    expect(collectStep.run).toContain('-name "*.apk"');
    expect(collectStep.run).toContain('-name "*.aab"');
    expect(collectStep.run).toContain('-name "*.sha256"');
  });
});

describe("Test-release workflow (.github/workflows/test-release.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("test-release.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("has workflow_dispatch trigger", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("has 4-target build matrix", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    expect(matrix).toHaveLength(4);
    const targets = matrix.map((m: any) => m.target);
    expect(targets).toContain("bun-linux-x64");
    expect(targets).toContain("bun-linux-arm64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-windows-x64");
    // bun-darwin-x64 dropped: macos-13 runner scarcity; CLI is Apple-Silicon-only.
    expect(targets).not.toContain("bun-darwin-x64");
  });

  it("maps bun-linux-arm64 to fn-cli-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-cli-linux-arm64");
  });

  it("includes smoke tests with --help", () => {
    expect(content).toContain("--help");
  });

  it("has signing steps with secret-availability guards", () => {
    expect(content).toContain("APPLE_CERTIFICATE_BASE64 != ''");
    expect(content).toContain("WINDOWS_CERTIFICATE_BASE64 != ''");
  });

  it("uses frozen-lockfile install in every matrix job", () => {
    const steps = workflow.jobs["build-binaries"].steps ?? [];
    const compositeStep = findCompositeSetupStep(steps);
    expect(compositeStep).toBeDefined();
    expect(compositeStep.with?.["install-args"] ?? "--frozen-lockfile").toBe("--frozen-lockfile");
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
  });

  it("uploads artifacts", () => {
    expect(content).toContain("actions/upload-artifact");
  });

  it("has a collect job that combines binary and Android artifacts", () => {
    expect(workflow.jobs.collect).toBeDefined();
    expect(workflow.jobs.collect.needs).toContain("build-binaries");
    expect(workflow.jobs.collect.needs).toContain("build-android");
    expect(content).toContain("all-binaries");
  });

  it("wires signed Android AAB artifacts into rehearsal aggregation", () => {
    const androidJob = workflow.jobs["build-android"];
    const combineStep = workflow.jobs.collect.steps.find((step: any) => step.name === "Combine artifacts");

    expect(androidJob.env.ANDROID_KEYSTORE_BASE64).toBe("${{ secrets.ANDROID_KEYSTORE_BASE64 }}");
    expect(content).toContain("./gradlew assembleRelease bundleRelease");
    expect(content).toContain("fusion-android-release.aab");
    expect(combineStep.run).toContain('-name "*.apk"');
    expect(combineStep.run).toContain('-name "*.aab"');
    expect(combineStep.run).toContain('-name "*.sha256"');
  });
});

describe("Cross-platform agent-browser install workflow", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("agent-browser-install.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("runs packed consumer installs on Windows, Linux, and macOS for relevant pull requests", () => {
    expect(workflow.on?.pull_request?.branches).toContain("main");
    expect(workflow.on?.pull_request?.paths).toContain(".github/workflows/agent-browser-install.yml");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/agent-browser.mjs");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/package.json");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/scripts/prepare-publish-manifest.mjs");
    const packFixture = workflow.jobs?.["pack-fixture"];
    const installSmoke = workflow.jobs?.["install-smoke"];
    expect(packFixture?.["runs-on"]).toBe("ubuntu-latest");
    expect(findCompositeSetupStep(packFixture?.steps ?? [])?.with?.["skip-install"]).toBe("true");
    expect(installSmoke?.needs).toBe("pack-fixture");
    expect(installSmoke?.["runs-on"]).toBe("${{ matrix.os }}");
    expect(installSmoke?.strategy?.matrix?.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(findCompositeSetupStep(installSmoke?.steps ?? [])).toBeUndefined();
  });

  it("executes npm's generated platform shim and checks the matching native executable", () => {
    expect(content).toContain("pnpm pack --pack-destination");
    expect(content).toContain('dependencies["agent-browser"]');
    expect(content).toContain("agent-browser-version.txt");
    expect(content).toContain("actions/upload-artifact@v4");
    expect(content).toContain("actions/download-artifact@v4");
    expect(content).toContain("Packed Fusion manifest lost the exact agent-browser pin");
    expect(content).toContain("Packed Fusion manifest lost the agent-browser bin");
    expect(content).toContain("Packed Fusion tarball omitted agent-browser.mjs");
    expect(content).toContain("npm install --ignore-scripts --no-audit --no-fund --install-strategy=nested");
    expect(content).toContain('$shimName = if ($IsWindows) { "agent-browser.cmd" } else { "agent-browser" }');
    expect(content).toContain('"node_modules/.bin/$shimName"');
    expect(content).toContain("& $shim --version");
    expect(content).toContain("does not match declared pin");
    expect(content).toContain("Missing native executable:");
    expect(content).toContain("process.platform + '-' + process.arch");
  });
});

describe("Code signing — Release workflow secrets", () => {
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("release.yml");
    content = result.content;
  });

  it("references macOS signing secrets", () => {
    expect(content).toContain("secrets.APPLE_CERTIFICATE_BASE64");
    expect(content).toContain("secrets.APPLE_CERTIFICATE_PASSWORD");
    expect(content).toContain("secrets.APPLE_IDENTITY");
    expect(content).toContain("secrets.APPLE_ID");
    expect(content).toContain("secrets.APPLE_TEAM_ID");
    expect(content).toContain("secrets.APPLE_APP_PASSWORD");
  });

  it("references Windows signing secrets", () => {
    expect(content).toContain("secrets.WINDOWS_CERTIFICATE_BASE64");
    expect(content).toContain("secrets.WINDOWS_CERTIFICATE_PASSWORD");
  });

  it("generates checksums after signing", () => {
    const signMacIdx = content.indexOf("Sign macOS binary");
    const signWinIdx = content.indexOf("Sign Windows binary");
    const checksumLinuxIdx = content.indexOf("Generate checksum (Linux)");
    const checksumMacIdx = content.indexOf("Generate checksum (macOS)");
    const checksumWinIdx = content.indexOf("Generate checksum (Windows)");

    // All checksum steps come after all signing steps
    expect(checksumLinuxIdx).toBeGreaterThan(signMacIdx);
    expect(checksumLinuxIdx).toBeGreaterThan(signWinIdx);
    expect(checksumMacIdx).toBeGreaterThan(signMacIdx);
    expect(checksumWinIdx).toBeGreaterThan(signWinIdx);
  });
});

describe("Code signing — Scripts", () => {
  const scriptsDir = join(workspaceRoot, "scripts");

  it("sign-macos.sh exists and is executable", () => {
    const scriptPath = join(scriptsDir, "sign-macos.sh");
    expect(() => accessSync(scriptPath, constants.F_OK)).not.toThrow();
    expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
  });

  it("sign-windows.ps1 exists", () => {
    const scriptPath = join(scriptsDir, "sign-windows.ps1");
    expect(() => accessSync(scriptPath, constants.F_OK)).not.toThrow();
  });

  it("sign-macos.sh references codesign, notarytool, and security import", () => {
    const script = readFileSync(join(scriptsDir, "sign-macos.sh"), "utf-8");
    expect(script).toContain("codesign");
    expect(script).toContain("notarytool");
    expect(script).toContain("security import");
  });

  it("sign-windows.ps1 references signtool", () => {
    const script = readFileSync(join(scriptsDir, "sign-windows.ps1"), "utf-8");
    expect(script).toContain("signtool");
  });
});
