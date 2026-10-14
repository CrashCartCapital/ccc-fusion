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
  `${SUITE} > writes inside a write root and scratch, and is refused in the worktree outside the write roots`,
  `${SUITE} > denies writes to any .git path segment inside a write root while a sibling file in the same root writes`,
  `${SUITE} > keeps .env unreadable when the caller passes no denied names, while README reads`,
  `${SUITE} > runs the sealed git and a node child with a worker thread under the profile`,
  `${SUITE} > refuses hard-linking a toolchain binary into a write root and cannot execute a copy, while a symlinked launch still runs the per-instance clone`,
  `${SUITE} > caps output at maxOutputBytes with a truncation marker and still confirms closure`,
  `${SUITE} > reaps a command that outlives the model-requested timeout and reports the timeout`,
  `${SUITE} > kills a CPU loop at the cpuSeconds rlimit while the same loop under the default limit is not killed early`,
  `${SUITE} > confirms a normal command's closure with zero survivors`,
  `${SUITE} > kills a setsid escaper, an argv[0]-spoofed escaper and a symlink-launched escaper from outside the sandbox after the command kills its reaper`,
  `${SUITE} > kills a setsid escaper from outside the sandbox after the command freezes its reaper past a 2 s timeout`,
  `${SUITE} > serializes concurrent execs on one instance so the later command starts after the earlier one ends`,
  `${SUITE} > emits every deny after the allows, admits loopback only for the owned port, and grants no mach, shm or system-socket`,
  `${SUITE} > binds the template digest to the denied-name pattern, the sealed environment and the loopback rule`,
  `${SUITE} > refuses before any spawn > refuses a non-Darwin platform as platform-unsupported, while the same input on Darwin is admitted`,
  `${SUITE} > refuses before any spawn > refuses a toolchain executable whose bytes changed after sealing, while the unchanged toolchain is admitted`,
  `${SUITE} > refuses before any spawn > refuses to seal an Apple platform binary, which macOS kills when it runs from a clone, while the Homebrew toolchain seals`,
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
