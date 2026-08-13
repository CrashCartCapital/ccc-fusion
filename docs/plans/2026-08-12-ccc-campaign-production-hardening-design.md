# CCC campaign production hardening design

## Goal

Turn the live pilot into the product contract: one human launch decision authorizes one completely sealed campaign, each provider call remains bound to its exact task and route, finite campaign limits remain enforceable and restart-truthful, and deterministic proof is owned by the verifier rather than by the model being judged.

This design is the code-local execution specification for the failures observed in live campaign Round 10. It does not reinterpret or repair Round 10. That campaign remains immutable evidence.

## Success criteria

- A new multi-task product campaign presents exactly one live-execution confirmation and one later merge confirmation.
- The live-execution confirmation commits to the complete immutable set of provider-capable tasks, routes, actions, prompts, bounds, target repository, and frozen base. Adding, removing, or changing one member invalidates it.
- One atomic claim creates the existing exact task/action approval leases for every sealed member. Partial claim is impossible.
- Provider reservation, settlement, replay, and follow-on-turn custody continue to use task-specific child approvals and the existing `CccCampaignAuthorityBinding`; no campaign-wide wildcard reaches a provider.
- `maxRequests` remains one campaign-wide append-only budget, with a deterministic admission feasibility floor of one request per provider task and no promise that the cap is sufficient for completion.
- Request-budget exhaustion dispatches no extra provider call, parks with `ccc-permanent:CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED`, preserves prior receipts and commits, and never advertises retry as recovery.
- Preview states plainly that the request cap is campaign-global, shows the deterministic one-request-per-provider-task floor, and labels completion adequacy as unproven.
- Every explicit in-scope PRD acceptance clause is preserved in the sealed task prompt or explicitly dispositioned before import.
- Authoritative verifier files are tracked at the frozen base, hash-bound, and outside every model-owned/writeable path. Model-authored tests may supplement them but cannot be the only merge authority.
- Each task commit passes its linked deterministic proof before dependent work is released, and all proofs rerun against the final integrated tree before merge approval.
- Legacy imports retain their original per-task approval and proof interpretation. New authority is never retroactively inferred for persisted rows.

## Round 10 facts this design answers

Round 10 proved that six-turn sessions and consumed-approval follow-on custody now work. It then exposed three different product gaps:

1. Two coding tasks produced two human execution prompts because the current executable contract is one approval per task.
2. The first task used 17 requests and the second used 7; request 25 correctly hit the sealed campaign-wide cap of 24, but the typed refusal was flattened into a generic workflow failure.
3. The first task's implementation passed tests written by the same model even though it violated clauses that the authoring projection had omitted from its structured acceptance text.

The fixes remain separate. Approval aggregation must not change provider receipt identity. Better budget diagnostics must not weaken the cap. Better proof must not rely on an AI review verdict.

## Decision 1: one parent launch authorization, exact child permits

New imports use `sealed_bundle_v1` execution authorization. Existing imports are marked or interpreted as `per_task_v1` and continue unchanged.

The parent authorization is a new persisted object, not an overloaded approval row. Its immutable authorization digest commits to:

- project, import, campaign, idempotency key, workflow definition, and the one deterministic imported workflow work-item ID;
- packet, sidecar, bundle, manifest, execution-policy, prompt, target-repository, and frozen-base hashes;
- campaign start, deadline, `maxRequests`, and `maxConcurrency`;
- every provider-capable member in canonical order: native task ID, semantic task ID, action ID and target, provider, model, transport, prompt/route custody, and existing child `bindingHash`;
- a canonical member-set hash and authorization schema version.

The parent also stores an immutable `expectedRequestCount` snapshot shown in the human confirmation. It is a one-time compare-and-swap precondition for `issued → claimed`, not part of later claimed replay admission. Mutable work-item attempt, run, lease owner/expiry, timestamps, retry counters, and current provider request count are excluded from durable parent identity. Every provider attempt continues to bind its current exact work-item fence.

Issuance locks the import, re-derives the complete admitted member set from PostgreSQL custody, and writes the parent, all exact existing child approval rows, and the membership map in one transaction. Missing, extra, duplicate, or changed members refuse.

Approval locks in this order: import, parent, children sorted by binding hash, action-lease buckets. On the first claim it re-derives the same immutable set and compare-and-swaps the current request count against stored `expectedRequestCount`, then claims the parent and every child lease atomically. A fault at any member rolls back the parent, all children, and all leases. Claimed replay verifies the stored snapshot, immutable membership, and exact children but does not compare the legitimately advanced current request count. A changed work-item attempt likewise does not invalidate the parent.

Provider dispatch does not accept the parent identifier. It continues to present the exact child approval and token for the current task/action/route. Settlement consumes children under existing rules.

A child is **unopened** only when no provider-attempt reservation exists for that exact child task/action/binding. Unknown, proved-not-dispatched, committed, and proved-failed attempts all count as opened because a durable reservation exists. If the campaign work item becomes durably failed, cancelled, or manual-required, or the database clock passes the campaign deadline, one atomic no-effect terminal transition may expire a still-claimed unopened child only after locking the import, parent, child, work item, and attempt history and proving: no reservation for the member, no unknown provider/effect receipt, and an exact terminal/unreachable reason. It settles the child lease and appends bounded audit evidence. Settlement versus no-effect closure shares the same lock order, so only one can win. The parent reaches terminal `settled` only when every member is consumed or proved closed-with-no-effect; its terminal summary distinguishes complete-effect from partial/no-effect closure. Cancel-before-dispatch, upstream failure, deadline, restart, and races are required tests. A separately bound merge approval remains mandatory only after successful final proof.

### Why this is not a wildcard

The human approves a closed list whose hashes already bind the whole execution policy. The runtime cannot discover a new task later and inherit authority. A dispatch absent from the list has no child lease and fails before provider setup.

### Rejected approval designs

- Keeping `N + 1` human prompts is safe but fails the operator contract.
- Sharing one live-action ID across tasks recreates the authority hole already rejected by compiler admission.
- Reusing the first task's approval for later tasks breaks task, route, action, and receipt identity.
- Removing task/route fields from `CccCampaignAuthorityBinding` destroys exact provider custody.
- Sequentially claiming children permits a half-authorized campaign after a crash.

## Decision 2: keep the global budget and add an admission feasibility floor

`maxRequests` stays campaign-global. The import row remains the single counter, provider-attempt ordinals remain contiguous and append-only, and reservations are never deleted or decremented. The counter measures first-time provider-attempt reservation slots, not confirmed outbound calls. Identical replay remains free; proved-not-dispatched and unknown attempts remain spent because their identities are part of the sealed audit history.

Fresh v2 admission requires `maxRequests >= providerTaskCount`. The check runs in authoritative core import admission before any new import mutation. An exact idempotent replay of a previously persisted legacy or below-floor import remains replayable under its original contract; CLI import must reach core so the database can distinguish replay from fresh creation. Parent issue and first claim recompute:

- total used and remaining requests;
- unresolved reserved or dispatched-unknown attempts;
- consistency between the import counter and attempt history.

This is a static import feasibility check, not a runtime quota or reservation for each task. Earlier tasks may still exhaust the whole campaign-global cap before later tasks begin.

When the cap is exhausted, the engine translates the typed core refusal at a stable boundary into `PermanentError(..., "CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED")`. The work item parks `manual-required`; no retry or provider call occurs. Specialized status recovery is valid only when the persisted counter equals the sealed maximum and matches the provider-attempt ledger; undercount, overshoot, or equal-to-limit ledger drift is custody failure. Any reserved or dispatched-unknown provider or proof work takes precedence over budget recovery, as does missing task, route, or proof custody, so the operator is never told to start a potentially duplicative fresh import before reconciliation. Once custody is certain, status explains that the same immutable import cannot resume and that recovery is a fresh preview/import with a larger source-bound cap.

A fresh import does not inherit the exhausted campaign's attempts, approvals, proofs, leases, or provider custody. Its prior task commits remain evidence only. Incorporating those bytes into a new frozen base is a separate explicitly authorized and proven integration; the runtime never presents a fresh import as automatic resume or landing.

Preview adds derived budget guidance without adding it to the confirmation identity:

- scope: campaign-global;
- maximum requests;
- provider-task count and deterministic minimum;
- headroom above that minimum;
- completion adequacy: unproven.

### Rejected budget designs

- Per-task counters would invalidate existing campaign ordinals, receipts, replay, and import custody.
- Refunding by decrementing the counter would break append-only reconstruction and could authorize more effects than the sealed cap.
- Automatic requeue after exhaustion would loop forever against immutable state.
- Calling the deterministic floor "adequate" would make an assertion the runtime cannot prove.

## Decision 3: clause-complete prompts and verifier-owned proof

New product packets use a versioned semantic-proof contract. It does not heuristically split ordinary prose into clauses. A v2 source PRD declares acceptance authority only through this normative Markdown grammar:

```text
### Requirement REQ-001
#### Acceptance clauses
- [AC-REQ-001-001] First exact acceptance clause.
- [AC-REQ-001-002] Second exact acceptance clause.
```

Requirement and clause IDs must match the existing bounded canonical-ID grammar; a clause ID is globally unique and its `AC-<requirement-id>-` prefix must name the immediately enclosing requirement. Each clause occupies exactly one physical UTF-8 line. Its authoritative span starts at the first byte after `] ` and ends before the line terminator; empty text, trailing whitespace, continuation lines, duplicate headings, nested lists, malformed bullets, clauses outside an `Acceptance clauses` subsection, or clause bullets under an unknown requirement refuse. Other requirement prose is informative and cannot silently become acceptance authority. Dispositions use a separate `#### Acceptance dispositions` subsection with the exact grammar `- [<clause-id>] <deferred|excluded|unresolved>: <non-empty reason>` and may refer only to a clause declared under that same requirement. Authoring maps this source-declared inventory byte-for-byte into the clause manifest. An accepted clause absent from the manifest, a foreign or duplicate ID, or any `unresolved` disposition refuses semantic normalization. This makes the source, not an authoring model's sentence parser, the authoritative inventory.

Each requirement declares stable `acceptanceClauses`. Every source-declared in-scope clause must be represented by a clause or explicitly dispositioned as deferred, excluded, or unresolved. Unresolved or undispositioned clauses refuse product import. Each accepted clause links to at least one executable proof, and every accepted clause must have final-integrated proof coverage.

The sealed execution prompt includes the exact accepted clauses and their admitted source excerpts, not only an authoring model's summary. The prompt remains hash-bound to the semantic bundle.

Each proof declares three disjoint input sets:

- a closed `verifierClosure`, whose members record role (`task_runner`, `harness`, `fixture`, or `config`), canonical target-relative path, frozen-base Git blob object ID, and SHA-256 digest;
- explicit `candidateInputs`, which are the only implementation paths the verifier may judge and which are read from the proof attempt's exact source commit/tree; and
- an `executionToolchain` containing the resolved Task and Node executable paths, file SHA-256 digests, canonical version-output digests, and proof-host identity used at preview/import.

At preview/import the runtime requires every verifier-closure member to be:

- target-relative, canonical, tracked, and a regular file at the frozen base;
- present with its frozen-base SHA-256 digest;
- outside every task `ownedPaths` and `allowedWriteRoots`;
- accompanied by the baseline-owned task-runner definition used by the proof command.

The admitted Task target is deliberately narrow: no Task includes, dotenv, dependencies, variables, package-script indirection, shell substitution, dynamic dispatch, or undeclared helper/config input. It contains one literal command that invokes the declared Node executable, one declared trusted harness, and literal candidate arguments. The harness is self-contained except for the hash-bound toolchain and the explicitly named candidate paths it judges. Any other executable, fixture, helper, or config belongs in the closure. An unchanged Taskfile that delegates to a model-owned test is refused.

Immediately before proof, the controller creates a fresh isolated proof root. It materializes verifier-closure bytes from their frozen-base Git blobs and candidate bytes from the attempt's exact source commit, preserving their target-relative names but no other repository files. All materialized files are read-only. A separate empty scratch directory is the only writeable path. The verifier process receives no original worktree/repository path, network, inherited environment, ambient `PATH`, or undeclared target read root. Sandbox policy permits the isolated proof root, scratch, the two exact toolchain executables, and the minimum fixed operating-system runtime libraries needed to start them; it explicitly denies the original target and engine repositories. A dynamic import, absolute read, symlink escape, or helper/config lookup not present in the materialized closure therefore fails. The controller rechecks every materialized blob/digest and toolchain identity, and records them in the receipt. Model-owned tests may still run separately, but they are supplemental. A proof with only model-writeable verifier files is not product-admissible.

After the controller creates a required task commit, it runs that task's linked deterministic proof before releasing dependents. A proof admitting phase `task` must be linked by exactly one semantic task, may cover only clauses owned by that task's requirements, and is that task's only gate authority. A proof linked by multiple tasks or covering cross-task behavior must exclude phase `task` and is final-only; a final-only proof cannot satisfy a task gate. Every accepted clause must be covered by at least one `final_integrated` proof. The compiler refuses duplicate task-phase ownership, a task with no exact task-phase gate, or phase/coverage drift. The final proof suite reruns every proof admitted for `final_integrated` against the exact integrated commit/tree before merge approval. Proof attempt identity includes immutable phase `task` or `final_integrated`; the phase is persisted, hashed into the attempt key, checked on replay, and included in receipts. A one-task campaign therefore executes the same proof once per phase even when both phases name the same commit, while replay within either phase remains idempotent.

Verifier stdout is a single bounded canonical JSON object with schema `ccc-prd.proof-evidence.v2`. It names the proof, phase, commit/tree, and exactly one result for every expected clause, positive case, and negative control. Missing, duplicate, unknown, malformed, over-limit, or failing evidence refuses even when the process exits zero. Every terminal attempt stores a controller-owned canonical `ccc-prd.proof-terminal-envelope.v2` union. A `verified` envelope contains the parsed proof evidence and its digest; only a complete passing `verified` envelope may settle `committed`, while a complete failing one settles `proved_failed`. An `execution_refused` envelope contains one stable refusal code (`timeout`, `killed`, `no_output`, `malformed_output`, `output_over_limit`, `spawn_refused`, or `sandbox_refused`) plus exit/process facts and raw stdout/stderr digests; it has no parsed proof evidence and always settles `proved_failed`. Thus killed, timed-out, or malformed executions remain durably replayable without fabricating semantic evidence. Proof receipts bind the terminal envelope, complete verifier closure, candidate inputs, and execution toolchain. Task-phase failure parks terminally and requires a fresh sealed import; this design does not add an in-campaign AI repair loop.

AI review may be added as read-only defense in depth. It never substitutes for deterministic proof and never owns merge authority.

### Rejected proof designs

- Treating a green model-authored test file as semantic authority proves only self-consistency.
- Relying on a reviewer model creates another probabilistic authority boundary.
- Merely displaying `positiveOracle` and `negativeControls` in a prompt does not execute them.
- Retrofitting new proof meaning onto frozen v1 packets would invalidate their hashes and receipts.

## Persistence and compatibility

- Add forward migration `0039_ccc_campaign_execution_authorization.sql` plus baseline-schema parity for parent authorization and immutable members.
- Add forward migration `0040_ccc_campaign_semantic_proof_v2.sql` plus baseline parity. Existing proof-attempt rows backfill `attempt_contract_version = 'v1'`, keep phase, terminal envelope, parsed evidence, and new digests null, and retain their original attempt keys. New rows use `attempt_contract_version = 'v2'`, require `phase IN ('task', 'final_integrated')`, and hash the phase into their v2 attempt key. A partial unique constraint over project/import/proof/phase/source commit/definition/work-item fence rejects two v2 identities for one same-phase execution. Terminal v2 rows require bounded canonical terminal-envelope JSON plus its SHA-256. `committed` requires a `verified` passing envelope and non-null parsed evidence/digest; `proved_failed` permits either a `verified` failing envelope with parsed evidence or an `execution_refused` envelope with parsed evidence/digest null. Nonterminal v2 rows require all terminal-envelope/evidence fields null. Legacy v1 replay never acquires phase or semantic-evidence meaning. Fresh-baseline, 0039-to-0040 upgrade, legacy replay, v2 replay, timeout/no-output/malformed replay, and constraint tests are mandatory.
- Add an immutable execution-authorization mode/version for imports; existing rows remain `per_task_v1`, new product imports use `sealed_bundle_v1`.
- Keep `CccCampaignAuthorityBinding`, deterministic child approval IDs, existing provider-attempt rows, and existing action-lease buckets byte-stable.
- Version the aggregate confirmation shape and semantic-proof packet/bundle shape.
- Existing packets remain inspectable. Existing in-flight imports continue their old contract. They do not silently gain aggregate authority or verifier-owned semantic status.
- New migrations include foreign keys, row-level security, uniqueness, lock-order tests, baseline/upgrade parity, and rollback injection.

Execution-authorization mode is part of the campaign manifest and manifest hash, never a free-standing switch. Manifest v1 deterministically means `per_task_v1`. New manifest v2 contains `executionAuthorizationMode: "sealed_bundle_v1"`. If a projection column is stored for indexing, the loader re-derives it from the manifest and refuses any mismatch. Direct row mutation cannot activate aggregate authority for a legacy import.

### Semantic-proof schema compatibility matrix

| Surface | Legacy | New product contract | Compatibility rule |
|---|---|---|---|
| Authoring proposal | `ccc-prd.authoring-proposal.v1` | `ccc-prd.authoring-proposal.v2` | v1 remains parseable; it cannot claim clause-complete semantic proof |
| Authoring proposal fragment | `ccc-prd.authoring-proposal-fragment.v1` | `ccc-prd.authoring-proposal-fragment.v2` | chunk v2 carries the same source-declared clause IDs/spans; v1 fragments may assemble only a v1 proposal |
| Sidecar | `ccc-prd.sidecar.v1` | `ccc-prd.sidecar.v2` | hashes and fields are version-specific; no reinterpretation |
| Semantic bundle | `ccc-prd.bundle.v1` | `ccc-prd.bundle.v2` | v2 binds source-declared clauses and verifier closure |
| Proof admission | `ccc-prd.proof-admission.v1` | `ccc-prd.proof-admission.v2` | v2 definition hash uses one shared core implementation |
| Execution prompt | `ccc-prd.execution-prompt.v1` | `ccc-prd.execution-prompt.v2` | v2 contains exact clauses and admitted excerpts |
| Proof evidence | exit code plus v1 receipt | `ccc-prd.proof-evidence.v2` | v2 requires bounded exact JSON evidence in addition to exit zero |
| Proof attempt | phase-less v1 identity | phase-bound v2 identity | legacy rows replay only under v1; new rows persist `task` or `final_integrated` |

The raw packet manifest remains `ccc-prd.packet.v1` because it inventories source bytes rather than interpreting semantic clauses. `ccc-prd.implementation-fact-provenance.v1` also remains unchanged because it records authoring facts, not proof authority. Neither schema may be used as evidence that a v1 semantic bundle satisfies the v2 proof contract.

The v2 proof-definition hash includes accepted clause IDs, allowed execution phases, the complete verifier closure, the canonical candidate-input path set, complete Task/Node toolchain and proof-host identity, command, positive cases, negative controls, and existing proof identity. Core owns the single hash implementation used by compiler, admission, persistence, and execution. Any candidate, toolchain, or proof-host drift changes the definition hash and refuses at admission or replay before spawn.

## Failure-mode pressure test

- **Member added after confirmation:** member-set re-derivation changes; claim refuses before any lease.
- **Member missing or duplicated:** canonical set validation refuses issue/claim.
- **Route, prompt, target, base, action, or bound drift:** aggregate digest changes; stale confirmation refuses.
- **Crash halfway through claim:** one database transaction leaves zero partial leases.
- **Restart after claim:** parent and exact children reload from PostgreSQL; dispatch still needs the matching child.
- **First task consumes the shared pool:** the global cap stops the campaign truthfully; no downstream authority or proof is fabricated, and recovery requires a newly sealed import.
- **Budget exhausted:** no reservation row or provider call is created; work parks with stable permanent reason.
- **Unknown provider effect:** reservation remains spent and concurrency remains held until authoritative reconciliation.
- **Model edits trusted tests or Taskfile:** write-root admission or pre-proof digest comparison refuses.
- **Unchanged Taskfile delegates to model tests:** closed-target admission refuses package-script/dynamic/undeclared delegation.
- **Trusted harness dynamically reads a model helper:** the helper is absent from the materialized proof root and the original repository is denied, so execution refuses and no successful evidence is recorded.
- **Authoring drops a PRD clause:** clause coverage refuses before import, and the exact source excerpt is also present in the prompt.
- **Task proof passes but integration breaks it:** final integrated proof reruns and refuses merge.
- **Task and final proof share a commit:** phase-bound attempt identity forces two executions and only deduplicates same-phase replay.
- **Verifier exits zero with incomplete evidence:** canonical evidence validation refuses.
- **Legacy import encountered:** legacy path remains explicit; no parent authority is inferred.
- **Downstream member never dispatches:** exact terminal work-item/deadline plus zero-reservation proof closes its lease as no-effect and lets the parent settle without inventing an effect.
- **Settlement races no-effect closure:** shared locks permit exactly one terminal child outcome.
- **Task A advances request count before task B replays require:** claimed replay validates the stored one-time snapshot and immutable children, not current count.
- **Projection mode is directly changed:** manifest-v2 reconstruction detects drift and refuses aggregate authority.

## Non-goals

- Changing the campaign-global request counter into task quotas.
- Refunding provider reservations by deleting or decrementing history.
- Making AI review the semantic proof authority.
- Upgrading existing frozen campaigns in place.
- Removing the separately confirmed Git merge decision.
- Changing provider/model identity, credentials, OmniRoute configuration, or live pilot evidence while implementing this design.

## Handoff

Implementation proceeds in accepted-spine slices: truthful budget failure and preview, aggregate authorization persistence/control, semantic-proof v2 and task proof, then full fake-provider and live-pilot acceptance. Every behavior slice starts with a named failing test, closes with its smallest GREEN, and receives fresh integrated verification and independent final-byte review before merge.
