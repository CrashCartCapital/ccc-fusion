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

FNXC:CccPlanningProofInventory 2026-10-14-17:30:
Repair 1 (errata E6-B). The closed check now holds nineteen tests: twelve in
discovery, seven in the shim layer. New since round 1: the missing bash and
node roles, the execute-permission check, the optional GNU tools (E6-0), the
Homebrew-only default search path, the `env -S` shebang and the extra-file
refusal; the sh-shim interpreter (mutant `sh|dash) tool=bash`) and
directory-first lookup (mutant D12, loops swapped) are now pinned. Each of
those mutants, plus C10 (no wrappers listing check), C16 (no top-level listing
check), D6, D14, D14b, D15, D16 and D17, fails the check with an assertion.

Runner hang bound (E6-B item 5, sized the X1c way), measured on the M5 Max on
2026-10-14 with other agents' suites running, with the prescribed command:
- loaded: 23.3 s wall, 19 of 19 passed, at load average 25.1 rising to 36.6
  (24 bounded CPU burners added for 43 s, then stopped);
- ambient: 21.3 s wall, 19 of 19 passed, at load average 11.4 falling to 10.8
  (and 23.2 s at 18.4 falling to 16.7 while the burners' load decayed).
The suite mostly waits on sandboxed processes, so load barely moves it.
The bound is 120 s, at least 1.5 x the worst run (1.5 x 23.3 s is about 35 s);
the margin also covers a burst of X1's lsof sweep stalls (round 1's adversary
saw one failing run take 86 s; X1c owns that fix, E6-X item 5). This is a hang
bound for a deterministic suite, not a test-timeout widening; no test timeout
is changed.

FNXC:CccPlanningProofInventory 2026-10-14-18:37:
Repair 2 (errata E7-B; test-only, no source file changed). The closed check
now holds twenty-three tests: twelve in discovery, eleven in the shim layer.
The four new shim-layer tests pin behaviours a named mutant broke while the
check still passed, and each mutant now fails it with an assertion: N1 (a
nested bash forgets the inherited shim directories; a package script running
`bash -c 'hello'` and a `bash -c` inside a shim-enabled bash both report
"command not found", 127), N11 (`#!/usr/bin/env bash` runs as the clone's
`sh`), N2 (a shim without a shebang runs as `bash`, not `sh`) and, optional
item 4, N7 (a wrappers directory redirected through a symlink is accepted).
The discovery test header's stale "reported as evidence, not asserted" line
is corrected (item 6).

Recorded limits (item 5), none of them a defect:
- inside the sandbox `id -un` fails like the dropped `whoami` ("id: cannot
  find name for user ID 501", exit 1), so only numeric `id` and `id -u` are
  supported;
- `/opt/homebrew` is writable by the operator account, so "Homebrew only" does
  not mean protected; sealing records digests, so a later change fails closed;
- a keg-only `node@NN` not linked into `/opt/homebrew/bin` is not found by
  default (a caller passes its `bin` explicitly);
- an optional tool that `sealCccToolchain` rejects refuses the whole discovery
  (fails closed) instead of being left out;
- inside one directory an unprefixed Homebrew name wins over the `g` name.

Measured with the prescribed command on the M5 Max on 2026-10-14, at ambient
load only (no CPU burners in this round): 23 of 23 passed in 27.8 s (load
8.6 rising to 10.9), 20.2 s (8.5 to 8.6) and 20.6 s (8.6 to 11.4); the 19
tests before this repair took 17.6 s at load 10.1, so the four new tests add
about 3 s of sandboxed execs. The bound stays 120 s, well above 1.5 x the
worst run here (41.7 s). The load-25 run was not repeated for the new tests.

FNXC:CccPlanningProofInventory 2026-10-14-20:52:
Card X1z, successor owner (errata E8-X items 1-3). The closed check now holds
twenty-six tests: fourteen in discovery, twelve in the shim layer. New:
- default search path: `discoverCccToolchain({})` seals the same toolchain
  digest as an explicit default `searchPath` (a stub bash first on PATH is
  ignored), an explicit empty `searchPath` refuses toolchain-missing:bash, and a
  malformed one still throws the TypeError (item 1);
- frozen signature (compiler-checked): the TypeScript compiler accepts `{}`
  with no diagnostic and reports exactly TS2322 for a string `searchPath`
  (item 1, type level);
- the shim layer keeps the raw shell's own `dispose` (item 2).
RED on INT-2d bytes: the first two fail with assertions (the TypeError where
null was expected; TS2344 and TS2345 where no diagnostic was expected). Mutants
that fail the check with an assertion: M1 (an empty searchPath takes the
default), M2 (the default read from PATH), M3 (runtime default with the
signature still requiring searchPath) and X2 (`return { exec } as unknown as
T` in the decorator, run through a scratch vitest config that aliases the
import to a mutated copy; shell-compat.ts itself is unchanged).
The names stay ASCII. Both lists stay names-closed (the card owns both files).

Measured with the prescribed command on the M5 Max on 2026-10-14 at ambient
load (other agents' suites running, no CPU burners): 26 of 26 passed in 24.4 s
(load 11.0 to 10.8), 21.8 s (11.6 to 10.6), 20.1 s (10.6 to 10.1) and 22.4 s
(10.1 to 10.0). In the JSON run the three new tests took 1.4 s (default
search path), 1.7 s (compiler check) and 2.3 s (dispose). The 120 s bound stays,
well above 1.5 x the worst run here (36.6 s); it is a hang bound, and no test
timeout is changed.

FNXC:CccPlanningProofInventory 2026-10-14-21:20:
Card X1z repair 1 (test-only; E6-0: no PATH or user-writable directory is ever
on the default search path). The closed check now holds twenty-seven tests:
fifteen in discovery, twelve in the shim layer. The absent-searchPath test is
renamed: it also plants a randomly named tool only in its PATH directory and
asserts toolchain-missing. New: a tool planted only last on PATH and in
~/.local/bin, ~/go/bin and ~/.cargo/bin under a fixture HOME refuses
toolchain-missing by default and is found in each directory passed explicitly.
Mutants added to the list above, each of which passed all fourteen discovery
tests before this repair (the reviews' runs) and now fails the check with an
assertion (a run against this repair's tests): M2c, also
called m4 (`i.searchPath ?? [...cccToolchainDefaultSearchPath(),
...PATH]`, PATH appended after Homebrew), and m5 (the default plus
$HOME/.local/bin, $HOME/go/bin, $HOME/.cargo/bin and /usr/local/bin). M2 (PATH
first) still fails, now in both tests.

Measured with the prescribed command on the M5 Max on 2026-10-14 at ambient
load (other agents' suites running, no CPU burners): 27 of 27 passed in 26.6 s
(load 13.4 to 12.1), 24.2 s (11.8 to 13.6) and, in the JSON run, 25.6 s
(12.2 to 11.2); there the renamed test took 1.4 s and the new one 0.6 s. The
120 s bound stays, well above 1.5 x the worst run here (39.9 s); it is a hang
bound, and no test timeout is changed.
*/

const DISCOVERY = "CCC toolchain discovery (Darwin)";
const FIXTURE = `${DISCOVERY} > fixture search path`;
const DEFAULT_PATH = `${DISCOVERY} > default search path (this host's Homebrew)`;
const SIGNATURE = `${DISCOVERY} > frozen signature (compiler-checked)`;
const HOST = `${DISCOVERY} > host scan (positive control)`;
const COMPAT = "CCC shell compatibility layer (Darwin sandbox-exec)";

const NAMES = Object.freeze([
  `${FIXTURE} > seals every required tool and every optional tool it finds from the non-platform directory under its unprefixed name, gcat as cat and gawk as awk, skipping the platform binaries in /bin and /usr/bin and a script shim earlier on the path`,
  `${FIXTURE} > seals sh from a non-platform dash when one is found, skipping the platform /bin/dash, and from the non-platform bash otherwise`,
  `${FIXTURE} > refuses a missing required utility as CCC_PLANNING_CONFINEMENT_UNQUALIFIED toolchain-missing:rg, while the same path with rg added seals it`,
  `${FIXTURE} > refuses a role found only as a platform binary or a script shim as toolchain-missing:git, while a non-platform git binary later on the path is sealed`,
  `${FIXTURE} > refuses a missing bash role as toolchain-missing:bash and a missing node role as toolchain-missing:node, skipping the platform /bin/bash, while the same paths with those binaries added seal them`,
  `${FIXTURE} > skips a candidate without execute permission and takes the binary in a later directory, while the same candidate made executable is taken`,
  `${FIXTURE} > seals exactly the required tools plus the four roles when optional is empty, adds each optional tool it finds when optional is left at its default or named, and so seals a path without gawk without awk`,
  `${FIXTURE} > treats GNU grep, sed, findutils, gawk and diffutils as optional by default, so a path without any of them still seals a toolchain without those names, while a missing coreutil still refuses toolchain-missing:dirname`,
  `${FIXTURE} > takes the first directory on the path that holds a usable candidate, and inside one directory the unprefixed name before the g-prefixed one`,
  `${FIXTURE} > rejects a malformed required or optional name with a TypeError before any search, and ignores relative search-path entries, while the absolute entry is searched`,
  `${DEFAULT_PATH} > keeps user-writable directories off the default search path, so a tool found only in a PATH directory such as ~/.local/bin is missing by default and found when the caller passes that directory explicitly`,
  `${DEFAULT_PATH} > defaults an absent searchPath inside the function: discoverCccToolchain({}) seals the same toolchain digest as an explicit default searchPath even with a stub bash first on PATH, a tool found only in that PATH directory refuses toolchain-missing, an explicit empty searchPath is kept and refuses toolchain-missing:bash, and a present but malformed searchPath still throws a TypeError`,
  `${DEFAULT_PATH} > never searches PATH or the user-writable home directories when searchPath is absent: a tool planted only last on PATH and in ~/.local/bin, ~/go/bin and ~/.cargo/bin under the fixture HOME refuses toolchain-missing, while each of those directories passed explicitly finds it`,
  `${SIGNATURE} > type-checks discoverCccToolchain({}) with searchPath optional and a Promise<CccSealedToolchain> result with no diagnostic, while a string searchPath reports exactly TS2322`,
  `${HOST} > discovers the default toolchain on this host from the Homebrew-only default search path, every sealed file under /opt/homebrew, and the sealed cat (from gcat) runs as cat inside X1's sandbox with task, rg and git`,
  `${COMPAT} > every wrapper carries a toolchain shebang and the npm wrapper runs npm inside the sandbox, while the raw shell has no npm`,
  `${COMPAT} > the BASH_ENV dispatcher runs node_modules/.bin shims through the toolchain sh and node and exports npm_config_script_shell, while the raw shell cannot run them`,
  `${COMPAT} > runs a #!/usr/bin/env -S node shim through the toolchain node with the flags its shebang names, while the raw shell cannot run it`,
  `${COMPAT} > runs a #!/usr/bin/env bash shim through the toolchain bash with POSIX mode off, while the raw shell cannot run it`,
  `${COMPAT} > runs a shim without a shebang through the toolchain sh, as execve's ENOEXEC fallback would, while the raw shell cannot run it`,
  `${COMPAT} > npm run starts its script shell from the toolchain bash, which loads the dispatcher and runs a .bin shim, while npm's default sh cannot run the shim`,
  `${COMPAT} > keeps the shim directories in a nested bash, from a package script that runs bash -c and from a bash -c inside a shim-enabled bash, while the raw shell cannot run the shim from either`,
  `${COMPAT} > refuses a shim whose shebang names an interpreter outside the toolchain with a clear message and status 126, while a sh shim in the same directory runs`,
  `${COMPAT} > keeps the dispatcher read-only inside the sandbox and refuses an exec once it changed outside, while the scratch home stays writable and the restored file runs`,
  `${COMPAT} > refuses an exec once an extra file is planted in the shim layer's directory or in its wrappers directory, while the exec runs again once the file is removed`,
  `${COMPAT} > refuses an exec once the wrappers directory is replaced by a symlink to a directory outside the shim layer that holds the same bytes, while the exec runs again once the real directory is back`,
  `${COMPAT} > keeps the raw shell's own dispose on the decorated operations, so disposing through the decorator returns the raw shell's closure result, removes its toolchain clone and makes a later raw exec refuse instance-disposed`,
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
