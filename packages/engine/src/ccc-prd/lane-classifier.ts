import { CccPrdCustodyError } from "./custody.js";

export type CccPrdLane = "single" | "chunked";
export type CccPrdRequestedLane = "auto" | "single" | "chunked";

export type CccPrdLaneClassifierPolicy = {
  singleShotMaxInventoryItems: number;
  singleShotMaxBytes: number;
};

/** Recommended constants from design §7, fitted to the three packets that measured the ceiling; re-fit after the first real chunked runs. */
export const DEFAULT_CCC_PRD_LANE_CLASSIFIER_POLICY: CccPrdLaneClassifierPolicy = {
  singleShotMaxInventoryItems: 48,
  singleShotMaxBytes: 160 * 1024,
};

export type CccPrdLaneClassificationInput = {
  totalInventoryItems: number;
  totalAuthoritativeBytes: number;
  estimatedPromptTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  requestedLane?: CccPrdRequestedLane;
  policy?: Partial<CccPrdLaneClassifierPolicy>;
};

export type CccPrdLaneClassification = {
  lane: CccPrdLane;
  qualifiesForSingle: boolean;
};

/**
 * Fast-lane classifier (design §7, D-3): inventory-item count x byte budget
 * x context fit. File count is NEVER a criterion -- the frozen acceptance
 * fixture freezes three manifest entries with at least two authoritative, so
 * a file-count rule would route the frozen gate onto the chunked lane.
 */
export function classifyCccPrdLane(input: CccPrdLaneClassificationInput): CccPrdLaneClassification {
  const policy = { ...DEFAULT_CCC_PRD_LANE_CLASSIFIER_POLICY, ...input.policy };
  const qualifiesForSingle = (
    input.totalInventoryItems <= policy.singleShotMaxInventoryItems
    && input.totalAuthoritativeBytes <= policy.singleShotMaxBytes
    && input.estimatedPromptTokens + input.reservedOutputTokens <= input.contextWindow
  );

  const requested = input.requestedLane ?? "auto";
  if (requested === "single" && !qualifiesForSingle) {
    throw new CccPrdCustodyError(
      "CCC_PRD_LANE_SINGLE_NOT_QUALIFIED",
      "--lane single was requested but the packet does not qualify for the single-shot lane "
        + `(items=${input.totalInventoryItems}/${policy.singleShotMaxInventoryItems}, `
        + `bytes=${input.totalAuthoritativeBytes}/${policy.singleShotMaxBytes}, `
        + `tokens=${input.estimatedPromptTokens + input.reservedOutputTokens}/${input.contextWindow})`,
    );
  }

  if (requested === "chunked") {
    return { lane: "chunked", qualifiesForSingle };
  }
  if (requested === "single") {
    return { lane: "single", qualifiesForSingle };
  }
  return { lane: qualifiesForSingle ? "single" : "chunked", qualifiesForSingle };
}
