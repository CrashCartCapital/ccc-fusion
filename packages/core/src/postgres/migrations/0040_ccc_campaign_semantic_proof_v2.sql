-- FNXC:CCCCampaignSemanticProofV2 2026-08-12:
-- Preserve every phase-less v1 receipt while adding phase-bound, verifier-owned
-- proof evidence for new campaign imports. Application code validates canonical
-- JSON bytes and their bounds; these constraints enforce lifecycle correlation.
ALTER TABLE project.ccc_campaign_execution_authorization_members
  DROP CONSTRAINT IF EXISTS ccc_campaign_execution_auth_members_prompt_schema_check;
ALTER TABLE project.ccc_campaign_execution_authorization_members
  ADD CONSTRAINT ccc_campaign_execution_auth_members_prompt_schema_check
    CHECK (prompt_schema IN ('ccc-prd.execution-prompt.v1', 'ccc-prd.execution-prompt.v2'));

ALTER TABLE project.ccc_campaign_proof_attempts
  ADD COLUMN IF NOT EXISTS attempt_contract_version text NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS verifier_closure_sha256 text,
  ADD COLUMN IF NOT EXISTS candidate_inputs_sha256 text,
  ADD COLUMN IF NOT EXISTS execution_toolchain_sha256 text,
  ADD COLUMN IF NOT EXISTS terminal_envelope jsonb,
  ADD COLUMN IF NOT EXISTS terminal_envelope_sha256 text,
  ADD COLUMN IF NOT EXISTS proof_evidence jsonb,
  ADD COLUMN IF NOT EXISTS proof_evidence_sha256 text;

UPDATE project.ccc_campaign_proof_attempts
SET attempt_contract_version = 'v1'
WHERE attempt_contract_version IS NULL;

ALTER TABLE project.ccc_campaign_proof_attempts
  DROP CONSTRAINT IF EXISTS ccc_campaign_proof_attempts_contract_version_check,
  DROP CONSTRAINT IF EXISTS ccc_campaign_proof_attempts_hashes_check,
  DROP CONSTRAINT IF EXISTS ccc_campaign_proof_attempts_v2_custody_check,
  DROP CONSTRAINT IF EXISTS ccc_campaign_proof_attempts_result_shape_check;

ALTER TABLE project.ccc_campaign_proof_attempts
  ADD CONSTRAINT ccc_campaign_proof_attempts_contract_version_check
    CHECK (attempt_contract_version IN ('v1', 'v2')),
  ADD CONSTRAINT ccc_campaign_proof_attempts_hashes_check CHECK (
    packet_hash ~ '^[0-9a-f]{64}$'
    AND sidecar_hash ~ '^[0-9a-f]{64}$'
    AND bundle_hash ~ '^[0-9a-f]{64}$'
    AND manifest_hash ~ '^[0-9a-f]{64}$'
    AND campaign_binding_hash ~ '^[0-9a-f]{64}$'
    AND definition_sha256 ~ '^[0-9a-f]{64}$'
    AND command_sha256 ~ '^[0-9a-f]{64}$'
    AND (changed_paths_sha256 IS NULL OR changed_paths_sha256 ~ '^[0-9a-f]{64}$')
    AND (verifier_closure_sha256 IS NULL OR verifier_closure_sha256 ~ '^[0-9a-f]{64}$')
    AND (candidate_inputs_sha256 IS NULL OR candidate_inputs_sha256 ~ '^[0-9a-f]{64}$')
    AND (execution_toolchain_sha256 IS NULL OR execution_toolchain_sha256 ~ '^[0-9a-f]{64}$')
    AND (terminal_envelope_sha256 IS NULL OR terminal_envelope_sha256 ~ '^[0-9a-f]{64}$')
    AND (proof_evidence_sha256 IS NULL OR proof_evidence_sha256 ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT ccc_campaign_proof_attempts_v2_custody_check CHECK (
    (
      attempt_contract_version = 'v1'
      AND phase IS NULL
      AND verifier_closure_sha256 IS NULL
      AND candidate_inputs_sha256 IS NULL
      AND execution_toolchain_sha256 IS NULL
      AND terminal_envelope IS NULL
      AND terminal_envelope_sha256 IS NULL
      AND proof_evidence IS NULL
      AND proof_evidence_sha256 IS NULL
    )
    OR (
      attempt_contract_version = 'v2'
      AND phase IS NOT NULL
      AND phase IN ('task', 'final_integrated')
      AND verifier_closure_sha256 IS NOT NULL
      AND verifier_closure_sha256 ~ '^[0-9a-f]{64}$'
      AND candidate_inputs_sha256 IS NOT NULL
      AND candidate_inputs_sha256 ~ '^[0-9a-f]{64}$'
      AND execution_toolchain_sha256 IS NOT NULL
      AND execution_toolchain_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT ccc_campaign_proof_attempts_result_shape_check CHECK (
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
      AND terminal_envelope IS NULL
      AND terminal_envelope_sha256 IS NULL
      AND proof_evidence IS NULL
      AND proof_evidence_sha256 IS NULL
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
      AND terminal_envelope IS NULL
      AND terminal_envelope_sha256 IS NULL
      AND proof_evidence IS NULL
      AND proof_evidence_sha256 IS NULL
    )
    OR (
      state IN ('committed', 'proved_failed')
      AND dispatched_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND result_success IS NOT NULL
      AND result_success IN (0, 1)
      AND duration_ms IS NOT NULL
      AND duration_ms >= 0
      AND stdout_sha256 IS NOT NULL
      AND stdout_sha256 ~ '^[0-9a-f]{64}$'
      AND stderr_sha256 IS NOT NULL
      AND stderr_sha256 ~ '^[0-9a-f]{64}$'
      AND stdout_tail IS NOT NULL
      AND char_length(stdout_tail) <= 8000
      AND stderr_tail IS NOT NULL
      AND char_length(stderr_tail) <= 8000
      AND timed_out IS NOT NULL
      AND timed_out IN (0, 1)
      AND killed IS NOT NULL
      AND killed IN (0, 1)
      AND warnings IS NOT NULL
      AND jsonb_typeof(warnings) = 'array'
      AND jsonb_array_length(warnings) <= 64
      AND (negative_control_label IS NULL OR char_length(negative_control_label) <= 512)
      AND (
        (
          attempt_contract_version = 'v1'
          AND terminal_envelope IS NULL
          AND terminal_envelope_sha256 IS NULL
          AND proof_evidence IS NULL
          AND proof_evidence_sha256 IS NULL
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
        OR (
          attempt_contract_version = 'v2'
          AND changed_paths_sha256 IS NOT NULL
          AND changed_paths_sha256 ~ '^[0-9a-f]{64}$'
          AND negative_control_label IS NULL
          AND terminal_envelope IS NOT NULL
          AND jsonb_typeof(terminal_envelope) = 'object'
          AND terminal_envelope ?& ARRAY[
            'schema', 'kind', 'proofId', 'phase', 'sourceCommit', 'sourceTree',
            'exitCode', 'durationMs', 'stdoutSha256', 'stderrSha256',
            'changedPathsSha256', 'stdoutTail', 'stderrTail', 'timedOut',
            'killed', 'warnings'
          ]
          AND octet_length(terminal_envelope::text) <= 262144
          AND terminal_envelope_sha256 IS NOT NULL
          AND terminal_envelope_sha256 ~ '^[0-9a-f]{64}$'
          AND terminal_envelope ->> 'schema' = 'ccc-prd.proof-terminal-envelope.v2'
          AND terminal_envelope ->> 'phase' = phase
          AND terminal_envelope ->> 'proofId' = proof_id
          AND terminal_envelope ->> 'sourceCommit' = source_commit
          AND terminal_envelope ->> 'sourceTree' = source_tree
          AND terminal_envelope ->> 'stdoutSha256' = stdout_sha256
          AND terminal_envelope ->> 'stderrSha256' = stderr_sha256
          AND terminal_envelope ->> 'changedPathsSha256' = changed_paths_sha256
          AND terminal_envelope ->> 'stdoutTail' = stdout_tail
          AND terminal_envelope ->> 'stderrTail' = stderr_tail
          AND terminal_envelope -> 'warnings' = warnings
          AND (terminal_envelope ->> 'durationMs')::bigint = duration_ms
          AND terminal_envelope -> 'timedOut' = to_jsonb(timed_out = 1)
          AND terminal_envelope -> 'killed' = to_jsonb(killed = 1)
          AND (
            (exit_code IS NULL AND terminal_envelope -> 'exitCode' = 'null'::jsonb)
            OR (exit_code IS NOT NULL AND terminal_envelope ->> 'exitCode' = exit_code::text)
          )
          AND (
            (
              terminal_envelope ->> 'kind' = 'verified'
              AND terminal_envelope ?& ARRAY['passed', 'evidence', 'evidenceSha256']
              AND proof_evidence IS NOT NULL
              AND jsonb_typeof(proof_evidence) = 'object'
              AND proof_evidence ?& ARRAY[
                'schema', 'proofId', 'phase', 'sourceCommit', 'sourceTree',
                'passed', 'clauseResults', 'positiveCaseResults',
                'negativeControlResults'
              ]
              AND octet_length(proof_evidence::text) <= 131072
              AND proof_evidence_sha256 IS NOT NULL
              AND proof_evidence_sha256 ~ '^[0-9a-f]{64}$'
              AND terminal_envelope -> 'evidence' = proof_evidence
              AND terminal_envelope ->> 'evidenceSha256' = proof_evidence_sha256
              AND proof_evidence ->> 'schema' = 'ccc-prd.proof-evidence.v2'
              AND proof_evidence ->> 'phase' = phase
              AND proof_evidence ->> 'proofId' = proof_id
              AND proof_evidence ->> 'sourceCommit' = source_commit
              AND proof_evidence ->> 'sourceTree' = source_tree
              AND terminal_envelope -> 'passed' = proof_evidence -> 'passed'
              AND (
                (
                  state = 'committed'
                  AND result_success = 1
                  AND terminal_envelope -> 'passed' = 'true'::jsonb
                  AND exit_code = 0
                  AND timed_out = 0
                  AND killed = 0
                )
                OR (
                  state = 'proved_failed'
                  AND result_success = 0
                  AND terminal_envelope -> 'passed' = 'false'::jsonb
                  AND timed_out = 0
                  AND killed = 0
                )
              )
            )
            OR (
              state = 'proved_failed'
              AND result_success = 0
              AND terminal_envelope ->> 'kind' = 'execution_refused'
              AND terminal_envelope ? 'code'
              AND terminal_envelope ->> 'code' IN (
                'timeout', 'killed', 'no_output', 'malformed_output',
                'output_over_limit', 'spawn_refused', 'sandbox_refused'
              )
              AND proof_evidence IS NULL
              AND proof_evidence_sha256 IS NULL
            )
          )
        )
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ccc_campaign_proof_attempts_v2_phase_fence_unique
  ON project.ccc_campaign_proof_attempts(
    project_id, import_id, proof_id, phase, source_commit, definition_sha256,
    work_item_id, run_id, work_item_attempt
  )
  WHERE attempt_contract_version = 'v2';

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
