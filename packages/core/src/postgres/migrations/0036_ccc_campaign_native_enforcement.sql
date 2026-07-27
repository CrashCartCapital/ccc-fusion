-- FNXC:CCCCampaignNative 2026-07-24:
-- Bind every new CCC PRD import to an immutable execution policy and canonical
-- campaign manifest. Existing 0035 imports receive an explicit unadmitted
-- marker so they cannot silently become provider-capable after upgrade.

ALTER TABLE project.ccc_prd_imports
  ADD COLUMN IF NOT EXISTS execution_policy jsonb,
  ADD COLUMN IF NOT EXISTS campaign_manifest jsonb,
  ADD COLUMN IF NOT EXISTS campaign_manifest_hash text,
  ADD COLUMN IF NOT EXISTS campaign_started_at text,
  ADD COLUMN IF NOT EXISTS campaign_deadline_at text,
  ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_action_leases jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE project.ccc_prd_imports
SET
  execution_policy = COALESCE(
    execution_policy,
    jsonb_build_object(
      'schema', 'ccc-campaign.execution-policy.unadmitted.v0',
      'routes', '[]'::jsonb
    )
  ),
  campaign_manifest = COALESCE(
    campaign_manifest,
    jsonb_build_object(
      'schema', 'ccc-campaign.manifest.unadmitted.v0',
      'importId', import_id,
      'bundleHash', bundle_hash,
      'packetHash', packet_hash,
      'sidecarHash', sidecar_hash,
      'targetRepository', jsonb_build_object(
        'path', target_repository,
        'baseCommit', target_base
      )
    )
  ),
  campaign_manifest_hash = COALESCE(campaign_manifest_hash, identity_hash),
  campaign_started_at = COALESCE(campaign_started_at, created_at),
  campaign_deadline_at = COALESCE(campaign_deadline_at, created_at)
WHERE
  execution_policy IS NULL
  OR campaign_manifest IS NULL
  OR campaign_manifest_hash IS NULL
  OR campaign_started_at IS NULL
  OR campaign_deadline_at IS NULL;

ALTER TABLE project.ccc_prd_imports
  ALTER COLUMN execution_policy SET NOT NULL,
  ALTER COLUMN campaign_manifest SET NOT NULL,
  ALTER COLUMN campaign_manifest_hash SET NOT NULL,
  ALTER COLUMN campaign_started_at SET NOT NULL,
  ALTER COLUMN campaign_deadline_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ccc_prd_imports_request_count_check'
      AND conrelid = 'project.ccc_prd_imports'::regclass
  ) THEN
    ALTER TABLE project.ccc_prd_imports
      ADD CONSTRAINT ccc_prd_imports_request_count_check
      CHECK (request_count >= 0);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ccc_prd_imports_campaign_manifest
  ON project.ccc_prd_imports(project_id, campaign_manifest_hash);
