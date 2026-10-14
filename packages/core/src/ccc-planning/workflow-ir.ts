import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "../workflow-ir-types.js";
import { CCC_PLANNING_IR_STAGES, type CccPlanningMode } from "./types.js";

/*
FNXC:CccPlanningWorkflowIr 2026-10-14-09:15:
A request-to-code run is one Fusion workflow: start, one `gate` node per IR stage in section 2.4 order, end, chained by success edges (CONTRACT-v2 decision 0.23, D1). Each gate carries `config.cccPlanningStage` so the stage host knows which stage to run, and `maxRetries: 0` because a stage never retries through the workflow engine; node attempts are counted by the planning ledger instead. Spec mode omits only the `import` stage. The builder lives in core so admission (AD1, core) can store the IR and the stage host (H1, engine) can verify it. Its hash is SHA-256 over canonical JSON, the importer's rule for campaign work items, not the short display hash `hashWorkflowIr`.
*/

export function buildCccPlanningWorkflowIr(mode: CccPlanningMode): WorkflowIr {
  const stages = CCC_PLANNING_IR_STAGES.filter((stage) => mode === "build" || stage !== "import");
  const nodes: WorkflowIrNode[] = [
    { id: "start", kind: "start" },
    ...stages.map((stage): WorkflowIrNode => ({ id: stage, kind: "gate", config: { cccPlanningStage: stage, maxRetries: 0 } })),
    { id: "end", kind: "end" },
  ];
  const edges: WorkflowIrEdge[] = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id, condition: "success" }));
  return { version: "v2", name: `ccc-planning-${mode}`, columns: [], nodes, edges };
}

/** sha256(canonicalCccPrdJson(ir)); H1 compares it with the work item's stored irHash at every stage start. */
export function cccPlanningWorkflowIrHash(ir: WorkflowIr): string {
  return createHash("sha256").update(canonicalCccPrdJson(ir), "utf8").digest("hex");
}
