import { CCC_PLANNING_MODEL_FAMILIES, classifyCccModelIdentity } from "../ccc-planning/policy.js";
import type { CccModelFamily, CccModelIdentityReason, CccPlanningExactModelId } from "../ccc-planning/types.js";
import type { CccCampaignProductExecutionRoute } from "./types.js";

/*
FNXC:CccRouteAdmission 2026-10-14-13:58:
Request-to-code route admission (critic 11, ADR C Q2 as amended by CONTRACT-v3 section 2.7 and decision 0.21). The import bridge calls it for planning-linked imports only, on every writer route and on the planned G7 and G8 review identities; `canonical.ts` and `importer.ts` are untouched, so historical combo campaigns still re-parse and direct `fn prd` stays byte-identical (PRD section 2). Admission is by allowlist: the role decides the model (writer: glm/glm-5.3-flash; G7 and G8: minimax/MiniMax-M3), on its one pinned provider, over Pi with the terminal receipt adapter, and no reviewer shares the reviewed writer's model family (glm/* is one family). The denylist only names the reason.

Each route gets at most one refusal, from the first failing check in this order: model identity (K1's frozen classification, plus `terminalRouteMembers` as a combo), transport, receipt adapter, the route's role against the compiled graph, the reviewer's family, the role's model, then the provider pin. The family check runs before the role-model check so a same-family reviewer is named as such. A review of a writer whose own model id is not an exact pin is not refused for family: that writer's refusal already blocks the import.
*/

/** The writer route admission reads: the product execution route of `ccc-campaign/types.ts`. */
export type CccCampaignProductRoute = CccCampaignProductExecutionRoute;

export type CccQualifiedPin = Readonly<{
  modelId: CccPlanningExactModelId;
  family: CccModelFamily;
  providerId: string;
  settingsEntrySha256: string;
}>;
export type CccRouteRole = "writer" | "g7-review";
export type CccRouteAdmissionReason =
  | CccModelIdentityReason      // excluded-model, floating-alias, combo-route, unqualified-id, not-in-pin-registry
  | "role-model-mismatch"
  | "provider-not-pinned"       // providerId absent, not the single valid pin for the model, or the pin is malformed
  | "receipt-adapter-required"
  | "transport-not-pi"
  | "same-family-review";
export type CccRouteAdmissionRefusal = Readonly<{
  code: "CCC_ROUTE_IDENTITY_REJECTED";
  reason: CccRouteAdmissionReason;
  taskId: string;
  observedModelId: string;
}>;
export type CccPlanningReviewIdentity = Readonly<{
  taskId: string;
  routeKind: "g7-review" | "g8-judge";
  reviewOfTaskId: string | null;
  providerId: string;
  modelId: string;
  transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
}>;

type AdmissionRoute = CccCampaignProductRoute | CccPlanningReviewIdentity;

const WRITER_MODEL: CccPlanningExactModelId = "glm/glm-5.3-flash";   // GLM 5.3 writer escalation is I3, refused in I2
const REVIEW_MODEL: CccPlanningExactModelId = "minimax/MiniMax-M3";
const RECEIPT_ADAPTER = "terminal-route-sse-comments.v1";
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function isReviewIdentity(route: AdmissionRoute): route is CccPlanningReviewIdentity {
  return Object.prototype.hasOwnProperty.call(route, "routeKind");
}

/** The admitted family of a route's model, or null when its id is not an exact pin. */
function familyOf(route: AdmissionRoute): CccModelFamily | null {
  const identity = classifyCccModelIdentity(route.modelId);
  return identity.admitted ? identity.family : null;
}

/** A model is pinned only by exactly one well-formed pin; a duplicate or malformed pin pins nothing. */
function pinnedProviderOf(modelId: CccPlanningExactModelId, pins: readonly CccQualifiedPin[]): string | null {
  const matches = pins.filter((pin) => pin.modelId === modelId);
  if (matches.length !== 1) return null;
  const pin = matches[0]!;
  const wellFormed = pin.family === CCC_PLANNING_MODEL_FAMILIES[modelId]
    && typeof pin.providerId === "string" && pin.providerId !== ""
    && typeof pin.settingsEntrySha256 === "string" && SHA256_HEX.test(pin.settingsEntrySha256);
  return wellFormed ? pin.providerId : null;
}

export function admitCccRequestToCodeRoutes(input: Readonly<{
  routes: readonly (CccCampaignProductRoute | CccPlanningReviewIdentity)[];
  roleOf: (taskId: string) => CccRouteRole;
  reviewedTaskOf: (reviewTaskId: string) => string;
  pins: readonly CccQualifiedPin[];
}>): readonly CccRouteAdmissionRefusal[] {
  const byTaskId = new Map<string, AdmissionRoute>();
  for (const route of input.routes) {
    if (byTaskId.has(route.taskId)) throw new TypeError(`route admission: duplicate task id ${JSON.stringify(route.taskId)}`);
    byTaskId.set(route.taskId, route);
  }
  // The writers in the graph: product routes whose compiled role is writer. G8 judges all of them together.
  const writers = input.routes.filter((route): route is CccCampaignProductRoute =>
    !isReviewIdentity(route) && input.roleOf(route.taskId) === "writer");

  const reasonFor = (route: AdmissionRoute): CccRouteAdmissionReason | null => {
    const identity = classifyCccModelIdentity(route.modelId);
    if (!identity.admitted) return identity.reason;
    if (Object.prototype.hasOwnProperty.call(route, "terminalRouteMembers")) return "combo-route";
    if (route.transport !== "pi") return "transport-not-pi";
    if (route.receiptAdapterId !== RECEIPT_ADAPTER) return "receipt-adapter-required";

    let expectedModel: CccPlanningExactModelId;
    if (!isReviewIdentity(route)) {
      if (input.roleOf(route.taskId) !== "writer") return "role-model-mismatch";
      expectedModel = WRITER_MODEL;
    } else if (route.routeKind === "g7-review") {
      // The identity's own reviewed task must be the graph's, and that task must be a writer route in this set.
      if (input.roleOf(route.taskId) !== "g7-review") return "role-model-mismatch";
      const reviewedTaskId = input.reviewedTaskOf(route.taskId);
      if (route.reviewOfTaskId !== reviewedTaskId) return "role-model-mismatch";
      const reviewed = byTaskId.get(reviewedTaskId);
      if (!reviewed || isReviewIdentity(reviewed) || input.roleOf(reviewed.taskId) !== "writer") return "role-model-mismatch";
      const reviewedFamily = familyOf(reviewed);
      if (reviewedFamily !== null && reviewedFamily === identity.family) return "same-family-review";
      expectedModel = REVIEW_MODEL;
    } else {
      // G8 judges the integrated candidate, so it must differ in family from every writer.
      if (route.reviewOfTaskId !== null) return "role-model-mismatch";
      if (writers.some((writer) => familyOf(writer) === identity.family)) return "same-family-review";
      expectedModel = REVIEW_MODEL;
    }
    if (identity.modelId !== expectedModel) return "role-model-mismatch";
    if (pinnedProviderOf(identity.modelId, input.pins) !== route.providerId) return "provider-not-pinned";
    return null;
  };

  const refusals: CccRouteAdmissionRefusal[] = [];
  for (const route of input.routes) {
    const reason = reasonFor(route);
    if (reason !== null) {
      refusals.push({ code: "CCC_ROUTE_IDENTITY_REJECTED", reason, taskId: route.taskId, observedModelId: route.modelId });
    }
  }
  return refusals;
}
