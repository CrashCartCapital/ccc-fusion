/*
FNXC:CccPlanningProofInventory 2026-10-14-08:45:
Proof inventory for request-to-code v3 card X1 (confined writer shell, PRD §8,
D12, ADR C Q3). One module per card keeps the inventory files disjoint
(contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order.

The suite runs the real `sandbox-exec`, so it is tagged `platform: "darwin"`;
its single `describe.skipIf(process.platform !== "darwin")` is the one skip form
ADR D allows in a Darwin-tagged planning file. Both lists are name-closed: the
names below are exactly the tests in the file, joined the way
`assertionName` in `scripts/run-ccc-pg-proof.mjs` joins them (ancestor titles
and the title with " > "), so a skipped, renamed, missing or extra test fails.

FNXC:CccPlanningProofInventory 2026-10-14-11:23:
Errata E1-17: X1's closed check is `ccc-confined-shell.darwin.test.ts` only.
`src/__tests__/ccc-campaign-proof-sandbox.test.ts` (the regression proof for the
runner extraction) runs as an outside regression check, not from this
inventory: its Darwin-inverse `it.skipIf(process.platform === "darwin")` at
line 35 predates this work and always skips on the only host this inventory
runs on, which the zero-skip rule would fail.

The repair per review v1 and errata E1-18..E1-20 (controller-side sweep, env
probe canary, escaper recording, denied-name minimum, `.git` segment deny,
serialized execs, wider template digest, platform-binary refusal) brings the
file to twenty-eight tests. Measured on the M5 Max: about 60 s for the file,
the slowest the reaper-freeze test at about 11 s (2 s timeout, then the reap
budget, then the controller sweep) and the seven-probe qualification at about
8 s. The 180 s command timeout is a hang bound with headroom for a loaded host,
not a test timeout.

FNXC:CccPlanningProofInventory 2026-10-14-14:05:
The final repair per errata E2 (E2-11, E2-12, E2-21..E2-26: test-only seams,
the env-scrubbed probe failing a leaky builder, absolute /usr/sbin/lsof with
strict parsing and the closure-sweep-unavailable refusal, the shared write
predicate and default denied names, instance dispose and the toolchains layout,
named utilities, the syscall-loop wall bound and foreign-zombie filtering)
brings the file to forty-five tests, listed below in file order. Measured on
the M5 Max with a load average of 16 to 30 from other agents: 162 s for the
file, the slowest the seven-probe qualification and its leaky-builder twin at
about 14 to 16 s each and the reaper-freeze test at about 13 s. Each confined
exec pays two to six lsof scans at 0.5 to 0.9 s each under that load. The
180 s command timeout is unchanged; on a quiet host the file takes well under
it, and on a host this loaded the margin is thin, which is a host-load fact,
not a reason to widen it.
*/

const SUITE = "CCC confined writer shell (Darwin sandbox-exec)";

const NAMES = Object.freeze([
  `${SUITE} > network > (a) refuses a connect to an unadmitted 127.0.0.1 listener with EPERM while the same connect outside succeeds`,
  `${SUITE} > network > (h) connects to the one admitted loopback port from acquireCccSemanticProofLoopbackPort while an unadmitted port in the same command is refused`,
  `${SUITE} > (b) denies reading a file outside the roots while the same read outside the sandbox prints it`,
  `${SUITE} > (c) denies kill -0 of a same-user sibling spawned outside the sandbox while the same kill outside succeeds, and the sibling survives`,
  `${SUITE} > (d) drops parent credentials from the environment and passes only the sealed and task keys`,
  `${SUITE} > (e) reaps a setsid escaper after the command returns and lists it in the closure record`,
  `${SUITE} > (f) denies .env inside the worktree while README in the same directory reads`,
  `${SUITE} > (g) qualifyCccConfinedShell reports all seven probes passed for this toolchain and OS build`,
  `${SUITE} > fails env-scrubbed, and so the qualification, when a test-only sealed-environment builder spreads process.env, while the other six probes still pass`,
  `${SUITE} > writes inside a write root and scratch, and is refused in the worktree outside the write roots`,
  `${SUITE} > denies writes to any .git path segment inside a write root while a sibling file in the same root writes`,
  `${SUITE} > denies .envrc, a default name, and a caller-added name inside the sandbox, while README reads`,
  `${SUITE} > keeps .env unreadable when the caller passes no denied names, while README reads`,
  `${SUITE} > runs the sealed git and a node child with a worker thread under the profile`,
  `${SUITE} > refuses hard-linking a toolchain binary into a write root and cannot execute a copy, while a symlinked launch still runs the per-instance clone`,
  `${SUITE} > lays the per-instance clone out at <scratch>/toolchains/<instance>/bin and denies writes anywhere under toolchains from inside, while the scratch home writes`,
  `${SUITE} > dispose removes only its own instance clone, is idempotent, and makes a later exec refuse, while another instance on the same scratch keeps running`,
  `${SUITE} > runs a utility sealed from gcat under the name cat, while without the name only gcat is on PATH`,
  `${SUITE} > keeps a foreign zombie the in-sandbox reaper can signal out of the closure record, while a real escaper in the same command is listed`,
  `${SUITE} > caps output at maxOutputBytes with a truncation marker and still confirms closure`,
  `${SUITE} > reaps a command that outlives the model-requested timeout and reports the timeout`,
  `${SUITE} > kills a CPU loop at the cpuSeconds rlimit while the same loop under the default limit is not killed early`,
  `${SUITE} > stops a loop that makes a syscall on every pass, which RLIMIT_CPU does not stop on macOS, at the wall timeout with closure confirmed`,
  `${SUITE} > confirms a normal command's closure with zero survivors`,
  `${SUITE} > reports CLOSURE_UNCONFIRMED when the sweep's lsof exits 1 or prints unparseable output, while the real lsof confirms the same command`,
  `${SUITE} > kills a setsid escaper, an argv[0]-spoofed escaper and a symlink-launched escaper from outside the sandbox after the command kills its reaper`,
  `${SUITE} > kills a setsid escaper from outside the sandbox after the command freezes its reaper past a 2 s timeout`,
  `${SUITE} > serializes concurrent execs on one instance so the later command starts after the earlier one ends`,
  `${SUITE} > emits every deny after the allows, admits loopback only for the owned port, and grants no mach, shm or system-socket`,
  `${SUITE} > binds the template digest to the denied-name pattern, the sealed environment and the loopback rule`,
  `${SUITE} > shared write predicate > exports the default denied names as a frozen superset of the planning list plus .envrc`,
  `${SUITE} > shared write predicate > unions caller names with the defaults, folding case and de-duplicating, so a caller cannot drop .env`,
  `${SUITE} > shared write predicate > refuses a path outside the write roots, including through .., a symlink or a relative spelling, while a path inside a root is admitted`,
  `${SUITE} > shared write predicate > refuses a .git segment in any case, while a sibling ordinary file is admitted`,
  `${SUITE} > shared write predicate > refuses every effective denied name as the basename or any segment, folding case like K1, while near-miss names are admitted`,
  `${SUITE} > refuses before any spawn > refuses a non-Darwin platform as platform-unsupported, while the same input on Darwin is admitted`,
  `${SUITE} > refuses before any spawn > refuses a toolchain executable whose bytes changed after sealing, while the unchanged toolchain is admitted`,
  `${SUITE} > refuses before any spawn > refuses to seal an Apple platform binary, which macOS kills when it runs from a clone, while the Homebrew toolchain seals`,
  `${SUITE} > refuses before any spawn > refuses a sealed record naming an Apple platform binary as platform-binary-in-toolchain, while the Homebrew toolchain is admitted`,
  `${SUITE} > refuses before any spawn > refuses a duplicate effective PATH name, a role collision and a malformed name as toolchain-digest-drift, while distinct names seal`,
  `${SUITE} > refuses before any spawn > refuses creation as closure-sweep-unavailable when the sweep's lsof is missing, relative or not executable, while the absolute /usr/sbin/lsof is admitted`,
  `${SUITE} > refuses before any spawn > refuses a write root that carries a denied-name or .git segment as root-overlap, while an ordinary write root is admitted`,
  `${SUITE} > refuses before any spawn > refuses a qualification for another OS build or profile template, while the live one is admitted`,
  `${SUITE} > refuses before any spawn > refuses a write root outside the worktree and a scratch root inside it, while the contained layout is admitted`,
  `${SUITE} > refuses before any spawn > refuses credential-shaped and sealed taskEnv keys, while a plain task key is admitted`,
]);

function confinedShellCommand(id) {
  return Object.freeze({
    id,
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-confined-shell.darwin.test.ts"]),
    closure: "names",
    expectedNames: NAMES,
    platform: "darwin",
    needsPostgres: false,
    timeoutMs: 180_000,
  });
}

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([confinedShellCommand("x1-confined-shell")]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([confinedShellCommand("x1-confined-shell-offline")]);
