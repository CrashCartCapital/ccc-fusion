import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  hydrateCccPrdSemanticProofV2Custody,
  parseCccCampaignProductExecutionPolicy,
  type CccPlanningAcceptanceCasesV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdAuthoringProposalV2,
  type CccPrdDiagnostic,
  type CccPrdProofV2,
  type CccPrdSemanticBundle,
  type CccPrdSemanticBundleV2,
} from "@fusion/core";
import { createCccPrdImportTestBundle, rehashCccPrdImportTestBundle } from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import { assertCccPrdImportBundle } from "../../../core/src/ccc-prd/import-admission.js";
import { nativeWorkflowIr } from "../../../core/src/ccc-prd/importer.js";
import { CCC_PLANNING_G4_SOURCE_PATHS, runCccPlanningG4, type CccPlanningG4Input } from "../ccc-planning/gates.js";
import {
  CCC_PLANNING_PACKET_SOURCES,
  cccPlanningPacketSourcePath,
  renderCccPlanningAdmissionFacts,
  renderCccPlanningFinalPrd,
  renderCccPlanningTechnicalAnnex,
  type CccPlanningAdmissionFacts,
  type CccPlanningPacketSourceKey,
} from "../ccc-planning/packet.js";
import { buildCccPlanningAuthoringProposal } from "../ccc-planning/proposal.js";

/*
FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
Card GGz (errata E12, section 2.17). G4 promises, in both directions, that a plan it admits is never refused later by the importer and that it never refuses a plan the importer admits. Every case here is therefore judged twice: by G4, over the proposal IB1's real builder makes from the reviewed artifacts (the packet sources rendered by IB1's own renderers), and by the real importer or custody function the G4 rule mirrors, called on that same proposal: the execution-policy parse (`parseCccCampaignProductExecutionPolicy`), the import admission (`assertCccPrdImportBundle`, import-admission.ts), the semantic proof plan (`nativeWorkflowIr`, which runs `semanticV2WorkflowProofPlan` for a v2 policy and bundle, importer.ts:660-762) and the custody hydration (`hydrateCccPrdSemanticProofV2Custody`) on a throwaway git repository holding the verifier bundle at its base commit, as B1 does. The two verdicts must agree, refusal for refusal and admission for admission.
FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
The importer's admission and proof-plan functions take a compiled bundle, which only the controller's toolchain can produce (IB1's packet compiles to CCC_PRD_PROOF_ADMISSION_MISSING without it). The fields those two functions read (task, edge, workflow and intent ids; task requirement and proof ids; proof phases, requirement and clause ids; acceptance clauses) are the fields the compiler copies from the proposal under the same names, so each harness below lends the proposal's fields to a bundle and calls the real function. Where a case needs a shape IB1 cannot build, the test says so and edits the IB1-built proposal by hand.
*/

const TARGET = "/private/tmp/ccc-planning-ggz/target";
const BASE = "1".repeat(40);

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T;

function edit<T>(value: T, mutate: (draft: DeepMutable<T>) => void): T {
  const copy = structuredClone(value) as DeepMutable<T>;
  mutate(copy);
  return copy as T;
}

/* ------------------------------------------------------------------ fixture: the section 4.1 diamond, built through IB1 */

const REQUEST = [
  "Build a small text statistics tool for plain text.",
  "Provide a tokenizer that splits text into lowercase words.",
  "Count word frequency from the tokens.",
  "Estimate reading time in whole minutes at 200 words per minute.",
  "Provide a CLI that prints JSON and exits 2 on error.",
  "Use node --test tests, no dependencies, no package.json change and no network.",
  "",
].join("\n");

const ACCEPTANCE_CASES: CccPlanningAcceptanceCasesV1 = {
  schema: "ccc-planning.acceptance-cases.v1",
  cases: [
    { id: "AC-1", statement: "Tokenize.", requestQuotes: ["Build a small text statistics tool for plain text.", "splits text into lowercase words"] },
    { id: "AC-2", statement: "Count.", requestQuotes: ["Count word frequency from the tokens."] },
    { id: "AC-3", statement: "Time.", requestQuotes: ["Estimate reading time in whole minutes"] },
    { id: "AC-4", statement: "CLI.", requestQuotes: ["prints JSON and exits 2 on error"] },
    { id: "AC-5", statement: "Tests.", requestQuotes: ["Use node --test tests"] },
  ],
  exclusions: [{ id: "EX-1", statement: "No network.", requestQuotes: ["no dependencies, no package.json change and no network"] }],
};

const requestClause = (id: string, text: string, quote: string, caseId: string) => ({
  id, text, derivation: { kind: "request" as const, requestQuotes: [quote], acceptanceCaseIds: [caseId] },
});

const REQUIREMENT_MAP: CccPlanningRequirementMapV1 = {
  schema: "ccc-planning.requirement-map.v1",
  requirements: [
    { id: "REQ-1", title: "Tokenizer", statement: "The tokenizer splits text into lowercase words.", proofIds: ["tokenizer"], clauses: [
      requestClause("C1", "Tokenizing Hello World yields hello and world.", "splits text into lowercase words", "AC-1"),
      requestClause("C2", "The tokenizer tests run under node --test.", "Use node --test tests", "AC-5")] },
    { id: "REQ-2", title: "Frequency", statement: "Word frequency counts each token.", proofIds: ["word-frequency"], clauses: [
      requestClause("C1", "Counting a b a reports a twice and b once.", "Count word frequency from the tokens.", "AC-2")] },
    { id: "REQ-3", title: "Reading time", statement: "Reading time rounds up to whole minutes.", proofIds: ["reading-time"], clauses: [
      requestClause("C1", "Four hundred words take two minutes.", "Estimate reading time in whole minutes", "AC-3")] },
    { id: "REQ-4", title: "CLI", statement: "The CLI prints JSON and exits 2 on error.", proofIds: ["cli"], clauses: [
      requestClause("C1", "The CLI prints one JSON object for a text file.", "prints JSON and exits 2 on error", "AC-4"),
      { id: "C2", text: "The CLI is its own module.", derivation: { kind: "annex", decisionIds: ["DEC-T4"] } }] },
  ],
  nonGoals: [{ id: "NG-1", text: "No network.", requestQuotes: ["no network"], exclusionIds: ["EX-1"] }],
};

const DIAMOND = [
  { id: "T1", requirement: "REQ-1", proof: "tokenizer", path: "src/tokenizer.mjs", deps: [] as string[] },
  { id: "T2", requirement: "REQ-2", proof: "word-frequency", path: "src/word-frequency.mjs", deps: ["T1"] },
  { id: "T3", requirement: "REQ-3", proof: "reading-time", path: "src/reading-time.mjs", deps: ["T1"] },
  { id: "T4", requirement: "REQ-4", proof: "cli", path: "bin/text-stats.mjs", deps: ["T2", "T3"] },
] as const;

const TASK_PLAN: CccPlanningTaskPlanV1 = {
  schema: "ccc-planning.task-plan.v1",
  tasks: DIAMOND.map((row) => ({
    id: row.id, title: `Task ${row.id}`, description: `Implements ${row.proof}.`, requirementIds: [row.requirement],
    dependencyTaskIds: [...row.deps], proofIds: [row.proof], ownedPaths: [row.path], allowedWriteRoots: [row.path], protectedActionIds: [],
  })),
  edges: DIAMOND.flatMap((row) => row.deps.map((dep) => ({ id: `E-${row.id}-${dep}`, fromTaskId: row.id, toTaskId: dep, kind: "depends_on" as const }))),
  protectedActions: [],
};

const VERIFIER_BUNDLE: CccPlanningVerifierBundleV1 = {
  schema: "ccc-planning.verifier-bundle.v1",
  files: [
    { path: "Taskfile.yml", mode: "100644", content: "" },
    ...DIAMOND.map((row) => ({ path: `test/${row.proof}.test.mjs`, mode: "100644" as const, content: `// ${row.proof} harness\n` })),
  ],
  proofs: DIAMOND.map((row) => ({
    id: row.proof, requirementIds: [row.requirement], files: ["Taskfile.yml", `test/${row.proof}.test.mjs`], taskfileTask: `verify:${row.proof}` as const,
  })),
  controls: [],
};

const FACTS: CccPlanningAdmissionFacts = {
  targetRepository: { path: TARGET, baseCommit: BASE },
  admittedWriteRoots: [
    { path: `${TARGET}/.fusion`, purpose: "Fusion task and artifact state" },
    { path: `${TARGET}/src`, purpose: "writer source modules" },
    { path: `${TARGET}/bin`, purpose: "writer command line entry point" },
  ],
  bounds: { maxRequests: 3072, maxDurationMs: 86_400_000, maxConcurrency: 1 },
  protectedActions: [],
};

type Fixture = Readonly<{
  requirementMap: CccPlanningRequirementMapV1;
  taskPlan: CccPlanningTaskPlanV1;
  verifierBundle: CccPlanningVerifierBundleV1;
  facts: CccPlanningAdmissionFacts;
}>;

const BASE_FIXTURE: Fixture = { requirementMap: REQUIREMENT_MAP, taskPlan: TASK_PLAN, verifierBundle: VERIFIER_BUNDLE, facts: FACTS };

/**
 * The bundle's Taskfile.yml as the custody check needs it for the proposal IB1 builds: one `verify:<proof>` target per proof,
 * running the proof's harness over exactly the candidates IB1 declares (the sorted owned paths of every task that names the proof).
 */
function sealTaskfile(fixture: Fixture): Fixture {
  const lines = ["version: \"3\"", "tasks:"];
  for (const proof of fixture.verifierBundle.proofs) {
    const owners = fixture.taskPlan.tasks.filter(({ proofIds }) => proofIds.includes(proof.id));
    const candidates = [...new Set(owners.flatMap(({ ownedPaths }) => ownedPaths))].sort();
    lines.push(`  ${proof.taskfileTask}:`, "    cmds:", `      - node test/${proof.id}.test.mjs ${candidates.join(" ")}`);
  }
  const content = `${lines.join("\n")}\n`;
  return edit(fixture, (draft) => {
    draft.verifierBundle.files = draft.verifierBundle.files.map((file) => (file.path === "Taskfile.yml" ? { ...file, content } : file));
  });
}

/** G4's input over the proposal IB1's real builder makes from this fixture and the sources IB1's renderers write. */
function g4Input(raw: Fixture = BASE_FIXTURE): CccPlanningG4Input {
  const fixture = sealTaskfile(raw);
  const sources = {
    originalRequest: Buffer.from(REQUEST, "utf8"),
    admissionFacts: renderCccPlanningAdmissionFacts(fixture.facts),
    finalPrd: renderCccPlanningFinalPrd({ requirementMap: fixture.requirementMap, verifierBundle: fixture.verifierBundle }),
    technicalAnnex: renderCccPlanningTechnicalAnnex({ taskPlan: fixture.taskPlan }),
  };
  const proposal = buildCccPlanningAuthoringProposal({
    sources, requirementMap: fixture.requirementMap, taskPlan: fixture.taskPlan, verifierBundle: fixture.verifierBundle, facts: fixture.facts,
  });
  return {
    taskPlan: fixture.taskPlan, proposal, sources, acceptanceCases: ACCEPTANCE_CASES, requirementMap: fixture.requirementMap,
    requestArtifactDigest: sha256(REQUEST), verifierBundle: fixture.verifierBundle,
  };
}

function byRule(diagnostics: readonly CccPrdDiagnostic[], rule: string): CccPrdDiagnostic[] {
  return diagnostics.filter(({ message }) => message.includes(`rule ${rule}:`));
}

/* ------------------------------------------------------------------ the real importer and custody functions */

function verdict(action: () => unknown): string {
  try {
    action();
    return "admitted";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

function routesOf(proposal: CccPrdAuthoringProposalV2) {
  return proposal.tasks.map((task) => ({
    taskId: task.id, providerId: "glm", modelId: "glm-5.3-flash", transport: "pi", executor: "model",
    toolMode: "coding", worktreeMode: "isolated", commitPolicy: "required",
    ownedPaths: [...(task.ownedPaths ?? [])], allowedWriteRoots: [...(task.allowedWriteRoots ?? [])],
  }));
}

type PolicyBundle = Parameters<typeof parseCccCampaignProductExecutionPolicy>[1];

function parsePolicy(proposal: CccPrdAuthoringProposalV2) {
  return parseCccCampaignProductExecutionPolicy({ schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION, routes: routesOf(proposal) }, {
    tasks: proposal.tasks.map(({ id, dependencyTaskIds }) => ({ id, dependencyTaskIds })) as unknown as PolicyBundle["tasks"],
    admittedWriteRoots: proposal.admittedWriteRoots,
    targetRepository: proposal.targetRepository,
  });
}

/** The importer's execution-policy parse of the proposal's routes. */
function routeVerdict(proposal: CccPrdAuthoringProposalV2): string {
  return verdict(() => parsePolicy(proposal));
}

/**
 * The importer's semantic proof plan: `nativeWorkflowIr` runs `semanticV2WorkflowProofPlan` for a v2 policy and a v2 bundle,
 * then builds the workflow. The compiled bundle gives each acceptance clause the span the compiler resolved; the proof plan
 * never reads it and the execution prompt only prints it, so the clause's own source reference stands in for it here.
 */
function proofPlanVerdict(proposal: CccPrdAuthoringProposalV2): string {
  const lent = structuredClone(proposal) as unknown as { requirements: Array<{ acceptanceClauses: Array<Record<string, unknown> & { sourceRefs: Array<{ path: string }> }> }> };
  for (const requirement of lent.requirements) {
    for (const clause of requirement.acceptanceClauses) {
      clause.span = { path: clause.sourceRefs[0]!.path, byteStart: 0, byteEnd: 1, line: 1, column: 1, endLine: 1, endColumn: 2, sha256: "0".repeat(64), excerptSha256: "0".repeat(64) };
    }
  }
  const bundle = { ...lent, kind: "bundle", schema: "ccc-prd.bundle.v2", bundleHash: "0".repeat(64) } as unknown as CccPrdSemanticBundleV2;
  return verdict(() => nativeWorkflowIr(bundle, bundle.workflows[0]!, parsePolicy(proposal), new Map()));
}

/** The importer's admission (`assertCccPrdImportBundle`) over the proposal's entity and intent ids, roots and bounds. */
function admissionVerdict(proposal: CccPrdAuthoringProposalV2): string {
  const fixture = createCccPrdImportTestBundle(TARGET, "ggz");
  const bundle = rehashCccPrdImportTestBundle({
    ...fixture,
    tasks: proposal.tasks as unknown as CccPrdSemanticBundle["tasks"],
    edges: proposal.edges as unknown as CccPrdSemanticBundle["edges"],
    workflows: proposal.workflows as unknown as CccPrdSemanticBundle["workflows"],
    documents: [], artifacts: [],
    importIntents: proposal.importIntents,
    admittedWriteRoots: proposal.admittedWriteRoots,
    bounds: proposal.bounds,
  });
  return verdict(() => assertCccPrdImportBundle(bundle, TARGET, "idem-ggz"));
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

/**
 * The real custody hydration: the verifier bundle committed as the base of a throwaway repository (B1), the proposal's proofs,
 * and every route's owned paths and write roots as the model write roots, exactly as the importer passes them
 * (importer.ts:1509-1517). The task and proof-host executables are the core fixture's version-printing scripts, and Node is a
 * two-line script that execs this process's Node: the hydration seals a copy of each executable before probing its version,
 * and sealing the real Node binary (and its Homebrew libraries) would cost seconds per case without touching any rule here.
 */
async function custodyVerdict(input: CccPlanningG4Input): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ccc-planning-ggz-custody-"));
  scratchRoots.push(root);
  const repo = join(root, "target");
  const tools = join(root, "tools");
  mkdirSync(repo);
  mkdirSync(tools);
  git(repo, ["init", "-q", "-b", "main"]);
  for (const file of input.verifierBundle.files) {
    mkdirSync(dirname(join(repo, file.path)), { recursive: true });
    writeFileSync(join(repo, file.path), file.content);
  }
  git(repo, ["add", "--", ...input.verifierBundle.files.map(({ path }) => `:(literal)${path}`)]);
  git(repo, ["-c", "user.name=ggz", "-c", "user.email=ggz@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "B1"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const taskExecutable = join(tools, "task-fixture.mjs");
  writeFileSync(taskExecutable, `#!${process.execPath}\nconsole.log('Task fixture 1.0.0');\n`);
  chmodSync(taskExecutable, 0o755);
  const proofHost = join(tools, "proof-host.mjs");
  writeFileSync(proofHost, "console.log('Fusion semantic proof host fixture 1.0.0');\n");
  chmodSync(proofHost, 0o755);
  const node = join(tools, "node");
  writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(node, 0o755);
  try {
    await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: repo,
      baseCommit,
      proofs: input.proposal.proofs as unknown as CccPrdProofV2[],
      modelWriteRoots: routesOf(input.proposal).flatMap((route) => [...route.ownedPaths, ...route.allowedWriteRoots]),
      toolchainPaths: {
        taskExecutablePath: taskExecutable,
        nodeExecutablePath: node,
        proofHost: { id: CCC_PRD_SEMANTIC_PROOF_HOST_ID, executablePath: proofHost },
      },
    });
    return "admitted";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

/* ================================================================== the cases */

describe("G4 importer and custody parity", () => {
  it("positive control: the IB1-built diamond passes G4 and every importer and custody function G4 mirrors", async () => {
    const input = g4Input();
    expect(runCccPlanningG4(input)).toEqual([]);
    expect(routeVerdict(input.proposal)).toBe("admitted");
    expect(admissionVerdict(input.proposal)).toBe("admitted");
    expect(proofPlanVerdict(input.proposal)).toBe("admitted");
    expect(await custodyVerdict(input)).toBe("admitted");
    // The proofs are IB1's: one owner each, so task and final_integrated phases, the owner's paths as candidates, its clauses.
    expect(input.proposal.proofs.find(({ id }) => id === "word-frequency")).toMatchObject({
      phases: ["task", "final_integrated"], candidateInputs: ["src/word-frequency.mjs"], clauseIds: ["AC-REQ-2-C1"],
    });
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 1. The custody check reads each closure file with `git ls-tree -- <path>` (semantic-proof-custody.ts:150) and refuses unless the one entry it prints is spelled exactly as asked (:165-167). A leading colon is git pathspec magic: `:data.json` asks for `data.json`, so a bundle file really named `:data.json` is never read and the check refuses the proof, while a colon later in the path is literal.
  */
  it("a verifier closure path that starts with a colon fails G4, as git pathspec magic makes the custody check miss it", async () => {
    const withFixture = (path: string) => edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path, mode: "100644", content: "{\"words\": 3}\n" });
      draft.verifierBundle.proofs[0]!.files.push(path);
    });
    const red = g4Input(withFixture(":data.json"));
    expect(red.proposal.proofs[0]!.verifierClosure.map(({ role, path }) => `${role} ${path}`)).toContain("fixture :data.json");
    const diagnostics = runCccPlanningG4(red);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(byRule(diagnostics, "closure-path-git-literal")).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("proof tokenizer");
    expect(diagnostics[0]!.message).toContain("path :data.json:");
    expect(await custodyVerdict(red)).toMatch(/path is missing, non-regular, or ambiguous at [0-9a-f]{40}: :data\.json$/u);
    // Control: a colon later in the path is literal to git, and both G4 and the custody hydration admit it.
    const control = g4Input(withFixture("fixtures:x/words.txt"));
    expect(runCccPlanningG4(control)).toEqual([]);
    expect(await custodyVerdict(control)).toBe("admitted");
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-15-00:02:
  Card GGz repair 1 (adversary finding, the sibling of E12 item 1: a closure path git cannot address literally). `git init` on the I2 host's APFS volume writes core.precomposeunicode=true into the repository's own config, and the custody check still reads that config (it scrubs only the global and system config), so git composes a decomposed (NFD) `ls-tree -- <path>` argument to NFC. A bundle committed through the working tree, as this harness and B1 do, holds the NFC name, so the one entry listed differs from the path asked and the custody check refuses (semantic-proof-custody.ts:150, :164-167); a bundle that kept the NFD name through plumbing lists nothing and is refused the same way. Every earlier G4 layer, IB1 and K1's bundle validator accept the NFD path, so G4 refuses any closure path that is not NFC. Git precomposes only on Darwin: elsewhere the custody check admits the NFD path and G4's refusal is a fail-closed over-refusal, consistent with K1's Darwin-first comparison key, so the custody verdict pinned here is the one for the platform the test runs on.
  */
  it("a verifier closure path that is not in Unicode NFC fails G4, as git's precomposeunicode on the Darwin host makes the custody check miss it", async () => {
    const withFixture = (path: string) => edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path, mode: "100644", content: "words\n" });
      draft.verifierBundle.proofs[0]!.files.push(path);
    });
    const nfd = "fixtures/café.txt";
    const nfc = "fixtures/café.txt";
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize("NFC")).toBe(nfc);
    const red = g4Input(withFixture(nfd));
    expect(red.proposal.proofs[0]!.verifierClosure.map(({ role, path }) => `${role} ${path}`)).toContain(`fixture ${nfd}`);
    const diagnostics = runCccPlanningG4(red);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(byRule(diagnostics, "closure-path-git-literal")).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("proof tokenizer");
    expect(diagnostics[0]!.message).toContain(`path ${nfd}:`);
    expect(diagnostics[0]!.message).toContain("NFC");
    const custodyRed = await custodyVerdict(red);
    if (process.platform === "darwin") {
      const asked = nfd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      expect(custodyRed).toMatch(new RegExp(`^refused: CCC semantic-proof path is missing, non-regular, or ambiguous at [0-9a-f]{40}: ${asked}$`, "u"));
    } else {
      expect(custodyRed).toBe("admitted");
    }
    // Control: the same name composed (NFC) is admitted by G4 and by the custody hydration.
    const control = g4Input(withFixture(nfc));
    expect(runCccPlanningG4(control)).toEqual([]);
    expect(await custodyVerdict(control)).toBe("admitted");
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 2. The importer refuses any task, edge, workflow, document or artifact id, and any import intent id or entity id, outside `^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$` (import-admission.ts:22, :113-125). IB1 turns each edge into the intent `IMPORT-EDGE-<edge id>` and each task into `IMPORT-TASK-<task id>`, so the prefix counts against the 192-character limit: a 180-character edge id is admitted and a 181-character one is refused, through its intent id alone.
  */
  it("a dependency edge id the importer's entity-id rule refuses fails G4, as the importer refuses it", () => {
    const renamed = (edgeId: string) => edit(BASE_FIXTURE, (draft) => { draft.taskPlan.edges[0]!.id = edgeId; });
    const red = g4Input(renamed("T2->T1"));
    expect(red.proposal.importIntents.map(({ id }) => id)).toContain("IMPORT-EDGE-T2->T1");
    expect(admissionVerdict(red.proposal)).toBe("refused: dependency edge has an unsafe identifier: \"T2->T1\"");
    const diagnostics = runCccPlanningG4(red);
    expect(diagnostics.map(({ code }) => code)).toEqual(["CCC_PLANNING_GRAPH_INADMISSIBLE", "CCC_PLANNING_GRAPH_INADMISSIBLE"]);
    expect(byRule(diagnostics, "import-entity-id").map(({ message }) => /: (?:dependency edge|import intent) (\S+):/u.exec(message)?.[1]))
      .toEqual(["T2->T1", "IMPORT-EDGE-T2->T1"]);
    // Control: the fixture's own edge id.
    const control = g4Input(renamed("E-T2-T1"));
    expect(runCccPlanningG4(control)).toEqual([]);
    expect(admissionVerdict(control.proposal)).toBe("admitted");
    // G4 reads the edge id and the intent id it implies from the reviewed plan itself, not only from the proposal: IB1 copies the
    // plan's edges, so a proposal still carrying the safe id beside a plan that renamed the edge is a hand edit.
    const planOnly: CccPlanningG4Input = { ...g4Input(), taskPlan: renamed("T2->T1").taskPlan };
    expect(byRule(runCccPlanningG4(planOnly), "import-entity-id").map(({ message }) => /: (?:dependency edge|import intent) (\S+):/u.exec(message)?.[1]))
      .toEqual(["T2->T1", "IMPORT-EDGE-T2->T1"]);
    // The limit counts IB1's intent prefix: 12 + 180 = 192 characters is admitted by both, 12 + 181 by neither.
    const longest = `E-${"a".repeat(178)}`;
    expect(runCccPlanningG4(g4Input(renamed(longest)))).toEqual([]);
    expect(admissionVerdict(g4Input(renamed(longest)).proposal)).toBe("admitted");
    const tooLong = g4Input(renamed(`${longest}a`));
    expect(admissionVerdict(tooLong.proposal)).toMatch(/^refused: import intent has an unsafe identifier: "IMPORT-EDGE-E-a{179}"$/u);
    const intentOnly = runCccPlanningG4(tooLong);
    expect(intentOnly).toHaveLength(1);
    expect(byRule(intentOnly, "import-entity-id")).toHaveLength(1);
    expect(intentOnly[0]!.message).toContain(`import intent IMPORT-EDGE-${longest}a:`);
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 2, defence in depth. IB1's packet refuses a task id outside its SHORT_ID grammar before G4 runs, so this plan is a shape IB1 cannot build: the IB1-built diamond is renamed by hand, in the plan and the proposal alike, to stand for any producer that skips that check. G4 must still refuse the task id and the `IMPORT-TASK-` intent id it implies.
  */
  it("defence in depth: a task id the importer's entity-id rule refuses fails G4 even when IB1's packet is bypassed", () => {
    const input = g4Input();
    const plan = input.taskPlan as unknown as { tasks: Array<{ id: string; dependencyTaskIds: string[] }>; edges: Array<{ fromTaskId: string; toTaskId: string }> };
    const proposal = input.proposal as unknown as {
      tasks: Array<{ id: string; dependencyTaskIds: string[] }>; edges: Array<{ fromTaskId: string; toTaskId: string }>;
      workflows: Array<{ taskIds: string[]; terminalTaskIds: string[] }>; importIntents: Array<{ id: string; entityId: string }>;
    };
    const swap = (id: string) => (id === "T4" ? "T4 cli" : id);
    for (const task of [...plan.tasks, ...proposal.tasks]) {
      task.id = swap(task.id);
      task.dependencyTaskIds = task.dependencyTaskIds.map(swap);
    }
    for (const edge of [...plan.edges, ...proposal.edges]) {
      edge.fromTaskId = swap(edge.fromTaskId);
      edge.toTaskId = swap(edge.toTaskId);
    }
    proposal.workflows[0]!.taskIds = proposal.workflows[0]!.taskIds.map(swap);
    proposal.workflows[0]!.terminalTaskIds = proposal.workflows[0]!.terminalTaskIds.map(swap);
    for (const intent of proposal.importIntents) {
      if (intent.entityId === "T4") Object.assign(intent, { id: "IMPORT-TASK-T4 cli", entityId: "T4 cli" });
    }
    expect(admissionVerdict(input.proposal)).toBe("refused: task has an unsafe identifier: \"T4 cli\"");
    const diagnostics = runCccPlanningG4(input);
    expect(byRule(diagnostics, "import-entity-id").map(({ message }) => /: (?:task|import intent) (.+?): /u.exec(message)?.[1]))
      .toEqual(["T4 cli", "IMPORT-TASK-T4 cli"]);
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 3. IB1 gives a proof named by two tasks the final_integrated phase only and the union of their owned paths as candidates (proposal.ts:255, :261). The custody check runs once per proof against every route's write roots (importer.ts:1509-1517), so it admits such a proof; G4 used to demand each candidate inside the write roots of every task running the proof, and refused it. G4 now requires each candidate, by exact spelling, inside an owned path or write root of at least one task that runs the proof.
  */
  it("a stats proof shared by T2 and T3, each with its own proof as well, is admitted by G4 and by the importer", async () => {
    const shared = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path: "test/stats.test.mjs", mode: "100644", content: "// stats harness\n" });
      draft.verifierBundle.proofs.push({ id: "stats", requirementIds: ["REQ-2", "REQ-3"], files: ["Taskfile.yml", "test/stats.test.mjs"], taskfileTask: "verify:stats" });
      for (const requirement of draft.requirementMap.requirements) if (requirement.id === "REQ-2" || requirement.id === "REQ-3") requirement.proofIds.push("stats");
      for (const task of draft.taskPlan.tasks) if (task.id === "T2" || task.id === "T3") task.proofIds.push("stats");
    });
    const input = g4Input(shared);
    expect(input.proposal.proofs.find(({ id }) => id === "stats")).toMatchObject({
      phases: ["final_integrated"], candidateInputs: ["src/reading-time.mjs", "src/word-frequency.mjs"],
    });
    expect(runCccPlanningG4(input)).toEqual([]);
    expect(routeVerdict(input.proposal)).toBe("admitted");
    expect(proofPlanVerdict(input.proposal)).toBe("admitted");
    expect(await custodyVerdict(input)).toBe("admitted");
  });

  it("a write root inside an owned directory, with IB1-built candidates, is admitted by G4 and by the importer", async () => {
    const nested = edit(BASE_FIXTURE, (draft) => {
      draft.taskPlan.tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "src/lib"];
      draft.taskPlan.tasks[0]!.allowedWriteRoots = ["src/tokenizer.mjs", "src/lib/x.mjs"];
    });
    const input = g4Input(nested);
    // IB1 declares every owned path a candidate, so the directory src/lib is one although no write root contains it.
    expect(input.proposal.proofs[0]!.candidateInputs).toEqual(["src/lib", "src/tokenizer.mjs"]);
    expect(runCccPlanningG4(input)).toEqual([]);
    expect(routeVerdict(input.proposal)).toBe("admitted");
    expect(proofPlanVerdict(input.proposal)).toBe("admitted");
    expect(await custodyVerdict(input)).toBe("admitted");
  });

  it("a task whose only proof is shared fails G4 exactly, as the importer's proof plan requires a task-phase proof", async () => {
    const onlyShared = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files = draft.verifierBundle.files.map((file) => (file.path === "test/reading-time.test.mjs" ? { ...file, path: "test/stats.test.mjs" } : file));
      draft.verifierBundle.proofs = draft.verifierBundle.proofs.map((proof) => (proof.id === "reading-time"
        ? { id: "stats", requirementIds: ["REQ-2", "REQ-3"], files: ["Taskfile.yml", "test/stats.test.mjs"], taskfileTask: "verify:stats" as const }
        : proof));
      draft.requirementMap.requirements[1]!.proofIds.push("stats");
      draft.requirementMap.requirements[2]!.proofIds = ["stats"];
      draft.taskPlan.tasks[1]!.proofIds.push("stats");
      draft.taskPlan.tasks[2]!.proofIds = ["stats"];
    });
    const input = g4Input(onlyShared);
    expect(proofPlanVerdict(input.proposal)).toBe("refused: CCC PRD semantic task T3 requires at least one task-phase proof");
    expect(routeVerdict(input.proposal)).toBe("admitted");
    expect(await custodyVerdict(input)).toBe("admitted");
    const diagnostics = runCccPlanningG4(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(byRule(diagnostics, "task-has-task-proof")).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("task T3:");
    expect(diagnostics[0]!.message).toContain("stats");
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 4. The importer's proof plan (`semanticV2WorkflowProofPlan`, importer.ts:660-762) refuses a task-phase proof that covers a requirement its one owner does not claim, so G4 refuses it before review spend. IB1 builds this proof: a single owner gives it the task phase, and its clauses are those of both requirements.
  */
  it("a single-owner proof whose requirements include another task's requirement fails G4, as the importer's proof plan refuses it", () => {
    const crossing = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.proofs[1]!.requirementIds = ["REQ-2", "REQ-3"];
      draft.requirementMap.requirements[2]!.proofIds.push("word-frequency");
    });
    const input = g4Input(crossing);
    expect(input.proposal.proofs.find(({ id }) => id === "word-frequency")).toMatchObject({ phases: ["task", "final_integrated"], requirementIds: ["REQ-2", "REQ-3"] });
    expect(proofPlanVerdict(input.proposal)).toBe("refused: CCC PRD task-phase proof word-frequency covers requirement REQ-3 outside semantic task T2");
    const diagnostics = runCccPlanningG4(input);
    for (const entry of diagnostics) expect(entry.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    const outside = byRule(diagnostics, "task-proof-requirement-owned");
    expect(outside).toHaveLength(1);
    expect(outside[0]!.message).toContain("proof word-frequency");
    expect(outside[0]!.message).toContain("REQ-3");
    expect(outside[0]!.message).toContain("task T2");
    // Control: the same proof with only its own task's requirement (the diamond) is admitted by both.
    const control = g4Input();
    expect(runCccPlanningG4(control)).toEqual([]);
    expect(proofPlanVerdict(control.proposal)).toBe("admitted");
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 4, every other rule of the proof plan, pinned case by case against the real `nativeWorkflowIr`. IB1 builds the cross-task case from a reviewed plan; the others are shapes IB1 never builds (it gives the task phase only to a single-owner proof, derives clause ids from the proof's requirements and puts every task in its one workflow), so each edits the IB1-built proposal by hand to stand for a producer that does. G4 must refuse each with the named rule, and the importer must refuse it too.
  */
  it("G4's proof-graph rules agree with the importer's proof plan case by case", () => {
    type ProposalDraft = {
      tasks: Array<{ id: string; requirementIds: string[]; proofIds: string[]; workflowId: string }>;
      proofs: Array<{ id: string; phases: string[]; requirementIds: string[]; clauseIds: string[] }>;
      requirements: Array<{ id: string; acceptanceClauses: Array<{ id: string; proofIds: string[] }> }>;
      workflows: Array<{ id: string; taskIds: string[] }>;
    };
    const handEdited = (mutate: (draft: ProposalDraft) => void, fixture: Fixture = BASE_FIXTURE): CccPlanningG4Input => {
      const input = g4Input(fixture);
      mutate(input.proposal as unknown as ProposalDraft);
      return input;
    };
    const sharedStats = edit(BASE_FIXTURE, (draft) => {
      draft.verifierBundle.files.push({ path: "test/stats.test.mjs", mode: "100644", content: "// stats harness\n" });
      draft.verifierBundle.proofs.push({ id: "stats", requirementIds: ["REQ-2", "REQ-3"], files: ["Taskfile.yml", "test/stats.test.mjs"], taskfileTask: "verify:stats" });
      draft.requirementMap.requirements[1]!.proofIds.push("stats");
      draft.requirementMap.requirements[2]!.proofIds.push("stats");
      draft.taskPlan.tasks[1]!.proofIds.push("stats");
      draft.taskPlan.tasks[2]!.proofIds.push("stats");
    });
    const cases: ReadonlyArray<Readonly<{ name: string; input: CccPlanningG4Input; rule: string; importer: RegExp }>> = [
      {
        name: "cross-task requirement (IB1-built)",
        input: g4Input(edit(BASE_FIXTURE, (draft) => {
          draft.verifierBundle.proofs[1]!.requirementIds = ["REQ-2", "REQ-3"];
          draft.requirementMap.requirements[2]!.proofIds.push("word-frequency");
          draft.taskPlan.tasks[1]!.requirementIds.push("REQ-3");
        })),
        rule: "task-proof-requirement-exclusive",
        importer: /^refused: CCC PRD task-phase proof word-frequency covers cross-task requirement REQ-3 owned by T2 and T3$/u,
      },
      {
        name: "a task-phase proof with two owners",
        input: handEdited((draft) => { draft.proofs.find(({ id }) => id === "stats")!.phases = ["task", "final_integrated"]; }, sharedStats),
        rule: "task-proof-one-owner",
        importer: /^refused: CCC PRD task-phase proof stats must have exactly one semantic task owner; received 2$/u,
      },
      {
        name: "a clause of another task's requirement",
        input: handEdited((draft) => { draft.proofs.find(({ id }) => id === "word-frequency")!.clauseIds.push("AC-REQ-3-C1"); }),
        rule: "task-proof-clause-owned",
        importer: /^refused: CCC PRD task-phase proof word-frequency covers clause AC-REQ-3-C1 outside semantic task T2$/u,
      },
      {
        name: "an unknown clause",
        input: handEdited((draft) => { draft.proofs.find(({ id }) => id === "word-frequency")!.clauseIds.push("AC-REQ-2-C9"); }),
        rule: "task-proof-clause-owned",
        importer: /^refused: CCC PRD task-phase proof word-frequency references unknown accepted clause AC-REQ-2-C9$/u,
      },
      {
        name: "a clause without final_integrated coverage",
        input: handEdited((draft) => { draft.proofs.find(({ id }) => id === "reading-time")!.phases = ["task"]; }),
        rule: "clause-final-coverage",
        importer: /^refused: CCC PRD accepted clause AC-REQ-3-C1 has no final_integrated proof coverage$/u,
      },
      {
        name: "a workflow that does not gate every task",
        input: handEdited((draft) => { draft.workflows[0]!.taskIds = draft.workflows[0]!.taskIds.filter((id) => id !== "T3"); }),
        rule: "workflow-gates-every-task",
        importer: /^refused: CCC PRD workflow WORKFLOW-PLANNING must gate every semantic task exactly once$/u,
      },
    ];
    for (const entry of cases) {
      expect(proofPlanVerdict(entry.input.proposal), entry.name).toMatch(entry.importer);
      const diagnostics = runCccPlanningG4(entry.input);
      expect(byRule(diagnostics, entry.rule).length, `${entry.name}: ${JSON.stringify(diagnostics)}`).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) expect(diagnostic.code, entry.name).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    }
  });

  /*
  FNXC:CccPlanningG4ImporterParity 2026-10-14-23:14:
  Errata E12 item 5. The importer resolves each PRD-admitted write root against its own working directory (`resolve(path)`, import-admission.ts and canonical.ts parseProductRoute), not against the target, so a relative admitted root means whatever directory the importer happens to run in. G4, which cannot see that directory, refuses a non-absolute admitted root (fail-closed).
  */
  it("a relative PRD-admitted write root fails G4, as the importer resolves it against its own working directory", () => {
    const withSrc = (path: string) => edit(BASE_FIXTURE, (draft) => { draft.facts.admittedWriteRoots[1]!.path = path; });
    const red = g4Input(withSrc("src"));
    expect(routeVerdict(red.proposal)).toMatch(/^refused: .*route 0 allowedWriteRoots path "src\/tokenizer\.mjs" is outside PRD-admitted write roots/u);
    const diagnostics = runCccPlanningG4(red);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("CCC_PLANNING_GRAPH_INADMISSIBLE");
    expect(byRule(diagnostics, "admitted-root-absolute")).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("path src:");
    // Control: the same root spelled absolutely under the target.
    const control = g4Input(withSrc(`${TARGET}/src`));
    expect(runCccPlanningG4(control)).toEqual([]);
    expect(routeVerdict(control.proposal)).toBe("admitted");
  });

  it("G4's source paths are IB1's packet source paths (errata E9-4, E12 item 7)", () => {
    const keys = Object.keys(CCC_PLANNING_PACKET_SOURCES) as CccPlanningPacketSourceKey[];
    expect(Object.keys(CCC_PLANNING_G4_SOURCE_PATHS).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(CCC_PLANNING_G4_SOURCE_PATHS[key]).toBe(cccPlanningPacketSourcePath(key));
    expect(Object.isFrozen(CCC_PLANNING_G4_SOURCE_PATHS)).toBe(true);
  });
});
