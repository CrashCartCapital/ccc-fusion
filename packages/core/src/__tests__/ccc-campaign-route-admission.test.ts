import { describe, expect, it } from "vitest";
import {
  admitCccRequestToCodeRoutes,
  type CccPlanningReviewIdentity,
  type CccQualifiedPin,
  type CccRouteRole,
} from "../ccc-campaign/route-admission.js";
import type { CccCampaignProductExecutionRoute } from "../ccc-campaign/types.js";

/*
FNXC:CccRouteAdmission 2026-10-14-13:45:
Card K2 RED for request-to-code route admission (critic 11, ADR C Q2 as amended by CONTRACT-v3 section 2.7). Admission is by allowlist: a writer is GLM 5.3 Flash, every review identity is MiniMax M3, each on its pinned loopback provider through the receipt adapter and Pi, and a reviewer never shares the reviewed writer's model family. Every refusal case is the admitted control set with one field changed, so a refuse-everything implementation fails the control.
FNXC:CccRouteAdmission 2026-10-14-17:16:
Repair 1 (errata E5-K2 items 3, 5 and 6). An unknown route kind is refused rather than judged as G8, a provider that serves two pinned models pins neither, and each graph-role, duplicate-id and pin-shape guard the round-1 mutants showed unprotected has a refusal with an admitted control. A role override changes one task's graph role and nothing else, so the control and the refusal differ in that one field.
*/

const PINS: readonly CccQualifiedPin[] = [
  { modelId: "glm/glm-5.3", family: "glm", providerId: "ccc-glm53", settingsEntrySha256: "1".repeat(64) },
  { modelId: "glm/glm-5.3-flash", family: "glm", providerId: "ccc-glm53-flash", settingsEntrySha256: "2".repeat(64) },
  { modelId: "minimax/MiniMax-M3", family: "minimax", providerId: "ccc-minimax-m3", settingsEntrySha256: "3".repeat(64) },
];

function writer(taskId: string, patch: Partial<CccCampaignProductExecutionRoute> = {}): CccCampaignProductExecutionRoute {
  return {
    taskId, providerId: "ccc-glm53-flash", modelId: "glm/glm-5.3-flash", transport: "pi", executor: "model",
    toolMode: "coding", worktreeMode: "isolated", ownedPaths: [`src/${taskId}.mjs`], allowedWriteRoots: ["src"],
    commitPolicy: "required", receiptAdapterId: "terminal-route-sse-comments.v1", ...patch,
  };
}

function review(taskId: string, reviewOfTaskId: string, patch: Partial<CccPlanningReviewIdentity> = {}): CccPlanningReviewIdentity {
  return {
    taskId, routeKind: "g7-review", reviewOfTaskId, providerId: "ccc-minimax-m3", modelId: "minimax/MiniMax-M3",
    transport: "pi", receiptAdapterId: "terminal-route-sse-comments.v1", ...patch,
  };
}

function judge(patch: Partial<CccPlanningReviewIdentity> = {}): CccPlanningReviewIdentity {
  return { ...review("judge:final", "", patch), routeKind: "g8-judge", reviewOfTaskId: null, ...patch };
}

type Route = CccCampaignProductExecutionRoute | CccPlanningReviewIdentity;

function controlRoutes(): Route[] {
  return [writer("T1"), writer("T2"), review("review:T1", "T1"), review("review:T2", "T2"), judge()];
}

const ROLES: Readonly<Record<string, CccRouteRole>> = {
  T1: "writer", T2: "writer", "review:T1": "g7-review", "review:T2": "g7-review",
};

function admit(routes: readonly Route[], pins: readonly CccQualifiedPin[] = PINS, roles: Readonly<Record<string, CccRouteRole>> = {}) {
  return admitCccRequestToCodeRoutes({
    routes,
    roleOf: (taskId) => {
      const role = roles[taskId] ?? ROLES[taskId];
      if (!role) throw new Error(`unknown task ${taskId}`);
      return role;
    },
    reviewedTaskOf: (reviewTaskId) => reviewTaskId.slice("review:".length),
    pins,
  });
}

function reasons(routes: readonly Route[], pins?: readonly CccQualifiedPin[], roles?: Readonly<Record<string, CccRouteRole>>): string[] {
  return admit(routes, pins, roles).map((refusal) => `${refusal.taskId}:${refusal.reason}:${refusal.observedModelId}`);
}

function replaceAt(index: number, route: Route): Route[] {
  const routes = controlRoutes();
  routes[index] = route;
  return routes;
}

describe("request-to-code route admission", () => {
  it("admits the control: Flash writers, M3 task reviews and an M3 final judge on their pinned providers", () => {
    expect(admit(controlRoutes())).toEqual([]);
  });

  it("refuses combo/x as combo-route, and admits the control glm/glm-5.3-flash", () => {
    const refused = admit(replaceAt(0, writer("T1", { modelId: "combo/x" })));
    expect(refused).toEqual([{ code: "CCC_ROUTE_IDENTITY_REJECTED", reason: "combo-route", taskId: "T1", observedModelId: "combo/x" }]);
    expect(admit(replaceAt(0, writer("T1", { modelId: "glm/glm-5.3-flash" })))).toEqual([]);
  });

  it("refuses a Flash writer reviewed by glm/glm-5.3 as same-family-review, and admits the M3 control", () => {
    const refused = admit(replaceAt(2, review("review:T1", "T1", { modelId: "glm/glm-5.3", providerId: "ccc-glm53" })));
    expect(refused).toEqual([
      { code: "CCC_ROUTE_IDENTITY_REJECTED", reason: "same-family-review", taskId: "review:T1", observedModelId: "glm/glm-5.3" },
    ]);
    expect(admit(replaceAt(2, review("review:T1", "T1", { modelId: "minimax/MiniMax-M3", providerId: "ccc-minimax-m3" }))))
      .toEqual([]);
  });

  it("refuses a GLM final judge of GLM writers as same-family-review", () => {
    expect(reasons(replaceAt(4, judge({ modelId: "glm/glm-5.3", providerId: "ccc-glm53" }))))
      .toEqual(["judge:final:same-family-review:glm/glm-5.3"]);
  });

  it("names every identity reason in the frozen classification order", () => {
    const cases: readonly [string, string][] = [
      ["glm/glm-5.2", "excluded-model"], ["glm-5.2", "excluded-model"], ["glm/glm-5.3-latest", "floating-alias"],
      ["combo/glm", "combo-route"], ["glm-5.3-flash", "unqualified-id"], ["opencode-go/glm-5.3", "not-in-pin-registry"],
      ["glm/glm-5.3-flashx", "not-in-pin-registry"], ["glm/GLM-5.3-flash", "not-in-pin-registry"],
    ];
    for (const [modelId, reason] of cases) {
      expect(reasons(replaceAt(0, writer("T1", { modelId })))).toEqual([`T1:${reason}:${modelId}`]);
    }
  });

  it("refuses a combo with terminal route members even under an exact model id", () => {
    const route = writer("T1", { terminalRouteMembers: [{ provider: "ccc-glm53-flash", model: "glm/glm-5.3-flash" }] });
    expect(reasons(replaceAt(0, route))).toEqual(["T1:combo-route:glm/glm-5.3-flash"]);
  });

  it("refuses a writer on GLM 5.3 or M3 as role-model-mismatch, and a review of its own family first as same-family-review", () => {
    expect(reasons(replaceAt(0, writer("T1", { modelId: "glm/glm-5.3", providerId: "ccc-glm53" }))))
      .toEqual(["T1:role-model-mismatch:glm/glm-5.3"]);
    expect(reasons(replaceAt(0, writer("T1", { modelId: "minimax/MiniMax-M3", providerId: "ccc-minimax-m3" }))))
      .toEqual([
        "T1:role-model-mismatch:minimax/MiniMax-M3",
        "review:T1:same-family-review:minimax/MiniMax-M3",
        "judge:final:same-family-review:minimax/MiniMax-M3",
      ]);
    expect(reasons(replaceAt(2, review("review:T1", "T1", { modelId: "glm/glm-5.3-flash", providerId: "ccc-glm53-flash" }))))
      .toEqual(["review:T1:same-family-review:glm/glm-5.3-flash"]);
    // A review of the other family on a model that is not M3 is the role's error, not the family's.
    const routes = controlRoutes();
    routes[1] = writer("T2", { modelId: "minimax/MiniMax-M3", providerId: "ccc-minimax-m3" });
    routes[3] = review("review:T2", "T2", { modelId: "glm/glm-5.3", providerId: "ccc-glm53" });
    expect(reasons(routes)).toEqual([
      "T2:role-model-mismatch:minimax/MiniMax-M3",
      "review:T2:role-model-mismatch:glm/glm-5.3",
      "judge:final:same-family-review:minimax/MiniMax-M3",
    ]);
  });

  it("refuses a route whose kind disagrees with the graph role or whose reviewed task disagrees with the graph", () => {
    // A product route for a task the graph calls a review, and a review identity naming the wrong writer.
    expect(reasons(replaceAt(2, writer("review:T1", { modelId: "minimax/MiniMax-M3", providerId: "ccc-minimax-m3" }))))
      .toEqual(["review:T1:role-model-mismatch:minimax/MiniMax-M3"]);
    expect(reasons(replaceAt(2, review("review:T1", "T2")))).toEqual(["review:T1:role-model-mismatch:minimax/MiniMax-M3"]);
  });

  it("refuses a non-pi transport, a missing receipt adapter and an unpinned provider", () => {
    expect(reasons(replaceAt(0, writer("T1", { transport: "cli", executor: "cli-agent" }))))
      .toEqual(["T1:transport-not-pi:glm/glm-5.3-flash"]);
    const withoutAdapter = writer("T1");
    delete (withoutAdapter as { receiptAdapterId?: string }).receiptAdapterId;
    expect(reasons(replaceAt(0, withoutAdapter))).toEqual(["T1:receipt-adapter-required:glm/glm-5.3-flash"]);
    expect(reasons(replaceAt(0, writer("T1", { providerId: "openrouter" })))).toEqual(["T1:provider-not-pinned:glm/glm-5.3-flash"]);
    // A pin list without the Flash pin, or with two Flash pins, leaves the writer unpinned.
    const withoutFlash = PINS.filter((pin) => pin.modelId !== "glm/glm-5.3-flash");
    expect(reasons(controlRoutes(), withoutFlash))
      .toEqual(["T1:provider-not-pinned:glm/glm-5.3-flash", "T2:provider-not-pinned:glm/glm-5.3-flash"]);
    const doubled = [...PINS, { ...PINS[1]!, providerId: "ccc-glm53-flash-b" }];
    expect(reasons(controlRoutes(), doubled))
      .toEqual(["T1:provider-not-pinned:glm/glm-5.3-flash", "T2:provider-not-pinned:glm/glm-5.3-flash"]);
  });

  it("refuses a review identity whose route kind is neither g7-review nor g8-judge, and admits the g8-judge control", () => {
    // E5-K2 item 3: the route kind is an allowlist; an unknown kind is not a judge.
    const unknownKind = { ...judge(), routeKind: "g9-anything" } as unknown as CccPlanningReviewIdentity;
    expect(reasons(replaceAt(4, unknownKind))).toEqual(["judge:final:role-model-mismatch:minimax/MiniMax-M3"]);
    expect(reasons(replaceAt(4, { ...judge(), routeKind: "g8-judge" as const }))).toEqual([]);
  });

  it("refuses pins that give two models the same provider as provider-not-pinned", () => {
    // E5-K2 item 6: one provider per model, as the receipt's three distinct provider ids require.
    const shared = PINS.map((pin) => (pin.modelId === "glm/glm-5.3" ? pin : { ...pin, providerId: "ccc-shared" }));
    const onShared = controlRoutes().map((route) => ({ ...route, providerId: "ccc-shared" }));
    expect(reasons(onShared, shared)).toEqual([
      "T1:provider-not-pinned:glm/glm-5.3-flash", "T2:provider-not-pinned:glm/glm-5.3-flash",
      "review:T1:provider-not-pinned:minimax/MiniMax-M3", "review:T2:provider-not-pinned:minimax/MiniMax-M3",
      "judge:final:provider-not-pinned:minimax/MiniMax-M3",
    ]);
    // The GLM 5.3 pin on the Flash provider leaves the Flash writers unpinned, although no route uses GLM 5.3.
    const glmOnFlash = PINS.map((pin) => (pin.modelId === "glm/glm-5.3" ? { ...pin, providerId: "ccc-glm53-flash" } : pin));
    expect(reasons(controlRoutes(), glmOnFlash))
      .toEqual(["T1:provider-not-pinned:glm/glm-5.3-flash", "T2:provider-not-pinned:glm/glm-5.3-flash"]);
    expect(reasons(controlRoutes(), PINS)).toEqual([]);
  });

  it("refuses a G7 identity on a writer task, a G7 review of a review or of a non-writer, and a G8 judge with a reviewed task", () => {
    // E5-K2 item 5: each graph-role guard the round-1 mutants showed unprotected, against an admitted one-field control.
    expect(reasons(controlRoutes(), PINS, { "review:T1": "writer" })).toEqual(["review:T1:role-model-mismatch:minimax/MiniMax-M3"]);
    expect(reasons(controlRoutes(), PINS, { "review:T1": "g7-review" })).toEqual([]);
    // A G7 identity whose reviewed task is itself a review identity.
    expect(reasons([...controlRoutes(), review("review:review:T1", "review:T1")], PINS, { "review:review:T1": "g7-review" }))
      .toEqual(["review:review:T1:role-model-mismatch:minimax/MiniMax-M3"]);
    // A G7 identity whose reviewed task is a product route the graph does not call a writer.
    const withP9 = [...controlRoutes(), writer("P9"), review("review:P9", "P9")];
    expect(reasons(withP9, PINS, { P9: "g7-review", "review:P9": "g7-review" }))
      .toEqual(["P9:role-model-mismatch:glm/glm-5.3-flash", "review:P9:role-model-mismatch:minimax/MiniMax-M3"]);
    expect(reasons(withP9, PINS, { P9: "writer", "review:P9": "g7-review" })).toEqual([]);
    expect(reasons(replaceAt(4, judge({ reviewOfTaskId: "T1" })))).toEqual(["judge:final:role-model-mismatch:minimax/MiniMax-M3"]);
    expect(reasons(replaceAt(4, judge({ reviewOfTaskId: null })))).toEqual([]);
  });

  it("refuses duplicate task ids, and a pin with the wrong family or a malformed settings digest", () => {
    // E5-K2 item 5: a duplicate task id is a caller bug, never a second admitted route.
    expect(() => admit([...controlRoutes(), writer("T1")])).toThrow(/duplicate task id "T1"/u);
    expect(() => admit(controlRoutes())).not.toThrow();
    const flashPin = (patch: Partial<CccQualifiedPin>) => PINS.map((pin) => (pin.modelId === "glm/glm-5.3-flash" ? { ...pin, ...patch } : pin));
    for (const patch of [{ family: "minimax" as const }, { settingsEntrySha256: "2".repeat(63) }, { settingsEntrySha256: "A".repeat(64) }]) {
      expect(reasons(controlRoutes(), flashPin(patch)), JSON.stringify(patch))
        .toEqual(["T1:provider-not-pinned:glm/glm-5.3-flash", "T2:provider-not-pinned:glm/glm-5.3-flash"]);
    }
    expect(reasons(controlRoutes(), flashPin({ family: "glm", settingsEntrySha256: "2".repeat(64) }))).toEqual([]);
  });
});
