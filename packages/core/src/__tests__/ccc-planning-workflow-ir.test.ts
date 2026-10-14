import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import { buildCccPlanningWorkflowIr, cccPlanningWorkflowIrHash } from "../ccc-planning/workflow-ir.js";
import { CCC_PLANNING_IR_STAGES } from "../ccc-planning/types.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import { hashWorkflowIr } from "../workflow-ir-resolver.js";
import type { WorkflowIrNode } from "../workflow-ir-types.js";

/*
FNXC:CccPlanningWorkflowIr 2026-10-14-08:40:
Card K1 proof for the planning workflow IR (CONTRACT-v2 section 2.10, decision 0.23). AD1 stores this IR at admission and H1 verifies its hash at every stage start, so the hash must be the importer's sha256-over-canonical-JSON rule, never the djb2 `hashWorkflowIr` used for display. The IR must also be a graph core's own parser accepts, or AD1 could never store it.
*/

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stageNodes(nodes: readonly WorkflowIrNode[]): WorkflowIrNode[] {
  return nodes.filter((node) => node.kind === "gate");
}

describe("planning workflow IR", () => {
  it("chains one gate node per IR stage in contract order for Build", () => {
    const ir = buildCccPlanningWorkflowIr("build");
    const gates = stageNodes(ir.nodes);
    expect(gates.map((node) => node.config?.cccPlanningStage)).toEqual([...CCC_PLANNING_IR_STAGES]);
    for (const node of gates) expect(node.config?.maxRetries, node.id).toBe(0);
    const order = ["start", ...gates.map((node) => node.id), "end"];
    expect(ir.edges.map((edge) => [edge.from, edge.to])).toEqual(order.slice(1).map((to, index) => [order[index], to]));
    expect(ir.nodes.map((node) => node.kind)).toEqual(["start", ...gates.map(() => "gate"), "end"]);
  });

  it("omits only the import stage in Spec mode", () => {
    const stages = stageNodes(buildCccPlanningWorkflowIr("spec").nodes).map((node) => node.config?.cccPlanningStage);
    expect(stages).not.toContain("import");
    expect(stages).toEqual(CCC_PLANNING_IR_STAGES.filter((stage) => stage !== "import"));
  });

  it("is accepted by core's workflow IR parser", () => {
    for (const mode of ["spec", "build"] as const) {
      const ir = buildCccPlanningWorkflowIr(mode);
      expect(() => parseWorkflowIr(structuredClone(ir))).not.toThrow();
    }
  });

  it("hashes as sha256 of canonical JSON, stable across calls and sensitive to one config byte", () => {
    const ir = buildCccPlanningWorkflowIr("build");
    const hash = cccPlanningWorkflowIrHash(ir);
    expect(hash).toBe(sha256(canonicalCccPrdJson(ir)));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr("build"))).toBe(hash);
    const changed = structuredClone(ir);
    const gate = stageNodes(changed.nodes)[3]!;
    gate.config = { ...gate.config, cccPlanningStage: "designx" };
    expect(cccPlanningWorkflowIrHash(changed)).not.toBe(hash);
    expect(cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr("spec"))).not.toBe(hash);
    // Non-vacuous: the display hash is a short djb2 value, never the 64-hex admission hash.
    expect(hashWorkflowIr(ir)).not.toBe(hash);
    expect(hashWorkflowIr(ir)).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a fresh graph each call so a caller cannot mutate the next admission", () => {
    const first = buildCccPlanningWorkflowIr("build");
    expect(stageNodes(first.nodes)).toHaveLength(CCC_PLANNING_IR_STAGES.length);
    stageNodes(first.nodes)[0]!.config!.maxRetries = 9;
    expect(stageNodes(buildCccPlanningWorkflowIr("build").nodes)[0]!.config!.maxRetries).toBe(0);
  });
});
