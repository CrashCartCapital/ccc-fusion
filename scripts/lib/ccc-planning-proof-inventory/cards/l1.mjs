/*
FNXC:CccPlanningProof 2026-10-14-14:18:
Proof inventory for request-to-code v3 card L1 (planning ledger, operator control, cancellation and retention:
CONTRACT-v3 section 2.11, D4, D5, D10, D13, D32, D39, D45, errata E2-3/E3-1, E2-4/E3-3, E2-9/E3-2). One module per
card keeps the inventory files disjoint; `index.mjs` loads `cards/*.mjs` in sorted order and rejects duplicate ids.

TARGETED is file-closed over the four files of the card's check command. OFFLINE is name-closed over the same four
files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds
them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command.
Every file declares `pgDescribe` blocks, so every entry needs PostgreSQL (`needsPostgres`, errata E1-1).

Measured on the M5 Max under parallel-agent load: 11 to 16 s wall for the four files (37 tests). The command timeouts
are hang bounds over that measurement; no test timeout is raised anywhere.

FNXC:CccPlanningProof 2026-10-14-17:46:
Repair 1 (errata E5-L1) renames the split test and adds 13 tests (items 3 to 12 and 14), so the name list is 50 names,
exactly the passing names of the card command. Measured again on the same host at load average 32.8 (1 min): 7 to 8 s
wall for the four files. The 180 s timeouts stay hang bounds.
*/

const CHECK_FILES = Object.freeze([
  "src/__tests__/postgres/ccc-planning-ledger.pg.test.ts",
  "src/__tests__/postgres/ccc-planning-control.pg.test.ts",
  "src/__tests__/postgres/ccc-planning-retention.pg.test.ts",
  "src/__tests__/postgres/ccc-planning-transition-parity.pg.test.ts",
]);

const LEDGER = "ccc planning ledger (card L1, PostgreSQL)";
const CONTROL = "ccc planning control (card L1, PostgreSQL)";
const RETENTION = "ccc planning retention exclusion (card L1, PostgreSQL)";
const PARITY = "ccc planning transition parity (card L1, PostgreSQL)";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "l1-planning-ledger-control",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: CHECK_FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 180_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "l1-planning-ledger-control-names",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: CHECK_FILES,
    closure: "names",
    expectedNames: Object.freeze([
      `${LEDGER} > admits pi-stream:11 in one turn key and refuses pi-stream:12 with iteration-cap`,
      `${LEDGER} > admits three turn keys in a fresh lineage and refuses the 4th distinct turn key with dispatch-cap`,
      `${LEDGER} > a split child inheriting 2 attempts has its 2nd attempt refused; a sibling split before any attempt admits it`,
      `${LEDGER} > a repair lineage claimed after the author used 2 attempts inherits 2 and its 2nd attempt is refused`,
      `${LEDGER} > refuses a chunk with DISPATCH_CAP when a repair author has no attempt left and writes nothing; another author is admitted`,
      `${LEDGER} > re-reviews open review nodes with 0 inherited attempts (rv1, rv2) and a 5th chunk is REPAIR_EXHAUSTED`,
      `${LEDGER} > refuses a reReviewers entry that is not reviewer-class with ROUTE_NOT_ADMITTED role-class-mismatch; a critic is admitted`,
      `${LEDGER} > refuses a repairAuthors entry that is not author-class with ROUTE_NOT_ADMITTED role-class-mismatch; an author is admitted`,
      `${LEDGER} > refuses a claim after the repair epoch is closed with REPAIR_EPOCH_CLOSED`,
      `${LEDGER} > refuses a preflight attempt's 4th call and a fresh preflight turn key admits 3 more`,
      `${LEDGER} > dispatched_unknown in lineage L blocks L while lineage M proceeds`,
      `${LEDGER} > a proved-not-dispatched call keeps its spend and unblocks the lineage`,
      `${LEDGER} > two connections racing at spent = allocation - 1 admit exactly one`,
      `${LEDGER} > a route-drift settlement records refused_known_effect, keeps the spend, blocks the run in the same tx and replays as a no-op`,
      `${LEDGER} > a provider error event settles failed_known_effect and leaves the run running`,
      `${LEDGER} > charges a review_proof call under the campaign fence and refuses a planning fence or another import's fence`,
      `${LEDGER} > calls the linked-outcome port exactly once before reading a linked run and never for an unlinked one`,
      `${LEDGER} > two stagnant review epochs in a row give stop: true; an improving epoch resets the count`,
      `${LEDGER} > grants one research fetch at a time and charges the settled raw bytes`,
      `${LEDGER} > refuses an unclaimed repair lineage, an unclaimed review node and a lineage outside its stage; claimed lineages are admitted (ADV-1)`,
      `${LEDGER} > refuses a repair lineage above CCC_PLANNING_MAX_REPAIR_CHUNKS even with a lineage:created event; the highest allowed ordinal is admitted`,
      `${LEDGER} > after a repair chunk claims lineages for a role, earlier lineages of that role take no new turn key (ADV-9)`,
      `${LEDGER} > refuses a repair chunk with UNRECONCILED_DISPATCH while an earlier lineage of the role is dispatched_unknown and writes nothing (ADV-8)`,
      `${LEDGER} > refuses a settlement whose refusal reason is outside the union with INTERNAL_ERROR and writes nothing (ADV-2)`,
      `${LEDGER} > an earlier epoch's digest redelivered after a later epoch is a replay that records nothing (ADV-5)`,
      `${LEDGER} > refuses an audit id over 256 characters or a malformed digest with INTERNAL_ERROR before any write; bounded values are admitted`,
      `${CONTROL} > pause while running sets control_request and the next dispatch is refused control-pending; an unpaused run admits`,
      `${CONTROL} > answering the awaited decision moves the run to running and the held work item to runnable in one transaction`,
      `${CONTROL} > resume from paused moves the run to running and the held work item to runnable; resume of a running run is refused`,
      `${CONTROL} > cancel from awaiting_intent with no live holder ends cancelled with the work item cancelled`,
      `${CONTROL} > cancel with a live lease holder stops at cancelling; completion runs once the lease has expired`,
      `${CONTROL} > refuses planning control on a linked run with CONTROL_REQUIRES_CAMPAIGN_BRIDGE; an unlinked run accepts the same pause`,
      `${CONTROL} > in importing refuses pause with COMMAND_NOT_SUPPORTED and accepts cancel only before the intent is recorded`,
      `${CONTROL} > build control in building refuses pause and resume without a write; cancel sets control_request and stops review spend`,
      `${CONTROL} > build cancel works from every linked non-building state with a ->cancelling pair (E2-3, E3-1)`,
      `${CONTROL} > refuses build cancel in a linked state without a ->cancelling pair with STATE_TRANSITION_REFUSED and writes nothing`,
      `${CONTROL} > refuses build control on a run that was never linked with INTERNAL_ERROR`,
      `${CONTROL} > refuses an actor over 200 characters or blank with INTERNAL_ERROR before any write; 200 characters are stored unchanged`,
      `${CONTROL} > resolves the run's project and refuses RUN_NOT_FOUND, RUN_AMBIGUOUS and RUN_PROJECT_MISMATCH`,
      `${CONTROL} > returns the custody of a planning task and null for an ordinary task`,
      `${CONTROL} > transitions by CAS on from, derives the awaited decision id, and clears a pending control on pause`,
      `${CONTROL} > refuses spec_ready -> importing with CONTROL_PENDING while a pause is pending; -> paused still moves and an unpaused twin imports (ADV-12)`,
      `${CONTROL} > refuses a transition with CONTROL_PENDING when the pause commits after the caller's read (ADV-11)`,
      `${CONTROL} > a caller-supplied now in the future does not complete a cancellation while the lease is live by the database clock`,
      `${CONTROL} > refuses the generic cancelling -> cancelled with STATE_TRANSITION_REFUSED even after the lease expires; completion ends the run (ADV-10)`,
      `${CONTROL} > a cancellation with an unsettled call stays cancelling with DESCENDANTS_UNSETTLED recorded and completes once the call is settled`,
      `${CONTROL} > resolves a run of another project through the runtime role with row-level security live (E5-L1 item 14)`,
      `${RETENTION} > keeps an old ccc-plan: audit row and deletes an equally old non-planning row on the same task`,
      `${PARITY} > K1 and the SQL function agree on all 400 pairs, and exactly 65 non-identity pairs are allowed`,
      `${PARITY} > refuses a pair outside the table before any write and applies an allowed pair with a state event`,
    ]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 180_000,
  }),
]);
