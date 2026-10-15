# ADR B — Planning artifacts, the import bridge, admissibility and Spec-ready output

- Status: Proposed (design only; nothing implemented, nothing run)
- Date: 2026-10-13
- Target: PRD v3 (`docs/plans/2026-10-13-ccc-fusion-request-to-code-prd-v3.md`), increments I1 (store) and I2 (bridge)
- Code base read: worktree `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3`, HEAD `589c293c7` (origin/main `d5fd9e87d` plus one docs commit). Every `path:line` below is relative to that worktree.
- Fixed decisions honoured: Fusion native workflows, project PostgreSQL, embedded Pi 0.81.1, no new database, no second execution authority, dashboard last, I2 = installed-CLI Build on an owned disposable target with the three exact pins.

## How to read this

Each question gets: the decision, the code evidence, rejected alternatives, exact signatures/SQL, files that change, RED tests (with what makes each one non-vacuous), and risks. Section 5 lists cards with disjoint file ownership. Section 6 lists what this ADR assumes from sibling ADRs (run driver, budget/reservations, Pi seam, verifier preparation).

---

## Q1. Where semantic artifacts and their envelope live, and how immutability is enforced

### Decision

1. **Content and envelope live in the planning task's own task documents** (`project.task_documents`), one document per artifact, under a reserved key prefix `cccplan-`. The envelope is the row's `metadata` jsonb. The row's `author` column is `ccc-planning:<roleId>` so the existing documents view shows truthful authorship. No new table.
2. **Immutability is enforced natively by one PostgreSQL trigger** on `project.task_documents` (migration `0042`). For any row whose key starts with `cccplan-` it:
   - refuses every `UPDATE` and every `DELETE` (including cascades from a task hard-delete);
   - refuses an `INSERT` unless the transaction set `fusion.ccc_planning_publication = 'on'` (only the publication function sets it), so the generic upsert, the chat tool and the dashboard route cannot forge or overwrite an artifact;
   - recomputes `sha256` of the stored bytes and refuses a mismatch with the envelope's `outputDigest`;
   - refuses a stale fence (the work-item lease must be `running`, same owner, same attempt, unexpired by `clock_timestamp()`);
   - refuses inputs that are not already-published planning artifacts of the same task with the declared digest (input closure);
   - refuses a `design` artifact whose transitive input closure contains any other `design` artifact (sealing);
   - enforces one run per planning task (first artifact must be the run's `admission` artifact; all later ones carry the same `runId`).
3. **Slot uniqueness reuses the existing unique constraint** `task_documents_task_id_key_unique (project_id, task_id, key)` (`packages/core/src/postgres/schema/project.ts:1009`). A slot is encoded in the key, so "one content per slot" is already a database guarantee.
4. **Status is an immutable producer outcome** recorded at publication (`complete | infeasible | blocked | refused`). "Current", "superseded" and "invalidated" are derived on read (higher version in the same slot, or a later `invalidate` artifact naming it). Nothing is ever flipped in place.
5. **Run-audit events carry only bounded fields** (key, stage, slot, version, digest, input count, role, status), written in the same transaction through the existing `recordRunAuditEventWithinTransaction`.

### Evidence

- Task documents are the native workflow artifact store already. Native workflow IR declares `artifacts` and the workflow runtime checks them as task documents by key (`packages/engine/src/workflow-task-runtime.ts:1045-1060`). The importer writes campaign documents into the same table (`packages/core/src/ccc-prd/importer.ts:1111-1128`). The dashboard already lists, reads, shows revisions and deletes them (`packages/dashboard/src/routes/register-task-workflow-routes.ts:3938-3977`, `:4115-4121`).
- Today they are mutable: `upsertTaskDocument` archives then overwrites (`packages/core/src/task-store/async-comments-attachments.ts:192-301`); `deleteTaskDocument` deletes revisions then the row (`:500-531`). The only native guard is compare-and-set: `expectedRevision: 0` means "must be absent" (`packages/core/src/task-document-concurrency.ts:139-159`). Callers may omit it (`:27`, "Omitted expectations retain the legacy unconditional write contract").
- Writers that can reach any task's documents: the chat `fn_task_document_write/read` with an explicit `task_id` (`packages/engine/src/agent-tools.ts:1862-1896`); the session-bound tools (`:1704-1750`); dashboard upsert/delete routes (`register-task-workflow-routes.ts:4027`, `:4121`).
- No immutability trigger exists anywhere: migrations only define project-id assignment triggers and RLS (`packages/core/src/postgres/migrations/0016_import_translation_cache_scope_fix.sql:11-42`, `0034_ccc_effect_receipts.sql:46-69`).
- Transaction-local GUC as a native signal is an existing pattern: `set_config('fusion.project_bypass','on', true)` (`packages/core/src/async-configuration-revision-store.ts:97`).
- The fenced-write pattern already exists: lock the work item `FOR UPDATE` with state/owner/attempt/unexpired lease, then write in the same transaction (`packages/core/src/task-store/workflow-workitems-ops-2.ts:389-430`; read-only variant `:56-90`).
- PostgreSQL is 15 (`packages/core/package.json:67`), so `sha256(bytea)` is built in.
- Canonical digest convention: `canonicalCccPrdJson` + sha256 of its UTF-8 (`packages/core/src/ccc-prd/contract.ts:100-108`).
- Task documents are database-only; nothing projects them to disk (searched `packages/core/src` for document directories: none).

### Rejected alternatives

- **`project.artifacts` table**: primary key is `id` alone with no project partition and its task foreign key ignores project (`project.ts:1013-1034`); content is updated in place (`updateArtifact`); `fn_artifact_list/view` expose every task's artifacts to any agent holding them (`agent-tools.ts:1930-1960`), which breaks sealing; binary payloads live on disk outside database custody.
- **New insert-only envelope table**: needs its own RLS, grants, Drizzle schema, projection and dashboard routes, and the task-document trigger would still be needed so the generic paths cannot shadow it. It adds a parallel store for zero additional guarantee; PRD §3 says store semantic content in task documents/artifacts.
- **Hybrid (content in documents, envelope in a new table)**: two rows that must stay atomic, plus all the cost above.
- **Revoke UPDATE/DELETE from `fusion_runtime`**: breaks ordinary documents for every task (`0006_project_ownership.sql:90` grants all four verbs).
- **Restrictive RLS policy for UPDATE/DELETE**: RLS filters silently. The generic upsert would archive a revision, update zero rows, then read back the old row and report success. A raised error is required.
- **Immutability checked only in TypeScript**: any path that skips the helper (chat tool, dashboard, a future caller) would mutate silently.

### Digest rules (exact)

- `outputDigest` = lowercase hex sha256 of the exact UTF-8 bytes stored in `content`.
  - JSON artifact: `content = canonicalCccPrdJson(value)` (no trailing newline). So `outputDigest === sha256(canonicalCccPrdJson(value))`, the same convention as `bundleHash` and `packetHash`.
  - Text artifact (original request, final PRD, technical annex, admission facts): `content` is the bytes decoded with `new TextDecoder("utf-8", { fatal: true })`. No newline or whitespace normalization. Bytes containing NUL or invalid UTF-8 are refused at publication (`CCC_PLANNING_ARTIFACT_NOT_UTF8`), because PostgreSQL `text` cannot store NUL and lossy decoding would change the bytes.
  - The trigger recomputes `encode(sha256(convert_to(content,'UTF8')),'hex')`. The existing `taskDocumentContentHash` result is always `"sha256:" + outputDigest` (`task-document-concurrency.ts:29-31`).
- `inputs` = array of `{ artifactKey, digest }` sorted by key; every digest is the input's `outputDigest`.
- `identityDigest` = sha256 of the canonical envelope without `fence`, `publishedAt` and `identityDigest`. It decides replay versus conflict.
- `closureDigest(key)` = sha256 of the canonical sorted set of `(artifactKey, digest)` over the transitive input closure, computed on read. Spec-to-Build reuse compares this ("identical complete input closure", PRD §8).
- A text artifact that becomes a packet source has `outputDigest` equal to that source's manifest `sha256` (custody hashes raw file bytes, `packages/engine/src/ccc-prd/custody.ts:228-262`). That equality is the non-circular anchor used in Q2.

### Publication semantics

- **Fence-guarded:** in one `transactionImmediate`: lock the planning task row `FOR UPDATE` (same as `upsertTaskDocument`), then lock the work item `FOR UPDATE` with the fence predicate (same as `recordFencedCccCampaignProofAuditImpl`). The trigger re-checks the fence as a backstop.
- **Idempotent:** if the key exists, then the same `identityDigest` returns the existing `{id, replayed: true}` and writes nothing. A different `identityDigest` throws `CCC_PLANNING_ARTIFACT_SLOT_CONFLICT`. Same bytes from a different producer or different inputs is a different provenance claim, so it conflicts rather than silently aliasing the first producer's receipt. A concurrent unique-violation (`23505`) is re-read and mapped the same way.
- **Input closure:** every input must already be published in this task with that digest. Checked in TypeScript for a readable message and in the trigger as the enforced gate.
- **Admission:** the first artifact of a run (`stage = admission`) carries `fence: { kind: "admission" }` and is written by the run-admission transaction (sibling ADR) through `publishCccPlanningArtifactWithinTransaction`. The trigger allows a fence-less insert only when it is the first planning artifact on that task.

### Sealing: why designer A cannot read designer B before both publish

Every path by which a model could see an artifact, and how each is closed:

1. **Packet path (the only intended path).** The controller builds a role's prompt from the artifact's declared `inputs` and nothing else. The trigger refuses a `design` artifact whose transitive input closure contains another `design`, so B's packet can contain neither A nor anything derived from A (for example a review of A).
2. **Document tools.** `fn_task_document_read` (session-bound, `agent-tools.ts:1740-1750`), chat `fn_task_document_read` (`:1892`), `fn_artifact_*` (`:1930-1960`), and `fn_task_show/list` must be absent from every planning role session. The planning task's description and PROMPT must hold only fixed run text, never artifact content. The closed per-role allowlist is owned by the Pi-seam ADR; it must override a permissive caller (the readonly allowlist alone admits `fn_task_show`, `fn_task_list`, `WebFetch`, `fn_web_fetch`, `workflow-step-tool-policy.ts:4-18`).
3. **Generic workflow injection.** Code nodes receive every task document (`packages/engine/src/executor.ts:7287-7293`). The planning task never runs a generic workflow or code node; its stages are planning-controller stages only (planning-task guard, sibling ADR).
4. **Filesystem.** Documents are database-only. The compile scratch packet (Q2) holds only request, admission facts, PRD and annex, which are produced after both designs are published. Pi session files for planning roles must live outside every role's read roots, and `read/grep/find/ls` must refuse realpath escapes (Pi-seam ADR).
5. **Loopback HTTP.** A web-capable role (researcher) must not reach the dashboard API on loopback. Designers get no web tool.
6. **Timing.** The cross-examination stage takes both designs (or one design plus a published `infeasible` artifact) as inputs. Its packet cannot be built before both exist, because inputs must already be published.

### SQL (migration `packages/core/src/postgres/migrations/0042_ccc_planning_artifact_guard.sql`)

```sql
-- FNXC:CccPlanningArtifacts 2026-10-13:
-- Planning artifacts are ordinary task documents under the reserved key prefix
-- 'cccplan-'. This trigger makes them insert-once, fence-guarded, digest-checked,
-- closure-checked and design-sealed. Ordinary documents are untouched.
CREATE OR REPLACE FUNCTION project.ccc_planning_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  envelope jsonb;
  fence jsonb;
  input_ref jsonb;
  admission_run_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be deleted', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.key LIKE 'cccplan-%' OR NEW.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be updated', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.key NOT LIKE 'cccplan-%' THEN
    RETURN NEW;
  END IF;
  IF current_setting('fusion.ccc_planning_publication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED: % is a reserved planning artifact key', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  envelope := NEW.metadata;
  IF envelope IS NULL
     OR jsonb_typeof(envelope) <> 'object'
     OR envelope->>'schema' IS DISTINCT FROM 'ccc-planning.artifact-envelope.v1'
     OR envelope->>'artifactKey' IS DISTINCT FROM NEW.key
     OR coalesce(envelope->>'runId', '') = ''
     OR coalesce(envelope->>'stageId', '') = ''
     OR jsonb_typeof(envelope->'inputs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(envelope->'fence') IS DISTINCT FROM 'object'
     OR NEW.revision <> 1
     OR NEW.author IS DISTINCT FROM ('ccc-planning:' || coalesce(envelope->'producer'->>'roleId', '')) THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  IF octet_length(NEW.content) > 4194304 THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_TOO_LARGE: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  IF envelope->>'outputDigest' IS DISTINCT FROM encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH: %', NEW.key USING ERRCODE = 'P0001';
  END IF;

  SELECT d.metadata->>'runId' INTO admission_run_id
    FROM project.task_documents d
   WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
     AND d.key LIKE 'cccplan-%' AND d.metadata->>'stageId' = 'admission'
   LIMIT 1;

  fence := envelope->'fence';
  IF envelope->>'stageId' = 'admission' THEN
    IF fence->>'kind' IS DISTINCT FROM 'admission' OR EXISTS (
      SELECT 1 FROM project.task_documents d
       WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key LIKE 'cccplan-%') THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_RUN_MISMATCH: admission must be the first planning artifact on task %', NEW.task_id
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF admission_run_id IS NULL OR admission_run_id IS DISTINCT FROM envelope->>'runId' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_RUN_MISMATCH: % does not belong to the run admitted on task %', NEW.key, NEW.task_id
        USING ERRCODE = 'P0001';
    END IF;
    IF fence->>'kind' IS DISTINCT FROM 'work_item_lease' OR NOT EXISTS (
      SELECT 1 FROM project.workflow_work_items w
       WHERE w.project_id = NEW.project_id
         AND w.id = fence->>'workItemId'
         AND w.task_id = NEW.task_id
         AND w.run_id = fence->>'runId'
         AND w.state = 'running'
         AND w.lease_owner = fence->>'leaseOwner'
         AND w.attempt = (fence->>'attempt')::integer
         AND w.lease_expires_at IS NOT NULL
         AND w.lease_expires_at::timestamptz > clock_timestamp()) THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: %', NEW.key USING ERRCODE = 'P0001';
    END IF;
  END IF;

  FOR input_ref IN SELECT value FROM jsonb_array_elements(envelope->'inputs') LOOP
    IF NOT EXISTS (
      SELECT 1 FROM project.task_documents d
       WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
         AND d.key LIKE 'cccplan-%'
         AND d.key = input_ref->>'artifactKey'
         AND d.metadata->>'outputDigest' = input_ref->>'digest') THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED: % requires % at %',
        NEW.key, input_ref->>'artifactKey', input_ref->>'digest' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF envelope->>'stageId' = 'design' AND EXISTS (
    WITH RECURSIVE closure(artifact_key) AS (
      SELECT value->>'artifactKey' FROM jsonb_array_elements(envelope->'inputs')
      UNION
      SELECT parent.value->>'artifactKey'
        FROM closure c
        JOIN project.task_documents d
          ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
        CROSS JOIN LATERAL jsonb_array_elements(d.metadata->'inputs') AS parent(value)
    )
    SELECT 1 FROM closure c
      JOIN project.task_documents d
        ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
     WHERE d.metadata->>'stageId' = 'design'
  ) THEN
    RAISE EXCEPTION 'CCC_PLANNING_DESIGN_SEAL_BROKEN: % may not depend on another design', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- PostgreSQL fires BEFORE row triggers in name order. The 'zz_' prefix makes this
-- run after any project-id assignment trigger, so NEW.project_id is final.
DROP TRIGGER IF EXISTS zz_ccc_planning_artifact_guard ON project.task_documents;
CREATE TRIGGER zz_ccc_planning_artifact_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project.task_documents
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_artifact_guard();
```

Notes: the recursion terminates because `UNION` removes duplicates and inputs must already exist (no cycles). Ordinary documents pay one `LIKE` test per write.

### TypeScript (new)

`packages/core/src/ccc-planning/artifacts.ts` (pure, no I/O):

```ts
export const CCC_PLANNING_ARTIFACT_KEY_PREFIX = "cccplan-" as const;
export const CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA = "ccc-planning.artifact-envelope.v1" as const;
export const CCC_PLANNING_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

export type CccPlanningStageId =
  | "admission" | "intent" | "research" | "srcverify" | "design" | "decision"
  | "spec" | "plan" | "verifier" | "review" | "receipt" | "specready"
  | "build" | "import" | "invalidate";

export type CccPlanningArtifactKind =
  | "original_request" | "admission_grant" | "acceptance_cases" | "repository_snapshot"
  | "research_evidence" | "extraction" | "source_verification" | "design_alternative"
  | "design_review" | "decision_record" | "objection" | "requirement_map" | "final_prd"
  | "technical_annex" | "task_plan" | "routing_plan" | "verifier_bundle" | "verifier_audit"
  | "oracle_observation" | "product_review" | "technical_review" | "oracle_review"
  | "adjudication" | "model_receipt" | "budget_receipt" | "spec_ready" | "build_grant"
  | "build_transition" | "admission_facts" | "packet_manifest" | "sidecar" | "bundle"
  | "execution_plan" | "authorship_receipt" | "import_intent" | "import_receipt" | "invalidation";

export type CccPlanningArtifactSlot = Readonly<{
  runRevision: number;  // 1..999
  stageId: CccPlanningStageId;
  slot: string;         // /^[a-z0-9]{1,20}$/
  version: number;      // 1..99
}>;

export type CccPlanningArtifactRef = Readonly<{ artifactKey: string; digest: string }>;

export type CccPlanningArtifactStatus = "complete" | "infeasible" | "blocked" | "refused";

export type CccPlanningArtifactProducer = Readonly<{
  kind: "model" | "controller";
  roleId: string;               // FULL-v2 role id, or "controller"
  instanceId: string;           // fresh session/attempt identity
  attemptRef?: string;          // reservation identity from the budget ADR
  requestedModel?: string;      // exact id, e.g. "glm/glm-5.3"; required when kind === "model"
  resolvedModel?: string;       // from the terminal route receipt; required when kind === "model"
  routeReceiptDigest?: string;
}>;

export type CccPlanningArtifactPolicy = Readonly<{
  promptVersion: string;  promptDigest: string;
  toolPolicyVersion: string;  toolPolicyDigest: string;  // "none" for controller artifacts
}>;

export type CccPlanningPublicationFence =
  | Readonly<{ kind: "admission" }>
  | Readonly<{ kind: "work_item_lease"; workItemId: string; leaseOwner: string; attempt: number; runId: string }>;

export type CccPlanningArtifactEnvelopeV1 = Readonly<{
  schema: typeof CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA;
  artifactKey: string;
  runId: string;
  runRevision: number;
  stageId: CccPlanningStageId;
  slot: string;
  version: number;
  kind: CccPlanningArtifactKind;
  contentType: "application/json" | "text/markdown; charset=utf-8";
  contentSchema: string;
  inputs: readonly CccPlanningArtifactRef[];   // sorted by artifactKey
  producer: CccPlanningArtifactProducer;
  policy: CccPlanningArtifactPolicy;
  outputDigest: string;
  status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence;
  identityDigest: string;
  publishedAt: string;
}>;

export type CccPlanningArtifactContent =
  | Readonly<{ type: "json"; value: unknown }>
  | Readonly<{ type: "text"; bytes: Uint8Array }>;

export function encodeCccPlanningArtifactKey(slot: CccPlanningArtifactSlot): string;
  // `cccplan-r${pad3(runRevision)}-${stageId}-${slot}-v${pad2(version)}` ; always <= 64 chars
export function decodeCccPlanningArtifactKey(key: string): CccPlanningArtifactSlot | null;
export function encodeCccPlanningArtifactContent(content: CccPlanningArtifactContent):
  Readonly<{ text: string; outputDigest: string; contentType: CccPlanningArtifactEnvelopeV1["contentType"] }>;
  // throws CCC_PLANNING_ARTIFACT_NOT_UTF8 / CCC_PLANNING_ARTIFACT_TOO_LARGE
export function computeCccPlanningEnvelopeIdentityDigest(
  envelope: Omit<CccPlanningArtifactEnvelopeV1, "fence" | "publishedAt" | "identityDigest">,
): string;
export function computeCccPlanningClosureDigest(closure: readonly CccPlanningArtifactRef[]): string;
export class CccPlanningArtifactError extends Error { readonly code: CccPlanningArtifactErrorCode; }
export type CccPlanningArtifactErrorCode =
  | "CCC_PLANNING_ARTIFACT_IMMUTABLE" | "CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED"
  | "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID" | "CCC_PLANNING_ARTIFACT_TOO_LARGE"
  | "CCC_PLANNING_ARTIFACT_NOT_UTF8" | "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH"
  | "CCC_PLANNING_ARTIFACT_RUN_MISMATCH" | "CCC_PLANNING_ARTIFACT_FENCE_REFUSED"
  | "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED" | "CCC_PLANNING_DESIGN_SEAL_BROKEN"
  | "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT" | "CCC_PLANNING_POSTGRES_REQUIRED";
```

`packages/core/src/task-store/ccc-planning-artifact-ops.ts` (PostgreSQL only):

```ts
export type PublishCccPlanningArtifactInput = Readonly<{
  planningTaskId: string;
  runId: string;
  slot: CccPlanningArtifactSlot;
  kind: CccPlanningArtifactKind;
  contentSchema: string;
  content: CccPlanningArtifactContent;
  inputs: readonly CccPlanningArtifactRef[];
  producer: CccPlanningArtifactProducer;
  policy: CccPlanningArtifactPolicy;
  status: CccPlanningArtifactStatus;
  fence: CccPlanningPublicationFence;
  now?: string;
}>;

export type CccPlanningArtifactRecord = Readonly<{
  id: string;                    // task_documents.id
  key: string;
  envelope: CccPlanningArtifactEnvelopeV1;
  replayed: boolean;
}>;

export async function publishCccPlanningArtifact(
  layer: AsyncDataLayer, input: PublishCccPlanningArtifactInput,
): Promise<CccPlanningArtifactRecord>;

/** Same, inside a caller's transaction (run admission uses it for the first artifact). */
export async function publishCccPlanningArtifactWithinTransaction(
  tx: DbTransaction, projectId: string, input: PublishCccPlanningArtifactInput,
): Promise<CccPlanningArtifactRecord>;

/** Recomputes sha256 on read and compares with the envelope and, if given, expectedDigest. */
export async function readCccPlanningArtifact(
  layer: AsyncDataLayer, planningTaskId: string, key: string,
  options?: Readonly<{ expectedDigest?: string }>,
): Promise<Readonly<{ record: CccPlanningArtifactRecord; text: string }> | null>;

/** Envelopes only, no content, ordered by key. */
export async function listCccPlanningArtifacts(
  layer: AsyncDataLayer, planningTaskId: string,
): Promise<readonly CccPlanningArtifactRecord[]>;

/** Transitive closure of refs, verified against stored digests. */
export async function resolveCccPlanningInputClosure(
  layer: AsyncDataLayer, planningTaskId: string, roots: readonly CccPlanningArtifactRef[],
): Promise<readonly CccPlanningArtifactRef[]>;
```

Inside `publishCccPlanningArtifactWithinTransaction`, in order: validate and encode content; lock the task row `FOR UPDATE`; for a `work_item_lease` fence, lock the work item `FOR UPDATE` with the predicate copied from `workflow-workitems-ops-2.ts:405-418`; select the existing key and replay or conflict; verify inputs; `SELECT set_config('fusion.ccc_planning_publication','on', true)`; insert `{key, content, revision: 1, author: 'ccc-planning:'+roleId, metadata: envelope}`; reset the GUC to `''` (still transaction-local) so later statements in a shared transaction cannot inherit publisher authority; write run-audit `ccc-planning:artifact-published` (domain `database`, `runId: 'ccc-plan:' + runId`, bounded metadata). No `task:updated` event and no citation scan, matching `publishArchivedTaskDocumentAddition` (`packages/core/src/task-store/comments-ops.ts:204-227`), so scheduler state stays inert.

### Changed existing code

- `packages/core/src/postgres/schema-applier.ts`: list `0042_ccc_planning_artifact_guard.sql` (beside `:406`), add `CCC_PLANNING_ARTIFACT_GUARD_VERSION = "0042"` (beside `:177`), applied check (beside `:529`), apply block (beside `:1095-1110`), `SCHEMA_BASELINE_VERSION = "0042"` (`:66`), and the baseline-bookkeeping branch (`:1087-1093`) keeps working.
- Pinned tests that must move to `"0042"`: `packages/core/src/__tests__/postgres/schema-applier.test.ts:230-231`, `ccc-campaign-execution-authorization-migration.pg.test.ts:166`, `ccc-campaign-semantic-proof-v2-migration.pg.test.ts:65`.
- `packages/core/src/task-store/task-mutation-ops.ts:1496-1545` (`cleanupArchivedTasksImpl`): add `NOT EXISTS (SELECT 1 FROM project.task_documents d WHERE d.project_id = tasks.project_id AND d.task_id = tasks.id AND d.key LIKE 'cccplan-%')` to the archived-row select. Otherwise the trigger makes the whole sweep throw on the first archived planning task, because the loop has no per-row catch.
- `packages/core/src/index.ts` and the hand-kept `packages/core/src/index.gate.ts`: export the new module.

### RED tests (Q1)

All `.pg` tests live in `packages/core/src/__tests__/postgres/ccc-planning-artifacts.pg.test.ts` unless named. They must run under a runner that refuses silent PostgreSQL skips (sibling ADR on proof lanes).

| Test | Asserts | Why it cannot pass vacuously |
|---|---|---|
| T1.1 generic update refused | `store.upsertTaskDocument(task, {key: <planning key>, content: "x"})` throws `CCC_PLANNING_ARTIFACT_IMMUTABLE`; content unchanged; no new `task_document_revisions` row | Same test updates an ordinary key on the same task through the same call and it succeeds, so the refusal comes from the trigger, not a broken store |
| T1.2 delete refused (store and dashboard route) | `deleteTaskDocument` and `DELETE /tasks/:id/documents/:key` refuse; row and revisions intact | Control: an ordinary document on the same task deletes |
| T1.3 forged insert refused | generic upsert of a fresh `cccplan-` key with a well-formed envelope throws `PUBLISHER_REQUIRED` | The identical envelope succeeds through `publishCccPlanningArtifact` |
| T1.4 digest enforced in SQL | raw SQL insert with the GUC on, a live fence and a wrong `outputDigest` is refused | A correct-digest raw insert in the same test succeeds; plus a parity corpus (ASCII, accents, emoji, CRLF, escaped control characters) proves JS `sha256(canonicalCccPrdJson(v))` equals the SQL digest |
| T1.5 stale fence | expired lease, bumped attempt, or wrong owner refuses, both via the helper and via raw SQL with the GUC on | Control: fresh lease publishes; raw-SQL arm proves the trigger, not only TypeScript |
| T1.6 idempotency and conflict | same envelope twice gives the same id, `replayed: true`, one row, one audit event; different bytes give `SLOT_CONFLICT` with the original intact; two concurrent publishers with different bytes leave exactly one row | Row and audit counts are asserted, not just return values |
| T1.7 input closure | input key missing, or present with another digest, refuses (helper and raw SQL) | Same publish succeeds after the input is published with that digest |
| T1.8 design seal (database) | design B with input design A refuses; design B with input "review of A" (transitive) refuses | Control: design B with research-only inputs succeeds, and a cross-exam artifact (stage `decision`) with inputs A and B succeeds |
| T1.9 one run per task | second `admission` artifact refuses; artifact with another `runId` refuses | Control: same-run artifact succeeds |
| T1.10 archive sweep | an archived planning task (created first so it sorts first) and an archived ordinary task: `cleanupArchivedTasks` removes the ordinary one, retains the planning one, does not throw | Without the filter the trigger throws on the first row and the ordinary task survives, so the assertion that it was removed fails |
| T1.11 input bytes | NUL byte, invalid UTF-8 and over-4-MiB content refuse before any write | Control: a valid CRLF text artifact round-trips byte-identical (read-back sha256 equals the input bytes' sha256) |
| T1.12 session seal (engine, Pi-seam card) | designer B built through the planning role builder with a permissive caller config: effective tools exclude `fn_task_document_*`, `fn_artifact_*`, `fn_task_show/list`, web tools; a scripted call to each is refused; `read` of designer A's Pi session file is refused; a canary token placed in design A never appears in any request body captured by the fake transport | Positive control: the cross-exam packet built after both publish contains the canary, so the detector works |

### Risks (Q1)

- The trigger is global on a busy generic table. Cost is one `LIKE`. Any future bulk maintenance that updates `task_documents` (for example a project re-scope rewriting `project_id`) will fail on planning rows and must handle them explicitly.
- It is an enforced gate for every application path and for the `fusion_runtime` role. It is not a defence against the table owner (who can disable triggers) or `TRUNCATE` (owner-only; the test harness truncates at `packages/core/src/__test-utils__/pg-test-harness.ts:914`, so no truncate trigger is added).
- A planning task can never be hard-deleted while it holds artifacts. Re-using a soft-deleted planning task id with `forceResurrect` (`packages/core/src/task-store/task-id-integrity.ts:403-407`) will now fail. This is intended, but it is a behaviour change.
- The dashboard documents tab will show planning artifacts with a Delete button that errors (I5 cleanup).
- The envelope is jsonb, not typed columns. The trigger checks the load-bearing fields; TypeScript validates the rest.
- The fence clause assumes the run driver uses native work-item leases (critic point 3). If the run ADR picks another lease, the trigger fence clause and `CccPlanningPublicationFence` change together; nothing else here depends on it.
- If sibling ADRs also add migrations, one card must own `schema-applier.ts`, numbering, and the three pinned tests.

---

## Q2. The import bridge: from planner outputs to an admitted, imported campaign

### Decision (data flow)

Reuse every existing step: packet writing (from freeze), `authorCccPrdPacket`, `compileCccPrdPacket`, `createCccPrdProductExecutionPlan`, and `importCccPrdBundle`. Add three things: a deterministic packet renderer, a planning authoring adapter with truthful labels, and one shared import preflight extracted from the CLI.

1. **Four authoritative packet sources, separated by who authored them.** Attribution is by source path, so authorship is readable from any span:
   - `sources/__fusion__/planning/original-request.md` (role `original_request`): the sealed request bytes, byte-identical to the G0 `original_request` artifact.
   - `sources/__fusion__/planning/admission-facts.md` (role `support`): controller-rendered operator facts (target repository, baseline commit, admitted write roots including `<target>/.fusion`, bounds, protected actions) using the exact labels the implementation-fact binder recognizes (as `renderCccPrdOperatorContextMarkdown` does, `packages/engine/src/ccc-prd/operator-context.ts:378-420`).
   - `sources/__fusion__/planning/final-prd.md` (role `prd`): the exact bytes of the Pass-3-approved `final_prd` artifact (spec author's content plus verifier author's proof sections, rendered in intake grammar). It contains no target path, baseline or bounds, so its bytes do not change when Spec becomes Build.
   - `sources/__fusion__/planning/technical-annex.md` (role `technical_annex`): the exact bytes of the Pass-3-approved `technical_annex` artifact: generated engineering decisions with stable `DEC-` ids, per-task contracts and custody (owned paths, allowed write roots), interfaces, dependencies and the integration plan.
2. **Packet writing reuses freeze's writer.** Extract the manifest-plus-staged-rename tail of `freezeCccPrdPacket` (`packages/engine/src/ccc-prd/intake.ts:1288-1399`) into `writeCccPrdPacketFiles`, used by both freeze and planning. The packet is written under owned scratch outside the target repository and outside every role's read roots.
3. **Proposal is built deterministically** from published artifacts (requirement map, task plan, verifier bundle, admission grant) by `buildCccPlanningAuthoringProposal`. Every `sourceRefs` quote is an exact, once-only substring of a named source. Tasks cite their own annex custody lines and the admission-facts lines, as the product acceptance script does today (`scripts/ccc-prd-product-acceptance.mjs:2161-2196`). This is not a model call. The models already authored and were reviewed upstream; the converter only reformats reviewed content.
4. **Truthful authorship.** `authorCccPrdPacket` gets an adapter whose labels are derived from the producer envelopes, never typed:
   - `id = "ccc-planning.full-v2:" + sortedRoleIds.join("+") + ":" + runId + ":r" + runRevision`, for example `ccc-planning.full-v2:execution-planner+spec-author+verifier-author:<runId>:r1`.
   - `model = sortedUniqueResolvedModels.join("+")`, for example `glm/glm-5.3`. An escalated producer would show up, for example `glm/glm-5.3+minimax/MiniMax-M3`.
   - Convention matches the native adapter (`id` names the adapter, `model` is `provider/model`, `packages/engine/src/ccc-prd/native-authoring-adapter.ts:384-385`). The sidecar keeps its exact provenance keys (`compiler.ts:1392`, only non-empty strings are checked at `:1430-1436`), so no schema change.
   - Before authoring, the controller publishes an `authorship_receipt` artifact: `{proposalHash, roles: [{roleId, artifactKey, outputDigest, requestedModel, resolvedModel, instanceId}]}`. After authoring, the bridge refuses unless `sidecar.provenance.proposalHash` equals it.
5. **Source fidelity is checked against the sealed original bytes**, in two separate deterministic checks, while meaning stays a model review (PRD §3: provenance and meaning need separate checks):
   - **Anchor:** custody's sha256 of `original-request.md` must equal the G0 `original_request` artifact's `outputDigest`. The G0 artifact was published at admission, before any model ran, so nothing downstream can rewrite it.
   - **Attribution and coverage** (`checkCccPlanningSourceFidelity`):
     - every acceptance clause in the requirement map declares `derivation: request | annex`;
     - request-derived clauses must have at least one quote that resolves exactly once in the request bytes (exact match only, never the fuzzy locator) and link to G1 acceptance-case ids;
     - annex-derived clauses must cite annex `DEC-` ids and must not cite request quotes;
     - every request "unit" (each non-blank, non-heading line outside code fences, plus each fenced block as one unit, from `computeCccPrdSourceLines`, `material-coverage.ts:171`) must be overlapped by a G1 quote (acceptance case, exclusion, question or explicit context note);
     - every G1 acceptance case must map to a request-derived clause; every G1 exclusion must appear as a non-goal citing its request quote.
   - Why this extra check is needed: compile's material coverage only inventories headings and requirement tokens (`material-coverage.ts:227-289`). A plain request with no headings yields zero items, so compile alone cannot judge fidelity for it.
6. **Shared preflight.** The CLI's inline chain (`packages/cli/src/commands/prd.ts:1961-2245`) moves into `packages/engine/src/ccc-prd/product-import-preflight.ts` as two phases (below), called by both `fn prd preview|import` and the planning bridge. This keeps one implementation and preserves the CLI's exact check order.
7. **Import identity and intent.**
   - Key: `importKey = "ccc-plan:" + runId + ":r" + runRevision` (under 256 characters, `packages/core/src/ccc-prd/import-admission.ts:52-57`).
   - The final digest is bound twice, with no new table: (a) by the importer's own `(project_id, idempotency_key)` row, which pins `bundleHash`, manifest, policy, target and base and refuses any difference with `CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION` under its advisory lock (`importer.ts:1443-1489`, `:1521-1545`); (b) by the `import_intent` artifact slot `cccplan-r00N-import-intent-v01`, whose insert-once rule refuses a second digest for the same revision with `CCC_PLANNING_ARTIFACT_SLOT_CONFLICT`.
   - So "planning-run id plus final digest" is the pair (run-derived key, bound digest), and a retry with a changed digest cannot open a second campaign.
   - The bundle, execution plan, sidecar, manifest and admission facts are published as artifacts **before** `importCccPrdBundle` is called. The intent records `{idempotencyKey, projectId, bundleHash, packetHash, sidecarHash, executionPlanDigest, confirmationDigest, targetRepository, targetBase, targetHead}`.
8. **Lost acknowledgement** is reconciled through the importer's own row (`inspectCccPrdImport`, `reconcileCccPrdImport`, `importer.ts:2486-2499`, `:2685-2711`). There is no link table. After success an `import_receipt` artifact is published.

### Evidence

- The importer opens its own serializable transaction under an advisory lock (`importer.ts:2341-2367`) and is called at `:2712-2781`. It cannot share a planning transaction, which is why the intent must be durable before the call.
- The importer re-checks only custody for fresh product imports (`assertFreshProductSemanticV2`, `importer.ts:2758`). It does **not** check verifier conformance (#74), target HEAD or implementation-fact provenance. Those exist only in the CLI chain: conformance `prd.ts:2147-2157`, HEAD `:2110-2116`, provenance `:1974-1981`, budget floor `:2050`, agent confinement `:2071-2081`, semantic-proof sandbox `:2091-2094` and `:2226-2236`.
- Fixture labels: `id: "local-deterministic-fixture"`, `model: "proposal-file-v2"` (`prd.ts:3948-3952`) are copied into the sidecar provenance (`packages/engine/src/ccc-prd/authoring.ts:1275-1278`).
- `readTargetHead` uses `execFileSync` (`prd.ts:1673-1690`); engine files are scanned by the no-blocking-shellout guard, so the engine version must be async and injected.
- `resolveCccPrdSemanticProofToolchainPaths` lives in the CLI because it locates the built proof host relative to the CLI module (`packages/cli/src/commands/ccc-semantic-proof-toolchain.ts:224-277`). It must be injected into engine callers (the CLI runtime host already re-exports it, `packages/cli/src/ccc-gate2-runtime-host.ts:12-14`).
- Every authoritative source is parsed for acceptance-clause grammar (`packages/engine/src/ccc-prd/acceptance-clauses.ts:308-346`) and material coverage (`material-coverage.ts:325-417`).
- Implementation facts bind to labeled lines in any authoritative source (`authoring.ts:540-600`, labels at `:659-700`). Task custody paths must appear verbatim in the task's own quotes (`authoring.ts:185-217`).
- Import ceilings: `maxRequests <= 10,000`, `maxDurationMs <= 86,400,000`, `maxConcurrency <= 256`, `.fusion/tasks` and `.fusion/artifacts` inside admitted write roots (`import-admission.ts:86-115`).

### Rejected alternatives

- **Key = `ccc-plan:<runId>:<digest>`** (draft C9): a retry with another digest gets a fresh key and the importer creates a second campaign (critic point 7).
- **Separate `ccc_planning_import_links` table**: duplicates the importer's key row, and still cannot commit atomically with the importer.
- **Reusing the CLI fixture adapter**: records model-written content as file-authored.
- **Having a model write the sidecar** (native authoring adapter): an extra model call whose job is quote copying (the August GLM 5.2 failure mode). Deterministic conversion keeps reviewed content byte-exact.
- **Quoting only the controller-rendered PRD** (draft R3): circular, because the controller wrote what it then "verified".
- **Putting boundary facts inside `final-prd.md`**: Spec-to-Build changes the baseline and bounds, so the reviewed PRD bytes would change and G6 "exact reviewed bytes" would fail.
- **Reusing `renderCccPrdOperatorContextMarkdown` as-is**: it carries one `taskCustody` (`operator-context.ts:14-30`), so its "Task owned path" lines would misstate the admitted scope as one task's custody.
- **`freezeCccPrdPacket` from the vault**: requires a selected PRD under an active-projects root; planning output is not a vault file.
- **Extracting the preflight into core**: it needs compile and conformance, which live in engine; core cannot import engine.

### Signatures (new)

`packages/engine/src/ccc-prd/product-import-preflight.ts`:

```ts
export type CccPrdProductPreviewIdentity = Readonly<{
  schema: string; projectId: string; projectPath: string; bundleHash: string;
  packetHash: string; sidecarHash: string; targetRepository: string; targetBase: string;
  targetHead: string; executionPolicy: CccCampaignProductExecutionPolicy;
}>;

export type CccPrdProductPacketPreflightInput = Readonly<{
  mode: "preview" | "import";
  packet: Readonly<{ rootDir: string; manifestPath: string; sidecarPath: string }>;
  expectedTarget: string;
  expectedBase: string;
  executionPlan: unknown;                  // CLI parses its file; planning passes the artifact value
  requestFloor: "check" | "importer";      // CLI: preview => "check", import => "importer" (unchanged); planning: "check"
}>;

export type CccPrdProductImportPreflightDependencies = Readonly<{
  resolveSemanticProofToolchainPaths: (input: Readonly<{
    pythonRequired: boolean; targetRoot?: string;
  }>) => CccPrdSemanticProofToolchainPaths;            // required: CLI-owned today
  readTargetHead: (targetRoot: string) => Promise<string>; // required: async in engine
  compileCccPrdPacket?: typeof compileCccPrdPacket;
  validateImplementationFactProvenance?: typeof validateCccPrdPacketImplementationFactProvenance;
  inspectVerifierConfinementReadiness?: () => Promise<VerifierConfinementReadiness>;
  inspectSemanticProofSandboxReadiness?: () => Promise<CccSemanticProofSandboxReadiness>;
  assertSemanticProofV2Custody?: typeof assertCccPrdSemanticProofV2Custody;
  assertSemanticProofVerifierConformance?: typeof assertCccSemanticProofVerifierConformance;
  inspectCccPrdImport?: typeof inspectCccPrdImport;
}>;

export type CccPrdProductPacketPreflight =
  | Readonly<{ kind: "compile_refusal"; refusal: Readonly<{ kind: "refusal"; diagnostics?: readonly unknown[] }> }>
  | Readonly<{ kind: "product_refusal"; code: string; message: string }>
  | Readonly<{ kind: "agent_confinement_unavailable"; readiness: VerifierConfinementReadiness }>
  | Readonly<{
      kind: "packet_admitted";
      bundle: CccPrdSemanticBundle;
      executionPolicy: CccCampaignProductExecutionPolicy;
      semanticProofToolchainPaths?: CccPrdSemanticProofToolchainPaths;
      verifierConfinement: VerifierConfinementReadiness;
      semanticProofSandboxReadiness: CccSemanticProofSandboxReadiness;
    }>;

/** Phase A: everything before a project/database is needed (prd.ts:2030-2094 today). */
export async function preflightCccPrdProductPacket(
  input: CccPrdProductPacketPreflightInput, deps: CccPrdProductImportPreflightDependencies,
): Promise<CccPrdProductPacketPreflight>;

export type CccPrdProductTargetPreflight =
  | Readonly<{ kind: "product_refusal"; code: string; message: string }>
  | Readonly<{
      kind: "admitted";
      bundle: CccPrdSemanticBundle;
      executionPolicy: CccCampaignProductExecutionPolicy;
      semanticProofToolchainPaths?: CccPrdSemanticProofToolchainPaths;
      targetHead: string;
      identity: CccPrdProductPreviewIdentity;
      confirmationDigest: string;
      verifierConformanceChecked: boolean;
      /** Import must still refuse with this after the caller's own digest comparison (CLI order). */
      importBlocker?: Readonly<{ kind: "semantic_proof_sandbox_unavailable"; readiness: CccSemanticProofSandboxReadiness }>;
    }>;

/** Phase B: project/target match, HEAD, custody, conformance, v1 replay, identity (prd.ts:2097-2236 today). */
export async function preflightCccPrdProductTarget(
  admitted: Extract<CccPrdProductPacketPreflight, { kind: "packet_admitted" }>,
  project: Readonly<{ projectId: string; projectPath: string; layer: AsyncDataLayer }>,
  options: Readonly<{ mode: "preview" | "import"; idempotencyKey?: string }>,
  deps: CccPrdProductImportPreflightDependencies,
): Promise<CccPrdProductTargetPreflight>;

// Moved verbatim from prd.ts so both callers share them:
export function assertCccPrdProductBundleComplete(bundle: CccPrdSemanticBundle): void;              // prd.ts:1718-1753
export function cccPrdProductRequestBudget(bundle: CccPrdSemanticBundle, policy: CccCampaignProductExecutionPolicy): CccPrdProductRequestBudget; // :1784-1818
export function assertCccPrdProductRequestBudgetFloor(bundle: CccPrdSemanticBundle, policy: CccCampaignProductExecutionPolicy): void; // :1820-1830
export function createCccPrdProductPreviewIdentity(input: { projectId: string; projectPath: string; targetHead: string; bundle: CccPrdSemanticBundle; executionPolicy: CccCampaignProductExecutionPolicy }): CccPrdProductPreviewIdentity; // :1755-1774
export function computeCccPrdProductConfirmationDigest(identity: CccPrdProductPreviewIdentity): string; // :1776-1782
export class CccPrdProductPreflightError extends Error { readonly code: string; }
```

The CLI keeps argument parsing, `withPrdProject`, the confirmation-digest comparison, and all rendering (`writeRefusalPayload`, `writeProductRefusal`, `writeVerifierConfinementImportRefusal`). `PrdProductCommandError` codes are unchanged.

`packages/engine/src/ccc-prd/intake.ts` (extraction):

```ts
export type CccPrdPacketSourceInput = Readonly<{
  projectRelativePath: string; bytes: Buffer; role: string; authoritative: boolean;
}>;
export function writeCccPrdPacketFiles(input: Readonly<{
  outputDir: string; sourceVersion: string; sources: readonly CccPrdPacketSourceInput[];
  extraFiles?: readonly Readonly<{ name: string; bytes: Buffer }>[];   // freeze passes freeze-receipt.json
}>): Readonly<{ rootDir: string; manifestPath: string; manifestSha256: string; packetHash: string }>;
```

`packages/engine/src/ccc-planning/packet.ts`:

```ts
export const CCC_PLANNING_PACKET_SOURCES = {
  originalRequest: { projectRelativePath: "__fusion__/planning/original-request.md", role: "original_request" },
  admissionFacts:  { projectRelativePath: "__fusion__/planning/admission-facts.md",  role: "support" },
  finalPrd:        { projectRelativePath: "__fusion__/planning/final-prd.md",        role: "prd" },
  technicalAnnex:  { projectRelativePath: "__fusion__/planning/technical-annex.md",  role: "technical_annex" },
} as const;

export type CccPlanningAdmissionFacts = Readonly<{
  targetRepository: CccPrdTargetRepository;           // path + 40-hex verifier-containing baseline
  admittedWriteRoots: readonly CccPrdAdmittedWriteRoot[]; // includes <target>/.fusion
  bounds: CccPrdExecutionBounds;                       // from the budget ADR, within import ceilings
  protectedActions: readonly Readonly<{ id: string; kind: CccPrdProtectedActionKind; target: string }>[];
}>;
export function renderCccPlanningAdmissionFacts(facts: CccPlanningAdmissionFacts): Buffer;
export function renderCccPlanningFinalPrd(input: Readonly<{
  requirementMap: CccPlanningRequirementMapV1; verifierBundle: CccPlanningVerifierBundleV1;
}>): Buffer;   // called once at the spec stage; its output is the final_prd artifact
export function renderCccPlanningTechnicalAnnex(input: Readonly<{ taskPlan: CccPlanningTaskPlanV1 }>): Buffer;
export async function materializeCccPlanningPacket(input: Readonly<{
  scratchRoot: string; runId: string; runRevision: number;
  sources: Readonly<{ originalRequest: Buffer; admissionFacts: Buffer; finalPrd: Buffer; technicalAnnex: Buffer }>;
}>): Promise<Readonly<{ rootDir: string; manifestPath: string; packetHash: string }>>;
```

`packages/engine/src/ccc-planning/proposal.ts`:

```ts
export type CccPlanningRequirementMapV1 = Readonly<{
  schema: "ccc-planning.requirement-map.v1";
  requirements: readonly Readonly<{
    id: string; title: string; statement: string; proofIds: readonly string[];
    clauses: readonly Readonly<{
      id: string; text: string;
      derivation:
        | Readonly<{ kind: "request"; requestQuotes: readonly string[]; acceptanceCaseIds: readonly string[] }>
        | Readonly<{ kind: "annex"; decisionIds: readonly string[] }>;
    }>[];
  }>[];
  nonGoals: readonly Readonly<{ id: string; text: string; requestQuotes: readonly string[]; exclusionIds: readonly string[] }>[];
}>;

export function buildCccPlanningAuthoringProposal(input: Readonly<{
  sources: Readonly<{ originalRequest: Buffer; admissionFacts: Buffer; finalPrd: Buffer; technicalAnnex: Buffer }>;
  requirementMap: CccPlanningRequirementMapV1;
  taskPlan: CccPlanningTaskPlanV1;
  verifierBundle: CccPlanningVerifierBundleV1;
  facts: CccPlanningAdmissionFacts;
}>): CccPrdAuthoringProposalV2;

export function createCccPlanningAuthoringAdapter(input: Readonly<{
  proposal: CccPrdAuthoringProposalV2;
  producers: readonly CccPlanningArtifactEnvelopeV1[];   // envelopes of requirement map, PRD, annex, plan, verifier bundle
  runId: string; runRevision: number;
}>): CccPrdAuthoringAdapter;   // throws if any producer lacks resolvedModel
```

`packages/engine/src/ccc-planning/source-fidelity.ts`:

```ts
export type CccPlanningFidelityCode =
  | "CCC_PLANNING_REQUEST_ANCHOR_MISMATCH" | "CCC_PLANNING_REQUEST_QUOTE_UNRESOLVED"
  | "CCC_PLANNING_REQUEST_QUOTE_AMBIGUOUS" | "CCC_PLANNING_REQUEST_UNIT_UNDISPOSITIONED"
  | "CCC_PLANNING_REQUEST_DERIVATION_MISSING" | "CCC_PLANNING_ANNEX_ATTRIBUTED_TO_REQUEST"
  | "CCC_PLANNING_ACCEPTANCE_CASE_UNMAPPED" | "CCC_PLANNING_EXCLUSION_UNMAPPED"
  | "CCC_PLANNING_ANNEX_DECISION_UNKNOWN";
export function checkCccPlanningSourceFidelity(input: Readonly<{
  requestBytes: Buffer;
  requestArtifactDigest: string;      // G0 original_request outputDigest
  packetRequestSha256: string;        // from readCccPrdPacketCustody
  acceptanceCases: CccPlanningAcceptanceCasesV1;   // G1 output with quotes
  requirementMap: CccPlanningRequirementMapV1;
  annexBytes: Buffer;
}>): readonly Readonly<{ code: CccPlanningFidelityCode; message: string }>[];
```

`packages/engine/src/ccc-planning/import-bridge.ts`:

```ts
export function cccPlanningImportKey(runId: string, runRevision: number): string; // "ccc-plan:<runId>:r<n>"

export type CccPlanningImportClosure = Readonly<{
  originalRequest: CccPlanningArtifactRef; admissionGrant: CccPlanningArtifactRef;
  buildGrant: CccPlanningArtifactRef;      buildTransition: CccPlanningArtifactRef; // B0, B1, verifier blobs
  acceptanceCases: CccPlanningArtifactRef; requirementMap: CccPlanningArtifactRef;
  finalPrd: CccPlanningArtifactRef;        technicalAnnex: CccPlanningArtifactRef;
  taskPlan: CccPlanningArtifactRef;        routingPlan: CccPlanningArtifactRef;
  verifierBundle: CccPlanningArtifactRef;  oracleAudit: CccPlanningArtifactRef;
  finalAdjudication: CccPlanningArtifactRef; // names the exact approved PRD/annex/plan digests
}>;

export type CccPlanningImportBridgeInput = Readonly<{
  layer: AsyncDataLayer; store: TaskStore;
  project: Readonly<{ projectId: string; projectPath: string }>;
  planningTaskId: string; runId: string; runRevision: number;
  fence: Extract<CccPlanningPublicationFence, { kind: "work_item_lease" }>;
  scratchRoot: string;
  closure: CccPlanningImportClosure;
  admittedWriterModels: readonly string[];   // exact pins admitted at G0, e.g. ["glm/glm-5.3-flash"]
  facts: CccPlanningAdmissionFacts;
}>;

export type CccPlanningImportBridgeDependencies = Readonly<{
  preflight: CccPrdProductImportPreflightDependencies;
  workflowExtensionRegistry: WorkflowExtensionRegistry;
  assertBuildGraphFitsAllocation: (bundle: CccPrdSemanticBundle, policy: CccCampaignProductExecutionPolicy) => void; // budget ADR
  authorCccPrdPacket?: typeof authorCccPrdPacket;
  importCccPrdBundle?: typeof importCccPrdBundle;
  inspectCccPrdImport?: typeof inspectCccPrdImport;
  reconcileCccPrdImport?: typeof reconcileCccPrdImport;
  now?: () => string;
}>;

export type CccPlanningImportBridgeResult =
  | Readonly<{ kind: "imported"; importKey: string; importId: string; bundleHash: string; receiptKey: string; replayed: boolean }>
  | Readonly<{ kind: "refused"; code: string; message: string; diagnostics?: readonly unknown[]; intentPublished: false }>
  | Readonly<{ kind: "parked"; code: "CCC_PLANNING_IMPORT_STOPPED" | "CCC_PLANNING_IMPORT_IDENTITY_DRIFT" | "CCC_PLANNING_IMPORT_REPLAY_REFUSED"; message: string }>;

export async function runCccPlanningImportBridge(
  input: CccPlanningImportBridgeInput, deps: CccPlanningImportBridgeDependencies,
): Promise<CccPlanningImportBridgeResult>;
```

Bridge algorithm (all reads verify digests):

```text
0  receipt exists for (run, r)?                    -> return imported (replayed)
1  intent exists for (run, r)?                     -> go to RECONCILE
2  load closure; refuse if finalAdjudication does not name the exact
   finalPrd/technicalAnnex/taskPlan digests        -> CCC_PLANNING_REVIEWED_BYTES_DRIFT
3  render admission facts; materialize packet; custody;
   checkCccPlanningSourceFidelity                  -> refuse on any diagnostic
4  proposal; authorship_receipt; authorCccPrdPacket with the planning adapter;
   proposalHash == receipt.proposalHash; write sidecar into the packet
5  plan = createCccPrdProductExecutionPlan({ bundle, routesByTaskId })
   from routingPlan; every route modelId in admittedWriterModels, exact pins only;
   no bundle document key starts with "cccplan-"
6  preflightCccPrdProductPacket(mode import, requestFloor "check")
   -> preflightCccPrdProductTarget; refuse unless admitted and no importBlocker
7  deps.assertBuildGraphFitsAllocation(bundle, policy)
8  publish admission_facts, packet_manifest, sidecar, bundle, execution_plan, then import_intent
9  importCccPrdBundle(stored bundle, stored policy, importKey, ...); publish import_receipt
RECONCILE:
   ins = inspectCccPrdImport(importKey)
   null                         -> importCccPrdBundle with the stored bundle and policy (exact replay inputs)
   ins.bundleHash != intent     -> park IDENTITY_DRIFT
   state stopped                -> park STOPPED
   prepared | projecting        -> reconcileCccPrdImport
   active                       -> nothing to do
   then publish import_receipt
```

### Files

- New: `packages/engine/src/ccc-prd/product-import-preflight.ts`, `packages/engine/src/ccc-planning/packet.ts`, `proposal.ts`, `source-fidelity.ts`, `import-bridge.ts`.
- Changed: `packages/cli/src/commands/prd.ts` (lines ~1718-1830 and 1961-2245 become calls; parsing and rendering stay), `packages/engine/src/ccc-prd/intake.ts` (writer extraction), `packages/engine/src/ccc-prd/index.ts` (exports), and the CLI mock list checked by `scripts/check-mock-completeness.mjs` if the CLI imports new engine exports.

### RED tests (Q2)

| Test (file) | Asserts | Why it cannot pass vacuously |
|---|---|---|
| T2.1 preflight parity (`packages/engine/src/__tests__/ccc-prd-product-import-preflight.test.ts`) | for one packet, policy and project, the CLI `fn prd preview --json` `confirmationDigest` equals `preflightCccPrdProductTarget(...).confirmationDigest`; the existing `packages/cli/src/commands/__tests__/prd*.test.ts` pass unchanged | The refactor is proven by unchanged CLI tests that already pin refusal order (stale digest before sandbox refusal) |
| T2.2 conformance (`packages/engine/src/__tests__/ccc-planning-import-bridge.real-pg.test.ts`) | injected conformance failure: bridge refuses, no `import_intent`, importer spy not called | `importCccPrdBundle` does not run conformance (`importer.ts:2758` runs custody only), so only the shared preflight can refuse |
| T2.3 HEAD drift (same file) | target HEAD differs from the bundle baseline: `CCC_PRD_TARGET_HEAD_DRIFT`, no intent | The importer has no HEAD check |
| T2.4 stale fact provenance (same file) | admission facts edited after authoring: provenance refusal, no intent | The importer has no fact-provenance check |
| T2.5 truthful authorship (`ccc-planning-import-bridge.test.ts`) | adapter id matches `^ccc-planning\.full-v2:`, roles and models equal those derived from envelopes; flipping one envelope's `resolvedModel` to `minimax/MiniMax-M3` changes `authoringModel` to `glm/glm-5.3+minimax/MiniMax-M3`; a `@ts-expect-error` proves the bridge accepts no adapter labels; proposalHash mismatch refuses | The label is proven to be derived from data (it changes when the data changes), not a constant |
| T2.6 request anchor and quotes (`ccc-planning-source-fidelity.test.ts`) | (a) one changed byte in the materialized request: anchor mismatch; (b) a request-derived clause quoting text that exists only in `final-prd.md`: `REQUEST_QUOTE_UNRESOLVED`; (c) a heading-free request with an uncovered line: `REQUEST_UNIT_UNDISPOSITIONED` | (b) the same quote does resolve in the PRD source, so the check targets the request path specifically; (c) `analyzeCccPrdMaterialCoverage` on that request returns zero items (asserted), showing compile alone would pass |
| T2.7 annex attribution (same file) | annex-derived clause citing a request quote: `ANNEX_ATTRIBUTED_TO_REQUEST`; request-derived clause with only annex refs: `REQUEST_DERIVATION_MISSING` | Control: a correctly attributed map yields zero diagnostics |
| T2.8 lost acknowledgement (real PG) | importer failure checkpoint `lost_response_after_commit` makes the bridge throw; second run finds the intent, inspects, publishes the receipt; exactly one `ccc_prd_imports` row for the key, state active. Variants: `after_prepared_db_commit` (reconcile finishes projection); crash before prepare (importer called with stored inputs, one row) | Uses the importer's real checkpoints (`importer.ts:69-93`, `:2771-2779`), so the commit really happened before the failure |
| T2.9 changed digest on retry (real PG) | after the intent exists, re-render with a one-byte annex change: intent publish gives `SLOT_CONFLICT`; forcing the importer with the new bundle under the same key gives `CCC_PRD_IMPORT_IDEMPOTENCY_COLLISION`; row count stays 1 | Exercises both guards independently; the test also computes the two digest-keyed keys of the rejected design and asserts they differ, documenting the double-campaign hazard |
| T2.10 exact reviewed bytes | adjudication approves PRD digest X; packet built from PRD bytes Y: `CCC_PLANNING_REVIEWED_BYTES_DRIFT` | Control: Y equal to X imports |

### Risks (Q2)

- **Import ceilings versus PRD budgets.** Build Large implementation is 12,288 calls, above the importer's 10,000 ceiling. Build deadlines (48 hours, 7 days) exceed the 24-hour `maxDurationMs` ceiling (`import-admission.ts:86-100`). I2 (Build Standard, 3,072 implementation calls) fits. The bridge must refuse with an exact insufficiency (or record a conservative clamp only if the time fit still holds), never clamp silently. Raising the ceilings is an I3/I4 core change.
- **Target HEAD must equal the verifier-containing baseline at import.** That means Build advances the admitted repository's checked-out branch from the admitted base to the baseline. This is fine for I2's owned disposable target, but it is a real effect on user repositories; it needs effect identity and reconcile (verifier-preparation ADR).
- **Live execution approval.** Every imported campaign needs a separate live-execution approval (`packages/engine/src/runtimes/in-process-runtime.ts` approval gate). This is an authority decision owned elsewhere.
- **Request grammar collisions.** A request containing `### Requirement` or `- [AC-...]` lines would be parsed as PRD grammar (`acceptance-clauses.ts:61-66`). G0 must refuse it with `CCC_PLANNING_REQUEST_CONTAINS_PRD_GRAMMAR` and point to `fn prd` (direct admitted-PRD intake stays).
- **Time-of-check gap.** Conformance and HEAD are checked in the preflight, then the importer runs; this is the same gap the CLI has today. The intent records `targetHead`, and RECONCILE never reuses a stale preflight for a fresh import (a missing importer row re-runs steps 3-9 if HEAD moved).
- **Toolchain drift between attempts.** A fresh import re-runs custody with the current toolchain. A changed host refuses, and the bridge parks with `REPLAY_REFUSED` rather than retrying.
- **Shared-file churn.** `prd.ts` is large (4,017 lines) and its CLI test is a known flake on the gate; the refactor card must run the CLI suite in isolation first.

---

## Q3. What compilation requires, so G4 can check it deterministically before any model review

### Decision

1. **Export the compiler's graph rules as one pure function** and make `compileCccPrdPacket` call it, so G4 and compile cannot drift:

   ```ts
   // packages/engine/src/ccc-prd/compiler.ts
   export type CccPrdProductGraphAdmissionInput = Readonly<{
     tasks: readonly Readonly<{ id: string; workflowId: string; dependencyTaskIds: readonly string[];
       ownedPaths: readonly string[]; allowedWriteRoots: readonly string[]; protectedActionIds: readonly string[] }>[];
     edges: readonly Readonly<{ id: string; fromTaskId: string; toTaskId: string; kind: "depends_on" }>[];
     workflows: readonly Readonly<{ id: string; taskIds: readonly string[]; entryTaskIds: readonly string[]; terminalTaskIds: readonly string[] }>[];
     protectedActions: readonly Readonly<{ id: string; kind: string }>[];
     importIntents: readonly CccPrdImportIntent[];
   }>;
   /** Dependency-cycle check + intent cardinality (compiler.ts:1917-1946) + productGraphAdmissionDiagnostics (:1042-1380). */
   export function diagnoseCccPrdProductGraphAdmission(input: CccPrdProductGraphAdmissionInput): CccPrdDiagnostic[];
   ```

2. **G4 deterministic pass, before any model review is reserved:**
   - graph admission (above) on the planner's task plan;
   - `validateTaskCustodyProvenance` (`authoring.ts:185-217`) on the proposal built from the rendered annex;
   - the acceptance-clause reconciliation and `analyzeCccPrdMaterialCoverage` over the four rendered sources (proof-free proposal);
   - the planning source-fidelity check (Q2);
   - the importer-side shape rules: one terminal, a merge action only on that terminal (`importer.ts:794-799`, `:1056-1092`), and `.fusion` among admitted write roots.
   Any diagnostic fails G4 with zero review calls spent.
3. **Full compile cannot run at G4.** Proof-v2 hydration needs the verifier files committed at the baseline (`intake-contract.ts:58-59`, `semantic-proof-custody.ts:1370-1400`), and that commit does not exist yet. So the full `authorCccPrdPacket` + `compileCccPrdPacket(requireMaterialCoverage: true)` runs once the verifier bundle is prepared, **in the disposable preparation clone before Pass 3** (Q4). A compile refusal is then found before fresh review rather than after it.

### What compilation and import require (checklist for the renderer and planner)

- PRD grammar: `### Requirement <ID>` (`acceptance-clauses.ts:62`), `#### Acceptance clauses` (`:65`), one-line clause bullets `- [AC-…] text` (`:63`), optional `#### Acceptance dispositions` with `deferred|excluded|unresolved` (`:64-66`); each proof's cited span contains `the verifier command task verify:<slug>` matching `CCC_CAMPAIGN_TASK_VERIFY_DECLARATION_PATTERN_SOURCE` (`packages/engine/src/ccc-campaign-proof-admission.ts:22-23`). Requirement ids and clause ids must be unique across all sources (`acceptance-clauses.ts:324-341`). The intake lint (`intake-contract.ts:135-258`) is optional and not on the compile path; run it on PRD plus admission facts as an advisory.
- Material coverage: every heading with a body in every authoritative source, and every `REQ|FR|NFR|AC|KTD|BTI-` token line, must be covered by a task span, a requirement span, an unresolved decision, or an explicit deferred/out-of-scope marker (`material-coverage.ts:49-51`, `:227-289`, `:325-417`). So every annex decision section must be realized by a task or requirement, and admission-facts sections must be cited by tasks.
- Implementation facts: labeled lines for target repository, baseline, max requests, max duration, max concurrency, write roots and protected actions (`authoring.ts:659-700`).
- Import intents: exactly one each of campaign, source, run_audit, workflow and work_item; the work item references the sole workflow (`compiler.ts:1917-1946`).
- Product graph admission (`compiler.ts:1042-1380`):
  - exactly one workflow (`:1060-1068`), and declared tasks, workflow members and task intents are the same set;
  - exactly one entry and one terminal (`:1135-1148`);
  - non-empty `ownedPaths`/`allowedWriteRoots` for every task when there is more than one task;
  - pairwise disjoint ownership, **including dependency-ordered pairs** (`:1160-1192`);
  - a live-execution action is never shared (`:1194-1213`);
  - no duplicate dependencies; exactly one head and one tail matching entry and terminal (`:1243-1266`); everything reachable;
  - series-parallel shape, checked by core `parseWorkflowIr` / `validateParallelism` (`:958-1011`, `packages/core/src/workflow-ir.ts:197-240`);
  - `edges` identical to `dependencyTaskIds`, each edge with an intent.
- Bundle completeness: non-empty requirements, proofs, tasks and workflows; every requirement has a task and a complete proof disposition (`prd.ts:1718-1753`).
- Importer: at least one proof, one terminal, one work item at `entryTaskIds[0]` (`importer.ts:1238-1258`), plus the ceilings in Q2.
- I2 consequence: the request must lead to a shape this accepts, for example the diamond (tokenizer, then two parallel functions, then the CLI join) with disjoint ownership.

### What I3 must change later (identified, not designed)

- **Multiple roots and independent domains:** `compiler.ts:1060-1068` (one workflow), `:1135-1148` and `:1243-1266` (single entry/head), `:1917-1946` (one workflow/work item intent); `importer.ts:1238-1258` (one work item at `entryTaskIds[0]`); `importer.ts:794-799` (one terminal; the `requiresProofJoin` branch at `:927` is unreachable for products); `mergeLandingFor` (`:1056-1092`); work-item and run identity `ccc-prd:<importId>`; sealed execution-authorization member sets and product status, which assume one work item. PRD §9 requires the mapping and authorization proof before identity guards change.
- **N-shaped joins** (A→C, A→D, B→D): not series-parallel. `validateParallelism` requires every split to reach one matching join (`workflow-ir.ts:197-240`). This needs a new join/barrier semantics in core IR, not just relaxed compiler checks.
- **Sequential lease handoff:** compiler ownership disjointness (`compiler.ts:1160-1192`) is stricter than the policy parser, which already allows dependency-ordered overlap (`packages/core/src/ccc-campaign/canonical.ts:883-908`). Relaxing it needs a cross-campaign ownership lease at dispatch time; no such lease exists today (only campaign action leases on `ccc_prd_imports`).

### Rejected alternatives

- **Re-implementing graph rules inside planning gates:** they would drift from the compiler.
- **Full compile at G4:** proof hydration needs the verifier baseline, which does not exist yet.
- **Letting G4 failures go to model review:** wastes review calls and the single repair allowance on a mechanical defect.

### Files

- `packages/engine/src/ccc-prd/compiler.ts` (export plus call site), `packages/engine/src/ccc-prd/index.ts` (export), new `packages/engine/src/ccc-planning/graph-gate.ts` (G4 deterministic pass), tests below.

### RED tests (Q3)

| Test | Asserts | Why it cannot pass vacuously |
|---|---|---|
| T3.1 parity (`packages/engine/src/__tests__/ccc-prd-graph-admission-parity.test.ts`) | for fixtures (single, chain, diamond, nested diamond, two roots, two terminals, N-shape, disconnected, dependency-ordered overlap, shared live-execution action, edge/dependency mismatch, duplicate dependency), wrapper codes equal full-compile graph codes | Mixes admitted and refused shapes; a wrapper missing any rule diverges on at least one fixture |
| T3.2 no review before G4 (`ccc-planning-graph-gate.test.ts`) | an N-shaped plan fails G4 and the fake model transport records zero calls and zero reservations | Control: the diamond passes and review records at least one call |
| T3.3 coverage pre-check (same file) | an annex decision realized by no task fails G4 with the material-coverage code | Control: linking that decision to a task passes |

### Risks (Q3)

- Proof-related compile failures still appear only after verifier preparation, though before Pass 3.
- Until I3, real requests with two roots or N-joins will be refused or forced into a series-parallel shape. Planner prompts must not invent fake roots (PRD §9 forbids it); refusal with an exact diagnostic is the honest outcome.

---

## Q4. Spec mode: what `SPEC_READY` stores, and what Spec-to-Build needs

### Decision

1. **`SPEC_READY` is a published `spec_ready` artifact** (`cccplan-r00N-specready-main-v01`), controller-produced, whose inputs are the entire reviewed closure. The run is Spec-ready exactly when that artifact exists for the latest revision and no `build` or `invalidate` artifact follows it. This is derived, not a mutable flag. The same checkpoint is published in Build mode, which then proceeds directly (flowchart F to G, no extra approval).
2. **No repository mutation in Spec mode.** Verifier preparation and the preparation compile run in an owned disposable clone:
   - `git clone --no-hardlinks --no-checkout --template= <target> <scratch>`, then a detached checkout of the admitted base B0, with `core.hooksPath=/dev/null`. Cloning reads the source repository and writes nothing to it.
   - No `git worktree add`, `update-ref`, commit, checkout or object write in the selected repository.
3. **Deterministic verifier baseline.** In the clone, build the verifier-containing commit with plumbing only:
   - `GIT_INDEX_FILE=<scratch>/idx git read-tree B0`;
   - `git hash-object -w --no-filters --stdin` per verifier file;
   - `git update-index --add --cacheinfo <mode>,<oid>,<path>`;
   - `git write-tree`;
   - `git -c commit.gpgsign=false commit-tree <tree> -p B0` with fixed author/committer name, email and date (the G0 admission timestamp) and a fixed message naming the run and verifier-bundle digest.
   Because every input is pinned, the commit id B1 is reproducible: Build recreates it in the real repository and must get the same id.
4. **No coding reserve and no import.** Spec admission reserves only the planning allocation (budget ADR). `SPEC_READY` records zero implementation and review/proof reservations, and there is no `ccc_prd_imports` row with prefix `ccc-plan:<runId>:`.
5. **Spec needs the Darwin semantic-proof sandbox** for G5. Where it is unavailable the run ends `BLOCKED_PREREQUISITE`, never `SPEC_READY`.

### `spec_ready` content (JSON, `contentSchema: "ccc-planning.spec-ready.v1"`)

```ts
export type CccPlanningSpecReadyV1 = Readonly<{
  schema: "ccc-planning.spec-ready.v1";
  runId: string;
  runRevision: number;
  mode: "spec" | "build";
  target: Readonly<{ projectId: string; repositoryPath: string; admittedBase: string /* B0 */ }>;
  closure: readonly CccPlanningArtifactRef[];       // complete reviewed closure, sorted
  closureDigest: string;
  reviewed: Readonly<{
    originalRequest: CccPlanningArtifactRef; acceptanceCases: CccPlanningArtifactRef;
    requirementMap: CccPlanningArtifactRef;  finalPrd: CccPlanningArtifactRef;
    technicalAnnex: CccPlanningArtifactRef;  taskPlan: CccPlanningArtifactRef;
    routingPlan: CccPlanningArtifactRef;     verifierBundle: CccPlanningArtifactRef;
    oracleAudit: CccPlanningArtifactRef;     finalAdjudication: CccPlanningArtifactRef;
  }>;
  gates: readonly Readonly<{
    gate: "G0" | "G1" | "G2" | "G3" | "G4" | "G5";
    verdict: "pass";
    evidence: readonly CccPlanningArtifactRef[];
    inputClosureDigest: string;                     // decides reuse at Build
  }>[];
  verifierBaseline: Readonly<{
    parent: string;                                 // B0
    files: readonly Readonly<{ path: string; mode: "100644" | "100755"; blobOid: string; sha256: string }>[];
    treeOid: string;
    author: Readonly<{ name: string; email: string; date: string }>;
    committer: Readonly<{ name: string; email: string; date: string }>;
    message: string;
    predictedCommitOid: string;                     // B1
  }>;
  preparationCompile: Readonly<{
    targetKind: "disposable_clone";                 // never importable
    packetHash: string; sidecarHash: string; bundleHash: string;
    toolchainDigest: string;                        // task/node/proof-host identities used
    diagnostics: readonly [];
  }>;
  graphAdmission: Readonly<{ graphDigest: string; diagnostics: readonly [] }>;
  spend: Readonly<{
    planningCallsIssued: number; planningAllocation: number;
    implementationReserved: 0; reviewProofReserved: 0;
  }>;
  campaignAdmission: "pending";
  repositoryMutation: "none";
}>;
```

### What Spec-to-Build needs (all from the record above, plus the new grant)

- An explicit `fn plan build RUN_ID --budget-profile ...` publishes a `build_grant` artifact at run revision N+1: fresh G0 recheck of authority, budget, scope, runtime version and target. Earlier spending stays counted against the new planning allocation.
- **Reuse rule:** a gate result is reused only if its recomputed `inputClosureDigest` is identical. Target HEAD must still equal B0; if it moved, the repository-specific research (G2) and all of G5 are invalidated by an `invalidate` artifact and redone.
- **Baseline:** recreate B1 in the real repository from `verifierBaseline` and require `commitOid === predictedCommitOid` (proves the identical verifier closure and base). Then rerun the bad controls in the isolated verifier-preparation worktree. Baseline-specific proof is always revalidated (PRD §8). Advancing the target to B1 is a recorded Build effect (verifier-preparation ADR).
- **G6:** render admission facts with the real path, B1 and Build implementation bounds; build the packet from the **same** `finalPrd`, `technicalAnnex` and `originalRequest` digests; then run the Q2 bridge. A `toolchainDigest` difference forces a fresh preparation compile.

### Rejected alternatives

- **Spec stores an importable bundle:** needs the verifier baseline committed in the selected repository, which is a branch mutation that PRD §8 forbids in Spec.
- **Spec creates the verifier-preparation worktree in the target:** `git worktree add` writes `.git/worktrees` metadata into the selected repository.
- **A mutable run status column for `SPEC_READY`:** a second mutable source of truth beside the immutable record.
- **Reserving coding capacity at Spec:** forbidden by PRD §8.

### Files

- New: `packages/engine/src/ccc-planning/spec-ready.ts` (assemble and verify the record, reuse decision), `packages/engine/src/ccc-planning/verifier-baseline-recipe.ts` (pure recipe type and the plumbing command list; execution belongs to the verifier-preparation card's async supervised runner), tests below.

### RED tests (Q4)

| Test | Asserts | Why it cannot pass vacuously |
|---|---|---|
| T4.1 no repository mutation (`packages/engine/src/__tests__/ccc-planning-spec-mode.real-pg.test.ts`, real Git, fake models) | before and after a Spec run: `git rev-parse HEAD`, `git for-each-ref`, `git worktree list --porcelain`, the index file hash, `git count-objects -v`, `git status --porcelain=v2` are identical; no `ccc_prd_imports` row with prefix `ccc-plan:<runId>:`; no mission or campaign tasks; zero implementation/review reservations | Positive control in the same harness: the Build transition changes the snapshot, so the detector sees real changes |
| T4.2 reproducible baseline (`ccc-planning-verifier-baseline-recipe.test.ts`) | B1 computed in the clone equals B1 computed in a second fresh clone and in the target's object store | Controls: one changed verifier byte, or a changed date, changes B1, so the recipe fields are really pinned |
| T4.3 reuse versus revalidate (`ccc-planning-spec-to-build.real-pg.test.ts`) | unchanged closure: G1–G4 reused with zero model calls, but G5 controls rerun (proof-run count at least 1); target HEAD moved off B0: an `invalidate` artifact, and G2/G5 redone or `CCC_PLANNING_BASE_DRIFT` | Both arms run in the same test; the call counter differs between them |
| T4.4 sandbox unavailable (`ccc-planning-spec-mode.test.ts`) | injected sandbox readiness false gives `BLOCKED_PREREQUISITE` and no `spec_ready` artifact | Control: readiness true reaches `SPEC_READY` |

### Risks (Q4)

- Commit determinism depends on git honouring `--no-filters`, fixed environment identity and no signing. A global `commit.gpgsign` or a `GIT_*` variable leaking into the environment changes B1. The recipe runner must scrub the environment, as `readTargetHead` does (`prd.ts:1673-1683`), and T4.2 guards it.
- SHA-256-object repositories are out of scope (the baseline grammar is 40-hex).
- The disposable clone is evidence-bearing until `SPEC_READY` is published. Cleanup must follow host rules (`rm -f` plus `rmdir` in unattended scripts, never `rm -rf`).
- Spec mode is proven offline with fake models only. Per PRD §7 that never counts as live Spec-mode proof; the I2 claim must say so.

---

## 5. Cards with disjoint file ownership

| Card | Owns (exclusive) | Depends on |
|---|---|---|
| B1 artifact store (core) | `migrations/0042_ccc_planning_artifact_guard.sql`, `core/src/ccc-planning/artifacts.ts`, `core/src/task-store/ccc-planning-artifact-ops.ts`, the `cleanupArchivedTasksImpl` hunk in `task-mutation-ops.ts`, `core/src/__tests__/postgres/ccc-planning-artifacts.pg.test.ts`, `core/src/__tests__/ccc-planning-artifact-envelope.test.ts` | Schema/barrel integration card (below) |
| B0 schema and barrel integration | `schema-applier.ts`, the three pinned `"0041"` tests, `core/src/index.ts`, `core/src/index.gate.ts` | One owner across all sibling ADRs' migrations |
| B2 graph admission export | `engine/src/ccc-prd/compiler.ts`, `engine/src/__tests__/ccc-prd-graph-admission-parity.test.ts` | none |
| B3 shared preflight | new `engine/src/ccc-prd/product-import-preflight.ts`, `cli/src/commands/prd.ts`, `engine/src/ccc-prd/index.ts` (also adds B2's export line), the mock-completeness list, `engine/src/__tests__/ccc-prd-product-import-preflight.test.ts` | B2 merged first, or B3 adds B2's export |
| B4 packet writer extraction | `engine/src/ccc-prd/intake.ts` | none (guarded by existing intake tests) |
| B5 import bridge | `engine/src/ccc-planning/{packet,proposal,source-fidelity,import-bridge,graph-gate}.ts` and their tests | B1, B2, B3, B4; budget ADR's fit check |
| B6 Spec-ready | `engine/src/ccc-planning/{spec-ready,verifier-baseline-recipe}.ts` and tests | B1, B5 (packet renderer); verifier-preparation ADR runs the commands |

## 6. Assumptions on sibling ADRs (stated, not designed here)

- **Run driver:** planning stages run under a native work-item lease on the planning task; the driver checks "slot already published" before dispatching a stage; run admission creates task, work item and the `admission` artifact in one transaction.
- **Planning-task guard:** the planning task is held and covered by the campaign mutation guard; it never runs generic workflows or code nodes; its description and PROMPT hold no artifact content.
- **Pi seam:** a closed per-role tool allowlist that overrides the caller; realpath-confined read tools; Pi session files outside role read roots; no loopback HTTP for web-capable roles.
- **Budget:** supplies `attemptRef`, the implementation bounds within the importer ceilings, and `assertBuildGraphFitsAllocation`.
- **Verifier preparation:** executes the baseline recipe (scratch in Spec, real repository in Build), runs controls in the Darwin sandbox, and owns the effect that advances the target to B1.
