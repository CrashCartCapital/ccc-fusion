/*
FNXC:CccPlanningCli 2026-10-14-22:41:
Card CL1 (CONTRACT-v3.5 section 2.19, D35): `fn plan` is routed by bin.ts BEFORE the bin-level `--project` parse, so plan.ts owns exit 2 and the JSON usage errors. These tests drive bin's own entry with injected argv (bin.ts is re-evaluated per import, the way bin.test.ts does) and read the process exit code bin leaves behind; the plan module is the real one, with only its default deps factory swapped for a spy-backed fake so no PostgreSQL is reached.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUSION_NON_RETRYABLE_EXIT_CODE, type AsyncDataLayer, type CccPlanningRunStatusV1 } from "@fusion/core";
import type { PlanCommandDeps } from "../commands/plan.js";

const RUN = "ccc-plan:0123456789abcdef01234567";

const planState = vi.hoisted(() => ({
  injected: undefined as unknown,
  defaultFactoryCalls: 0,
}));

vi.mock("../commands/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/plan.js")>();
  return {
    ...actual,
    createDefaultPlanCommandDeps: () => {
      planState.defaultFactoryCalls += 1;
      return (planState.injected as PlanCommandDeps | undefined) ?? actual.createDefaultPlanCommandDeps();
    },
  };
});

const originalArgv = process.argv;
const originalExit = process.exit;
const originalSkipOnboardingEnv = process.env.FUSION_SKIP_ONBOARDING;
let importCounter = 0;

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const exitSpy = vi.fn();

type BinOutcome = Readonly<{ exitCode: number | string | undefined; thrown: unknown; stdout: string[]; stderr: string[] }>;

async function runBin(args: string[]): Promise<BinOutcome> {
  process.argv = ["node", "bin.ts", ...args];
  process.exitCode = undefined;
  logSpy.mockClear();
  errorSpy.mockClear();
  importCounter += 1;
  let thrown: unknown;
  try {
    await import(/* @vite-ignore */ `../bin.ts?test=${importCounter}`);
  } catch (error) {
    thrown = error;
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return {
    exitCode,
    thrown,
    stdout: logSpy.mock.calls.map((call) => call.join(" ")),
    stderr: errorSpy.mock.calls.map((call) => call.join(" ")),
  };
}

function status(): CccPlanningRunStatusV1 {
  return { schema: "ccc-planning.run-status.v1", runId: RUN, projectId: "proj-a", state: "running", import: null } as unknown as CccPlanningRunStatusV1;
}

function fakeDeps(options: Readonly<{ inspect?: () => Promise<CccPlanningRunStatusV1> }> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const layer = { projectId: "proj-a" } as unknown as AsyncDataLayer;
  const resolveRunProject = vi.fn(async (_layer: AsyncDataLayer, _input: Readonly<{ runId: string; projectId?: string }>) => ({ projectId: "proj-a" }));
  const inspectRun = vi.fn(options.inspect ?? (async () => status()));
  const deps = {
    ledger: { resolveRunProject, inspectRun, requestControl: vi.fn(), answerDecision: vi.fn() },
    openLayer: vi.fn(async () => ({ layer, close: async () => {} })),
    applyBuildControl: vi.fn(async () => ({ kind: "refused" as const, code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", detail: "build control bridge not wired" })),
    osUserName: () => "operator-user",
    readTextFile: vi.fn(async () => ""),
    stdout: (line: string) => { out.push(line); },
    stderr: (line: string) => { err.push(line); },
  } as unknown as PlanCommandDeps;
  return { deps, out, err, resolveRunProject, inspectRun };
}

describe("bin routes fn plan before the bin-level --project parse (card CL1, D35)", () => {
  beforeEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockReset();
    exitSpy.mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    process.exit = exitSpy as unknown as typeof process.exit;
    planState.injected = undefined;
    planState.defaultFactoryCalls = 0;
    process.env.FUSION_SKIP_ONBOARDING = "1";
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = undefined;
    if (originalSkipOnboardingEnv === undefined) {
      delete process.env.FUSION_SKIP_ONBOARDING;
    } else {
      process.env.FUSION_SKIP_ONBOARDING = originalSkipOnboardingEnv;
    }
  });

  it("a duplicate --project on fn plan exits 2 with one usage_error JSON line, while the same flags on another command still hit the bin-level duplicate-project error", async () => {
    const outcome = await runBin(["plan", "status", RUN, "--project", "a", "--project", "b", "--json"]);
    expect(outcome.thrown, "bin must not throw the bin-level duplicate --project error for plan").toBeUndefined();
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toHaveLength(1);
    expect(JSON.parse(outcome.stdout[0]!)).toMatchObject({ schema: "ccc-planning.cli.v1", kind: "usage_error", code: "CCC_PLANNING_CLI_USAGE" });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(planState.defaultFactoryCalls).toBe(1);

    planState.defaultFactoryCalls = 0;
    const control = await runBin(["task", "list", "--project", "a", "--project", "b"]);
    expect(control.thrown).toBeInstanceOf(Error);
    expect((control.thrown as Error).message).toContain("Duplicate --project flag");
    expect(control.exitCode).toBeUndefined();
    expect(planState.defaultFactoryCalls).toBe(0);
  });

  it("a missing RUN_ID and an unknown subcommand through bin exit 2 with a JSON usage_error line; the twin with the id does not", async () => {
    const missing = await runBin(["plan", "status", "--json"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toHaveLength(1);
    expect(JSON.parse(missing.stdout[0]!)).toMatchObject({ kind: "usage_error" });

    const unknown = await runBin(["plan", "frobnicate", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout[0]!)).toMatchObject({ kind: "usage_error" });

    const fake = fakeDeps();
    planState.injected = fake.deps;
    const ok = await runBin(["plan", "status", RUN, "--json"]);
    expect(ok.exitCode).toBe(0);
  });

  it("fn plan status with no --project resolves the project from the run row through bin and exits 0 with kind status", async () => {
    const fake = fakeDeps();
    planState.injected = fake.deps;
    const outcome = await runBin(["plan", "status", RUN, "--json"]);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(fake.out).toHaveLength(1);
    expect(JSON.parse(fake.out[0]!)).toMatchObject({ schema: "ccc-planning.cli.v1", kind: "status", status: { runId: RUN } });
    expect(fake.resolveRunProject.mock.calls[0]![1]).toEqual({ runId: RUN });
    expect(outcome.stdout).toEqual([]);
  });

  it("the --project given to fn plan reaches plan.ts untouched: bin does not strip it", async () => {
    const fake = fakeDeps();
    planState.injected = fake.deps;
    const outcome = await runBin(["plan", "status", RUN, "--project", "proj-a", "--json"]);
    expect(outcome.exitCode).toBe(0);
    expect(fake.resolveRunProject.mock.calls[0]![1]).toEqual({ runId: RUN, projectId: "proj-a" });
  });

  it("an unexpected error inside fn plan exits 1 with CCC_PLANNING_INTERNAL_ERROR, never the non-retryable exit bin gives a unique violation", async () => {
    const fake = fakeDeps({
      inspect: async () => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); },
    });
    planState.injected = fake.deps;
    const outcome = await runBin(["plan", "status", RUN, "--json"]);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.exitCode).toBe(1);
    expect(outcome.exitCode).not.toBe(FUSION_NON_RETRYABLE_EXIT_CODE);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fake.out).toHaveLength(1);
    expect(JSON.parse(fake.out[0]!)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_INTERNAL_ERROR" });
  });
});
