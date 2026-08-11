import { describe, expect, it } from "vitest";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";
import {
  classifyCccPrdLane,
  DEFAULT_CCC_PRD_LANE_CLASSIFIER_POLICY,
} from "../ccc-prd/lane-classifier.js";

describe("classifyCccPrdLane", () => {
  it("test 55: a fixture-sized packet classifies lane === \"single\"", () => {
    const classification = classifyCccPrdLane({
      totalInventoryItems: 12,
      totalAuthoritativeBytes: 20_000,
      estimatedPromptTokens: 5_000,
      reservedOutputTokens: 2_000,
      contextWindow: 65_536,
    });
    expect(classification.lane).toBe("single");
    expect(classification.qualifiesForSingle).toBe(true);
  });

  it("classifies a packet over the inventory-item ceiling as chunked (auto), never by file count", () => {
    const classification = classifyCccPrdLane({
      totalInventoryItems: 88, // the measured cqw ceiling
      totalAuthoritativeBytes: 20_000,
      estimatedPromptTokens: 5_000,
      reservedOutputTokens: 2_000,
      contextWindow: 65_536,
    });
    expect(classification.lane).toBe("chunked");
    expect(classification.qualifiesForSingle).toBe(false);
  });

  it("classifies a packet over the byte budget as chunked even with few inventory items", () => {
    const classification = classifyCccPrdLane({
      totalInventoryItems: 5,
      totalAuthoritativeBytes: 200 * 1024,
      estimatedPromptTokens: 5_000,
      reservedOutputTokens: 2_000,
      contextWindow: 65_536,
    });
    expect(classification.lane).toBe("chunked");
  });

  it("classifies a packet that would overflow the route's context window as chunked", () => {
    const classification = classifyCccPrdLane({
      totalInventoryItems: 5,
      totalAuthoritativeBytes: 10_000,
      estimatedPromptTokens: 60_000,
      reservedOutputTokens: 10_000,
      contextWindow: 65_536,
    });
    expect(classification.lane).toBe("chunked");
  });

  it("test 56: --lane single on a non-qualifying packet refuses", () => {
    expect(() => classifyCccPrdLane({
      totalInventoryItems: 88,
      totalAuthoritativeBytes: 20_000,
      estimatedPromptTokens: 5_000,
      reservedOutputTokens: 2_000,
      contextWindow: 65_536,
      requestedLane: "single",
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_LANE_SINGLE_NOT_QUALIFIED" }));
  });

  it("--lane chunked on a qualifying (small) packet is always allowed", () => {
    const classification = classifyCccPrdLane({
      totalInventoryItems: 5,
      totalAuthoritativeBytes: 5_000,
      estimatedPromptTokens: 1_000,
      reservedOutputTokens: 500,
      contextWindow: 65_536,
      requestedLane: "chunked",
    });
    expect(classification.lane).toBe("chunked");
    expect(classification.qualifiesForSingle).toBe(true);
  });

  it("uses the documented default fast-lane thresholds when none are supplied", () => {
    expect(DEFAULT_CCC_PRD_LANE_CLASSIFIER_POLICY.singleShotMaxInventoryItems).toBe(48);
    expect(DEFAULT_CCC_PRD_LANE_CLASSIFIER_POLICY.singleShotMaxBytes).toBe(160 * 1024);
  });

  it("CccPrdCustodyError carries the code used for programmatic dispatch", () => {
    try {
      classifyCccPrdLane({
        totalInventoryItems: 100,
        totalAuthoritativeBytes: 1,
        estimatedPromptTokens: 1,
        reservedOutputTokens: 1,
        contextWindow: 1000,
        requestedLane: "single",
      });
      throw new Error("expected classifyCccPrdLane to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CccPrdCustodyError);
    }
  });
});
