import { describe, expect, it } from "vitest";
import {
  cccPlanningPathComparisonKey,
  cccPlanningPathsOverlap,
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
    dependencyTaskIds: deps, proofIds: [`proof-${id.toLowerCase()}`], ownedPaths: [owned], allowedWriteRoots: [owned], protectedActionIds: [],
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

  /*
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-40 amends E1-10. APFS folds letter case fully, not by simple lower-casing: on this host's volume `straße` and `strasse`, final and medial sigma, and the `ﬁ` ligature and `fi` each open one file. A plan admitted with one such pair split across two tasks would give two writers one physical file. The comparison key therefore upper-cases and then lower-cases (with NFC on both sides), which merges every pair APFS merges. Its one over-refusal is capital I against dotless ı, which APFS keeps apart; refusing that pair is accepted as fail-closed.
  */
  const FULL_FOLD_PAIRS: readonly (readonly [string, string])[] = [
    ["src/straße.mjs", "src/strasse.mjs"], // sharp s and ss
    ["src/ας.mjs", "src/ασ.mjs"], // final and medial sigma
    ["src/ﬁle.mjs", "src/file.mjs"], // fi ligature and fi
  ];

  it("refuses owned paths across tasks that only full case folding merges (sharp s, final sigma, fi ligature) and over-refuses I against dotless i as accepted fail-closed", () => {
    for (const [left, right] of [...FULL_FOLD_PAIRS, ["src/I.mjs", "src/ı.mjs"] as const]) {
      expect(problemsOf(mutate((plan) => {
        plan.tasks[0]!.ownedPaths = [left]; plan.tasks[0]!.allowedWriteRoots = [left];
        plan.tasks[1]!.ownedPaths = [right]; plan.tasks[1]!.allowedWriteRoots = [right];
      })), `${left} | ${right}`).toMatch(/tasks T1 and T2 own overlapping paths/);
    }
    // A folded directory still contains the folded file.
    expect(problemsOf(mutate((plan) => {
      plan.tasks[0]!.ownedPaths = ["STRASSE"]; plan.tasks[0]!.allowedWriteRoots = ["STRASSE"];
      plan.tasks[1]!.ownedPaths = ["straße/x.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["straße/x.mjs"];
    }))).toMatch(/tasks T1 and T2 own overlapping paths STRASSE and straße\/x\.mjs/);
    // Control: names that differ by more than case stay admissible.
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => {
      plan.tasks[0]!.ownedPaths = ["src/strase.mjs"]; plan.tasks[0]!.allowedWriteRoots = ["src/strase.mjs"];
      plan.tasks[1]!.ownedPaths = ["src/strasse.mjs"]; plan.tasks[1]!.allowedWriteRoots = ["src/strasse.mjs"];
    }))).toEqual([]);
  });

  it("refuses a duplicate owned path within one task that only full case folding reveals (sharp s, final sigma, fi ligature)", () => {
    for (const [first, second] of FULL_FOLD_PAIRS) {
      expect(problemsOf(mutate((plan) => {
        plan.tasks[0]!.ownedPaths = [first, second]; plan.tasks[0]!.allowedWriteRoots = [first];
      })), `${first} | ${second}`).toMatch(/task T1 owns the same path twice: /);
    }
    // Control: two files that differ by more than case in one task are admissible.
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => {
      plan.tasks[0]!.ownedPaths = ["src/strase.mjs", "src/strasse.mjs"]; plan.tasks[0]!.allowedWriteRoots = ["src/strase.mjs"];
    }))).toEqual([]);
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
    // Control: names that only contain "git" or "env" are admissible (`.envrc` is a denied name since errata E2-42).
    for (const good of ["src/git.mjs", "src/.github/workflow.mjs", "src/env.mjs", "src/app.env", "src/.environment.mjs"]) {
      expect(validateCccPlanningTaskPlanV1(mutate((plan) => { plan.tasks[0]!.ownedPaths = [good]; plan.tasks[0]!.allowedWriteRoots = [good]; })), good)
        .toEqual([]);
    }
  });

  /*
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-42: an owned path or write root may not have any segment equal, after case folding, to a `CCC_PLANNING_DENIED_NAMES` entry (`.agentsecrets`, `.env`, `.env.*`, `.envrc`, `.npmrc`, `_secrets`). A writer that owns `.npmrc` or anything under `_secrets/` could plant registry credentials or read secrets the confined shell is meant to hide.
  */
  it("refuses an owned path or write root with a denied-name segment (.npmrc, _secrets, .agentsecrets, .envrc), folded", () => {
    for (const bad of [".npmrc", "_secrets/x", ".agentsecrets", ".envrc", "src/.NPMRC", "config/_Secrets/key.json", "pkg/.envrc/x", ".env.d/x"]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.ownedPaths = [bad]; plan.tasks[0]!.allowedWriteRoots = [bad]; })), bad)
        .toMatch(/task T1 owned path .* has the denied name \S+ as a path segment/);
    }
    expect(problemsOf(mutate((plan) => { plan.tasks[3]!.ownedPaths = ["bin"]; plan.tasks[3]!.allowedWriteRoots = ["bin/.npmrc"]; })))
      .toMatch(/task T4 write root "bin\/\.npmrc" has the denied name \.npmrc as a path segment/);
    // Controls: names that merely mention env or secrets are admissible.
    for (const good of ["src/env.mjs", "docs/secrets-guide.md", "src/npmrc.mjs", "src/secrets/x.mjs", "src/agentsecrets.mjs"]) {
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

  /*
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-46: the write-root containment check compares on the same key as ownership, so a root spelled `SRC/Tokenizer.mjs` is inside an owned `src/tokenizer.mjs`, as it is on the I2 host's volume.
  */
  it("counts a write root inside its owned paths on the comparison key, so SRC/Tokenizer.mjs is inside src/tokenizer.mjs", () => {
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => { plan.tasks[0]!.allowedWriteRoots = ["SRC/Tokenizer.mjs"]; }))).toEqual([]);
    expect(validateCccPlanningTaskPlanV1(mutate((plan) => {
      plan.tasks[3]!.ownedPaths = ["bin"]; plan.tasks[3]!.allowedWriteRoots = ["BIN/text-stats.mjs"];
    }))).toEqual([]);
    // Control: a root outside the owned paths in every spelling is still refused.
    expect(problemsOf(mutate((plan) => { plan.tasks[0]!.allowedWriteRoots = ["SRC/other.mjs"]; })))
      .toMatch(/task T1 write root SRC\/other\.mjs is outside its owned paths/);
    expect(problemsOf(mutate((plan) => {
      plan.tasks[3]!.ownedPaths = ["bin"]; plan.tasks[3]!.allowedWriteRoots = ["BINARY/text-stats.mjs"];
    }))).toMatch(/task T4 write root BINARY\/text-stats\.mjs is outside its owned paths/);
  });

  /*
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-43: a task's proof ids are Taskfile names (E1-12), so they match `CCC_PLANNING_PROOF_ID_PATTERN` like the verifier bundle's proof ids. A task naming `PROOF-T1` could never be matched to a `verify:<id>` target.
  */
  it("refuses a task proof id that is not a Taskfile-safe proof id", () => {
    for (const id of ["PROOF-T1", "Tokenizer", "-t1", "t1_a", "verify:t1", `a${"b".repeat(63)}`]) {
      expect(problemsOf(mutate((plan) => { plan.tasks[0]!.proofIds = [id]; })), id).toMatch(/tasks\[0\]\.proofIds\[0\] must be a proof id/);
    }
    // Controls: lowercase, hyphenated and the longest legal ids are admitted.
    for (const id of ["proof-t1", "0tokenizer", `a${"b".repeat(62)}`]) {
      expect(validateCccPlanningTaskPlanV1(mutate((plan) => { plan.tasks[0]!.proofIds = [id]; })), id).toEqual([]);
    }
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

/*
FNXC:CccPlanningSchemas 2026-10-14-13:26:
Errata E2-40 and E2-13: `cccPlanningPathComparisonKey` is the one path identity every planning card compares with (GG reuses it for graph admission). It posix-normalizes the spelling itself, so a caller never has to remember to strip `./` or a trailing slash first, then folds case fully with NFC on both sides. The key must merge every pair this host's APFS volume opens as one file and nothing that differs by more than case or composition.
*/
describe("path comparison key", () => {
  it("gives one key to every spelling APFS opens as the same file: case, NFC and NFD, ./ and .., a trailing slash, sharp s, final sigma, the fi ligature, the Kelvin sign and dotted capital I", () => {
    const same: readonly (readonly [string, string])[] = [
      ["src/Tokenizer.mjs", "src/tokenizer.mjs"],
      ["src/café.mjs", "src/café.mjs"],
      ["./src/a.mjs", "src/a.mjs"],
      ["src/../src/a.mjs", "src/a.mjs"],
      ["src/", "src"],
      ["./SRC/CafÉ.mjs", "src/café.mjs"],
      ["straße", "STRASSE"],
      ["ας", "ασ"],
      ["ﬁle.mjs", "file.mjs"],
      ["K.mjs", "k.mjs"],
      ["İ.mjs", "i̇.mjs"],
    ];
    for (const [left, right] of same) {
      expect(cccPlanningPathComparisonKey(left), `${left} | ${right}`).toBe(cccPlanningPathComparisonKey(right));
      expect(cccPlanningPathsOverlap(left, right), `${left} | ${right}`).toBe(true);
    }
    // Controls: names that differ by more than case or composition keep different keys and do not overlap.
    for (const [left, right] of [["src/a.mjs", "src/b.mjs"], ["src/strase", "src/strasse"], ["src/cafe.mjs", "src/café.mjs"],
      ["src/a", "src/ab"], ["src/a.mjs", "src/a.mjs.bak"]] as const) {
      expect(cccPlanningPathComparisonKey(left), `${left} | ${right}`).not.toBe(cccPlanningPathComparisonKey(right));
      expect(cccPlanningPathsOverlap(left, right), `${left} | ${right}`).toBe(false);
    }
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
    id: "REQ-1", title: "Tokenize", statement: "Split text into words", proofIds: ["tokenizer"],
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
  proofIds: ["tokenizer", "word-frequency"],
  phase: "task",
  results: [
    {
      proofId: "tokenizer", attemptKey: `ccc-proof-attempt-${"5".repeat(64)}`, state: "committed", resultSuccess: true,
      exitCode: 0, durationMs: 1_234, stdoutSha256: "6".repeat(64), stderrSha256: "7".repeat(64), terminalEnvelopeSha256: "8".repeat(64),
    },
    {
      proofId: "word-frequency", attemptKey: `ccc-proof-attempt-${"9".repeat(64)}`, state: "proved_failed", resultSuccess: false,
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
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-41: the verifier bundle's files become the baseline commit, and a control's files are written over the implementation, so their paths get the owned-path refusals. A `.git/hooks/post-checkout` would run on the host at the next checkout, and an `.env` or denied name could plant or expose secrets. Paths are also de-duplicated on the comparison key: `Taskfile.yml` and `taskfile.yml` are one file on the I2 host's volume, so the Taskfile on disk could differ from the blob the custody check reads. Control files are de-duplicated within one control; two controls may each replace the same implementation file.
  */
  it("refuses a bundle or control file inside .git, naming an .env file or a denied name, or colliding with another on the comparison key", () => {
    type BundleFile = Readonly<{ path: string; mode: "100644" | "100755"; content: string }>;
    const file = (path: string, mode: BundleFile["mode"] = "100644"): BundleFile => ({ path, mode, content: "export {};\n" });
    const withFiles = (...extra: BundleFile[]) => validateCccPlanningVerifierBundleV1(withField(VERIFIER, "files", [...VERIFIER.files, ...extra]));
    expect(withFiles(file(".git/hooks/post-checkout", "100755")))
      .toContainEqual(expect.stringMatching(/files\[2\]\.path "\.git\/hooks\/post-checkout" has a \.git path segment/));
    expect(withFiles(file("taskfile.yml"))).toContainEqual(expect.stringMatching(/verifier file taskfile\.yml is the same path as Taskfile\.yml/));
    expect(withFiles(file("test/café.mjs"), file("test/café.mjs")))
      .toContainEqual(expect.stringMatching(/verifier file test\/café\.mjs is the same path as test\/café\.mjs/));
    expect(withFiles(file(".env"))).toContainEqual(expect.stringMatching(/files\[2\]\.path "\.env" names an \.env file/));
    expect(withFiles(file("config/.npmrc"))).toContainEqual(expect.stringMatching(/files\[2\]\.path "config\/\.npmrc" has the denied name \.npmrc/));

    const control = VERIFIER.controls[0]!;
    const withControlFiles = (...paths: string[]) => validateCccPlanningVerifierBundleV1(withField(VERIFIER, "controls",
      [{ ...control, files: paths.map((path) => ({ path, content: "export {};\n" })) }]));
    expect(withControlFiles(".git/hooks/post-checkout"))
      .toContainEqual(expect.stringMatching(/controls\[0\]\.files\[0\]\.path "\.git\/hooks\/post-checkout" has a \.git path segment/));
    expect(withControlFiles(".env.local")).toContainEqual(expect.stringMatching(/controls\[0\]\.files\[0\]\.path "\.env\.local" names an \.env file/));
    expect(withControlFiles("src/Tokenizer.mjs", "src/tokenizer.mjs"))
      .toContainEqual(expect.stringMatching(/control CTRL-1 file src\/tokenizer\.mjs is the same path as src\/Tokenizer\.mjs/));

    // Controls: an ordinary harness path is admitted, and two controls may each replace the same implementation file.
    expect(withFiles(file("test/harness/run.mjs"), file("test/fixtures/sample.txt"))).toEqual([]);
    expect(validateCccPlanningVerifierBundleV1(withField(VERIFIER, "controls", [control, { ...control, id: "CTRL-2" }]))).toEqual([]);
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
      ["v1 outcome shape", { proofId: "tokenizer", outcome: "passed", evidenceDigest: "5".repeat(64) }, /unexpected key outcome/],
      ["unknown state", { ...passed, state: "passed" }, /state must be one of committed, proved_failed/],
      ["committed but failed", { ...passed, resultSuccess: false }, /committed .* resultSuccess true/],
      ["proved_failed but succeeded", { ...failed, proofId: "tokenizer", resultSuccess: true }, /proved_failed .* resultSuccess false/],
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
    expect(withResults(passed)).toContainEqual(expect.stringMatching(/proof word-frequency has no result/));
    expect(withResults(passed, failed, { ...failed })).toContainEqual(expect.stringMatching(/proof word-frequency has more than one result/));
    // Controls: a negative exit code within int4 and a null exit code are admitted.
    expect(withResults({ ...passed, exitCode: -2_147_483_648, state: "proved_failed", resultSuccess: false }, failed)).toEqual([]);
    expect(withResults(passed, { ...failed, exitCode: null })).toEqual([]);
  });

  /*
  FNXC:CccPlanningSchemas 2026-10-14-13:26:
  Errata E2-43: the state and exit code agree exactly as the proof-attempt store requires. `prepareTerminalResult` (ccc-campaign/proof-attempt.ts) refuses a successful result unless its exit code is 0, and the attempt settles `committed` exactly when the result succeeded; a failed result may carry any int4 exit code or none. Every proof id is a Taskfile name (E1-12), in `proofIds` and in each result.
  */
  it("mirrors the proof-attempt store: a committed result has exit code 0, and every proof id matches the proof id pattern", () => {
    const passed: Record<string, unknown> = { ...PROOF_RESULTS.results[0]! };
    const failed: Record<string, unknown> = { ...PROOF_RESULTS.results[1]! };
    const withResults = (...results: unknown[]) => validateCccPlanningProofResultsV1(withField(PROOF_RESULTS, "results", results));
    for (const exitCode of [1, -1, null]) {
      expect(withResults({ ...passed, exitCode }, failed), String(exitCode))
        .toContainEqual(expect.stringMatching(/results\[0\] state committed needs exitCode 0/));
    }
    expect(validateCccPlanningProofResultsV1({ ...PROOF_RESULTS, proofIds: ["Any Id!", "word-frequency"],
      results: [{ ...passed, proofId: "Any Id!" }, failed] }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/proofIds\[0\] must be a proof id/),
        expect.stringMatching(/results\[0\]\.proofId must be a proof id/)]));
    expect(validateCccPlanningProofResultsV1({ ...PROOF_RESULTS, proofIds: ["PROOF-1", "word-frequency"],
      results: [{ ...passed, proofId: "PROOF-1" }, failed] }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/proofIds\[0\] must be a proof id/),
        expect.stringMatching(/results\[0\]\.proofId must be a proof id/)]));
    // Controls: committed with exit code 0, and proved_failed with exit code 0, 1 or none, are admitted.
    expect(validateCccPlanningProofResultsV1(PROOF_RESULTS)).toEqual([]);
    for (const exitCode of [0, 1, 137, null]) {
      expect(withResults(passed, { ...failed, exitCode }), String(exitCode)).toEqual([]);
    }
  });

  it("registers one validator per content schema id", () => {
    expect(Object.keys(CCC_PLANNING_CONTENT_VALIDATORS).sort()).toEqual(Object.values(CCC_PLANNING_CONTENT_SCHEMAS).sort());
    expect(CCC_PLANNING_CONTENT_VALIDATORS["ccc-planning.task-plan.v1"]).toBe(validateCccPlanningTaskPlanV1);
    expect(CCC_PLANNING_CONTENT_VALIDATORS["ccc-planning.objection.v1"]).toBe(validateCccPlanningObjectionV1);
  });
});
