# CCC-Fusion Gate 2 Verifier Split Design

## Goal

Keep semantic proof fail-closed inside the existing no-network sandbox while still proving that the generated telemetry service works through real HTTP, SSE, persistence, restart, and CLI behavior.

## Success Criteria

- Task and integrated semantic proofs execute with zero network syscalls under `sandbox-exec`.
- The sealed verifier exercises stable leaf contracts plus an in-process request/response seam, append-only audit behavior, SSE delivery, restart recovery, and injected health-probe behavior.
- The live Gate 2 harness independently starts the committed candidate on an owned reserved loopback port and proves real HTTP ingest, invalid-request rejection, SSE delivery, audit survival, and healthy/unavailable CLI exit behavior.
- Formal proof admission remains bound to exact source commit/tree; outer usefulness evidence remains bound to the same integrated commit/tree and installed-runtime receipt.

## Constraints

- Do not relax `(deny network*)` in the semantic-proof sandbox.
- Do not accept syntax, source inspection, or candidate-authored tests as the sole usefulness proof.
- Do not leak verifier answer bytes into worker prompts.
- Preserve the frozen six-task DAG, exact routes, generous campaign envelope, and one controller REPAIR turn.
- Importing a candidate module must never start a listener, consume CLI arguments, or perform another external effect; executable entrypoints use an explicit `import.meta.url` main guard.

## Options Considered

1. Allow loopback in every semantic proof. Rejected: it broadens a security boundary for all campaigns and lets candidate code open arbitrary local listeners.
2. Split proof layers. Selected: socket-free deterministic semantic proof inside confinement, plus a controller-owned real-loopback usefulness probe in the live harness.
3. Keep only structural checks inside confinement and rely entirely on the outer probe. Rejected: it makes formal task proof too weak and lets the final campaign advance without meaningful behavior evidence.

## Decision

Define small import-safe candidate contracts for every leaf: `contract.ts` exports strict parse/validation; `ingest.ts` exports a handler with injected audit/broadcast dependencies; `audit.ts` exports an append/read store over an injected path; `broadcast.ts` exports publish/subscribe with an async SSE stream; `health-cli.ts` exports an injectable `probeHealth(fetchFn, url)` plus a guarded CLI entry; and `app.ts` exports an in-process request handler plus a guarded real-server entry. Each task description names only these observable signatures and behavior, not verifier implementation bytes. The sealed verifier imports and exercises each contract without sockets.

After the integrated proof reaches the merge hold, the live harness resolves an explicit free loopback port with the existing reservation helper, creates a clean detached checkout at the integrated proof's exact source commit, verifies its tree hash, and runs a controller-owned probe plus candidate inside a generated `sandbox-exec` profile. That profile has a scrubbed environment, read access only to the detached checkout and sealed runtime, write access only to one scratch root, and network bind/outbound access only for `127.0.0.1:<reserved-port>`; all other network is denied and port `4040` remains forbidden. The probe runs the binary usefulness rubric and stops only its supervised process group.

The outer evidence schema is `ccc-gate2.usefulness-evidence.v1`: installed receipt digest; source commit/tree; detached checkout status; reserved port; six named case results; process exit/signal/duration; bounded stdout/stderr tails and hashes; sandbox profile digest; cleanup result; and final target status. Any mismatch, dirty checkout, missing case, sandbox fallback, process leak, or probe failure is a Gate 2 failure. It does not consume or invent a second controller REPAIR turn; the next action is packet/harness repair followed by a fresh isolated campaign.

## Pressure Test

- Models may implement the exported seams inconsistently. Mitigation: state the leaf signatures in the PRD/task contract and make each task verifier report exact missing exports before downstream work releases.
- The outer probe could test different bytes. Mitigation: bind its checkout to the admitted integrated proof source commit/tree and fail on mismatch.
- Candidate top-level code could execute during import. Mitigation: require and verify guarded entrypoints before any in-process call.
- A service may pass in-process but fail over real sockets. Mitigation: the confined outer probe is mandatory for Gate 2 clean success and is not inferred from semantic proof.

## Open Questions

None block implementation. The smallest implementation should reuse the existing verifier source generator, installed-runtime evidence writer, owned process supervision, and loopback port helpers.
