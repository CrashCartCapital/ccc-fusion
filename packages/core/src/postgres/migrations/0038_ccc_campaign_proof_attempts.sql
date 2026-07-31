-- Durable command-execution receipts for exact-commit CCC campaign proof.
-- Proof-definition admission remains separate: this table records the
-- reserve-before-spawn boundary and the terminal process result.
CREATE TABLE IF NOT EXISTS project.ccc_campaign_proof_attempts (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  attempt_key text NOT NULL,
  controller_token text NOT NULL,
  import_id text NOT NULL,
  campaign_id text NOT NULL,
  task_id text NOT NULL,
  semantic_task_id text NOT NULL,
  proof_id text NOT NULL,
  packet_hash text NOT NULL,
  sidecar_hash text NOT NULL,
  bundle_hash text NOT NULL,
  manifest_hash text NOT NULL,
  campaign_binding_hash text NOT NULL,
  target_repository text NOT NULL,
  target_base text NOT NULL,
  source_commit text NOT NULL,
  source_tree text NOT NULL,
  definition_sha256 text NOT NULL,
  command text NOT NULL,
  command_sha256 text NOT NULL,
  work_item_id text NOT NULL,
  run_id text NOT NULL,
  work_item_attempt integer NOT NULL,
  state text NOT NULL,
  result_success integer,
  exit_code integer,
  duration_ms bigint,
  stdout_sha256 text,
  stderr_sha256 text,
  stdout_tail text,
  stderr_tail text,
  timed_out integer,
  killed integer,
  warnings jsonb,
  changed_paths_sha256 text,
  negative_control_label text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  dispatched_at text,
  settled_at text,
  PRIMARY KEY (project_id, attempt_key),
  CONSTRAINT ccc_campaign_proof_attempts_import_fkey
    FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_campaign_proof_attempts_attempt_key_check
    CHECK (attempt_key ~ '^ccc-proof-attempt-[0-9a-f]{64}$'),
  CONSTRAINT ccc_campaign_proof_attempts_controller_token_check
    CHECK (controller_token ~ '^ccc-proof-controller-[0-9a-f-]{36}$'),
  CONSTRAINT ccc_campaign_proof_attempts_hashes_check CHECK (
    packet_hash ~ '^[0-9a-f]{64}$'
    AND sidecar_hash ~ '^[0-9a-f]{64}$'
    AND bundle_hash ~ '^[0-9a-f]{64}$'
    AND manifest_hash ~ '^[0-9a-f]{64}$'
    AND campaign_binding_hash ~ '^[0-9a-f]{64}$'
    AND definition_sha256 ~ '^[0-9a-f]{64}$'
    AND command_sha256 ~ '^[0-9a-f]{64}$'
    AND (changed_paths_sha256 IS NULL OR changed_paths_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ccc_campaign_proof_attempts_git_objects_check CHECK (
    source_commit ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    AND source_tree ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
  ),
  CONSTRAINT ccc_campaign_proof_attempts_state_check
    CHECK (state IN ('reserved', 'dispatched_unknown', 'committed', 'proved_failed')),
  CONSTRAINT ccc_campaign_proof_attempts_work_item_attempt_check
    CHECK (work_item_attempt > 0),
  CONSTRAINT ccc_campaign_proof_attempts_result_shape_check CHECK (
    (
      state = 'reserved'
      AND dispatched_at IS NULL
      AND settled_at IS NULL
      AND result_success IS NULL
      AND exit_code IS NULL
      AND duration_ms IS NULL
      AND stdout_sha256 IS NULL
      AND stderr_sha256 IS NULL
      AND stdout_tail IS NULL
      AND stderr_tail IS NULL
      AND timed_out IS NULL
      AND killed IS NULL
      AND warnings IS NULL
      AND changed_paths_sha256 IS NULL
      AND negative_control_label IS NULL
    )
    OR (
      state = 'dispatched_unknown'
      AND dispatched_at IS NOT NULL
      AND settled_at IS NULL
      AND result_success IS NULL
      AND exit_code IS NULL
      AND duration_ms IS NULL
      AND stdout_sha256 IS NULL
      AND stderr_sha256 IS NULL
      AND stdout_tail IS NULL
      AND stderr_tail IS NULL
      AND timed_out IS NULL
      AND killed IS NULL
      AND warnings IS NULL
      AND changed_paths_sha256 IS NULL
      AND negative_control_label IS NULL
    )
    OR (
      state IN ('committed', 'proved_failed')
      AND dispatched_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND result_success IN (0, 1)
      AND duration_ms >= 0
      AND stdout_sha256 ~ '^[0-9a-f]{64}$'
      AND stderr_sha256 ~ '^[0-9a-f]{64}$'
      AND char_length(stdout_tail) <= 8000
      AND char_length(stderr_tail) <= 8000
      AND timed_out IN (0, 1)
      AND killed IN (0, 1)
      AND jsonb_typeof(warnings) = 'array'
      AND jsonb_array_length(warnings) <= 64
      AND (negative_control_label IS NULL OR char_length(negative_control_label) <= 512)
      AND (
        (
          state = 'committed'
          AND result_success = 1
          AND exit_code = 0
          AND timed_out = 0
          AND killed = 0
        )
        OR (state = 'proved_failed' AND result_success = 0)
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_ccc_campaign_proof_attempts_campaign_commit
  ON project.ccc_campaign_proof_attempts(project_id, import_id, source_commit, proof_id);

ALTER TABLE project.ccc_campaign_proof_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_campaign_proof_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_campaign_proof_attempts;
CREATE POLICY fusion_project_isolation ON project.ccc_campaign_proof_attempts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_campaign_proof_attempts;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_campaign_proof_attempts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON project.ccc_campaign_proof_attempts
      TO fusion_runtime;
  END IF;
END
$$;
