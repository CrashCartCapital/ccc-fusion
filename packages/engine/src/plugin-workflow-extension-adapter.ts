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
  const ordinaryContributions = params.contributions.filter(
    ({ extension }) => extension.kind !== "proof-admission",
  );

  const registered: string[] = [];
  // This adapter bridges ambient external plugins only. Proof admission is
  // bootstrapped separately from the fixed native entry after its persisted
  // selection/dependency closure is established.
  for (const { extension } of ordinaryContributions) {
    const id = workflowExtensionRegistryId(params.pluginId, extension.extensionId);
    params.registry.upsert(params.pluginId, extension);
    registered.push(id);
  }
  return registered;
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
