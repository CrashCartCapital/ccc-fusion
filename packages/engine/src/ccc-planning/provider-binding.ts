import {
  CccProviderAttemptIdentityError,
  type CccCampaignProviderDispatchInput,
  type CccPlanningCallScope,
  type CccPlanningRouteBinding,
} from "@fusion/core";
import type {
  CccProviderAttemptBinding,
  CccProviderAttemptController,
  CccProviderAttemptSettlementInputOf,
  CccSessionToolPolicy,
} from "../agent-runtime.js";
import { attachCccProviderAttemptBoundRoute } from "../pi.js";

/*
FNXC:CccPlanningProviderBinding 2026-10-14-14:50:
A planning session is bound to exactly one route: the provider, model and transport of its planning route binding (CONTRACT-v3 section 2.12). The binding's controller refuses any dispatch that names another route with a `route-drift` identity error before the planning controller sees it, so a swapped model never reserves a call. The bound route is also recorded on the frozen controller under a symbol key, so Pi can refuse at session creation a session whose default provider is not the bound provider (D48); a symbol key leaves the controller's own keys exactly `preDispatch` and `reconcile`, as Pi's binding validation requires.
*/
/*
FNXC:CccPlanningProviderBinding 2026-10-14-17:37:
Repair 1 (errata E5-P1 item 9). The recorded route also carries the route binding's role class and toolset digest, so session creation can refuse a tool policy that was not issued for this binding. Only the provider, model and transport take part in the route-drift check.
*/
/*
FNXC:CccPlanningProviderBinding 2026-10-14-18:43:
Repair 2 (errata E7-P item 7). The route is recorded through attachCccProviderAttemptBoundRoute, the one writer of the bound-route marker, which card WR also uses for a linked writer's controller.
*/
export function createCccPlanningProviderAttemptBinding(i: Readonly<{
  controller: CccProviderAttemptController<CccPlanningCallScope>;
  binding: CccPlanningRouteBinding;
  turnKey: string;
  toolPolicy: CccSessionToolPolicy;
}>): CccProviderAttemptBinding<CccPlanningCallScope> {
  const inner = i.controller;
  const route = Object.freeze({
    providerId: i.binding.providerId,
    modelId: i.binding.modelId,
    transport: i.binding.transport,
    roleClass: i.binding.roleClass,
    toolsetDigest: i.binding.toolsetDigest,
  });
  const controller = attachCccProviderAttemptBoundRoute<CccPlanningCallScope>(Object.freeze({
    preDispatch: async (input: CccCampaignProviderDispatchInput) => {
      if (input.providerId !== route.providerId || input.modelId !== route.modelId || input.transport !== route.transport) {
        throw new CccProviderAttemptIdentityError(
          "route-drift",
          `ccc-fusion planning dispatch ${input.providerId}/${input.modelId} over ${input.transport} `
          + `does not match the bound route ${route.providerId}/${route.modelId} over ${route.transport}`,
        );
      }
      return inner.preDispatch(input);
    },
    reconcile: (input: CccProviderAttemptSettlementInputOf<CccPlanningCallScope>) => inner.reconcile(input),
  }), route);
  return Object.freeze({
    turnKey: i.turnKey,
    controller,
    receiptAdapterId: i.binding.receiptAdapterId,
    scopeKind: "planning" as const,
    toolPolicy: i.toolPolicy,
  });
}
