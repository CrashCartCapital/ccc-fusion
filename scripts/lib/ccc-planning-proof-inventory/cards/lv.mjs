/*
FNXC:CccPlanningProofInventory 2026-10-15-01:45:
Proof inventory for request-to-code v3 card LV (the live and installed proof scripts; CONTRACT-v3.5 section 2.20, section 4.2 step 5, section 4.5; errata E9 rulings 2 and 4). One module per card keeps the inventory files disjoint; `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order.

One node:test file proves the offline half: `scripts/__tests__/ccc-planning-live-proof.test.mjs`. It drives both scripts against a fake installed `fn` and a fake Pueue, lsof and pgrep written into a temp directory, so nothing spawns the real fn, a real serve, a provider or the network and nothing binds or probes port 4040. It proves the missing-digest refusal before any spawn, the typed digest reaching `fn plan start` byte for byte and the downstream UNCONFIRMED refusal coming back unchanged, the file-system and narrowed crypto spies (the script never writes, confirms or hashes an authority receipt), the adaptive and lean refusals, the installed proof exiting 1 with its NOT RUN list, the drift and keepalive-source refusals, the `notEnforced` report, the keepalive arm reported NOT RUN and never passed, and a positive control; eleven mutants (copies of the real scripts with one edit each) prove the spies and assertions are not vacuous.

TARGETED is file-closed. OFFLINE is names-closed over the same file with the exact names below (ancestor titles joined with " > ", the join the closure uses). Both run under packageFilter "node-test" with no config and no project, platform "any" and needsPostgres false: the file reads no PostgreSQL URL and names no skip flag.

Measured on the M5 Max (18 cores) at a load average of 9 to 12 from other sessions, with the child environment the runner builds (offline guard preloaded, `PI_OFFLINE=1`, `FUSION_PG_TEST_SKIP=1`) and the closed-results reporter: the file runs in 31.3 to 31.8 s wall over three runs (36 tests; about 21 s user, 5 s sys), and the offline guard wrote no report, so the tests made no non-loopback attempt. Most of the time is the dist-digest recomputation and the fake installed-fn and fake Pueue processes that each live run spawns. `timeoutMs` 180000 is a hang bound about 5.7 times the slowest measurement; no test timeout was widened and no retry exists.

The installed keepalive lane (`scripts/__tests__/ccc-planning-installed-keepalive.test.mjs`) is NOT in this inventory (errata E9 ruling 2): it builds and packs the CLI and installs the tarball, so the parent runs it as step 0 of the live proof. The fn-path keepalive arm (E9 ruling 4) is reported NOT RUN by the live script, with its reason, until a session factory (card SF) is integrated; the test file proves it is never reported as passed.
*/

const FILES = Object.freeze(["scripts/__tests__/ccc-planning-live-proof.test.mjs"]);

const REFUSALS = "live proof refusals before any spawn";
const DIGEST = "live proof typed digest";
const CUSTODY = "live proof authority receipt custody";
const MUTANTS = "live proof mutants for the profile, the candidate and teardown";
const SEQUENCE = "live proof sequence poll and teardown";
const ARM = "live proof fn-path keepalive arm";
const REPORT = "live proof report";
const INSTALLED = "installed proof";
const ENTRY = "proof script entry points";
const INVENTORY = "proof inventory and the installed keepalive lane";

const NAMES = Object.freeze([
  `${REFUSALS} > without --confirm-authority exits 1 with CCC_PLANNING_AUTHORITY_CONFIRMATION_REQUIRED before any spawn, write or Pueue call; the twin with a typed digest runs`,
  `${REFUSALS} > a flag with no value, an empty value, an empty = value, a flag followed by another flag and no arguments at all are all a missing digest`,
  `${REFUSALS} > --profile adaptive and --profile lean exit 1 with CCC_PLANNING_PROFILE_NOT_IMPLEMENTED before any spawn, with or without a digest; full runs; a missing or unknown profile is a usage error`,
  `${REFUSALS} > usage errors exit 2: unknown flag, duplicate flag, stray argument, missing required value, a candidate outside <ROOT>/evidence; one leading -- is dropped`,
  `${REFUSALS} > a candidate with a one-byte dist drift is refused by a real recomputation that the narrowed hash spy allows; the untouched twin verifies`,
  `${REFUSALS} > a candidate whose keepaliveModelSource is not fusion-receipt-adapter is refused; the untouched twin verifies`,
  `${REFUSALS} > refuses when the approval receipt, the request or the target is missing, or a report already exists, before any serve call; the twin runs`,
  `${REFUSALS} > a serve lane refusal is reported with the lane's code before fn plan start is ever called; the lane stops its own task`,
  `${REFUSALS} > a database url that is shared or carries a password is refused before anything starts, through the serve lane's own builder`,
  `${DIGEST} > a wrong digest reaches fn plan start byte for byte, the downstream UNCONFIRMED refusal is reported unchanged, and serve is stopped`,
  `${DIGEST} > awkward typed bytes (case, spaces, a tab, non-ASCII) reach fn unchanged, so nothing trims, folds or validates them`,
  `${DIGEST} > positive control: a correct receipt and digest pass through to the fake fn, which returns run_admitted, and the run is polled to accepted with serve stopped`,
  `${CUSTODY} > never writes, confirms or hashes an authority receipt: only the report is written, the receipt bytes are unchanged, and the narrowed hash spy sees real hashing but no match`,
  `${CUSTODY} > the hash and file-system spies have teeth: they match the receipt bytes, its digest preimage and a chunked hash of it, record writes, and ignore other hashing`,
  `${CUSTODY} > mutants: a script that helpfully hashes the receipt (file bytes or digest preimage) to fill in the digest, and one that rewrites the receipt, fail the custody property`,
  `${CUSTODY} > mutants: a script that trims and folds the typed digest fails the byte-for-byte property, and one that spawns before it checks the digest fails the missing-digest property`,
  `${MUTANTS} > a script that accepts adaptive, one that skips candidate verification and one that never stops serve each fail their property`,
  `${SEQUENCE} > stops polling on every operator-wait state and leaves serve running; the report says so and names the Pueue task`,
  `${SEQUENCE} > verification_failed and the terminal states fail the proof with CCC_PLANNING_LIVE_RUN_NOT_ACCEPTED and stop serve; accepted is the only pass`,
  `${SEQUENCE} > a poll past the run deadline plus its margin fails with CCC_PLANNING_LIVE_POLL_DEADLINE and stops serve; an unknown state is invalid output`,
  `${SEQUENCE} > an abort while polling stops the poll and serve with CCC_PLANNING_LIVE_ABORTED`,
  `${SEQUENCE} > fn plan start output that is not exactly one run_admitted line, or that names another node count, fails and stops serve`,
  `${SEQUENCE} > a serve task that cannot be stopped cleanly fails the proof with CCC_PLANNING_SERVE_DESCENDANTS_REMAIN and records the teardown error`,
  `${ARM} > is reported NOT RUN with the reason when no installed fn command drives it, never passed, and is listed in notRun`,
  `${ARM} > a driver that reports the true model passes the arm; it runs before serve starts and before fn plan start, and the arm leaves notRun`,
  `${ARM} > a driver that reports the placeholder, another provider, another adapter, missing evidence or an error fails the arm before anything starts`,
  `${ARM} > a script that trusts the driver instead of judging its observations fails the property`,
  `${REPORT} > lists notEnforced (D52) and the declared NOT RUN items of section 4.5, on a pass and on a refusal alike; a script that drops notEnforced fails`,
  `${REPORT} > the state sets are pinned to packages/core/src/ccc-planning/types.ts, so a state added there cannot make the poll hang`,
  `${INSTALLED} > always exits 1 and lists every NOT RUN item, including the fn-path keepalive arm, with no arguments and with a perfect candidate`,
  `${INSTALLED} > refuses a drifted candidate and a candidate with another keepalive source, and still lists every NOT RUN item; usage errors exit 2`,
  `${INSTALLED} > a script that exits 0 for a verified candidate fails the property that it always exits 1`,
  `${ENTRY} > node scripts/ccc-planning-live-proof.mjs runs end to end against the fake fn and fake Pueue: one report on stdout and in the file, progress on stderr, exit 0, serve stopped`,
  `${ENTRY} > the entry point refuses without --confirm-authority (exit 1, nothing on stdout, one refusal line on stderr) and exits 2 on a usage error`,
  `${ENTRY} > node scripts/ccc-planning-installed-proof.mjs exits 1 with one stderr line, an empty stdout and its NOT RUN list for any arguments`,
  `${INVENTORY} > the installed keepalive lane is parent-run and sits in no inventory card (E9 ruling 2); this file is listed file-closed and name-closed by cards/lv.mjs`,
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "lv-live-proof-scripts",
    packageFilter: "node-test",
    project: null,
    config: null,
    files: FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 180_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "lv-live-proof-scripts-names",
    packageFilter: "node-test",
    project: null,
    config: null,
    files: FILES,
    closure: "names",
    expectedNames: NAMES,
    platform: "any",
    needsPostgres: false,
    timeoutMs: 180_000,
  }),
]);
