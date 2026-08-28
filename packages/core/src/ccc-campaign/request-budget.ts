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

export function cccCampaignRequestFloor(providerTasks: number): number {
  return providerTasks * CCC_CAMPAIGN_REQUESTS_PER_PROVIDER_TASK_FLOOR;
}
