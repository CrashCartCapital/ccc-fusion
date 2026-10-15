# CONTRACT-v3 errata E2: leader adjudication of W1 round 2 and the v3+E1 contract review

Date: 2026-10-14. Binding on top of CONTRACT-v3.md and errata-v3-E1.md. Where they disagree, E2 wins over E1, and E1 wins over v3. Every item names the card that applies it. Items marked **R2** are the final repair, repair 2 of 2, for that card's lineage.

## Verdicts after round 2
- **P0 (proof runner): ACCEPTED** at `e3f459740`. The optional notes go to the P0 follow-up list (E2-30).
- **K1, S0, X1: REPAIR, repair 2.** Each is the lineage's final repair. If the final bytes still fail review, the leader re-plans the card. A fourth attempt is never dispatched.

## Contract amendments (apply to v3.1; later cards build against these)
- **E2-1 (B1, card P1): slot advance after a provider error.**
  - The item-42 "throw instead of advance" rule applies only to a held decision with `refused_known_effect`, or another route refusal.
  - A `proved_failed` terminal hold advances `nextSlot`, as D10 requires.
  - P1 RED: a provider error then a retry in one planning session yields dispatch keys `["pi-stream:1","pi-stream:2"]`. The existing refusal RED stays as the negative case.
- **E2-2 (B2, card BF): cancel versus failure.** Add a BF mapping row, checked before the generic failed row.
  - When it applies: the linked item ends `failed`, `manual-required` or `cancelled`, and either the run has `control_request='cancel'` or its latest refusal code is `control-pending`.
  - What happens: the run maps to `cancelling` then `cancelled`, with the cancel reason, never `CAMPAIGN_FAILED`.
  - BF RED: a refusal lands before the 2 s runtime tick, and the run still ends `cancelled`.
- **E2-3 (B3, cards L1 and BF): build cancel from any linked state.**
  - `recordCccPlanningBuildControl` stores `control_request='cancel'` for every linked non-terminal state that has an allowed `→cancelling` pair. In any other state it refuses with `CCC_PLANNING_CONTROL_STATE_INVALID`.
  - The applier `applyCccPlanningPendingBuildCancels` and the BF mapping use the run's current state as the transition source, never the literal `building`.
  - One CB RED per non-building linked state that has the pair, for example `awaiting_execution_authority` and `blocked_provider`.
- **E2-4 (B4, cards CL1 and L1): actor length.** `--actor` is trimmed and must be 1 to 200 characters. Anything else is a CLI `usage_error` (exit 2) before any read or write. L1 also refuses an actor over 200 characters, as defence in depth. The CB RED becomes: a 2,000-character actor gives exit 2 `usage_error` with no row changed, and a 200-character actor succeeds with `operator:<actor>` stored unchanged in the audit agentId.
- **E2-5 (B5, cards WR, BF and H1): writer closure unconfirmed.**
  - New terminal refusal code `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED`. BF maps it to `blocked`, with the item `manual-required`.
  - When `CccConfinementClosureError` reaches the WR call site, WR performs the quarantine:
    - it moves the attempt's write roots to `<fusionDir>/quarantine/<attemptKey>/`, a rename on the same volume;
    - it writes a `quarantine.json` holding the attempt key, the closure record and a timestamp;
    - it does not commit;
    - the graph executor gets a `PermanentError("ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED")`, so there is no retry on that worktree.
  - Any later attempt uses a fresh worktree.
  - The E1-18 listener clause is dropped: no long-lived admitted listener exists, because `acquireCccSemanticProofLoopbackPort` closes its probe listener.
  - WR RED: an injected closure error yields the quarantine directory, no commit and the permanent error.
- **E2-6 (B6, card X1): absolute lsof.** See E2-22.
- **E2-7 (B7, cards X1 and C2): one shared write predicate.** X1 exports one predicate (E2-23). C2's `createCccConfinedFsOperations` (write and edit) and grep's path filter must call it, so both shells refuse a `.git` path segment and every effective denied name. C2 RED: a write or edit to `<root>/sub/.git/config` and to a denied-name file is refused, and a sibling ordinary file is accepted as the positive control.
- **E2-8 (B8, card S0): check line.** S0's Check line and `cards/s0.mjs` include `packages/core/src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts`. This is already applied in `063e4a287`; v3.1 updates the text.
- **E2-9 (N1, card L1): role class at claim.** The L1 claim refuses with `CCC_PLANNING_ROLE_CLASS_MISMATCH` in two cases:
  - a `reReviewers` entry whose role is not reviewer-class;
  - a `repairAuthors` entry whose role is not author-class.

  One RED per list.
- **E2-10 (N2, card WR): outside regression check.** `ccc-campaign-proof-execution.test.ts` is an outside regression check. It stays out of `cards/wr.mjs`, and its runtime `it.skip` is outside P0's static policy, because P0 scans only the files listed in an inventory.
- **E2-11 (N3, card X1): test-only seam.** `qualifyCccConfinedShell(i: Readonly<{ toolchain; scratchRoot; testOnly?: Readonly<{ sealedEnvironment?: (sealed: Readonly<Record<string,string>>) => Readonly<Record<string,string>>; lsofPath?: string }> }>)`. Production never passes `testOnly`. See E2-21.
- **E2-12 (N4, D12 note, card X1): toolchain clone.** E1-18 overrides ADR C on two points: the toolchain is a per-instance clone, and closure authority is a controller-side sweep. The reason is the X1 review's P4 and P6 escapes; an in-sandbox reaper can be killed or frozen by the command. Clone location, hash check and cleanup are in E2-24.
- **E2-13 (N5, card GG): path comparison.** GG compares paths with K1 `cccPlanningPathComparisonKey` (as amended by E2-40). GG RED: an equivalent spelling (case, NFC/NFD, `./`) is treated as the same path.
- **E2-14 (N6, card H1): one attempt per node.** H1 gets a single attempt through settings `maxRetriesPerNode: 1` and never edits the K1-pinned workflow IR. H1's non-vacuity check asserts the IR digest is unchanged.

## X1 final repair (R2, Opus)
- **E2-21 (adversarial required fix, E1-19 RED).** Add the `testOnly.sealedEnvironment` seam from E2-11.
  - RED: an environment builder that spreads `process.env` (with the planted canary) gives `env-scrubbed` `passed:false`, and qualification as a whole is not qualified.
  - Control: the default builder passes.
  - Add the new names to `cards/x1.mjs`.
- **E2-22 (B6) Absolute lsof.**
  - The sweep spawns `/usr/sbin/lsof` by absolute path, never by PATH lookup. Instance creation checks that it exists and is executable. If not, creation throws `CccConfinementRefusedError` with the new reason `closure-sweep-unavailable`.
  - A sweep spawn that fails or exits non-zero with unparseable output during an exec yields `CccConfinementClosureError` (unconfirmed). It never yields confirmation.
  - REDs use `testOnly.lsofPath` (or the equivalent seam on the operations input, documented):
    - a missing path refuses at creation;
    - a stub that exits 1 yields closure-unconfirmed;
    - the real lsof is the positive control.
- **E2-23 (B7) Shared write predicate.** Export from `confined-shell.ts`:
  - `CCC_CONFINED_DEFAULT_DENIED_NAMES`;
  - `cccConfinedEffectiveDeniedNames(callerNames): readonly string[]` (the union with the defaults, de-duplicated);
  - `cccConfinedWriteRefusal(i: { path: string; writeRoots: readonly string[]; deniedNames: readonly string[] }): null | "outside-write-roots" | "git-segment" | "denied-name"`.

  The predicate resolves the path, checks containment in the write roots, any `.git` segment and every effective denied name (the basename or any segment). Name comparison folds case like K1 (E2-40). X1's own profile and validation use these exports. Add unit tests with positive controls.
- **E2-24 (N4) Clone lifecycle.**
  - The clone lives at `<scratchRoot>/toolchains/<instanceId>/bin/`.
  - The profile denies writes to `<scratchRoot>/toolchains/` even though it sits under the scratch root.
  - After cloning, each clone's sha256 must equal its sealed sha256 before the first exec. A mismatch is `toolchain-digest-drift`.
  - `createCccConfinedBashOperations` returns `BashOperations & { dispose(): Promise<void> }`. `dispose` is idempotent, removes the instance's clone directory with `fs.rm` on that exact directory, and makes later execs refuse.
  - Tests:
    - a write into the clone dir from inside is denied;
    - after dispose, the dir is gone and an exec refuses.
- **E2-25 Toolchain names and refusal reasons.**
  - `CccSealedExecutable` gains an optional `name` (`^[A-Za-z0-9._+-]{1,64}$`). The clone file is named `name ?? basename(path)`, so GNU coreutils `gcat` can appear as `cat`. A duplicate effective name refuses with `toolchain-digest-drift`.
  - Add the reason `platform-binary-in-toolchain` and use it instead of reusing `toolchain-digest-drift` for Apple platform binaries.
  - RED: a utility sealed from `gcat` with name `cat` runs as `cat` inside.
- **E2-26 Evidence the repair must report.**
  - (a) Whether a CPU-bound command (`node -e 'for(;;){}'`) is killed by RLIMIT_CPU within `cpuSeconds` plus slack. Explain the deviation note that "a loop calling process.cpuUsage() escapes RLIMIT_CPU". If RLIMIT_CPU is unreliable on this host, say so; the wall ceiling is then the binding bound, and the risk table gets a row.
  - (b) Run `ccc-campaign-proof-execution.test.ts` on Darwin, with `--project=engine-default`, against `dbe834b82` and against your HEAD. Report both counts as the no-behaviour-change proof for the `runCccSemanticProofSandboxedProcess` delegation.
  - (c) Filter the closure record's `killed` list to pids the controller confirmed as instance processes, meaning their text segment is in the clone directory. The P7 foreign-zombie pid must not appear. Add a test if one can be made deterministic; otherwise report it.
- **Out of scope for X1, now card X1b (W3):** toolchain discovery and package-command compatibility. X1b finds non-platform (Homebrew) bash, sh, node, git, task, rg and GNU coreutils/grep/sed/findutils/gawk/diffutils, and seals them with unprefixed names. It provides wrappers with toolchain shebangs, plus a `BASH_ENV` dispatcher that runs `node_modules/.bin` shims through the toolchain `sh` and sets `npm_config_script_shell`. Missing required tools refuse G0 with an explicit code. The I2 target is pure `node --test` with Taskfile, so I2 needs only discovery and unprefixed names. The shim layer is required before the I3 held-out cases.

## K1 final repair (R2, Opus)
- **E2-40 (adversarial required fix): case folding.** `cccPlanningPathComparisonKey(p)` = posix-normalized `p.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")`. On this host's APFS volume, this merges every pair the filesystem merges: ß/ss, ς/σ, ﬁ/fi, Kelvin K/k, İ/i̇, NFC/NFD and A/a. Its one over-refusal, I/ı, is accepted as fail-closed.
  - REDs for the ß/ss, ς/σ and ﬁ/fi pairs, both across tasks and as duplicates within one task.
  - Document the I/ı over-refusal in the test name.
- **E2-41 Verifier bundle and control paths.**
  - Bundle file paths and control-file paths are de-duplicated on the comparison key.
  - They refuse a `.git` segment, a `.env`/`.env.*` basename and any `CCC_PLANNING_DENIED_NAMES` segment, reusing the owned-path reason helper.
  - REDs: `.git/hooks/post-checkout`; the `Taskfile.yml` + `taskfile.yml` pair; an NFC/NFD pair; `.env`. Control: an ordinary harness path.
- **E2-42 Denied names.** Owned paths and write roots also refuse any segment equal (folded) to a `CCC_PLANNING_DENIED_NAMES` entry. Add `.envrc` to that list.
  - REDs: `.npmrc`, `_secrets/x`, `.agentsecrets`, `.envrc`.
  - Controls: `src/env.mjs`, `docs/secrets-guide.md`.
- **E2-43 Proof results.**
  - The `state`/`exitCode` consistency mirrors the proof-attempt store exactly (`packages/core/src/.../proof-attempt.ts` near :1131; read it and copy its rule).
  - `proofIds` and `results[].proofId` must match `CCC_PLANNING_PROOF_ID_PATTERN`.
  - Task-plan `proofIds` must match it too.
  - REDs for each, with controls.
- **E2-44** `computeCccPlanningClosureDigest` maps canonical-JSON failures to `CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID")`. RED: a ref with digest `undefined`.
- **E2-45** Deep-freeze `CCC_PLANNING_PREFLIGHT_LINEAGES`, `CCC_PLANNING_DENIED_NAMES`, `CCC_PLANNING_SOURCE_POLICY_I2` and every other object that feeds `cccPlanningPolicyDigest`. RED: a mutation attempt throws in strict mode, and the digest is unchanged.
- **E2-46** The task-plan "write root inside owned paths" check uses the comparison key. `SRC/a.mjs` with owned `src/a.mjs` counts as inside. RED plus control.
- **E2-47** The turn-key derivation refuses, at runtime, any ordinal outside the typed range. RED: ordinal 4.
- **E2-48 Check line for test types.** K1 owns a new `packages/core/tsconfig.ccc-planning-tests.json`. It extends the core tsconfig, sets noEmit, and includes only the K1 test files and their sources. The K1 check line adds `pnpm --filter @fusion/core exec tsc -p tsconfig.ccc-planning-tests.json`. Positive control: a deliberately wrong fixture type fails it. Report that, then revert it.

## S0 final repair (R2, Sonnet build, Opus review)
- **E2-60 (adversarial fix 1): import foreign key and promotion.**
  - In 0042, declare `ccc_planning_runs_import_fkey ... DEFERRABLE INITIALLY IMMEDIATE`, matching the task foreign key and the 0037 precedent. Keep the Drizzle comment in sync.
  - Regression test: a stand-in project partition that holds one `ccc_prd_imports` row, and no anchor, is promoted with 0042 and 0043 present. The row moves to the real id.
- **E2-61 (adversarial S4): typed refusal for planning rows.** `fn plan start` requires a registered `--project`, so anchors should never sit under a stand-in id. As defence in depth, promotion (`migration-stamping.ts`, granted to S0 by this erratum) first checks the stand-in partition for any `ccc_planning_runs` row or any `task_documents` key with the `cccplan-` prefix. If it finds one, it throws `ProjectPartitionRekeyError` with the new typed reason `planning-rows-present`. Startup then falls back gracefully instead of refusing the project.
  - RED: a stand-in partition with an anchor gives that typed reason, not `CCC_PLANNING_ANCHOR_IMMUTABLE`.
  - Read `startup-factory.ts:1194-1205` and confirm the fallback path in the report.
- **E2-62 (adversarial fix 2): audit metadata.** Before insert, `recordPlanningRunAuditEvent` normalizes metadata by recursively dropping object properties whose value is `undefined`, which matches how jsonb stores them. It then canonicalizes before the INSERT, so any other non-JSON value is refused on the first write with no row written. Use the same refusal mechanism as the malformed-eventId check.
  - REDs:
    - an optional field set to `undefined`, written once and then replayed exactly, returns the persisted event;
    - a `Date` or `BigInt` value is refused on the first write, and no row exists afterwards.
- **E2-63 (adversarial fix 3): guard ordering.**
  - The 0042 guard compares every immutable identity column with `IS DISTINCT FROM`.
  - Rename the trigger to `zz_ccc_planning_runs_guard`, so it fires after `fusion_assign_project_id`, as 0043 does.
  - RED: an UPDATE setting `project_id = NULL` is refused. The explicit project change stays as the paired control.
  - Update every test that names the trigger.
- **E2-64 Deadline check.** Add `CHECK (deadline_at IS NULL OR deadline_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$')` (adjust to the column's real name and type), plus the same for any other text timestamp that the spend check casts.
  - RED: `'tomorrow'` and `'infinity'` are refused.
  - Control: an ISO `toISOString()` value is accepted.
- **E2-65** `expectPermissionDenied` matches SQLSTATE 42501 and the table name only, not the English message text.
- **Declined (accepted residual risk):** a BEFORE DELETE trigger on the anchor. Owner and bypass connections are the trusted migration and startup paths; the runtime role cannot delete (E1-15).
- **Note:** 0042 was edited in place. No database outside disposable test clusters ever booted `0719c0e98`.

## P0 follow-up list (not dispatched now; folded into the next card that touches the runner)
- **E2-30** Three items:
  - set `postgres.stopError` to `"unknown: supervisor failed"` when the supervisor throws;
  - change `blank()` to `blankLiteral()` at `ccc-closed-vitest-results.mjs:429`;
  - correct the types-header wording (E1-3 versus E1-4, CONTRACT-v3 citation).

## Integration rules for INT-1 (parent)
- **E2-80 Merge order.** P0, then K1, then S0, then X1, each cherry-picked as its exact accepted range.
  - The core barrel `packages/core/src/index.ts` gains `export * from "./ccc-planning/index.js";`, with a new `ccc-planning/index.ts` exporting the K1 modules.
  - `schema/index.ts` exports `schema/ccc-planning.ts` (E1 carry-forward), not `project.ts`.
- **E2-81 Denied-name check.** INT adds one consistency test asserting X1 `CCC_CONFINED_DEFAULT_DENIED_NAMES` ⊇ K1 `CCC_PLANNING_DENIED_NAMES`.
- **E2-82 W2 base.** W2 cards may start from the INT-1 snapshot holding the round-2 bytes of K1, S0 and X1. The round-3 changes are internal behaviour, not interface changes, except for the additive X1 exports and `name`, which W2 does not consume. Before review, each W2 leaf rebases onto the integration head that holds the final W1 bytes, and its card check is re-run.
