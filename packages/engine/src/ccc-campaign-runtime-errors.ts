import { CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE } from "@fusion/core";
import { PermanentError } from "./engine-errors.js";

const REQUEST_BUDGET_EXHAUSTED_PREFIX =
  `ccc-permanent:${CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE}: `;

/**
 * Preserve a stable campaign refusal through Pi's string-only session error
 * boundary. The prefix is machine-owned; the trailing message remains useful
 * for local diagnostics without becoming protocol identity.
 */
export function encodeCccCampaignRequestBudgetExhausted(
  error: Error,
): PermanentError {
  return new PermanentError(
    `${REQUEST_BUDGET_EXHAUSTED_PREFIX}${error.message}`,
    CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE,
    undefined,
    error,
  );
}

/** Restore the structured error class after Pi has retained only its message. */
export function decodeCccCampaignPermanentSessionError(
  message: string,
): PermanentError | null {
  if (!message.startsWith(REQUEST_BUDGET_EXHAUSTED_PREFIX)) return null;
  const detail = message.slice(REQUEST_BUDGET_EXHAUSTED_PREFIX.length).trim();
  return new PermanentError(
    detail || "CCC campaign request budget is exhausted",
    CCC_CAMPAIGN_REQUEST_BUDGET_EXHAUSTED_CODE,
  );
}
