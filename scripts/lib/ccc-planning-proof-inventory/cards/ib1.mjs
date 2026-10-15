/*
FNXC:CccPlanningProof 2026-10-14-21:07:
Proof inventory for request-to-code v3 card IB1 (packet and truthful proposal; contract 2.17, ADR B Q2, test T2.5). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

The card owns one engine test file, so the same file appears twice under two ids. TARGETED is file-closed: every test the file holds must pass, so a new test is covered without touching this module. OFFLINE is name-closed: the names below are exactly the file's tests, built the way `assertionName` in `scripts/lib/ccc-closed-vitest-results.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. Both are pinned to `engine-default`, whose aliases point @fusion/core at source, so no build runs and nothing needs PostgreSQL (`needsPostgres` false, errata E1-1).

Measured on the M5 Max under a load average near 10 (parallel agents) after repair 1 (errata E9): 3.0 s wall from the pnpm command to exit, 2.0 s vitest duration for 28 tests, including transform and import. Repair 1 adds assertions inside existing tests and no test, so the 28 names below are unchanged. The command timeout is a hang bound over that measurement; no test timeout is raised anywhere.
*/

const TEST_FILE = "src/__tests__/ccc-planning-proposal.test.ts";

const PACKET = "ccc planning packet sources";
const AUTHORSHIP = "ccc planning truthful authorship";
const PROPOSAL = "ccc planning authoring proposal";

const COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([TEST_FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "ib1-proposal", ...COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "ib1-proposal-names",
    ...COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${PACKET} > renders the admission facts with the labels the implementation-fact binder reads`,
      `${PACKET} > renders the final PRD in the acceptance grammar and keeps the target path, baseline and bounds out of it`,
      `${PACKET} > renders one proof block per verifier proof and one non-goal line per map non-goal`,
      `${PACKET} > renders the technical annex with a decision id and the custody lines of every task`,
      `${PACKET} > renders identical bytes twice and different bytes when one input changes`,
      `${PACKET} > refuses admission facts the binder could not read back, each next to the passing twin`,
      `${PACKET} > refuses a requirement id the acceptance grammar cannot carry; the twin with a canonical id renders`,
      `${PACKET} > writes the four sources as a packet that custody reads back with their paths, roles and hashes`,
      `${PACKET} > refuses to write the same run revision twice and accepts the next revision`,
      `${AUTHORSHIP} > names the adapter after the full-v2 profile, the run and the revision`,
      `${AUTHORSHIP} > labels the model from the producer envelopes: unflipped envelopes give glm/glm-5.3`,
      `${AUTHORSHIP} > changes the model label to glm/glm-5.3+minimax/MiniMax-M3 when one envelope resolved model is flipped to M3, and leaves the id alone`,
      `${AUTHORSHIP} > labels the sorted unique set of resolved models whatever the order or the repeats`,
      `${AUTHORSHIP} > refuses producers that cannot support a truthful label, each next to a passing twin`,
      `${AUTHORSHIP} > builds a receipt with the proposal hash and one role row per producer in role order`,
      `${AUTHORSHIP} > refuses a proposal hash that differs from the authorship receipt, and accepts the matching one`,
      `${AUTHORSHIP} > refuses sidecar labels the receipt roles do not derive, next to a passing twin`,
      `${PROPOSAL} > is accepted by authorCccPrdPacket and the sidecar carries the derived provenance`,
      `${PROPOSAL} > attributes each requirement by source path: request-derived clauses cite the request, annex-derived clauses cite the annex`,
      `${PROPOSAL} > gives every task its own custody paths in its annex evidence and nothing outside the packet`,
      `${PROPOSAL} > gives each proof the verifier closure from the bundle, the task and final phases, and controller placeholders`,
      `${PROPOSAL} > admits a proof that two tasks share for the final phase only`,
      `${PROPOSAL} > is deterministic and its hash follows the plan`,
      `${PROPOSAL} > refuses plans and sources the converter cannot quote exactly, each next to a passing twin`,
      `${PROPOSAL} > compiles with no finding except the proof admission that only the controller's toolchain can supply`,
      `${PROPOSAL} > collapses model whitespace to one line, in the PRD and in the proposal alike`,
      `${PROPOSAL} > leaves no heading of the authored packet without an owner, which is why the admission facts carry no heading`,
      `${PROPOSAL} > writes the request into the packet untouched, so a changed request byte changes the packet hash`,
    ]),
  }),
]);
