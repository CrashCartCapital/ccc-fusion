export type GoldenPiDriver = Readonly<{
  key: string;
  displayName: string;
  providerId: string;
  modelId: string;
  effectiveProvider: string;
  effectiveModel: string;
}>;

export const GOLDEN_PI_PROJECT_ENVELOPE = Object.freeze({
  maxRequests: 14,
  maxDurationMs: 600_000,
  maxConcurrency: 1,
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  taskTokenBudget: Object.freeze({ soft: 300_000, hard: 500_000 }),
});

export const GOLDEN_PI_DRIVERS: readonly GoldenPiDriver[] = Object.freeze([
  Object.freeze({
    key: "glm-5.3",
    displayName: "GLM 5.3",
    providerId: "golden-omniroute-glm",
    modelId: "glm/glm-5.3",
    effectiveProvider: "glm",
    effectiveModel: "glm-5.3",
  }),
  Object.freeze({
    key: "gemini-flash-3.7",
    displayName: "Gemini 3.7 Flash High",
    providerId: "golden-omniroute-gemini-flash",
    modelId: "antigravity/gemini-3.7-flash-high",
    effectiveProvider: "antigravity",
    effectiveModel: "gemini-3.7-flash-high",
  }),
  Object.freeze({
    key: "luna-max",
    displayName: "GPT-5.6 Luna Max",
    providerId: "golden-omniroute-luna",
    modelId: "cx/gpt-5.6-luna-max",
    effectiveProvider: "cx",
    effectiveModel: "gpt-5.6-luna-max",
  }),
]);

export function resolveGoldenPiDriver(key: string | undefined): GoldenPiDriver {
  const driver = GOLDEN_PI_DRIVERS.find((candidate) => candidate.key === key);
  if (driver) return driver;
  throw new Error(
    `CCC_GOLDEN_PI_DRIVER must be one of: ${GOLDEN_PI_DRIVERS.map(({ key: candidate }) => candidate).join(", ")}`,
  );
}
