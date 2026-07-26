import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  importCccPrdBundle,
  atomicReserveCccCampaignProviderDispatch,
} from "../../index.js";
import {
  claimCccCampaignApproval,
  issueCccCampaignApproval,
} from "../../async-approval-request-store.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { createCccPrdImportTestBundle, createCccPrdImportTestExecutionPolicy, rehashCccPrdImportTestBundle } from "../../__test-utils__/ccc-prd-import-fixture.js";
import type { ApprovalRequestActorSnapshot } from "../../types.js";

const worker: ApprovalRequestActorSnapshot = { actorId: "controller-worker", actorType: "agent", actorName: "Controller" };
type TestBundle = ReturnType<typeof createCccPrdImportTestBundle>;

pgDescribe("CCC campaign provider controller (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_provider_controller" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(async () => {
    await h.layer().db.execute(sql`DROP TRIGGER IF EXISTS ccc_controller_fail_dispatched ON project.run_audit_events`);
    await h.layer().db.execute(sql`DROP FUNCTION IF EXISTS project.ccc_controller_fail_dispatched()`);
    await h.afterEach();
  }); afterAll(h.afterAll);

  async function fixture(
    suffix: string,
    options: Readonly<{ protectedActions?: TestBundle["protectedActions"]; taskProtectedActionIds?: readonly string[]; issueApproval?: boolean; baseCommit?: string }> = {},
  ) {
    const initial = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const semanticTaskId = initial.tasks[0]!.id;
    const protectedActions = options.protectedActions ?? [{ id: "ACTION-LIVE-EXECUTION", kind: "live_execution", target: "ccc-lab-super:pre-live-provider-gate", requiresOperatorDecision: true, operatorDecision: "approve_live_execution", spans: [initial.tasks[0]!.spans[0]!] }];
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      targetRepository: options.baseCommit ? { ...initial.targetRepository, baseCommit: options.baseCommit } : initial.targetRepository,
      bounds: { maxRequests: 3, maxDurationMs: 60_000, maxConcurrency: 1 },
      tasks: initial.tasks.map((task, index) => index === 0 ? { ...task, protectedActionIds: [...(options.taskProtectedActionIds ?? ["ACTION-LIVE-EXECUTION"])] } : task),
      protectedActions,
    });
    await importCccPrdBundle({ bundle: source, idempotencyKey: `controller-${suffix}`, store: h.store(), layer: h.layer(), rootDir: h.rootDir(), executionPolicy: createCccPrdImportTestExecutionPolicy(source) });
    const taskId = `TASK-${suffix}`;
    const campaign = await h.store().getCccCampaignContextForTask(taskId);
    if (!campaign) throw new Error("missing campaign");
    const action = { actionId: "ACTION-LIVE-EXECUTION", actionTarget: "ccc-lab-super:pre-live-provider-gate", requireProtected: true };
    const issued = options.issueApproval === false
      ? ({ id: `approval-${suffix}` } as Awaited<ReturnType<typeof issueCccCampaignApproval>>)
      : await issueCccCampaignApproval(h.layer(), { authorityStore: h.store(), rootDir: h.rootDir(), taskId, action, requester: worker, runId: `issue-${suffix}`, notBeforeAt: campaign.campaignStartedAt, expiresAt: campaign.campaignDeadlineAt });
    const claimToken = `claim-${suffix}`;
    if (options.issueApproval !== false) {
      await claimCccCampaignApproval(h.layer(), { authorityStore: h.store(), rootDir: h.rootDir(), taskId, action, claimant: worker, runId: `claim-${suffix}`, claimToken });
    }
    return { taskId, campaign, issued, claimToken };
  }

  function input(f: Awaited<ReturnType<typeof fixture>>, suffix: string) {
    return { layer: h.layer(), rootDir: h.rootDir(), authorityStore: h.store(), gitObservation: { targetRoot: f.campaign.targetRepository.path, expectedBaseObject: f.campaign.targetRepository.baseCommit, head: f.campaign.targetRepository.baseCommit, headDescendsFromExpectedBase: true as const }, taskId: f.taskId, approvalRequestId: f.issued.id, claimToken: f.claimToken, turnKey: `turn-${suffix}`, dispatchKey: `dispatch-${suffix}` };
  }

  async function counts() {
    const attempts = await h.layer().db.execute(sql`SELECT mutation_type FROM project.run_audit_events WHERE mutation_type LIKE 'ccc-campaign:provider-attempt:%'`);
    const imports = await h.layer().db.execute(sql`SELECT request_count::int AS request_count FROM project.ccc_prd_imports` ) as unknown as Array<{ request_count: number }>;
    return { attempts: attempts.length, requestCount: imports[0]?.request_count ?? 0 };
  }

  it("requires one exact active claimed approval and lease before atomic reservation", async () => {
    const f = await fixture("exact");
    await expect(atomicReserveCccCampaignProviderDispatch(input(f, "exact"))).resolves.toMatchObject({ kind: "dispatch-permit", scope: { semanticTaskId: f.campaign.semanticTaskId, binding: { actionId: "ACTION-LIVE-EXECUTION", actionTarget: "ccc-lab-super:pre-live-provider-gate" } } });
    expect(await counts()).toEqual({ attempts: 2, requestCount: 1 });
  });

  it("accepts a canonical 64-character local Git head observation", async () => {
    const f = await fixture("sha256-head", { baseCommit: "b".repeat(64) });
    await expect(atomicReserveCccCampaignProviderDispatch({
      ...input(f, "sha256-head"),
      gitObservation: {
        targetRoot: f.campaign.targetRepository.path,
        expectedBaseObject: f.campaign.targetRepository.baseCommit,
        head: "b".repeat(64),
        headDescendsFromExpectedBase: true,
      },
    })).resolves.toMatchObject({ kind: "dispatch-permit", scope: { binding: { actionId: "ACTION-LIVE-EXECUTION" } } });
    expect(await counts()).toEqual({ attempts: 2, requestCount: 1 });
  });

  it("refuses expired approval before any request-count or audit mutation", async () => {
    const f = await fixture("expired");
    await h.layer().db.execute(sql`UPDATE project.approval_requests SET not_before_at = ${new Date(Date.now() - 2_000).toISOString()}, expires_at = ${new Date(Date.now() - 1_000).toISOString()} WHERE id = ${f.issued.id}`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(f, "expired"))).rejects.toThrow(/active provider-dispatch window|active/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses future not-before, wrong approval identity, and wrong claim token without writes", async () => {
    const f = await fixture("approval-negative");
    await h.layer().db.execute(sql`UPDATE project.approval_requests SET not_before_at = ${new Date(Date.now() + 30_000).toISOString()}, expires_at = ${new Date(Date.now() + 60_000).toISOString()} WHERE id = ${f.issued.id}`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(f, "approval-negative"))).rejects.toThrow(/active provider-dispatch window|active/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
    await h.layer().db.execute(sql`UPDATE project.approval_requests SET not_before_at = ${f.campaign.campaignStartedAt}, expires_at = ${f.campaign.campaignDeadlineAt} WHERE id = ${f.issued.id}`);
    await expect(atomicReserveCccCampaignProviderDispatch({ ...input(f, "approval-negative"), approvalRequestId: "foreign-approval" })).rejects.toThrow(/identity|custody/i);
    await expect(atomicReserveCccCampaignProviderDispatch({ ...input(f, "approval-negative"), claimToken: "foreign-claim" })).rejects.toThrow(/claimed|token/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses a missing persisted action lease without campaign writes", async () => {
    const f = await fixture("missing-lease");
    await h.layer().db.execute(sql`UPDATE project.ccc_prd_imports SET active_action_leases = '{}'::jsonb WHERE import_id = ${f.issued.campaign!.binding.importId}`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(f, "missing-lease"))).rejects.toThrow(/lease/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses corrupted persisted route and semantic task custody without campaign writes", async () => {
    const route = await fixture("route-drift");
    await h.layer().db.execute(sql`UPDATE project.ccc_prd_imports SET execution_policy = jsonb_set(execution_policy, '{routes,0,providerId}', '"foreign-provider"'::jsonb) WHERE import_id = ${route.issued.campaign!.binding.importId}`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(route, "route-drift"))).rejects.toThrow(/route|campaign/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });

    const semantic = await fixture("semantic-drift");
    await h.layer().db.execute(sql`UPDATE project.ccc_prd_import_entities SET entity_id = 'foreign-semantic-task' WHERE import_id = ${semantic.issued.campaign!.binding.importId} AND native_id = ${semantic.taskId}`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(semantic, "semantic-drift"))).rejects.toThrow(/semantic|route|campaign/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("rolls back reservation and count when begin is interrupted", async () => {
    const f = await fixture("rollback");
    await h.layer().db.execute(sql`CREATE FUNCTION project.ccc_controller_fail_dispatched() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.mutation_type = 'ccc-campaign:provider-attempt:dispatched' THEN RAISE EXCEPTION 'injected dispatched stage failure'; END IF; RETURN NEW; END $$`);
    await h.layer().db.execute(sql`CREATE TRIGGER ccc_controller_fail_dispatched BEFORE INSERT ON project.run_audit_events FOR EACH ROW EXECUTE FUNCTION project.ccc_controller_fail_dispatched()`);
    await expect(atomicReserveCccCampaignProviderDispatch(input(f, "rollback"))).rejects.toThrow(/Failed query/);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses a foreign Git target before campaign attempt writes", async () => {
    const f = await fixture("foreign-git");
    await expect(atomicReserveCccCampaignProviderDispatch({ ...input(f, "foreign-git"), gitObservation: { targetRoot: "/foreign", expectedBaseObject: f.campaign.targetRepository.baseCommit, head: f.campaign.targetRepository.baseCommit, headDescendsFromExpectedBase: true } })).rejects.toThrow(/snapshot.*custody/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses a foreign Git expected base before campaign attempt writes", async () => {
    const f = await fixture("foreign-base");
    await expect(atomicReserveCccCampaignProviderDispatch({ ...input(f, "foreign-base"), gitObservation: { targetRoot: f.campaign.targetRepository.path, expectedBaseObject: "0".repeat(40), head: f.campaign.targetRepository.baseCommit, headDescendsFromExpectedBase: true } })).rejects.toThrow(/snapshot.*custody/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses a noncanonical Git head before campaign attempt writes", async () => {
    const f = await fixture("noncanonical-head");
    await expect(atomicReserveCccCampaignProviderDispatch({
      ...input(f, "noncanonical-head"),
      gitObservation: {
        targetRoot: f.campaign.targetRepository.path,
        expectedBaseObject: f.campaign.targetRepository.baseCommit,
        head: "B".repeat(64),
        headDescendsFromExpectedBase: true,
      },
    })).rejects.toThrow(/snapshot.*custody/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses mixed Git object formats before campaign attempt writes", async () => {
    const f = await fixture("mixed-object-format");
    await expect(atomicReserveCccCampaignProviderDispatch({
      ...input(f, "mixed-object-format"),
      gitObservation: {
        targetRoot: f.campaign.targetRepository.path,
        expectedBaseObject: f.campaign.targetRepository.baseCommit,
        head: "b".repeat(64),
        headDescendsFromExpectedBase: true,
      },
    })).rejects.toThrow(/snapshot.*custody/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("holds identical lost-response replay without extra audit rows or provider permit", async () => {
    const f = await fixture("replay");
    const first = await atomicReserveCccCampaignProviderDispatch(input(f, "replay"));
    expect(first).toMatchObject({ kind: "dispatch-permit" });
    const replay = await atomicReserveCccCampaignProviderDispatch(input(f, "replay"));
    expect(replay).toMatchObject({ kind: "hold", reason: "dispatched-unknown" });
    expect(await counts()).toEqual({ attempts: 2, requestCount: 1 });
  });

  it("refuses a task without imported campaign custody instead of treating it as ordinary", async () => {
    await expect(atomicReserveCccCampaignProviderDispatch({
      layer: h.layer(),
      rootDir: h.rootDir(),
      authorityStore: h.store(),
      gitObservation: { targetRoot: h.rootDir(), expectedBaseObject: "a".repeat(40), head: "a".repeat(40), headDescendsFromExpectedBase: true },
      taskId: "TASK-not-imported",
      approvalRequestId: "approval",
      claimToken: "claim",
      turnKey: "turn-nonimported",
      dispatchKey: "dispatch-nonimported",
    })).rejects.toThrow(/no persisted CCC campaign context/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });

  it("refuses missing, ambiguous, and wrong-kind live-execution declarations before campaign writes", async () => {
    const missing = await fixture("missing-action", { protectedActions: [], taskProtectedActionIds: [], issueApproval: false });
    await expect(atomicReserveCccCampaignProviderDispatch(input(missing, "missing-action"))).rejects.toThrow(/exactly one declared live-execution/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });

    const initial = createCccPrdImportTestBundle(h.rootDir(), "ambiguous-template");
    const spans = [initial.tasks[0]!.spans[0]!];
    const ambiguous = await fixture("ambiguous-action", {
      taskProtectedActionIds: ["ACTION-LIVE-EXECUTION", "ACTION-LIVE-EXECUTION-2"],
      protectedActions: [
        { id: "ACTION-LIVE-EXECUTION", kind: "live_execution", target: "ccc-lab-super:pre-live-provider-gate", requiresOperatorDecision: true, operatorDecision: "approve_live_execution", spans },
        { id: "ACTION-LIVE-EXECUTION-2", kind: "live_execution", target: "ccc-lab-super:second-provider-gate", requiresOperatorDecision: true, operatorDecision: "approve_live_execution", spans },
      ],
    });
    await expect(atomicReserveCccCampaignProviderDispatch(input(ambiguous, "ambiguous-action"))).rejects.toThrow(/exactly one declared live-execution/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });

    const wrongKind = await fixture("wrong-kind-action", {
      issueApproval: false,
      protectedActions: [{ id: "ACTION-LIVE-EXECUTION", kind: "merge", target: "ccc-lab-super:pre-live-provider-gate", requiresOperatorDecision: true, operatorDecision: "approve_merge", spans }],
    });
    await expect(atomicReserveCccCampaignProviderDispatch(input(wrongKind, "wrong-kind-action"))).rejects.toThrow(/exactly one declared live-execution/i);
    expect(await counts()).toEqual({ attempts: 0, requestCount: 0 });
  });
});
