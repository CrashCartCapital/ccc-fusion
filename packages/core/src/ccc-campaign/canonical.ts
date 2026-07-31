import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "../ccc-prd/contract.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
  CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
  CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
  CccCampaignContextError,
  type CccCampaignActionLookup,
  type CccCampaignAuthorityBinding,
  type CccCampaignContext,
  type CccCampaignExecutionPolicy,
  type CccCampaignExecutionRoute,
  type CccCampaignManifest,
  type CccCampaignProductExecutionPolicy,
  type CccCampaignProductExecutionRoute,
  type CccCampaignTransport,
} from "./types.js";

const ROUTE_KEYS = ["modelId", "providerId", "taskId", "transport"] as const;
const WORKFLOW_ROUTE_KEYS = [...ROUTE_KEYS, "workflowExtensionId"] as const;
const PRODUCT_ROUTE_KEYS = [
  "allowedWriteRoots",
  "commitPolicy",
  "executor",
  "modelId",
  "ownedPaths",
  "providerId",
  "taskId",
  "toolMode",
  "transport",
  "worktreeMode",
] as const;
const PRODUCT_CLI_ROUTE_KEYS = [...PRODUCT_ROUTE_KEYS, "cliAdapterId"] as const;
const POLICY_KEYS = ["routes", "schema"] as const;
const AUTHORITY_BINDING_KEYS = [
  "actionId",
  "actionTarget",
  "bindingHash",
  "bundleHash",
  "campaignId",
  "idempotencyKey",
  "importId",
  "manifestHash",
  "modelId",
  "packetHash",
  "projectId",
  "providerId",
  "sidecarHash",
  "targetBase",
  "targetRepository",
  "taskId",
  "transport",
] as const;
const TRANSPORTS = new Set<CccCampaignTransport>(["pi", "cli", "workflow"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const WORKFLOW_EXTENSION_REGISTRY_ID_PATTERN = /^plugin:[a-z0-9]([a-z0-9-]*[a-z0-9])?:[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export class CccCampaignExecutionPolicyError extends Error {
  public readonly code = "CCC_PRD_EXECUTION_ROUTE_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignExecutionPolicyError";
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort(compareCccPrdCodeUnits);
  const canonicalExpected = [...expected].sort(compareCccPrdCodeUnits);
  if (canonicalCccPrdJson(observed) !== canonicalCccPrdJson(canonicalExpected)) {
    throw new CccCampaignExecutionPolicyError(
      `${label} fields must be exactly ${canonicalExpected.join(", ")}; received ${observed.join(", ") || "none"}`,
    );
  }
}

function exactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new CccCampaignExecutionPolicyError(
      `${label} must be a non-empty canonical identifier`,
    );
  }
  return value;
}

function parseRoute(value: unknown, index: number): CccCampaignExecutionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  const transport = exactIdentifier(
    route.transport,
    `CCC campaign execution route ${index} transport`,
  );
  if (!TRANSPORTS.has(transport as CccCampaignTransport)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} has unsupported transport ${JSON.stringify(transport)}`,
    );
  }
  const isWorkflowTransport = transport === "workflow";
  if (!isWorkflowTransport && Object.prototype.hasOwnProperty.call(route, "workflowExtensionId")) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} workflowExtensionId is forbidden for ${transport} transport`,
    );
  }
  if (isWorkflowTransport) {
    exactWorkflowExtensionRegistryId(route.workflowExtensionId, index);
  }
  exactKeys(
    route,
    isWorkflowTransport ? WORKFLOW_ROUTE_KEYS : ROUTE_KEYS,
    `CCC campaign execution route ${index}`,
  );
  const workflowExtensionId = isWorkflowTransport ? route.workflowExtensionId as string : undefined;
  return {
    taskId: exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`),
    providerId: exactIdentifier(
      route.providerId,
      `CCC campaign execution route ${index} providerId`,
    ),
    modelId: exactIdentifier(route.modelId, `CCC campaign execution route ${index} modelId`),
    transport: transport as CccCampaignTransport,
    ...(workflowExtensionId ? { workflowExtensionId } : {}),
  };
}

function exactTargetRelativePaths(
  value: unknown,
  index: number,
  field: "ownedPaths" | "allowedWriteRoots",
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} ${field} must be a non-empty array of canonical target-relative paths`,
    );
  }
  const paths = value.map((candidate, pathIndex) => {
    if (
      typeof candidate !== "string"
      || candidate.length === 0
      || candidate !== candidate.trim()
      || candidate.includes("\\")
      || candidate.includes("\0")
      || isAbsolute(candidate)
      || candidate === "."
      || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} ${field}[${pathIndex}] must be a canonical target-relative path`,
      );
    }
    return candidate;
  });
  if (new Set(paths).size !== paths.length) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} ${field} must not contain duplicates`,
    );
  }
  return paths;
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function filesystemPathContains(parent: string, child: string): boolean {
  const descendant = relative(parent, child);
  return descendant === ""
    || (descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function parseProductRoute(
  value: unknown,
  index: number,
  bundle: Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">,
): CccCampaignProductExecutionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} must be an object`,
    );
  }
  const route = value as Record<string, unknown>;
  const transport = exactIdentifier(
    route.transport,
    `CCC campaign execution route ${index} transport`,
  );
  if (transport !== "pi" && transport !== "cli") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} product transport must be pi or cli`,
    );
  }
  exactKeys(
    route,
    transport === "cli" ? PRODUCT_CLI_ROUTE_KEYS : PRODUCT_ROUTE_KEYS,
    `CCC campaign execution route ${index}`,
  );
  const executor = exactIdentifier(
    route.executor,
    `CCC campaign execution route ${index} executor`,
  );
  if (transport === "pi" && executor !== "model") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} pi transport requires executor model`,
    );
  }
  if (transport === "cli" && executor !== "cli-agent") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} cli transport requires executor cli-agent`,
    );
  }
  if (route.toolMode !== "coding") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} toolMode must be coding`,
    );
  }
  if (route.worktreeMode !== "isolated") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} worktreeMode must be isolated`,
    );
  }
  if (route.commitPolicy !== "required") {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} commitPolicy must be required`,
    );
  }
  const ownedPaths = exactTargetRelativePaths(route.ownedPaths, index, "ownedPaths");
  const allowedWriteRoots = exactTargetRelativePaths(
    route.allowedWriteRoots,
    index,
    "allowedWriteRoots",
  );
  for (const allowedRoot of allowedWriteRoots) {
    if (!ownedPaths.some((ownedPath) => pathContains(ownedPath, allowedRoot))) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside task ownership`,
      );
    }
    const absoluteAllowedRoot = resolve(bundle.targetRepository.path, allowedRoot);
    if (
      !bundle.admittedWriteRoots.some(({ path }) =>
        filesystemPathContains(resolve(path), absoluteAllowedRoot))
    ) {
      throw new CccCampaignExecutionPolicyError(
        `CCC campaign execution route ${index} allowedWriteRoots path ${JSON.stringify(allowedRoot)} is outside PRD-admitted write roots`,
      );
    }
  }
  return {
    taskId: exactIdentifier(route.taskId, `CCC campaign execution route ${index} taskId`),
    providerId: exactIdentifier(
      route.providerId,
      `CCC campaign execution route ${index} providerId`,
    ),
    modelId: exactIdentifier(route.modelId, `CCC campaign execution route ${index} modelId`),
    transport,
    executor: executor as CccCampaignProductExecutionRoute["executor"],
    toolMode: "coding",
    worktreeMode: "isolated",
    ownedPaths,
    allowedWriteRoots,
    commitPolicy: "required",
    ...(transport === "cli"
      ? {
        cliAdapterId: exactIdentifier(
          route.cliAdapterId,
          `CCC campaign execution route ${index} cliAdapterId`,
        ),
      }
      : {}),
  };
}

function exactWorkflowExtensionRegistryId(value: unknown, index: number): string {
  if (typeof value !== "string" || value !== value.trim() || !WORKFLOW_EXTENSION_REGISTRY_ID_PATTERN.test(value)) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution route ${index} workflowExtensionId must be a non-empty canonical registry ID`,
    );
  }
  return value;
}

function assertCompleteRouteSet(
  routes: CccCampaignExecutionRoute[],
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): void {
  const routeIds = routes.map(({ taskId }) => taskId);
  const duplicateIds = routeIds.filter((id, index) => routeIds.indexOf(id) !== index);
  const expectedIds = bundle.tasks.map(({ id }) => id).sort(compareCccPrdCodeUnits);
  const observedIds = [...new Set(routeIds)].sort(compareCccPrdCodeUnits);
  const missing = expectedIds.filter((id) => !observedIds.includes(id));
  const extra = observedIds.filter((id) => !expectedIds.includes(id));
  if (
    duplicateIds.length > 0
    || missing.length > 0
    || extra.length > 0
    || routes.length !== expectedIds.length
  ) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign routes must bind every task exactly once; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; duplicate=${[...new Set(duplicateIds)].sort(compareCccPrdCodeUnits).join(",") || "none"}`,
    );
  }
}

function taskDependsOn(
  taskId: string,
  dependencyId: string,
  tasks: ReadonlyMap<string, Pick<CccPrdSemanticBundle["tasks"][number], "dependencyTaskIds">>,
  visited = new Set<string>(),
): boolean {
  if (taskId === dependencyId) return true;
  if (visited.has(taskId)) return false;
  visited.add(taskId);
  const task = tasks.get(taskId);
  if (!task) return false;
  return task.dependencyTaskIds.some((candidate) =>
    candidate === dependencyId || taskDependsOn(candidate, dependencyId, tasks, visited));
}

function assertConcurrentOwnershipDoesNotOverlap(
  routes: CccCampaignProductExecutionRoute[],
  bundle: Pick<CccPrdSemanticBundle, "tasks">,
): void {
  const tasks = new Map(bundle.tasks.map((task) => [task.id, task]));
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex]!;
      if (
        taskDependsOn(left.taskId, right.taskId, tasks)
        || taskDependsOn(right.taskId, left.taskId, tasks)
      ) {
        continue;
      }
      const overlap = left.ownedPaths.find((leftPath) =>
        right.ownedPaths.some((rightPath) =>
          pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)));
      if (overlap) {
        throw new CccCampaignExecutionPolicyError(
          `CCC campaign concurrently runnable tasks ${left.taskId} and ${right.taskId} have overlapping ownership at ${overlap}`,
        );
      }
    }
  }
}

type CccCampaignExecutionPolicyBundle = Pick<CccPrdSemanticBundle, "tasks">
  & Partial<Pick<CccPrdSemanticBundle, "admittedWriteRoots" | "targetRepository">>;

export function parseCccCampaignExecutionPolicy(
  value: unknown,
  bundle: CccCampaignExecutionPolicyBundle,
): CccCampaignExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (
    policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION
    && policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION
  ) {
    throw new CccCampaignExecutionPolicyError(
      `CCC campaign execution policy schema must be ${CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION} or ${CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  if (policy.schema === CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION) {
    if (!bundle.admittedWriteRoots || !bundle.targetRepository) {
      throw new CccCampaignExecutionPolicyError(
        "CCC campaign execution-policy v2 requires target repository and admitted write roots",
      );
    }
    return parseCccCampaignProductExecutionPolicy(policy, {
      tasks: bundle.tasks,
      admittedWriteRoots: bundle.admittedWriteRoots,
      targetRepository: bundle.targetRepository,
    });
  }
  const routes = policy.routes.map(parseRoute);
  assertCompleteRouteSet(routes, bundle);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

export function parseCccCampaignProductExecutionPolicy(
  value: unknown,
  bundle: Pick<
    CccPrdSemanticBundle,
    "tasks" | "admittedWriteRoots" | "targetRepository"
  >,
): CccCampaignProductExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC PRD product import requires a versioned execution policy",
    );
  }
  const policy = value as Record<string, unknown>;
  exactKeys(policy, POLICY_KEYS, "CCC campaign execution policy");
  if (policy.schema !== CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION) {
    throw new CccCampaignExecutionPolicyError(
      `CCC PRD product import requires ${CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(policy.routes)) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign execution policy routes must be an array",
    );
  }
  const routes = policy.routes.map((route, index) => parseProductRoute(route, index, bundle));
  assertCompleteRouteSet(routes, bundle);
  assertConcurrentOwnershipDoesNotOverlap(routes, bundle);
  return {
    schema: CCC_CAMPAIGN_EXECUTION_POLICY_V2_SCHEMA_VERSION,
    routes: routes.sort((left, right) => compareCccPrdCodeUnits(left.taskId, right.taskId)),
  };
}

export function createCccCampaignManifest(input: {
  projectId: string;
  importId: string;
  idempotencyKey: string;
  campaignId: string;
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  targetRepositoryPath: string;
  campaignStartedAt: string;
}): CccCampaignManifest {
  const startedAt = Date.parse(input.campaignStartedAt);
  if (
    !Number.isFinite(startedAt)
    || new Date(startedAt).toISOString() !== input.campaignStartedAt
  ) {
    throw new CccCampaignExecutionPolicyError(
      "CCC campaign start must be a canonical ISO timestamp",
    );
  }
  return {
    schema: CCC_CAMPAIGN_MANIFEST_SCHEMA_VERSION,
    projectId: input.projectId,
    importId: input.importId,
    idempotencyKey: input.idempotencyKey,
    campaignId: input.campaignId,
    packetHash: input.bundle.sourceHash,
    sidecarHash: input.bundle.sidecarHash,
    bundleHash: input.bundle.bundleHash,
    sourceVersion: input.bundle.sourceVersion,
    targetRepository: {
      path: resolve(input.targetRepositoryPath),
      baseCommit: input.bundle.targetRepository.baseCommit,
    },
    bounds: { ...input.bundle.bounds },
    campaignStartedAt: input.campaignStartedAt,
    campaignDeadlineAt: new Date(
      startedAt + input.bundle.bounds.maxDurationMs,
    ).toISOString(),
    admittedWriteRoots: input.bundle.admittedWriteRoots.map((root) => ({ ...root })),
    proofs: input.bundle.proofs.map((proof) => ({
      ...proof,
      requirementIds: [...proof.requirementIds],
      negativeControls: [...proof.negativeControls],
      spans: proof.spans.map((span) => ({ ...span })),
    })),
    protectedActions: input.bundle.protectedActions.map((action) => ({
      ...action,
      spans: action.spans.map((span) => ({ ...span })),
    })),
    executionPolicy: {
      schema: input.executionPolicy.schema,
      routes: input.executionPolicy.routes.map((route) => ({ ...route })),
    },
  };
}

export function hashCccCampaignManifest(manifest: CccCampaignManifest): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(manifest), "utf8")
    .digest("hex");
}

function requireAuthorityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CccCampaignContextError(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireAuthorityHash(value: unknown, label: string): string {
  const hash = requireAuthorityText(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new CccCampaignContextError(`${label} must be a lowercase SHA-256 hash`);
  }
  return hash;
}

function requireAuthorityTransport(value: unknown): CccCampaignTransport {
  if (typeof value !== "string" || !TRANSPORTS.has(value as CccCampaignTransport)) {
    throw new CccCampaignContextError("campaign route transport is invalid");
  }
  return value as CccCampaignTransport;
}

function requireAuthorityContext(
  context: CccCampaignContext,
): Omit<CccCampaignAuthorityBinding, "actionId" | "actionTarget" | "bindingHash"> {
  if (!context || typeof context !== "object") {
    throw new CccCampaignContextError("CCC campaign context is missing");
  }
  if (context.schema !== CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION) {
    throw new CccCampaignContextError("CCC campaign context schema is invalid");
  }
  if (!context.targetRepository || typeof context.targetRepository !== "object") {
    throw new CccCampaignContextError("CCC campaign context target repository is missing");
  }
  if (!context.route || typeof context.route !== "object") {
    throw new CccCampaignContextError("CCC campaign context execution route is missing");
  }
  const taskId = requireAuthorityText(context.taskId, "campaign taskId");
  const semanticTaskId = "semanticTaskId" in context
    ? requireAuthorityText(context.semanticTaskId, "campaign semanticTaskId")
    : taskId;
  const routeTaskId = requireAuthorityText(
    context.route.taskId,
    "campaign route taskId",
  );
  if (routeTaskId !== semanticTaskId) {
    throw new CccCampaignContextError(
      `CCC campaign route taskId ${routeTaskId} does not match campaign semanticTaskId ${semanticTaskId} (native taskId ${taskId})`,
    );
  }
  return {
    projectId: requireAuthorityText(context.projectId, "campaign projectId"),
    importId: requireAuthorityText(context.importId, "campaign importId"),
    campaignId: requireAuthorityText(context.campaignId, "campaign campaignId"),
    taskId,
    idempotencyKey: requireAuthorityText(
      context.idempotencyKey,
      "campaign idempotencyKey",
    ),
    packetHash: requireAuthorityHash(context.packetHash, "campaign packetHash"),
    sidecarHash: requireAuthorityHash(context.sidecarHash, "campaign sidecarHash"),
    bundleHash: requireAuthorityHash(context.bundleHash, "campaign bundleHash"),
    targetRepository: requireAuthorityText(
      context.targetRepository.path,
      "campaign targetRepository",
    ),
    targetBase: requireAuthorityText(
      context.targetRepository.baseCommit,
      "campaign targetBase",
    ),
    providerId: requireAuthorityText(context.route.providerId, "campaign providerId"),
    modelId: requireAuthorityText(context.route.modelId, "campaign modelId"),
    transport: requireAuthorityTransport(context.route.transport),
    manifestHash: requireAuthorityHash(context.manifestHash, "campaign manifestHash"),
  };
}

function protectedActionFor(
  context: CccCampaignContext,
  actionId: string,
): { id: string; target: string } | undefined {
  if (!Array.isArray(context.protectedActions)) {
    throw new CccCampaignContextError("CCC campaign protected actions are missing");
  }
  const matches = context.protectedActions.filter((action) => {
    if (!action || typeof action !== "object") {
      throw new CccCampaignContextError("CCC campaign protected action is invalid");
    }
    const id = requireAuthorityText(action.id, "campaign protected action id");
    requireAuthorityText(action.target, `campaign protected action ${id} target`);
    return id === actionId;
  });
  if (matches.length > 1) {
    throw new CccCampaignContextError(
      `CCC campaign protected action ${actionId} is declared more than once`,
    );
  }
  return matches[0];
}

export function assertCccCampaignAuthorityBinding(
  binding: CccCampaignAuthorityBinding,
): CccCampaignAuthorityBinding {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new CccCampaignContextError("CCC campaign authority binding is missing");
  }
  const record = binding as Record<string, unknown>;
  const observedKeys = Object.keys(record).sort(compareCccPrdCodeUnits);
  const expectedKeys = [...AUTHORITY_BINDING_KEYS].sort(compareCccPrdCodeUnits);
  if (canonicalCccPrdJson(observedKeys) !== canonicalCccPrdJson(expectedKeys)) {
    throw new CccCampaignContextError(
      `CCC campaign authority binding fields must be exactly ${expectedKeys.join(", ")}`,
    );
  }
  const fields = {
    projectId: requireAuthorityText(record.projectId, "campaign binding projectId"),
    importId: requireAuthorityText(record.importId, "campaign binding importId"),
    campaignId: requireAuthorityText(record.campaignId, "campaign binding campaignId"),
    taskId: requireAuthorityText(record.taskId, "campaign binding taskId"),
    actionId: requireAuthorityText(record.actionId, "campaign binding actionId"),
    actionTarget: requireAuthorityText(record.actionTarget, "campaign binding actionTarget"),
    idempotencyKey: requireAuthorityText(
      record.idempotencyKey,
      "campaign binding idempotencyKey",
    ),
    packetHash: requireAuthorityHash(record.packetHash, "campaign binding packetHash"),
    sidecarHash: requireAuthorityHash(record.sidecarHash, "campaign binding sidecarHash"),
    bundleHash: requireAuthorityHash(record.bundleHash, "campaign binding bundleHash"),
    targetRepository: requireAuthorityText(
      record.targetRepository,
      "campaign binding targetRepository",
    ),
    targetBase: requireAuthorityText(record.targetBase, "campaign binding targetBase"),
    providerId: requireAuthorityText(record.providerId, "campaign binding providerId"),
    modelId: requireAuthorityText(record.modelId, "campaign binding modelId"),
    transport: requireAuthorityTransport(record.transport),
    manifestHash: requireAuthorityHash(record.manifestHash, "campaign binding manifestHash"),
  };
  const bindingHash = requireAuthorityHash(record.bindingHash, "campaign binding bindingHash");
  const expectedHash = createHash("sha256")
    .update(canonicalCccPrdJson(fields), "utf8")
    .digest("hex");
  if (bindingHash !== expectedHash) {
    throw new CccCampaignContextError("CCC campaign authority binding hash does not match its fields");
  }
  return { ...fields, bindingHash };
}

export function createCccCampaignAuthorityBinding(
  context: CccCampaignContext,
  action: CccCampaignActionLookup,
): CccCampaignAuthorityBinding {
  const bindingContext = requireAuthorityContext(context);
  if (!action || typeof action !== "object") {
    throw new CccCampaignContextError("CCC campaign action lookup is missing");
  }
  const actionId = requireAuthorityText(action.actionId, "CCC campaign actionId");
  const actionTarget = requireAuthorityText(
    action.actionTarget,
    "CCC campaign actionTarget",
  );
  if (action.requireProtected !== undefined && typeof action.requireProtected !== "boolean") {
    throw new CccCampaignContextError("CCC campaign requireProtected must be a boolean");
  }
  const protectedAction = protectedActionFor(context, actionId);
  if (protectedAction && protectedAction.target !== actionTarget) {
    throw new CccCampaignContextError(
      `CCC campaign protected action ${actionId} target must match exactly`,
    );
  }
  if (action.requireProtected === true && !protectedAction) {
    throw new CccCampaignContextError(
      `CCC campaign action ${actionId} is not a declared protected action`,
    );
  }
  const fields = {
    ...bindingContext,
    actionId,
    actionTarget,
  };
  return assertCccCampaignAuthorityBinding({
    ...fields,
    bindingHash: createHash("sha256")
      .update(canonicalCccPrdJson(fields), "utf8")
      .digest("hex"),
  });
}
