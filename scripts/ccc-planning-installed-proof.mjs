#!/usr/bin/env node
/*
FNXC:CccPlanningProof 2026-10-14-08:10:
`pnpm verify:ccc-planning-installed` is a placeholder until the installed-proof card (IP) replaces this file. PRD section 14 says partial proof fails and CONTRACT-v2 section 2.20 says the installed command always exits 1 before I6, so this stub refuses for every argument list and names what it did not run.
*/

const refusal = {
  schema: "ccc-planning.proof-refusal.v1",
  command: "verify:ccc-planning-installed",
  passed: false,
  code: "CCC_PLANNING_PROOF_NOT_IMPLEMENTED",
  detail: "The installed planning proof is not implemented yet; this command proves nothing.",
  notRun: [
    "neutral-directory CLI journeys",
    "neutral-directory dashboard journeys",
    "twelve-criterion release matrix",
    "held-out results",
  ],
};

process.stderr.write(`${JSON.stringify(refusal)}\n`);
process.exitCode = 1;
