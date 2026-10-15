/*
FNXC:CccPlanningProof 2026-10-14-21:22:
Proof inventory for request-to-code v3 card C2 (tool policy and confined tools: D11, CONTRACT-v3 section 2.13, verify-v2 items 34, 37, 39 and 47, errata E2-7 and E4-10). One module per card keeps the inventory files disjoint; `index.mjs` loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the five files of the card's check command, one engine command pinned to `engine-default` (its aliases point @fusion/core at source, so no build runs). OFFLINE is name-closed over the same five files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command. No file reaches PostgreSQL (`needsPostgres: false`); the files use temporary directories, symlinks and an empty PATH only, so they run on any platform.

Measured on the M5 Max at load average 12.2 (1 min) with parallel agents: 5.3 s wall for the five files (32 tests), about 4 s vitest duration. The 120 s timeout is a hang bound over that measurement; no test timeout is raised anywhere.
*/

const FILES = Object.freeze([
  "src/__tests__/ccc-session-tool-policy.test.ts",
  "src/__tests__/ccc-confined-fs-tools.test.ts",
  "src/__tests__/ccc-confined-grep-tool.test.ts",
  "src/__tests__/ccc-verdict-tool.test.ts",
  "src/__tests__/ccc-probe-echo-tool.test.ts",
]);

const POLICY = "closed session tool policy (card C2, D11)";
const FS = "confined file operations (card C2)";
const GREP = "confined grep (card C2, D11)";
const VERDICT = "ccc_submit_verdict (card C2)";
const ARTIFACT = "ccc_submit_artifact (card C2)";
const PROBE = "ccc_probe_echo and wrapCccProbedTool (card C2)";

const ENGINE_COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: FILES,
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "c2-engine-tool-policy", ...ENGINE_COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "c2-engine-tool-policy-names",
    ...ENGINE_COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${FS} > refuses a confined read of ../x and of an escaping symlink; a read inside the root, also through an in-root symlink, returns the bytes`,
      `${FS} > never reads, lists or finds a denied name or a .git segment inside a root`,
      `${FS} > refuses a write or edit to <root>/sub/.git/config and to a denied-name file through X1's shared cccConfinedWriteRefusal; a sibling ordinary file is accepted`,
      `${FS} > refuses every write when the session has no write roots, and a write through an escaping symlink`,
      `${FS} > validates denied names against [A-Za-z0-9._*-] with a TypeError before any predicate call`,
      `${GREP} > with an empty PATH and PI_OFFLINE=1 the confined grep and find return their matches while Pi's own grep and find reject`,
      `${GREP} > finds a match in an allowed file, refuses a path outside the roots, and never returns lines from .env inside a root`,
      `${GREP} > its own path filter calls X1's cccConfinedWriteRefusal with writeRoots equal to readRoots, so file operations that filter nothing still never yield .env or .git lines`,
      `${GREP} > is named grep, carries CCC_CONFINED_TOOL_MARK and Pi's grep parameter names, and refuses an invalid denied name with a TypeError before any predicate call`,
      `${GREP} > bounds matches by the call limit and by limits.maxMatches, and skips a file larger than limits.maxBytesPerFile`,
      `${PROBE} > ccc_probe_echo with one extra key records exact: false and aborts the turn`,
      `${PROBE} > positive control: the exact echo records exact: true once, aborts the turn once and ends the turn`,
      `${PROBE} > records a wrong value as exact: false and never records a second observation`,
      `${PROBE} > wrapCccProbedTool(edit) keeps the name, parameters and CCC_CONFINED_TOOL_MARK, runs the real confined edit, records exact-edit ok and aborts the turn exactly once`,
      `${PROBE} > wrapCccProbedTool records a failing tool as error, still aborts the turn once and ends the turn`,
      `${PROBE} > a wrapped ccc_submit_verdict records verdict-shape ok and aborts the turn exactly once`,
      `${POLICY} > refuses a critic session given tools readonly, builtinToolsAllowlist WebFetch and one MCP server with CCC_SESSION_TOOL_POLICY_REFUSED before any MCP connection or session`,
      `${POLICY} > positive control: the same options with no binding policy yield a session containing WebFetch`,
      `${POLICY} > a critic session's final tools equal exactly the 5 critic names, its grep carries CCC_CONFINED_TOOL_MARK, Pi's grep is never created, and host extensions and skills are off`,
      `${POLICY} > refuses an out-of-policy custom tool, toolsAllowlist entry or builtinToolsAllowlist entry, and an unmarked tool named grep; positive control: in-policy entries create the session`,
      `${POLICY} > buildCccSessionToolPolicy for a linked writer gives ccc-linked-writer-tools.v1 and CCC_PLANNING_LINKED_WRITER_TOOLSET; assertCccSessionToolSet admits the ready tool and refuses the set without it and a plain writer policy with it`,
      `${POLICY} > linkedWriter true with any other role class throws, a critic with write roots throws, and a fn_complete_phase that is not the campaign ready tool is refused`,
      `${POLICY} > assertCccSessionToolSet refuses changed parameters and Pi's own grep under the grep name; positive control: the built tools pass`,
      `${POLICY} > a linked writer session through createFnAgent keeps fn_complete_phase through the wrapper chain and is refused without it`,
      `${VERDICT} > refuses accept with a blocking finding; positive control: reject with the same finding is recorded`,
      `${VERDICT} > refuses a requirement ref when requirementIds is null or the id is unknown; positive control: a known requirement id is recorded`,
      `${VERDICT} > refuses an artifact or source ref outside the session inputs; positive control: an input artifact, an input source and a counterexample ref are recorded`,
      `${VERDICT} > refuses a path outside reviewedPaths, any path when reviewedPaths is null, a summary or counterexample over 600 characters, and an unknown key; positive control: a reviewed path at 600 characters is recorded`,
      `${VERDICT} > refuses a second call after an accepted submission`,
      `${VERDICT} > declares no copy of CccReviewFindingRef or CccReviewVerdict and imports both from @fusion/core`,
      `${ARTIFACT} > refuses a kind outside allowedKinds, an unknown contentSchema, validator problems and a bad status; positive control: an allowed json submission is recorded`,
      `${ARTIFACT} > submits text content as its UTF-8 bytes`,
    ]),
  }),
]);
