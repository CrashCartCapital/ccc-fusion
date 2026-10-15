/*
FNXC:CccPlanningCli 2026-10-14-22:41:
Card CL1 (CONTRACT-v3.5 section 2.19, D35, D49, errata E2-4/E4-6): the `fn plan` grammar, the 0/1/2 exit codes, the one-JSON-line output, project resolution from the run row, control routing and the actor rule. Every refusal below has a positive control (the twin on the same fixture that must succeed), and every check that says "deps are never called" counts calls on every injected spy, so a command that read or wrote before it validated fails.
*/
import { describe, expect, it, vi } from "vitest";
import {
  CccPlanningRefusal,
  FUSION_NON_RETRYABLE_EXIT_CODE,
  type AsyncDataLayer,
  type CccPlanningRunStatusV1,
} from "@fusion/core";
import {
  CCC_PLANNING_CLI_EXIT,
  CCC_PLANNING_CLI_SCHEMA,
  runPlanCommand,
  type PlanCommandDeps,
} from "../plan.js";

const RUN = "ccc-plan:0123456789abcdef01234567";
const OTHER_RUN = "ccc-plan:fedcba9876543210fedcba98";
const DIGEST = "a".repeat(64);
const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";

function statusFixture(importId: string | null = null): CccPlanningRunStatusV1 {
  return {
    schema: "ccc-planning.run-status.v1",
    runId: RUN, projectId: PROJECT_A, planningTaskId: "FN-PLAN-1", mode: "build", budgetProfile: "standard",
    roleProfile: "full-v2", state: "running", stateCode: null, revision: 1, controlSeq: 0,
    deadlineAt: "2026-10-14T23:00:00.000Z", pendingControl: null, lastControl: null, awaitingDecision: null,
    budgets: {
      planning: { allocation: 100, spent: 12, preflightSpent: 3 },
      implementation: { allocation: 400, transferred: null, spent: null },
      reviewProof: { allocation: 80, spent: 0 },
      researchFetches: { allocation: 20, spent: 1 },
      researchBytes: { allocation: 1_000_000, spent: 2048 },
    },
    counters: { repairEpochState: "unopened", repairChunksUsed: 0, reviewEpochs: 0, stagnantEpochs: 0 },
    stages: [{ stageId: "intake", status: "committed", artifactKeys: ["cccplan-r001-a"] }],
    unreconciled: [], writerAttempts: [],
    import: importId === null ? null : { idempotencyKey: "idem-1", intentDigest: DIGEST, importId, importState: "active" },
    executionAuthority: null,
    notRun: [],
  } as unknown as CccPlanningRunStatusV1;
}

type Harness = ReturnType<typeof harness>;

type HarnessOptions = Readonly<{
  /** Run id -> projects that hold it; the fake resolver mirrors L1 resolveCccPlanningRunProject (none, many, mismatch). */
  runs?: Readonly<Record<string, readonly string[]>>;
  status?: CccPlanningRunStatusV1;
  osUser?: string;
  files?: Readonly<Record<string, string>>;
  applyBuildControl?: PlanCommandDeps["applyBuildControl"];
}>;

function harness(options: HarnessOptions = {}) {
  const runs = options.runs ?? { [RUN]: [PROJECT_A] };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const closed: string[] = [];
  const events: string[] = [];
  const layers: Record<string, AsyncDataLayer> = {
    [PROJECT_A]: { projectId: PROJECT_A } as unknown as AsyncDataLayer,
    [PROJECT_B]: { projectId: PROJECT_B } as unknown as AsyncDataLayer,
    ambient: { projectId: PROJECT_A } as unknown as AsyncDataLayer,
  };
  const openLayer = vi.fn(async (input: Readonly<{ projectId?: string }>) => {
    const key = input.projectId ?? "ambient";
    events.push(`open:${key}`);
    return { layer: layers[key] ?? ({ projectId: key } as unknown as AsyncDataLayer), close: async () => { events.push(`close:${key}`); closed.push(key); } };
  });
  const resolveRunProject = vi.fn(async (_layer: AsyncDataLayer, input: Readonly<{ runId: string; projectId?: string }>) => {
    const holders = runs[input.runId] ?? [];
    if (holders.length === 0) throw new CccPlanningRefusal("CCC_PLANNING_RUN_NOT_FOUND", `run ${input.runId} not found`, "runId");
    if (holders.length > 1) throw new CccPlanningRefusal("CCC_PLANNING_RUN_AMBIGUOUS", `run ${input.runId} exists in ${holders.length} projects`, "runId");
    if (input.projectId !== undefined && input.projectId !== holders[0]) {
      throw new CccPlanningRefusal("CCC_PLANNING_RUN_PROJECT_MISMATCH", `run ${input.runId} belongs to another project`, "projectId");
    }
    return { projectId: holders[0]! };
  });
  const inspectRun = vi.fn(async (_layer: AsyncDataLayer, _runId: string, _ports?: unknown) => options.status ?? statusFixture());
  const requestControl = vi.fn(async (_layer: AsyncDataLayer, input: Readonly<{ runId: string; request: "pause" | "cancel" | "resume"; actor: string }>) => {
    events.push(`request:${input.request}`);
    return { controlSeq: 7, appliedDirectly: input.request !== "pause" };
  });
  const answerDecision = vi.fn(async (_layer: AsyncDataLayer, _input: Readonly<{ runId: string; decisionId: string; answer: string; actor: string }>) => ({ controlSeq: 4, answerArtifactKey: "cccplan-r001-operator-answer4-v001" }));
  const applyBuildControl = vi.fn<PlanCommandDeps["applyBuildControl"]>(options.applyBuildControl ?? (async () => {
    events.push("apply");
    return { kind: "refused", code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", detail: "build control bridge not wired" };
  }));
  const osUserName = vi.fn(() => options.osUser ?? "operator-user");
  const readTextFile = vi.fn(async (path: string) => {
    const content = options.files?.[path];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: "ENOENT" });
    return content;
  });
  const deps: PlanCommandDeps = {
    ledger: { resolveRunProject, inspectRun, requestControl, answerDecision } as unknown as PlanCommandDeps["ledger"],
    openLayer,
    applyBuildControl,
    osUserName,
    readTextFile,
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  };
  const spies = { openLayer, resolveRunProject, inspectRun, requestControl, answerDecision, applyBuildControl, osUserName, readTextFile };
  return { deps, stdout, stderr, closed, events, spies };
}

function lines(h: Harness): Array<Record<string, unknown>> {
  return h.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function totalDepCalls(h: Harness, except: readonly string[] = ["osUserName"]): number {
  return Object.entries(h.spies)
    .filter(([name]) => !except.includes(name))
    .reduce((sum, [, spy]) => sum + (spy as { mock: { calls: unknown[] } }).mock.calls.length, 0);
}

async function run(h: Harness, argv: readonly string[]): Promise<number> {
  return runPlanCommand(argv, h.deps);
}

function only(h: Harness): Record<string, unknown> {
  expect(h.stdout, "stdout must hold exactly one JSON line").toHaveLength(1);
  return lines(h)[0]!;
}

describe("fn plan CLI (card CL1)", () => {
  it("exports the frozen schema and exit codes", () => {
    expect(CCC_PLANNING_CLI_SCHEMA).toBe("ccc-planning.cli.v1");
    expect(CCC_PLANNING_CLI_EXIT).toEqual({ success: 0, refusal: 1, usage: 2 });
  });

  it("status with no --project resolves the project from the run row and prints one status line; the twin with --project forwards it", async () => {
    const h = harness();
    const exit = await run(h, ["status", RUN, "--json"]);
    expect(exit).toBe(0);
    const line = only(h);
    expect(line.schema).toBe(CCC_PLANNING_CLI_SCHEMA);
    expect(line.kind).toBe("status");
    expect(line.status).toEqual(statusFixture());
    expect(h.spies.resolveRunProject).toHaveBeenCalledTimes(1);
    expect(h.spies.resolveRunProject.mock.calls[0]![1]).toEqual({ runId: RUN });
    expect(h.spies.inspectRun).toHaveBeenCalledTimes(1);
    expect(h.spies.inspectRun.mock.calls[0]![1]).toBe(RUN);
    expect(h.stderr).toEqual([]);

    const twin = harness();
    expect(await run(twin, ["status", RUN, "--project", PROJECT_A, "--json"])).toBe(0);
    expect(only(twin).kind).toBe("status");
    expect(twin.spies.resolveRunProject.mock.calls[0]![1]).toEqual({ runId: RUN, projectId: PROJECT_A });
  });

  it("a run id held by two projects exits 1 with CCC_PLANNING_RUN_AMBIGUOUS; the twin held by one project exits 0", async () => {
    const h = harness({ runs: { [RUN]: [PROJECT_A, PROJECT_B] } });
    expect(await run(h, ["status", RUN, "--json"])).toBe(1);
    const line = only(h);
    expect(line).toMatchObject({ schema: CCC_PLANNING_CLI_SCHEMA, kind: "refusal", code: "CCC_PLANNING_RUN_AMBIGUOUS", runId: RUN, field: "runId" });
    expect(h.spies.inspectRun).not.toHaveBeenCalled();
    expect(h.stderr.join("\n")).toContain("CCC_PLANNING_RUN_AMBIGUOUS");

    const twin = harness({ runs: { [RUN]: [PROJECT_A] } });
    expect(await run(twin, ["status", RUN, "--json"])).toBe(0);
  });

  it("--project naming another project exits 1 with CCC_PLANNING_RUN_PROJECT_MISMATCH; the twin naming the run's project exits 0", async () => {
    const h = harness({ runs: { [RUN]: [PROJECT_A] } });
    expect(await run(h, ["status", RUN, "--project", PROJECT_B, "--json"])).toBe(1);
    expect(only(h)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_RUN_PROJECT_MISMATCH", runId: RUN });
    expect(h.spies.inspectRun).not.toHaveBeenCalled();

    const twin = harness({ runs: { [RUN]: [PROJECT_A] } });
    expect(await run(twin, ["status", RUN, "--project", PROJECT_A, "--json"])).toBe(0);
    expect(only(twin).kind).toBe("status");
  });

  it("opens the resolution layer on the --project given, reuses it when it already is the run's project, and opens the run's project otherwise", async () => {
    const reuse = harness({ runs: { [RUN]: [PROJECT_A] } });
    await run(reuse, ["status", RUN, "--project", PROJECT_A, "--json"]);
    expect(reuse.events).toEqual([`open:${PROJECT_A}`, `close:${PROJECT_A}`]);

    const reopen = harness({ runs: { [RUN]: [PROJECT_B] } });
    await run(reopen, ["status", RUN, "--json"]);
    expect(reopen.events).toEqual(["open:ambient", `open:${PROJECT_B}`, `close:${PROJECT_B}`, "close:ambient"]);
    expect(reopen.spies.inspectRun.mock.calls[0]![0]).toEqual({ projectId: PROJECT_B });
  });

  it("a missing positional RUN_ID exits 2 with one usage_error line for every run subcommand and deps are never called; the twin with the id passes", async () => {
    const cases: ReadonlyArray<readonly string[]> = [
      ["status", "--json"],
      ["answer", "--decision", "d1", "--value", "x", "--json"],
      ["pause", "--json"],
      ["cancel", "--json"],
      ["resume", "--json"],
      ["build", "--budget-profile", "standard", "--json"],
      ["budget", "--amendment", "a.json", "--json"],
    ];
    for (const argv of cases) {
      const h = harness();
      expect(await run(h, argv), argv.join(" ")).toBe(2);
      const line = only(h);
      expect(line, argv.join(" ")).toMatchObject({ schema: CCC_PLANNING_CLI_SCHEMA, kind: "usage_error", code: "CCC_PLANNING_CLI_USAGE" });
      expect(typeof line.detail).toBe("string");
      expect(String(line.usage)).toContain("fn plan");
      expect(totalDepCalls(h), argv.join(" ")).toBe(0);
    }
    const twin = harness();
    expect(await run(twin, ["status", RUN, "--json"])).toBe(0);
  });

  it("a --run flag grammar is not accepted: the run id is positional only", async () => {
    const h = harness();
    expect(await run(h, ["status", "--run", RUN, "--json"])).toBe(2);
    expect(only(h)).toMatchObject({ kind: "usage_error" });
    expect(totalDepCalls(h)).toBe(0);
    const extra = harness();
    expect(await run(extra, ["status", RUN, OTHER_RUN, "--json"])).toBe(2);
    expect(only(extra)).toMatchObject({ kind: "usage_error" });
    expect(totalDepCalls(extra)).toBe(0);
  });

  it("every other grammar fault exits 2 with one usage_error line and no dep call, and each twin without the fault is not a usage error", async () => {
    const faults: ReadonlyArray<Readonly<{ label: string; argv: readonly string[]; twin: readonly string[] }>> = [
      { label: "duplicate --project", argv: ["status", RUN, "--project", "a", "--project", "b", "--json"], twin: ["status", RUN, "--project", "a", "--json"] },
      { label: "duplicate --json", argv: ["status", RUN, "--json", "--json"], twin: ["status", RUN, "--json"] },
      { label: "duplicate --actor", argv: ["pause", RUN, "--actor", "a", "--actor", "b", "--json"], twin: ["pause", RUN, "--actor", "a", "--json"] },
      { label: "unknown subcommand", argv: ["frobnicate", RUN, "--json"], twin: ["status", RUN, "--json"] },
      { label: "no subcommand", argv: ["--json"], twin: ["status", RUN, "--json"] },
      { label: "unknown flag", argv: ["status", RUN, "--verbose", "--json"], twin: ["status", RUN, "--json"] },
      { label: "short project flag is not part of the grammar", argv: ["status", RUN, "-P", "a", "--json"], twin: ["status", RUN, "--project", "a", "--json"] },
      { label: "actor on status", argv: ["status", RUN, "--actor", "a", "--json"], twin: ["pause", RUN, "--actor", "a", "--json"] },
      { label: "project flag without a value", argv: ["status", RUN, "--project", "--json"], twin: ["status", RUN, "--project", "a", "--json"] },
      { label: "project flag with an empty value", argv: ["status", RUN, "--project", "", "--json"], twin: ["status", RUN, "--project", "a", "--json"] },
      { label: "answer without --decision", argv: ["answer", RUN, "--value", "x", "--json"], twin: ["answer", RUN, "--decision", "d1", "--value", "x", "--json"] },
      { label: "answer with both --value and --value-file", argv: ["answer", RUN, "--decision", "d1", "--value", "x", "--value-file", "f.txt", "--json"], twin: ["answer", RUN, "--decision", "d1", "--value", "x", "--json"] },
      { label: "answer with neither --value nor --value-file", argv: ["answer", RUN, "--decision", "d1", "--json"], twin: ["answer", RUN, "--decision", "d1", "--value", "x", "--json"] },
      { label: "answer with an empty --value", argv: ["answer", RUN, "--decision", "d1", "--value", "", "--json"], twin: ["answer", RUN, "--decision", "d1", "--value", "x", "--json"] },
      { label: "build with a bad enum", argv: ["build", RUN, "--budget-profile", "huge", "--json"], twin: ["build", RUN, "--budget-profile", "large", "--json"] },
      { label: "build without --budget-profile", argv: ["build", RUN, "--json"], twin: ["build", RUN, "--budget-profile", "standard", "--json"] },
      { label: "budget without --amendment", argv: ["budget", RUN, "--json"], twin: ["budget", RUN, "--amendment", "a.json", "--json"] },
      { label: "start without --project", argv: ["start", ...startFlags({ project: null }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with a bad --mode", argv: ["start", ...startFlags({ mode: "plan" }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with a bad --budget-profile", argv: ["start", ...startFlags({ profile: "medium" }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with a 63-character digest", argv: ["start", ...startFlags({ digest: "a".repeat(63) }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with an uppercase digest", argv: ["start", ...startFlags({ digest: "A".repeat(64) }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with a non-hex digest", argv: ["start", ...startFlags({ digest: `${"a".repeat(63)}g` }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start without --authority-receipt", argv: ["start", ...startFlags({ receipt: null }), "--json"], twin: ["start", ...startFlags({}), "--json"] },
      { label: "start with a positional argument", argv: ["start", RUN, ...startFlags({}), "--json"], twin: ["start", ...startFlags({}), "--json"] },
    ];
    for (const fault of faults) {
      const h = harness({ files: { "f.txt": "x" } });
      expect(await run(h, fault.argv), fault.label).toBe(2);
      expect(only(h), fault.label).toMatchObject({ schema: CCC_PLANNING_CLI_SCHEMA, kind: "usage_error", code: "CCC_PLANNING_CLI_USAGE" });
      expect(totalDepCalls(h), fault.label).toBe(0);

      const twin = harness({ files: { "f.txt": "x" } });
      const twinExit = await run(twin, fault.twin);
      expect(twinExit, `${fault.label} twin`).not.toBe(2);
      expect(twin.stdout.map((line) => (JSON.parse(line) as { kind: string }).kind), `${fault.label} twin`).not.toContain("usage_error");
    }
  });

  it("an actor over 200 characters, or blank after trimming, exits 2 before any dep call; 200 characters pass unchanged and a padded actor is trimmed", async () => {
    const long = "x".repeat(2000);
    const subcommands: ReadonlyArray<readonly string[]> = [
      ["pause", RUN],
      ["cancel", RUN],
      ["resume", RUN],
      ["answer", RUN, "--decision", "d1", "--value", "v"],
    ];
    for (const base of subcommands) {
      for (const [label, actor] of [["2000 characters", long], ["201 characters", "y".repeat(201)], ["empty", ""], ["blank", "   \t "]] as const) {
        const h = harness();
        expect(await run(h, [...base, "--actor", actor, "--json"]), `${base[0]} ${label}`).toBe(2);
        expect(only(h), `${base[0]} ${label}`).toMatchObject({ kind: "usage_error", code: "CCC_PLANNING_CLI_USAGE" });
        expect(totalDepCalls(h, []), `${base[0]} ${label}: every spy, the OS user lookup included`).toBe(0);
      }
      const exact = harness();
      const actor200 = "z".repeat(200);
      expect(await run(exact, [...base, "--actor", actor200, "--json"]), `${base[0]} 200`).toBe(0);
      const received = base[0] === "answer"
        ? exact.spies.answerDecision.mock.calls[0]![1]
        : exact.spies.requestControl.mock.calls[0]![1];
      expect((received as { actor: string }).actor).toBe(actor200);

      const one = harness();
      expect(await run(one, [...base, "--actor", "a", "--json"]), `${base[0]} 1`).toBe(0);

      const padded = harness();
      expect(await run(padded, [...base, "--actor", `  ${actor200}  `, "--json"]), `${base[0]} padded`).toBe(0);
      const paddedActor = base[0] === "answer"
        ? padded.spies.answerDecision.mock.calls[0]![1]
        : padded.spies.requestControl.mock.calls[0]![1];
      expect((paddedActor as { actor: string }).actor).toBe(actor200);
    }
  });

  it("the actor defaults to the OS user name, and an OS user name that is not 1 to 200 characters is a usage error before any read", async () => {
    const h = harness({ osUser: "  carol  " });
    expect(await run(h, ["pause", RUN, "--json"])).toBe(0);
    expect(h.spies.requestControl.mock.calls[0]![1]).toEqual({ runId: RUN, request: "pause", actor: "carol" });

    for (const osUser of ["", "   ", "q".repeat(201)]) {
      const bad = harness({ osUser });
      expect(await run(bad, ["pause", RUN, "--json"]), JSON.stringify(osUser.length)).toBe(2);
      expect(only(bad)).toMatchObject({ kind: "usage_error" });
      expect(totalDepCalls(bad)).toBe(0);
    }
    const explicit = harness({ osUser: "" });
    expect(await run(explicit, ["pause", RUN, "--actor", "dave", "--json"])).toBe(0);
    expect(explicit.spies.osUserName).not.toHaveBeenCalled();
  });

  it("build and budget exit 1 with CCC_PLANNING_COMMAND_NOT_SUPPORTED and touch nothing; the same grammar with a bad value is still a usage error", async () => {
    const build = harness();
    expect(await run(build, ["build", RUN, "--budget-profile", "standard", "--json"])).toBe(1);
    expect(only(build)).toMatchObject({ schema: CCC_PLANNING_CLI_SCHEMA, kind: "refusal", code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", runId: RUN });
    expect(totalDepCalls(build, [])).toBe(0);

    const budget = harness();
    expect(await run(budget, ["budget", RUN, "--amendment", "amend.json", "--json"])).toBe(1);
    expect(only(budget)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", runId: RUN });
    expect(totalDepCalls(budget, [])).toBe(0);

    const bad = harness();
    expect(await run(bad, ["build", RUN, "--budget-profile", "enormous", "--json"])).toBe(2);
  });

  it("pause, cancel and resume on a run without import_id go to L1 and print control_accepted with route planning; deps.applyBuildControl is not called", async () => {
    for (const request of ["pause", "cancel", "resume"] as const) {
      const h = harness({ status: statusFixture(null) });
      expect(await run(h, [request, RUN, "--actor", "alice", "--json"]), request).toBe(0);
      expect(only(h), request).toEqual({
        schema: CCC_PLANNING_CLI_SCHEMA, kind: "control_accepted", runId: RUN, request,
        controlSeq: 7, appliedDirectly: request !== "pause", route: "planning",
      });
      expect(h.spies.requestControl.mock.calls[0]![1], request).toEqual({ runId: RUN, request, actor: "alice" });
      expect(h.spies.applyBuildControl, request).not.toHaveBeenCalled();
    }
  });

  it("a run whose import intent is recorded but not linked yet still goes to L1", async () => {
    const intentOnly = statusFixture(null);
    const status = { ...intentOnly, import: { idempotencyKey: "idem-1", intentDigest: DIGEST, importId: null, importState: null } } as CccPlanningRunStatusV1;
    const h = harness({ status });
    expect(await run(h, ["cancel", RUN, "--actor", "alice", "--json"])).toBe(0);
    expect(h.spies.requestControl).toHaveBeenCalledTimes(1);
    expect(h.spies.applyBuildControl).not.toHaveBeenCalled();
  });

  it("pause, cancel and resume on a linked run call deps.applyBuildControl with the resolved project and never L1; the CL1 refusal exits 1 with COMMAND_NOT_SUPPORTED", async () => {
    for (const request of ["pause", "cancel", "resume"] as const) {
      const h = harness({ status: statusFixture("imp-1"), runs: { [RUN]: [PROJECT_B] } });
      expect(await run(h, [request, RUN, "--actor", "alice", "--json"]), request).toBe(1);
      expect(only(h), request).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", runId: RUN });
      expect(h.spies.applyBuildControl, request).toHaveBeenCalledTimes(1);
      expect(h.spies.applyBuildControl.mock.calls[0]![0], request).toEqual({ projectId: PROJECT_B, runId: RUN, request, actor: "alice" });
      expect(h.spies.requestControl, request).not.toHaveBeenCalled();
      expect(h.events.filter((event) => event.startsWith("close:") || event === "apply"), `${request}: layers are closed before the bridge runs`)
        .toEqual([`close:${PROJECT_B}`, "close:ambient", "apply"]);
    }

    // E4-6: the bridge receives the trimmed actor unchanged at 200 characters, and an over-long one never reaches it.
    const actor200 = "k".repeat(200);
    const exact = harness({ status: statusFixture("imp-1") });
    await run(exact, ["cancel", RUN, "--actor", ` ${actor200} `, "--json"]);
    expect(exact.spies.applyBuildControl.mock.calls[0]![0].actor).toBe(actor200);
    const over = harness({ status: statusFixture("imp-1") });
    expect(await run(over, ["cancel", RUN, "--actor", "k".repeat(2000), "--json"])).toBe(2);
    expect(totalDepCalls(over, [])).toBe(0);
  });

  it("a bridge result is printed as control_accepted on the campaign-bridge route: applied is direct, pending-in-lease is not", async () => {
    const applied = harness({ status: statusFixture("imp-1"), applyBuildControl: async () => ({ kind: "applied", controlSeq: 9 }) });
    expect(await run(applied, ["cancel", RUN, "--actor", "alice", "--json"])).toBe(0);
    expect(only(applied)).toEqual({
      schema: CCC_PLANNING_CLI_SCHEMA, kind: "control_accepted", runId: RUN, request: "cancel", controlSeq: 9, appliedDirectly: true, route: "campaign-bridge",
    });

    const pending = harness({ status: statusFixture("imp-1"), applyBuildControl: async () => ({ kind: "pending-in-lease", controlSeq: 10 }) });
    expect(await run(pending, ["cancel", RUN, "--actor", "alice", "--json"])).toBe(0);
    expect(only(pending)).toEqual({
      schema: CCC_PLANNING_CLI_SCHEMA, kind: "control_accepted", runId: RUN, request: "cancel", controlSeq: 10, appliedDirectly: false, route: "campaign-bridge",
    });

    const refused = harness({ status: statusFixture("imp-1"),
      applyBuildControl: async () => ({ kind: "refused", code: "CCC_PLANNING_STATE_TRANSITION_REFUSED", detail: "cancel in delivering has no ->cancelling transition" }) });
    expect(await run(refused, ["cancel", RUN, "--actor", "alice", "--json"])).toBe(1);
    expect(only(refused)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_STATE_TRANSITION_REFUSED", runId: RUN });

    const stray = harness({ status: statusFixture("imp-1"), applyBuildControl: async () => ({ kind: "refused", code: "ENOENT", detail: "stray" }) });
    expect(await run(stray, ["cancel", RUN, "--actor", "alice", "--json"])).toBe(1);
    expect(only(stray)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_INTERNAL_ERROR" });
  });

  it("answer reads --value or --value-file, calls L1 with the actor and prints answer_accepted; an unreadable file is a usage error before any store call", async () => {
    const inline = harness();
    expect(await run(inline, ["answer", RUN, "--decision", "decision-1", "--value", "use the blue one", "--actor", "alice", "--json"])).toBe(0);
    expect(only(inline)).toEqual({
      schema: CCC_PLANNING_CLI_SCHEMA, kind: "answer_accepted", runId: RUN, decisionId: "decision-1", controlSeq: 4,
      answerArtifactKey: "cccplan-r001-operator-answer4-v001",
    });
    expect(inline.spies.answerDecision.mock.calls[0]![1]).toEqual({ runId: RUN, decisionId: "decision-1", answer: "use the blue one", actor: "alice" });
    expect(inline.spies.readTextFile).not.toHaveBeenCalled();

    const fromFile = harness({ files: { "answer.txt": "line one\nline two\n" } });
    expect(await run(fromFile, ["answer", RUN, "--decision", "decision-1", "--value-file", "answer.txt", "--actor", "alice", "--json"])).toBe(0);
    expect(fromFile.spies.readTextFile).toHaveBeenCalledWith("answer.txt");
    expect(fromFile.spies.answerDecision.mock.calls[0]![1]).toEqual({ runId: RUN, decisionId: "decision-1", answer: "line one\nline two\n", actor: "alice" });

    const missing = harness({ files: {} });
    expect(await run(missing, ["answer", RUN, "--decision", "decision-1", "--value-file", "nope.txt", "--json"])).toBe(2);
    expect(only(missing)).toMatchObject({ kind: "usage_error" });
    expect(missing.spies.openLayer).not.toHaveBeenCalled();
    expect(missing.spies.answerDecision).not.toHaveBeenCalled();

    const empty = harness({ files: { "empty.txt": "" } });
    expect(await run(empty, ["answer", RUN, "--decision", "decision-1", "--value-file", "empty.txt", "--json"])).toBe(2);
    expect(empty.spies.answerDecision).not.toHaveBeenCalled();
  });

  it("an answer value that starts with a dash is taken verbatim, but a value that is another flag is a missing value", async () => {
    const dash = harness();
    expect(await run(dash, ["answer", RUN, "--decision", "d1", "--value", "-5 degrees", "--actor", "a", "--json"])).toBe(0);
    expect((dash.spies.answerDecision.mock.calls[0]![1] as { answer: string }).answer).toBe("-5 degrees");

    const flagValue = harness();
    expect(await run(flagValue, ["answer", RUN, "--decision", "d1", "--value", "--json"])).toBe(2);
    expect(only(flagValue)).toMatchObject({ kind: "usage_error" });
  });

  it("an L1 refusal keeps its own code and field; a code outside the CCC families is an internal error", async () => {
    const families = ["CCC_PLANNING_RUN_TERMINAL", "CCC_ROUTE_RECEIPT_MISSING", "CCC_CONFINEMENT_UNQUALIFIED", "CCC_PROVIDER_PIN_DRIFT", "CCC_CAMPAIGN_OPERATOR_STOP_REFUSED"];
    for (const code of families) {
      const h = harness();
      h.spies.inspectRun.mockRejectedValueOnce(Object.assign(new Error(`${code}: nope`), { code, detail: "bounded detail", field: "runId" }));
      expect(await run(h, ["status", RUN, "--json"]), code).toBe(1);
      expect(only(h), code).toMatchObject({ kind: "refusal", code, detail: "bounded detail", field: "runId", runId: RUN });
    }
    for (const code of ["ENOENT", "23505", "CCC_OTHER_THING", "ccc_planning_lowercase"]) {
      const h = harness();
      h.spies.inspectRun.mockRejectedValueOnce(Object.assign(new Error("something broke"), { code }));
      expect(await run(h, ["status", RUN, "--json"]), code).toBe(1);
      expect(only(h), code).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_INTERNAL_ERROR" });
    }
  });

  it("a thrown internal error exits 1 with CCC_PLANNING_INTERNAL_ERROR and never FUSION_NON_RETRYABLE_EXIT_CODE, even for a unique-violation shape", async () => {
    const shapes: ReadonlyArray<unknown> = [
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
      new Error("plain failure"),
      "a thrown string",
      { cause: { code: "23505" }, message: "wrapped unique violation" },
      undefined,
    ];
    for (const shape of shapes) {
      const h = harness();
      h.spies.inspectRun.mockRejectedValueOnce(shape);
      const exit = await run(h, ["status", RUN, "--json"]);
      expect(exit).toBe(1);
      expect(exit).not.toBe(FUSION_NON_RETRYABLE_EXIT_CODE);
      const line = only(h);
      expect(line).toMatchObject({ schema: CCC_PLANNING_CLI_SCHEMA, kind: "refusal", code: "CCC_PLANNING_INTERNAL_ERROR", runId: RUN });
      expect(String(line.detail).length).toBeLessThanOrEqual(1000);
    }
    const opening = harness();
    opening.spies.openLayer.mockRejectedValueOnce(new Error("no project here"));
    expect(await run(opening, ["status", RUN, "--json"])).toBe(1);
    expect(only(opening)).toMatchObject({ kind: "refusal", code: "CCC_PLANNING_INTERNAL_ERROR" });

    const twin = harness();
    expect(await run(twin, ["status", RUN, "--json"])).toBe(0);
  });

  it("a long diagnostic is bounded and a failing close does not change the outcome", async () => {
    const h = harness();
    h.spies.inspectRun.mockRejectedValueOnce(new Error("e".repeat(50_000)));
    expect(await run(h, ["status", RUN, "--json"])).toBe(1);
    expect(String(only(h).detail).length).toBeLessThanOrEqual(1000);

    const closing = harness();
    closing.spies.openLayer.mockImplementationOnce(async () => ({
      layer: { projectId: PROJECT_A } as unknown as AsyncDataLayer,
      close: async () => { throw new Error("shutdown failed"); },
    }));
    expect(await run(closing, ["status", RUN, "--project", PROJECT_A, "--json"])).toBe(0);
    expect(only(closing).kind).toBe("status");
    expect(closing.stderr.join("\n")).toContain("shutdown failed");
  });

  it("--json keeps stdout to exactly one JSON line and stderr to free text; human mode prints text with the same exit codes", async () => {
    const jsonRefusal = harness({ runs: { [RUN]: [PROJECT_A, PROJECT_B] } });
    expect(await run(jsonRefusal, ["status", RUN, "--json"])).toBe(1);
    expect(jsonRefusal.stdout).toHaveLength(1);
    for (const line of jsonRefusal.stderr) expect(() => JSON.parse(line)).toThrow();

    const human = harness();
    expect(await run(human, ["status", RUN])).toBe(0);
    expect(human.stdout.length).toBeGreaterThan(0);
    expect(human.stdout.join("\n")).toContain(RUN);
    expect(human.stdout.join("\n")).toContain("running");
    for (const line of human.stdout) expect(() => JSON.parse(line)).toThrow();
    expect(human.stderr).toEqual([]);

    const humanRefusal = harness({ runs: { [RUN]: [PROJECT_A, PROJECT_B] } });
    expect(await run(humanRefusal, ["status", RUN])).toBe(1);
    expect(humanRefusal.stdout).toEqual([]);
    expect(humanRefusal.stderr.join("\n")).toContain("CCC_PLANNING_RUN_AMBIGUOUS");

    const humanUsage = harness();
    expect(await run(humanUsage, ["status"])).toBe(2);
    expect(humanUsage.stdout).toEqual([]);
    expect(humanUsage.stderr.join("\n")).toContain("fn plan status RUN_ID");

    const humanControl = harness();
    expect(await run(humanControl, ["cancel", RUN, "--actor", "alice"])).toBe(0);
    expect(humanControl.stdout.join("\n")).toContain("cancel");
    expect(humanControl.stdout.join("\n")).toContain("planning");
  });

  it("the status path hands the linked-outcome port to L1, and the control routing read does not", async () => {
    const reconcileLinkedOutcome = vi.fn(async () => {});
    const h = harness();
    const deps: PlanCommandDeps = { ...h.deps, linkedOutcomePorts: { reconcileLinkedOutcome } };
    expect(await runPlanCommand(["status", RUN, "--json"], deps)).toBe(0);
    expect(h.spies.inspectRun.mock.calls[0]![2]).toEqual({ reconcileLinkedOutcome });

    const control = harness();
    expect(await runPlanCommand(["pause", RUN, "--actor", "a", "--json"], { ...control.deps, linkedOutcomePorts: { reconcileLinkedOutcome } })).toBe(0);
    expect(control.spies.inspectRun.mock.calls[0]![2]).toBeUndefined();
  });
});

function startFlags(options: Readonly<{
  project?: string | null; mode?: string; profile?: string; digest?: string; receipt?: string | null;
}>): string[] {
  const flags: string[] = [];
  if (options.project !== null) flags.push("--project", options.project ?? PROJECT_A);
  flags.push("--request-file", "request.md", "--mode", options.mode ?? "build", "--budget-profile", options.profile ?? "standard");
  if (options.receipt !== null) flags.push("--authority-receipt", options.receipt ?? "receipt.json");
  flags.push("--confirm-authority", options.digest ?? DIGEST);
  return flags;
}
