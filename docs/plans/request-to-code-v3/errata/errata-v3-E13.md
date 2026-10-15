# Errata E13: W4a verdicts; IM1 final repair; obligations for IB2

Date: 2026-10-14. Precedence: E13 > E12 > E11 > E10 > E9 > v3.5.

## Verdicts

- **CL1: ACCEPTED** at 04ba56649 (normal lane; repair 1 review ACCEPT). It integrates at INT-3b.
- **IM1: REPAIR** at eab1819f7. Repair 1's review accepted it, but repair 1's adversary found one blocking fail-open. IM1 goes to **repair 2 of 2 (final)**, then a fresh critical review (Opus reviewer plus Opus adversary). If that fails, the leader re-plans as IM1z.

## IM1 repair 2 (binding)

1. **The bounds identity is tied to the imported bundle** (adversary, adopted). Each part below gets a RED that fails on eab1819f7 and a passing twin.
   - (a) `recordCccPlanningImportIntent` refuses `CCC_PLANNING_IMPORT_IDENTITY_DRIFT`, before the CAS, unless the stored bundle artifact's own `bundleHash` equals `intent.bundleHash`. The same applies to `sourceHash` against `intent.packetHash` and to `sidecarHash` against `intent.sidecarHash`, wherever the stored bundle carries those fields.
   - (b) `linkCccPlanningImport` selects `ccc_prd_imports.canonical_bundle->'bounds'`. Before the UPDATE, it refuses `IMPORT_IDENTITY_DRIFT` unless those bounds canonically equal `{maxRequests, maxDurationMs, maxConcurrency}` of `intent.limits`. The adversary's X1 reproduction (scratchpad/adv2-im1) becomes the RED.
2. **Only a complete artifact may be the bounds source** (review and adversary notes, adopted fail-closed). The bundle and admission_facts artifacts that IM1 reads must have envelope status `complete`. Any other status refuses `IMPORT_IDENTITY_DRIFT`.
   - RED: a `refused` bundle artifact.
   - Control: the same bundle with status `complete`.

Not in scope (recorded): the link's handling of import-row states, which belongs to the bridge's RECONCILE in ADR B (IB2/AU2), and the untested defence-in-depth refusals listed in the reviewers' notes.

## Obligations carried to IB2 (W8)

- IB2 publishes admission_facts as JSON whose `bounds` deep-equals the full five-field `intent.limits`: maxRequests, maxDurationMs, maxConcurrency, boundsComputedAt and clamps.
- `CccPlanningImportClosure` lives in core (`ccc-planning-import-ops.ts`). IB2 imports it from `@fusion/core`.
- The receipt slot is `import-receipt-v01`. The release value passed to the link must be deterministic across a crash and restart, because a link replay with a different value is permanently `ARTIFACT_SLOT_CONFLICT`.
