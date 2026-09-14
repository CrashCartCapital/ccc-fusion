# Model admission and boundary diagnostics

CCC-Fusion now has three pure contracts for deciding whether a model route has enough evidence to enter a campaign. They do not call a provider, write telemetry to storage, resume an attempt, or control a running session.

The code is split by responsibility:

- `@fusion/core` owns the versioned capability profile.
- `@fusion/engine` owns the privacy-safe boundary event contract and transition validator.
- `@fusion/engine` owns the deterministic admission policy.

This is source-and-test implementation only. It is not installed, runtime-loaded, live-working, or proven useful against a real provider.

## Capability profiles

`parseCccModelCapabilityProfile` validates one provider/model/transport route. The parser rejects unknown fields and missing capability records. It does not infer behavior from a provider name, model alias, or transport label.

Every required capability carries a value and one evidence state:

| Evidence state | Meaning |
|---|---|
| `unknown` | No usable evidence exists. The value must be `null`. |
| `declared` | A provider or adapter declares the behavior, but Fusion has not proved it. |
| `offline_proven` | Deterministic local fixtures proved the behavior. |
| `live_proven` | A bounded live probe proved the behavior for this exact route. |

All 14 version-one capabilities are campaign-critical. `evaluateCccCampaignCapabilityAdmission` refuses a profile if any one of them remains `unknown`.

Canonical serialization sorts object keys before encoding. `digestCccModelCapabilityProfile` hashes those canonical bytes with SHA-256, so equivalent profiles produce the same lowercase digest. Parsed profiles and nested values are frozen.

## Boundary telemetry

The telemetry module records boundary facts, not model content. An event may contain route identity, adapter version, receipt state, timestamps, elapsed time, tool name/category, schema fingerprints, usage counts, and terminal classification.

It may not contain prompts, reasoning text, tool arguments, tool output, authorization headers, cookies, API keys, environment values, database material, or generic payload/body fields. The strict parser rejects those keys before serialization.

When two sensitive payloads need an equality comparison, call `createCccSensitivePayloadHmac` with a key of at least 32 bytes and an already encoded `string` or `Uint8Array`. The event stores only the `hmac-sha256:<hex>` token. Structured objects are not accepted because property ordering would make equality ambiguous.

`validateCccModelBoundarySequence` consumes events in their supplied order. Sequence numbers must increase and elapsed time must not move backward within an attempt. The validator enforces these boundaries:

- terminal observation requires both request dispatch and an opened stream;
- dispatch, an HTTP response, or stream startup is not terminal success;
- a failed stream cannot later become successful inside the same attempt;
- `dispatched_unknown` remains nonterminal and replay-ineligible;
- controller handoff requires terminal observation and stream closure;
- proof may start only after a successful controller handoff;
- terminal, closure, handoff, and proof transitions cannot repeat.

A retry needs a distinct attempt identity. The validator returns frozen attempt states in first-attempt order.

## Admission policy

`evaluateCccModelAdmission` evaluates evidence without network or filesystem access. Version one uses six ordered stages:

1. `profile_validated`
2. `offline_conformance`
3. `live_microprobe`
4. `replicated_scenarios`
5. `bounded_coding`
6. `campaign_admitted`

The built-in policy requires every named offline fixture to pass, both controls to behave as expected, 10 valid live microprobes, all 30 predefined scenario arms, and all five sealed coding tasks. The route receipt must bind the evidence to the profile digest and prove that requested and effective provider/model identity match.

A coding trial needs a produced diff, a successful terminal return, stream closure, clean scope, verifier success, and proof eligibility. A good diff without terminal model return is rejected.

The evaluator returns:

- `admitted` when every stage passes;
- `rejected` when evidence proves a failed invariant;
- `insufficient_evidence` when required evidence is absent, malformed, duplicated, or below the stage's evidence level.

Reasons are emitted in fixed stage and policy order. `rejected` takes precedence over `insufficient_evidence` if both kinds are present. The verdict includes the highest contiguous passing stage and the first ordered probe that could change a non-admitted result.

## Adding another model route

MiniMax M3, Gemini Flash, and later models use the same path:

1. Create a new profile for the exact provider/model/transport route.
2. Record declared facts without upgrading their evidence state.
3. Run the generic offline fixtures and update only the capabilities they prove.
4. Run the bounded live probes and retain requested/effective route proof.
5. Feed replicated scenario and sealed coding results into the evaluator.

Do not add model-name branches to the evaluator or telemetry validator. Route-specific behavior belongs in profile data and probe evidence. Transport transformations must name their single owner so Fusion and the gateway do not both rewrite the same behavior.

## Deferred runtime work

Phase 2 may wire event creation into adapters, persist bounded receipts, and run real probes. That work must first settle persistence ownership and avoid the active R1 campaign surfaces.

Controller-forced termination remains out of scope. Telemetry and admission evidence must prove a safe boundary before a later project can design or authorize termination behavior.
