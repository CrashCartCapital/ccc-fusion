import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { selectCccCampaignDeclaredLiveExecutionAction, type CccPrdSidecar } from "@fusion/core";

const sidecarPath = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/candidate.sidecar.v1.json", import.meta.url);
const EXPECTED_CCC_LAB_SUPER_SIDECAR_SHA256 = "644624afede709b457a075094df0c4b69072ca1823422e94fa2429449b039ed8";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("CCC campaign provider controller real-packet authority", () => {
  it("selects the exact declared live-execution action without rewriting the unchanged sidecar", async () => {
    const before = await readFile(sidecarPath);
    const beforeHash = sha256(before);
    expect(beforeHash).toBe(EXPECTED_CCC_LAB_SUPER_SIDECAR_SHA256);
    const sidecar = JSON.parse(before.toString("utf8")) as CccPrdSidecar;

    expect(sidecar.tasks.some((task) => task.id === "TASK-KERNEL-TRANSACTION")).toBe(true);
    const action = selectCccCampaignDeclaredLiveExecutionAction(sidecar.protectedActions);

    expect(action).toEqual({
      actionId: "ACTION-LIVE-EXECUTION",
      actionTarget: "ccc-lab-super:pre-live-provider-gate",
      requireProtected: true,
    });
    expect(action.actionTarget).not.toBe("TASK-KERNEL-TRANSACTION");
    expect(action.actionTarget).not.toMatch(/^TASK-/);

    const after = await readFile(sidecarPath);
    expect(sha256(after)).toBe(EXPECTED_CCC_LAB_SUPER_SIDECAR_SHA256);
    expect(sha256(after)).toBe(beforeHash);
    expect(after.equals(before)).toBe(true);
  });
});
