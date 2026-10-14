/*
FNXC:CccPlanningProofInventory 2026-10-14-15:32:
Proof inventory for request-to-code v3 card X1b (toolchain discovery and
package-command compatibility; PRD §8, D12; errata E2-25, E4-5, E4-15, E4-B).
One module per card keeps the inventory files disjoint; `index.mjs` (owned by
P0) loads `cards/*.mjs` in sorted order.

Both suites run the real `sandbox-exec` or real host binaries, so the command
is tagged `platform: "darwin"`; each file's single
`describe.skipIf(process.platform !== "darwin")` is the one skip form ADR D
allows in a Darwin-tagged planning file. Neither needs PostgreSQL. The lists
are names-closed: the names below are exactly the tests in the two files,
built as ancestor titles joined with " > ", then " > ", then the title, so a
skipped, renamed, missing or extra test fails. The command pins
`--project=engine-default` like every engine check (rule 3.0.5).

Runner hang bound (E4-B sized the X1c way, E4-X item 3), measured on the M5 Max
on 2026-10-14 with other agents' suites running: the closed check (both files,
thirteen tests) took 14.36 s and 14.33 s wall at load averages 8.99 and 8.10;
the slowest test is the real host scan at 4.8 s, then two sandbox tests at
about 3.9 s. No run at load average 25 or more could be observed this session,
so the bound scales from X1's measured slowdown instead (each confined exec
pays 0.5 to 0.9 s per lsof scan at load 16 to 33 against about 0.3 s quiet,
about three times): 14.4 s x 3 x 1.5 is about 65 s, and the bound is 120 s.
This is a hang bound for a deterministic suite, not a test-timeout widening;
no test timeout is changed.
*/

const DISCOVERY = "CCC toolchain discovery (Darwin)";
const FIXTURE = `${DISCOVERY} > fixture search path`;
const HOST = `${DISCOVERY} > host scan (positive control)`;
const COMPAT = "CCC shell compatibility layer (Darwin sandbox-exec)";

const NAMES = Object.freeze([
  `${FIXTURE} > seals every required tool from the non-platform directory under its unprefixed name, gcat as cat and gawk as awk, skipping the platform binaries in /bin and /usr/bin and a script shim earlier on the path`,
  `${FIXTURE} > seals sh from a non-platform dash when one is found, skipping the platform /bin/dash, and from the non-platform bash otherwise`,
  `${FIXTURE} > refuses a missing required utility as CCC_PLANNING_CONFINEMENT_UNQUALIFIED toolchain-missing:rg, while the same path with rg added seals it`,
  `${FIXTURE} > refuses a role found only as a platform binary or a script shim as toolchain-missing:git, while a non-platform git binary later on the path is sealed`,
  `${FIXTURE} > seals exactly the tools a caller requires plus the four roles, so a path without gawk seals without awk, while the default list refuses toolchain-missing:awk`,
  `${FIXTURE} > takes the first directory on the path that holds a usable candidate, and inside one directory the unprefixed name before the g-prefixed one`,
  `${FIXTURE} > rejects a malformed required name with a TypeError before any search, and ignores relative search-path entries, while the absolute entry is searched`,
  `${HOST} > finds and seals bash, sh, node, git, task, rg and cat on this host from the default search path, and the sealed cat (from gcat) runs as cat inside X1's sandbox with task, rg and git`,
  `${COMPAT} > every wrapper carries a toolchain shebang and the npm wrapper runs npm inside the sandbox, while the raw shell has no npm`,
  `${COMPAT} > the BASH_ENV dispatcher runs node_modules/.bin shims through the toolchain sh and node and exports npm_config_script_shell, while the raw shell cannot run them`,
  `${COMPAT} > npm run starts its script shell from the toolchain bash, which loads the dispatcher and runs a .bin shim, while npm's default sh cannot run the shim`,
  `${COMPAT} > refuses a shim whose shebang names an interpreter outside the toolchain with a clear message and status 126, while a sh shim in the same directory runs`,
  `${COMPAT} > keeps the dispatcher read-only inside the sandbox and refuses an exec once it changed outside, while the scratch home stays writable and the restored file runs`,
]);

function toolchainShellCompatCommand(id) {
  return Object.freeze({
    id,
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze([
      "src/__tests__/ccc-toolchain-discovery.darwin.test.ts",
      "src/__tests__/ccc-shell-compat.darwin.test.ts",
    ]),
    closure: "names",
    expectedNames: NAMES,
    platform: "darwin",
    needsPostgres: false,
    timeoutMs: 120_000,
  });
}

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([toolchainShellCompatCommand("x1b-toolchain-shell-compat")]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([toolchainShellCompatCommand("x1b-toolchain-shell-compat-offline")]);
