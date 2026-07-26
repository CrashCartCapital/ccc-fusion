import {
  atomicReserveCccCampaignProviderDispatch,
  type CccCampaignAuthorityStore,
  type CccCampaignProviderControllerDecision,
  type AtomicCccCampaignProviderDispatchInput,
  type AsyncDataLayer,
} from "@fusion/core";
import { recheckCccCampaignLocalGit, type CccCampaignLocalGitSnapshot } from "./ccc-campaign-local-git.js";

export type CccCampaignEngineProviderControllerInput = Readonly<{
  initialGitSnapshot: CccCampaignLocalGitSnapshot;
  signal?: AbortSignal;
  preDispatch: Omit<AtomicCccCampaignProviderDispatchInput, "layer" | "authorityStore" | "gitObservation"> & {
    layer: AsyncDataLayer;
    authorityStore: CccCampaignAuthorityStore;
  };
}>;

/** Rechecks the immutable initial Git observation before obtaining a one-shot core permit. */
export async function preDispatchCccCampaignProviderFromEngine(
  input: CccCampaignEngineProviderControllerInput,
): Promise<CccCampaignProviderControllerDecision> {
  const rechecked = await recheckCccCampaignLocalGit(input.initialGitSnapshot, input.signal);
  input.signal?.throwIfAborted();
  return atomicReserveCccCampaignProviderDispatch({
    ...input.preDispatch,
    gitObservation: Object.freeze({ targetRoot: rechecked.targetRoot, expectedBaseObject: rechecked.expectedBaseObject, head: rechecked.head, headDescendsFromExpectedBase: true }),
  });
}
