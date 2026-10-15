/**
 * FNXC:CccPlanningImportLink 2026-10-14-22:45 (card IM1):
 * The import intent and the import link of a request-to-code Build run (CONTRACT-v3.5 section 2.11, D16, D17) against
 * a real PostgreSQL, through a layer that runs as the application's own role (`fusion_runtime`) bound to one project,
 * so row-level security, the anchor trigger (0042) and the artifact guard (0043) are all live.
 *
 * Fixtures are written with direct SQL as the harness superuser, the way the L1 and A1 tests write them: a Build run
 * moved admitted -> running -> spec_ready -> importing, its planning work item running under a live lease, and the two
 * import-stage artifacts the intent is checked against (`admission_facts` and `bundle`), published through A1's
 * publisher under that lease. Every refusal is paired with a control that differs in the one offending fact and is
 * accepted on the same kind of fixture, so a refusal can never pass because the fixture is broken. Refusals are
 * matched on the typed CccPlanningRefusal code, never on message text.
 *
 * Non-vacuity, as the card states it:
 * - atomicity: the anchor CAS and the import_intent artifact are written in one transaction, so a failing
 *   `beforeArtifact` hook leaves no intent digest; an implementation that commits the CAS on its own fails the test.
 *   FNXC:CccPlanningImportLink 2026-10-14-23:20 (repair 1): the hook alone could not tell where it ran, so the hook
 *   test also requires, while the hook runs, one open writer holding a write lock on the anchor table only, and a
 *   second test makes the artifact publication itself fail (SLOT_CONFLICT), which rolls the CAS back whatever the
 *   hook order;
 * - bounds: the drifted intent carries exactly the limits stored in `admission_facts`, so only an implementation that
 *   reads the published bundle artifact refuses it.
 *
 * FNXC:CccPlanningImportLink 2026-10-14-23:48 (card IM1, repair 2, errata E13):
 * The bounds are tied to the bundle that is actually imported (the adversary's X1). The fixture bundle now carries its
 * own bundleHash, sourceHash and sidecarHash, equal to the intent's bundleHash, packetHash and sidecarHash, as a real
 * semantic bundle does, and the importer row carries `canonical_bundle.bounds` equal to the intent's limits. The new
 * REDs: an intent naming another bundle than the published one (or another packet or sidecar, or a bundle with no
 * bundleHash) is refused at record; a link whose import row's canonical bounds differ from the intent's limits is
 * refused although its bundle hash matches; and a bundle or admission_facts artifact whose envelope status is not
 * `complete` is never the bounds source. Each refusal's control differs in that one fact and is accepted.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { cccPlanningRuns } from "../../postgres/schema/ccc-planning.js";
import { canonicalCccPrdJson } from "../../ccc-prd/contract.js";
import type {
  CccPlanningArtifactPolicy,
  CccPlanningArtifactRef,
  CccPlanningArtifactStatus as ArtifactStatus,
} from "../../ccc-planning/artifacts.js";
import { CccPlanningRefusal, type CccPlanningRefusalCode } from "../../ccc-planning/errors.js";
import { cccPlanningEventId, cccPlanningImportKey } from "../../ccc-planning/policy.js";
import type { CccPlanningWorkItemFence } from "../../ccc-planning/types.js";
import { publishCccPlanningArtifact } from "../../task-store/ccc-planning-artifact-ops.js";
import {
  inspectCccPlanningImportLink,
  linkCccPlanningImport,
  recordCccPlanningImportIntent,
  type CccPlanningImportClosure,
  type CccPlanningImportIntentV1,
  type CccPlanningImportReceiptV1,
} from "../../task-store/ccc-planning-import-ops.js";

const PROJECT = "r2c-im1-import-link";
const NOW = "2026-10-14T12:00:00.000Z";
const FAR = "2999-01-01T00:00:00.000Z";
const BOUNDS_AT = "2026-10-14T11:59:00.000Z";
const LEASE_OWNER = "h1-import-worker";
const TARGET = "/private/tmp/r2c-im1-target";
const INTENT_KEY = "cccplan-r001-import-intent-v01";
const RECEIPT_KEY = "cccplan-r001-import-receipt-v01";

type Limits = CccPlanningImportIntentV1["limits"];
type Bounds = Readonly<{ maxRequests: number; maxDurationMs: number; maxConcurrency: number }>;
type Row = Record<string, unknown>;

/** D16 for a Build Standard run 20 hours before its deadline: 3,072 calls, 20 h - 30 s, one writer at a time. */
const LIMITS: Limits = {
  maxRequests: 3072, maxDurationMs: 71_970_000, maxConcurrency: 1, boundsComputedAt: BOUNDS_AT,
  clamps: [{ field: "maxDurationMs", requested: 86_400_000, applied: 71_970_000, reason: "deadline-headroom" }],
};

const NO_POLICY: CccPlanningArtifactPolicy = {
  promptVersion: "none", promptDigest: "none", toolPolicyVersion: "none", toolPolicyDigest: "none",
};
const CONTROLLER = { kind: "controller", roleId: "controller", instanceId: "controller:import" } as const;

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function bundleBoundsOf(limits: Limits): Bounds {
  return { maxRequests: limits.maxRequests, maxDurationMs: limits.maxDurationMs, maxConcurrency: limits.maxConcurrency };
}

type BundleIdentity = Readonly<{ bundleHash?: string; sourceHash?: string; sidecarHash?: string }>;

/** The published bundle's own identity, equal to what `intentFor` names by default (sourceHash is the packet hash). */
function bundleIdentityOf(runId: string): BundleIdentity {
  return { bundleHash: sha(`bundle:${runId}`), sourceHash: sha(`packet:${runId}`), sidecarHash: sha(`sidecar:${runId}`) };
}

function syntheticRef(artifactKey: string): CccPlanningArtifactRef {
  return { artifactKey, digest: sha(`artifact:${artifactKey}`) };
}

const CLOSURE: CccPlanningImportClosure = {
  originalRequest: syntheticRef("cccplan-r001-admission-request-v01"),
  admissionGrant: syntheticRef("cccplan-r001-admission-grant-v01"),
  buildGrant: syntheticRef("cccplan-r001-operator-build-v01"),
  buildTransition: syntheticRef("cccplan-r001-import-transition-v01"),
  acceptanceCases: syntheticRef("cccplan-r001-intent-cases-v01"),
  requirementMap: syntheticRef("cccplan-r001-spec-map-v01"),
  finalPrd: syntheticRef("cccplan-r001-spec-prd-v01"),
  technicalAnnex: syntheticRef("cccplan-r001-spec-annex-v01"),
  taskPlan: syntheticRef("cccplan-r001-plan-tasks-v01"),
  routingPlan: syntheticRef("cccplan-r001-plan-routing-v01"),
  verifierBundle: syntheticRef("cccplan-r001-verifier-bundle-v01"),
  oracleAudit: syntheticRef("cccplan-r001-verifier-audit-v01"),
  finalAdjudication: syntheticRef("cccplan-r001-review-adjudication-v01"),
};

type Run = Readonly<{
  runId: string; taskId: string; workItemId: string; fence: CccPlanningWorkItemFence;
  factsRef: CccPlanningArtifactRef; bundleRef: CccPlanningArtifactRef;
}>;

function intentFor(run: Pick<Run, "runId">, limits: Limits = LIMITS, overrides: Partial<CccPlanningImportIntentV1> = {}):
  CccPlanningImportIntentV1 {
  return {
    schema: "ccc-planning.import-intent.v1", runId: run.runId, runRevision: 1,
    idempotencyKey: cccPlanningImportKey(run.runId, 1), bundleHash: sha(`bundle:${run.runId}`),
    packetHash: sha(`packet:${run.runId}`), sidecarHash: sha(`sidecar:${run.runId}`),
    executionPolicyDigest: sha("ccc-campaign.execution-policy.v2"), targetRepository: TARGET,
    targetBase: "c".repeat(40), targetHead: "c".repeat(40),
    baselineBranchRef: `refs/heads/fusion/r2c-${run.runId.slice("ccc-plan:".length)}-r001-baseline`,
    buildTransitionRef: CLOSURE.buildTransition, limits, closure: CLOSURE, closureDigest: sha(`closure:${run.runId}`),
    receiptSha256: sha(`receipt:${run.runId}`),
    ...overrides,
  };
}

function digestOf(intent: CccPlanningImportIntentV1): string {
  return sha(canonicalCccPrdJson(intent));
}

async function expectRefusal(attempt: Promise<unknown>, code: CccPlanningRefusalCode): Promise<void> {
  const error = await attempt.then(() => null, (failure: unknown) => failure);
  expect(error, `expected a ${code} refusal but the call resolved`).not.toBeNull();
  expect(error).toBeInstanceOf(CccPlanningRefusal);
  expect((error as CccPlanningRefusal).code).toBe(code);
}

pgDescribe("ccc planning import intent and link (card IM1, PostgreSQL)", () => {
  let harness: PgTestHarness;
  let db: PostgresJsDatabase;
  let connections: PostgresConnections;
  let layer: AsyncDataLayer;

  beforeAll(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_ccc_planning_im1", copyFromGolden: true });
    db = harness.adminDb;
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: harness.testUrl, migrationUrl: harness.testUrl, migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, {
      poolMax: 2, connectTimeoutSeconds: 5, projectId: PROJECT, useRuntimeRole: true,
    });
    layer = createAsyncDataLayer(connections, { projectId: PROJECT });
  });

  afterAll(async () => {
    await connections?.close();
    await harness?.teardown();
  });

  let ordinal = 0;

  async function moveTo(runId: string, state: string): Promise<void> {
    await db.execute(sql`
      UPDATE project.ccc_planning_runs SET state = ${state}, updated_at = ${NOW}
       WHERE project_id = ${PROJECT} AND run_id = ${runId}
    `);
  }

  /** A Build run in `importing` (or `spec_ready`), its planning work item leased, and both import-stage artifacts published. */
  async function seedRun(options: {
    bundleBounds?: Bounds; factsBounds?: Limits; state?: "importing" | "spec_ready";
    bundleIdentity?: (runId: string) => BundleIdentity; bundleStatus?: ArtifactStatus; factsStatus?: ArtifactStatus;
  } = {}): Promise<Run> {
    ordinal += 1;
    const taskId = `R2C-IM1-${ordinal}`;
    const runId = `ccc-plan:${sha(`r2c-im1-run-${ordinal}`).slice(0, 24)}`;
    const workItemId = `wi-${taskId}`;
    await db.execute(sql`
      INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
      VALUES (${PROJECT}, ${taskId}, ${`request-to-code planning task ${taskId}`}, 'todo', ${NOW}, ${NOW})
    `);
    await db.insert(cccPlanningRuns).values({
      projectId: PROJECT, runId, planningTaskId: taskId, mode: "build", budgetProfile: "standard", roleProfile: "full-v2",
      policyVersion: "ccc-planning.budget-policy.v1", policyDigest: sha("policy"), requestDigest: sha(`request:${runId}`),
      requestBytes: 512, targetRepository: TARGET, admittedBase: "b".repeat(40), grantDigest: sha(`grant:${runId}`),
      authorityReceiptSha256: sha(`receipt:${runId}`), authorityReceiptJson: JSON.stringify({ runId }),
      runtimeDistManifestSha256: sha("dist"), state: "admitted", deadlineAt: FAR, planningAllocation: 1536,
      implementationAllocation: 3072, reviewProofAllocation: 512, researchFetchAllocation: 5,
      researchBytesAllocation: 1_048_576, createdAt: NOW, updatedAt: NOW,
    });
    await db.execute(sql`
      INSERT INTO project.workflow_work_items
        (project_id, id, run_id, task_id, node_id, kind, state, attempt, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (${PROJECT}, ${workItemId}, ${runId}, ${taskId}, 'import', 'task', 'running', 1, ${LEASE_OWNER}, ${FAR},
              ${NOW}, ${NOW})
    `);
    const target = options.state ?? "importing";
    for (const state of ["running", "spec_ready", "importing"]) {
      await moveTo(runId, state);
      if (state === target) break;
    }
    const lease = { kind: "work_item_lease", workItemId, leaseOwner: LEASE_OWNER, attempt: 1, runId } as const;
    const common = { planningTaskId: taskId, runId, inputs: [], producer: CONTROLLER, policy: NO_POLICY,
      fence: lease, now: NOW } as const;
    const facts = await publishCccPlanningArtifact(layer, {
      ...common, status: options.factsStatus ?? "complete",
      slot: { runRevision: 1, stageId: "import", slot: "facts", version: 1 }, kind: "admission_facts",
      contentSchema: "ccc-planning.admission-facts.v1",
      content: { type: "json", value: { schema: "ccc-planning.admission-facts.v1", targetRepository: TARGET,
        bounds: options.factsBounds ?? LIMITS } },
    });
    const bundle = await publishCccPlanningArtifact(layer, {
      ...common, status: options.bundleStatus ?? "complete",
      slot: { runRevision: 1, stageId: "import", slot: "bundle", version: 1 }, kind: "bundle",
      contentSchema: "ccc-prd.semantic-bundle.v2",
      content: { type: "json", value: { schemaVersion: 2, ...(options.bundleIdentity ?? bundleIdentityOf)(runId),
        bounds: options.bundleBounds ?? bundleBoundsOf(LIMITS), tasks: [] } },
    });
    return {
      runId, taskId, workItemId,
      fence: { kind: "planning", workItemId, runId, attempt: 1, leaseOwner: LEASE_OWNER, originTaskId: taskId },
      factsRef: { artifactKey: facts.key, digest: facts.envelope.outputDigest },
      bundleRef: { artifactKey: bundle.key, digest: bundle.envelope.outputDigest },
    };
  }

  /** The importer's canonical bundle for the run's import key holds `bounds`, or no bounds at all when undefined. */
  async function setImportBounds(run: Run, bounds: unknown): Promise<void> {
    await db.execute(sql`
      UPDATE project.ccc_prd_imports SET canonical_bundle = ${JSON.stringify(bounds === undefined ? {} : { bounds })}::jsonb
       WHERE project_id = ${PROJECT} AND idempotency_key = ${cccPlanningImportKey(run.runId, 1)}
    `);
  }

  /** The importer's own row for the run's import key, as `importCccPrdBundle` leaves it, with the given bundle hash and
   *  the run's bounds in its canonical bundle (the importer's budget comes from `canonical_bundle.bounds`). */
  async function seedImportRow(run: Run, bundleHash: string, bounds: unknown = bundleBoundsOf(LIMITS)): Promise<string> {
    const importId = `r2c-im1-import-${run.taskId}`;
    const digest = sha(`import:${importId}`);
    await db.execute(sql`
      INSERT INTO project.ccc_prd_imports (
        project_id, idempotency_key, import_id, identity_hash, bundle_hash, packet_hash, sidecar_hash,
        source_version, target_repository, target_base, root_dir, staging_relative_path, state, runnable,
        canonical_bundle, transaction_witness, projection_digest, created_at, updated_at,
        execution_policy, campaign_manifest, campaign_manifest_hash, campaign_started_at, campaign_deadline_at
      ) VALUES (
        ${PROJECT}, ${cccPlanningImportKey(run.runId, 1)}, ${importId}, ${digest}, ${bundleHash}, ${digest}, ${digest},
        'v1', ${TARGET}, ${"c".repeat(40)}, '/private/tmp/r2c-im1-root', 'stage', 'active', 1,
        ${JSON.stringify({ bounds })}::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${NOW},
        '{}'::jsonb, '{}'::jsonb, ${digest}, ${NOW}, ${FAR}
      )
    `);
    return importId;
  }

  async function anchor(run: Run): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT state, import_intent_digest, import_idempotency_key, import_id, implementation_transferred
        FROM project.ccc_planning_runs WHERE project_id = ${PROJECT} AND run_id = ${run.runId}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function documents(run: Run, key: string): Promise<Array<{ key: string; content: string; metadata: Row }>> {
    return (await db.execute(sql`
      SELECT key, content, metadata FROM project.task_documents
       WHERE project_id = ${PROJECT} AND task_id = ${run.taskId} AND key = ${key}
    `)) as unknown as Array<{ key: string; content: string; metadata: Row }>;
  }

  async function events(run: Run, mutationType: string): Promise<Row[]> {
    return (await db.execute(sql`
      SELECT id, agent_id, target, metadata FROM project.run_audit_events
       WHERE project_id = ${PROJECT} AND run_id = ${run.runId} AND mutation_type = ${mutationType} ORDER BY timestamp, id
    `)) as unknown as Row[];
  }

  function record(run: Run, intent: CccPlanningImportIntentV1, beforeArtifact?: () => Promise<void>) {
    return recordCccPlanningImportIntent(layer, {
      runId: run.runId, intent, fence: run.fence, ...(beforeArtifact ? { hooks: { beforeArtifact } } : {}),
    });
  }

  async function expectNoIntent(run: Run): Promise<void> {
    expect(await anchor(run)).toMatchObject({ state: "importing", import_intent_digest: null, import_idempotency_key: null });
    expect(await documents(run, INTENT_KEY)).toHaveLength(0);
    expect(await events(run, "ccc-planning:import-intent")).toHaveLength(0);
  }

  it("records an intent whose limits equal the bundle bounds once, with the import key, the artifact and one event, and replays it with replayed: true", async () => {
    const run = await seedRun();
    const intent = intentFor(run);
    const digest = digestOf(intent);
    const importKey = cccPlanningImportKey(run.runId, 1);
    const beforeArtifact = vi.fn(async () => undefined);

    await expect(record(run, intent, beforeArtifact)).resolves.toEqual({ intentDigest: digest, replayed: false });
    expect(beforeArtifact).toHaveBeenCalledTimes(1);
    expect(await anchor(run)).toMatchObject({
      state: "importing", import_intent_digest: digest, import_idempotency_key: importKey, import_id: null,
      implementation_transferred: null,
    });
    const stored = await documents(run, INTENT_KEY);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.content)).toEqual(intent);
    expect(stored[0]!.metadata).toMatchObject({
      kind: "import_intent", stageId: "import", slot: "intent", runRevision: 1, outputDigest: digest,
      contentSchema: "ccc-planning.import-intent.v1",
      inputs: [run.bundleRef, run.factsRef].sort((left, right) => (left.artifactKey < right.artifactKey ? -1 : 1)),
      fence: { kind: "work_item_lease", workItemId: run.workItemId, leaseOwner: LEASE_OWNER, attempt: 1, runId: run.runId },
    });
    const recorded = await events(run, "ccc-planning:import-intent");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      id: cccPlanningEventId({ projectId: PROJECT, runId: run.runId, mutationType: "ccc-planning:import-intent", subject: importKey }),
      agent_id: "ccc-planning-controller", target: importKey,
    });

    await expect(record(run, intent, beforeArtifact)).resolves.toEqual({ intentDigest: digest, replayed: true });
    expect(beforeArtifact).toHaveBeenCalledTimes(1);
    expect(await documents(run, INTENT_KEY)).toHaveLength(1);
    expect(await events(run, "ccc-planning:import-intent")).toHaveLength(1);
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:20 (card IM1, repair 1):
   * A failing hook alone cannot tell where the hook ran, so an implementation that calls it before two separate
   * transactions passed this test. While the hook runs, the admin connection therefore requires exactly one open
   * writing transaction and reads the project tables it holds a granted RowExclusiveLock on: only the anchor
   * (`ccc_planning_runs`). The CAS is in flight and uncommitted, and neither the artifact (`task_documents`) nor the
   * event (`run_audit_events`) is written yet, so the rollback below proves they share the CAS's transaction.
   */
  it("a failing beforeArtifact hook rolls back the anchor CAS with the artifact, so the anchor has no intent digest; the same intent then records", async () => {
    const run = await seedRun();
    const intent = intentFor(run);
    const injected = new Error("injected failure before the import_intent artifact");
    let inFlight: string[] | null = null;
    const failing = vi.fn(async () => {
      const writers = (await db.execute(sql`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
           AND backend_xid IS NOT NULL
      `)) as unknown as Array<{ pid: number }>;
      expect(writers, "the intent transaction is the one open writer while the hook runs").toHaveLength(1);
      inFlight = ((await db.execute(sql`
        SELECT c.relname FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE l.pid = ${writers[0]!.pid} AND l.locktype = 'relation' AND l.mode = 'RowExclusiveLock' AND l.granted
           AND n.nspname = 'project' AND c.relkind IN ('r', 'p')
      `)) as unknown as Array<{ relname: string }>).map((row) => row.relname).sort();
      throw injected;
    });

    await expect(record(run, intent, failing)).rejects.toBe(injected);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(inFlight, "the anchor CAS is in flight and nothing else is written yet").toEqual(["ccc_planning_runs"]);
    await expectNoIntent(run);

    await expect(record(run, intent)).resolves.toEqual({ intentDigest: digestOf(intent), replayed: false });
    expect(await anchor(run)).toMatchObject({ import_intent_digest: digestOf(intent) });
    expect(await documents(run, INTENT_KEY)).toHaveLength(1);
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:20 (card IM1, repair 1):
   * Atomicity whatever the hook order: the import_intent publication itself fails inside the intent's transaction,
   * because its slot already holds other bytes (A1 refuses SLOT_CONFLICT). An implementation that commits the anchor
   * CAS in a transaction of its own leaves the intent digest set; here it must roll back with the refused artifact, and
   * no import-intent event may exist. The records-once test above, on an unoccupied run, is the positive control.
   */
  it("a refused import_intent publication (its slot already holds other bytes) rolls back the anchor CAS with it, whatever the hook order", async () => {
    const run = await seedRun();
    const occupied = { occupied: run.runId };
    await publishCccPlanningArtifact(layer, {
      planningTaskId: run.taskId, runId: run.runId, inputs: [], producer: CONTROLLER, policy: NO_POLICY, status: "complete",
      fence: { kind: "work_item_lease", workItemId: run.workItemId, leaseOwner: LEASE_OWNER, attempt: 1, runId: run.runId },
      now: NOW, slot: { runRevision: 1, stageId: "import", slot: "intent", version: 1 }, kind: "import_intent",
      contentSchema: "ccc-planning.import-intent.v1", content: { type: "json", value: occupied },
    });
    const hook = vi.fn(async () => undefined);

    await expectRefusal(record(run, intentFor(run), hook), "CCC_PLANNING_ARTIFACT_SLOT_CONFLICT");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await anchor(run)).toMatchObject({ state: "importing", import_intent_digest: null, import_idempotency_key: null });
    expect(await events(run, "ccc-planning:import-intent")).toHaveLength(0);
    const stored = await documents(run, INTENT_KEY);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.content)).toEqual(occupied);
  });

  it("refuses a second intent with another digest with IMPORT_LINK_WRITE_ONCE and writes nothing; the first intent still replays", async () => {
    const run = await seedRun();
    const first = intentFor(run);
    const second = intentFor(run, LIMITS, { packetHash: sha(`another packet:${run.runId}`) });
    expect(digestOf(second)).not.toBe(digestOf(first));
    await expect(record(run, first)).resolves.toMatchObject({ replayed: false });

    await expectRefusal(record(run, second), "CCC_PLANNING_IMPORT_LINK_WRITE_ONCE");
    expect(await anchor(run)).toMatchObject({ import_intent_digest: digestOf(first) });
    const stored = await documents(run, INTENT_KEY);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.content)).toEqual(first);
    expect(await events(run, "ccc-planning:import-intent")).toHaveLength(1);

    await expect(record(run, first)).resolves.toEqual({ intentDigest: digestOf(first), replayed: true });
  });

  it("refuses an intent whose maxDurationMs is 1 ms off the published bundle bounds with IMPORT_IDENTITY_DRIFT although admission_facts holds exactly those limits; a twin whose bundle agrees records", async () => {
    const drifted: Limits = { ...LIMITS, maxDurationMs: LIMITS.maxDurationMs + 1 };
    const run = await seedRun({ bundleBounds: bundleBoundsOf(LIMITS), factsBounds: drifted });

    await expectRefusal(record(run, intentFor(run, drifted)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    await expectNoIntent(run);

    const twin = await seedRun({ bundleBounds: bundleBoundsOf(drifted), factsBounds: drifted });
    await expect(record(twin, intentFor(twin, drifted))).resolves.toMatchObject({ replayed: false });
  });

  it("refuses an intent whose limits are 1 ms off admission_facts with IMPORT_IDENTITY_DRIFT although the bundle agrees; a twin whose facts agree records", async () => {
    const run = await seedRun({ factsBounds: { ...LIMITS, maxDurationMs: LIMITS.maxDurationMs - 1 } });

    await expectRefusal(record(run, intentFor(run)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    await expectNoIntent(run);

    const twin = await seedRun();
    await expect(record(twin, intentFor(twin))).resolves.toMatchObject({ replayed: false });
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:48 (card IM1, repair 2, errata E13 item 1(a)):
   * The adversary's X1, first half: the published bundle artifact is bundle A and its bounds equal the intent's limits,
   * but the intent names bundle B. Before E13 the intent recorded, so the limits could be checked against one bundle and
   * the importer run another. The control is the same run with the intent that names bundle A.
   */
  it("refuses an intent that names another bundle than the published bundle artifact's own bundleHash with IMPORT_IDENTITY_DRIFT although its limits equal that bundle's bounds; the same run records the intent that names it", async () => {
    const run = await seedRun();
    const other = intentFor(run, LIMITS, { bundleHash: sha(`bundle-B-never-published:${run.runId}`) });

    await expectRefusal(record(run, other), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    await expectNoIntent(run);

    const named = intentFor(run);
    expect(named.bundleHash).toBe(bundleIdentityOf(run.runId).bundleHash);
    await expect(record(run, named)).resolves.toEqual({ intentDigest: digestOf(named), replayed: false });
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:48 (card IM1, repair 2, errata E13 item 1(a)):
   * The same identity rule for the bundle's sourceHash (the intent's packetHash) and sidecarHash, which a real semantic
   * bundle carries, and the bundleHash is required: a bundle that names no bundleHash cannot be the one the intent names.
   */
  it("refuses an intent whose packetHash or sidecarHash differs from the published bundle's sourceHash or sidecarHash, or whose bundle carries no bundleHash, with IMPORT_IDENTITY_DRIFT; the same run records the intent that agrees", async () => {
    const run = await seedRun();
    for (const overrides of [
      { packetHash: sha(`another packet:${run.runId}`) },
      { sidecarHash: sha(`another sidecar:${run.runId}`) },
    ]) {
      await expectRefusal(record(run, intentFor(run, LIMITS, overrides)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
      await expectNoIntent(run);
    }

    const unnamed = await seedRun({
      bundleIdentity: (runId) => ({ sourceHash: sha(`packet:${runId}`), sidecarHash: sha(`sidecar:${runId}`) }),
    });
    await expectRefusal(record(unnamed, intentFor(unnamed)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    await expectNoIntent(unnamed);

    await expect(record(run, intentFor(run))).resolves.toMatchObject({ replayed: false });
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:48 (card IM1, repair 2, errata E13 item 2):
   * Only a complete artifact may be the bounds source. Each refused fixture is identical to the control except for the
   * envelope status of one artifact.
   */
  it("refuses an intent whose bundle or admission_facts artifact has an envelope status other than complete with IMPORT_IDENTITY_DRIFT; the same bundle with status complete records", async () => {
    for (const status of ["refused", "blocked", "infeasible"] as const) {
      const run = await seedRun({ bundleStatus: status });
      await expectRefusal(record(run, intentFor(run)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
      await expectNoIntent(run);
    }
    const facts = await seedRun({ factsStatus: "refused" });
    await expectRefusal(record(facts, intentFor(facts)), "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    await expectNoIntent(facts);

    const twin = await seedRun({ bundleStatus: "complete", factsStatus: "complete" });
    await expect(record(twin, intentFor(twin))).resolves.toMatchObject({ replayed: false });
  });

  it("refuses an intent on a run that has not reached importing with STATE_TRANSITION_REFUSED; the same run records once it is importing", async () => {
    const run = await seedRun({ state: "spec_ready" });

    await expectRefusal(record(run, intentFor(run)), "CCC_PLANNING_STATE_TRANSITION_REFUSED");
    expect(await anchor(run)).toMatchObject({ state: "spec_ready", import_intent_digest: null });
    expect(await documents(run, INTENT_KEY)).toHaveLength(0);

    await moveTo(run.runId, "importing");
    await expect(record(run, intentFor(run))).resolves.toMatchObject({ replayed: false });
  });

  it("links the import row whose bundle hash equals the intent once: import_id, implementation_transferred, import_receipt and one event, and replays with replayed: true", async () => {
    const run = await seedRun();
    const intent = intentFor(run);
    await record(run, intent);
    const importId = await seedImportRow(run, intent.bundleHash);
    const importKey = cccPlanningImportKey(run.runId, 1);
    const expected: CccPlanningImportReceiptV1 = {
      schema: "ccc-planning.import-receipt.v1", runId: run.runId, runRevision: 1, idempotencyKey: importKey, importId,
      bundleHash: intent.bundleHash, intentDigest: digestOf(intent), implementationTransferred: LIMITS.maxRequests,
      maxDurationMs: LIMITS.maxDurationMs, replayed: false, release: "released",
    };

    await expect(linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "released" })).resolves.toEqual(expected);
    expect(await anchor(run)).toMatchObject({
      state: "importing", import_intent_digest: digestOf(intent), import_id: importId,
      implementation_transferred: LIMITS.maxRequests,
    });
    const stored = await documents(run, RECEIPT_KEY);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.content)).toEqual(expected);
    expect(stored[0]!.metadata).toMatchObject({
      kind: "import_receipt", stageId: "import", slot: "receipt", contentSchema: "ccc-planning.import-receipt.v1",
      inputs: [{ artifactKey: INTENT_KEY, digest: digestOf(intent) }],
    });
    const linked = await events(run, "ccc-planning:import-linked");
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      id: cccPlanningEventId({ projectId: PROJECT, runId: run.runId, mutationType: "ccc-planning:import-linked", subject: importKey }),
      target: importKey,
    });

    await expect(linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "released" }))
      .resolves.toEqual({ ...expected, replayed: true });
    expect(await documents(run, RECEIPT_KEY)).toHaveLength(1);
    expect(await events(run, "ccc-planning:import-linked")).toHaveLength(1);
  });

  it("refuses a link whose ccc_prd_imports bundle hash differs from the intent with IMPORT_IDENTITY_DRIFT and writes nothing; a twin whose row matches links", async () => {
    const run = await seedRun();
    const intent = intentFor(run);
    await record(run, intent);
    await seedImportRow(run, sha(`another bundle:${run.runId}`));

    await expectRefusal(linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "released" }),
      "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
    expect(await anchor(run)).toMatchObject({ import_intent_digest: digestOf(intent), import_id: null, implementation_transferred: null });
    expect(await documents(run, RECEIPT_KEY)).toHaveLength(0);
    expect(await events(run, "ccc-planning:import-linked")).toHaveLength(0);

    const twin = await seedRun();
    const twinIntent = intentFor(twin);
    await record(twin, twinIntent);
    const importId = await seedImportRow(twin, twinIntent.bundleHash);
    await expect(linkCccPlanningImport(layer, { runId: twin.runId, fence: twin.fence, release: "awaiting_operator" }))
      .resolves.toMatchObject({ importId, release: "awaiting_operator", replayed: false });
  });

  /**
   * FNXC:CccPlanningImportLink 2026-10-14-23:48 (card IM1, repair 2, errata E13 item 1(b)):
   * The adversary's X1, second half: the import row for the run's key holds the intent's bundle hash, but its canonical
   * bundle runs with bounds {10000, 86400000, 1}. Before E13 the link resolved and recorded implementation_transferred
   * 3072, a budget the linked campaign does not run with. Each drift below (X1's values, then one field at a time, then
   * no bounds) is refused and writes nothing; the control is the same row with the intent's bounds.
   */
  it("refuses a link whose ccc_prd_imports canonical bundle bounds differ from the intent's limits with IMPORT_IDENTITY_DRIFT and writes nothing although its bundle hash matches; the same row with the intent's bounds links", async () => {
    const run = await seedRun();
    const intent = intentFor(run);
    await record(run, intent);
    const x1 = { maxRequests: 10_000, maxDurationMs: 86_400_000, maxConcurrency: 1 };
    const importId = await seedImportRow(run, intent.bundleHash, x1);
    const exact = bundleBoundsOf(LIMITS);
    const drifts: unknown[] = [
      x1,
      { ...exact, maxRequests: exact.maxRequests - 1 },
      { ...exact, maxDurationMs: exact.maxDurationMs + 1 },
      { ...exact, maxConcurrency: 2 },
      undefined,
    ];

    for (const bounds of drifts) {
      await setImportBounds(run, bounds);
      await expectRefusal(linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "released" }),
        "CCC_PLANNING_IMPORT_IDENTITY_DRIFT");
      expect(await anchor(run)).toMatchObject({ import_intent_digest: digestOf(intent), import_id: null, implementation_transferred: null });
      expect(await documents(run, RECEIPT_KEY)).toHaveLength(0);
      expect(await events(run, "ccc-planning:import-linked")).toHaveLength(0);
    }

    await setImportBounds(run, exact);
    await expect(linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "released" })).resolves.toMatchObject({
      importId, implementationTransferred: LIMITS.maxRequests, maxDurationMs: LIMITS.maxDurationMs, replayed: false,
    });
    expect(await anchor(run)).toMatchObject({ import_id: importId, implementation_transferred: LIMITS.maxRequests });
  });

  it("reports none before the intent, intent-only with the stored intent after it, and linked with the receipt after the link", async () => {
    const run = await seedRun();
    const intent = intentFor(run);

    await expect(inspectCccPlanningImportLink(layer, run.runId)).resolves.toEqual({ kind: "none" });
    await record(run, intent);
    await expect(inspectCccPlanningImportLink(layer, run.runId)).resolves.toEqual({ kind: "intent-only", intent });

    await seedImportRow(run, intent.bundleHash);
    const receipt = await linkCccPlanningImport(layer, { runId: run.runId, fence: run.fence, release: "not_applicable" });
    await expect(inspectCccPlanningImportLink(layer, run.runId)).resolves.toEqual({ kind: "linked", receipt });
  });
});
