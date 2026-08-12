/**
 * FNXC:CampaignNotifications 2026-08-11-00:00:
 * Classification for the two CCC campaign operator pings (operator decision,
 * 2026-08-11 top-down audit, Lane A). Input is the persisted work-item row from
 * the store's `workitem:transitioned` event — the single funnel that startup
 * recovery parks, provider-dispatch permanent parks, merge-approval waits, and
 * workflow runtime terminal transitions all pass through.
 *
 * Payload discipline: notifications carry machine facts only (identifiers,
 * state, bounded ccc-* reason code). The reason extractor keeps the leading
 * machine token and drops everything after it, so an appended free-text error
 * message (e.g. startup recovery's `<code>: <error.message>` lastError) can
 * never leak into a notification channel.
 */

import type { WorkflowWorkItem } from "@fusion/core";
import { isImportedCccCampaignWorkItem } from "../ccc-campaign-routing.js";

export type CccCampaignWorkItemNotification = Readonly<{
  event: "campaign-needs-decision" | "campaign-failed";
  /** Bounded ccc-* machine code (e.g. `ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED`). */
  reasonCode?: string;
}>;

/*
 * Leading machine token only: `ccc-<lowercase-words>` optionally followed by
 * one `:SCREAMING_SNAKE` code. Matches the repo's park/exhaustion shapes
 * (`ccc-permanent:<CODE>`, `ccc-transient-retry-exhausted[:<CODE>]`) and stops
 * before any free-text suffix.
 */
const CCC_REASON_CODE_PATTERN = /^(ccc-[a-z][a-z0-9-]*(?::[A-Z][A-Z0-9_]*)?)/;

export function extractCccCampaignReasonCode(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return CCC_REASON_CODE_PATTERN.exec(value)?.[1];
}

/**
 * Decide whether a work-item transition is one of the two campaign operator
 * pings. Returns null for everything else — non-campaign parks, non-terminal
 * states, and terminal failures of work items with no campaign evidence.
 */
export function classifyCccCampaignWorkItemNotification(
  workItem: WorkflowWorkItem,
): CccCampaignWorkItemNotification | null {
  const reasonCode = extractCccCampaignReasonCode(workItem.blockedReason)
    ?? extractCccCampaignReasonCode(workItem.lastError);

  if (workItem.state === "manual-required") {
    // The ccc-* machine reason IS the campaign-park marker (requirement 1):
    // generic workflow manual-required holds carry no ccc-* reason and stay quiet.
    return reasonCode ? { event: "campaign-needs-decision", reasonCode } : null;
  }

  if (workItem.state === "failed" || workItem.state === "exhausted") {
    // Campaign evidence: the imported campaign row shape, or a ccc-* machine
    // reason left by the campaign retry/exhaustion machinery.
    if (!isImportedCccCampaignWorkItem(workItem) && reasonCode === undefined) {
      return null;
    }
    return { event: "campaign-failed", ...(reasonCode ? { reasonCode } : {}) };
  }

  return null;
}
