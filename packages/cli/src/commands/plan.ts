/*
FNXC:CccPlanningCli 2026-10-14-22:42:
`fn plan` (card CL1; CONTRACT-v3.5 section 2.19, D35, D49, errata E2-4/E4-6). The operator's command surface for a request-to-code run: a positional RUN_ID, an optional `--project` that is otherwise resolved from the run row, exit 0 for success, 1 for a semantic refusal and 2 for a usage error, and exactly one JSON line on stdout under `--json`. bin.ts routes `plan` before its own `--project` parse, so this file owns every usage error (D35).

A thrown error never leaves this file: an error carrying a `CCC_PLANNING_*`, `CCC_ROUTE_*`, `CCC_CONFINEMENT_*`, `CCC_PROVIDER_*` or `CCC_CAMPAIGN_OPERATOR_*` code is a refusal that keeps its code, and everything else is a refusal with `CCC_PLANNING_INTERNAL_ERROR`. Both exit 1, so bin's catch (which maps a unique violation to FUSION_NON_RETRYABLE_EXIT_CODE) is never reached.

CL2 adds the `start` path and wires the build control bridge into `deps.applyBuildControl`; CL1 parses the whole `start` grammar (its usage errors are CL1's) and refuses a well-formed start with CCC_PLANNING_COMMAND_NOT_SUPPORTED until then. The L1 store operations are the injected `deps.ledger`, so the grammar and routing run without PostgreSQL; `createDefaultPlanCommandDeps` binds the real ones from @fusion/core and loads them lazily, the way bin.ts keeps application imports dynamic until its environment is configured.
*/
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import type {
  AsyncDataLayer,
  CccPlanningLinkedOutcomePorts,
  CccPlanningRunStatusV1,
  answerCccPlanningDecision,
  inspectCccPlanningRun,
  requestCccPlanningControl,
  resolveCccPlanningRunProject,
} from "@fusion/core";

export const CCC_PLANNING_CLI_SCHEMA = "ccc-planning.cli.v1" as const;

export type CccPlanningCliLineV1 =
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "run_admitted"; runId: string; projectId: string;
      planningTaskId: string; state: "admitted"; deadlineAt: string; receiptSha256: string;
      allocations: Readonly<{ planning: number; implementation: number; reviewProof: number }>; plannedPlanningNodes: number }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "status"; status: CccPlanningRunStatusV1 }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "control_accepted"; runId: string;
      request: "pause" | "cancel" | "resume"; controlSeq: number; appliedDirectly: boolean; route: "planning" | "campaign-bridge" }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "answer_accepted"; runId: string; decisionId: string;
      controlSeq: number; answerArtifactKey: string }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "refusal"; code: string; detail: string; field?: string; runId?: string }>
  | Readonly<{ schema: typeof CCC_PLANNING_CLI_SCHEMA; kind: "usage_error"; code: "CCC_PLANNING_CLI_USAGE"; detail: string; usage: string }>;

export const CCC_PLANNING_CLI_EXIT = { success: 0, refusal: 1, usage: 2 } as const;

/** The L1 operations `fn plan` calls, typed as the L1 functions themselves so a signature change fails the CLI typecheck. */
export type PlanLedgerOps = Readonly<{
  resolveRunProject: typeof resolveCccPlanningRunProject;
  inspectRun: typeof inspectCccPlanningRun;
  requestControl: typeof requestCccPlanningControl;
  answerDecision: typeof answerCccPlanningDecision;
}>;

export type PlanCommandDeps = Readonly<{
  ledger: PlanLedgerOps;
  /** Opens a PostgreSQL layer: for the named project, or for the ambient (default or working-directory) project when none is named. */
  openLayer: (i: Readonly<{ projectId?: string }>) => Promise<Readonly<{ layer: AsyncDataLayer; close: () => Promise<void> }>>;
  /** Handed to L1 `inspectCccPlanningRun` by `fn plan status` (BF's reconcile; CL2 wires it). */
  linkedOutcomePorts?: CccPlanningLinkedOutcomePorts;
  applyBuildControl: (i: Readonly<{ projectId: string; runId: string; request: "pause" | "cancel" | "resume"; actor: string }>) =>
    Promise<Readonly<{ kind: "applied" | "pending-in-lease"; controlSeq: number } | { kind: "refused"; code: string; detail: string }>>;
  // CL1 default: refused CCC_PLANNING_COMMAND_NOT_SUPPORTED ("build control bridge not wired"); CL2 wires CB
  osUserName: () => string;
  readTextFile: (path: string) => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}>;

// ---------------------------------------------------------------- grammar

type ControlRequest = "pause" | "cancel" | "resume";

type Spec = Readonly<{
  /** Whether the subcommand takes the positional RUN_ID. */
  runId: boolean;
  valueFlags: readonly string[];
  required: readonly string[];
  usage: string;
}>;

const START_USAGE = "fn plan start --project <id> --request-file <path> --mode spec|build --budget-profile standard|large --authority-receipt <path> --confirm-authority <sha256> [--json]";
const STATUS_USAGE = "fn plan status RUN_ID [--project <id>] [--json]";
const ANSWER_USAGE = "fn plan answer RUN_ID --decision <decisionId> (--value <text> | --value-file <path>) [--actor <name>] [--project <id>] [--json]";
const CONTROL_USAGE = "fn plan pause|cancel|resume RUN_ID [--actor <name>] [--project <id>] [--json]";
const BUILD_USAGE = "fn plan build RUN_ID --budget-profile standard|large [--project <id>] [--json]";
const BUDGET_USAGE = "fn plan budget RUN_ID --amendment <file> [--project <id>] [--json]";
const ALL_USAGE = [START_USAGE, STATUS_USAGE, ANSWER_USAGE, CONTROL_USAGE, BUILD_USAGE, BUDGET_USAGE].join("\n");

const START_FLAGS = ["--project", "--request-file", "--mode", "--budget-profile", "--authority-receipt", "--confirm-authority"] as const;
const CONTROL_SPEC: Spec = { runId: true, valueFlags: ["--actor", "--project"], required: [], usage: CONTROL_USAGE };

const SPECS: ReadonlyMap<string, Spec> = new Map<string, Spec>([
  ["start", { runId: false, valueFlags: START_FLAGS, required: START_FLAGS, usage: START_USAGE }],
  ["status", { runId: true, valueFlags: ["--project"], required: [], usage: STATUS_USAGE }],
  ["answer", { runId: true, valueFlags: ["--decision", "--value", "--value-file", "--actor", "--project"], required: ["--decision"], usage: ANSWER_USAGE }],
  ["pause", CONTROL_SPEC],
  ["cancel", CONTROL_SPEC],
  ["resume", CONTROL_SPEC],
  ["build", { runId: true, valueFlags: ["--budget-profile", "--project"], required: ["--budget-profile"], usage: BUILD_USAGE }],
  ["budget", { runId: true, valueFlags: ["--amendment", "--project"], required: ["--amendment"], usage: BUDGET_USAGE }],
]);

const MODES: readonly string[] = ["spec", "build"];
const BUDGET_PROFILES: readonly string[] = ["standard", "large"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/** E2-4, E4-6: the CLI refuses first, so an actor that reaches L1 out of range is a caller bug. */
const ACTOR_MAX = 200;
const DETAIL_MAX = 1000;

type Fault = Readonly<{ kind: "fault"; detail: string; usage: string }>;

type ParsedPlan = Readonly<
  | { kind: "start" }
  | { kind: "status"; runId: string; project: string | undefined }
  | { kind: "answer"; runId: string; project: string | undefined; decisionId: string; actor: string;
      value: Readonly<{ kind: "inline"; text: string } | { kind: "file"; path: string }> }
  | { kind: "control"; request: ControlRequest; runId: string; project: string | undefined; actor: string }
  | { kind: "build"; runId: string }
  | { kind: "budget"; runId: string }
>;

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 3)}...` : text;
}

function fault(detail: string, usage: string): Fault {
  return { kind: "fault", detail: clip(detail), usage };
}

/**
 * Pure: no dep other than the OS user lookup is touched, so a usage error is decided before any read or write (E2-4).
 * A value flag takes the next token verbatim, so an answer such as `-5 degrees` works; a value that is exactly one of the
 * subcommand's own flags is a missing value instead.
 */
function parsePlanArgs(argv: readonly string[], osUserName: () => string): ParsedPlan | Fault {
  const name = argv[0];
  if (name === undefined || name.startsWith("-")) return fault("a subcommand is required", ALL_USAGE);
  const spec = SPECS.get(name);
  if (spec === undefined) return fault(`unknown subcommand ${JSON.stringify(clip(name))}`, ALL_USAGE);

  const values = new Map<string, string>();
  const positionals: string[] = [];
  let sawJson = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      if (sawJson) return fault("duplicate flag --json", spec.usage);
      sawJson = true;
      continue;
    }
    if (spec.valueFlags.includes(token)) {
      if (values.has(token)) return fault(`duplicate flag ${token}`, spec.usage);
      const next = argv[index + 1];
      if (next === undefined || next === "--json" || spec.valueFlags.includes(next)) return fault(`${token} requires a value`, spec.usage);
      if (next.length === 0) return fault(`${token} must not be empty`, spec.usage);
      values.set(token, next);
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) return fault(`unknown flag ${JSON.stringify(clip(token))} for fn plan ${name}`, spec.usage);
    positionals.push(token);
  }

  let runId: string | undefined;
  if (spec.runId) {
    if (positionals.length === 0) return fault("RUN_ID is required", spec.usage);
    if (positionals.length > 1) return fault(`unexpected argument ${JSON.stringify(clip(positionals[1]!))}; fn plan ${name} takes one RUN_ID`, spec.usage);
    runId = positionals[0]!;
  } else if (positionals.length > 0) {
    return fault(`unexpected argument ${JSON.stringify(clip(positionals[0]!))}; fn plan ${name} takes no RUN_ID`, spec.usage);
  }
  for (const flag of spec.required) {
    if (!values.has(flag)) return fault(`${flag} is required`, spec.usage);
  }
  const project = values.get("--project");

  const resolveActor = (): string | Fault => {
    let raw = values.get("--actor");
    if (raw === undefined) {
      try {
        raw = osUserName();
      } catch {
        raw = "";
      }
    }
    const actor = raw.trim();
    if (actor.length < 1 || actor.length > ACTOR_MAX) {
      return fault(`--actor must be 1 to ${ACTOR_MAX} characters after trimming; pass --actor <name>`, spec.usage);
    }
    return actor;
  };

  switch (name) {
    case "start": {
      if (!MODES.includes(values.get("--mode")!)) return fault("--mode must be spec or build", spec.usage);
      if (!BUDGET_PROFILES.includes(values.get("--budget-profile")!)) return fault("--budget-profile must be standard or large", spec.usage);
      if (!SHA256_PATTERN.test(values.get("--confirm-authority")!)) return fault("--confirm-authority must be 64 lowercase hex characters (a sha256)", spec.usage);
      return { kind: "start" };
    }
    case "status":
      return { kind: "status", runId: runId!, project };
    case "answer": {
      const inline = values.get("--value");
      const file = values.get("--value-file");
      if (inline !== undefined && file !== undefined) return fault("pass --value or --value-file, not both", spec.usage);
      if (inline === undefined && file === undefined) return fault("one of --value or --value-file is required", spec.usage);
      const actor = resolveActor();
      if (typeof actor !== "string") return actor;
      return {
        kind: "answer", runId: runId!, project, decisionId: values.get("--decision")!, actor,
        value: inline !== undefined ? { kind: "inline", text: inline } : { kind: "file", path: file! },
      };
    }
    case "pause":
    case "cancel":
    case "resume": {
      const actor = resolveActor();
      if (typeof actor !== "string") return actor;
      return { kind: "control", request: name, runId: runId!, project, actor };
    }
    case "build":
      if (!BUDGET_PROFILES.includes(values.get("--budget-profile")!)) return fault("--budget-profile must be standard or large", spec.usage);
      return { kind: "build", runId: runId! };
    default:
      return { kind: "budget", runId: runId! };
  }
}

// ---------------------------------------------------------------- lines

function usageLine(detail: string, usage: string): CccPlanningCliLineV1 {
  return { schema: CCC_PLANNING_CLI_SCHEMA, kind: "usage_error", code: "CCC_PLANNING_CLI_USAGE", detail: clip(detail), usage };
}

const REFUSAL_CODE_FAMILIES = ["CCC_PLANNING_", "CCC_ROUTE_", "CCC_CONFINEMENT_", "CCC_PROVIDER_", "CCC_CAMPAIGN_OPERATOR_"] as const;

function isRefusalCode(code: unknown): code is string {
  return typeof code === "string" && REFUSAL_CODE_FAMILIES.some((family) => code.startsWith(family));
}

function refusalLine(i: Readonly<{ code: string; detail: string; field?: string; runId?: string }>): CccPlanningCliLineV1 {
  const known = isRefusalCode(i.code);
  return {
    schema: CCC_PLANNING_CLI_SCHEMA, kind: "refusal",
    code: known ? i.code : "CCC_PLANNING_INTERNAL_ERROR",
    detail: clip(known ? i.detail : `${i.code}: ${i.detail}`),
    ...(i.field === undefined ? {} : { field: i.field }),
    ...(i.runId === undefined ? {} : { runId: i.runId }),
  };
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function refusalFromError(error: unknown, runId: string | undefined): CccPlanningCliLineV1 {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; detail?: unknown; field?: unknown; message?: unknown } : undefined;
  if (record !== undefined && isRefusalCode(record.code)) {
    const detail = typeof record.detail === "string" ? record.detail : typeof record.message === "string" ? record.message : record.code;
    return refusalLine({
      code: record.code, detail,
      ...(typeof record.field === "string" ? { field: record.field } : {}),
      ...(runId === undefined ? {} : { runId }),
    });
  }
  return refusalLine({ code: "CCC_PLANNING_INTERNAL_ERROR", detail: describeThrown(error), ...(runId === undefined ? {} : { runId }) });
}

function renderStatus(status: CccPlanningRunStatusV1): string[] {
  const out = [
    `run ${status.runId}  project ${status.projectId}  task ${status.planningTaskId}`,
    `state ${status.state}${status.stateCode === null ? "" : ` (${status.stateCode})`}  mode ${status.mode}  budget ${status.budgetProfile}  revision ${status.revision}  control ${status.controlSeq}`,
    `deadline ${status.deadlineAt}`,
  ];
  if (status.pendingControl !== null) out.push(`pending control: ${status.pendingControl.request} since ${status.pendingControl.requestedAt}`);
  if (status.awaitingDecision !== null) out.push(`awaiting decision ${status.awaitingDecision.decisionId} (question ${status.awaitingDecision.questionArtifactKey})`);
  const budgets = status.budgets;
  out.push(
    `planning ${budgets.planning.spent}/${budgets.planning.allocation}  implementation ${budgets.implementation.spent ?? "-"}/${budgets.implementation.allocation}  review and proof ${budgets.reviewProof.spent}/${budgets.reviewProof.allocation}`,
  );
  out.push(`stages: ${status.stages.map((stage) => `${stage.stageId}=${stage.status}`).join(" ") || "none"}`);
  if (status.unreconciled.length > 0) out.push(`unreconciled dispatches: ${status.unreconciled.length}`);
  if (status.import !== null) out.push(`import: ${status.import.importId ?? "intent recorded"}${status.import.importState === null ? "" : ` (${status.import.importState})`}`);
  if (status.notRun.length > 0) out.push(`not run: ${status.notRun.join(", ")}`);
  return out;
}

function renderHuman(line: CccPlanningCliLineV1): string[] {
  switch (line.kind) {
    case "run_admitted":
      return [`run ${line.runId} admitted in project ${line.projectId}: task ${line.planningTaskId}, deadline ${line.deadlineAt}, ${line.plannedPlanningNodes} planned nodes`];
    case "status":
      return renderStatus(line.status);
    case "control_accepted":
      return [`${line.request} accepted for run ${line.runId}: control ${line.controlSeq}, ${line.appliedDirectly ? "applied directly" : "pending"}, route ${line.route}`];
    case "answer_accepted":
      return [`answer accepted for run ${line.runId}: decision ${line.decisionId}, control ${line.controlSeq}, artifact ${line.answerArtifactKey}`];
    case "refusal":
      return [`refused: ${line.code}: ${line.detail}${line.field === undefined ? "" : ` (field ${line.field})`}${line.runId === undefined ? "" : ` (run ${line.runId})`}`];
    case "usage_error":
      return [`usage error: ${line.detail}`, "usage:", ...line.usage.split("\n").map((entry) => `  ${entry}`)];
  }
}

/**
 * Under `--json` stdout holds exactly the one JSON line and stderr holds a free-text diagnostic for a refusal or a usage
 * error; in human mode a success goes to stdout and a refusal or usage error to stderr. The exit code follows the kind.
 */
function emit(deps: PlanCommandDeps, json: boolean, line: CccPlanningCliLineV1): 0 | 1 | 2 {
  const exit = line.kind === "usage_error" ? CCC_PLANNING_CLI_EXIT.usage
    : line.kind === "refusal" ? CCC_PLANNING_CLI_EXIT.refusal
      : CCC_PLANNING_CLI_EXIT.success;
  const failed = line.kind === "usage_error" || line.kind === "refusal";
  try {
    if (json) {
      deps.stdout(JSON.stringify(line));
      if (failed) for (const text of renderHuman(line)) deps.stderr(text);
    } else {
      for (const text of renderHuman(line)) (failed ? deps.stderr : deps.stdout)(text);
    }
  } catch {
    // An output stream that cannot be written (a closed pipe) must not turn the outcome into a crash; the exit code still tells it.
  }
  return exit;
}

// ---------------------------------------------------------------- execution

type OpenedLayer = Readonly<{ layer: AsyncDataLayer; close: () => Promise<void> }>;

async function closeQuietly(deps: PlanCommandDeps, opened: OpenedLayer): Promise<void> {
  try {
    await opened.close();
  } catch (error) {
    deps.stderr(`warning: closing the project store failed: ${clip(describeThrown(error))}`);
  }
}

/**
 * D49: the project comes from the run row. L1 `resolveCccPlanningRunProject` does the bypass-scoped lookup over a layer for
 * the `--project` named (or the ambient project) and refuses a missing, ambiguous or mismatched run; every later call runs
 * on a layer bound to the resolved project, and the lookup layer is reused when it already is that project.
 */
async function withRunProject<T>(deps: PlanCommandDeps, i: Readonly<{ runId: string; project: string | undefined }>,
  work: (layer: AsyncDataLayer, projectId: string) => Promise<T>): Promise<T> {
  const named = i.project === undefined ? {} : { projectId: i.project };
  const lookup = await deps.openLayer(named);
  let bound: OpenedLayer | undefined;
  try {
    const { projectId } = await deps.ledger.resolveRunProject(lookup.layer, { runId: i.runId, ...named });
    let layer = lookup.layer;
    if (lookup.layer.projectId !== projectId) {
      bound = await deps.openLayer({ projectId });
      layer = bound.layer;
    }
    return await work(layer, projectId);
  } finally {
    if (bound !== undefined) await closeQuietly(deps, bound);
    await closeQuietly(deps, lookup);
  }
}

function controlLine(i: Readonly<{ runId: string; request: ControlRequest; controlSeq: number; appliedDirectly: boolean;
  route: "planning" | "campaign-bridge" }>): CccPlanningCliLineV1 {
  return { schema: CCC_PLANNING_CLI_SCHEMA, kind: "control_accepted", runId: i.runId, request: i.request, controlSeq: i.controlSeq,
    appliedDirectly: i.appliedDirectly, route: i.route };
}

async function executePlan(parsed: ParsedPlan, deps: PlanCommandDeps): Promise<CccPlanningCliLineV1> {
  switch (parsed.kind) {
    case "start":
      return refusalLine({ code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", detail: "fn plan start is not available in this build" });
    case "build":
      return refusalLine({ code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", detail: "fn plan build is not supported until a later increment (I4)", runId: parsed.runId });
    case "budget":
      return refusalLine({ code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED", detail: "fn plan budget is not supported until a later increment (I4)", runId: parsed.runId });
    case "status":
      return withRunProject(deps, parsed, async (layer) => ({
        schema: CCC_PLANNING_CLI_SCHEMA, kind: "status" as const,
        status: await deps.ledger.inspectRun(layer, parsed.runId, deps.linkedOutcomePorts),
      }));
    case "answer": {
      let answer: string;
      if (parsed.value.kind === "inline") {
        answer = parsed.value.text;
      } else {
        try {
          answer = await deps.readTextFile(parsed.value.path);
        } catch (error) {
          return usageLine(`--value-file ${JSON.stringify(clip(parsed.value.path))} cannot be read: ${describeThrown(error)}`, ANSWER_USAGE);
        }
        if (answer.length === 0) return usageLine(`--value-file ${JSON.stringify(clip(parsed.value.path))} is empty`, ANSWER_USAGE);
      }
      const accepted = await withRunProject(deps, parsed, (layer) =>
        deps.ledger.answerDecision(layer, { runId: parsed.runId, decisionId: parsed.decisionId, answer, actor: parsed.actor }));
      return { schema: CCC_PLANNING_CLI_SCHEMA, kind: "answer_accepted", runId: parsed.runId, decisionId: parsed.decisionId,
        controlSeq: accepted.controlSeq, answerArtifactKey: accepted.answerArtifactKey };
    }
    case "control": {
      /*
      Control routing (section 2.19): a run with an import_id goes to deps.applyBuildControl, any other run to L1
      requestCccPlanningControl. The status read decides, and the layers are closed before the bridge runs, so the bridge
      never nests inside this command's store lifetime.
      */
      const routed = await withRunProject(deps, parsed, async (layer, projectId) => {
        const status = await deps.ledger.inspectRun(layer, parsed.runId);
        if (status.import !== null && status.import.importId !== null) return { linked: true as const, projectId };
        const accepted = await deps.ledger.requestControl(layer, { runId: parsed.runId, request: parsed.request, actor: parsed.actor });
        return { linked: false as const, accepted };
      });
      if (!routed.linked) {
        return controlLine({ runId: parsed.runId, request: parsed.request, controlSeq: routed.accepted.controlSeq,
          appliedDirectly: routed.accepted.appliedDirectly, route: "planning" });
      }
      const result = await deps.applyBuildControl({ projectId: routed.projectId, runId: parsed.runId, request: parsed.request, actor: parsed.actor });
      if (result.kind === "refused") return refusalLine({ code: result.code, detail: result.detail, runId: parsed.runId });
      return controlLine({ runId: parsed.runId, request: parsed.request, controlSeq: result.controlSeq,
        appliedDirectly: result.kind === "applied", route: "campaign-bridge" });
    }
  }
}

export async function runPlanCommand(argv: readonly string[], deps: PlanCommandDeps): Promise<0 | 1 | 2> {
  const json = argv.includes("--json");
  let runId: string | undefined;
  let line: CccPlanningCliLineV1;
  try {
    const parsed = parsePlanArgs(argv, deps.osUserName);
    if (parsed.kind === "fault") {
      line = usageLine(parsed.detail, parsed.usage);
    } else {
      if (parsed.kind !== "start") runId = parsed.runId;
      line = await executePlan(parsed, deps);
    }
  } catch (error) {
    line = refusalFromError(error, runId);
  }
  return emit(deps, json, line);
}

// ---------------------------------------------------------------- default wiring

export function createDefaultPlanCommandDeps(): PlanCommandDeps {
  return {
    ledger: {
      resolveRunProject: async (layer, input) => (await import("@fusion/core")).resolveCccPlanningRunProject(layer, input),
      inspectRun: async (layer, runId, ports) => (await import("@fusion/core")).inspectCccPlanningRun(layer, runId, ports),
      requestControl: async (layer, input) => (await import("@fusion/core")).requestCccPlanningControl(layer, input),
      answerDecision: async (layer, input) => (await import("@fusion/core")).answerCccPlanningDecision(layer, input),
    },
    openLayer: async ({ projectId }) => {
      const { resolveProject, closeProjectStore } = await import("../project-context.js");
      const context = await resolveProject(projectId);
      const layer = context.store.getAsyncLayer();
      if (!layer) {
        await closeProjectStore(context);
        const { CccPlanningRefusal } = await import("@fusion/core");
        throw new CccPlanningRefusal("CCC_PLANNING_POSTGRES_REQUIRED", `PostgreSQL AsyncDataLayer unavailable for ${context.projectPath}`);
      }
      return { layer, close: () => closeProjectStore(context) };
    },
    applyBuildControl: async () => ({
      kind: "refused",
      code: "CCC_PLANNING_COMMAND_NOT_SUPPORTED",
      detail: "build control bridge not wired",
    }),
    osUserName: () => {
      try {
        return userInfo().username;
      } catch {
        return "";
      }
    },
    readTextFile: (path) => readFile(path, "utf8"),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}
