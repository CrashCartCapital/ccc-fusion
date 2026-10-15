/*
FNXC:CccPlanningProofInventory 2026-10-14-20:20:
Proof inventory for request-to-code v3 card IP (installed runtime and serve lane; CONTRACT-v3.3 section 3.2 IP). One module per card keeps the inventory files disjoint; `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order.

Three node:test files prove the offline half: `ccc-planning-installed-runtime.test.mjs` (digest, pi-ai patch/shipping/keepalive-source derivation, receipt capture and verification, the shared pack and install helpers, the entry script), `ccc-planning-serve-lane.test.mjs` (log liveness verdicts, the sealed `env -i` launch, owned PostgreSQL, start and stop through a fake Pueue) and `ccc-gate2-installed-runtime.test.mjs` (the Gate 2 regression guard on the extraction). They need no network, no PostgreSQL, no real Pueue and no real `fn serve`, so they are `platform: "any"` and also run in the ci-linux lane. TARGETED lists them file-closed; OFFLINE lists the same files name-closed (63 names, the closed names the node:test reporter in `scripts/lib/ccc-closed-vitest-results.mjs` emits: ancestor titles and the title joined with " > "). The Gate 2 file keeps its 7 pre-existing tests and gains 2.

Measured on the M5 Max (18 cores) with a load average of about 8.5 from other sessions: the three files run in 10.2 s (63 tests). The 120 s command timeout is a hang bound, not a measurement.

`ccc-planning-installed-keepalive.test.mjs` is the installed lane, PARENT-RUN: it builds the CLI package, packs it, and `npm install`s the tarball with `--ignore-scripts` into a scratch root. It is `platform: "darwin"` (so ci-linux never selects it) and lives in TARGETED only: the offline network guard (D50) refuses the public-registry fallback that a cold npm cache needs, so it cannot belong to the offline proof. Its four names are derived from the file text, not from a run, because the card could not run it: the offline npm cache lacks the CLI's dependencies (ENOTCACHED) and the card may not fetch. The section 4.2 step 0 duration is therefore NOT measured; 3,600,000 ms is the largest timeout the inventory admits and is only a hang bound, and the file's own set-up hook gives up first, at 3,000,000 ms.
*/

const OFFLINE_FILES = Object.freeze([
  "scripts/__tests__/ccc-planning-installed-runtime.test.mjs",
  "scripts/__tests__/ccc-planning-serve-lane.test.mjs",
  "scripts/__tests__/ccc-gate2-installed-runtime.test.mjs",
]);

const INSTALLED_LANE_FILE = "scripts/__tests__/ccc-planning-installed-keepalive.test.mjs";

const OFFLINE_NAMES = Object.freeze([
  "installed dist manifest digest > is stable for the same bytes and changes when one byte of one dist file changes",
  "installed dist manifest digest > hashes the sorted relative path and file digest pairs of every nested js file and ignores other extensions",
  "installed dist manifest digest > refuses a missing dist root and a dist root that holds no js file",
  "installed dist manifest digest: links > refuses a symbolic link inside dist, because a linked js file would be read through or skipped silently",
  "pi-ai workspace patch status from installed bytes > classifies an unpatched file as not_carried and a file holding the identitySubstantive marker as carried",
  "pi-ai workspace patch status from installed bytes > uses the marker the checked-in patch adds, so a changed patch cannot leave this check behind",
  "pi-ai shipping from the packed manifest and the tsup rule > is external only for an exactly pinned runtime dependency that no noExternal rule matches",
  "pi-ai shipping from the packed manifest and the tsup rule > reads the real CLI manifest and tsup config as external, and flips when the rule would bundle pi-ai",
  "pi-ai shipping from the packed manifest and the tsup rule > refuses a tsup config whose noExternal rule it cannot read",
  "installed runtime receipt capture > captures the exact key set with piAi shipping, workspacePatch and keepaliveModelSource",
  "installed runtime receipt capture > records workspacePatch carried only when the installed pi-ai file holds the marker",
  "installed runtime receipt capture > refuses to capture when pi-ai is not a pinned dependency of the packed manifest",
  "installed runtime receipt capture > refuses to capture when the installed receipt adapter is missing or bundles pi-ai instead of importing it",
  "installed runtime receipt capture > refuses to capture when the installed pi-ai is not the pinned version",
  "installed runtime receipt capture > refuses to capture when the installed fn has no plan command, and records the observed codes when it has",
  "installed runtime receipt verification > accepts the untouched install and returns the receipt it checked",
  "installed runtime receipt verification > detects a one-byte change in one installed dist file and names distManifestSha256",
  "installed runtime receipt verification > detects a changed fn executable, a changed tarball and a changed version output, each by field name",
  "installed runtime receipt verification > refuses a receipt without piAi.keepaliveModelSource, with another value, or without the piAi block",
  "installed runtime receipt verification > refuses shipping that is not derived from the packed manifest",
  "installed runtime receipt verification > refuses a workspacePatch claim that disagrees with the installed pi-ai bytes",
  "installed runtime receipt verification > refuses an unknown key, a missing key, a wrong schema and text that is not JSON",
  "prepare refuses before building and captures provenance first > refuses a tracked-dirty source tree before the pack and install step runs",
  "prepare refuses before building and captures provenance first > reads the git status, head and tree and the toolchain before the build and hands them to the capture",
  "shared installed CLI helpers > passes only the allowlisted names plus the isolated home to the child, never a credential or PORT",
  "shared installed CLI helpers > refuses extra environment names that are credentials, PORT, preload hooks or the isolation variables, and accepts the names it is meant for",
  "shared installed CLI helpers > returns every JSON stdout line with the exit code and refuses a line that is not JSON",
  "shared installed CLI helpers > stops a child that outlives its timeout and reports the timeout",
  "pack and install sequence > builds, packs, restores the manifest and installs with the default arguments and the default layout",
  "pack and install sequence > refuses a root that is not empty before running any step",
  "pack and install sequence > offline mode passes --offline and never goes online; offline-first retries online only after ENOTCACHED",
  "planning install entry script > exits 2 with a usage line for no argument and for two arguments",
  "planning install entry script > refuses a non-empty install directory before any pnpm or npm step runs",
  "serve log liveness > accepts a clean log with one bound line and one listening banner and returns the port",
  "serve log liveness > gives CCC_PLANNING_SERVE_NOT_BOUND for an empty log, a bound line for another project, a missing banner and a non-loopback banner",
  "serve log liveness > gives CCC_PLANNING_SERVE_AUTO_REGISTERED when an Auto-registered line is present, even beside a clean bound line",
  "serve log liveness > gives CCC_PLANNING_SERVE_PORT_FORBIDDEN for a 4040 binding and accepts the neighbouring ports",
  "serve log liveness > gives CCC_PLANNING_SERVE_MULTIPLE_BINDINGS for two bound lines and for two banners",
  "serve log liveness > reads the child pid the launch script prints before it execs, and nothing else",
  "serve launch builder > puts env -i, PI_OFFLINE=1, --port 0, --host 127.0.0.1 and --no-auto-register in the Pueue payload, with the target as cwd and no PORT=",
  "serve launch builder > refuses a relative path, an unsafe group or label, a project id with shell characters, and a database url that is shared, remote or carries a password",
  "serve launch builder > executes through sh with a sealed environment: the fake fn sees the exact argv, the target as cwd, the isolated home and none of the parent's canaries",
  "owned PostgreSQL > runs initdb, pg_ctl start and createdb with loopback-only arguments on a free port that is neither 5432 nor 4040, then stops once",
  "owned PostgreSQL > refuses a picked port of 5432 or 4040 before running anything, and a data directory that already holds files",
  "owned PostgreSQL > really executes the binaries it is given when no run function is injected",
  "serve lane start and stop through a fake Pueue > creates the group when absent, caps it to one task, adds the task, reads the bound port and checks the listener belongs to the pid",
  "serve lane start and stop through a fake Pueue > leaves an existing group alone and keeps polling until the bound line and banner appear",
  "serve lane start and stop through a fake Pueue > hands Pueue a scrubbed client environment, so no credential is stored in the task",
  "serve lane start and stop through a fake Pueue > kills only its own task and throws the coded error for an Auto-registered line, a 4040 binding and a doubled binding",
  "serve lane start and stop through a fake Pueue > refuses a listener that is not the announced port, and kills the task",
  "serve lane start and stop through a fake Pueue > times out with CCC_PLANNING_SERVE_NOT_BOUND and kills the task, and reports a task that ended early",
  "serve lane start and stop through a fake Pueue > refuses an existing group that is paused before adding any task, and re-caps an existing group that is not at one task",
  "serve lane start and stop through a fake Pueue > stops by killing only the named task, then confirms no process of its group remains",
  "serve lane start and stop through a fake Pueue > refuses with CCC_PLANNING_SERVE_DESCENDANTS_REMAIN when a process of the group survives, and sends no second signal",
  "PRD:GATE2-05 installed runtime receipt binds the CLI, controller, and scheduler host",
  "PRD:GATE2-07 installed PRD controls execute through the receipt-bound fn executable",
  "PRD:GATE2-08 installed PRD controls execute through the exact receipt-bound controller module",
  "PRD:GATE2-08 installed PRD controller runs with isolated installed-runtime environment",
  "PRD:GATE2-09 loads only the exact receipt-bound installed scheduler host",
  "PRD:GATE2-09 package build owns the Gate 2 runtime host in CLI source",
  "PRD:GATE2-09 failed installed-runtime pack restores the CLI package manifest",
  "PRD:GATE2-10 the pack, restore and install sequence lives in the shared installed-cli module",
  "PRD:GATE2-10 a successful prepare returns the Gate 2 receipt through the shared sequence with the unchanged npm arguments",
]);

const INSTALLED_LANE_NAMES = Object.freeze([
  "installed keepalive model rule > arm A: the packed receipt adapter reports the true model although the keepalive chunks carry a placeholder",
  "installed keepalive model rule > arm B: the installed pi-ai stream agrees with the bytes of its own file, so workspacePatch is written from what it did",
  "installed keepalive model rule > the packed dist ships the adapter entry and selects it by name for bound routes",
  "installed keepalive model rule > the installed pi-ai ships external, pinned at 0.81.1, with the adapter named as the keepalive source",
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "ip-installed-runtime-scripts",
    packageFilter: "node-test",
    project: null,
    config: null,
    files: OFFLINE_FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: "ip-installed-keepalive",
    packageFilter: "node-test",
    project: null,
    config: null,
    files: Object.freeze([INSTALLED_LANE_FILE]),
    closure: "names",
    expectedNames: INSTALLED_LANE_NAMES,
    platform: "darwin",
    needsPostgres: false,
    timeoutMs: 3_600_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "ip-installed-runtime-scripts-names",
    packageFilter: "node-test",
    project: null,
    config: null,
    files: OFFLINE_FILES,
    closure: "names",
    expectedNames: OFFLINE_NAMES,
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);
