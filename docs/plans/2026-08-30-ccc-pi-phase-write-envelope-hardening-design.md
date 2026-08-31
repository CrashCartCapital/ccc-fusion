# CCC Pi Phase And Write-Envelope Hardening Design

## Goal

Make the Pi inner loop reliably finish an admitted campaign phase across model families and detect worker-created paths outside the sealed write envelope immediately, then rerun the unchanged three-peer Evidence Ledger matrix.

## Scope Classification

Deep. This changes the provider-neutral phase state machine, Pi tool execution policy, candidate custody diagnostics, and the live acceptance campaign. The user already approved this exact end-to-end goal and its success conditions.

## Current Evidence

- GLM wrote the two admitted Contract files, passed `task verify:contract`, received the existing MUTATE continuation, then emitted a second prose completion report without calling `fn_complete_phase`. The controller therefore never entered VERIFY and failed with `MUTATE ended twice with a dirty candidate but without an explicit phase signal`.
- MiniMax completed and locally proved the Core files, but had already created `.fusion-tmp/h2.txt` outside the task's admitted roots. SafeExec correctly refused unattended recursive deletion. The required-commit fence caught the residue only after 180 total requests.
- In current Pi policy, a potential mutation is inspected only while the phase is DISCOVER. Once the first admitted mutation changes the phase to MUTATE, later tools bypass that policy callback.
- Native write/edit paths are bounded to the whole worktree, not the task's narrower admitted roots. Bash validates its working directory, not arbitrary command effects.

## Success Criteria

- A dirty, unsignaled MUTATE turn receives one ordinary work continuation and then one distinct signal-only handshake.
- Signal-only is an explicit state-machine state. Pi mechanically permits only `fn_complete_phase`; any other tool is refused before execution, invalidates the signal turn, and terminates it. Prose or reasoning alongside the sole signal tool is tolerated.
- Exact admitted write roots are visible in the implementation prompt. Native write/edit targets outside those roots are refused before execution using canonical path boundaries.
- The worktree begins the provider phase with zero foreign changed paths.
- Every potential mutation tool in every phase captures a pre-tool write-set snapshot and a post-tool snapshot. Newly introduced foreign paths terminate the turn immediately with a stable diagnostic. No automatic deletion occurs.
- The existing readiness and required-commit fences remain unchanged as defense in depth.
- Generous envelope, task shape, route receipts, and peer attribution remain unchanged.
- MiniMax, GLM, and Gemini Flash each reach the durable merge-approval hold with three committed tasks, four green proofs, and the exact six files, or a genuine external blocker is preserved truthfully after changed experiments.

## Design

### Explicit signal handshake

Add `AWAIT_PHASE_SIGNAL` and `PROMPT_PHASE_SIGNAL` to the pure phase machine. A settled dirty MUTATE turn still receives one normal continuation for unfinished work. If that continuation settles without `fn_complete_phase`, the machine enters `AWAIT_PHASE_SIGNAL` for exactly one request. The prompt says the admitted candidate is already dirty and that the next action must be the zero-argument `fn_complete_phase` tool. It does not invite inspection, verification, or more editing.

Pi receives the current phase through the campaign tool policy. In `AWAIT_PHASE_SIGNAL`, all tools remain sequential. `fn_complete_phase` is the only executable tool. Any attempted sibling tool is rejected before its implementation runs, records an invalidating tool name, and returns a terminating Pi-shaped error. This provides the safety effect of atomic signal-only handling even though the current Pi SDK exposes individual sequential tool executions rather than a pre-dispatch whole-batch hook. A later signal in the same provider batch cannot erase the earlier invalidation.

Text or thinking alongside the sole signal tool is not rejected. If no signal arrives, or any other tool was attempted, the phase fails honestly. Controller VERIFY still begins only after the explicit signal and after the provider turn settles.

### Early write-envelope guard

The campaign prompt renders the exact relative admitted roots and states that every file or directory created inside the candidate worktree must fall within them. Worker scratch, temporary output, logs, and copies must not be created elsewhere in the worktree.

Native write/edit tools receive a pre-execution path check. Paths are resolved against the worktree, normalized, required to remain inside the worktree, and compared using exact-or-descendant path semantics against normalized admitted roots. Prefix lookalikes and `..` traversal do not pass.

For every potential mutation tool, including Bash and during MUTATE/REPAIR, Pi captures the full candidate write set before execution and again afterward. Phase entry first asserts there are no foreign paths, so attribution begins from a valid baseline. The guard computes newly introduced paths from the two snapshots and checks them against the admitted roots. A new foreign path sets `CCC_CAMPAIGN_WRITE_ENVELOPE_VIOLATION`, records the tool name, new foreign paths, allowed roots, and the bounded original tool result, then terminates the provider turn. It never tries to remove the path. The end-of-phase readiness and commit fences independently recheck the full worktree.

The guard proves candidate-worktree custody, not arbitrary host-filesystem confinement. Existing action gates, worktree boundary checks, SafeExec, Git custody checks, and environment isolation retain their separate responsibilities. This slice does not claim to hash all `.git` internals or sandbox every possible external shell side effect.

## Alternatives Considered

1. Prompt-only reminder: rejected. The current clear reminder already failed with GLM and cannot enforce a signal-only turn.
2. Infer completion from prose or a passing worker command: rejected. It weakens the explicit phase protocol and trusts model-controlled evidence.
3. Run controller VERIFY automatically after a quiet dirty turn: deferred. Controller proof is stronger than prose, but the approved acceptance criterion requires correct explicit phase signals.
4. Static parsing of every shell command or an OS sandbox: deferred. It may eventually offer stronger prevention, but it is broad, platform-sensitive, and can block legitimate commands. Native preflight plus immediate Git-delta detection is the smallest faithful correction.
5. Automatic cleanup of foreign residue: rejected. It is destructive, can be blocked by host safety gates, and erases evidence.

## Error Handling

- Pre-existing foreign paths at phase entry fail before a provider request.
- Native out-of-envelope path attempts return a specific non-executed refusal so the model can choose an admitted target.
- A post-tool foreign-path delta is terminal because the candidate is already contaminated. The original tool result remains bounded in the terminal diagnostic.
- Signal-only sibling tool attempts are terminal for that handshake and cannot be laundered by a later `fn_complete_phase` call.
- Timeouts, route uncertainty, quota failure, and provider errors retain their existing classifications.

## TDD Map

- `PHASE-1` -> `ccc-phase-machine.test.ts`: second dirty unsignaled MUTATE observation yields `PROMPT_PHASE_SIGNAL`; `AWAIT_PHASE_SIGNAL` transitions only on a valid signal.
- `PHASE-2` -> `ccc-campaign-fallback-executor-seam.test.ts`: GLM-shaped prose completion receives one signal-only prompt, sole tool signal reaches controller VERIFY, sibling tool invalidates the handshake.
- `CUSTODY-1` -> Pi campaign tool-policy tests: native foreign write is refused before execute; Bash-created foreign delta returns a terminating custody error in MUTATE as well as DISCOVER.
- `CUSTODY-2` -> real-Git required-commit tests: admitted files plus `.fusion-tmp/h2.txt` remain uncommitted and diagnostically preserved.
- `REGRESSION` -> existing phase, Pi, provider controller, required-commit, alias receipt, golden matrix, and fake three-task control.

## Product Pressure Test

- Risk: baseline residue is falsely blamed on the next tool. Mitigation: zero-foreign baseline assertion plus pre/post path-set delta.
- Risk: a batched sibling tool executes beside the signal. Mitigation: sequential tools, pre-execution signal-only refusal, persistent invalidation, and terminating result.
- Risk: terminating on a foreign path wastes otherwise valid admitted edits. This is intentional custody behavior; the admitted edits remain available for diagnosis and no destructive cleanup occurs.
- Closest alternative: automatic controller VERIFY after quiet completion. Rejected for this goal because it would make the product pass while leaving the explicit phase protocol broken.

## AGY Review Dispositions

- Adopt: baseline/delta attribution, explicit state-machine handshake, canonical path handling, terminating custody error, and prose-tolerant sole-tool validation.
- Adapt: Pi exposes sequential tool execution rather than a whole-batch preflight. Equivalent safety is achieved by refusing every non-signal tool before execution, persisting invalidation, and preventing a later signal from clearing it.
- Defer: global host-filesystem and `.git` hashing. Those are broader confinement concerns and are not claimed by this candidate-write-envelope fix.

## Handoff

Write the implementation plan, execute each behavior under RED -> GREEN -> REFACTOR, run deterministic controls, then rerun the unchanged live matrix serially and update the golden evidence note.
