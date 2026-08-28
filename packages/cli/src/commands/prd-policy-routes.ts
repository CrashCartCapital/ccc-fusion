import type { CccPrdProductExecutionRouteSelection } from "@fusion/core";

export const CCC_PRD_ROUTES_BY_TASK_SCHEMA = "ccc-prd.routes-by-task.v1" as const;

const PRODUCT_POLICY_ROUTE_ENTRY_PI_KEYS = new Set([
  "providerId",
  "modelId",
  "transport",
  "receiptAdapterId",
]);
const PRODUCT_POLICY_ROUTE_ENTRY_CLI_KEYS = new Set([
  "providerId",
  "modelId",
  "transport",
  "cliAdapterId",
]);

export class PrdProductRoutesFileError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrdProductRoutesFileError";
  }
}

export function parseProductPolicyRoutesFileContents(
  raw: string,
  routesFilePath: string,
): Record<string, CccPrdProductExecutionRouteSelection> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_READ_FAILED",
      `routes file ${routesFilePath} is not valid JSON`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} must contain one JSON object`,
    );
  }
  const document = value as Record<string, unknown>;
  const extraTopKeys = Object.keys(document).filter((key) => key !== "schema" && key !== "routes");
  if (extraTopKeys.length > 0) {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} has unknown top-level fields: ${extraTopKeys.join(", ")}`,
    );
  }
  if (document.schema !== CCC_PRD_ROUTES_BY_TASK_SCHEMA) {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} must declare schema ${CCC_PRD_ROUTES_BY_TASK_SCHEMA}`,
    );
  }
  if (
    !document.routes
    || typeof document.routes !== "object"
    || Array.isArray(document.routes)
  ) {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} routes field must be an object keyed by task id`,
    );
  }
  const routesRaw = document.routes as Record<string, unknown>;
  const taskIds = Object.keys(routesRaw);
  if (taskIds.length === 0) {
    throw new PrdProductRoutesFileError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} routes must declare at least one task route`,
    );
  }
  const routesByTaskId: Record<string, CccPrdProductExecutionRouteSelection> = {};
  for (const taskId of taskIds) {
    const entry = routesRaw[taskId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PrdProductRoutesFileError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} must be an object`,
      );
    }
    const route = entry as Record<string, unknown>;
    const transport = route.transport;
    const allowedKeys = transport === "cli"
      ? PRODUCT_POLICY_ROUTE_ENTRY_CLI_KEYS
      : PRODUCT_POLICY_ROUTE_ENTRY_PI_KEYS;
    const unknownKeys = Object.keys(route).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new PrdProductRoutesFileError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} has unknown fields: ${unknownKeys.join(", ")}`,
      );
    }
    const providerId = route.providerId;
    const modelId = route.modelId;
    const cliAdapterId = route.cliAdapterId;
    const receiptAdapterId = route.receiptAdapterId;
    if (
      typeof providerId !== "string"
      || providerId.length === 0
      || typeof modelId !== "string"
      || modelId.length === 0
      || (transport !== "pi" && transport !== "cli")
      || (transport === "cli" && (typeof cliAdapterId !== "string" || cliAdapterId.length === 0))
      || (transport === "pi" && cliAdapterId !== undefined)
      || (transport === "cli" && receiptAdapterId !== undefined)
      || (
        receiptAdapterId !== undefined
        && receiptAdapterId !== "terminal-route-sse-comments.v1"
      )
    ) {
      throw new PrdProductRoutesFileError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} must declare providerId, modelId, and transport pi|cli (cliAdapterId is required only for cli transport)`,
      );
    }
    routesByTaskId[taskId] = {
      providerId,
      modelId,
      transport,
      ...(transport === "cli" ? { cliAdapterId: cliAdapterId as string } : {}),
      ...(receiptAdapterId === "terminal-route-sse-comments.v1"
        ? { receiptAdapterId }
        : {}),
    };
  }
  return routesByTaskId;
}
