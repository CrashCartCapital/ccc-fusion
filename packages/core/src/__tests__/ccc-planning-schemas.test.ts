import { describe, expect, it } from "vitest";
import {
  normalizeCccPlanningRelativePath,
  normalizeCccPlanningTaskPlanV1,
  validateCccPlanningAcceptanceCasesV1,
  validateCccPlanningAdjudicationV1,
  validateCccPlanningBuildTransitionV1,
  validateCccPlanningDecisionRecordV1,
  validateCccPlanningDecisionRequestV1,
  validateCccPlanningObjectionV1,
  validateCccPlanningProofResultsV1,
  validateCccPlanningRequirementMapV1,
  validateCccPlanningRoutingPlanV1,
  validateCccPlanningSpecReadyV1,
  validateCccPlanningTaskPlanV1,
  validateCccPlanningVerifierBundleV1,
  CCC_PLANNING_CONTENT_SCHEMAS,
  CCC_PLANNING_CONTENT_VALIDATORS,
  type CccPlanningAcceptanceCasesV1,
  type CccPlanningAdjudicationV1,
  type CccPlanningBuildTransitionV1,
  type CccPlanningDecisionRecordV1,
  type CccPlanningDecisionRequestV1,
  type CccPlanningObjectionV1,
  type CccPlanningProofResultsV1,
  type CccPlanningRequirementMapV1,
  type CccPlanningRoutingPlanV1,
  type CccPlanningSpecReadyV1,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
} from "../ccc-planning/schemas.js";

/*
FNXC:CccPlanningSchemas 2026-10-14-08:40:
Card K1 proof for the planning content schemas (CONTRACT-v2 section 2.17). The task-plan validator is the gate G4 runs before the compiler's graph admission, which under-refuses (carry-forward GG): duplicate task ids, duplicate or undeclared protected-action ids, dependencies on undeclared tasks and non-`depends_on` edges must each be refused here, and owned paths must be normalized so `./src/a.mjs` and `src/../src/a.mjs` are seen as the same path. Each refusal is one field away from the admitted diamond.
*/

const ref = (artifactKey: string, digest = "a".repeat(64)) => ({ artifactKey, digest });

function diamondPlan(): CccPlanningTaskPlanV1 {
  const task = (id: string, owned: string, deps: string[]) => ({
    id, title: `task ${id}`, description: `implements ${id}`, requirementIds: [`REQ-${id}`],
    dependencyTaskIds: deps, proofIds: [`PROOF-${id}`], ownedPaths: [owned], allowedWriteRoots: [owned], protectedActionIds: [],
  });
  return {
    schema: "ccc-planning.task-plan.v1",
    tasks: [
      task("T1", "src/tokenizer.mjs", []),
      task("T2", "src/word-frequency.mjs", ["T1"]),
      task("T3", "src/reading-time.mjs", ["T1"]),
      task("T4", "bin/text-stats.mjs", ["T2", "T3"]),
    ],
    edges: [
      { id: "E1", fromTaskId: "T2", toTaskId: "T1", kind: "depends_on" },
      { id: "E2", fromTaskId: "T3", toTaskId: "T1", kind: "depends_on" },
      { id: "E3", fromTaskId: "T4", toTaskId: "T2", kind: "depends_on" },
      { id: "E4", fromTaskId: "T4", toTaskId: "T3", kind: "depends_on" },
    ],
    protectedActions: [],
  };
}

type DraftPlan = {
  schema: unknown;
  tasks: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  protectedActions: Record<string, unknown>[];
  [key: string]: unknown;
};
function mutate(edit: (plan: DraftPlan) => void): unknown {
  const plan = structuredClone(diamondPlan()) as unknown as DraftPlan;
  edit(plan);
  return plan;
}

function problemsOf(value: unknown): string {
  return validateCccPlanningTaskPlanV1(value).join("\n");
}

describe("task plan validation (G4 prerequisites)", () => {
  it("admits the I2 diamond with zero problems (positive control)", () => {
    expect(validateCccPlanningTaskPlanV1(diamondPlan())).toEqual([]);
  });

  it("refuses a duplicate task id", () => {
    expect(problemsOf(mutate((plan) => { plan.tasks[3]!.id = "T3"; }))).toMatch(/task id T3 is declared more than once/);
  });

  it("refuses a dependency on an undeclared task", () => {
    expect(problemsOf(mutate((plan) => { plan.tasks[1]!.dependencyTaskIds = ["T9"]; }))).toMatch(/task T2 depends on undeclared task T9/);
  });

  it("refuses an edge kind other than depends_on", () => {
    expect(problemsOf(mutate((plan) => { plan.edges[0]!.kind = "blocks"; }))).toMatch(/edge E1 kind must be depends_on/);
  });

  it("refuses an edge that names an undeclared task", () => {
    expect(problemsOf(mutate((plan) => { plan.edges[0]!.toTaskId = "T9"; }))).toMatch(/edge E1 names undeclared task T9/);
  });

  it("refuses a duplicate protected-action id and an undeclared one", () => {
    const action = { id: "PA1", kind: "merge", target: "main" };
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => {
      plan.protectedActions = [action];
      plan.tasks[3]!.protectedActionIds = ["PA1"];
    }))).toEqual([]);
    expect(problemsOf(mutate((plan) => {
      plan.protectedActions = [action, { ...action, target: "release" }];
      plan.tasks[3]!.protectedActionIds = ["PA1"];
    }))).toMatch(/protected action id PA1 is declared more than once/);
    expect(problemsOf(mutate((plan) => {
      plan.protectedActions = [action];
      plan.tasks[3]!.protectedActionIds = ["PA2"];
    }))).toMatch(/task T4 names undeclared protected action PA2/);
  });

  it("refuses owned paths that overlap only after normalization", () => {
    expect(problemsOf(mutate((plan) => { plan.tasks[1]!.ownedPaths = ["./src/tokenizer.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["src/tokenizer.mjs"]; })))
      .toMatch(/tasks T1 and T2 own overlapping paths src\/tokenizer\.mjs and src\/tokenizer\.mjs/);
    expect(problemsOf(mutate((plan) => { plan.tasks[2]!.ownedPaths = ["src/../src"]; plan.tasks[2]!.allowedWriteRoots = ["src"]; })))
      .toMatch(/own overlapping paths/);
  });

  /*
  FNXC:CccPlanningSchemas 2026-10-14-09:21:
  Errata E1-10: the I2 host is Darwin, whose default APFS volume ignores letter case and Unicode composed-versus-decomposed form, so `src/A.mjs` and `src/a.mjs` (or `café` in NFC and NFD) are one file there. Overlap is compared on `normalize("NFC").toLowerCase()` after `./` and `..` normalization; this is stricter than Linux needs, which is safe. A task may not list one path twice, own anything inside `.git`, or own an `.env` file.
  */
  it("refuses owned paths that differ only in letter case or Unicode normalization form", () => {
    expect(problemsOf(mutate((plan) => {
      plan.tasks[1]!.ownedPaths = ["src/Tokenizer.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["src/Tokenizer.mjs"];
    }))).toMatch(/tasks T1 and T2 own overlapping paths src\/tokenizer\.mjs and src\/Tokenizer\.mjs/);
    expect(problemsOf(mutate((plan) => {
      plan.tasks[0]!.ownedPaths = ["src/café.mjs"]; plan.tasks[0]!.allowedWriteRoots = ["src/café.mjs"];
      plan.tasks[1]!.ownedPaths = ["src/café.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["src/café.mjs"];
    }))).toMatch(/tasks T1 and T2 own overlapping paths/);
    expect(problemsOf(mutate((plan) => {
      plan.tasks[2]!.ownedPaths = ["SRC"]; plan.tasks[2]!.allowedWriteRoots = ["SRC"];
    }))).toMatch(/tasks T1 and T3 own overlapping paths src\/tokenizer\.mjs and SRC/);
    // Control: distinct names that merely look alike stay admissible.
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => {
      plan.tasks[1]!.ownedPaths = ["src/tokenizer2.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["src/tokenizer2.mjs"];
    }))).toEqual([]);
  });

  it("refuses a duplicate owned path within one task, including a case-only or ./ duplicate", () => {
    for (const duplicate of ["src/tokenizer.mjs", "./src/tokenizer.mjs", "src/Tokenizer.mjs"]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.ownedPaths = ["src/tokenizer.mjs", duplicate]; })), duplicate)
        .toMatch(/task T1 owns the same path twice: src\/tokenizer\.mjs and /);
    }
    // Control: two different files in one task are admissible.
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => { plan.tasks[0]!.ownedPaths = ["src/tokenizer.mjs", "src/tokens.mjs"]; })))
      .toEqual([]);
  });

  it("refuses an owned path inside .git or naming an .env file, and the same for a write root", () => {
    for (const bad of [".git", ".git/hooks/pre-commit", "src/.git/config", ".GIT/config"]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.ownedPaths = [bad]; plan.tasks[0]!.allowedWriteRoots = [bad]; })), bad)
        .toMatch(/task T1 owned path .* has a \.git path segment/);
    }
    for (const bad of [".env", "src/.env", ".env.local", "src/.env.production", ".ENV"]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.ownedPaths = [bad]; plan.tasks[0]!.allowedWriteRoots = [bad]; })), bad)
        .toMatch(/task T1 owned path .* names an \.env file/);
    }
    expect(problemsOf(mutate((plan) => { plan.tasks[3]!.ownedPaths = ["bin"]; plan.tasks[3]!.allowedWriteRoots = ["bin/.git"]; })))
      .toMatch(/task T4 write root "bin\/\.git" has a \.git path segment/);
    // Control: names that only contain "git" or "env" are admissible.
    for (const good of ["src/git.mjs", "src/.github/workflow.mjs", "src/env.mjs", "src/.envrc", "src/app.env", "src/.environment.mjs"]) {
      expect(validateCccPlanningTaskPlanV1(mutate((plan) => { plan.tasks[0]!.ownedPaths = [good]; plan.tasks[0]!.allowedWriteRoots = [good]; })), good)
        .toEqual([]);
    }
  });

  it("refuses an owned path that is absolute, escapes the worktree or names the root", () => {
    for (const bad of ["/etc/passwd", "../outside.mjs", "src/../../x", ".", "", "src\\win.mjs"]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.ownedPaths = [bad]; })), JSON.stringify(bad)).toMatch(/owned path/);
    }
  });

  it("refuses a write root outside the task's owned paths", () => {
    expect(problemsOf(mutate((plan) => { plan.tasks[0]!.allowedWriteRoots = ["src/other.mjs"]; })))
      .toMatch(/task T1 write root src\/other\.mjs is outside its owned paths/);
  });

  it("refuses an extra key and a wrong schema", () => {
    expect(problemsOf(mutate((plan) => { plan.extra = true; }))).toMatch(/unexpected key extra/);
    expect(problemsOf(mutate((plan) => { plan.schema = "ccc-planning.task-plan.v2"; }))).toMatch(/schema/);
    expect(problemsOf(mutate((plan) => { plan.tasks = []; }))).toMatch(/at least one task/);
    expect(validateCccPlanningTaskPlanV1(null)).not.toEqual([]);
  });
});

describe("owned path normalization", () => {
  it("normalizes relative spellings to one canonical path", () => {
    expect(normalizeCccPlanningRelativePath("./tasks/t1")).toBe("tasks/t1");
    expect(normalizeCccPlanningRelativePath("tasks/../tasks/t1")).toBe("tasks/t1");
    expect(normalizeCccPlanningRelativePath("src//a.mjs/")).toBe("src/a.mjs");
    expect(normalizeCccPlanningRelativePath("src/a.mjs")).toBe("src/a.mjs");
  });

  it("returns null for paths that cannot be owned", () => {
    for (const bad of ["/abs", "..", "../x", "a/../../x", ".", "", "a\\b", "a\0b", "C:/x"]) {
      expect(normalizeCccPlanningRelativePath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rewrites a plan's owned paths and write roots into canonical form", () => {
    const plan = mutate((draft) => {
      draft.tasks[0]!.ownedPaths = ["./src/tokenizer.mjs"];
      draft.tasks[0]!.allowedWriteRoots = ["src/../src/tokenizer.mjs"];
    }) as CccPlanningTaskPlanV1;
    const normalized = normalizeCccPlanningTaskPlanV1(plan);
    expect(normalized.tasks[0]!.ownedPaths).toEqual(["src/tokenizer.mjs"]);
    expect(normalized.tasks[0]!.allowedWriteRoots).toEqual(["src/tokenizer.mjs"]);
    expect(normalized).toEqual(diamondPlan());
    expect(() => normalizeCccPlanningTaskPlanV1(mutate((draft) => { draft.tasks[0]!.ownedPaths = ["../x"]; }) as CccPlanningTaskPlanV1))
      .toThrow(TypeError);
  });
});

const ACCEPTANCE: CccPlanningAcceptanceCasesV1 = {
  schema: "ccc-planning.acceptance-cases.v1",
  cases: [{ id: "AC-1", statement: "Counts words", requestQuotes: ["word frequency"] }],
  exclusions: [{ id: "EX-1", statement: "No network", requestQuotes: ["no network"] }],
};
const REQUIREMENT_MAP: CccPlanningRequirementMapV1 = {
  schema: "ccc-planning.requirement-map.v1",
  requirements: [{
    id: "REQ-1", title: "Tokenize", statement: "Split text into words", proofIds: ["PROOF-1"],
    clauses: [
      { id: "C1", text: "split on whitespace", derivation: { kind: "request", requestQuotes: ["a tokenizer"], acceptanceCaseIds: ["AC-1"] } },
      { id: "C2", text: "lower-case tokens", derivation: { kind: "annex", decisionIds: ["D-1"] } },
    ],
  }],
  nonGoals: [{ id: "NG-1", text: "no network", requestQuotes: ["no network"], exclusionIds: ["EX-1"] }],
};
const ROUTING: CccPlanningRoutingPlanV1 = {
  schema: "ccc-planning.routing-plan.v1",
  routes: [{ taskId: "T1", providerId: "omniroute-glm53-flash", modelId: "glm/glm-5.3-flash", transport: "pi" }],
};
const VERIFIER: CccPlanningVerifierBundleV1 = {
  schema: "ccc-planning.verifier-bundle.v1",
  files: [
    { path: "Taskfile.yml", mode: "100644", content: "version: '3'\ntasks:\n  verify:tokenizer:\n    cmds: [node test/tokenizer.test.mjs src/tokenizer.mjs]\n" },
    { path: "test/tokenizer.test.mjs", mode: "100644", content: "test('[REQ-1] splits', () => {});\n" },
  ],
  proofs: [{ id: "tokenizer", requirementIds: ["REQ-1"], files: ["Taskfile.yml", "test/tokenizer.test.mjs"], taskfileTask: "verify:tokenizer" }],
  controls: [{ id: "CTRL-1", requirementId: "REQ-1", files: [{ path: "src/tokenizer.mjs", content: "export const tokenize = () => [];\n" }] }],
};
const ADJUDICATION: CccPlanningAdjudicationV1 = {
  schema: "ccc-planning.adjudication.v1",
  epoch: 1,
  candidate: [ref("cccplan-r001-spec-main-v01")],
  reviews: [ref("cccplan-r001-review-product-v01")],
  objections: [],
  blockingFindings: 0,
  verdict: "approve",
  approved: {
    finalPrd: ref("cccplan-r001-spec-prd-v01"),
    technicalAnnex: ref("cccplan-r001-spec-annex-v01"),
    taskPlan: ref("cccplan-r001-plan-main-v01"),
  },
};
const DECISION_REQUEST: CccPlanningDecisionRequestV1 = {
  schema: "ccc-planning.decision-request.v1",
  question: "Should the CLI read stdin when no file is given?",
  options: ["yes", "no"],
  context: [ref("cccplan-r001-admission-request-v01")],
};
const OBJECTION: CccPlanningObjectionV1 = {
  stageId: "review",
  reviewerRoleId: "product-adversary",
  severity: "blocking",
  ref: { kind: "counterexample", text: "empty input crashes" },
  summary: "The CLI crashes on empty input",
  reviewedRef: ref("cccplan-r001-spec-prd-v01"),
};
const DECISION_RECORD: CccPlanningDecisionRecordV1 = {
  objectionKey: "cccplan-r001-review-obj1-v01",
  proposal: "Handle empty input",
  evidence: [{ kind: "requirement", requirementId: "REQ-1" }],
  objection: "The CLI crashes on empty input",
  discriminatingObservation: "Running with an empty file exits 0 with {}",
  disposition: "accepted",
  remainingUncertainty: "none",
};
const BUILD_TRANSITION: CccPlanningBuildTransitionV1 = {
  schema: "ccc-planning.build-transition.v1",
  b0: "1".repeat(40),
  predictedCommitOid: "2".repeat(40),
  branchRef: `refs/heads/fusion/r2c-${"0123456789abcdef01234567"}-r001-baseline`,
  verifierBundle: ref("cccplan-r001-verifier-bundle-v01"),
  specReady: ref("cccplan-r001-specready-main-v01"),
};
const PROOF_RESULTS: CccPlanningProofResultsV1 = {
  sourceCommit: "3".repeat(40),
  sourceTree: "4".repeat(40),
  proofIds: ["PROOF-1", "PROOF-2"],
  phase: "task",
  results: [
    {
      proofId: "PROOF-1", attemptKey: `ccc-proof-attempt-${"5".repeat(64)}`, state: "committed", resultSuccess: true,
      exitCode: 0, durationMs: 1_234, stdoutSha256: "6".repeat(64), stderrSha256: "7".repeat(64), terminalEnvelopeSha256: "8".repeat(64),
    },
    {
      proofId: "PROOF-2", attemptKey: `ccc-proof-attempt-${"9".repeat(64)}`, state: "proved_failed", resultSuccess: false,
      exitCode: null, durationMs: 0, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64), terminalEnvelopeSha256: "c".repeat(64),
    },
  ],
};
const SPEC_READY: CccPlanningSpecReadyV1 = {
  schema: "ccc-planning.spec-ready.v1",
  runId: `ccc-plan:${"0123456789abcdef01234567"}`,
  runRevision: 1,
  mode: "spec",
  target: { projectId: "proj-a", repositoryPath: "/tmp/target", admittedBase: "1".repeat(40) },
  closure: [ref("cccplan-r001-plan-main-v01"), ref("cccplan-r001-spec-main-v01")],
  closureDigest: "6".repeat(64),
  reviewed: {
    originalRequest: ref("cccplan-r001-admission-request-v01"), acceptanceCases: ref("cccplan-r001-intent-cases-v01"),
    requirementMap: ref("cccplan-r001-spec-map-v01"), finalPrd: ref("cccplan-r001-spec-prd-v01"),
    technicalAnnex: ref("cccplan-r001-spec-annex-v01"), taskPlan: ref("cccplan-r001-plan-main-v01"),
    routingPlan: ref("cccplan-r001-plan-routing-v01"), verifierBundle: ref("cccplan-r001-verifier-bundle-v01"),
    oracleAudit: ref("cccplan-r001-verifier-audit-v01"), finalAdjudication: ref("cccplan-r001-review-adj-v01"),
  },
  gates: [{ gate: "G4", verdict: "pass", evidence: [ref("cccplan-r001-plan-main-v01")], inputClosureDigest: "7".repeat(64) }],
  verifierBaseline: {
    parent: "1".repeat(40),
    files: [{ path: "verify/tokenizer.test.mjs", mode: "100644", blobOid: "8".repeat(40), sha256: "9".repeat(64) }],
    treeOid: "a".repeat(40),
    author: { name: "Fusion", email: "fusion@localhost", date: "2026-10-14T00:00:00Z" },
    committer: { name: "Fusion", email: "fusion@localhost", date: "2026-10-14T00:00:00Z" },
    message: "verifier baseline",
    predictedCommitOid: "b".repeat(40),
  },
  preparationCompile: {
    targetKind: "disposable_clone", packetHash: "c".repeat(64), sidecarHash: "d".repeat(64), bundleHash: "e".repeat(64),
    toolchainDigest: "f".repeat(64), diagnostics: [],
  },
  graphAdmission: { graphDigest: "0".repeat(64), diagnostics: [] },
  spend: { planningCallsIssued: 120, planningAllocation: 1536, implementationReserved: 0, reviewProofReserved: 0 },
  campaignAdmission: "pending",
  repositoryMutation: "none",
};

function withField<T extends object>(value: T, key: string, next: unknown): unknown {
  return { ...value, [key]: next };
}

describe("content schema validators", () => {
  const cases = [
    { name: "acceptance cases", validate: validateCccPlanningAcceptanceCasesV1, value: ACCEPTANCE,
      bad: [withField(ACCEPTANCE, "cases", [...ACCEPTANCE.cases, { ...ACCEPTANCE.cases[0]! }]),
        withField(ACCEPTANCE, "cases", [{ ...ACCEPTANCE.cases[0]!, requestQuotes: [] }])] },
    { name: "requirement map", validate: validateCccPlanningRequirementMapV1, value: REQUIREMENT_MAP,
      bad: [withField(REQUIREMENT_MAP, "requirements", [{ ...REQUIREMENT_MAP.requirements[0]!, clauses: [
        { id: "C1", text: "x", derivation: { kind: "request", requestQuotes: [], acceptanceCaseIds: ["AC-1"] } }] }]),
      withField(REQUIREMENT_MAP, "requirements", [{ ...REQUIREMENT_MAP.requirements[0]!, clauses: [
        { id: "C1", text: "x", derivation: { kind: "guess" } }] }])] },
    { name: "routing plan", validate: validateCccPlanningRoutingPlanV1, value: ROUTING,
      bad: [withField(ROUTING, "routes", [{ ...ROUTING.routes[0]!, modelId: "glm/glm-5.3-flashx" }]),
        withField(ROUTING, "routes", [ROUTING.routes[0]!, ROUTING.routes[0]!])] },
    { name: "verifier bundle", validate: validateCccPlanningVerifierBundleV1, value: VERIFIER,
      bad: [withField(VERIFIER, "proofs", [{ ...VERIFIER.proofs[0]!, files: ["verify/missing.test.mjs"] }]),
        withField(VERIFIER, "files", [{ ...VERIFIER.files[0]!, path: "../escape.mjs" }])] },
    { name: "adjudication", validate: validateCccPlanningAdjudicationV1, value: ADJUDICATION,
      bad: [withField(ADJUDICATION, "blockingFindings", 1), withField(ADJUDICATION, "approved", null)] },
    { name: "decision request", validate: validateCccPlanningDecisionRequestV1, value: DECISION_REQUEST,
      bad: [withField(DECISION_REQUEST, "question", ""), withField(DECISION_REQUEST, "options", ["yes", "yes"])] },
    { name: "spec ready", validate: validateCccPlanningSpecReadyV1, value: SPEC_READY,
      bad: [withField(SPEC_READY, "repositoryMutation", "branch"),
        withField(SPEC_READY, "verifierBaseline", { ...SPEC_READY.verifierBaseline, predictedCommitOid: "B1" })] },
    { name: "objection", validate: validateCccPlanningObjectionV1, value: OBJECTION,
      bad: [withField(OBJECTION, "ref", { kind: "counterexample", text: "x".repeat(601) }), withField(OBJECTION, "severity", "major")] },
    { name: "decision record", validate: validateCccPlanningDecisionRecordV1, value: DECISION_RECORD,
      bad: [withField(DECISION_RECORD, "disposition", "ignored"), withField(DECISION_RECORD, "objectionKey", "not-a-key")] },
    { name: "build transition", validate: validateCccPlanningBuildTransitionV1, value: BUILD_TRANSITION,
      bad: [withField(BUILD_TRANSITION, "branchRef", "refs/heads/main"), withField(BUILD_TRANSITION, "b0", "HEAD")] },
    { name: "proof results", validate: validateCccPlanningProofResultsV1, value: PROOF_RESULTS,
      bad: [withField(PROOF_RESULTS, "results", []), withField(PROOF_RESULTS, "phase", "final")] },
  ] as const;

  for (const entry of cases) {
    it(`admits a well-formed ${entry.name} and refuses each one-field defect`, () => {
      expect(entry.validate(entry.value)).toEqual([]);
      for (const bad of entry.bad) expect(entry.validate(bad), JSON.stringify(bad).slice(0, 160)).not.toEqual([]);
      expect(entry.validate(withField(entry.value, "unexpected", 1))).toContainEqual(expect.stringMatching(/unexpected key unexpected/));
      expect(entry.validate("not an object")).not.toEqual([]);
    });
  }

  /*
  FNXC:CccPlanningSchemas 2026-10-14-09:21:
  Errata E1-12 (v3 item 41): a proof id is its Taskfile name. Every proof command is `task verify:<id>`, so each proof carries its own `taskfileTask`, equal to "verify:" + id, and the id is a lowercase Taskfile-safe name. The bundle has no root-level task: item 41 leaves nothing for one to name.
  */
  it("names each proof's own verify:<id> Taskfile target and has no root-level task", () => {
    const proof = VERIFIER.proofs[0]!;
    const withProof = (next: Record<string, unknown>) => validateCccPlanningVerifierBundleV1(withField(VERIFIER, "proofs", [next]));
    expect(withProof({ ...proof, taskfileTask: "verify:other" }))
      .toContainEqual(expect.stringMatching(/proofs\[0\]\.taskfileTask must be verify:tokenizer/));
    expect(withProof({ ...proof, taskfileTask: "tokenizer" }))
      .toContainEqual(expect.stringMatching(/proofs\[0\]\.taskfileTask must be verify:tokenizer/));
    const { taskfileTask: _dropped, ...withoutTask } = proof;
    void _dropped;
    expect(withProof(withoutTask)).toContainEqual(expect.stringMatching(/proofs\[0\]\.taskfileTask is required/));
    for (const id of ["PROOF-1", "Tokenizer", "-tokenizer", "tokenizer_1", "tokenizer:a", `a${"b".repeat(63)}`, ""]) {
      expect(withProof({ ...proof, id, taskfileTask: `verify:${id}` }), JSON.stringify(id))
        .toContainEqual(expect.stringMatching(/proofs\[0\]\.id must be/));
    }
    expect(validateCccPlanningVerifierBundleV1({ ...VERIFIER, taskfileTask: "verify" }))
      .toContainEqual(expect.stringMatching(/unexpected key taskfileTask/));
    // Controls: the longest legal id and a hyphenated id are admitted.
    for (const id of [`a${"b".repeat(62)}`, "word-frequency", "0tokenizer"]) {
      expect(withProof({ ...proof, id, taskfileTask: `verify:${id}` }), id).toEqual([]);
    }
  });

  /*
  FNXC:CccPlanningSchemas 2026-10-14-09:21:
  Errata E1-8 (v3 section 2.17, item 46): proof results are read from the settled proof attempts (`listCccCampaignProofAttemptsForCommit`), one entry per proof id, carrying the attempt key, the settled state and the stored terminal evidence digests. A proof attempt settles `committed` exactly when its result succeeded (proof-attempt.ts settle), so the two fields must agree. The exit code is a PostgreSQL integer or null (a killed process has none).
  */
  it("follows section 2.17: one settled attempt per proof id with its terminal evidence", () => {
    const passed: Record<string, unknown> = { ...PROOF_RESULTS.results[0]! };
    const failed: Record<string, unknown> = { ...PROOF_RESULTS.results[1]! };
    const withResults = (...results: unknown[]) => validateCccPlanningProofResultsV1(withField(PROOF_RESULTS, "results", results));
    const refusals: readonly [string, unknown, RegExp][] = [
      ["v1 outcome shape", { proofId: "PROOF-1", outcome: "passed", evidenceDigest: "5".repeat(64) }, /unexpected key outcome/],
      ["unknown state", { ...passed, state: "passed" }, /state must be one of committed, proved_failed/],
      ["committed but failed", { ...passed, resultSuccess: false }, /committed .* resultSuccess true/],
      ["proved_failed but succeeded", { ...failed, proofId: "PROOF-1", resultSuccess: true }, /proved_failed .* resultSuccess false/],
      ["boolean as number", { ...passed, resultSuccess: 1 }, /resultSuccess must be a boolean/],
      ["malformed attempt key", { ...passed, attemptKey: "ccc-plan-attempt-x" }, /attemptKey must be a proof attempt key/],
      ["fractional exit code", { ...passed, exitCode: 1.5 }, /exitCode must be/],
      ["exit code outside int4", { ...passed, exitCode: 2_147_483_648 }, /exitCode must be/],
      ["negative duration", { ...passed, durationMs: -1 }, /durationMs must be an integer/],
      ["upper-case digest", { ...passed, stdoutSha256: "A".repeat(64) }, /stdoutSha256 must be a lowercase sha256/],
      ["missing stderr digest", { ...passed, stderrSha256: undefined }, /stderrSha256 must be a lowercase sha256/],
      ["missing envelope digest", (({ terminalEnvelopeSha256: _x, ...rest }) => rest)(passed), /terminalEnvelopeSha256 is required/],
    ];
    for (const [label, bad, problem] of refusals) {
      expect(withResults(bad, failed), label).toContainEqual(expect.stringMatching(problem));
    }
    expect(withResults(passed)).toContainEqual(expect.stringMatching(/proof PROOF-2 has no result/));
    expect(withResults(passed, failed, { ...failed })).toContainEqual(expect.stringMatching(/proof PROOF-2 has more than one result/));
    // Controls: a negative exit code within int4 and a null exit code are admitted.
    expect(withResults({ ...passed, exitCode: -2_147_483_648, state: "proved_failed", resultSuccess: false }, failed)).toEqual([]);
    expect(withResults(passed, { ...failed, exitCode: null })).toEqual([]);
  });

  it("registers one validator per content schema id", () => {
    expect(Object.keys(CCC_PLANNING_CONTENT_VALIDATORS).sort()).toEqual(Object.values(CCC_PLANNING_CONTENT_SCHEMAS).sort());
    expect(CCC_PLANNING_CONTENT_VALIDATORS["ccc-planning.task-plan.v1"]).toBe(validateCccPlanningTaskPlanV1);
    expect(CCC_PLANNING_CONTENT_VALIDATORS["ccc-planning.objection.v1"]).toBe(validateCccPlanningObjectionV1);
  });
});
