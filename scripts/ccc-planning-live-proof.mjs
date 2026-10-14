#!/usr/bin/env node
/*
FNXC:CccPlanningProof 2026-10-14-08:10:
`pnpm verify:ccc-planning-live` is a placeholder until the live-proof card (LV) replaces this file. It must never look like proof: it prints one JSON line naming the refusal and exits 1 for every argument list, including a valid one. The contract (CONTRACT-v2 section 2.20, PRD section 14) says the live command requires `--confirm-authority <digest>` typed by Ryan and never computes, reads back or writes that digest, so this stub does not look at its arguments at all.
*/

const refusal = {
  schema: "ccc-planning.proof-refusal.v1",
  command: "verify:ccc-planning-live",
  passed: false,
  code: "CCC_PLANNING_PROOF_NOT_IMPLEMENTED",
  detail: "The live planning proof is not implemented yet; this command proves nothing.",
};

process.stderr.write(`${JSON.stringify(refusal)}\n`);
process.exitCode = 1;
