-- FNXC:CCCCampaignGovernance 2026-07-25:
-- project_id remains forced-RLS ownership. The campaign_* tuple is optional
-- only for legacy rows and otherwise binds one row to exact import custody.

ALTER TABLE project.run_audit_events
  ADD COLUMN IF NOT EXISTS campaign_project_id text,
  ADD COLUMN IF NOT EXISTS campaign_import_id text,
  ADD COLUMN IF NOT EXISTS campaign_id text,
  ADD COLUMN IF NOT EXISTS campaign_task_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_target text,
  ADD COLUMN IF NOT EXISTS campaign_idempotency_key text,
  ADD COLUMN IF NOT EXISTS campaign_packet_hash text,
  ADD COLUMN IF NOT EXISTS campaign_sidecar_hash text,
  ADD COLUMN IF NOT EXISTS campaign_bundle_hash text,
  ADD COLUMN IF NOT EXISTS campaign_target_repository text,
  ADD COLUMN IF NOT EXISTS campaign_target_base text,
  ADD COLUMN IF NOT EXISTS campaign_provider_id text,
  ADD COLUMN IF NOT EXISTS campaign_model_id text,
  ADD COLUMN IF NOT EXISTS campaign_transport text,
  ADD COLUMN IF NOT EXISTS campaign_manifest_hash text,
  ADD COLUMN IF NOT EXISTS campaign_binding_hash text,
  ADD COLUMN IF NOT EXISTS campaign_event_key text;

ALTER TABLE project.approval_requests
  ADD COLUMN IF NOT EXISTS not_before_at text,
  ADD COLUMN IF NOT EXISTS expires_at text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_at text,
  ADD COLUMN IF NOT EXISTS campaign_project_id text,
  ADD COLUMN IF NOT EXISTS campaign_import_id text,
  ADD COLUMN IF NOT EXISTS campaign_id text,
  ADD COLUMN IF NOT EXISTS campaign_task_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_target text,
  ADD COLUMN IF NOT EXISTS campaign_idempotency_key text,
  ADD COLUMN IF NOT EXISTS campaign_packet_hash text,
  ADD COLUMN IF NOT EXISTS campaign_sidecar_hash text,
  ADD COLUMN IF NOT EXISTS campaign_bundle_hash text,
  ADD COLUMN IF NOT EXISTS campaign_target_repository text,
  ADD COLUMN IF NOT EXISTS campaign_target_base text,
  ADD COLUMN IF NOT EXISTS campaign_provider_id text,
  ADD COLUMN IF NOT EXISTS campaign_model_id text,
  ADD COLUMN IF NOT EXISTS campaign_transport text,
  ADD COLUMN IF NOT EXISTS campaign_manifest_hash text,
  ADD COLUMN IF NOT EXISTS campaign_binding_hash text;

ALTER TABLE project.ccc_effect_receipts
  ADD COLUMN IF NOT EXISTS campaign_project_id text,
  ADD COLUMN IF NOT EXISTS campaign_import_id text,
  ADD COLUMN IF NOT EXISTS campaign_id text,
  ADD COLUMN IF NOT EXISTS campaign_task_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_id text,
  ADD COLUMN IF NOT EXISTS campaign_action_target text,
  ADD COLUMN IF NOT EXISTS campaign_idempotency_key text,
  ADD COLUMN IF NOT EXISTS campaign_packet_hash text,
  ADD COLUMN IF NOT EXISTS campaign_sidecar_hash text,
  ADD COLUMN IF NOT EXISTS campaign_bundle_hash text,
  ADD COLUMN IF NOT EXISTS campaign_target_repository text,
  ADD COLUMN IF NOT EXISTS campaign_target_base text,
  ADD COLUMN IF NOT EXISTS campaign_provider_id text,
  ADD COLUMN IF NOT EXISTS campaign_model_id text,
  ADD COLUMN IF NOT EXISTS campaign_transport text,
  ADD COLUMN IF NOT EXISTS campaign_manifest_hash text,
  ADD COLUMN IF NOT EXISTS campaign_binding_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.run_audit_events'::regclass AND conname = 'run_audit_events_campaign_binding_check') THEN
    ALTER TABLE project.run_audit_events ADD CONSTRAINT run_audit_events_campaign_binding_check CHECK (
      (campaign_project_id IS NULL AND campaign_import_id IS NULL AND campaign_id IS NULL AND campaign_task_id IS NULL AND campaign_action_id IS NULL AND campaign_action_target IS NULL AND campaign_idempotency_key IS NULL AND campaign_packet_hash IS NULL AND campaign_sidecar_hash IS NULL AND campaign_bundle_hash IS NULL AND campaign_target_repository IS NULL AND campaign_target_base IS NULL AND campaign_provider_id IS NULL AND campaign_model_id IS NULL AND campaign_transport IS NULL AND campaign_manifest_hash IS NULL AND campaign_binding_hash IS NULL AND campaign_event_key IS NULL)
      OR (campaign_project_id IS NOT NULL AND campaign_import_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_task_id IS NOT NULL AND campaign_action_id IS NOT NULL AND campaign_action_target IS NOT NULL AND campaign_idempotency_key IS NOT NULL AND campaign_packet_hash IS NOT NULL AND campaign_sidecar_hash IS NOT NULL AND campaign_bundle_hash IS NOT NULL AND campaign_target_repository IS NOT NULL AND campaign_target_base IS NOT NULL AND campaign_provider_id IS NOT NULL AND campaign_model_id IS NOT NULL AND campaign_transport IS NOT NULL AND campaign_manifest_hash IS NOT NULL AND campaign_binding_hash IS NOT NULL AND campaign_event_key IS NOT NULL AND campaign_project_id = project_id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.approval_requests'::regclass AND conname = 'approval_requests_status_check') THEN
    ALTER TABLE project.approval_requests ADD CONSTRAINT approval_requests_status_check CHECK (status IN ('pending', 'approved', 'denied', 'completed', 'issued', 'claimed', 'consumed', 'expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.approval_requests'::regclass AND conname = 'approval_requests_campaign_binding_check') THEN
    ALTER TABLE project.approval_requests ADD CONSTRAINT approval_requests_campaign_binding_check CHECK (
      (campaign_project_id IS NULL AND campaign_import_id IS NULL AND campaign_id IS NULL AND campaign_task_id IS NULL AND campaign_action_id IS NULL AND campaign_action_target IS NULL AND campaign_idempotency_key IS NULL AND campaign_packet_hash IS NULL AND campaign_sidecar_hash IS NULL AND campaign_bundle_hash IS NULL AND campaign_target_repository IS NULL AND campaign_target_base IS NULL AND campaign_provider_id IS NULL AND campaign_model_id IS NULL AND campaign_transport IS NULL AND campaign_manifest_hash IS NULL AND campaign_binding_hash IS NULL)
      OR (campaign_project_id IS NOT NULL AND campaign_import_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_task_id IS NOT NULL AND campaign_action_id IS NOT NULL AND campaign_action_target IS NOT NULL AND campaign_idempotency_key IS NOT NULL AND campaign_packet_hash IS NOT NULL AND campaign_sidecar_hash IS NOT NULL AND campaign_bundle_hash IS NOT NULL AND campaign_target_repository IS NOT NULL AND campaign_target_base IS NOT NULL AND campaign_provider_id IS NOT NULL AND campaign_model_id IS NOT NULL AND campaign_transport IS NOT NULL AND campaign_manifest_hash IS NOT NULL AND campaign_binding_hash IS NOT NULL AND campaign_project_id = project_id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.approval_requests'::regclass AND conname = 'approval_requests_campaign_lifecycle_check') THEN
    ALTER TABLE project.approval_requests ADD CONSTRAINT approval_requests_campaign_lifecycle_check CHECK (
      (campaign_project_id IS NULL AND not_before_at IS NULL AND expires_at IS NULL AND claim_token IS NULL AND claimed_at IS NULL AND status IN ('pending', 'approved', 'denied', 'completed'))
      OR (campaign_project_id IS NOT NULL AND not_before_at IS NOT NULL AND expires_at IS NOT NULL AND not_before_at <= expires_at AND (
        (status = 'issued' AND claim_token IS NULL AND claimed_at IS NULL)
        OR (status = 'claimed' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
        OR (status = 'consumed' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL)
        OR (status = 'denied' AND claim_token IS NULL AND claimed_at IS NULL AND decided_at IS NOT NULL)
        OR (status = 'expired' AND decided_at IS NOT NULL AND ((claim_token IS NULL AND claimed_at IS NULL) OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)))
      ))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.ccc_effect_receipts'::regclass AND conname = 'ccc_effect_receipts_campaign_binding_check') THEN
    ALTER TABLE project.ccc_effect_receipts ADD CONSTRAINT ccc_effect_receipts_campaign_binding_check CHECK (
      (campaign_project_id IS NULL AND campaign_import_id IS NULL AND campaign_id IS NULL AND campaign_task_id IS NULL AND campaign_action_id IS NULL AND campaign_action_target IS NULL AND campaign_idempotency_key IS NULL AND campaign_packet_hash IS NULL AND campaign_sidecar_hash IS NULL AND campaign_bundle_hash IS NULL AND campaign_target_repository IS NULL AND campaign_target_base IS NULL AND campaign_provider_id IS NULL AND campaign_model_id IS NULL AND campaign_transport IS NULL AND campaign_manifest_hash IS NULL AND campaign_binding_hash IS NULL)
      OR (campaign_project_id IS NOT NULL AND campaign_import_id IS NOT NULL AND campaign_id IS NOT NULL AND campaign_task_id IS NOT NULL AND campaign_action_id IS NOT NULL AND campaign_action_target IS NOT NULL AND campaign_idempotency_key IS NOT NULL AND campaign_packet_hash IS NOT NULL AND campaign_sidecar_hash IS NOT NULL AND campaign_bundle_hash IS NOT NULL AND campaign_target_repository IS NOT NULL AND campaign_target_base IS NOT NULL AND campaign_provider_id IS NOT NULL AND campaign_model_id IS NOT NULL AND campaign_transport IS NOT NULL AND campaign_manifest_hash IS NOT NULL AND campaign_binding_hash IS NOT NULL AND campaign_project_id = project_id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.run_audit_events'::regclass AND conname = 'run_audit_events_campaign_import_fkey') THEN
    ALTER TABLE project.run_audit_events ADD CONSTRAINT run_audit_events_campaign_import_fkey FOREIGN KEY (project_id, campaign_import_id) REFERENCES project.ccc_prd_imports(project_id, import_id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.approval_requests'::regclass AND conname = 'approval_requests_campaign_import_fkey') THEN
    ALTER TABLE project.approval_requests ADD CONSTRAINT approval_requests_campaign_import_fkey FOREIGN KEY (project_id, campaign_import_id) REFERENCES project.ccc_prd_imports(project_id, import_id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.ccc_effect_receipts'::regclass AND conname = 'ccc_effect_receipts_campaign_import_fkey') THEN
    ALTER TABLE project.ccc_effect_receipts ADD CONSTRAINT ccc_effect_receipts_campaign_import_fkey FOREIGN KEY (project_id, campaign_import_id) REFERENCES project.ccc_prd_imports(project_id, import_id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_run_audit_events_campaign_import ON project.run_audit_events(project_id, campaign_import_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_run_audit_events_campaign_event ON project.run_audit_events(project_id, campaign_event_key) WHERE campaign_event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_requests_campaign_import ON project.approval_requests(project_id, campaign_import_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_requests_campaign_action ON project.approval_requests(project_id, campaign_import_id, campaign_action_id) WHERE campaign_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ccc_effect_receipts_campaign_import ON project.ccc_effect_receipts(project_id, campaign_import_id);

-- Migration 0036 marked legacy CCC imports unadmitted but did not park the
-- already-active native rows they owned. Quarantine only imports carrying that
-- explicit legacy policy marker; admitted v1 campaign rows remain unchanged.

UPDATE project.ccc_prd_imports
SET
  state = 'prepared',
  runnable = 0,
  projection_owner = NULL,
  projection_lease_until = NULL,
  activated_at = NULL,
  last_error = 'ccc-prd-import-unadmitted'
WHERE execution_policy ->> 'schema'
  = 'ccc-campaign.execution-policy.unadmitted.v0';

UPDATE project.tasks AS task
SET
  "column" = 'triage',
  status = 'ccc-prd-import-prepared',
  paused = 1,
  user_paused = 1,
  paused_reason = 'ccc-prd-import-unadmitted'
WHERE EXISTS (
  SELECT 1
  FROM project.ccc_prd_import_entities AS entity
  JOIN project.ccc_prd_imports AS import
    ON import.project_id = entity.project_id
    AND import.import_id = entity.import_id
  WHERE entity.project_id = task.project_id
    AND entity.entity_type = 'task'
    AND entity.native_id = task.id
    AND import.execution_policy ->> 'schema'
      = 'ccc-campaign.execution-policy.unadmitted.v0'
);

UPDATE project.workflow_work_items AS work_item
SET
  state = 'held',
  blocked_reason = 'ccc-prd-import-unadmitted',
  lease_owner = NULL,
  lease_expires_at = NULL
WHERE EXISTS (
  SELECT 1
  FROM project.ccc_prd_import_entities AS entity
  JOIN project.ccc_prd_imports AS import
    ON import.project_id = entity.project_id
    AND import.import_id = entity.import_id
  WHERE entity.project_id = work_item.project_id
    AND (
      (
        entity.entity_type = 'work_item'
        AND entity.native_id = work_item.id
      )
      OR (
        entity.entity_type = 'task'
        AND entity.native_id = work_item.task_id
      )
    )
    AND import.execution_policy ->> 'schema'
      = 'ccc-campaign.execution-policy.unadmitted.v0'
)
AND work_item.state IN ('runnable', 'running', 'retrying');
