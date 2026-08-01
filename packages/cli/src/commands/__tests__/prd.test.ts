import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapCccCampaignProofAdmissionHost } from "../ccc-native-proof-host.js";
import { runPrdCommand } from "../prd.js";
import {
  cleanupPacketRoots,
  createPacketRoot,
  repoRoot,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);
const bootstrapProofAdmission = () => bootstrapCccCampaignProofAdmissionHost({
  builtRootPath: join(repoRoot, "packages/cli/dist"),
});

async function createExecutionPlan(
  packet: ReturnType<typeof createPacketRoot>,
  name = "execution-plan.json",
): Promise<string> {
  const outputPath = join(packet.root, name);
  const output: string[] = [];
  const exit = await runPrdCommand([
    "policy",
    packet.root,
    packet.manifest,
    packet.sidecar,
    packet.target,
    packet.base,
    outputPath,
    "--provider",
    "deterministic-fake",
    "--model",
    "fixture-v2",
    "--transport",
    "pi",
  ], { write: (line) => output.push(line) });
  expect(exit, output.join("\n")).toBe(0);
  return outputPath;
}

describe("prd command exit contract", () => {
  it("returns usage exit 2 before any compiler or filesystem work", async () => {
    const output: string[] = [];
    expect(await runPrdCommand(["compile"], { write: (line) => output.push(line) })).toBe(2);
    expect(output).toEqual([
      [
        "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
        "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
        "       fn prd discover <active-projects-root>",
        "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir>",
        "       fn prd policy <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base> <output-path> --provider <provider> --model <model> --transport <pi|cli> [--cli-adapter <id>]",
        "       fn prd template",
        "       fn prd lint <prd-path>",
        "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
        "       fn prd preview <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> [--project <id|name>]",
        "       fn prd import <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> <idempotency-key> --confirm <preview-digest> [--project <id|name>]",
        "       fn prd <inspect|reconcile> <idempotency-key> [--project <id|name>]",
        "       fn prd status <idempotency-key> [--project <id|name>]",
        "       fn prd <pause|resume> <idempotency-key> --confirm <status-digest> [--project <id|name>]",
        "       fn prd <stop|abandon> <idempotency-key> --reason <reason> --confirm <status-digest> [--project <id|name>]",
        "       fn prd resolve-proof <idempotency-key> <attempt-key> <evidence-path> [--confirm <resolution-digest>] [--project <id|name>]",
        "       fn prd resolve-provider <idempotency-key> <attempt-key> <committed|proved-failed> <observer-id> <evidence-sha256> [--confirm <resolution-digest>] [--project <id|name>]",
        "       fn prd approve-execution <idempotency-key> <approval-request-id> --confirm <approval-digest> [--project <id|name>]",
        "       fn prd approve-merge <idempotency-key> <approval-request-id> --confirm <approval-digest> [--project <id|name>]",
      ].join("\n"),
    ]);
  });

  it("discovers project-local current PRDs and freezes the operator-selected packet through engine APIs", async () => {
    const discovery = {
      schema: "ccc-prd.discovery.v1",
      activeProjectsRoot: "/vault/active",
      projects: [{
        project: "alpha",
        projectRoot: "/vault/active/alpha",
        candidates: [{
          path: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
          projectRelativePath: "PRJ-HUM-Alpha-PRD-v2.0.0.md",
          version: "2.0.0",
          status: "approved",
          score: { semver: [2, 0, 0], status: 4, signal: 2 },
        }],
        selection: {
          kind: "selected",
          selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        },
      }],
    };
    const frozen = {
      schema: "ccc-prd.freeze-result.v1",
      rootDir: "/tmp/frozen-alpha",
      manifestPath: "/tmp/frozen-alpha/manifest.json",
      receiptPath: "/tmp/frozen-alpha/freeze-receipt.json",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      packet: {
        schema: "ccc-prd.packet.v1",
        sourceVersion: "v2.0.0",
        manifestSha256: "a".repeat(64),
        packetHash: "b".repeat(64),
        receiptSha256: "c".repeat(64),
        fileCount: 3,
        totalBytes: 1234,
        unresolvedReferenceCount: 0,
        project: "alpha",
        selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      },
      unresolvedReferences: [],
    };
    const discover = vi.fn(() => discovery);
    const freeze = vi.fn(() => frozen);
    const discoveredOutput: string[] = [];
    expect(await runPrdCommand(
      ["discover", "/vault/active"],
      { write: (line) => discoveredOutput.push(line) },
      { discoverCccPrdCandidates: discover },
    )).toBe(0);
    expect(JSON.parse(discoveredOutput[0]!)).toEqual(discovery);
    expect(discover).toHaveBeenCalledWith({ activeProjectsRoot: "/vault/active" });

    const frozenOutput: string[] = [];
    expect(await runPrdCommand(
      [
        "freeze",
        "/vault/active",
        "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
        "/tmp/frozen-alpha",
      ],
      { write: (line) => frozenOutput.push(line) },
      { freezeCccPrdPacket: freeze },
    )).toBe(0);
    expect(JSON.parse(frozenOutput[0]!)).toEqual(frozen);
    expect(freeze).toHaveBeenCalledWith({
      activeProjectsRoot: "/vault/active",
      selectedPrdPath: "/vault/active/alpha/PRJ-HUM-Alpha-PRD-v2.0.0.md",
      outputDir: "/tmp/frozen-alpha",
    });
  });

  it("generates a hash-bound execution plan without operator-authored policy JSON", async () => {
    const packet = createPacketRoot();
    const authorOutput: string[] = [];
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: (line) => authorOutput.push(line) },
      { bootstrapProofAdmission },
    )).toBe(0);

    const executionPlanPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];
    const policyExit = await runPrdCommand(
      [
        "policy",
        packet.root,
        packet.manifest,
        packet.sidecar,
        packet.target,
        packet.base,
        executionPlanPath,
        "--provider",
        "deterministic-fake",
        "--model",
        "fixture-v2",
        "--transport",
        "pi",
      ],
      { write: (line) => output.push(line) },
      { bootstrapProofAdmission },
    );
    expect(policyExit, output.join("\n")).toBe(0);

    expect(existsSync(executionPlanPath)).toBe(true);
    expect(JSON.parse(readFileSync(executionPlanPath, "utf8"))).toMatchObject({
      schema: "ccc-prd.execution-plan.v1",
      packetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sidecarHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      policy: {
        schema: "ccc-campaign.execution-policy.v2",
        routes: [{
          taskId: "TASK-CLI-001",
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/task-1"],
          allowedWriteRoots: ["src/task-1"],
          commitPolicy: "required",
        }],
      },
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "execution-plan",
      path: executionPlanPath,
    });
  });

  it("prints the optional intake template and lints implementation-changing facts without rewriting the PRD", async () => {
    const templateOutput: string[] = [];
    expect(await runPrdCommand(
      ["template"],
      { write: (line) => templateOutput.push(line) },
    )).toBe(0);
    const template = JSON.parse(templateOutput[0]!) as {
      kind: string;
      schema: string;
      markdown: string;
    };
    expect(template).toMatchObject({
      kind: "prd-intake-template",
      schema: "ccc-prd.intake-contract.v1",
    });
    expect(template.markdown).toContain("Target repository:");
    expect(template.markdown).toContain("Acceptance behavior and expected proof");

    const packet = createPacketRoot();
    const prdPath = join(packet.root, "future-prd.md");
    writeFileSync(prdPath, `# Future PRD

## Requirements

- Make the operator route work.
`);
    const before = readFileSync(prdPath, "utf8");
    const lintOutput: string[] = [];
    expect(await runPrdCommand(
      ["lint", prdPath],
      { write: (line) => lintOutput.push(line) },
    )).toBe(1);
    expect(JSON.parse(lintOutput[0]!)).toMatchObject({
      schema: "ccc-prd.intake-contract.v1",
      optionalContract: true,
      readyForIntake: false,
      blockingQuestions: [
        expect.objectContaining({ code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_BASELINE_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ALLOWED_PATHS_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_ACCEPTANCE_BEHAVIOR_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_EXPECTED_PROOF_REQUIRED" }),
        expect.objectContaining({ code: "CCC_PRD_PROTECTED_ACTIONS_REQUIRED" }),
      ],
    });
    expect(readFileSync(prdPath, "utf8")).toBe(before);
  });

  it("previews and imports one hash-bound product bundle through the production service seam", async () => {
    const packet = createPacketRoot();
    const authorOutput: string[] = [];
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: (line) => authorOutput.push(line) },
      { bootstrapProofAdmission },
    )).toBe(0);
    const policyPath = join(packet.root, "execution-plan.json");
    expect(await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      policyPath,
      "--provider",
      "deterministic-fake",
      "--model",
      "fixture-v2",
      "--transport",
      "pi",
    ], { write: () => undefined })).toBe(0);
    const layer = {};
    const store = { getAsyncLayer: vi.fn(() => layer) };
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store,
    };
    const importBundle = vi.fn(async () => ({
      importId: "import-1",
      idempotencyKey: "operator-key",
      bundleHash: "bundle-hash",
      identityHash: "identity-hash",
      targetRepository: packet.target,
      targetBase: packet.base,
      state: "active",
      runnable: true,
      stagingRelativePath: ".fusion/ccc-prd-import-staging/import-1",
      transactionWitness: {},
      directCounts: {},
      replayed: false,
    }));
    const closeProjectStore = vi.fn(async () => undefined);
    const inspectVerifierConfinementReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      detail: "test-injected ready confinement",
    }));
    const dependencies = {
      resolveProject: vi.fn(async () => context),
      closeProjectStore,
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
      inspectVerifierConfinementReadiness,
    };
    const common = [
      packet.root,
      packet.manifest,
      packet.sidecar,
      policyPath,
      packet.target,
      packet.base,
    ];
    const previewOutput: string[] = [];
    expect(await runPrdCommand(
      ["preview", ...common],
      { write: (line) => previewOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(0);
    const preview = JSON.parse(previewOutput[0]!) as {
      kind: string;
      confirmationDigest: string;
      projectId: string;
      bundleHash: string;
      requirements: unknown[];
      tasks: unknown[];
      proofs: unknown[];
    };
    expect(preview).toMatchObject({
      kind: "preview",
      projectId: "project-1",
      requirements: [expect.objectContaining({ id: "CF-CLI-001" })],
      tasks: [
        expect.objectContaining({ id: "TASK-CLI-001" }),
      ],
      proofs: [expect.objectContaining({ id: "PF-CLI-001" })],
      verifierConfinement: {
        ready: true,
        backend: "sandbox-exec",
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"],
      },
    });
    expect(preview.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);

    const importOutput: string[] = [];
    expect(await runPrdCommand(
      ["import", ...common, "operator-key", "--confirm", preview.confirmationDigest],
      { write: (line) => importOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(0);
    expect(JSON.parse(importOutput[0]!)).toMatchObject({
      kind: "imported",
      confirmationDigest: preview.confirmationDigest,
      result: { importId: "import-1", state: "active", runnable: true },
    });
    expect(importBundle).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "operator-key",
      rootDir: context.projectPath,
      layer,
      store,
      executionPolicy: expect.objectContaining({
        schema: "ccc-campaign.execution-policy.v2",
      }),
    }));
    expect(closeProjectStore).toHaveBeenCalledTimes(2);
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(2);
  });

  it("shows extracted PRD work and actionable verifier guidance when confinement is unavailable", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const policyPath = await createExecutionPlan(packet);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => ({})) },
    };
    const output: string[] = [];

    expect(await runPrdCommand(
      [
        "preview",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        readTargetHead: vi.fn(async () => packet.base),
        inspectVerifierConfinementReadiness: vi.fn(async () => ({
          ready: false,
          backend: "bubblewrap" as const,
          code: "VERIFIER_CONFINEMENT_UNAVAILABLE",
          message: "trusted bubblewrap confinement is unavailable",
          trustedPaths: ["/usr/bin/bwrap", "/bin/bwrap"] as const,
          detail: "private runner detail must not reach operator output",
        })),
      },
      { projectName: "fixture" },
    )).toBe(0);

    const preview = JSON.parse(output[0]!);
    expect(preview).toMatchObject({
      kind: "preview",
      requirements: [expect.objectContaining({ id: "CF-CLI-001" })],
      tasks: [expect.objectContaining({ id: "TASK-CLI-001" })],
      verifierConfinement: {
        ready: false,
        backend: "bubblewrap",
        code: "VERIFIER_CONFINEMENT_UNAVAILABLE",
        safeState: "The frozen PRD preview is intact; no campaign, approval, provider effect, or source change was created.",
        decisionOwner: "Fusion host or CI runner operator",
        consequence: "Campaign import and live execution remain blocked because exact requirement proof cannot run safely.",
        recoveryOptions: [
          "Provision and functionally verify the trusted verifier confinement backend on this host.",
          "Keep the packet as a review-only preview until confinement is ready.",
        ],
        nextSafeAction: "Repair the trusted verifier confinement backend, then rerun fn prd preview before import.",
      },
    });
    expect(output[0]).not.toContain("private runner detail");
  });

  it("refuses import before project or importer residue when readiness has no admitted backend", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const policyPath = await createExecutionPlan(packet);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: vi.fn(() => ({})) },
    };
    const resolveProject = vi.fn(async () => context);
    const importBundle = vi.fn();
    const inspectVerifierConfinementReadiness = vi.fn()
      .mockResolvedValueOnce({
        ready: true,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "verifier confinement readiness probe executed successfully",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      })
      .mockResolvedValueOnce({
        ready: true,
        backend: "native" as never,
        code: "VERIFIER_CONFINEMENT_INVALID_RESULT",
        message: "readiness result named an unadmitted backend",
        trustedPaths: [] as const,
        detail: "private runner detail must not reach operator output",
      });
    const dependencies = {
      resolveProject,
      closeProjectStore: vi.fn(async () => undefined),
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
      inspectVerifierConfinementReadiness,
    };
    const common = [
      packet.root,
      packet.manifest,
      packet.sidecar,
      policyPath,
      packet.target,
      packet.base,
    ];
    const previewOutput: string[] = [];
    expect(await runPrdCommand(
      ["preview", ...common],
      { write: (line) => previewOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(0);
    const preview = JSON.parse(previewOutput[0]!) as {
      confirmationDigest: string;
    };
    const importOutput: string[] = [];

    expect(await runPrdCommand(
      ["import", ...common, "operator-key", "--confirm", preview.confirmationDigest],
      { write: (line) => importOutput.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(importOutput[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
        message: "Exact requirement verification is unavailable: readiness result named an unadmitted backend",
      }],
      safeState: "This import created no campaign rows, staging files, approvals, provider effects, or source changes.",
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "The PRD packet remains reviewable, but Fusion cannot safely import or execute it on this host.",
      approvalExpiresAt: null,
      recoveryOptions: [
        "Provision and functionally verify the trusted verifier confinement backend at one trusted system path.",
        "Keep the frozen packet unchanged and rerun preview after the host is repaired.",
      ],
      nextSafeAction: "Repair verifier confinement, rerun fn prd preview, then issue a fresh import confirmation.",
    });
    expect(importOutput[0]).not.toContain("private runner detail");
    expect(resolveProject).toHaveBeenCalledTimes(1);
    expect(importBundle).not.toHaveBeenCalled();
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(2);
  });

  it("recomputes preview identity and refuses a stale confirmation before import residue", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const policyPath = await createExecutionPlan(packet);
    const importBundle = vi.fn();
    const closeProjectStore = vi.fn(async () => undefined);
    const context = {
      projectId: "project-1",
      projectPath: resolve(packet.target),
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => ({}) },
    };
    const output: string[] = [];
    expect(await runPrdCommand(
      [
        "import",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
        "operator-key",
        "--confirm",
        "f".repeat(64),
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore,
        readTargetHead: vi.fn(async () => packet.base),
        importCccPrdBundle: importBundle,
      },
      { projectName: "fixture" },
    )).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [expect.objectContaining({ code: "CCC_PRD_CONFIRMATION_MISMATCH" })],
    });
    expect(importBundle).not.toHaveBeenCalled();
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
  });

  it("refuses product preview/import when implementation facts are not source-bound before import residue", async () => {
    const packet = createPacketRoot();
    expect(await runPrdCommand(
      ["author", packet.root, packet.manifest, packet.proposal, packet.sidecar],
      { write: () => undefined },
      { bootstrapProofAdmission },
    )).toBe(0);
    const sidecar = JSON.parse(readFileSync(packet.sidecar, "utf8")) as {
      admittedWriteRoots: Array<{ path: string; purpose: string }>;
    };
    sidecar.admittedWriteRoots = [{ path: `${packet.target}/src/not-in-prd`, purpose: "tampered path" }];
    writeFileSync(packet.sidecar, JSON.stringify(sidecar));

    const policyPath = join(packet.root, "execution-policy.json");
    writeFileSync(policyPath, JSON.stringify({
      schema: "ccc-campaign.execution-policy.v2",
      routes: [
        {
          taskId: "TASK-CLI-001",
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/not-in-prd"],
          allowedWriteRoots: ["src/not-in-prd"],
          commitPolicy: "required",
        },
      ],
    }));
    const importBundle = vi.fn();
    const closeProjectStore = vi.fn(async () => undefined);
    const dependencies = {
      resolveProject: vi.fn(async () => ({
        projectId: "project-1",
        projectPath: resolve(packet.target),
        projectName: "Fixture",
        isRegistered: true,
        store: { getAsyncLayer: vi.fn(() => ({})) },
      })),
      closeProjectStore,
      readTargetHead: vi.fn(async () => packet.base),
      importCccPrdBundle: importBundle,
    };
    const output: string[] = [];
    expect(await runPrdCommand(
      [
        "import",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policyPath,
        packet.target,
        packet.base,
        "operator-key",
        "--confirm",
        "0".repeat(64),
      ],
      { write: (line) => output.push(line) },
      dependencies,
      { projectName: "fixture" },
    )).toBe(1);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_ALLOWED_WRITE_ROOT_PROVENANCE_REQUIRED" }),
      ]),
    });
    expect(importBundle).not.toHaveBeenCalled();
    expect(dependencies.resolveProject).not.toHaveBeenCalled();
    expect(closeProjectStore).not.toHaveBeenCalled();
  });

  it("shows one redacted product status with an exact merge confirmation", async () => {
    const confirmation = "c".repeat(64);
    const approval = {
      id: "approval-1",
      status: "issued",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "git_write",
        action: "ACTION-merge",
        summary: "Merge the campaign result",
        resourceType: "ccc-campaign-merge",
        resourceId: "refs/heads/main",
        context: {
          protectedActionKind: "merge",
          operatorDecision: "approve_merge",
        },
      },
      taskId: "TASK-terminal",
      runId: "RUN-product",
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-terminal",
          actionId: "ACTION-merge",
          actionTarget: "refs/heads/main",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "pi",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
        claimToken: "must-never-serialize",
      },
    };
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [{
        id: "work-item-1",
        runId: "ccc-prd:import-1",
        taskId: "TASK-entry",
        nodeId: "node-entry",
        kind: "task",
        state: "manual-required",
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        stableWorkflowRunId: "ccc-prd:import-1",
      }],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-merge",
        reason: "Executed proof is complete; exact human merge approval is next.",
      },
      controllerToken: "must-never-serialize",
    };
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => layer },
    };
    const output: string[] = [];

    expect(await runPrdCommand(
      ["status", "operator-key"],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        computeCccCampaignMergeApprovalConfirmation: vi.fn(() => confirmation),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "product-status",
      found: true,
      status: {
        nextAction: { kind: "approve-merge" },
      },
      mergeApprovalConfirmations: [{
        approvalRequestId: "approval-1",
        confirmation,
      }],
      operatorControls: expect.arrayContaining([
        expect.objectContaining({ action: "pause" }),
        expect.objectContaining({ action: "resume" }),
        expect.objectContaining({ action: "stop" }),
      ]),
    });
    expect(output[0]).not.toContain("claimToken");
    expect(output[0]).not.toContain("controllerToken");
    expect(output[0]).not.toContain("must-never-serialize");
  });

  it("pauses and resumes only the exact confirmed unleased campaign status", async () => {
    const confirmation = "6".repeat(64);
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-entry",
      nodeId: "node-entry",
      kind: "task",
      state: "runnable",
      attempt: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: { kind: "wait-for-runtime", reason: "Running." },
    };
    const afterPause = {
      ...before,
      workItems: [{
        ...workItem,
        state: "held",
        blockedReason: "ccc-operator:campaign-paused",
      }],
      nextAction: { kind: "blocked", reason: "Paused." },
    };
    const transitionWorkflowWorkItem = vi.fn();
    const pauseTask = vi.fn();
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
        pauseTask,
      },
    };
    const applyControl = vi.fn(async () => ({
      action: "pause",
      workItemId: "work-item-1",
      workItemState: "held",
      taskIds: ["FN-1"],
      unresolvedEffectsPreserved: false,
    }));
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterPause);
    const output: string[] = [];

    expect(await runPrdCommand(
      ["pause", "operator-key", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignOperatorControlConfirmation: vi.fn(
          () => confirmation,
        ),
        applyCccCampaignOperatorControl: applyControl,
        describeCccCampaignOperatorControls: vi.fn(() => []),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(applyControl).toHaveBeenCalledWith({
      action: "pause",
      status: before,
      store: context.store,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "campaign-paused",
      result: {
        workItemId: "work-item-1",
        workItemState: "held",
      },
      status: {
        workItems: [expect.objectContaining({ state: "held" })],
      },
    });
  });

  it("terminally stops a campaign only with a fresh digest and explicit reason", async () => {
    const confirmation = "7".repeat(64);
    const reason = "Operator abandons this run after preserving all receipts.";
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-1",
      nodeId: "node-entry",
      kind: "task",
      state: "manual-required",
      attempt: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [{
        definition: { id: "PROOF-1" },
        attempts: [{
          attemptKey: `ccc-proof-attempt-${"a".repeat(64)}`,
          state: "dispatched_unknown",
        }],
      }],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Proof effect is uncertain.",
      },
    };
    const afterStop = {
      ...before,
      workItems: [{
        ...workItem,
        state: "cancelled",
        lastError: `ccc-operator:campaign-stopped:${"f".repeat(64)}`,
        blockedReason: reason,
      }],
      nextAction: { kind: "abandoned", reason: "Stopped by operator." },
    };
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem: vi.fn(),
        pauseTask: vi.fn(),
      },
    };
    const applyControl = vi.fn(async () => ({
      action: "stop",
      workItemId: "work-item-1",
      workItemState: "cancelled",
      taskIds: ["FN-1"],
      unresolvedEffectsPreserved: true,
    }));
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterStop);
    const output: string[] = [];

    expect(await runPrdCommand(
      [
        "stop",
        "operator-key",
        "--reason",
        reason,
        "--confirm",
        confirmation,
      ],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignOperatorControlConfirmation: vi.fn(
          () => confirmation,
        ),
        applyCccCampaignOperatorControl: applyControl,
        describeCccCampaignOperatorControls: vi.fn(() => []),
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(applyControl).toHaveBeenCalledWith({
      action: "stop",
      reason,
      status: before,
      store: context.store,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "campaign-stopped",
      result: {
        workItemState: "cancelled",
        unresolvedEffectsPreserved: true,
      },
      status: {
        nextAction: { kind: "abandoned" },
      },
    });
  });

  it("previews and settles one uncertain proof before requeueing its exact work item", async () => {
    const packet = createPacketRoot();
    const evidencePath = join(packet.root, "proof-resolution.json");
    writeFileSync(evidencePath, JSON.stringify({
      schema: "ccc-campaign.proof-resolution.v1",
      observerId: "operator-local-1",
      summary: "Observed the verifier process exit zero and captured its output.",
      result: {
        success: true,
        exitCode: 0,
        durationMs: 42,
        stdout: "POSITIVE_ORACLE_PASS\n",
        stderr: "",
        timedOut: false,
        killed: false,
        warnings: [],
        negativeControlLabel: "planted-defect-failed",
      },
    }));
    const attemptKey = `ccc-proof-attempt-${"a".repeat(64)}`;
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-1",
      nodeId: "node-proof",
      kind: "task",
      state: "manual-required",
      attempt: 4,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const proofAttempt = {
      attemptKey,
      importId: "import-1",
      campaignId: "campaign-1",
      taskId: "FN-1",
      semanticTaskId: "TASK-1",
      proofId: "PROOF-1",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      manifestHash: "d".repeat(64),
      campaignBindingHash: "e".repeat(64),
      targetRepository: "/tmp/product-target",
      targetBase: "f".repeat(40),
      sourceCommit: "1".repeat(40),
      sourceTree: "2".repeat(40),
      definitionSha256: "3".repeat(64),
      commandSha256: "4".repeat(64),
      workItemId: workItem.id,
      runId: workItem.runId,
      workItemAttempt: workItem.attempt,
      state: "dispatched_unknown",
      result: null,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:01.000Z",
      dispatchedAt: "2026-07-31T00:00:01.000Z",
      settledAt: null,
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        packetHash: "a".repeat(64),
        sidecarHash: "b".repeat(64),
        bundleHash: "c".repeat(64),
        targetRepository: "/tmp/product-target",
        targetBase: "f".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [{
        semanticTaskId: "TASK-1",
        nativeTaskId: "FN-1",
        present: true,
      }],
      workItems: [workItem],
      proofs: [{
        definition: { id: "PROOF-1" },
        definitionSha256: "3".repeat(64),
        attempts: [proofAttempt],
      }],
      orphanProofAttempts: [],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Proof effect is uncertain.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      proofs: [{
        ...before.proofs[0],
        attempts: [{
          ...proofAttempt,
          state: "committed",
          result: { success: true, exitCode: 0 },
        }],
      }],
      nextAction: { kind: "wait-for-runtime", reason: "Ready." },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const persistedAttempt = {
      ...proofAttempt,
      controllerToken:
        "ccc-proof-controller-00000000-0000-4000-8000-000000000001",
    };
    const inspectAttempt = vi.fn(async () => persistedAttempt);
    const settleAttempt = vi.fn(async () => ({
      ...persistedAttempt,
      state: "committed",
      result: { success: true },
    }));
    const previewOutput: string[] = [];

    const previewExit = await runPrdCommand(
      ["resolve-proof", "operator-key", attemptKey, evidencePath],
      { write: (line) => previewOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        inspectCccCampaignProofAttempt: inspectAttempt,
        settleCccCampaignProofAttempt: settleAttempt,
      },
      { projectName: "fixture" },
    );
    expect(previewExit, previewOutput.join("\n")).toBe(0);
    const preview = JSON.parse(previewOutput[0]!);
    expect(preview).toMatchObject({
      kind: "proof-resolution-preview",
      attemptKey,
      decision: "settle",
      consequence: expect.stringContaining("requeue"),
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inspectAttempt).not.toHaveBeenCalled();
    expect(settleAttempt).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();

    const settleOutput: string[] = [];
    expect(await runPrdCommand(
      [
        "resolve-proof",
        "operator-key",
        attemptKey,
        evidencePath,
        "--confirm",
        preview.confirmation,
      ],
      { write: (line) => settleOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        inspectCccCampaignProofAttempt: inspectAttempt,
        settleCccCampaignProofAttempt: settleAttempt,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(inspectAttempt).toHaveBeenCalledWith({
      attemptKey,
      layer,
    });
    expect(settleAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptKey,
      controllerToken: persistedAttempt.controllerToken,
      layer,
      result: expect.objectContaining({
        success: true,
        stdout: "POSITIVE_ORACLE_PASS\n",
        warnings: [
          "operator-reconciliation:operator-local-1: Observed the verifier process exit zero and captured its output.",
        ],
      }),
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(settleOutput[0]!)).toMatchObject({
      kind: "proof-resolved",
      attempt: {
        attemptKey,
        state: "committed",
      },
      status: {
        workItems: [expect.objectContaining({ state: "runnable" })],
      },
    });
    expect(settleOutput[0]).not.toContain("controllerToken");
    expect(settleOutput[0]).not.toContain(persistedAttempt.controllerToken);
  });

  it("previews and settles one non-CLI provider effect while routing CLI recovery to its native fence", async () => {
    const attemptKey = `ccc-provider-attempt-${"a".repeat(64)}`;
    const controllerToken =
      "ccc-provider-controller-00000000-0000-4000-8000-000000000001";
    const evidenceDigest = "7".repeat(64);
    const workItemFence = {
      workItemId: "work-item-1",
      runId: "ccc-prd:import-1",
      attempt: 2,
    } as const;
    const binding = {
      projectId: "project-1",
      importId: "import-1",
      campaignId: "campaign-1",
      taskId: "FN-1",
      actionId: "ACTION-1",
      actionTarget: "provider://fixture/FN-1",
      idempotencyKey: "operator-key",
      packetHash: "a".repeat(64),
      sidecarHash: "b".repeat(64),
      bundleHash: "c".repeat(64),
      targetRepository: "/tmp/product-target",
      targetBase: "d".repeat(40),
      providerId: "fixture-provider",
      modelId: "fixture-model",
      transport: "pi",
      manifestHash: "e".repeat(64),
      bindingHash: "f".repeat(64),
    } as const;
    const providerAttempt = {
      attemptKey,
      taskId: "FN-1",
      semanticTaskId: "TASK-1",
      campaignDeadlineAt: "2026-07-31T01:00:00.000Z",
      turnKey: "turn-1",
      dispatchKey: "dispatch-1",
      attemptOrdinal: 1,
      requestCount: 1,
      workItemFence,
      state: "dispatched_unknown",
      binding,
    } as const;
    const workItem = {
      id: workItemFence.workItemId,
      runId: workItemFence.runId,
      taskId: "FN-1",
      nodeId: "node-provider",
      kind: "task",
      state: "manual-required",
      attempt: workItemFence.attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_PROVIDER_DISPATCH_UNKNOWN",
      blockedReason: "ccc-permanent:CCC_PROVIDER_DISPATCH_UNKNOWN",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        packetHash: binding.packetHash,
        sidecarHash: binding.sidecarHash,
        bundleHash: binding.bundleHash,
        targetRepository: binding.targetRepository,
        targetBase: binding.targetBase,
        campaignId: binding.campaignId,
        state: "active",
        runnable: true,
      },
      tasks: [
        {
          semanticTaskId: "TASK-entry",
          nativeTaskId: "FN-entry",
          present: true,
          route: {
            providerId: "entry-provider",
            modelId: "entry-model",
            transport: "pi",
          },
        },
        {
          semanticTaskId: "TASK-1",
          nativeTaskId: "FN-1",
          present: true,
          route: {
            providerId: binding.providerId,
            modelId: binding.modelId,
            transport: binding.transport,
          },
        },
      ],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      providerAttempts: [providerAttempt],
      approvals: [],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "resolve-manual-required",
        reason: "Provider effect is uncertain.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      providerAttempts: [{
        ...providerAttempt,
        state: "committed",
        terminal: {
          kind: "reconciled",
          state: "committed",
          evidenceDigest,
          observerId: "operator-local-1",
        },
      }],
      nextAction: { kind: "wait-for-runtime", reason: "Ready." },
    };
    const inspectAttempt = vi.fn(async () => ({
      ...providerAttempt,
      controllerToken,
    }));
    const settleAttempt = vi.fn(async () => ({
      ...after.providerAttempts[0],
      controllerToken,
    }));
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        inspectCccProviderAttempt: inspectAttempt,
        settleCccProviderAttemptAndApproval: settleAttempt,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const previewOutput: string[] = [];

    expect(await runPrdCommand(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
      ],
      { write: (line) => previewOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
      },
      { projectName: "fixture" },
    )).toBe(0);
    const preview = JSON.parse(previewOutput[0]!);
    expect(preview).toMatchObject({
      kind: "provider-resolution-preview",
      attemptKey,
      outcome: "committed",
      consequence: expect.stringContaining("requeue"),
      confirmation: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inspectAttempt).not.toHaveBeenCalled();
    expect(settleAttempt).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();

    const settleOutput: string[] = [];
    expect(await runPrdCommand(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
        "--confirm",
        preview.confirmation,
      ],
      { write: (line) => settleOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
      },
      { projectName: "fixture" },
    )).toBe(0);
    expect(inspectAttempt).toHaveBeenCalledWith({
      taskId: "FN-1",
      attemptKey,
    });
    expect(settleAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptKey,
      controllerToken,
      outcome: "committed",
      evidenceDigest,
      observerId: "operator-local-1",
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      workItem.id,
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: workItem.attempt,
        expectedLeaseOwner: null,
        attempt: workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(settleOutput[0]!)).toMatchObject({
      kind: "provider-resolved",
      attempt: { attemptKey, state: "committed" },
      status: {
        workItems: [expect.objectContaining({ state: "runnable" })],
      },
    });
    expect(settleOutput[0]).not.toContain("controllerToken");
    expect(settleOutput[0]).not.toContain(controllerToken);

    const cliStatus = {
      ...before,
      tasks: [{
        ...before.tasks[0],
      }, {
        ...before.tasks[1],
        route: { ...before.tasks[1].route, transport: "cli" },
      }],
      providerAttempts: [{
        ...providerAttempt,
        binding: { ...binding, transport: "cli" },
      }],
    };
    const cliOutput: string[] = [];
    expect(await runPrdCommand(
      [
        "resolve-provider",
        "operator-key",
        attemptKey,
        "committed",
        "operator-local-1",
        evidenceDigest,
      ],
      { write: (line) => cliOutput.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => cliStatus),
      },
      { projectName: "fixture" },
    )).toBe(1);
    expect(JSON.parse(cliOutput[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_PROVIDER_RESOLUTION_CLI_FENCE_REQUIRED",
        message: expect.stringMatching(/native CLI.*recovery/i),
      }],
      safeState: expect.stringContaining("inspect"),
      decisionOwner: "human operator",
      consequence: expect.stringContaining("not complete"),
      approvalExpiresAt: null,
      recoveryOptions: expect.arrayContaining([
        expect.stringContaining("status"),
        expect.stringContaining("stop"),
      ]),
      nextSafeAction: expect.stringContaining("fn prd status"),
    });
  });

  it("claims exact merge approval, lands, and settles only its parked imported work item", async () => {
    const confirmation = "9".repeat(64);
    const approval = {
      id: "approval-1",
      status: "issued",
      taskId: "TASK-terminal",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "git_write",
        action: "ACTION-merge",
        summary: "Merge",
        resourceType: "ccc-campaign-merge",
        resourceId: "refs/heads/main",
        context: {
          protectedActionKind: "merge",
          operatorDecision: "approve_merge",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-terminal",
          actionId: "ACTION-merge",
          actionTarget: "refs/heads/main",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "pi",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-entry",
      nodeId: "node-entry",
      kind: "task",
      state: "manual-required",
      attempt: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: { kind: "approve-merge", reason: "Approve exact merge." },
    };
    const after = {
      ...before,
      workItems: [{ ...workItem, state: "succeeded", lastError: null, blockedReason: null }],
      landing: { intents: [{}], terminals: [{}] },
      nextAction: { kind: "complete", reason: "Campaign landed." },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const approveMerge = vi.fn(async () => ({
      merged: true,
      noOp: false,
      reason: "ccc-campaign-native-git-landed",
      campaignControlled: { kind: "ccc-campaign-controlled" },
    }));
    const output: string[] = [];

    expect(await runPrdCommand(
      ["approve-merge", "operator-key", "approval-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignMergeApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignMerge: approveMerge,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(approveMerge).toHaveBeenCalledWith(expect.objectContaining({
      store: context.store,
      rootDir: context.projectPath,
      taskId: "TASK-terminal",
      approvalRequestId: "approval-1",
      confirmation,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-item-1",
      "succeeded",
      {
        expectedState: "manual-required",
        expectedAttempt: 3,
        attempt: 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "merge-approved",
      approvalRequestId: "approval-1",
      result: { merged: true, noOp: false },
      status: { nextAction: { kind: "complete" } },
    });
  });

  it("keeps live-execution approval issued and work parked when verifier confinement is unavailable", async () => {
    const confirmation = "8".repeat(64);
    const approval = {
      id: "approval-live-1",
      status: "issued",
      taskId: "TASK-coding",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "command_execution",
        action: "ACTION-live",
        summary: "Run the admitted coding provider",
        resourceType: "ccc-campaign-live_execution",
        resourceId: "provider://fixture/TASK-coding",
        context: {
          protectedActionKind: "live_execution",
          operatorDecision: "approve_live_execution",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-coding",
          actionId: "ACTION-live",
          actionTarget: "provider://fixture/TASK-coding",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "cli",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const status = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve exact live execution.",
      },
    };
    const transitionWorkflowWorkItem = vi.fn();
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => ({}),
        transitionWorkflowWorkItem,
      },
    };
    const approveExecution = vi.fn();
    const output: string[] = [];

    expect(await runPrdCommand(
      ["approve-execution", "operator-key", "approval-live-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: vi.fn(async () => status),
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness: vi.fn(async () => ({
          ready: true,
          backend: "native" as never,
          code: "VERIFIER_CONFINEMENT_INVALID_RESULT",
          message: "readiness result named an unadmitted backend",
          trustedPaths: [] as const,
          detail: "private runner detail must not reach operator output",
        })),
      },
      { projectName: "fixture" },
    )).toBe(1);

    const refusal = JSON.parse(output[0]!);
    expect(refusal).toMatchObject({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
        message: "Exact requirement verification is unavailable: readiness result named an unadmitted backend",
      }],
      safeState: "Approval approval-live-1 remains issued and workflow work-item-1 remains manual-required; this command started no provider, source, or proof effect.",
      decisionOwner: "Fusion host or CI runner operator",
      consequence: "Live coding cannot start because Fusion could not prove exact requirement tests can run under enforced confinement.",
      approvalExpiresAt: "2026-07-31T01:00:00.000Z",
      recoveryOptions: [
        "Repair and functionally verify the trusted verifier confinement backend before this approval expires.",
        "If the approval expires, request a fresh exact live-execution approval after the host is ready.",
        "Stop the campaign with a fresh status digest if the operator does not want to continue.",
      ],
      nextSafeAction: "Repair verifier confinement, rerun fn prd status operator-key, then submit a still-current exact approval.",
    });
    expect(JSON.stringify(refusal.verifierConfinement)).not.toContain(
      "no campaign",
    );
    expect(output[0]).not.toContain("private runner detail");
    expect(approveExecution).not.toHaveBeenCalled();
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("claims exact live-execution approval and requeues only its parked imported work item", async () => {
    const confirmation = "8".repeat(64);
    const approval = {
      id: "approval-live-1",
      status: "issued",
      taskId: "TASK-coding",
      runId: "RUN-product",
      requester: {
        actorId: "ccc-campaign-runtime",
        actorType: "agent",
        actorName: "CCC Campaign Runtime",
      },
      targetAction: {
        category: "command_execution",
        action: "ACTION-live",
        summary: "Run the admitted coding provider",
        resourceType: "ccc-campaign-live_execution",
        resourceId: "provider://fixture/TASK-coding",
        context: {
          protectedActionKind: "live_execution",
          operatorDecision: "approve_live_execution",
        },
      },
      requestedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      campaign: {
        binding: {
          projectId: "project-1",
          importId: "import-1",
          campaignId: "campaign-1",
          taskId: "TASK-coding",
          actionId: "ACTION-live",
          actionTarget: "provider://fixture/TASK-coding",
          idempotencyKey: "operator-key",
          packetHash: "a".repeat(64),
          sidecarHash: "b".repeat(64),
          bundleHash: "c".repeat(64),
          targetRepository: "/tmp/product-target",
          targetBase: "d".repeat(40),
          providerId: "fixture",
          modelId: "fixture-v2",
          transport: "cli",
          manifestHash: "e".repeat(64),
          bindingHash: "f".repeat(64),
        },
        notBeforeAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
      },
    };
    const workItem = {
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "TASK-coding",
      nodeId: "node-coding",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    };
    const before = {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
      },
      tasks: [],
      workItems: [workItem],
      proofs: [],
      orphanProofAttempts: [],
      approvals: [approval],
      landing: { intents: [], terminals: [] },
      nextAction: {
        kind: "approve-execution",
        reason: "Approve exact live execution.",
      },
    };
    const after = {
      ...before,
      workItems: [{
        ...workItem,
        state: "runnable",
        lastError: null,
        blockedReason: null,
      }],
      approvals: [{ ...approval, status: "claimed" }],
      nextAction: {
        kind: "wait-for-runtime",
        reason: "Campaign work is admitted and ready for the runtime.",
      },
    };
    const transitionWorkflowWorkItem = vi.fn(async () => after.workItems[0]);
    const layer = {};
    const context = {
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: {
        getAsyncLayer: () => layer,
        transitionWorkflowWorkItem,
      },
    };
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const approveExecution = vi.fn(async () => after.approvals[0]);
    const inspectVerifierConfinementReadiness = vi.fn(async () => ({
      ready: true,
      backend: "sandbox-exec" as const,
      code: "VERIFIER_CONFINEMENT_READY",
      message: "verifier confinement readiness probe executed successfully",
      trustedPaths: ["/usr/bin/sandbox-exec"] as const,
    }));
    const output: string[] = [];

    expect(await runPrdCommand(
      ["approve-execution", "operator-key", "approval-live-1", "--confirm", confirmation],
      { write: (line) => output.push(line) },
      {
        resolveProject: vi.fn(async () => context),
        closeProjectStore: vi.fn(async () => undefined),
        inspectCccPrdProductStatus: inspectStatus,
        computeCccCampaignLiveExecutionApprovalConfirmation: vi.fn(() => confirmation),
        approveCccCampaignLiveExecution: approveExecution,
        inspectVerifierConfinementReadiness,
      },
      { projectName: "fixture" },
    )).toBe(0);

    expect(approveExecution).toHaveBeenCalledWith(expect.objectContaining({
      store: context.store,
      rootDir: context.projectPath,
      taskId: "TASK-coding",
      approvalRequestId: "approval-live-1",
      confirmation,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    }));
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "work-item-1",
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: 1,
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        blockedReason: null,
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "execution-approved",
      approvalRequestId: "approval-live-1",
      approval: { status: "claimed" },
      status: { nextAction: { kind: "wait-for-runtime" } },
    });
    expect(inspectVerifierConfinementReadiness).toHaveBeenCalledTimes(1);
  });
});
