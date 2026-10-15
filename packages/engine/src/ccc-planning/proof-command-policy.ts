import { posix } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";
import {
  cccPlanningPathComparisonKey,
  cccPlanningPathsOverlap,
  computeCccPrdCandidateInputsSha256,
  type CccPlanningTaskPlanV1,
  type CccPlanningVerifierBundleV1,
  type CccPrdDiagnostic,
  type CccPrdVerifierClosureEntry,
} from "@fusion/core";

/*
FNXC:CccPlanningProofCommands 2026-10-14-18:52:
Card GG, verify-v2 item 41 (D19, challenge 29). A plan G4 admits must not be refused later by the importer's semantic-proof custody check, so this policy mirrors that check's rules (semantic-proof-custody.ts: the PROOF_COMMAND and VERIFY_TARGET patterns near :29, the literal-command and strict-target parsers near :211-292, verifyTaskfile near :297-350, and hydrateProof with assertClosureDisjoint near :1266-1330) over the plan instead of a repository: every proof command is exactly `task verify:<proof id>`; the bundle's Taskfile.yml declares that target with exactly one literal `node <harness> <candidate...>` command; the verifier closure (Taskfile.yml as the one task runner, the one harness, any fixtures) consists of files of the VP verifier bundle, which B1 commits and the custody check reads at that base commit; no closure path is the same as, inside or above any task's owned path or write root; every candidate lies inside the write roots of the task that runs the proof and is not a closure path; and writer tasks own only `src/**` and `bin/**`.
FNXC:CccPlanningProofCommands 2026-10-14-18:52:
Paths are compared on K1's `cccPlanningPathComparisonKey` (E2-13, E2-40a) wherever two spellings could name one file on the I2 host's case- and normalization-insensitive volume, so `./TASKFILE.yml` is the writer-owned `Taskfile.yml` and `TEST/Tokenizer.test.mjs` overlaps the harness `test/tokenizer.test.mjs`. Where the custody check compares exact strings to admit something (the task runner must be `Taskfile.yml`, a closure file must exist at its exact path in the bundle, a candidate must lie inside a write root), the policy keeps the exact comparison too, because an equivalent spelling the custody check would not match must not pass here. Each violation is a CCC_PLANNING_GRAPH_INADMISSIBLE diagnostic whose detail names the rule, the proof (or the task) and the path.
FNXC:CccPlanningProofCommands 2026-10-14-18:52:
The frozen signature is `(taskPlan, verifierBundle)`, which derives each proof the way the importer will see it from the bundle: command `task <taskfileTask>`, closure `Taskfile.yml`, the target's harness and the proof's other files as fixtures, and the target's candidate arguments. G4 passes a third argument, the proposal's own proof definitions, so the commands, closures and candidates that will actually be compiled are the ones checked against the bundle. The Python adapter profile is not modelled: a planning bundle has no verifier profile, so a `python3` target is refused (fail-closed). The E6-0 `bash -c` rule for package scripts is an I3 prerequisite and is not enforced here.
*/

export type CccPlanningProofDefinition = Readonly<{
  id: string;
  command: string;
  verifierClosure: readonly Readonly<{ role: CccPrdVerifierClosureEntry["role"]; path: string }>[];
  candidateInputs: readonly string[];
}>;

export const CCC_PLANNING_PROOF_COMMAND_RULES = Object.freeze([
  "proof-command-is-task-verify",
  "proof-is-in-verifier-bundle",
  "task-proof-defined",
  "taskfile-in-verifier-bundle",
  "taskfile-literal-shape",
  "taskfile-declares-target",
  "target-literal-node-command",
  "target-invokes-declared-harness",
  "target-candidates-match-proof",
  "closure-has-one-taskfile-runner",
  "closure-path-canonical",
  "closure-in-verifier-bundle",
  "closure-disjoint-from-write-roots",
  "candidate-path-canonical",
  "candidate-not-closure",
  "candidate-in-own-write-roots",
  "writer-owns-only-src-bin",
] as const);
export type CccPlanningProofCommandRule = (typeof CCC_PLANNING_PROOF_COMMAND_RULES)[number];

const TASKFILE = "Taskfile.yml";
const VERIFY_TARGET = /^verify:[a-z0-9][a-z0-9:-]{0,63}$/u; // semantic-proof-custody.ts VERIFY_TARGET
const PROOF_COMMAND = /^task (verify:[a-z0-9][a-z0-9:-]{0,63})$/u; // semantic-proof-custody.ts PROOF_COMMAND
const TARGET_COMMAND_TOKEN = /^[A-Za-z0-9._/-]+$/u;
const FORBIDDEN_COMMAND_CHARACTERS = /[;&|`$<>\n\r\t'"\\*?{}()[\]!~]/u;
const TOP_LEVEL_TASKFILE_KEYS = new Set(["version", "tasks"]);
const WRITER_ROOTS = ["src", "bin"] as const;

class ShapeError extends Error {}

function shape(message: string): never {
  throw new ShapeError(message);
}

function plainScalar(node: unknown, label: string): string {
  if (!isScalar(node) || typeof node.value !== "string" || node.anchor) shape(`Taskfile ${label} must be one literal string`);
  return node.value;
}

function mapEntries(node: unknown, label: string): Map<string, unknown> {
  if (!isMap(node) || node.anchor) shape(`Taskfile ${label} must be a literal mapping`);
  const result = new Map<string, unknown>();
  for (const pair of node.items as readonly Pair[]) {
    const key = plainScalar(pair.key, `${label} key`);
    if (result.has(key)) shape(`Taskfile ${label} duplicates ${key}`);
    result.set(key, pair.value);
  }
  return result;
}

function assertNoAliases(node: unknown): void {
  if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && (node as { anchor?: unknown }).anchor)) {
    shape("Taskfile aliases and anchors are forbidden");
  }
  if (isMap(node)) {
    for (const item of node.items as readonly Pair[]) {
      assertNoAliases(item.key);
      assertNoAliases(item.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items as readonly unknown[]) assertNoAliases(item);
  }
}

/** custody canonicalRelativePath: non-empty, relative, posix-normalized, no empty, `.` or `..` segment. */
function canonicalPathProblem(path: string): string | null {
  if (
    typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/")
    || posix.normalize(path) !== path || path === "." || path === ".."
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return "is not a canonical target-relative path";
  }
  return null;
}

type ParsedTarget = Readonly<{ tokens: readonly string[] }> | Readonly<{ problem: string }>;
type ParsedTaskfile = Readonly<{ targets: ReadonlyMap<string, unknown> }> | Readonly<{ problem: string }>;

function parseTaskfile(content: string): ParsedTaskfile {
  try {
    const document = parseDocument(content, { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0 || !document.contents) shape("Taskfile is malformed or ambiguous YAML");
    assertNoAliases(document.contents);
    const root = mapEntries(document.contents as Node, "root");
    for (const key of root.keys()) if (!TOP_LEVEL_TASKFILE_KEYS.has(key)) shape(`Taskfile ${key} behavior is forbidden`);
    plainScalar(root.get("version"), "version");
    return { targets: mapEntries(root.get("tasks"), "tasks") };
  } catch (error) {
    if (error instanceof ShapeError) return { problem: error.message };
    throw error;
  }
}

/** custody verifyStrictTaskTarget plus parseLiteralCommand, for the Node profile only. */
function parseTarget(name: string, node: unknown): ParsedTarget {
  try {
    if (!VERIFY_TARGET.test(name)) shape(`target must be verify:* only: ${name}`);
    const target = mapEntries(node, `target ${name}`);
    for (const key of target.keys()) if (key !== "cmds") shape(`target ${key === "deps" ? "dependencies" : key} behavior is forbidden`);
    const commands = target.get("cmds");
    if (!isSeq(commands) || commands.anchor || commands.items.length !== 1) shape("target must contain exactly one literal command");
    const command = plainScalar(commands.items[0], "command");
    if (command.trim() !== command || FORBIDDEN_COMMAND_CHARACTERS.test(command)) shape("target command must be literal and substitution-free");
    const tokens = command.split(" ");
    if (tokens.some((token) => token.length === 0 || !TARGET_COMMAND_TOKEN.test(token)) || tokens.length < 3 || tokens[0] !== "node") {
      shape("target must invoke node, one harness and literal candidates");
    }
    for (const path of tokens.slice(1)) {
      const problem = canonicalPathProblem(path);
      if (problem) shape(`target path ${path} ${problem}`);
    }
    return { tokens };
  } catch (error) {
    if (error instanceof ShapeError) return { problem: error.message };
    throw error;
  }
}

function bundleTaskfile(bundle: CccPlanningVerifierBundleV1): string | null {
  return bundle.files.find((file) => file.path === TASKFILE)?.content ?? null;
}

/** The proofs as the importer will see them, derived from the verifier bundle alone. */
export function cccPlanningProofDefinitionsFromBundle(bundle: CccPlanningVerifierBundleV1): CccPlanningProofDefinition[] {
  const content = bundleTaskfile(bundle);
  const taskfile = content === null ? null : parseTaskfile(content);
  return bundle.proofs.map((proof) => {
    const others = proof.files.filter((path) => path !== TASKFILE);
    const node = taskfile !== null && "targets" in taskfile ? taskfile.targets.get(proof.taskfileTask) : undefined;
    const target = node === undefined ? null : parseTarget(proof.taskfileTask, node);
    const tokens = target !== null && "tokens" in target ? target.tokens : null;
    const harness = tokens ? tokens[1]! : (others.length === 1 ? others[0]! : null);
    return {
      id: proof.id,
      command: `task ${proof.taskfileTask}`,
      verifierClosure: [
        { role: "task_runner" as const, path: TASKFILE },
        ...(harness === null ? [] : [{ role: "harness" as const, path: harness }]),
        ...others.filter((path) => path !== harness).map((path) => ({ role: "fixture" as const, path })),
      ],
      candidateInputs: tokens ? tokens.slice(2) : [],
    };
  });
}

type TaskPaths = Readonly<{ id: string; proofIds: readonly string[]; owned: readonly string[]; roots: readonly string[]; all: readonly string[] }>;

function isWriterPath(path: string): boolean {
  const key = cccPlanningPathComparisonKey(path);
  return WRITER_ROOTS.some((root) => key === root || key.startsWith(`${root}/`));
}

function isSameOrWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function keyWithin(path: string, root: string): boolean {
  return isSameOrWithin(cccPlanningPathComparisonKey(path), cccPlanningPathComparisonKey(root));
}

/** Pure; one CCC_PLANNING_GRAPH_INADMISSIBLE diagnostic per violation, empty when every proof survives the custody rules. */
export function checkCccPlanningProofCommands(
  taskPlan: CccPlanningTaskPlanV1,
  verifierBundle: CccPlanningVerifierBundleV1,
  proofs: readonly CccPlanningProofDefinition[] = cccPlanningProofDefinitionsFromBundle(verifierBundle),
): CccPrdDiagnostic[] {
  const diagnostics: CccPrdDiagnostic[] = [];
  const add = (rule: CccPlanningProofCommandRule, subject: string, path: string, text: string) => diagnostics.push({
    code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
    message: `proof-command policy rule ${rule}: ${subject}: path ${path}: ${text}`,
  });

  const tasks: TaskPaths[] = taskPlan.tasks.map((task) => {
    const owned = [...task.ownedPaths];
    const roots = [...task.allowedWriteRoots];
    return { id: task.id, proofIds: [...task.proofIds], owned, roots, all: [...owned, ...roots] };
  });
  const bundleFiles = new Set(verifierBundle.files.map(({ path }) => path));
  const bundleFileByKey = new Map(verifierBundle.files.map(({ path }) => [cccPlanningPathComparisonKey(path), path]));
  const bundleProofs = new Map(verifierBundle.proofs.map((proof) => [proof.id, proof]));
  const taskfileKey = cccPlanningPathComparisonKey(TASKFILE);

  // Writers own only src/** and bin/**.
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const path of task.all) {
      const key = cccPlanningPathComparisonKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isWriterPath(path)) continue;
      const bundled = bundleFileByKey.get(key);
      const why = key === taskfileKey
        ? `is the verifier task runner ${TASKFILE}, which only the verifier bundle may hold`
        : bundled !== undefined
          ? `is the verifier bundle file ${bundled}`
          : ["test", "tests", "fixtures"].includes(key.split("/")[0]!)
            ? "is a test or fixture path, which only the verifier bundle may hold"
            : "is outside src/** and bin/**, the only paths a writer task may own";
      add("writer-owns-only-src-bin", `task ${task.id} (proofs ${task.proofIds.join(", ") || "none"})`, path, why);
    }
  }

  // Every proof a task names is defined once and is a verifier bundle proof.
  const definitions = new Map<string, CccPlanningProofDefinition>();
  for (const proof of proofs) {
    if (definitions.has(proof.id)) add("task-proof-defined", `proof ${proof.id}`, "-", "is defined more than once");
    else definitions.set(proof.id, proof);
  }
  for (const task of tasks) {
    for (const proofId of task.proofIds) {
      if (!definitions.has(proofId)) add("task-proof-defined", `proof ${proofId}`, "-", `task ${task.id} names it but no proof definition exists`);
    }
  }

  const content = bundleTaskfile(verifierBundle);
  const taskfile = content === null ? null : parseTaskfile(content);

  for (const proof of definitions.values()) {
    const subject = `proof ${proof.id}`;
    const bundleProof = bundleProofs.get(proof.id);
    if (!bundleProof) {
      add("proof-is-in-verifier-bundle", subject, "-", "the verifier bundle declares no proof with this id");
    } else if (bundleProof.taskfileTask !== `verify:${proof.id}`) {
      add("proof-is-in-verifier-bundle", subject, TASKFILE, `the bundle names target ${JSON.stringify(bundleProof.taskfileTask)}, not verify:${proof.id}`);
    }

    // The command.
    const commandMatch = PROOF_COMMAND.exec(proof.command);
    const commandOk = commandMatch !== null && proof.command === `task verify:${proof.id}`;
    if (!commandOk) {
      add("proof-command-is-task-verify", subject, "-",
        `command ${JSON.stringify(proof.command)} must be exactly "task verify:${proof.id}", run through the baseline ${TASKFILE}`);
    }

    // The closure.
    const closure = proof.verifierClosure;
    const closureKeys = new Map<string, string>();
    for (const entry of closure) {
      const problem = canonicalPathProblem(entry.path);
      if (problem) add("closure-path-canonical", subject, entry.path, problem);
      const key = cccPlanningPathComparisonKey(entry.path);
      const first = closureKeys.get(key);
      if (first !== undefined) add("closure-path-canonical", subject, entry.path, `is the same path as closure path ${first}`);
      else closureKeys.set(key, entry.path);
      if (!bundleFiles.has(entry.path)) {
        add("closure-in-verifier-bundle", subject, entry.path,
          `is not a file of the verifier bundle committed at B1, where the custody check reads the closure`);
      }
      for (const task of tasks) {
        const root = task.all.find((candidate) => cccPlanningPathsOverlap(entry.path, candidate));
        if (root !== undefined) {
          add("closure-disjoint-from-write-roots", subject, entry.path,
            `verifier ${entry.role} overlaps ${root}, owned or writable by task ${task.id}`);
        }
      }
    }
    const runners = closure.filter((entry) => entry.role === "task_runner");
    if (runners.length !== 1 || runners[0]!.path !== TASKFILE) {
      add("closure-has-one-taskfile-runner", subject, runners.map(({ path }) => path).join(", ") || "-",
        `the closure needs exactly one task runner, the baseline ${TASKFILE}`);
    }
    const harnesses = closure.filter((entry) => entry.role === "harness").map(({ path }) => path);

    // The Taskfile target, when the command names one.
    let targetCandidates: readonly string[] | null = null;
    if (commandOk) {
      const targetName = commandMatch![1]!;
      if (content === null || taskfile === null) {
        add("taskfile-in-verifier-bundle", subject, TASKFILE, `the verifier bundle has no ${TASKFILE}`);
      } else if ("problem" in taskfile) {
        add("taskfile-literal-shape", subject, TASKFILE, taskfile.problem);
      } else if (!taskfile.targets.has(targetName)) {
        add("taskfile-declares-target", subject, TASKFILE, `the bundle's ${TASKFILE} does not declare target ${targetName}`);
      } else {
        const target = parseTarget(targetName, taskfile.targets.get(targetName));
        if ("problem" in target) {
          add("target-literal-node-command", subject, TASKFILE, `target ${targetName}: ${target.problem}`);
        } else {
          if (harnesses.length !== 1 || target.tokens[1] !== harnesses[0]) {
            add("target-invokes-declared-harness", subject, target.tokens[1]!,
              `target ${targetName} must invoke the one declared harness (${harnesses.join(", ") || "none"})`);
          }
          targetCandidates = target.tokens.slice(2);
          if (
            targetCandidates.length !== proof.candidateInputs.length
            || computeCccPrdCandidateInputsSha256(targetCandidates) !== computeCccPrdCandidateInputsSha256(proof.candidateInputs)
          ) {
            add("target-candidates-match-proof", subject, TASKFILE,
              `target ${targetName} passes ${targetCandidates.join(" ")} but the proof declares ${proof.candidateInputs.join(" ") || "none"}`);
          }
        }
      }
    }

    // The candidates.
    // The custody check hydrates a proof for each task that runs it, so a candidate must lie inside every such task's write roots.
    const runningTasks = tasks.filter((task) => task.proofIds.includes(proof.id));
    const candidates = new Set<string>();
    for (const candidate of proof.candidateInputs) {
      const problem = canonicalPathProblem(candidate);
      if (problem) {
        add("candidate-path-canonical", subject, candidate, problem);
        continue;
      }
      const key = cccPlanningPathComparisonKey(candidate);
      if (candidates.has(key)) add("candidate-path-canonical", subject, candidate, "is listed more than once");
      candidates.add(key);
      const closurePath = closureKeys.get(key);
      if (closurePath !== undefined) add("candidate-not-closure", subject, candidate, `is the verifier closure path ${closurePath}`);
      if (runningTasks.length === 0) {
        add("candidate-in-own-write-roots", subject, candidate, "no task in the plan runs this proof, so the candidate lies in no task's write roots");
      }
      for (const task of runningTasks) {
        if (task.roots.some((root) => isSameOrWithin(candidate, root))) continue;
        const aliased = task.roots.find((root) => keyWithin(candidate, root));
        add("candidate-in-own-write-roots", subject, candidate, aliased !== undefined
          ? `matches task ${task.id} write root ${aliased} only on the comparison key; the custody check needs the exact spelling`
          : `is outside the write roots of task ${task.id} (${task.roots.join(", ") || "none"})`);
      }
    }
  }
  return diagnostics;
}
