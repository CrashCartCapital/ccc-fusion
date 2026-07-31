import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";

const ccc = engine as typeof engine & {
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    requireMaterialCoverage?: boolean;
  }): {
    kind: string;
    diagnostics?: Array<{ code: string; message: string }>;
  };
  validateCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    requireMaterialCoverage?: boolean;
  }): {
    kind: string;
    valid: boolean;
    diagnostics: Array<{ code: string; message: string }>;
  };
};

const fixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type MutableSidecar = {
  importIntents: Array<Record<string, string>>;
  workflows: Array<Record<string, unknown> & { id: string }>;
};

function packet(mutator: (sidecar: MutableSidecar) => void): {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), "ccc-prd-import-intents-"));
  roots.push(rootDir);
  cpSync(fixture, rootDir, { recursive: true });
  const sidecarPath = join(rootDir, "candidate.sidecar.v1.json");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as MutableSidecar;
  mutator(sidecar);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`);
  return { rootDir, manifestPath: join(rootDir, "manifest.json"), sidecarPath };
}

function refusal(input: ReturnType<typeof packet>): Array<{ code: string; message: string }> {
  const result = ccc.compileCccPrdPacket(input);
  expect(result.kind).toBe("refusal");
  return result.diagnostics ?? [];
}

function expectValidationAndCompileRefusal(
  input: ReturnType<typeof packet>,
  expectedCode: string,
  options: { requireMaterialCoverage?: boolean } = {},
): void {
  const validation = ccc.validateCccPrdPacket({ ...input, ...options });
  const compiled = ccc.compileCccPrdPacket({ ...input, ...options });
  expect(validation.valid).toBe(false);
  expect(validation.diagnostics).toContainEqual(
    expect.objectContaining({ code: expectedCode }),
  );
  expect(compiled.kind).toBe("refusal");
  expect(compiled.diagnostics).toContainEqual(
    expect.objectContaining({ code: expectedCode }),
  );
}

describe("ccc-prd import intent descendants", () => {
  it("keeps the unmodified real oracle green", () => {
    const result = ccc.compileCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath: new URL("manifest.json", fixture).pathname,
      sidecarPath: new URL("candidate.sidecar.v1.json", fixture).pathname,
    });
    expect(result.kind).toBe("bundle");
  });

  it.each([
    ["campaign", "project.missions"],
    ["task", "project.tasks"],
    ["dependency_edge", "project.tasks.dependencies"],
    ["workflow", "project.workflow_work_items"],
    ["document", "project.task_documents"],
    ["artifact", "project.artifacts"],
    ["source", "project.ccc_prd_import_sources"],
    ["work_item", "project.workflow_work_items"],
    ["run_audit", "project.run_audit_events"],
  ])("refuses a wrong native target for %s", (entityType, expectedTarget) => {
    const diagnostics = refusal(packet((sidecar) => {
      const intent = sidecar.importIntents.find((value) => value.entityType === entityType)!;
      expect(intent.target).toBe(expectedTarget);
      intent.target = "project.wrong_target";
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CCC_PRD_IMPORT_INTENT_INVALID" }));
  });

  it("refuses foreign work item and run audit entities", () => {
    for (const entityType of ["work_item", "run_audit"]) {
      const diagnostics = refusal(packet((sidecar) => {
        sidecar.importIntents.find((value) => value.entityType === entityType)!.entityId = "FOREIGN-ID";
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CCC_PRD_IMPORT_INTENT_INVALID" }));
    }
  });

  it.each([
    "campaign",
    "source",
    "run_audit",
    "workflow",
    "work_item",
  ])("requires exactly one %s intent", (entityType) => {
    for (const count of [0, 2]) {
      const input = packet((sidecar) => {
        const index = sidecar.importIntents.findIndex((value) => value.entityType === entityType);
        if (count === 0) sidecar.importIntents.splice(index, 1);
        else sidecar.importIntents.push({ ...sidecar.importIntents[index], id: `DUPLICATE-${entityType}` });
      });
      expectValidationAndCompileRefusal(
        input,
        "CCC_PRD_IMPORT_INTENT_CARDINALITY",
      );
    }
  });

  it("binds the sole work item intent to the sole imported workflow", () => {
    const input = packet((sidecar) => {
      const importedWorkflow = sidecar.importIntents.find(
        ({ entityType }) => entityType === "workflow",
      )!;
      const workItem = sidecar.importIntents.find(
        ({ entityType }) => entityType === "work_item",
      )!;
      const declaredWorkflow = sidecar.workflows.find(
        ({ id }) => id === importedWorkflow.entityId,
      )!;
      const foreignWorkflowId = "WORKFLOW-FOREIGN";
      sidecar.workflows.push({
        ...declaredWorkflow,
        id: foreignWorkflowId,
      });
      workItem.entityId = foreignWorkflowId;
    });

    expectValidationAndCompileRefusal(
      input,
      "CCC_PRD_IMPORT_INTENT_INVALID",
    );
  });

  it("refuses a multi-task graph on the current supported product path", () => {
    const input = packet(() => undefined);
    for (const result of [
      ccc.validateCccPrdPacket({
        ...input,
        requireMaterialCoverage: true,
      }),
      ccc.compileCccPrdPacket({
        ...input,
        requireMaterialCoverage: true,
      }),
    ]) {
      expect(result).toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED",
            message: expect.stringContaining(
              "multi-task campaign integration is not yet supported",
            ),
          }),
        ]),
      });
    }
  });
});
