import {
  getWorkflowExtensionHostProvenanceBinding,
  hasSameWorkflowExtensionHostProvenanceIdentity,
  verifyWorkflowExtensionHostProvenance,
  WorkflowExtensionProvenanceError,
  type WorkflowExtensionHostProvenance,
  type WorkflowExtensionHostProvenanceBinding,
} from "./workflow-extension-provenance.js";
import type {
  WorkflowExtensionContribution,
  WorkflowExtensionKind,
  WorkflowProofAdmissionExtensionContribution,
} from "./workflow-extension-types.js";
import { workflowExtensionRegistryId } from "./workflow-extension-types.js";

export type WorkflowExtensionRegistrationReason =
  | "duplicate-id"
  | "invalid-plugin-id"
  | "invalid-extension-id"
  | "invalid-proof-contribution"
  | "missing-host-provenance"
  | "invalid-host-provenance"
  | "host-identity-mismatch"
  | "identity-drift";

export class WorkflowExtensionRegistrationError extends Error {
  constructor(
    public readonly reason: WorkflowExtensionRegistrationReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowExtensionRegistrationError";
  }
}

export interface WorkflowExtensionDefinition {
  id: string;
  pluginId: string;
  extension: WorkflowExtensionContribution;
  readonly hostProvenance?: WorkflowExtensionHostProvenanceBinding;
  degraded?: {
    reason: "force-disabled" | "plugin-unloaded" | "runtime-fault";
    message: string;
  };
}

type WorkflowExtensionDegradeReason = NonNullable<WorkflowExtensionDefinition["degraded"]>["reason"];

type InternalWorkflowExtensionDefinition = {
  readonly id: string;
  readonly pluginId: string;
  readonly sealedProof: boolean;
  extension: WorkflowExtensionContribution;
  hostProvenance?: WorkflowExtensionHostProvenance;
  hostBinding?: WorkflowExtensionHostProvenanceBinding;
  degraded?: WorkflowExtensionDefinition["degraded"];
  snapshot?: WorkflowExtensionDefinition;
};

const PLUGIN_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PROOF_CONTRIBUTION_KEYS = new Set([
  "extensionId",
  "name",
  "description",
  "kind",
  "schemaVersion",
  "fallback",
  "proofVersion",
  "evaluate",
]);

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (typeof value === "function") return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing) return existing as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(object, clone);
    for (const entry of value) clone.push(cloneAndFreeze(entry, seen));
    return Object.freeze(clone) as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(object, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneAndFreeze(entry, seen);
  }
  return Object.freeze(clone) as T;
}

function snapshotOf(
  definition: InternalWorkflowExtensionDefinition,
): WorkflowExtensionDefinition {
  if (!definition.snapshot) {
    const snapshot: WorkflowExtensionDefinition = {
      id: definition.id,
      pluginId: definition.pluginId,
      extension: definition.extension,
      ...(definition.hostBinding ? { hostProvenance: definition.hostBinding } : {}),
      ...(definition.degraded ? { degraded: definition.degraded } : {}),
    };
    definition.snapshot = definition.sealedProof ? Object.freeze(snapshot) : snapshot;
  }
  return definition.snapshot;
}

function updateDegraded(
  definition: InternalWorkflowExtensionDefinition,
  reason: WorkflowExtensionDegradeReason,
  message: string,
): void {
  definition.degraded = definition.sealedProof
    ? Object.freeze({ reason, message })
    : { reason, message };
  if (definition.sealedProof) {
    definition.snapshot = undefined;
  } else if (definition.snapshot) {
    definition.snapshot.degraded = definition.degraded;
  }
}

function validateRegistrationIds(
  pluginId: string,
  extensionId: string,
): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new WorkflowExtensionRegistrationError(
      "invalid-plugin-id",
      `Plugin id '${pluginId}' is not a valid workflow extension namespace`,
    );
  }
  if (!PLUGIN_ID_PATTERN.test(extensionId)) {
    throw new WorkflowExtensionRegistrationError(
      "invalid-extension-id",
      `Workflow extension id '${extensionId}' is not a valid slug`,
    );
  }
}

function requireProofContribution(
  extension: WorkflowExtensionContribution,
): WorkflowProofAdmissionExtensionContribution {
  if (
    extension.kind !== "proof-admission"
    || extension.fallback !== "failClosed"
    || typeof extension.proofVersion !== "string"
    || extension.proofVersion.trim() === ""
    || typeof extension.evaluate !== "function"
  ) {
    throw new WorkflowExtensionRegistrationError(
      "invalid-proof-contribution",
      "Proof-admission contributions require failClosed, a proofVersion, and an evaluator",
    );
  }
  for (const key of Object.keys(extension)) {
    if (!PROOF_CONTRIBUTION_KEYS.has(key)) {
      throw new WorkflowExtensionRegistrationError(
        "invalid-proof-contribution",
        `Proof-admission contributions cannot assert '${key}'`,
      );
    }
  }
  return extension;
}

function requireProofHostAuthority(
  pluginId: string,
  extension: WorkflowExtensionContribution,
  hostProvenance: WorkflowExtensionHostProvenance | undefined,
): WorkflowExtensionHostProvenanceBinding | undefined {
  if (extension.kind !== "proof-admission") return undefined;
  requireProofContribution(extension);
  if (!hostProvenance) {
    throw new WorkflowExtensionRegistrationError(
      "missing-host-provenance",
      "Proof-admission registration requires host-derived provenance",
    );
  }
  let binding: WorkflowExtensionHostProvenanceBinding;
  try {
    binding = getWorkflowExtensionHostProvenanceBinding(hostProvenance);
  } catch (error) {
    if (error instanceof WorkflowExtensionProvenanceError) {
      throw new WorkflowExtensionRegistrationError(
        "invalid-host-provenance",
        error.message,
      );
    }
    throw error;
  }
  if (binding.pluginId !== pluginId) {
    throw new WorkflowExtensionRegistrationError(
      "host-identity-mismatch",
      `Host provenance plugin '${binding.pluginId}' does not match registry namespace '${pluginId}'`,
    );
  }
  return binding;
}

function sameHostBinding(
  left: WorkflowExtensionHostProvenanceBinding | undefined,
  right: WorkflowExtensionHostProvenanceBinding | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.pluginId === right.pluginId
    && left.pluginVersion === right.pluginVersion
    && left.extensionRootRelativeSource === right.extensionRootRelativeSource
    && left.extensionSourceSha256 === right.extensionSourceSha256
    && left.extensionManifestSha256 === right.extensionManifestSha256;
}

function sameProofIdentity(
  existing: InternalWorkflowExtensionDefinition,
  replacement: WorkflowExtensionContribution,
  replacementProvenance: WorkflowExtensionHostProvenance | undefined,
  replacementBinding: WorkflowExtensionHostProvenanceBinding | undefined,
): boolean {
  if (
    existing.extension.kind !== "proof-admission"
    || replacement.kind !== "proof-admission"
  ) {
    return false;
  }
  return existing.extension.proofVersion === replacement.proofVersion
    && sameHostBinding(existing.hostBinding, replacementBinding)
    && existing.hostProvenance !== undefined
    && replacementProvenance !== undefined
    && hasSameWorkflowExtensionHostProvenanceIdentity(
      existing.hostProvenance,
      replacementProvenance,
    );
}

export class WorkflowExtensionRegistry {
  private definitions = new Map<string, InternalWorkflowExtensionDefinition>();

  register(
    pluginId: string,
    extension: WorkflowExtensionContribution,
    hostProvenance?: WorkflowExtensionHostProvenance,
  ): WorkflowExtensionDefinition {
    validateRegistrationIds(pluginId, extension.extensionId);
    const hostBinding = requireProofHostAuthority(pluginId, extension, hostProvenance);
    const id = workflowExtensionRegistryId(pluginId, extension.extensionId);
    if (this.definitions.has(id)) {
      throw new WorkflowExtensionRegistrationError(
        "duplicate-id",
        `Workflow extension '${id}' is already registered`,
      );
    }
    const definition: InternalWorkflowExtensionDefinition = {
      id,
      pluginId,
      sealedProof: extension.kind === "proof-admission",
      extension: extension.kind === "proof-admission"
        ? cloneAndFreeze(extension)
        : extension,
      ...(hostProvenance ? { hostProvenance } : {}),
      ...(hostBinding ? { hostBinding } : {}),
    };
    this.definitions.set(id, definition);
    return snapshotOf(definition);
  }

  upsert(
    pluginId: string,
    extension: WorkflowExtensionContribution,
    hostProvenance?: WorkflowExtensionHostProvenance,
  ): WorkflowExtensionDefinition {
    validateRegistrationIds(pluginId, extension.extensionId);
    const hostBinding = requireProofHostAuthority(pluginId, extension, hostProvenance);
    const id = workflowExtensionRegistryId(pluginId, extension.extensionId);
    const existing = this.definitions.get(id);
    if (!existing) {
      return this.register(pluginId, extension, hostProvenance);
    }
    if (
      existing.extension.kind === "proof-admission"
      || extension.kind === "proof-admission"
    ) {
      if (sameProofIdentity(existing, extension, hostProvenance, hostBinding)) {
        return snapshotOf(existing);
      }
      updateDegraded(
        existing,
        "runtime-fault",
        `Proof-admission extension '${id}' refused a same-id identity replacement`,
      );
      throw new WorkflowExtensionRegistrationError(
        "identity-drift",
        `Proof-admission extension '${id}' changed its sealed identity`,
      );
    }
    existing.extension = extension;
    if (existing.snapshot) existing.snapshot.extension = extension;
    return snapshotOf(existing);
  }

  async reverifyHostProvenance(
    id: string,
  ): Promise<WorkflowExtensionHostProvenanceBinding> {
    const definition = this.definitions.get(id);
    if (!definition?.hostProvenance || !definition.hostBinding) {
      throw new WorkflowExtensionRegistrationError(
        "invalid-host-provenance",
        `Workflow extension '${id}' has no sealed host provenance`,
      );
    }
    try {
      return await verifyWorkflowExtensionHostProvenance(definition.hostProvenance);
    } catch (error) {
      updateDegraded(
        definition,
        "runtime-fault",
        `Workflow extension '${id}' failed host provenance re-verification`,
      );
      throw error;
    }
  }

  unregister(id: string): boolean {
    return this.definitions.delete(id);
  }

  unregisterPlugin(pluginId: string): string[] {
    const removed: string[] = [];
    for (const [id, definition] of this.definitions) {
      if (definition.pluginId !== pluginId) continue;
      this.definitions.delete(id);
      removed.push(id);
    }
    return removed;
  }

  degrade(ids: readonly string[], reason: WorkflowExtensionDegradeReason, message: string): string[] {
    const degraded: string[] = [];
    for (const id of ids) {
      const definition = this.definitions.get(id);
      if (!definition) continue;
      updateDegraded(definition, reason, message);
      degraded.push(id);
    }
    return degraded;
  }

  get(id: string): WorkflowExtensionDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition ? snapshotOf(definition) : undefined;
  }

  list(kind?: WorkflowExtensionKind): WorkflowExtensionDefinition[] {
    const definitions = [...this.definitions.values()]
      .filter((definition) => !kind || definition.extension.kind === kind)
      .map(snapshotOf);
    return kind === "proof-admission"
      ? Object.freeze(definitions) as unknown as WorkflowExtensionDefinition[]
      : definitions;
  }

  clear(): void {
    this.definitions.clear();
  }
}

const defaultWorkflowExtensionRegistry = new WorkflowExtensionRegistry();

export function getWorkflowExtensionRegistry(): WorkflowExtensionRegistry {
  return defaultWorkflowExtensionRegistry;
}

export function __resetWorkflowExtensionRegistryForTests(): void {
  defaultWorkflowExtensionRegistry.clear();
}
