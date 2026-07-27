import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCccCampaignProofAdmissionHost as bootstrapEngineCccCampaignProofAdmissionHost,
  type BootstrapCccCampaignProofAdmissionHostInput as EngineBootstrapCccCampaignProofAdmissionHostInput,
} from "@fusion/engine";

export type BootstrapCccCampaignProofAdmissionHostInput = Omit<
  EngineBootstrapCccCampaignProofAdmissionHostInput,
  "builtRootPath"
> & {
  builtRootPath?: string;
};

/** CLI compatibility surface; custody and registration live in @fusion/engine. */
export async function bootstrapCccCampaignProofAdmissionHost(
  input: BootstrapCccCampaignProofAdmissionHostInput = {},
) {
  return bootstrapEngineCccCampaignProofAdmissionHost({
    ...input,
    builtRootPath: input.builtRootPath ?? dirname(fileURLToPath(import.meta.url)),
  });
}

export { bootstrapEngineCccCampaignProofAdmissionHost };
