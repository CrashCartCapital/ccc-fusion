-- FNXC:CCCCampaignExecutionAuthorization 2026-08-12:
-- One launch authorization binds the complete sealed campaign while exact
-- child approval rows retain task/action/provider dispatch custody.
CREATE TABLE IF NOT EXISTS project.ccc_campaign_execution_authorizations (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  authorization_id text NOT NULL,
  schema_version text NOT NULL,
  import_id text NOT NULL,
  campaign_id text NOT NULL,
  idempotency_key text NOT NULL,
  workflow_id text NOT NULL,
  work_item_id text NOT NULL,
  workflow_ir_hash text NOT NULL,
  packet_hash text NOT NULL,
  sidecar_hash text NOT NULL,
  bundle_hash text NOT NULL,
  manifest_hash text NOT NULL,
  execution_policy_sha256 text NOT NULL,
  target_repository text NOT NULL,
  target_base text NOT NULL,
  campaign_started_at text NOT NULL,
  campaign_deadline_at text NOT NULL,
  max_requests integer NOT NULL,
  max_concurrency integer NOT NULL,
  member_set_hash text NOT NULL,
  authorization_digest text NOT NULL,
  expected_request_count integer NOT NULL,
  status text NOT NULL,
  requester_actor_id text NOT NULL,
  requester_actor_type text NOT NULL,
  requester_actor_name text NOT NULL,
  not_before_at text NOT NULL,
  expires_at text NOT NULL,
  claim_token text,
  claimed_at text,
  settled_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, authorization_id),
  CONSTRAINT ccc_campaign_execution_authorizations_project_import_unique
    UNIQUE (project_id, import_id),
  CONSTRAINT ccc_campaign_execution_authorizations_project_digest_unique
    UNIQUE (project_id, authorization_digest),
  CONSTRAINT ccc_campaign_execution_authorizations_import_fkey
    FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_campaign_execution_authorizations_schema_version_check
    CHECK (schema_version = 'ccc-campaign.execution-authorization.v1'),
  CONSTRAINT ccc_campaign_execution_authorizations_identity_check
    CHECK (authorization_id = 'ccc-execution-authorization-' || authorization_digest),
  CONSTRAINT ccc_campaign_execution_authorizations_hashes_check CHECK (
    workflow_ir_hash ~ '^[0-9a-f]{64}$'
    AND packet_hash ~ '^[0-9a-f]{64}$'
    AND sidecar_hash ~ '^[0-9a-f]{64}$'
    AND bundle_hash ~ '^[0-9a-f]{64}$'
    AND manifest_hash ~ '^[0-9a-f]{64}$'
    AND execution_policy_sha256 ~ '^[0-9a-f]{64}$'
    AND target_base ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    AND member_set_hash ~ '^[0-9a-f]{64}$'
    AND authorization_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ccc_campaign_execution_authorizations_bounds_check CHECK (
    max_requests > 0
    AND max_concurrency > 0
    AND expected_request_count >= 0
    AND expected_request_count <= max_requests
  ),
  CONSTRAINT ccc_campaign_execution_authorizations_window_check CHECK (
    campaign_started_at <= not_before_at
    AND not_before_at <= expires_at
    AND expires_at <= campaign_deadline_at
  ),
  CONSTRAINT ccc_campaign_execution_authorizations_status_check
    CHECK (status IN ('issued', 'claimed', 'settled')),
  CONSTRAINT ccc_campaign_execution_authorizations_lifecycle_check CHECK (
    (
      status = 'issued'
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND settled_at IS NULL
    )
    OR (
      status = 'claimed'
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND settled_at IS NULL
    )
    OR (
      status = 'settled'
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND claimed_at <= settled_at
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_ccc_campaign_execution_authorizations_campaign
  ON project.ccc_campaign_execution_authorizations(project_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_ccc_campaign_execution_authorizations_status
  ON project.ccc_campaign_execution_authorizations(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS project.ccc_campaign_execution_authorization_members (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  authorization_id text NOT NULL,
  ordinal integer NOT NULL,
  native_task_id text NOT NULL,
  semantic_task_id text NOT NULL,
  action_id text NOT NULL,
  action_target text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  transport text NOT NULL,
  prompt_schema text NOT NULL,
  prompt_sha256 text NOT NULL,
  route_sha256 text NOT NULL,
  binding_hash text NOT NULL,
  approval_request_id text NOT NULL,
  member_hash text NOT NULL,
  PRIMARY KEY (project_id, authorization_id, ordinal),
  CONSTRAINT ccc_campaign_execution_authorization_members_binding_unique
    UNIQUE (project_id, authorization_id, binding_hash),
  CONSTRAINT ccc_campaign_execution_authorization_members_task_action_unique
    UNIQUE (project_id, authorization_id, native_task_id, action_id),
  CONSTRAINT ccc_campaign_execution_authorization_members_native_task_unique
    UNIQUE (project_id, authorization_id, native_task_id),
  CONSTRAINT ccc_campaign_execution_auth_members_semantic_task_unique
    UNIQUE (project_id, authorization_id, semantic_task_id),
  CONSTRAINT ccc_campaign_execution_authorization_members_approval_unique
    UNIQUE (project_id, approval_request_id),
  CONSTRAINT ccc_campaign_execution_authorization_members_member_hash_unique
    UNIQUE (project_id, authorization_id, member_hash),
  CONSTRAINT ccc_campaign_execution_authorization_members_authorization_fkey
    FOREIGN KEY (project_id, authorization_id)
    REFERENCES project.ccc_campaign_execution_authorizations(project_id, authorization_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_campaign_execution_authorization_members_approval_fkey
    FOREIGN KEY (project_id, approval_request_id)
    REFERENCES project.approval_requests(project_id, id)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_campaign_execution_authorization_members_ordinal_check
    CHECK (ordinal >= 0),
  CONSTRAINT ccc_campaign_execution_authorization_members_transport_check
    CHECK (transport IN ('pi', 'cli', 'workflow')),
  CONSTRAINT ccc_campaign_execution_auth_members_prompt_schema_check
    CHECK (prompt_schema = 'ccc-prd.execution-prompt.v1'),
  CONSTRAINT ccc_campaign_execution_authorization_members_hashes_check CHECK (
    prompt_sha256 ~ '^[0-9a-f]{64}$'
    AND route_sha256 ~ '^[0-9a-f]{64}$'
    AND binding_hash ~ '^[0-9a-f]{64}$'
    AND member_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ccc_campaign_execution_authorization_members_approval_id_check
    CHECK (approval_request_id = 'ccc-approval-' || binding_hash)
);

CREATE INDEX IF NOT EXISTS idx_ccc_campaign_execution_authorization_members_task_action
  ON project.ccc_campaign_execution_authorization_members(project_id, native_task_id, action_id);

ALTER TABLE project.ccc_campaign_execution_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_campaign_execution_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_campaign_execution_authorizations;
CREATE POLICY fusion_project_isolation ON project.ccc_campaign_execution_authorizations
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_campaign_execution_authorizations;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_campaign_execution_authorizations
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.ccc_campaign_execution_authorization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_campaign_execution_authorization_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_campaign_execution_authorization_members;
CREATE POLICY fusion_project_isolation ON project.ccc_campaign_execution_authorization_members
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_campaign_execution_authorization_members;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_campaign_execution_authorization_members
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON project.ccc_campaign_execution_authorizations,
         project.ccc_campaign_execution_authorization_members
      TO fusion_runtime;
  END IF;
END
$$;
