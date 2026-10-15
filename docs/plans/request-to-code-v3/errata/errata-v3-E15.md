# Errata E15: IM1 lineage closed; further obligations for IB2

Date: 2026-10-15. Precedence: E15 > E14 > E13 > E12 > E11 > E10 > E9 > v3.5.

## Verdict

- **IM1: ACCEPTED** at bc4d1a695 (repair 2 of 2). The fresh Opus reviewer and the fresh Opus adversary both returned ACCEPT. IM1 integrates at INT-3c (local picks 19149b330, a70f1304f, ca77294b6 on d028d92cb), with the core barrels exporting `ccc-planning-import-ops.ts` for engine callers (AU2, IB2). AU2 may now dispatch.

## Obligations carried to IB2 (W8), adding to E13

1. IB2 builds the import intent from exactly the stored bundle artifact's own fields:
   - `intent.bundleHash` = `bundle.bundleHash`;
   - `intent.packetHash` = `bundle.sourceHash`;
   - `intent.sidecarHash` = `bundle.sidecarHash`.

   Otherwise IM1 refuses every real intent with `IMPORT_IDENTITY_DRIFT`.
2. IB2 publishes exactly one bundle artifact and exactly one admission_facts artifact per revision, both with envelope status `complete`. IM1's reader refuses a second version at the same revision (fail-closed).
3. A link refused with `IMPORT_IDENTITY_DRIFT` can only fire after the importer has committed. IB2's RECONCILE maps it to `failed` / `CCC_PLANNING_IMPORT_IDENTITY_DRIFT` and never retries the link.
4. IM1 checks only the shape of the intent's target fields (targetRepository, targetBase, targetHead, executionPolicyDigest, closureDigest, buildTransitionRef). It does not compare them with the anchor. IB2 must not assume IM1 checked them; IB2 derives them from the anchor and G6's outputs.

## Recorded, not blocking

- The link compares the import row's `bundle_hash` and bounds, but not `packet_hash`, `sidecar_hash` or `target_base`. This is a cheap defence-in-depth candidate for a later core planning card.
- The `link-transfers-allocation` mutant is killed only by a database CHECK failure, not by a receipt assertion.
