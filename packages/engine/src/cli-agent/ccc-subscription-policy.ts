import type { CliAutonomyPosture } from "@fusion/core";

export const CCC_FUSION_PROFILE = "ccc-fusion";
export const CCC_FUSION_POSTURE_PROFILE_KEY = "cccFusionProfile";
export const CCC_FUSION_POSTURE_MODEL_KEY = "cccFusionModel";

export class CccSubscriptionReadyRequiredError extends Error {
  readonly code = "CCC_SUBSCRIPTION_PREFLIGHT_REQUIRED";

  constructor() {
    super("CCC Fusion subscription readiness must be explicitly true before spawning a child.");
    this.name = "CccSubscriptionReadyRequiredError";
  }
}

const CCC_EXACT_FORBIDDEN_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "FUSION_CLAUDE_ACP_FORWARD_AUTH",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
]);

/*
FNXC:CCCSubscriptionPolicy 2026-07-23-13:15:
Wave 1 admits exactly one positive ccc-fusion profile. Its children must reuse
existing user-session custody while never receiving API-key, auth-token, or
base-route environment variables; ordinary Fusion profiles remain unchanged.
*/
export function isCccFusionProfile(settings: Record<string, unknown> | undefined | null): boolean {
  return settings?.profile === CCC_FUSION_PROFILE;
}

/*
FNXC:CCCSubscriptionReadiness 2026-07-23-14:38:
The ccc-fusion child boundary accepts only subscriptionReady === true, a
structural caller-supplied outcome. It deliberately performs no auth,
credential, or provider probe; recovery persists only profile and model, so
each relaunch must supply current readiness rather than inherit prior success.
*/
export function assertCccFusionSubscriptionReady(settings: { profile?: unknown; subscriptionReady?: unknown } | undefined | null): void {
  if (settings?.profile === CCC_FUSION_PROFILE && settings.subscriptionReady !== true) {
    throw new CccSubscriptionReadyRequiredError();
  }
}

export function isCccForbiddenEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CCC_EXACT_FORBIDDEN_ENV_KEYS.has(normalized)
    || /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY|AUTH[_-]?TOKEN|OAUTH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|BASE[_-]?URL)(?:_|$)/.test(normalized);
}

export function cccFusionEnvAllowlist(allowlist: readonly string[], settings: Record<string, unknown> | undefined | null): string[] {
  return isCccFusionProfile(settings)
    ? allowlist.filter((key) => !isCccForbiddenEnvKey(key))
    : [...allowlist];
}

export function persistCccFusionPosture(
  posture: CliAutonomyPosture | null,
  settings: Record<string, unknown> | undefined | null,
): CliAutonomyPosture | null {
  if (!isCccFusionProfile(settings)) return posture;
  const model = typeof settings?.model === "string" && settings.model.length > 0
    ? settings.model
    : undefined;
  return {
    [CCC_FUSION_POSTURE_PROFILE_KEY]: CCC_FUSION_PROFILE,
    ...(model ? { [CCC_FUSION_POSTURE_MODEL_KEY]: model } : {}),
  };
}

export function restoreCccFusionSettings(
  settings: Record<string, unknown> | undefined | null,
  posture: CliAutonomyPosture | null,
): Record<string, unknown> {
  if (posture?.[CCC_FUSION_POSTURE_PROFILE_KEY] !== CCC_FUSION_PROFILE) {
    return { ...(settings ?? {}) };
  }
  const model = posture[CCC_FUSION_POSTURE_MODEL_KEY];
  return {
    ...(settings ?? {}),
    profile: CCC_FUSION_PROFILE,
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
  };
}

export function redactCccSensitiveText(value: string): string {
  return value
    .replace(/(?:^|[\\/])(?:_KELSEY|_secrets)(?:[\\/][^\s"'`]+)*/gi, "[REDACTED_PROTECTED_PATH]")
    .replace(/("(?:api[_-]?key|auth[_-]?token|oauth[_-]?token|token|secret|password)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?:api[_-]?key|auth[_-]?token|oauth[_-]?token|token|secret|password)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}\]]+)/gi, "$1[REDACTED]")
    .replace(/\bfake[-_](?:secret|token)[-_][a-z0-9_-]+\b/gi, "[REDACTED]");
}
