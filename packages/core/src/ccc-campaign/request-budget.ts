export const CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE =
  "CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED" as const;

export const CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_REASON =
  `ccc-permanent:${CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE}` as const;

export const CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR =
  "CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR" as const;

/**
 * Each provider task's executor phase machine guarantees exactly one MUTATE
 * turn plus exactly one REPAIR turn, so every admitted provider task costs a
 * minimum of two requests. This is a structural admission floor derived from
 * the phase machine, not an adequacy guarantee — live runs commonly cost
 * 9-13 requests per task.
 */
export const CCC_CAMPAIGN_REQUESTS_PER_PROVIDER_TASK_FLOOR = 2 as const;

/**
 * Finite starting guidance for useful project work. This deliberately sits
 * above the structural admission floor without changing admission or safety
 * ceilings: operators may size a packet differently when task evidence says
 * they should.
 */
export const CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK = 384 as const;

export function cccCampaignRequestFloor(providerTasks: number): number {
  return providerTasks * CCC_CAMPAIGN_REQUESTS_PER_PROVIDER_TASK_FLOOR;
}

export function cccCampaignRecommendedStartingMaximum(
  providerTasks: number,
): number {
  return providerTasks * CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK;
}

export function cccCampaignRequestSizingGuidance(
  providerTasks: number,
  maximum: number,
): Readonly<{
  recommendedStartingMaximum: number;
  headroomAboveRecommendation: number;
  sizingPosture: "tight" | "generous";
}> {
  const recommendedStartingMaximum =
    cccCampaignRecommendedStartingMaximum(providerTasks);
  const headroomAboveRecommendation = maximum - recommendedStartingMaximum;
  return {
    recommendedStartingMaximum,
    headroomAboveRecommendation,
    sizingPosture: headroomAboveRecommendation >= 0 ? "generous" : "tight",
  };
}
