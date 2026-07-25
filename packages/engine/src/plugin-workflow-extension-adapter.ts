import {
  type WorkflowExtensionContribution,
  type WorkflowExtensionHostProvenance,
  type WorkflowExtensionRegistry,
  workflowExtensionRegistryId,
} from "@fusion/core";

export interface PluginWorkflowExtensionRegistration {
  extension: WorkflowExtensionContribution;
  hostProvenance?: WorkflowExtensionHostProvenance;
}

export function registerPluginWorkflowExtensions(params: {
  registry: WorkflowExtensionRegistry;
  pluginId: string;
  contributions: PluginWorkflowExtensionRegistration[];
}): string[] {
  const proofContributions = params.contributions.filter(
    ({ extension }) => extension.kind === "proof-admission",
  );
  const ordinaryContributions = params.contributions.filter(
    ({ extension }) => extension.kind !== "proof-admission",
  );
  const proofIds = new Set<string>();
  for (const { extension } of proofContributions) {
    const id = workflowExtensionRegistryId(params.pluginId, extension.extensionId);
    if (proofIds.has(id)) {
      throw new Error(`duplicate proof-admission contribution '${id}'`);
    }
    proofIds.add(id);
  }

  const registered: string[] = [];
  const newlyRegisteredProofIds: string[] = [];
  try {
    for (const { extension, hostProvenance } of proofContributions) {
      const id = workflowExtensionRegistryId(params.pluginId, extension.extensionId);
      const existing = params.registry.get(id);
      const existed = existing !== undefined;
      if (
        !hostProvenance
        && existing?.extension.kind === "proof-admission"
      ) {
        params.registry.degrade(
          [id],
          "runtime-fault",
          `Proof-admission extension '${id}' lost host-derived provenance`,
        );
      }
      params.registry.upsert(params.pluginId, extension, hostProvenance);
      if (!existed) newlyRegisteredProofIds.push(id);
      registered.push(id);
    }
    for (const { extension } of ordinaryContributions) {
      const id = workflowExtensionRegistryId(params.pluginId, extension.extensionId);
      params.registry.upsert(params.pluginId, extension);
      registered.push(id);
    }
    return registered;
  } catch (error) {
    for (const id of newlyRegisteredProofIds) {
      params.registry.unregister(id);
    }
    throw error;
  }
}

export function unregisterPluginWorkflowExtensions(
  registry: WorkflowExtensionRegistry,
  ids: readonly string[],
): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    if (registry.unregister(id)) removed.push(id);
  }
  return removed;
}

export function degradePluginWorkflowExtensions(
  registry: WorkflowExtensionRegistry,
  ids: readonly string[],
  message = "workflow extension plugin force-disabled",
): string[] {
  return registry.degrade(ids, "force-disabled", message);
}
