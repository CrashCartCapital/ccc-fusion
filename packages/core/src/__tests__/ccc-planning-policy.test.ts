import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import {
  cccPlanningRefusalFromDatabaseError,
  CccPlanningRefusal,
  CccPlanningTaskCustodyError,
  CCC_PLANNING_REFUSAL_CODES,
} from "../ccc-planning/errors.js";
import { isCccPlanningCustodyTask, isCccPlanningRunId } from "../ccc-planning/marker.js";
import {
  cccPlanningAttemptKey,
  cccPlanningBaselineBranchRef,
  cccPlanningBindingHash,
  cccPlanningDecisionId,
  cccPlanningEventId,
  cccPlanningGrantDigest,
  cccPlanningImportKey,
  cccPlanningLinkedWriterTurnKey,
  cccPlanningPolicyDigest,
  cccPlanningPolicyDigestMaterial,
  cccPlanningRole,
  cccPlanningRunId,
  cccPlanningSessionToolNames,
  cccPlanningSourcePolicySha256,
  cccPlanningTurnKey,
  CCC_PLANNING_COMPLETE_PHASE_TOOL,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE,
  CCC_PLANNING_MAX_REPAIR_CHUNKS,
  CCC_PLANNING_MODEL_FAMILIES,
  CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_PROBE_TOOL,
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  CCC_PLANNING_SOURCE_POLICY_I2,
  CCC_PLANNING_STAGNATION_EPOCHS,
  CCC_PLANNING_TOOLSETS,
  classifyCccModelIdentity,
} from "../ccc-planning/policy.js";
import {
  cccPlanningResumeTarget,
  cccPlanningRestingStates,
  cccPlanningTransitionAllowed,
  CCC_PLANNING_OPERATOR_WAIT_STATES,
  CCC_PLANNING_RUN_STATES,
  CCC_PLANNING_TERMINAL_STATES,
  type CccPlanningGrantV1,
  type CccPlanningRouteBinding,
  type CccPlanningRunState,
} from "../ccc-planning/types.js";

/*
FNXC:CccPlanningPolicy 2026-10-14-08:40:
Card K1 proof for the pure planning policy: the FULL-v2 role table and its cross-family review rule, the exact-identity classifier (including the live lookalikes `glm/glm-5.3-flashx` and `glm/glm-5.2`), the derived identifiers, the state machine mirror of migration 0042 plus adjudication item 38, the task marker and the database refusal mapping. Every refusal below sits next to a control that differs in the one offending field and is admitted.
*/

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const GRANT: CccPlanningGrantV1 = {
  schema: "ccc-planning.grant.v1",
  mode: "build",
  budgetProfile: "standard",
  budgetPolicyVersion: "ccc-planning.budget-policy.v1",
  allocations: { planning: 1536, implementation: 3072, reviewProof: 1536 },
  research: { fetches: 24, bytes: 16_777_216 },
  deadlineAt: "2026-10-16T12:00:00.000Z",
  sourcePolicyId: "ccc-planning.source-policy.i2.v1",
  amendmentSeq: 0,
};

describe("FULL-v2 role policy", () => {
  it("declares 22 roles, of which the 14 fixed planning roles are the planning nodes at L = 0", () => {
    const roles = CCC_PLANNING_ROLE_POLICY_FULL_V2.roles;
    expect(CCC_PLANNING_ROLE_POLICY_FULL_V2.policyId).toBe("ccc-planning.role-policy.full-v2");
    expect(roles).toHaveLength(22);
    expect(new Set(roles.map((role) => role.roleId)).size).toBe(22);
    const fixed = roles.filter((role) => role.counting === "fixed");
    expect(fixed).toHaveLength(14);
    expect(fixed.every((role) => role.phase === "planning")).toBe(true);
    expect(roles.filter((role) => role.counting === "probe").map((role) => role.roleId))
      .toEqual(["preflight-writer", "preflight-critic", "preflight-researcher"]);
    expect(cccPlanningRole("implementation-writer")).toMatchObject({
      modelId: "glm/glm-5.3-flash", roleClass: "writer", stageId: "campaign", phase: "implementation",
      reviewedBy: "task-reviewer", counting: "per-task",
    });
    expect(cccPlanningRole("final-judge")).toMatchObject({ stageId: "g8", phase: "review_proof", counting: "once" });
  });

  it("gives every non-probe reviewer the other model family", () => {
    const roles = CCC_PLANNING_ROLE_POLICY_FULL_V2.roles;
    const reviewed = roles.filter((role) => role.counting !== "probe" && role.reviewedBy !== null);
    // Non-vacuous: nine roles are reviewed by a separate role, which is itself the review (section 2.7:
    // eight critics plus the researcher-class source verifier).
    expect(reviewed.map((role) => role.roleId).sort()).toEqual([
      "designer-a", "designer-b", "execution-planner", "extraction-leaf", "implementation-writer",
      "intent-assessor", "researcher", "spec-author", "verifier-author",
    ]);
    for (const role of reviewed) {
      const reviewer = cccPlanningRole(role.reviewedBy!);
      expect(reviewer.reviewedBy, `${role.roleId} reviewer ${reviewer.roleId}`).toBeNull();
      expect(reviewer.counting, `${role.roleId} reviewer ${reviewer.roleId}`).not.toBe("probe");
      expect(reviewer.family, `${role.roleId} reviewed by ${reviewer.roleId}`).not.toBe(role.family);
    }
    expect(cccPlanningRole("source-verifier")).toMatchObject({ roleClass: "researcher", family: "glm" });
    for (const role of roles.filter((entry) => entry.counting === "probe")) {
      expect(role.reviewedBy).toBeNull();
    }
  });

  it("derives every role's family from its exact model", () => {
    for (const role of CCC_PLANNING_ROLE_POLICY_FULL_V2.roles) {
      expect(role.family, role.roleId).toBe(CCC_PLANNING_MODEL_FAMILIES[role.modelId]);
      expect(classifyCccModelIdentity(role.modelId)).toEqual({ admitted: true, modelId: role.modelId, family: role.family });
    }
  });
});

describe("closed toolsets", () => {
  it("gives the planning-linked writer fn_complete_phase and keeps it out of the planning writer (adjudication item 37)", () => {
    expect(CCC_PLANNING_COMPLETE_PHASE_TOOL).toBe("fn_complete_phase");
    expect(CCC_PLANNING_LINKED_WRITER_TOOLSET).toEqual(
      ["bash", "edit", "find", "fn_complete_phase", "grep", "ls", "read", "write"],
    );
    expect(CCC_PLANNING_LINKED_WRITER_TOOLSET).toEqual([...CCC_PLANNING_TOOLSETS.writer, CCC_PLANNING_COMPLETE_PHASE_TOOL].sort());
    expect(CCC_PLANNING_TOOLSETS.writer).not.toContain("fn_complete_phase");
    expect(cccPlanningSessionToolNames({ roleClass: "writer", scopeKind: "planning-linked-writer" }))
      .toEqual(CCC_PLANNING_LINKED_WRITER_TOOLSET);
    // Control: the same writer class in planning scope has no completion tool.
    expect(cccPlanningSessionToolNames({ roleClass: "writer", scopeKind: "planning" })).toEqual(CCC_PLANNING_TOOLSETS.writer);
  });

  it("adds the probe tool only in probe mode and refuses a linked scope for a non-writer class", () => {
    expect(cccPlanningSessionToolNames({ roleClass: "critic", scopeKind: "planning", probe: true }))
      .toEqual(["ccc_probe_echo", "ccc_submit_verdict", "find", "grep", "ls", "read"]);
    expect(cccPlanningSessionToolNames({ roleClass: "critic", scopeKind: "planning" })).not.toContain(CCC_PLANNING_PROBE_TOOL);
    expect(() => cccPlanningSessionToolNames({ roleClass: "critic", scopeKind: "planning-linked-writer" })).toThrow(/writer/);
    expect(() => cccPlanningSessionToolNames({ roleClass: "writer", scopeKind: "planning-linked-writer", probe: true })).toThrow(/probe/);
  });

  it("keeps every toolset sorted and unique", () => {
    for (const names of [...Object.values(CCC_PLANNING_TOOLSETS), CCC_PLANNING_LINKED_WRITER_TOOLSET]) {
      expect([...names].sort()).toEqual(names);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("reflects the linked writer toolset in the policy digest", () => {
    const material = cccPlanningPolicyDigestMaterial();
    expect(material.linkedWriterToolset).toEqual(CCC_PLANNING_LINKED_WRITER_TOOLSET);
    expect(cccPlanningPolicyDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(cccPlanningPolicyDigest()).toBe(sha256(canonicalCccPrdJson(material)));
    const withoutCompletion = {
      ...material,
      linkedWriterToolset: CCC_PLANNING_LINKED_WRITER_TOOLSET.filter((name) => name !== "fn_complete_phase"),
    };
    expect(sha256(canonicalCccPrdJson(withoutCompletion))).not.toBe(cccPlanningPolicyDigest());
    const { linkedWriterToolset: _dropped, ...withoutLinked } = material;
    void _dropped;
    expect(sha256(canonicalCccPrdJson(withoutLinked))).not.toBe(cccPlanningPolicyDigest());
    for (const key of ["roles", "toolsets", "probeTool", "preflightLineages", "deniedNames", "budgetPolicy", "sourcePolicy", "counters"]) {
      expect(material, key).toHaveProperty(key);
    }
  });
});

describe("exact model identity classification", () => {
  it("admits exactly the three pins, case-sensitively", () => {
    expect(classifyCccModelIdentity("glm/glm-5.3")).toEqual({ admitted: true, modelId: "glm/glm-5.3", family: "glm" });
    expect(classifyCccModelIdentity("glm/glm-5.3-flash")).toEqual({ admitted: true, modelId: "glm/glm-5.3-flash", family: "glm" });
    expect(classifyCccModelIdentity("minimax/MiniMax-M3")).toEqual({ admitted: true, modelId: "minimax/MiniMax-M3", family: "minimax" });
    expect(classifyCccModelIdentity("glm/GLM-5.3")).toEqual({ admitted: false, reason: "not-in-pin-registry" });
    expect(classifyCccModelIdentity("minimax/minimax-m3")).toEqual({ admitted: false, reason: "not-in-pin-registry" });
  });

  it("refuses glm-5.2 in every form as excluded-model before the floating-alias rule", () => {
    expect(classifyCccModelIdentity("glm/glm-5.2-latest")).toEqual({ admitted: false, reason: "excluded-model" });
    expect(classifyCccModelIdentity("glm/glm-5.2")).toEqual({ admitted: false, reason: "excluded-model" });
    expect(classifyCccModelIdentity("glm-5.2")).toEqual({ admitted: false, reason: "excluded-model" });
    expect(classifyCccModelIdentity("openrouter/glm-5.2")).toEqual({ admitted: false, reason: "excluded-model" });
    expect(classifyCccModelIdentity("GLM/GLM-5.2-Turbo")).toEqual({ admitted: false, reason: "excluded-model" });
    // Control: the same suffix on an admitted family is only a floating alias.
    expect(classifyCccModelIdentity("glm/glm-5.3-latest")).toEqual({ admitted: false, reason: "floating-alias" });
  });

  it("refuses the live lookalike glm/glm-5.3-flashx while admitting glm/glm-5.3-flash", () => {
    expect(classifyCccModelIdentity("glm/glm-5.3-flashx")).toEqual({ admitted: false, reason: "not-in-pin-registry" });
    expect(classifyCccModelIdentity("glm/glm-5.3-flash")).toMatchObject({ admitted: true });
  });

  it("classifies aliases, combos and unqualified ids in the frozen order", () => {
    expect(classifyCccModelIdentity("minimax/MiniMax-M3:latest")).toEqual({ admitted: false, reason: "floating-alias" });
    expect(classifyCccModelIdentity("glm/glm-5.3@LATEST")).toEqual({ admitted: false, reason: "floating-alias" });
    expect(classifyCccModelIdentity("combo/planning")).toEqual({ admitted: false, reason: "combo-route" });
    expect(classifyCccModelIdentity("COMBO/planning-latest")).toEqual({ admitted: false, reason: "floating-alias" });
    expect(classifyCccModelIdentity("glm-5.3")).toEqual({ admitted: false, reason: "unqualified-id" });
    expect(classifyCccModelIdentity("anthropic/claude-x")).toEqual({ admitted: false, reason: "not-in-pin-registry" });
  });
});

describe("derived identifiers", () => {
  const runInput = { projectId: "proj-a", requestDigest: "a".repeat(64), receiptSha256: "b".repeat(64) };

  it("derives the run id from a domain tag, a NUL and canonical JSON", () => {
    const runId = cccPlanningRunId(runInput);
    expect(runId).toBe(`ccc-plan:${sha256(`ccc-plan-run/v1\0${canonicalCccPrdJson(runInput)}`).slice(0, 24)}`);
    expect(isCccPlanningRunId(runId)).toBe(true);
    expect(cccPlanningRunId({ ...runInput, projectId: "proj-b" })).not.toBe(runId);
  });

  it("derives turn, attempt, linked writer and event keys with their own domain tags", () => {
    const runId = cccPlanningRunId(runInput);
    const turnInput = { projectId: "proj-a", runId, revision: 1, stageId: "design" as const, roleId: "designer-b" as const,
      lineageId: "design:designer-b", nodeAttemptOrdinal: 1 as const };
    const turnKey = cccPlanningTurnKey(turnInput);
    expect(turnKey).toBe(`ccc-plan-turn-${sha256(`ccc-plan-turn/v1\0${canonicalCccPrdJson(turnInput)}`)}`);
    expect(cccPlanningTurnKey({ ...turnInput, nodeAttemptOrdinal: 2 })).not.toBe(turnKey);

    const attemptInput = { projectId: "proj-a", runId, turnKey, dispatchKey: "pi-stream:1" };
    expect(cccPlanningAttemptKey(attemptInput))
      .toBe(`ccc-plan-attempt-${sha256(`ccc-plan-attempt/v1\0${canonicalCccPrdJson(attemptInput)}`)}`);

    const writerInput = { baseTurnKey: "campaign-turn-1", dispatchAttemptOrdinal: 1 as const };
    const writerKey = cccPlanningLinkedWriterTurnKey(writerInput);
    expect(writerKey).toBe(`ccc-plan-writer-${sha256(`ccc-plan-writer-turn/v1\0${canonicalCccPrdJson(writerInput)}`)}`);
    expect(cccPlanningLinkedWriterTurnKey({ ...writerInput, dispatchAttemptOrdinal: 2 })).not.toBe(writerKey);

    const eventId = cccPlanningEventId({ projectId: "proj-a", runId, mutationType: "ccc-planning:state", subject: "admitted->running@t" });
    expect(eventId).toMatch(/^ccc-plan-event-[0-9a-f]{64}$/);
    expect(cccPlanningEventId({ projectId: "proj-a", runId, mutationType: "ccc-planning:control", subject: "admitted->running@t" }))
      .not.toBe(eventId);
  });

  /*
  FNXC:CccPlanningPolicy 2026-10-14-09:21:
  Errata E1-11: a derived key hashes exactly its contract-named fields, so a caller that spreads a wider object (a binding, a row, a call record) into the input replays the same key instead of silently minting a new identity.
  */
  it("hashes exactly the contract-named fields, so extra caller fields leave every derived key unchanged", () => {
    const runId = cccPlanningRunId(runInput);
    const turnInput = { projectId: "proj-a", runId, revision: 1, stageId: "spec" as const, roleId: "spec-author" as const,
      lineageId: "spec:spec-author", nodeAttemptOrdinal: 1 as const };
    const turnKey = cccPlanningTurnKey(turnInput);
    const attemptInput = { projectId: "proj-a", runId, turnKey, dispatchKey: "pi-stream:1" };
    const writerInput = { baseTurnKey: "campaign-turn-1", dispatchAttemptOrdinal: 2 as const };
    const eventInput = { projectId: "proj-a", runId, mutationType: "ccc-planning:state" as const, subject: "admitted->running@t" };
    const extra = { fence: { kind: "planning", attempt: 4 }, note: "metadata", bindingHash: "f".repeat(64) };

    const widenedRun = { ...runInput, ...extra };
    const widenedTurn = { ...turnInput, ...extra };
    const widenedAttempt = { ...attemptInput, ...extra };
    const widenedWriter = { ...writerInput, ...extra };
    const widenedEvent = { ...eventInput, ...extra };
    expect([
      cccPlanningRunId(widenedRun), cccPlanningTurnKey(widenedTurn), cccPlanningAttemptKey(widenedAttempt),
      cccPlanningLinkedWriterTurnKey(widenedWriter), cccPlanningEventId(widenedEvent),
    ]).toEqual([
      runId, turnKey, cccPlanningAttemptKey(attemptInput), cccPlanningLinkedWriterTurnKey(writerInput), cccPlanningEventId(eventInput),
    ]);
    // Control: changing a named field still changes each key.
    expect(cccPlanningRunId({ ...widenedRun, receiptSha256: "c".repeat(64) })).not.toBe(runId);
    expect(cccPlanningTurnKey({ ...widenedTurn, lineageId: "spec:other" })).not.toBe(turnKey);
    expect(cccPlanningAttemptKey({ ...widenedAttempt, dispatchKey: "pi-stream:2" })).not.toBe(cccPlanningAttemptKey(attemptInput));
    expect(cccPlanningLinkedWriterTurnKey({ ...widenedWriter, baseTurnKey: "campaign-turn-2" }))
      .not.toBe(cccPlanningLinkedWriterTurnKey(writerInput));
    expect(cccPlanningEventId({ ...widenedEvent, subject: "running->paused@t" })).not.toBe(cccPlanningEventId(eventInput));
  });

  it("formats the decision id, import key and baseline branch ref", () => {
    const runId = cccPlanningRunId(runInput);
    expect(cccPlanningDecisionId({ revision: 1, questionDigest: "c".repeat(64) })).toBe(`ccc-plan-decision-r001-${"c".repeat(16)}`);
    const importKey = cccPlanningImportKey(runId, 1);
    expect(importKey).toBe(`${runId}:r1`);
    expect(importKey).toMatch(/^ccc-plan:[0-9a-f]{24}:r[1-9][0-9]{0,2}$/);
    expect(cccPlanningBaselineBranchRef(runId, 12))
      .toBe(`refs/heads/fusion/r2c-${runId.slice("ccc-plan:".length)}-r012-baseline`);
    expect(() => cccPlanningImportKey("ccc-plan:not-hex", 1)).toThrow();
    expect(() => cccPlanningImportKey(runId, 0)).toThrow();
    expect(() => cccPlanningImportKey(runId, 1000)).toThrow();
    expect(() => cccPlanningDecisionId({ revision: 1, questionDigest: "short" })).toThrow();
  });

  it("hashes the grant canonically and the binding without its own hash", () => {
    expect(cccPlanningGrantDigest(GRANT)).toBe(sha256(canonicalCccPrdJson(GRANT)));
    expect(cccPlanningGrantDigest({ ...GRANT, amendmentSeq: 1 })).not.toBe(cccPlanningGrantDigest(GRANT));
    const binding: Omit<CccPlanningRouteBinding, "bindingHash"> = {
      kind: "ccc-planning-route.v1", projectId: "proj-a", runId: cccPlanningRunId(runInput), runRevision: 1,
      taskId: "FN-1", stageId: "spec", roleId: "spec-author", roleClass: "author", lineageId: "spec:spec-author",
      nodeAttemptOrdinal: 1, phase: "planning", providerId: "omniroute-glm53", modelId: "glm/glm-5.3", transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1", toolsetDigest: "d".repeat(64), promptDigest: "e".repeat(64),
      policyDigest: "f".repeat(64), grantDigest: cccPlanningGrantDigest(GRANT),
    };
    const hash = cccPlanningBindingHash(binding);
    expect(hash).toBe(sha256(canonicalCccPrdJson(binding)));
    expect(cccPlanningBindingHash({ ...binding, bindingHash: hash } as CccPlanningRouteBinding)).toBe(hash);
    expect(cccPlanningBindingHash({ ...binding, modelId: "minimax/MiniMax-M3" })).not.toBe(hash);
  });
});

describe("counters and the I2 source policy", () => {
  it("pins the frozen counter values", () => {
    expect(CCC_PLANNING_MAX_CALLS_PER_ATTEMPT).toBe(11);
    expect(CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE).toBe(3);
    expect(CCC_PLANNING_PREFLIGHT_MAX_CALLS_PER_ATTEMPT).toBe(3);
    expect(CCC_PLANNING_MAX_REPAIR_CHUNKS).toBe(4);
    expect(CCC_PLANNING_STAGNATION_EPOCHS).toBe(2);
  });

  it("digests the source policy canonically", () => {
    expect(cccPlanningSourcePolicySha256()).toBe(sha256(canonicalCccPrdJson(CCC_PLANNING_SOURCE_POLICY_I2)));
    expect(cccPlanningSourcePolicySha256()).toMatch(/^[0-9a-f]{64}$/);
  });
});

/*
The literal pair list of `project.ccc_planning_run_transition_allowed` exactly as frozen in CONTRACT-v2 section 2.2,
plus the one pair leader adjudication item 38 adds. Kept in SQL form so the expectation is an independent copy of
the migration text rather than a second copy of the TypeScript table.
*/
const FROZEN_SQL_PAIRS = `
    ('admitted', 'running'), ('admitted', 'cancelling'), ('admitted', 'failed'), ('admitted', 'blocked_prerequisite'),
    ('running', 'awaiting_intent'), ('running', 'awaiting_budget'), ('running', 'blocked_prerequisite'),
    ('running', 'blocked_provider'), ('running', 'budget_exhausted'), ('running', 'unknown_effect'),
    ('running', 'paused'), ('running', 'cancelling'), ('running', 'spec_ready'), ('running', 'failed'),
    ('awaiting_intent', 'running'), ('awaiting_intent', 'cancelling'),
    ('awaiting_budget', 'running'), ('awaiting_budget', 'building'), ('awaiting_budget', 'cancelling'),
    ('blocked_prerequisite', 'running'), ('blocked_prerequisite', 'building'), ('blocked_prerequisite', 'cancelling'),
    ('blocked_provider', 'running'), ('blocked_provider', 'building'), ('blocked_provider', 'cancelling'),
    ('budget_exhausted', 'awaiting_budget'), ('budget_exhausted', 'cancelling'), ('budget_exhausted', 'failed'),
    ('unknown_effect', 'running'), ('unknown_effect', 'building'), ('unknown_effect', 'cancelling'),
    ('paused', 'running'), ('paused', 'building'), ('paused', 'cancelling'),
    ('cancelling', 'cancelled'),
    ('spec_ready', 'importing'), ('spec_ready', 'cancelling'), ('spec_ready', 'paused'),
    ('spec_ready', 'blocked_prerequisite'), ('spec_ready', 'budget_exhausted'), ('spec_ready', 'failed'),
    ('importing', 'awaiting_execution_authority'), ('importing', 'building'),
    ('importing', 'blocked_prerequisite'), ('importing', 'cancelling'), ('importing', 'failed'),
    ('awaiting_execution_authority', 'building'), ('awaiting_execution_authority', 'cancelling'),
    ('awaiting_execution_authority', 'failed'),
    ('building', 'verification_failed'), ('building', 'accepted'), ('building', 'paused'),
    ('building', 'cancelling'), ('building', 'blocked_prerequisite'), ('building', 'blocked_provider'),
    ('building', 'budget_exhausted'), ('building', 'unknown_effect'), ('building', 'failed'),
    ('verification_failed', 'cancelling'), ('verification_failed', 'failed'),
    ('accepted', 'delivering'), ('accepted', 'cancelling'),
    ('delivering', 'delivered'), ('delivering', 'failed')`;
const ADJUDICATION_38_PAIR = "('importing', 'budget_exhausted')";

function parseSqlPairs(text: string): Set<string> {
  const pairs = new Set<string>();
  for (const match of text.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)) pairs.add(`${match[1]}->${match[2]}`);
  return pairs;
}

describe("run states and transitions", () => {
  it("allows exactly the 64 frozen pairs, the adjudication-38 pair and identity, across all 400 pairs", () => {
    const frozen = parseSqlPairs(FROZEN_SQL_PAIRS);
    expect(frozen.size).toBe(64);
    const expected = new Set([...frozen, ...parseSqlPairs(ADJUDICATION_38_PAIR)]);
    expect(expected.size).toBe(65);
    expect(CCC_PLANNING_RUN_STATES).toHaveLength(20);
    let allowedNonIdentity = 0;
    for (const from of CCC_PLANNING_RUN_STATES) {
      for (const to of CCC_PLANNING_RUN_STATES) {
        const allowed = cccPlanningTransitionAllowed(from, to);
        expect(allowed, `${from}->${to}`).toBe(from === to || expected.has(`${from}->${to}`));
        if (allowed && from !== to) allowedNonIdentity += 1;
      }
    }
    expect(allowedNonIdentity).toBe(65);
  });

  it("refuses running -> importing and allows importing -> budget_exhausted (adjudication item 38)", () => {
    expect(cccPlanningTransitionAllowed("running", "importing")).toBe(false);
    expect(cccPlanningTransitionAllowed("spec_ready", "importing")).toBe(true);
    expect(cccPlanningTransitionAllowed("importing", "budget_exhausted")).toBe(true);
    expect(cccPlanningTransitionAllowed("cancelled", "running")).toBe(false);
  });

  it("rests Build on accepted or verification_failed, and only Spec on spec_ready", () => {
    expect(cccPlanningRestingStates("build")).toEqual(["accepted", "verification_failed"]);
    expect(cccPlanningRestingStates("build")).not.toContain("spec_ready");
    expect(cccPlanningRestingStates("spec")).toEqual(["spec_ready"]);
  });

  it("resumes to running before the import link and to building after it", () => {
    expect(cccPlanningResumeTarget({ importId: null })).toBe("running");
    expect(cccPlanningResumeTarget({ importId: "imp-1" })).toBe("building");
  });

  it("keeps terminal and operator-wait states inside the state vocabulary and disjoint", () => {
    const states = new Set<CccPlanningRunState>(CCC_PLANNING_RUN_STATES);
    for (const state of [...CCC_PLANNING_TERMINAL_STATES, ...CCC_PLANNING_OPERATOR_WAIT_STATES]) expect(states.has(state)).toBe(true);
    for (const terminal of CCC_PLANNING_TERMINAL_STATES) {
      expect(CCC_PLANNING_OPERATOR_WAIT_STATES as readonly string[]).not.toContain(terminal);
      for (const to of CCC_PLANNING_RUN_STATES) {
        if (to !== terminal) expect(cccPlanningTransitionAllowed(terminal, to), `${terminal}->${to}`).toBe(false);
      }
    }
  });
});

describe("planning task marker", () => {
  const runId = `ccc-plan:${"0123456789abcdef01234567"}`;

  it("recognises a held planning task by lineage, paused and not user-paused", () => {
    expect(isCccPlanningCustodyTask({ lineageId: runId, paused: true, userPaused: false })).toBe(true);
    expect(isCccPlanningCustodyTask({ lineageId: runId, paused: true })).toBe(true);
  });

  it("refuses each marker field on its own", () => {
    expect(isCccPlanningCustodyTask({ lineageId: runId, paused: false, userPaused: false })).toBe(false);
    expect(isCccPlanningCustodyTask({ lineageId: runId, paused: true, userPaused: true })).toBe(false);
    expect(isCccPlanningCustodyTask({ lineageId: `${runId}0`, paused: true, userPaused: false })).toBe(false);
    expect(isCccPlanningCustodyTask({ lineageId: `ccc-prd:${"0123456789abcdef01234567"}:T1`, paused: true, userPaused: false })).toBe(false);
    expect(isCccPlanningCustodyTask({ paused: true, userPaused: false })).toBe(false);
  });
});

describe("database refusal mapping", () => {
  it("maps every code the 0042 and 0043 triggers raise", () => {
    for (const code of [
      "CCC_PLANNING_ANCHOR_IMMUTABLE", "CCC_PLANNING_ANCHOR_INSERT_INVALID", "CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH",
      "CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID", "CCC_PLANNING_ARTIFACT_FENCE_REFUSED", "CCC_PLANNING_ARTIFACT_IMMUTABLE",
      "CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED", "CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED", "CCC_PLANNING_ARTIFACT_RUN_MISMATCH",
      "CCC_PLANNING_ARTIFACT_TOO_LARGE", "CCC_PLANNING_COUNTER_DECREASE", "CCC_PLANNING_DESIGN_SEAL_BROKEN",
      "CCC_PLANNING_GRANT_CHANGE_REFUSED", "CCC_PLANNING_IMPORT_LINK_WRITE_ONCE", "CCC_PLANNING_REPAIR_EPOCH_CLOSED",
      "CCC_PLANNING_REVIEW_EPOCH_INVALID", "CCC_PLANNING_RUN_TERMINAL", "CCC_PLANNING_SPEND_REFUSED",
      "CCC_PLANNING_STATE_TRANSITION_REFUSED",
    ] as const) {
      expect(CCC_PLANNING_REFUSAL_CODES as readonly string[]).toContain(code);
      const refusal = cccPlanningRefusalFromDatabaseError(Object.assign(new Error(`${code}: run x detail`), { code: "P0001" }));
      expect(refusal, code).toBeInstanceOf(CccPlanningRefusal);
      expect(refusal?.code).toBe(code);
      expect(refusal?.detail).toBe("run x detail");
    }
  });

  it("follows a driver error wrapped as a cause, and returns null for anything else", () => {
    const inner = new Error("CCC_PLANNING_SPEND_REFUSED: run r control pending");
    const wrapped = Object.assign(new Error("Failed query: update ..."), { cause: inner });
    expect(cccPlanningRefusalFromDatabaseError(wrapped)?.code).toBe("CCC_PLANNING_SPEND_REFUSED");
    expect(cccPlanningRefusalFromDatabaseError(new Error("duplicate key value violates unique constraint"))).toBeNull();
    expect(cccPlanningRefusalFromDatabaseError(new Error("CCC_PLANNING_NOT_A_REAL_CODE: x"))).toBeNull();
    expect(cccPlanningRefusalFromDatabaseError(new Error("CCC_PLANNING_SPEND_REFUSED without separator"))).toBeNull();
    expect(cccPlanningRefusalFromDatabaseError("CCC_PLANNING_SPEND_REFUSED: string, not an error")).toBeNull();
    expect(cccPlanningRefusalFromDatabaseError(null)).toBeNull();
  });

  it("names the custody error after the operation it refused", () => {
    const error = new CccPlanningTaskCustodyError("FN-9", "moveTask");
    expect(error.code).toBe("CCC_PLANNING_TASK_CUSTODY");
    expect(error.message).toBe("CCC_PLANNING_TASK_CUSTODY: task FN-9 is held by a request-to-code run; moveTask refused");
    expect(error.field).toBe("moveTask");
  });
});
