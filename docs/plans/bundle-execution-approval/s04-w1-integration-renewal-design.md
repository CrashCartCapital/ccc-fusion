---
title: "S04: reconcile W1 with the accepted sealed authorization spine"
type: design
status: accepted
date: 2026-08-20
slice: S04
milestone: "Bundle execution approval"
origin: "PRD rev 0.1.2 W1 reconciliation after fresh exact-tree audit"
---

# S04: reconcile W1 with the accepted sealed authorization spine

## Goal

Close the real W1 gaps without creating a second authorization system.

Baseline `91ced0cca` already contains the production `sealed_bundle_v1` path:

- `execution-authorization.ts` derives one immutable parent over every provider task;
- one parent confirmation claims every exact child action lease in one PostgreSQL transaction;
- product status and CLI expose the redacted parent and child rows;
- the product acceptance harness proves `approvalCalls: 1` for a four-task fan-out.

The later `execution-bundle*.ts` modules and migration `0041` duplicate that capability behind a disconnected internal API. They are parked evidence, not the integration target.

## Decisions

### 1. Accepted spine wins

W1 continues through these existing public surfaces:

- `packages/core/src/ccc-campaign/execution-authorization.ts`
- `packages/core/src/ccc-campaign/index.ts`
- `packages/core/src/ccc-prd/product-status.ts`
- `packages/engine/src/ccc-campaign-product-control.ts`
- `packages/engine/src/workflow-work-processor.ts`
- `packages/engine/src/workflow-task-runtime.ts`
- `packages/cli/src/commands/prd.ts`
- `scripts/ccc-prd-product-acceptance.mjs`

Do not export, wire, or extend the disconnected `execution-bundle*.ts` path. Preserve its bytes until the parent archives or removes it under the repository's work-discard rules.

### 2. Two authorities remain separate and both are required

The runtime keeps two different fences:

1. the sealed execution authorization and its exact child action lease; and
2. the running workflow work-item lease, bound to work item, task, run, owner, attempt, and expiry.

Bundle approval must not mint or renew the workflow lease. Workflow renewal must not create or extend execution authority.

Before a provider-backed campaign task may run, the product path must establish both:

- `requireCccCampaignLiveExecutionApproval` / exact child action-lease custody; and
- `assertCccCampaignWorkflowLeaseFence` for the running workflow item.

Loss of either fence refuses or aborts before a new provider effect.

### 3. W1-T5 proves real contention on the shared workflow row

The accepted parent claim calls `deriveExecutionAuthorization`, which locks the campaign workflow item with `FOR UPDATE`. `renewWorkflowWorkItemLease` updates that same row. This is the meaningful Round-11 contention surface. The disconnected `0041` bundle tables are not.

Add a deterministic real-PostgreSQL regression to `packages/core/src/__tests__/postgres/ccc-campaign-execution-authorization.pg.test.ts`:

1. Import a three-member `sealed_bundle_v1` campaign and issue its one parent authorization.
2. Put the campaign workflow item in `running` with one exact owner, run, attempt, and live expiry.
3. Hold the workflow row lock in a test-owned transaction.
4. Start three distinct parent claims and one exact workflow-lease renewal while the lock is held.
5. Prove all four operations are pending through explicit test promises or query-state observation, not sleeps.
6. Release the row lock.
7. Assert exactly one parent claim succeeds, two claims refuse, and the exact owner/attempt renewal succeeds.
8. Assert stale-owner, stale-attempt, expired, and wrong-state renewals return `null`.
9. Assert every child action lease belongs to the winning parent token derivation.
10. Assert the workflow lease fence accepts the renewed owner/attempt and refuses stale values.

The test proves lock-order safety, one coherent authorization winner, renewal survival, and both post-race fences. It does not claim the parent authorization itself is renewable.

If the row-lock barrier cannot be expressed with the existing PG harness, the test may add a test-only helper under `packages/core/src/__tests__/postgres/`. Product code must not gain timing hooks solely for the test. Sleeps and widened timeouts are forbidden as concurrency proof.

### 4. Product status uses the existing import-keyed parent

`getCccCampaignExecutionAuthorizationForImport` already resolves zero or one parent. More than one is a typed ambiguity error. `inspectCccPrdProductStatus` verifies the parent against import, campaign, manifest, packet, sidecar, bundle, repository, base, request limit, and concurrency limit, then redacts the parent claim token.

W1-T3 closure is therefore a presentation and assertion task, not a new store:

- show one parent confirmation only;
- join each immutable authorization member to its redacted child approval status by `approvalRequestId`;
- show per-member custody as `issued`, `claimed`, `consumed`, `expired`, or `denied`;
- keep parent and child claim tokens absent;
- fail closed on a missing child, duplicate child, or binding mismatch.

The CLI keeps the existing `fn prd ... status` surface. No second bundle-status command is added.

### 5. Structural re-seal rule follows the cryptographic contract

The existing parent digest directly covers:

- `workflowIrHash` and `manifestHash`, which transitively cover task/dependency structure;
- every member binding, route, prompt, action, provider, model, and transport;
- target repository and `targetBase`;
- packet, sidecar, bundle, execution-policy, bounds, campaign window, and complete member set.

Required tests prove:

- task/member-set change changes the parent identity and old confirmation refuses;
- workflow dependency-edge change changes `workflowIrHash` and parent identity;
- owned-path or route change changes the bound route/member identity;
- target-base change changes the parent identity and old confirmation refuses;
- an identical re-derivation is idempotent and returns the same parent.

The ratified PRD sentence allowing “digest-preserving re-freezes” with an updated base conflicts with the implemented preimage because `targetBase` is hashed. S04 chooses the stricter fail-closed rule: **any target-base change requires a fresh parent confirmation**. No existing confirmation may float to a different base.

### 6. Duplicate candidate disposition

The following are not accepted W1 product surfaces:

- committed `packages/core/src/ccc-campaign/execution-bundle*.ts` modules and their unit tests;
- dirty `packages/core/src/ccc-campaign/execution-bundle-pg.ts`;
- dirty migration/schema `0041_ccc_campaign_execution_bundles*`;
- dirty `ccc-campaign-execution-bundle.pg.test.ts`.

Before removal, preserve one reviewable patch/archive reference and verify no accepted-spine import or public call site depends on them. Removal is a separate, exact-target cleanup change after AGY review and repository proof. W3-T2 files in the same branch are unrelated and must be retained.

## Alternatives rejected

### Extend the disconnected bundle implementation

Rejected because it creates a parallel authority database, status path, and claim state beside the already-integrated `sealed_bundle_v1` system. It would make two sources of truth possible.

### Keep both and translate between them

Rejected because synchronization failures would become authority failures. Translation adds no operator value.

### Test unrelated bundle-table claims beside lease renewal

Rejected because those transactions touch disjoint tables and would prove only generic PostgreSQL concurrency, not the product lock path.

### Permit base movement under the old digest

Rejected because it contradicts the current cryptographic preimage and weakens exact-base custody.

## Failure pressure test

- Three claimants race: one parent wins; every child lease derives from the winner; losers produce zero dispatch.
- Renewal overlaps claim: the workflow row lock serializes safely; no deadlock; exact renewal survives.
- Renewal loses owner/attempt/expiry/state: runtime aborts and provider execution remains fenced.
- Parent claim exists but workflow lease is stale: workflow fence refuses.
- Workflow lease is live but child action lease is missing/drifted: execution-authorization fence refuses.
- Dependency, route, owned-path, member, or base changes: old confirmation refuses.
- Status has a missing or mismatched child: status refuses rather than hiding the member.
- Duplicate implementation remains present: public imports and acceptance assertions must still prove only the accepted spine is reachable.

## Success criteria

- One public authorization system exists.
- One operator confirmation claims every exact member atomically.
- Per-member custody is visible through the existing status/CLI path with no tokens.
- The real-PG suite contains an honest three-claim plus lease-renewal contention regression on the shared workflow row.
- Runtime proof demonstrates both the action-authorization fence and workflow-lease fence.
- Structural or base drift changes the digest and requires a fresh confirmation.
- Product acceptance asserts the status shape and one-decision behavior.
- No W1 claim is labelled live-model proof until a later authorized rung actually uses a live model.

## Implementation ownership

Shared contracts remain parent-owned. After the design is accepted, safe parallel slices are:

1. **PG contention proof:** execution-authorization PG test plus test-only PG helper.
2. **Status presentation:** product-status/CLI join and exact unit/PG tests.
3. **Acceptance assertion:** product acceptance script assertions only.

Duplicate-path cleanup is serial and parent-owned. No worker may edit `canonical.ts`, `execution-authorization.ts`, workflow lease implementation, migrations, or shared types unless a valid RED proves product code is missing.

## Proof ladder

1. Named RED for each missing assertion.
2. Smallest GREEN on the accepted spine.
3. Exact real-PG test with no silent skip.
4. Affected core, engine, and CLI tests.
5. `task verify:fast`.
6. `task gate`.
7. `task verify` only after the bounded gates are green.
8. Fresh exact-tree review of final bytes and explicit proof labels.

## Authority boundary

This design authorizes local code, tests, docs, and reversible worktree operations only. It does not authorize a live campaign, provider request, target-repository mutation, merge, push, release, credential action, or protected Vault mutation.
