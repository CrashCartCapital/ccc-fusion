import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";

const ccc = engine as typeof engine & {
  compileCccPrdPacket(input: { rootDir: string; manifestPath: string; sidecarPath: string }): {
    kind: string;
    diagnostics?: Array<{ code: string; message: string }>;
  };
};

const fixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packet(mutator: (sidecar: { importIntents: Array<Record<string, string>> }) => void): {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), "ccc-prd-import-intents-"));
  roots.push(rootDir);
  cpSync(fixture, rootDir, { recursive: true });
  const sidecarPath = join(rootDir, "candidate.sidecar.v1.json");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as { importIntents: Array<Record<string, string>> };
  mutator(sidecar);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`);
  return { rootDir, manifestPath: join(rootDir, "manifest.json"), sidecarPath };
}

function refusal(input: ReturnType<typeof packet>): Array<{ code: string; message: string }> {
  const result = ccc.compileCccPrdPacket(input);
  expect(result.kind).toBe("refusal");
  return result.diagnostics ?? [];
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

  it.each(["campaign", "source", "run_audit"])("requires exactly one %s intent", (entityType) => {
    for (const count of [0, 2]) {
      const diagnostics = refusal(packet((sidecar) => {
        const index = sidecar.importIntents.findIndex((value) => value.entityType === entityType);
        if (count === 0) sidecar.importIntents.splice(index, 1);
        else sidecar.importIntents.push({ ...sidecar.importIntents[index], id: `DUPLICATE-${entityType}` });
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CCC_PRD_IMPORT_INTENT_CARDINALITY" }));
    }
  });
});
