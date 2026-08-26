# CCC provider-neutral terminal route receipt adapter

Date: 2026-08-26
Status: approved for local TDD implementation

## Goal

Make terminal route identity evidence a sealed, provider-neutral execution capability that survives the packed CLI install boundary. A committed campaign turn must not depend on provider names, model aliases, workspace-only package patches, or manually injected test receipts.

## Contract

- A sealed execution route may declare `receiptAdapterId: "terminal-route-sse-comments.v1"`.
- Absence means no receipt adapter. Legacy frozen routes remain byte-for-byte valid and are never silently rewritten.
- Unknown adapter IDs fail closed during policy parsing.
- The existing canonical route and policy hashes bind the adapter selection. No new authority-binding field is required for this first implementation.
- Receipt behavior is selected only by the sealed field. `providerId`, `modelId`, aliases, URLs, and provider branding never activate it.
- The adapter's wire parser may understand the admitted terminal SSE comment format, including its current header names, without using those names to choose the adapter.

## Runtime architecture

```text
sealed route receiptAdapterId
  -> authenticated task/provider binding
  -> Fusion provider registration with request-scoped streamSimple
  -> normal OpenAI-compatible request and assistant event stream
  -> terminal SSE comment parser
  -> terminal effective-route receipt
  -> provider-attempt reconciliation
  -> controller commit/readiness custody
```

The runtime seam is the custom provider `streamSimple` callback registered through Pi's `ModelRuntime`. It owns exactly one prepared request, can inspect the raw response body, and avoids global `fetch` mutation. It must honor the prepared headers, API key, abort signal, and CCC's `maxRetries: 0` boundary.

## Compatibility

- Historical effective-route records with `omniRoute` stay readable.
- New receipt enforcement is driven by the explicit adapter contract, not `isOmniRouteProvider` or equivalent heuristics.
- Provider-attempt reconciliation requires a terminal receipt only for a committed result whose sealed route selected the adapter. Proved-failed attempts may honestly lack a terminal receipt.
- The first implementation may retain the historical `omniRoute` receipt field as a wire/storage compatibility name, provided all selection and requirement logic is provider-neutral. A generic persisted field can follow as a separately migrated schema.

## Failure behavior

- Missing, partial, conflicting, or route-mismatched terminal receipts fail closed.
- Aborted or timed-out requests remain bounded and do not manufacture a receipt.
- No fallback or alias normalization is admitted.
- A loaded artifact is `RUNTIME_LOADED`, not `LIVE_WORKING`. Live status requires a brand-new campaign and exact terminal receipt through the installed artifact.

## TDD sequence

1. Core RED: explicit arbitrary-provider adapter is accepted and hash-bound; unknown IDs are refused; legacy absence remains valid.
2. Core RED: receipt requirement depends only on the explicit adapter contract, never provider/model naming.
3. Engine RED: a request-scoped parser handles split comments, unrelated comments, conflict, missing terminal data, and abort.
4. Engine RED: a loopback SSE response reaches reconciliation without manual receipt injection.
5. CLI RED: product policy authoring explicitly carries the adapter selection.
6. Pack/install RED: the exact packed CLI handles the loopback receipt using installed bytes.
7. Verify targeted core/engine/CLI suites, typechecks, broader gates, exact artifact hash, isolated install, then a brand-new V7 campaign.

## Rejected designs

- Provider-name/model-alias inference: violates the provider-neutral constraint and permits accidental activation or omission.
- Global or temporary `fetch` replacement: unsafe under concurrent requests and import/test order.
- `onResponse`: exposes status and headers but not the response body containing terminal comments.
- Workspace `pnpm.patchedDependencies`: not preserved by a normal packed install.
- Blindly bundling the Pi dependency graph: risks patched/pristine split copies, extension and worker drift, and package bloat.
- Worktree cleanup on refusal: can destroy operator-owned untracked or pre-existing work and is outside commit custody.

## Acceptance labels

- `SOURCE_GREEN`: source tests and typechecks pass for the exact commit.
- `RUNTIME_LOADED`: an isolated packed install loads the exact built artifact and adapter code.
- `LIVE_WORKING`: a brand-new live campaign produces a terminal provider/model receipt and controller-owned committed result through that installed artifact.
