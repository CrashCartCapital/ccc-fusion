import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type {
  CccCampaignProviderControllerDecision,
  CccCampaignProviderDispatchInput,
  CccProviderAttemptControllerView,
  CccProviderControllerDecisionView,
} from "../ccc-campaign/provider-controller.js";
import type {
  CccProviderAttemptLimitError,
  CccProviderAttemptScope,
  CccProviderAttemptScopeView,
  CccProviderAttemptSettlementInput,
  CccProviderAttemptSettlementInputOf,
} from "../ccc-campaign/types.js";
import type { CccPlanningCallScope, CccReviewFindingRef, CccReviewVerdict } from "../ccc-planning/types.js";

/*
FNXC:CccProviderAttemptViews 2026-10-14-08:40:
Card K1 proof for the Pi seam view types (CONTRACT-v2 section 2.12, decision 0.24). Core cannot import the engine, so the campaign controller is reproduced here structurally, member for member, from `packages/engine/src/agent-runtime.ts` (leader adjudication item 51); card P1 later assigns the real controller. The type assertions only mean something if a compiler checks them, and core's `typecheck` script excludes `*.test.ts`, so this test runs the TypeScript compiler over its own source with core's compiler options and over small negative snippets, and asserts the exact diagnostics.
*/

// ------------------------------------------------------------ compile-time fixtures

/** Member-for-member copy of the engine's `CccProviderAttemptController` (agent-runtime.ts). */
type StructuralCampaignController = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccCampaignProviderControllerDecision>;
  reconcile(input: CccProviderAttemptSettlementInput): Promise<CccProviderAttemptScope>;
}>;

/** The shape L1's `createCccPlanningAttemptController` returns. */
type StructuralPlanningController = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccProviderControllerDecisionView<CccPlanningCallScope>>;
  reconcile(input: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>): Promise<CccPlanningCallScope>;
}>;

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

/** Never called: the compiler checks these bodies, the runtime never executes them. */
export function cccProviderAttemptViewTypeFixtures(
  campaign: StructuralCampaignController,
  planning: StructuralPlanningController,
  campaignScope: CccProviderAttemptScope,
  planningScope: CccPlanningCallScope,
  planningSettlement: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>,
): unknown {
  // Both scopes are views, so one generic seam carries both.
  type _CampaignScopeIsView = Assert<Extends<CccProviderAttemptScope, CccProviderAttemptScopeView>>;
  type _PlanningScopeIsView = Assert<Extends<CccPlanningCallScope, CccProviderAttemptScopeView>>;
  // The campaign settlement input is exactly the view settlement input over the campaign scope, minus refusalReason.
  type _CampaignSettlementIsView = Assert<Extends<CccProviderAttemptSettlementInputOf<CccProviderAttemptScope>, CccProviderAttemptSettlementInput>>;
  const campaignView: CccProviderAttemptControllerView<CccProviderAttemptScope> = campaign;
  const defaultView: CccProviderAttemptControllerView = campaign;
  const planningView: CccProviderAttemptControllerView<CccPlanningCallScope> = planning;
  const fence: CccPlanningCallScope["workItemFence"] = planningScope.workItemFence;
  const refusal: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>["refusalReason"] = "effective-route-drift";
  const reason: CccProviderAttemptLimitError["reason"] = "run-not-building";
  // @ts-expect-error a campaign controller hands back campaign-bound scopes, never planning-bound ones
  const wrongScope: CccProviderAttemptControllerView<CccPlanningCallScope> = campaign;
  // A local object literal annotated as the campaign-scope view (item 51); P1 assigns the real engine controller.
  const literalView: CccProviderAttemptControllerView<CccProviderAttemptScope> = {
    preDispatch: async () => ({ kind: "dispatch-permit", scope: campaignScope }),
    reconcile: async () => campaignScope,
  };
  // Review findings are core types (item 34): a source ref may carry a quote; an unknown ref kind is refused.
  const verdict: CccReviewVerdict = {
    verdict: "reject",
    findings: [{ ref: { kind: "source", artifactKey: "cccplan-r001-research-src1-v01", quote: "exact words" }, severity: "blocking", summary: "misquoted" }],
  };
  // @ts-expect-error a finding ref of an unknown kind is not a CccReviewFindingRef
  const bogusRef: CccReviewFindingRef = { kind: "bogus", text: "x" };
  return [campaignView, defaultView, planningView, fence, refusal, reason, wrongScope, planningSettlement, literalView, verdict, bogusRef] as const;
}

// ------------------------------------------------------------ compiler harness

const TEST_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = dirname(TEST_FILE);
const CORE_ROOT = join(TESTS_DIR, "..", "..");

function coreCompilerOptions(): ts.CompilerOptions {
  const configPath = join(CORE_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  // Passing the config path pins type roots to core: the test workers run in a temp cwd with no node_modules.
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, CORE_ROOT, undefined, configPath);
  return { ...parsed.options, noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false, sourceMap: false };
}

type Finding = Readonly<{ file: string; line: number; code: number; message: string }>;

/** Type-checks the given files (real paths, or virtual sources keyed by absolute path) and returns their diagnostics. */
function typecheck(files: Readonly<Record<string, string | null>>): readonly Finding[] {
  const options = coreCompilerOptions();
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => CORE_ROOT;
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
  const findings: Finding[] = [];
  for (const fileName of Object.keys(files)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) throw new Error(`compiler did not load ${fileName}`);
    for (const diagnostic of [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]) {
      const line = diagnostic.start === undefined ? 0 : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      findings.push({ file: fileName, line, code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
    }
  }
  return findings;
}

const SNIPPET_HEADER = `
import type { CccCampaignProviderControllerDecision, CccCampaignProviderDispatchInput, CccProviderAttemptControllerView } from "../ccc-campaign/provider-controller.js";
import type { CccProviderAttemptScope, CccProviderAttemptSettlementInput, CccProviderAttemptSettlementInputOf } from "../ccc-campaign/types.js";
import type { CccPlanningCallScope } from "../ccc-planning/types.js";
type StructuralCampaignController = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccCampaignProviderControllerDecision>;
  reconcile(input: CccProviderAttemptSettlementInput): Promise<CccProviderAttemptScope>;
}>;
export function probe(campaign: StructuralCampaignController): unknown {
`;

function snippet(name: string, body: string): [string, string] {
  return [join(TESTS_DIR, `__k1_views_${name}.ts`), `${SNIPPET_HEADER}${body}\n}\n`];
}

describe("provider-attempt view types (type-only, compiled in-test)", () => {
  it("compiles this file's structural fixtures with zero diagnostics, so the expect-error line really errors", () => {
    // The @ts-expect-error above turns into TS2578 if the wrong-scope assignment ever compiles.
    expect(typecheck({ [TEST_FILE]: null })).toEqual([]);
  });

  it("refuses a campaign controller as a planning-scope view with an assignability error", () => {
    const [file, text] = snippet("wrong_scope", "  const view: CccProviderAttemptControllerView<CccPlanningCallScope> = campaign;\n  return view;");
    const findings = typecheck({ [file]: text });
    expect(findings.map((finding) => finding.code)).toEqual([2322]);
    expect(findings[0]!.message).toMatch(/ccc-planning-route\.v1|CccPlanningRouteBinding|kind/);
  });

  it("refuses a scope type that is not a view, and a refusal reason outside the closed set", () => {
    const [file, text] = snippet("not_a_view", [
      "  type NotAScope = { attemptKey: string };",
      "  const view: CccProviderAttemptControllerView<NotAScope> | null = null;",
      "  const reason: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>[\"refusalReason\"] = \"model-was-rude\";",
      "  return [view, reason, campaign];",
    ].join("\n"));
    const codes = typecheck({ [file]: text }).map((finding) => finding.code).sort();
    expect(codes).toEqual([2322, 2344]);
  });

  it("accepts the campaign controller as a campaign-scope view (positive control on the same harness)", () => {
    const [file, text] = snippet("campaign_ok", [
      "  const view: CccProviderAttemptControllerView<CccProviderAttemptScope> = campaign;",
      "  const settlement: CccProviderAttemptSettlementInputOf<CccProviderAttemptScope> | null = null;",
      "  return [view, settlement];",
    ].join("\n"));
    expect(typecheck({ [file]: text })).toEqual([]);
  });
});
