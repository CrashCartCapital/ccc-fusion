import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { CccPlanningCallScope, CccProviderAttemptScope } from "@fusion/core";
import type {
  CccProviderAttemptBinding,
  CccProviderAttemptController,
  CccProviderAttemptControllerView,
  CccProviderAttemptSettlementInputOf,
  CccProviderControllerDecisionView,
} from "../agent-runtime.js";
import type { createCccCampaignProviderAttemptBinding } from "../ccc-campaign-provider-controller.js";
import type { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";

/*
FNXC:CccPlanningProviderSeam 2026-10-14-14:40:
Card P1 proof that the Pi seam types still carry the real campaign controller (CONTRACT-v3 section 2.12, verify-v2 item 51). K1 could only assign a structural copy of the engine controller to its view type, because core cannot import the engine; this test assigns the real controller returned by `createCccCampaignProviderAttemptBinding`, both to the engine's `CccProviderAttemptController<CccProviderAttemptScope>` and to K1's own `CccProviderAttemptControllerView<CccProviderAttemptScope>`. The engine's `typecheck` script excludes tests and vitest strips types, so the assertions only mean something when a compiler checks them: the test runs the TypeScript compiler once, with the engine's options and `@fusion/core` pointed at core source, over its own file and a few snippets, and asserts the exact diagnostics.
*/
/*
FNXC:CccPlanningProviderSeam 2026-10-14-17:22:
Repair 1 (errata E5-P1). The planning binding the factory returns is passed to createFnAgent's options and to AgentRuntimeOptions with no cast, because both option properties are typed with the K1 view scope while the binding alias keeps its campaign default (item 5). The engine's view type names are re-exports of K1's, so the compiler resolves each one to its declaration in core (item 6). CccConfinement.bash is typed structurally with the dispose result X1c returns, without importing X1c (items 12, E6-0).
*/

// ------------------------------------------------------------ compile-time fixtures

/** The real campaign controller type, as the engine builds it today. */
type RealCampaignController = Awaited<ReturnType<typeof createCccCampaignProviderAttemptBinding>>["controller"];

/** The shape L1's planning controller returns. */
type StructuralPlanningController = Readonly<{
  preDispatch(input: Parameters<RealCampaignController["preDispatch"]>[0]): Promise<CccProviderControllerDecisionView<CccPlanningCallScope>>;
  reconcile(input: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>): Promise<CccPlanningCallScope>;
}>;

/** Never called: the compiler checks this body, the runtime never executes it. */
export function cccProviderSeamTypeFixtures(real: RealCampaignController, planning: StructuralPlanningController): unknown {
  const campaignController: CccProviderAttemptController<CccProviderAttemptScope> = real;
  const campaignView: CccProviderAttemptControllerView<CccProviderAttemptScope> = real;
  const planningController: CccProviderAttemptController<CccPlanningCallScope> = planning;
  const campaignBinding: CccProviderAttemptBinding = { turnKey: "turn", controller: real };
  const planningBinding: CccProviderAttemptBinding<CccPlanningCallScope> = {
    turnKey: "turn",
    controller: planning,
    receiptAdapterId: "terminal-route-sse-comments.v1",
    scopeKind: "planning",
  };
  // @ts-expect-error a campaign controller hands back campaign-bound scopes, never planning-bound ones
  const wrongScope: CccProviderAttemptController<CccPlanningCallScope> = real;
  return [campaignController, campaignView, planningController, campaignBinding, planningBinding, wrongScope] as const;
}

// ------------------------------------------------------------ compiler harness

const TEST_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = dirname(TEST_FILE);
const ENGINE_ROOT = join(TESTS_DIR, "..", "..");
const CORE_SRC = join(ENGINE_ROOT, "..", "core", "src");

function engineCompilerOptions(): ts.CompilerOptions {
  const configPath = join(ENGINE_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  // Passing the config path pins type roots to the engine: test workers run in a temp cwd with no node_modules.
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ENGINE_ROOT, undefined, configPath);
  const { rootDir: _rootDir, ...options } = parsed.options;
  return {
    ...options,
    // Core source, not core dist: the proof must not depend on a fresh core build.
    paths: { ...options.paths, "@fusion/core": [join(CORE_SRC, "index.ts")], "@fusion/core/*": [join(CORE_SRC, "*")] },
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
}

type Finding = Readonly<{ file: string; line: number; code: number; message: string }>;

/** Type-checks the given files in one program (real paths, or virtual sources keyed by absolute path). */
function typecheck(files: Readonly<Record<string, string | null>>): Readonly<{ program: ts.Program; byFile: ReadonlyMap<string, readonly Finding[]> }> {
  const options = engineCompilerOptions();
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => ENGINE_ROOT;
  const virtual = new Map(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null));
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram({ rootNames: Object.keys(files), options, host });
  const byFile = new Map<string, Finding[]>();
  for (const fileName of Object.keys(files)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) throw new Error(`compiler did not load ${fileName}`);
    const findings: Finding[] = [];
    for (const diagnostic of [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]) {
      const line = diagnostic.start === undefined ? 0 : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      findings.push({ file: fileName, line, code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
    }
    byFile.set(fileName, findings);
  }
  return { program, byFile };
}

const K1_PROVIDER_CONTROLLER = join(CORE_SRC, "ccc-campaign", "provider-controller.js");
const K1_TYPES = join(CORE_SRC, "ccc-campaign", "types.js");

const SNIPPET_HEADER = `
import type { CccPlanningCallScope, CccProviderAttemptScope } from "@fusion/core";
import type * as K1Controller from ${JSON.stringify(K1_PROVIDER_CONTROLLER)};
import type * as K1Types from ${JSON.stringify(K1_TYPES)};
import type * as Engine from "../agent-runtime.js";
import type { createCccCampaignProviderAttemptBinding } from "../ccc-campaign-provider-controller.js";
type Real = Awaited<ReturnType<typeof createCccCampaignProviderAttemptBinding>>["controller"];
type Assert<T extends true> = T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export function probe(real: Real): unknown {
`;

function snippet(name: string, body: string): [string, string] {
  return [join(TESTS_DIR, `__p1_seam_${name}.ts`), `${SNIPPET_HEADER}${body}\n}\n`];
}

const ITEM_51 = snippet("item51", [
  "  // Item 51: the real engine campaign controller is a K1 campaign-scope view.",
  "  const view: K1Controller.CccProviderAttemptControllerView<CccProviderAttemptScope> = real;",
  "  // The engine mirrors are K1's view types exactly, for both scopes.",
  "  type _RouteBinding = Assert<Same<Engine.CccProviderAttemptRouteBindingView, K1Types.CccProviderAttemptRouteBindingView>>;",
  "  type _ScopeView = Assert<Same<Engine.CccProviderAttemptScopeView, K1Types.CccProviderAttemptScopeView>>;",
  "  type _CampaignSettlement = Assert<Same<Engine.CccProviderAttemptSettlementInputOf<CccProviderAttemptScope>, K1Types.CccProviderAttemptSettlementInputOf<CccProviderAttemptScope>>>;",
  "  type _PlanningSettlement = Assert<Same<Engine.CccProviderAttemptSettlementInputOf<CccPlanningCallScope>, K1Types.CccProviderAttemptSettlementInputOf<CccPlanningCallScope>>>;",
  "  type _Refusal = Assert<Same<Engine.CccProviderAttemptRefusalReason, NonNullable<K1Types.CccProviderAttemptSettlementInputOf<CccPlanningCallScope>[\"refusalReason\"]>>>;",
  "  type _CampaignDecision = Assert<Same<Engine.CccProviderControllerDecisionView<CccProviderAttemptScope>, K1Controller.CccProviderControllerDecisionView<CccProviderAttemptScope>>>;",
  "  type _PlanningDecision = Assert<Same<Engine.CccProviderControllerDecisionView<CccPlanningCallScope>, K1Controller.CccProviderControllerDecisionView<CccPlanningCallScope>>>;",
  "  type _CampaignController = Assert<Same<Engine.CccProviderAttemptControllerView<CccProviderAttemptScope>, K1Controller.CccProviderAttemptControllerView<CccProviderAttemptScope>>>;",
  "  type _PlanningController = Assert<Same<Engine.CccProviderAttemptControllerView<CccPlanningCallScope>, K1Controller.CccProviderAttemptControllerView<CccPlanningCallScope>>>;",
  "  type _Alias = Assert<Same<Engine.CccProviderAttemptController<CccPlanningCallScope>, Engine.CccProviderAttemptControllerView<CccPlanningCallScope>>>;",
  "  return view;",
].join("\n"));

const WRONG_SCOPE = snippet("wrong_scope", [
  "  const view: K1Controller.CccProviderAttemptControllerView<CccPlanningCallScope> = real;",
  "  return view;",
].join("\n"));

/** E5-P1 items 5 and 12: written without a cast, so any assignability error is a finding. */
const PLANNING_OPTIONS: [string, string] = [join(TESTS_DIR, "__p1_seam_planning_options.ts"), [
  'import type { BashOperations } from "@earendil-works/pi-coding-agent";',
  'import type { CccProviderAttemptScope } from "@fusion/core";',
  'import type { AgentOptions } from "../pi.js";',
  'import type * as Engine from "../agent-runtime.js";',
  'import type { createCccPlanningProviderAttemptBinding } from "../ccc-planning/provider-binding.js";',
  "type Assert<T extends true> = T;",
  "type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
  "type FactoryBinding = ReturnType<typeof createCccPlanningProviderAttemptBinding>;",
  "export function probe(binding: FactoryBinding): unknown {",
  '  const fnAgentOptions: Pick<AgentOptions, "cccProviderAttemptBinding"> = { cccProviderAttemptBinding: binding };',
  '  const runtimeOptions: Pick<Engine.AgentRuntimeOptions, "cccProviderAttemptBinding"> = { cccProviderAttemptBinding: binding };',
  "  return [fnAgentOptions, runtimeOptions];",
  "}",
  "// The campaign alias keeps its campaign default, so campaign code reads campaign-typed scopes back.",
  "export type CampaignDefault = Assert<Same<Engine.CccProviderAttemptBinding, Engine.CccProviderAttemptBinding<CccProviderAttemptScope>>>;",
  "// E4-9 and E6-0: the structural dispose result, with no X1c import.",
  'export type ConfinedBash = Assert<Same<Engine.CccConfinement["bash"], (BashOperations & { dispose(): Promise<Readonly<{ closure: "confirmed" | "unconfirmed" }>> }) | null>>;',
  "",
].join("\n")];

/** The K1 view types the engine must take from core instead of redefining (E5-P1 item 6). */
const K1_VIEW_TYPES = Object.freeze([
  ["CccProviderAttemptRouteBindingView", join(CORE_SRC, "ccc-campaign", "types.ts")],
  ["CccProviderAttemptScopeView", join(CORE_SRC, "ccc-campaign", "types.ts")],
  ["CccProviderAttemptRefusalReason", join(CORE_SRC, "ccc-campaign", "types.ts")],
  ["CccProviderAttemptSettlementInputOf", join(CORE_SRC, "ccc-campaign", "types.ts")],
  ["CccProviderControllerDecisionView", join(CORE_SRC, "ccc-campaign", "provider-controller.ts")],
  ["CccProviderAttemptControllerView", join(CORE_SRC, "ccc-campaign", "provider-controller.ts")],
] as const);
const AGENT_RUNTIME = join(ENGINE_ROOT, "src", "agent-runtime.ts");

/** Where the compiler finds the declaration behind each named export of a module, following re-export aliases. */
function exportDeclarationFiles(program: ts.Program, moduleFile: string): ReadonlyMap<string, readonly string[]> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(moduleFile);
  if (!source) throw new Error(`compiler did not load ${moduleFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${moduleFile} is not a module`);
  const declarations = new Map<string, readonly string[]>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    declarations.set(exported.name, (target.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName));
  }
  return declarations;
}

const NON_VACUOUS = snippet("non_vacuous", [
  "  // Same<> is strict: a campaign scope is a view but not the view itself.",
  "  type _NotSame = Assert<Same<Engine.CccProviderAttemptScopeView, CccProviderAttemptScope>>;",
  "  const scopeKind: Engine.CccProviderAttemptBinding[\"scopeKind\"] = \"planning-writer\";",
  "  return [real, scopeKind];",
].join("\n"));

describe("Pi seam types carry the real campaign controller (type-only, compiled in-test)", () => {
  let findings: ReadonlyMap<string, readonly Finding[]>;
  let program: ts.Program;

  beforeAll(() => {
    const checked = typecheck({
      [TEST_FILE]: null,
      [ITEM_51[0]]: ITEM_51[1],
      [WRONG_SCOPE[0]]: WRONG_SCOPE[1],
      [NON_VACUOUS[0]]: NON_VACUOUS[1],
      [PLANNING_OPTIONS[0]]: PLANNING_OPTIONS[1],
    });
    findings = checked.byFile;
    program = checked.program;
  });

  it("the campaign controller still satisfies CccProviderAttemptController<CccProviderAttemptScope>", () => {
    expectTypeOf<RealCampaignController>().toExtend<CccProviderAttemptController<CccProviderAttemptScope>>();
    expectTypeOf<ReturnType<typeof createCccPlanningProviderAttemptBinding>>().toEqualTypeOf<CccProviderAttemptBinding<CccPlanningCallScope>>();
    // This file's fixtures and expectTypeOf lines compile cleanly, so the @ts-expect-error line above really errors.
    expect(findings.get(TEST_FILE)).toEqual([]);
  });

  it("assigns the real campaign controller to K1's CccProviderAttemptControllerView<CccProviderAttemptScope> (item 51)", () => {
    expect(findings.get(ITEM_51[0])).toEqual([]);
  });

  it("refuses the real campaign controller as a planning-scope K1 view with an assignability error", () => {
    const wrong = findings.get(WRONG_SCOPE[0]) ?? [];
    expect(wrong).toHaveLength(1);
    // TS2719 is TS2322's wording when both sides print the same truncated type name.
    expect([2322, 2719]).toContain(wrong[0]!.code);
    expect(wrong[0]!.message).toMatch(/is not assignable to type/);
    expect(wrong[0]!.message).toMatch(/The types returned by 'preDispatch\(\.\.\.\)' are incompatible/);
  });

  it("the equality check is strict and the scope kind is a closed set", () => {
    const codes = (findings.get(NON_VACUOUS[0]) ?? []).map((finding) => finding.code).sort();
    expect(codes).toEqual([2322, 2344]);
  });

  it("passes the planning factory binding to createFnAgent options and AgentRuntimeOptions with no cast, and types the confined bash dispose structurally (E5-P1 items 5 and 12)", () => {
    expect(findings.get(PLANNING_OPTIONS[0])).toEqual([]);
  });

  it("re-exports K1's view types from core instead of keeping engine copies (E5-P1 item 6)", () => {
    const declared = exportDeclarationFiles(program, AGENT_RUNTIME);
    for (const [name, coreFile] of K1_VIEW_TYPES) {
      expect({ name, files: declared.get(name) }).toEqual({ name, files: [coreFile] });
    }
  });
});
