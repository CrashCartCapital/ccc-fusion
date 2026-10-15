/*
FNXC:CccPlanningProof 2026-10-14-21:22:
Proof inventory for request-to-code v3 card C2 (tool policy and confined tools: D11, CONTRACT-v3 section 2.13, verify-v2 items 34, 37, 39 and 47, errata E2-7 and E4-10). One module per card keeps the inventory files disjoint; `index.mjs` loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the five files of the card's check command, one engine command pinned to `engine-default` (its aliases point @fusion/core at source, so no build runs). OFFLINE is name-closed over the same five files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command. No file reaches PostgreSQL (`needsPostgres: false`); the files use temporary directories, symlinks and an empty PATH only, so they run on any platform.

Measured on the M5 Max at load average 12.2 (1 min) with parallel agents: 5.3 s wall for the five files (32 tests), about 4 s vitest duration. The 120 s timeout is a hang bound over that measurement; no test timeout is raised anywhere.
*/
/*
FNXC:CccPlanningProof 2026-10-14-22:41:
Repair 1 of card C2 adds eight tests (grep matching in a worker with a deadline and abort, a walk that enters each directory once, the file-cap notice on an empty result, probe calls that fail Pi's argument check and an inexact echo through Pi's real agent loop, a structural copy of an issued policy, sequential confined bash, write and edit, and the checked open) and renames the grep limits test. Measured at load average 9.3 (1 min) with parallel agents: 5 s wall for the five files (40 tests). The 120 s hang bound is unchanged.
*/
/*
FNXC:CccPlanningProof 2026-10-15-00:52:
Repair 2 of card C2 (errata E14) adds four tests: a FIFO inside a root that a confined read, edit, write or grep never blocks on, a wrapped ccc_probe_echo that records what the model sent and never ok for an inexact echo, and the refusal of a tool policy buildCccSessionToolPolicy did not build. The fs and grep files now make a FIFO with /usr/bin/mkfifo, present on macOS and on the Linux runners. Measured with parallel agents running: 4.9 s vitest duration for the five files (44 tests). The 120 s hang bound is unchanged.
*/
/*
FNXC:CccPlanningProof 2026-10-15-05:07:
The C2 extension-boundary successor adds two tests: policy-bound critic and linked writer sessions prevent package discovery and extension-factory execution while preserving explicit M3 provider registration, and an unbound legacy session still discovers enabled project and user extensions. The five files now hold 46 exact names; the 120 s hang bound is unchanged.
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
      `${FS} > under a tool policy the confined bash, write and edit run one at a time, so a write or read sent with a shell that swaps an in-root directory for an outside symlink lands inside the root and nothing lands outside`,
      `${FS} > a read or write whose checked directory is swapped for an outside symlink before the open is refused, and no outside bytes are returned or written`,
      `${FS} > a FIFO inside a root never blocks a confined read, edit or write: each settles at once with a not-a-regular-file refusal, four reads leave the thread pool free for an unrelated read, and a write with a reader present refuses before any byte reaches it; positive control: a regular file beside it still reads and writes`,
      `${FS} > validates denied names against [A-Za-z0-9._*-] with a TypeError before any predicate call`,
      `${GREP} > with an empty PATH and PI_OFFLINE=1 the confined grep and find return their matches while Pi's own grep and find reject`,
      `${GREP} > finds a match in an allowed file, refuses a path outside the roots, and never returns lines from .env inside a root`,
      `${GREP} > its own path filter calls X1's cccConfinedWriteRefusal with writeRoots equal to readRoots, so file operations that filter nothing still never yield .env or .git lines`,
      `${GREP} > is named grep, carries CCC_CONFINED_TOOL_MARK and Pi's grep parameter names, and refuses an invalid denied name with a TypeError before any predicate call`,
      `${GREP} > bounds matches by the call limit and by limits.maxMatches, and skips a file larger than limits.maxBytesPerFile without reading it`,
      `${GREP} > runs the pattern off the engine thread: ^(\\w+\\s?)+$ over a 40-character identifier line rejects with grep timed out inside the deadline while an unrelated timer keeps firing; positive control: the same pattern on a matching line returns the match`,
      `${GREP} > an abort ends a call whose pattern is still backtracking`,
      `${GREP} > enters each directory once: two symlinks to their own directory end in No matches found without an abort; positive control: a real subdirectory beside them is searched once`,
      `${GREP} > a search stopped by limits.maxFiles says so even when nothing matched; positive control: the narrowed path finds the symbol`,
      `${GREP} > skips a FIFO inside a root without opening it: a whole-root search and a search of the FIFO itself settle at once, and the FIFO is never read; positive control: the regular file beside it is read and matched`,
      `${PROBE} > ccc_probe_echo with one extra key records exact: false and aborts the turn`,
      `${PROBE} > positive control: the exact echo records exact: true once, aborts the turn once and ends the turn`,
      `${PROBE} > records a wrong value as exact: false and never records a second observation`,
      `${PROBE} > wrapCccProbedTool(edit) keeps the name, parameters and CCC_CONFINED_TOOL_MARK, runs the real confined edit, records exact-edit ok and aborts the turn exactly once`,
      `${PROBE} > wrapCccProbedTool records a failing tool as error, still aborts the turn once and ends the turn`,
      `${PROBE} > a wrapped ccc_submit_verdict or edit called with schema-invalid arguments through Pi's agent loop records one error observation, aborts the turn once, never runs the tool and makes no follow-up model call; positive control: a schema-valid call records ok in one model call`,
      `${PROBE} > a wrapped ccc_probe_echo given an inexact echo through Pi's agent loop records error with exactly the arguments the model sent, never ok, in one model call with one abort from the wrapper and one from the echo; positive control: an exact echo records ok with the sent arguments`,
      `${PROBE} > a wrapped ccc_submit_verdict records verdict-shape ok and aborts the turn exactly once`,
      `${POLICY} > refuses a critic session given tools readonly, builtinToolsAllowlist WebFetch and one MCP server with CCC_SESSION_TOOL_POLICY_REFUSED before any MCP connection or session`,
      `${POLICY} > positive control: the same options with no binding policy yield a session containing WebFetch`,
      `${POLICY} > policy-bound critic and linked writer sessions never discover extensions or execute their factories, while the explicit M3 provider still registers`,
      `${POLICY} > positive control: an unbound legacy session discovers enabled project and user extensions and executes their factories`,
      `${POLICY} > a critic session's final tools equal exactly the 5 critic names, its grep carries CCC_CONFINED_TOOL_MARK, Pi's grep is never created, and host extensions and skills are off`,
      `${POLICY} > refuses an out-of-policy custom tool, toolsAllowlist entry or builtinToolsAllowlist entry, and an unmarked tool named grep; positive control: in-policy entries create the session`,
      `${POLICY} > buildCccSessionToolPolicy for a linked writer gives ccc-linked-writer-tools.v1 and CCC_PLANNING_LINKED_WRITER_TOOLSET; assertCccSessionToolSet admits the ready tool and refuses the set without it and a plain writer policy with it`,
      `${POLICY} > linkedWriter true with any other role class throws, a critic with write roots throws, and a fn_complete_phase that is not the campaign ready tool is refused`,
      `${POLICY} > assertCccSessionToolSet refuses changed parameters and Pi's own grep under the grep name; positive control: the built tools pass`,
      `${POLICY} > a frozen structural copy of an issued policy gets the full final check: a critic copy without its verdict tool or with a foreign ccc_submit_verdict, and a linked writer copy without fn_complete_phase, are refused; positive control: the copies with their tools create sessions`,
      `${POLICY} > createFnAgent refuses a policy not built by buildCccSessionToolPolicy: a hand-built critic policy without ccc_submit_verdict, with a foreign one or even with its own, and a hand-built linked-writer policy without fn_complete_phase are refused before any MCP connection or session; positive control: the same roles built through buildCccSessionToolPolicy create their sessions`,
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
