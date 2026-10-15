# Errata E10: leader rulings on the CONTRACT-v3.5 check (AMEND)

Date: 2026-10-14. The contract in force is CONTRACT-v3.5.md with E9 and E10 applied. Precedence: E10 > E9 > v3.5.

The independent check of v3.5 returned AMEND: one blocking finding (B-1) and six non-blocking (N-1 to N-6). All seven are adopted as the checker wrote them, with the notes below.

- **B-1 (adopted).** The `@fusion/core` import rule applies to engine and CLI cards only, such as C2, H1 and every later engine or CLI card. Core cards (AD1, L1z and later core cards) import core store operations relatively:
  - from `task-store/`: `./ccc-planning-ops.js` and `./ccc-planning-artifact-ops.js`;
  - from core tests: `../../task-store/...`.

  The INT-3 barrel line for `ccc-planning-admission-ops.ts` stays. AD1 at 043863f98 already imports relatively, so it needs no change.
- **N-1 (adopted).** WR's shape-equality type test must be compiled. Either it runs the TypeScript compiler over its own file, as `ccc-provider-seam.typecheck.test.ts` does, or the assertion lives in a non-test engine source file that WR owns. A plain `expectTypeOf` in a vitest file proves nothing, because the engine tsconfig excludes `__tests__`.
- **N-2 (adopted).** X1z's type pin belongs where a compiler checks it: in `toolchain-discovery.ts` (for example `const _acceptsEmpty: Parameters<typeof discoverCccToolchain>[0] = {};`) or in a compiler-run test. The Non-vacuous line becomes: "the RED fails on INT-2d bytes with the TypeError thrown by the searchPath check (toolchain-discovery.ts:218-219), and the type pin fails to compile while the input type requires searchPath (:214)". X1z's post-repair reviewers judge this; if the pin is in a vitest file, that is a repair-2 item.
- **N-3 (adopted, narrower gate).** No W6 card that has not yet been dispatched starts before P1z is accepted, since no live call runs before W6. BF also waits for L1z (E8-0 B-1). RP, IP and B3 were dispatched early from INT-2c and run offline only. In the W3 base line, "P1z and L1z are accepted before W6" becomes "P1z before W6, L1z before BF".
- **N-4 (adopted).** `transitionCccPlanningRunStateWithin` takes `projectId` as a required input, because the within form has no data layer to locate the run (the same reason as `completeCccPlanningCancellationWithin`). "L1z reports which" is struck.
- **N-5 (adopted).** IB2 builds exactly one G8 identity. Its taskId is the campaign's final-judge task, whose planning lineage is `judge:final`. IB2 builds no G8 identity whose taskId is a writer task or a G7 review task.
- **N-6 (adopted).** Risk 56 is split:
  - the K2 deadline-row residual (pinned at 1 ms, not 1 µs) becomes its own row: "Recorded, not fixed (E8)", owner K2;
  - risk 56 keeps the G8 `roleOf` residual, with mitigation and owner IB2.

The editor's conflict list in v3.5 is confirmed as written, except where N-3 and N-4 above narrow it.
