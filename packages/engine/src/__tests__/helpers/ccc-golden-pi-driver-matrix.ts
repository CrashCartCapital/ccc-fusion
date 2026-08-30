export type GoldenPiDriver = Readonly<{
  key: string;
  displayName: string;
  providerId: string;
  modelId: string;
  comboAlias: string;
  attributionTerminalRouteMembers: readonly Readonly<{ provider: string; model: string }>[];
}>;

export const GOLDEN_PI_PROJECT_ENVELOPE = Object.freeze({
  taskCount: 3,
  maxRequests: 1_152,
  maxDurationMs: 10_800_000,
  maxConcurrency: 1,
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  taskTokenBudget: Object.freeze({ soft: 5_000_000, hard: 10_000_000 }),
});

export const GOLDEN_PI_DRIVERS: readonly GoldenPiDriver[] = Object.freeze([
  Object.freeze({
    key: "minimax-latest",
    displayName: "MiniMax Latest",
    providerId: "golden-omniroute-minimax-latest",
    modelId: "combo/minimax-latest",
    comboAlias: "minimax-latest",
    attributionTerminalRouteMembers: Object.freeze([
      Object.freeze({ provider: "minimax", model: "MiniMax-M3" }),
    ]),
  }),
  Object.freeze({
    key: "glm-latest",
    displayName: "GLM Latest",
    providerId: "golden-omniroute-glm-latest",
    modelId: "combo/glm-latest",
    comboAlias: "glm-latest",
    attributionTerminalRouteMembers: Object.freeze([
      Object.freeze({ provider: "glm", model: "glm-5.3" }),
    ]),
  }),
  Object.freeze({
    key: "gemini-flash-latest",
    displayName: "Gemini Flash Latest",
    providerId: "golden-omniroute-gemini-flash-latest",
    modelId: "combo/gemini-flash-latest",
    comboAlias: "gemini-flash-latest",
    attributionTerminalRouteMembers: Object.freeze([
      Object.freeze({ provider: "antigravity", model: "gemini-3.7-flash-high" }),
      Object.freeze({ provider: "gemini", model: "gemini-flash-latest" }),
    ]),
  }),
]);

export function resolveGoldenPiDriver(key: string | undefined): GoldenPiDriver {
  const driver = GOLDEN_PI_DRIVERS.find((candidate) => candidate.key === key);
  if (driver) return driver;
  throw new Error(
    `CCC_GOLDEN_PI_DRIVER must be one of: ${GOLDEN_PI_DRIVERS.map(({ key: candidate }) => candidate).join(", ")}`,
  );
}
