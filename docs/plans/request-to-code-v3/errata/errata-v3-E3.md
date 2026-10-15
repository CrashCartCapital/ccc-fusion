# CONTRACT-v3 errata E3: refusal-code mapping for E2 items, and W2 notes

Date: 2026-10-14. Binding on top of v3, E1 and E2; E3 wins where it differs. `CCC_PLANNING_REFUSAL_CODES` is a closed list owned by K1, and K1 is in its final repair. So E2 items that named new codes use existing codes, except one, which goes to a new tiny card.

- **E3-1 (E2-3).** For L1's `recordCccPlanningBuildControl` in a state with no `→cancelling` pair, the refusal is `CCC_PLANNING_STATE_TRANSITION_REFUSED`, not `CONTROL_STATE_INVALID`.
- **E3-2 (E2-9).** For L1's claim when a role class does not match its list, the refusal is `CCC_PLANNING_ROUTE_NOT_ADMITTED`, with detail `role-class-mismatch` in the refusal message. It is not `ROLE_CLASS_MISMATCH`.
- **E3-3 (E2-4).** L1's defence-in-depth refusal of an actor over 200 characters is `CCC_PLANNING_INTERNAL_ERROR`, because the CLI refuses first with `usage_error`, so reaching L1 means a caller bug.
- **E3-4 (E2-5).** `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` is a genuinely new terminal code. A new card **K1b (W3, sonnet, cheap review)** owns an additive hunk in `packages/core/src/ccc-planning/errors.ts` that appends it to `CCC_PLANNING_REFUSAL_CODES`, plus its test name in `cards/k1b.mjs` and an update to the K1 contract-equality test, if K1 pins the count. WR and BF depend on K1b.
- **E3-5 Review lanes for this session.** Gemini (agy-bridge) and GPT (codex-mcp-server) are both parked after repeated failures, so the contract's lanes are filled as follows:
  - **normal:** one fresh Opus reviewer, since agy-bridge is unavailable;
  - **critical:** a fresh Opus reviewer, plus a fresh Opus adversarial reviewer with no shared context, plus the parent rerunning the check at integration.
- **E3-6 (W2 base).** W2 leaves branch from INT-1 `a426a4377`. That commit holds round-2 bytes for K1, S0 and X1. Their final repairs:
  - change no exported signature W2 consumes;
  - add K1 path-key folding and validator strictness;
  - change S0's FK deferrability, guard trigger name, deadline CHECK and audit metadata normalization;
  - add X1 exports.

  A W2 test must not depend on the round-2 behaviour of any of those, for example a 0042 trigger name or an un-folded path key.
