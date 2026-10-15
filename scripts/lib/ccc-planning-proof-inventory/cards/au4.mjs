/*
FNXC:CccPlanningProof 2026-10-15-00:43:
Proof inventory for request-to-code v3 card AU4 (owned disposable target, D24, PRD section 7:213-215, CONTRACT-v3.5 section 4.1 and section 4.2 step 2, ADR D Q3 and Q4). One module per card keeps the inventory files disjoint; `index.mjs` (card P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's one real-git test file. OFFLINE is name-closed over the same file: the names below are exactly its 33 tests, built the way `assertionName` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The file holds two groups: the target builder (`scripts/lib/ccc-planning-disposable-target.mjs`, 15 tests: layout and receipt facts, home settings, K1 pins, base URL policy, refusals, the directories step 1 leaves behind, output symlink refusal, and the PostgreSQL argv, root ownership, log confinement, port and failure-cleanup tests) and `assertCccPlanningOwnedDisposableTarget` (18 tests, each a flip on the owned control repository).

The command is `platform: "any"` and `needsPostgres: false`: every repository is a real git repository under os.tmpdir(), with HOME and GIT_CONFIG_NOSYSTEM set, no network and no PostgreSQL; the tests that cover PostgreSQL provisioning use argv and a fake runner and never start a server. The default-pins test reads `packages/core/dist/ccc-planning/policy.js`, so core must be built first, as for every engine run. The engine project is pinned to `engine-default` so the `engine-core` build-on-setup never fires.

Fresh pre-repair run on 2026-10-15: Darwin arm64, Node v24.16.0, engine-default, PI_OFFLINE=1 and FUSION_PG_TEST_SKIP=1, with task TMPDIR outside the repository: 27/27 passed in 14.75 s (tests 12.26 s). The command timeout remains a hang bound; no test timeout is raised anywhere. The ownership/cleanup repair adds four focused behavioural regressions, using a fake PostgreSQL runner and no service startup.
*/

/*
FNXC:CccPlanningProof 2026-10-15-05:25:
AU4 repair 2 adds the pg.log leaf confinement and external Git metadata refusals. The 33 exact names include the 31 predecessor tests unchanged; PostgreSQL startup and log append are represented by the owned fake runner, never a live service.
*/

const FILE = "src/__tests__/ccc-planning-disposable-target.real-git.test.ts";

const BUILDER = "ccc planning disposable target builder";
const ASSERT = "assertCccPlanningOwnedDisposableTarget";

const COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "au4-disposable-target", ...COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "au4-disposable-target-names",
    ...COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${BUILDER} > builds the sealed layout, a one-commit B0 baseline without a remote, and reports the receipt facts`,
      `${BUILDER} > writes home settings with three pinned providers, modelSync disabled, the no-cache header and no credential`,
      `${BUILDER} > reads the three model pins from the K1 role policy in core, and refuses a policy that disagrees`,
      `${BUILDER} > accepts exactly the OmniRoute base URLs the engine loopback policy accepts, and refuses port 4040 as well`,
      `${BUILDER} > refuses a bad base URL, a root with another name and a relative root before writing anything; the control builds`,
      `${BUILDER} > refuses to build over an existing target or inside another repository, without writing; a second target gets a fresh nonce`,
      `${BUILDER} > builds beside the install, evidence and home directories that step 1 already filled, and leaves them as they were`,
      `${BUILDER} > builds PostgreSQL commands that bind 127.0.0.1 only, with no Unix socket, and refuses ports 5432 and 4040`,
      `${BUILDER} > picks a free loopback port that is neither 5432 nor 4040 and can really be bound`,
      `${BUILDER} > runs no PostgreSQL command unless asked, and runs initdb, start, ready, createdb in order when asked; a failure stops the server it started`,
      `${BUILDER} > refuses existing layout symlinks before writing any target or following an external directory`,
      `${BUILDER} > keeps PostgreSQL inside the builder root even when PostgreSQL options name another root`,
      `${BUILDER} > refuses a pre-existing or late-created pg.log symlink before PostgreSQL can append outside the scratch root`,
      `${BUILDER} > attempts exact owned PostgreSQL teardown when start fails and preserves a teardown failure`,
      `${BUILDER} > stops owned PostgreSQL when sealing fails after startup and preserves a teardown failure`,
      `${ASSERT} > admits the owned control repository and runs the git checks in order, each in the right directory`,
      `${ASSERT} > refuses a repository with a remote, and admits the same repository before the remote is added`,
      `${ASSERT} > refuses remote config that git remote does not list, so the second remote probe is not redundant`,
      `${ASSERT} > refuses an owner.json with a different digest, whether the file or the receipt changed`,
      `${ASSERT} > refuses a missing owner.json, an unreadable or foreign marker, and a marker that names another repository`,
      `${ASSERT} > refuses an ownership marker path other than <scratchRoot>/owner.json even when its bytes match the digest`,
      `${ASSERT} > refuses a repository that is not a direct child of scratchRoot, whether the receipt or the disk puts it deeper`,
      `${ASSERT} > refuses a baseCommit that is not HEAD, and a baseTree that is not its tree`,
      `${ASSERT} > refuses a dirty tracked file, an untracked file and a staged file, each admitted again once undone`,
      `${ASSERT} > refuses a scratch root that sits inside another repository, and admits it before that repository exists`,
      `${ASSERT} > compares realpaths: a symlink to the repository is the registered project, a different directory is not`,
      `${ASSERT} > refuses a receipt that spells the scratch root or the repository through a symlink instead of its realpath`,
      `${ASSERT} > refuses an external .git symlink, gitfile or common directory before any git command; the owned standalone control passes`,
      `${ASSERT} > refuses a receipt that is not an owned disposable target without remotes, or whose fields are not what the check reads`,
      `${ASSERT} > refuses instead of throwing when git, readFile or realpath fail, and when a git failure proves nothing`,
      `${ASSERT} > runs no git command until the ownership marker matches its digest`,
      `${ASSERT} > runs git status with core.fsmonitor off, so a repository config cannot make git run a program`,
      `${ASSERT} > has refused with every named check at least once in this file`,
    ]),
  }),
]);
