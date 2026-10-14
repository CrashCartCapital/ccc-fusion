/**
 * FNXC:CccPlanningArtifacts 2026-10-14-13:48 (card A1):
 * Publish, read, list and resolve immutable request-to-code planning artifacts
 * (CONTRACT-v3 section 2.6, decision D6) against a real PostgreSQL, through a
 * layer that runs as the application's own role (`fusion_runtime`) bound to one
 * project, so row-level security and the 0043 guard trigger are both live.
 *
 * Every refusal is paired with a control that differs by the one offending
 * field and succeeds on the same fixture, so a refusal can never pass because
 * the fixture is broken. Refusals are matched on the typed CccPlanningRefusal
 * code, never on message text.
 *
 * The archive-cleanup case runs in the unbound `__legacy_unscoped__` partition
 * on the harness TaskStore, because cleanupArchivedTasks scopes itself to its
 * layer's project. It moves the planning task into the archived column with
 * direct SQL and never through a guarded store path, so it keeps passing once
 * the custody guards of card G1 refuse `archiveTask` for a held planning task.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer, type DbTransaction } from "../../postgres/data-layer.js";
import { cccPlanningRuns, type CccPlanningRunInsert } from "../../postgres/schema/ccc-planning.js";
import {
  CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA,
  computeCccPlanningEnvelopeIdentityDigest,
  encodeCccPlanningArtifactContent,
  type CccPlanningArtifactEnvelopeV1,
  type CccPlanningArtifactPolicy,
  type CccPlanningArtifactRef,
} from "../../ccc-planning/artifacts.js";
import { CccPlanningRefusal, type CccPlanningRefusalCode } from "../../ccc-planning/errors.js";
import { cccPlanningEventId } from "../../ccc-planning/policy.js";
import {
  listCccPlanningArtifacts,
  publishCccPlanningArtifact,
  publishCccPlanningArtifactWithinTransaction,
  readCccPlanningArtifact,
  resolveCccPlanningInputClosure,
  type PublishCccPlanningArtifactInput,
} from "../../task-store/ccc-planning-artifact-ops.js";

const PROJECT_A = "r2c-a1-project-a";
const PROJECT_B = "r2c-a1-project-b";
const LEGACY_PROJECT = "__legacy_unscoped__";
const NOW = "2026-10-14T12:00:00.000Z";
const LATER = "2026-10-14T12:05:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const REQUEST_TEXT = "Add a --version flag that prints the package version.";
const PUBLISHED_EVENT = "ccc-planning:artifact-published" as const;

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

let fixtureOrdinal = 0;
function nextRunId(): string {
  fixtureOrdinal += 1;
  return `ccc-plan:${sha(`r2c-a1-run-${fixtureOrdinal}`).slice(0, 24)}`;
}

function anchorValues(projectId: string, runId: string, planningTaskId: string): CccPlanningRunInsert {
  return {
    projectId,
    runId,
    planningTaskId,
    mode: "build",
    budgetProfile: "standard",
    roleProfile: "full-v2",
    policyVersion: "ccc-planning.budget-policy.v1",
    policyDigest: sha("policy"),
    requestDigest: sha(`request:${runId}`),
    requestBytes: 512,
    targetRepository: "/private/tmp/r2c-a1-target",
    admittedBase: "b".repeat(40),
    grantDigest: sha(`grant:${runId}`),
    authorityReceiptSha256: sha(`receipt:${runId}`),
    authorityReceiptJson: JSON.stringify({ runId }),
    runtimeDistManifestSha256: sha("dist"),
    state: "admitted",
    deadlineAt: FAR,
    planningAllocation: 40,
    implementationAllocation: 20,
    reviewProofAllocation: 10,
    researchFetchAllocation: 5,
    researchBytesAllocation: 1_048_576,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const NO_POLICY: CccPlanningArtifactPolicy = {
  promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none",
};
const MODEL_POLICY: CccPlanningArtifactPolicy = {
  promptVersion: "designer.v1", promptDigest: sha("designer-prompt"),
  toolPolicyVersion: "tools.v1", toolPolicyDigest: sha("designer-tools"),
};

/** A typed refusal with the expected code; message text is never matched. */
async function expectRefusal(attempt: Promise<unknown>, code: CccPlanningRefusalCode): Promise<void> {
  const error = await attempt.then(() => null, (failure: unknown) => failure);
  expect(error, `expected a ${code} refusal but the call resolved`).not.toBeNull();
  expect(error).toBeInstanceOf(CccPlanningRefusal);
  expect((error as CccPlanningRefusal).code).toBe(code);
}

/** Drizzle wraps driver errors; the PostgresError with code and message is the cause. */
async function expectRawRefusal(statement: Promise<unknown>, sqlState: string, prefix: string): Promise<void> {
  await expect(statement).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: sqlState,
      message: expect.stringMatching(new RegExp(`^${prefix}:`)),
    }),
  });
}

interface Run {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
}

pgDescribe("ccc planning artifact ops (PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;
  let connectionsA: PostgresConnections;
  let connectionsB: PostgresConnections;
  let layerA: AsyncDataLayer;
  let layerB: AsyncDataLayer;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_a1", copyFromGolden: true });
    db = harness.adminDb;
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: harness.testUrl, migrationUrl: harness.testUrl, migrationUrlOverridden: false,
    };
    connectionsA = await createConnectionSetFromUrl(backend, {
      poolMax: 4, connectTimeoutSeconds: 5, projectId: PROJECT_A, useRuntimeRole: true,
    });
    connectionsB = await createConnectionSetFromUrl(backend, {
      poolMax: 2, connectTimeoutSeconds: 5, projectId: PROJECT_B, useRuntimeRole: true,
    });
    layerA = createAsyncDataLayer(connectionsA, { projectId: PROJECT_A });
    layerB = createAsyncDataLayer(connectionsB, { projectId: PROJECT_B });
  });

  afterAll(async () => {
    await connectionsA?.close();
    await connectionsB?.close();
    await harness?.teardown();
  });

  let taskOrdinal = 0;
  async function insertTask(projectId: string): Promise<string> {
    taskOrdinal += 1;
    const id = `R2C-A1-${taskOrdinal}`;
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${projectId}, ${id}, ${`request-to-code planning task ${id}`}, 'todo', ${NOW}, ${NOW})
    `);
    return id;
  }

  async function admittedRun(projectId = PROJECT_A, existingTaskId?: string): Promise<Run> {
    const taskId = existingTaskId ?? await insertTask(projectId);
    const runId = nextRunId();
    await db.insert(cccPlanningRuns).values(anchorValues(projectId, runId, taskId));
    return { projectId, runId, taskId };
  }

  async function moveRun(run: Run, state: string): Promise<void> {
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${state}, updated_at = ${NOW}
       WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
    `);
  }

  async function insertWorkItem(run: Run, input: { id: string; leaseOwner: string; attempt: number; leaseExpiresAt?: string }): Promise<void> {
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (${run.projectId}, ${input.id}, ${run.runId}, ${run.taskId}, 'ccc-planning-stage', 'step', 'running',
              ${input.attempt}, ${input.leaseOwner}, ${input.leaseExpiresAt ?? FAR}, ${NOW}, ${NOW})
    `);
  }

  /** The admission request of a run: a controller text artifact under the admission fence. */
  function requestInput(run: Run, overrides: Partial<PublishCccPlanningArtifactInput> = {}): PublishCccPlanningArtifactInput {
    return {
      planningTaskId: run.taskId,
      runId: run.runId,
      slot: { runRevision: 1, stageId: "admission", slot: "request", version: 1 },
      kind: "original_request",
      contentSchema: "ccc-planning.original-request.v1",
      content: { type: "text", bytes: new TextEncoder().encode(REQUEST_TEXT) },
      inputs: [],
      producer: { kind: "controller", roleId: "controller", instanceId: "controller:admit" },
      policy: NO_POLICY,
      status: "complete",
      fence: { kind: "admission" },
      now: NOW,
      ...overrides,
    };
  }

  function grantInput(run: Run, overrides: Partial<PublishCccPlanningArtifactInput> = {}): PublishCccPlanningArtifactInput {
    return requestInput(run, {
      slot: { runRevision: 1, stageId: "admission", slot: "grant", version: 1 },
      kind: "admission_grant",
      contentSchema: "ccc-planning.admission-grant.v1",
      content: { type: "json", value: { runId: run.runId, allocation: { planning: 40 } } },
      ...overrides,
    });
  }

  /** A design alternative by a model designer under a live work item lease. */
  function designInput(
    run: Run, leaseOwner: string, inputs: readonly CccPlanningArtifactRef[], overrides: Partial<PublishCccPlanningArtifactInput> = {},
  ): PublishCccPlanningArtifactInput {
    return requestInput(run, {
      slot: { runRevision: 1, stageId: "design", slot: "a", version: 1 },
      kind: "design_alternative",
      contentSchema: "ccc-planning.design-alternative.v1",
      content: { type: "json", value: { summary: "design a" } },
      inputs,
      producer: {
        kind: "model", roleId: "designer-a", instanceId: "designer-a:1", attemptRef: sha("attempt-designer-a"),
        requestedModel: "glm/glm-5.3", resolvedModel: "glm/glm-5.3", routeReceiptDigest: sha("receipt-designer-a"),
      },
      policy: MODEL_POLICY,
      fence: { kind: "work_item_lease", workItemId: `WI-${run.taskId}`, leaseOwner, attempt: 1, runId: run.runId },
      ...overrides,
    });
  }

  function ref(record: { key: string; envelope: CccPlanningArtifactEnvelopeV1 }): CccPlanningArtifactRef {
    return { artifactKey: record.key, digest: record.envelope.outputDigest };
  }

  async function countDocuments(run: Run, keyPrefix = "cccplan-"): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM project.task_documents
       WHERE project_id = ${run.projectId} AND task_id = ${run.taskId} AND key LIKE ${`${keyPrefix}%`}
    `)) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  }

  async function publishedEvents(run: Run): Promise<Array<Record<string, unknown>>> {
    return (await db.execute(sql`
      SELECT id, agent_id, domain, target, task_id, metadata FROM project.run_audit_events
       WHERE project_id = ${run.projectId} AND run_id = ${run.runId} AND mutation_type = ${PUBLISHED_EVENT}
       ORDER BY target
    `)) as unknown as Array<Record<string, unknown>>;
  }

  /** A valid planning envelope for a raw INSERT, built the way the publisher would build it. */
  function rawArtifact(run: Run, slot: string) {
    const encoded = encodeCccPlanningArtifactContent({ type: "text", bytes: new TextEncoder().encode(`raw ${slot}`) });
    const key = `cccplan-r001-admission-${slot}-v01`;
    const base = {
      schema: CCC_PLANNING_ARTIFACT_ENVELOPE_SCHEMA, artifactKey: key, runId: run.runId, runRevision: 1,
      stageId: "admission", slot, version: 1, kind: "original_request", contentType: encoded.contentType,
      contentSchema: "ccc-planning.original-request.v1", inputs: [],
      producer: { kind: "controller", roleId: "controller", instanceId: "controller:raw" }, policy: NO_POLICY,
      outputDigest: encoded.outputDigest, status: "complete",
    } as const;
    const metadata = {
      ...base, fence: { kind: "admission" }, identityDigest: computeCccPlanningEnvelopeIdentityDigest(base as never), publishedAt: NOW,
    };
    return { key, content: encoded.text, metadata, author: "ccc-planning:controller" };
  }

  function rawInsert(executor: Pick<DbTransaction, "execute">, run: Run, raw: ReturnType<typeof rawArtifact>) {
    return executor.execute(sql`
      INSERT INTO project.task_documents
        (project_id, id, task_id, key, content, revision, author, metadata, created_at, updated_at)
      VALUES (${run.projectId}, ${`doc-raw-${run.taskId}-${raw.key}`}, ${run.taskId}, ${raw.key}, ${raw.content}, 1,
              ${raw.author}, ${JSON.stringify(raw.metadata)}::jsonb, ${NOW}, ${NOW})
    `);
  }

  describe("publish and replay", () => {
    it("republishing the same identity returns replayed: true, leaves one row and one audit event; a first publish of a new key reads back with the same digest", async () => {
      const run = await admittedRun();

      const first = await publishCccPlanningArtifact(layerA, requestInput(run));
      expect(first).toMatchObject({ key: "cccplan-r001-admission-request-v01", replayed: false });
      const read = await readCccPlanningArtifact(layerA, run.taskId, first.key);
      expect(read?.text).toBe(REQUEST_TEXT);
      expect(read?.record.envelope.outputDigest).toBe(sha(REQUEST_TEXT));
      expect(first.envelope.outputDigest).toBe(sha(REQUEST_TEXT));

      // The replay happens at a later clock; the persisted first publication is returned unchanged.
      const replay = await publishCccPlanningArtifact(layerA, requestInput(run, { now: LATER }));
      expect(replay.replayed).toBe(true);
      expect(replay.id).toBe(first.id);
      expect(replay.envelope).toEqual(first.envelope);
      expect(replay.envelope.publishedAt).toBe(NOW);
      expect(await countDocuments(run)).toBe(1);

      const events = await publishedEvents(run);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: cccPlanningEventId({ projectId: PROJECT_A, runId: run.runId, mutationType: PUBLISHED_EVENT, subject: first.key }),
        agent_id: "ccc-planning-controller", domain: "database", target: first.key, task_id: run.taskId,
      });
    });

    it("gives SLOT_CONFLICT for the same key with a different identity and keeps the first row; the next version slot is admitted", async () => {
      const run = await admittedRun();
      const first = await publishCccPlanningArtifact(layerA, requestInput(run));

      await expectRefusal(
        publishCccPlanningArtifact(layerA, requestInput(run, { content: { type: "text", bytes: new TextEncoder().encode("a different request") } })),
        "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT",
      );
      await expectRefusal(
        publishCccPlanningArtifact(layerA, requestInput(run, { status: "blocked" })),
        "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT",
      );
      expect(await countDocuments(run)).toBe(1);
      expect((await readCccPlanningArtifact(layerA, run.taskId, first.key))?.text).toBe(REQUEST_TEXT);

      const next = await publishCccPlanningArtifact(layerA, requestInput(run, {
        slot: { runRevision: 1, stageId: "admission", slot: "request", version: 2 },
        content: { type: "text", bytes: new TextEncoder().encode("a different request") },
      }));
      expect(next).toMatchObject({ key: "cccplan-r001-admission-request-v02", replayed: false });
      expect(await countDocuments(run)).toBe(2);
    });

    it("serialises concurrent publishes of one key: equal identities give one insert and one replay, different identities one winner and a SLOT_CONFLICT", async () => {
      const equal = await admittedRun();
      const [left, right] = await Promise.all([
        publishCccPlanningArtifact(layerA, requestInput(equal)),
        publishCccPlanningArtifact(layerA, requestInput(equal, { now: LATER })),
      ]);
      expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
      expect(left.id).toBe(right.id);
      expect(await countDocuments(equal)).toBe(1);
      expect(await publishedEvents(equal)).toHaveLength(1);

      const different = await admittedRun();
      const settled = await Promise.allSettled([
        publishCccPlanningArtifact(layerA, requestInput(different)),
        publishCccPlanningArtifact(layerA, requestInput(different, { status: "blocked" })),
      ]);
      expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(CccPlanningRefusal);
      expect((rejected.reason as CccPlanningRefusal).code).toBe("CCC_PLANNING_ARTIFACT_SLOT_CONFLICT");
      expect(await countDocuments(different)).toBe(1);
    });

    it("sorts and de-duplicates inputs before hashing, so input order never changes the identity; one key with two digests is refused", async () => {
      const run = await admittedRun();
      const owner = "ccc-planning-host:a1";
      // The admission fence is only valid while the anchor is still 'admitted'.
      const request = await publishCccPlanningArtifact(layerA, requestInput(run));
      const grant = await publishCccPlanningArtifact(layerA, grantInput(run));
      await moveRun(run, "running");
      await insertWorkItem(run, { id: `WI-${run.taskId}`, leaseOwner: owner, attempt: 1 });

      const first = await publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(grant), ref(request), ref(grant)]));
      expect(first.replayed).toBe(false);
      expect(first.envelope.inputs).toEqual([ref(request), ref(grant)].sort((a, b) => (a.artifactKey < b.artifactKey ? -1 : 1)));

      const replay = await publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request), ref(grant)]));
      expect(replay.replayed).toBe(true);
      expect(replay.id).toBe(first.id);

      await expectRefusal(
        publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request), { artifactKey: request.key, digest: sha("another") }], {
          slot: { runRevision: 1, stageId: "design", slot: "b", version: 1 },
        })),
        "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      );
      expect(await countDocuments(run)).toBe(3);
    });
  });

  describe("read, list and closure", () => {
    it("gives DIGEST_MISMATCH when expectedDigest differs on read; the stored digest reads back, a missing key is null and a non-planning key is refused", async () => {
      const run = await admittedRun();
      const published = await publishCccPlanningArtifact(layerA, requestInput(run));

      await expectRefusal(
        readCccPlanningArtifact(layerA, run.taskId, published.key, { expectedDigest: sha("something else") }),
        "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      );
      const matching = await readCccPlanningArtifact(layerA, run.taskId, published.key, { expectedDigest: sha(REQUEST_TEXT) });
      expect(matching?.text).toBe(REQUEST_TEXT);
      expect(matching?.record.envelope.outputDigest).toBe(sha(REQUEST_TEXT));
      expect(matching?.record.replayed).toBe(false);

      expect(await readCccPlanningArtifact(layerA, run.taskId, "cccplan-r001-admission-absent-v01")).toBeNull();
      await expectRefusal(readCccPlanningArtifact(layerA, run.taskId, "notes.md"), "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
    });

    it("gives DIGEST_MISMATCH when the stored text no longer hashes to its envelope digest, even without an expectedDigest", async () => {
      const run = await admittedRun();
      const published = await publishCccPlanningArtifact(layerA, requestInput(run));
      expect((await readCccPlanningArtifact(layerA, run.taskId, published.key))?.text).toBe(REQUEST_TEXT);

      // Storage drift is staged with the replica role, which skips ordinary triggers, so the 0043 guard cannot stop the write.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`
          UPDATE project.task_documents SET content = 'drifted bytes'
           WHERE project_id = ${run.projectId} AND task_id = ${run.taskId} AND key = ${published.key}
        `);
      });
      await expectRefusal(readCccPlanningArtifact(layerA, run.taskId, published.key), "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH");
    });

    it("lists only the task's planning artifacts, in key order, with their envelopes", async () => {
      const run = await admittedRun();
      const other = await admittedRun();
      const grant = await publishCccPlanningArtifact(layerA, grantInput(run));
      const request = await publishCccPlanningArtifact(layerA, requestInput(run));
      await publishCccPlanningArtifact(layerA, requestInput(other));
      await db.execute(sql`
        INSERT INTO project.task_documents (project_id, id, task_id, key, content, created_at, updated_at)
        VALUES (${run.projectId}, ${`doc-${run.taskId}-notes`}, ${run.taskId}, 'notes.md', 'ordinary document', ${NOW}, ${NOW})
      `);

      const listed = await listCccPlanningArtifacts(layerA, run.taskId);
      expect(listed.map((record) => record.key)).toEqual([grant.key, request.key].sort());
      expect(listed.every((record) => !record.replayed && record.envelope.runId === run.runId)).toBe(true);
      expect(listed.find((record) => record.key === request.key)?.envelope).toEqual(request.envelope);
      expect(await listCccPlanningArtifacts(layerA, other.taskId)).toHaveLength(1);
      expect(await listCccPlanningArtifacts(layerA, "R2C-A1-no-such-task")).toEqual([]);
    });

    it("resolves the transitive input closure of its roots, roots included, sorted and unique; an unpublished or wrong-digest root is refused", async () => {
      const run = await admittedRun();
      const owner = "ccc-planning-host:closure";
      const request = await publishCccPlanningArtifact(layerA, requestInput(run));
      const grant = await publishCccPlanningArtifact(layerA, grantInput(run));
      await moveRun(run, "running");
      await insertWorkItem(run, { id: `WI-${run.taskId}`, leaseOwner: owner, attempt: 1 });
      const design = await publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request)]));
      const review = await publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(design)], {
        slot: { runRevision: 1, stageId: "design-review", slot: "a", version: 1 },
        kind: "design_review",
        contentSchema: "ccc-planning.design-review.v1",
        content: { type: "json", value: { verdict: "accept" } },
      }));
      const byKey = (a: CccPlanningArtifactRef, b: CccPlanningArtifactRef) => (a.artifactKey < b.artifactKey ? -1 : 1);

      expect(await resolveCccPlanningInputClosure(layerA, run.taskId, [ref(review)]))
        .toEqual([ref(request), ref(design), ref(review)].sort(byKey));
      expect(await resolveCccPlanningInputClosure(layerA, run.taskId, [ref(design)]))
        .toEqual([ref(request), ref(design)].sort(byKey));
      expect(await resolveCccPlanningInputClosure(layerA, run.taskId, [ref(review), ref(design), ref(grant), ref(review)]))
        .toEqual([ref(request), ref(design), ref(review), ref(grant)].sort(byKey));
      expect(await resolveCccPlanningInputClosure(layerA, run.taskId, [])).toEqual([]);

      await expectRefusal(
        resolveCccPlanningInputClosure(layerA, run.taskId, [{ artifactKey: "cccplan-r001-design-ghost-v01", digest: sha("ghost") }]),
        "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED",
      );
      await expectRefusal(
        resolveCccPlanningInputClosure(layerA, run.taskId, [{ artifactKey: design.key, digest: sha("wrong") }]),
        "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      );
      await expectRefusal(
        resolveCccPlanningInputClosure(layerA, run.taskId, [{ artifactKey: request.key, digest: request.envelope.outputDigest }, { artifactKey: request.key, digest: sha("two digests") }]),
        "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      );
    });
  });

  describe("publication steps", () => {
    it("resets the publisher GUC after a publish inside a shared transaction, so a raw reserved-key insert in the same transaction is refused with PUBLISHER_REQUIRED", async () => {
      const run = await admittedRun();
      const raw = rawArtifact(run, "rawone");
      const guarded = rawArtifact(run, "rawtwo");

      await layerA.transactionImmediate(async (tx) => {
        const first = await publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, requestInput(run));
        expect(first.replayed).toBe(false);

        const flag = (await tx.execute(sql`SELECT current_setting('fusion.ccc_planning_publication', true) AS flag`)) as unknown as Array<{ flag: string | null }>;
        expect(flag[0]!.flag === "on").toBe(false);
        // The raw insert is refused by the guard trigger; the nested transaction keeps the shared one usable.
        await expectRawRefusal(
          tx.transaction((nested) => rawInsert(nested, run, raw)),
          "P0001",
          "CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED",
        );

        // Control: the publisher still works afterwards in the same transaction, and a hand-set GUC admits the same raw insert.
        const second = await publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, grantInput(run));
        expect(second.replayed).toBe(false);
        await tx.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
        await rawInsert(tx, run, guarded);
      });

      const keys = (await db.execute(sql`
        SELECT key FROM project.task_documents WHERE project_id = ${run.projectId} AND task_id = ${run.taskId} ORDER BY key
      `)) as unknown as Array<{ key: string }>;
      expect(keys.map((row) => row.key)).toEqual([
        "cccplan-r001-admission-grant-v01", "cccplan-r001-admission-request-v01", guarded.key,
      ].sort());
    });

    it("maps a trigger refusal to its typed refusal, writes nothing for it, and leaves the shared transaction usable", async () => {
      const run = await admittedRun();
      const foreign = await admittedRun();

      await layerA.transactionImmediate(async (tx) => {
        // The run id belongs to another anchor: only the 0043 trigger can see that.
        await expectRefusal(
          publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, requestInput(run, { runId: foreign.runId })),
          "CCC_PLANNING_ARTIFACT_RUN_MISMATCH",
        );
        const ok = await publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, requestInput(run));
        expect(ok.replayed).toBe(false);
      });

      expect(await countDocuments(run)).toBe(1);
      expect(await publishedEvents(run)).toHaveLength(1);
      expect(await publishedEvents(foreign)).toHaveLength(0);
    });

    it("refuses a stale, expired or reclaimed work item lease with FENCE_REFUSED, replays included; the live lease is admitted", async () => {
      const run = await admittedRun();
      const owner = "ccc-planning-host:fence";
      const request = await publishCccPlanningArtifact(layerA, requestInput(run));
      await moveRun(run, "running");
      await insertWorkItem(run, { id: `WI-${run.taskId}`, leaseOwner: owner, attempt: 1 });
      const design = (overrides: Partial<PublishCccPlanningArtifactInput> = {}) =>
        designInput(run, owner, [ref(request)], overrides);

      const live = await publishCccPlanningArtifact(layerA, design());
      expect(live.replayed).toBe(false);

      await expectRefusal(
        publishCccPlanningArtifact(layerA, design({
          slot: { runRevision: 1, stageId: "design", slot: "b", version: 1 },
          fence: { kind: "work_item_lease", workItemId: `WI-${run.taskId}`, leaseOwner: owner, attempt: 2, runId: run.runId },
        })),
        "CCC_PLANNING_ARTIFACT_FENCE_REFUSED",
      );
      await expectRefusal(
        publishCccPlanningArtifact(layerA, design({
          slot: { runRevision: 1, stageId: "design", slot: "b", version: 1 },
          fence: { kind: "work_item_lease", workItemId: `WI-${run.taskId}`, leaseOwner: "someone-else", attempt: 1, runId: run.runId },
        })),
        "CCC_PLANNING_ARTIFACT_FENCE_REFUSED",
      );
      expect(await countDocuments(run)).toBe(2);

      // The lease is reclaimed by attempt 2: the old holder may no longer publish, not even an identical replay.
      await db.execute(sql`
        UPDATE project.workflow_work_items SET attempt = 2, updated_at = ${NOW}
         WHERE project_id = ${run.projectId} AND id = ${`WI-${run.taskId}`}
      `);
      await expectRefusal(publishCccPlanningArtifact(layerA, design()), "CCC_PLANNING_ARTIFACT_FENCE_REFUSED");
      const reclaimed = await publishCccPlanningArtifact(layerA, design({
        fence: { kind: "work_item_lease", workItemId: `WI-${run.taskId}`, leaseOwner: owner, attempt: 2, runId: run.runId },
      }));
      expect(reclaimed.replayed).toBe(true);

      await db.execute(sql`
        UPDATE project.workflow_work_items SET lease_expires_at = ${PAST}, updated_at = ${NOW}
         WHERE project_id = ${run.projectId} AND id = ${`WI-${run.taskId}`}
      `);
      await expectRefusal(
        publishCccPlanningArtifact(layerA, design({
          slot: { runRevision: 1, stageId: "design", slot: "b", version: 1 },
          fence: { kind: "work_item_lease", workItemId: `WI-${run.taskId}`, leaseOwner: owner, attempt: 2, runId: run.runId },
        })),
        "CCC_PLANNING_ARTIFACT_FENCE_REFUSED",
      );
      expect(await countDocuments(run)).toBe(2);
    });

    it("validates the envelope before touching the database: stage and kind, model producer receipt, input digests; the valid input is admitted", async () => {
      const run = await admittedRun();
      const owner = "ccc-planning-host:validate";
      const request = await publishCccPlanningArtifact(layerA, requestInput(run));
      await moveRun(run, "running");
      await insertWorkItem(run, { id: `WI-${run.taskId}`, leaseOwner: owner, attempt: 1 });
      expect(await countDocuments(run)).toBe(1);

      await expectRefusal(
        publishCccPlanningArtifact(layerA, requestInput(run, {
          slot: { runRevision: 1, stageId: "admission", slot: "wrong", version: 1 }, kind: "design_alternative",
        })),
        "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID",
      );
      const modelProducer = designInput(run, owner, [ref(request)]).producer;
      await expectRefusal(
        publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request)], {
          producer: { ...modelProducer, routeReceiptDigest: undefined },
        })),
        "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID",
      );
      await expectRefusal(
        publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request)], {
          slot: { runRevision: 1, stageId: "design", slot: "Bad Slot", version: 1 },
        })),
        "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID",
      );
      await expectRefusal(
        publishCccPlanningArtifact(layerA, designInput(run, owner, [{ artifactKey: request.key, digest: sha("not the request") }])),
        "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED",
      );
      await expectRefusal(
        publishCccPlanningArtifact(layerA, designInput(run, owner, [{ artifactKey: "cccplan-r001-admission-ghost-v01", digest: sha("ghost") }])),
        "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED",
      );
      expect(await countDocuments(run)).toBe(1);
      expect(await publishedEvents(run)).toHaveLength(1);

      const valid = await publishCccPlanningArtifact(layerA, designInput(run, owner, [ref(request)]));
      expect(valid).toMatchObject({ key: "cccplan-r001-design-a-v01", replayed: false });
    });

    it("gives SLOT_CONFLICT when a concurrent publication took the key after this snapshot, and the shared transaction stays usable; a different slot is admitted", async () => {
      const run = await admittedRun();
      const raw = rawArtifact(run, "request");

      await layerA.transactionImmediate(async (tx) => {
        // The first statement fixes this repeatable-read snapshot; the competing publication commits after it.
        await tx.execute(sql`SELECT count(*) FROM project.task_documents WHERE task_id = ${run.taskId}`);
        await db.transaction(async (competing) => {
          await competing.execute(sql`SELECT set_config('fusion.ccc_planning_publication', 'on', true)`);
          await rawInsert(competing, run, raw);
        });

        // Step 4's read cannot see the winner, the insert hits the key's unique constraint, and the re-read still cannot see it.
        await expectRefusal(
          publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, requestInput(run)),
          "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT",
        );
        const other = await publishCccPlanningArtifactWithinTransaction(tx, PROJECT_A, grantInput(run));
        expect(other.replayed).toBe(false);
      }, { isolationLevel: "repeatable read" });

      const stored = (await db.execute(sql`
        SELECT key, content FROM project.task_documents WHERE project_id = ${run.projectId} AND task_id = ${run.taskId} ORDER BY key
      `)) as unknown as Array<{ key: string; content: string }>;
      expect(stored.map((row) => row.key)).toEqual(["cccplan-r001-admission-grant-v01", raw.key]);
      expect(stored.find((row) => row.key === raw.key)?.content).toBe(raw.content);
      expect(await publishedEvents(run)).toHaveLength(1);
    });

    it("publishes under the operator fence at the current controlSeq and refuses a stale one with FENCE_REFUSED", async () => {
      const run = await admittedRun();
      await moveRun(run, "running");
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET control_seq = control_seq + 1, control_request = 'pause', control_revision = revision,
               control_requested_at = ${NOW}, updated_at = ${NOW}
         WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
      `);
      const answer = (controlSeq: number): PublishCccPlanningArtifactInput => requestInput(run, {
        slot: { runRevision: 1, stageId: "operator", slot: "answer1", version: 1 },
        kind: "operator_answer",
        contentSchema: "ccc-planning.operator-answer.v1",
        content: { type: "json", value: { decision: "approve" } },
        producer: { kind: "operator", roleId: "operator", instanceId: `operator:${controlSeq}` },
        fence: { kind: "operator", runRevision: 1, controlSeq },
      });

      await expectRefusal(publishCccPlanningArtifact(layerA, answer(0)), "CCC_PLANNING_ARTIFACT_FENCE_REFUSED");
      expect(await countDocuments(run)).toBe(0);
      const current = await publishCccPlanningArtifact(layerA, answer(1));
      expect(current).toMatchObject({ key: "cccplan-r001-operator-answer1-v01", replayed: false });
      expect(current.envelope.fence).toEqual({ kind: "operator", runRevision: 1, controlSeq: 1 });
      expect(current.envelope.producer).toEqual({ kind: "operator", roleId: "operator", instanceId: "operator:1" });
    });

    it("publishes a g7 review under the campaign item's lease, and refuses a lease on another import's run or a fence that names the planning run", async () => {
      const run = await admittedRun();
      const importId = `r2c-a1-import-${run.taskId}`;
      const digest = sha(`import:${importId}`);
      await db.execute(sql`
        INSERT INTO project.ccc_prd_imports (
          project_id, idempotency_key, import_id, identity_hash, bundle_hash, packet_hash, sidecar_hash,
          source_version, target_repository, target_base, root_dir, staging_relative_path, state,
          canonical_bundle, transaction_witness, projection_digest, created_at, updated_at,
          execution_policy, campaign_manifest, campaign_manifest_hash, campaign_started_at, campaign_deadline_at
        ) VALUES (
          ${run.projectId}, ${`${run.runId}:r1`}, ${importId}, ${digest}, ${digest}, ${digest}, ${digest},
          'v1', '/private/tmp/r2c-a1-target', ${"b".repeat(40)}, '/private/tmp/r2c-a1-root', 'stage', 'prepared',
          '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${NOW},
          '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${FAR}
        )
      `);
      for (const state of ["running", "spec_ready"]) await moveRun(run, state);
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET state = 'importing', import_intent_digest = ${sha(`intent:${run.runId}`)},
               import_idempotency_key = ${`${run.runId}:r1`}, updated_at = ${NOW}
         WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
      `);
      await db.execute(sql`
        UPDATE project.ccc_planning_runs
           SET state = 'building', import_id = ${importId}, implementation_transferred = 5, updated_at = ${NOW}
         WHERE project_id = ${run.projectId} AND run_id = ${run.runId}
      `);

      const owner = "ccc-campaign-worker:a1";
      const campaignTask = await insertTask(run.projectId);
      const otherTask = await insertTask(run.projectId);
      await db.execute(sql`
        INSERT INTO project.workflow_work_items
          (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (${run.projectId}, ${`WI-campaign-${run.taskId}`}, ${`ccc-prd:${importId}`}, ${campaignTask}, 'campaign-node', 'step',
                'running', 1, ${owner}, ${FAR}, ${NOW}, ${NOW}),
               (${run.projectId}, ${`WI-other-${run.taskId}`}, 'ccc-prd:r2c-a1-another-import', ${otherTask}, 'campaign-node', 'step',
                'running', 1, ${owner}, ${FAR}, ${NOW}, ${NOW})
      `);
      const review = (workItemId: string, fenceRunId: string): PublishCccPlanningArtifactInput => requestInput(run, {
        slot: { runRevision: 1, stageId: "g7", slot: "t1", version: 1 },
        kind: "task_review",
        contentSchema: "ccc-planning.task-review.v1",
        content: { type: "json", value: { verdict: "accept" } },
        producer: {
          kind: "model", roleId: "task-reviewer", instanceId: "task-reviewer:1", attemptRef: sha("attempt-task-reviewer"),
          requestedModel: "glm/glm-5.3", resolvedModel: "glm/glm-5.3", routeReceiptDigest: sha("receipt-task-reviewer"),
        },
        policy: MODEL_POLICY,
        fence: { kind: "campaign_work_item_lease", workItemId, leaseOwner: owner, attempt: 1, runId: fenceRunId as `ccc-prd:${string}` },
      });

      // A live lease on a different import's run passes the lock and is refused by the trigger.
      await expectRefusal(publishCccPlanningArtifact(layerA, review(`WI-other-${run.taskId}`, "ccc-prd:r2c-a1-another-import")), "CCC_PLANNING_ARTIFACT_FENCE_REFUSED");
      // A campaign fence must name a ccc-prd run, never the planning run.
      await expectRefusal(publishCccPlanningArtifact(layerA, review(`WI-campaign-${run.taskId}`, run.runId)), "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID");
      expect(await countDocuments(run)).toBe(0);

      const admitted = await publishCccPlanningArtifact(layerA, review(`WI-campaign-${run.taskId}`, `ccc-prd:${importId}`));
      expect(admitted).toMatchObject({ key: "cccplan-r001-g7-t1-v01", replayed: false });
      expect(admitted.envelope.fence).toMatchObject({ kind: "campaign_work_item_lease", runId: `ccc-prd:${importId}` });
    });

    it("keeps the layer's project: another project's layer neither reads, lists nor publishes this task's artifacts; the owning layer does", async () => {
      const run = await admittedRun();
      const published = await publishCccPlanningArtifact(layerA, requestInput(run));

      expect(await readCccPlanningArtifact(layerB, run.taskId, published.key)).toBeNull();
      expect(await listCccPlanningArtifacts(layerB, run.taskId)).toEqual([]);
      await expectRefusal(
        publishCccPlanningArtifact(layerB, requestInput(run, {
          slot: { runRevision: 1, stageId: "admission", slot: "request", version: 2 },
        })),
        "CCC_PLANNING_RUN_NOT_FOUND",
      );
      expect(await countDocuments(run)).toBe(1);

      expect((await readCccPlanningArtifact(layerA, run.taskId, published.key))?.text).toBe(REQUEST_TEXT);
      expect(await listCccPlanningArtifacts(layerA, run.taskId)).toHaveLength(1);
    });
  });

  describe("archive cleanup", () => {
    it("archive cleanup of an archived planning task does not throw and keeps its artifacts; an archived ordinary task is still cleaned up", async () => {
      const store = harness.store;
      const ordinary = await store.createTask({ description: "ordinary archived task" });
      await store.archiveTask(ordinary.id);
      const planning = await store.createTask({ description: "held planning task" });
      const run = await admittedRun(LEGACY_PROJECT, planning.id);
      const published = await publishCccPlanningArtifact(harness.layer, requestInput(run));
      expect(published.replayed).toBe(false);
      // Direct SQL, not archiveTask: the custody guards of a later card refuse that path for a held planning task.
      await db.execute(sql`
        UPDATE project.tasks SET "column" = 'archived', updated_at = ${NOW}
         WHERE project_id = ${LEGACY_PROJECT} AND id = ${planning.id}
      `);

      const cleaned = await store.cleanupArchivedTasks();

      expect(cleaned).toContain(ordinary.id);
      expect(cleaned).not.toContain(planning.id);
      const live = (await db.execute(sql`
        SELECT id FROM project.tasks WHERE project_id = ${LEGACY_PROJECT} AND id IN (${ordinary.id}, ${planning.id}) ORDER BY id
      `)) as unknown as Array<{ id: string }>;
      expect(live.map((row) => row.id)).toEqual([planning.id]);
      expect(await countDocuments(run)).toBe(1);
      const anchors = (await db.execute(sql`
        SELECT run_id FROM project.ccc_planning_runs WHERE project_id = ${LEGACY_PROJECT} AND planning_task_id = ${planning.id}
      `)) as unknown as Array<{ run_id: string }>;
      expect(anchors).toEqual([{ run_id: run.runId }]);
      expect((await readCccPlanningArtifact(harness.layer, planning.id, published.key))?.text).toBe(REQUEST_TEXT);

      // Cleaning up again is a no-op for the held task: no throw, nothing removed.
      await expect(store.cleanupArchivedTasks()).resolves.not.toContain(planning.id);
      expect(await countDocuments(run)).toBe(1);
    });
  });
});
