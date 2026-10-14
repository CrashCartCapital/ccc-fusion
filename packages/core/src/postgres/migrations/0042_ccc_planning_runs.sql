-- FNXC:CccPlanningRuns 2026-10-14: pre-import anchor for one request-to-code run.
-- Not a ledger: per-call history stays append-only in project.run_audit_events.
CREATE TABLE IF NOT EXISTS project.ccc_planning_runs (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  run_id text NOT NULL,
  planning_task_id text NOT NULL,
  mode text NOT NULL,
  budget_profile text NOT NULL,
  role_profile text NOT NULL,
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  request_digest text NOT NULL,
  request_bytes integer NOT NULL,
  target_repository text NOT NULL,
  admitted_base text NOT NULL,
  grant_digest text NOT NULL,
  authority_receipt_sha256 text NOT NULL,
  authority_receipt_json text NOT NULL,
  runtime_dist_manifest_sha256 text NOT NULL,
  amendment_seq integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  state_code text,
  deadline_at text NOT NULL,
  planning_allocation integer NOT NULL,
  implementation_allocation integer NOT NULL,
  review_proof_allocation integer NOT NULL,
  planning_spent integer NOT NULL DEFAULT 0,
  review_proof_spent integer NOT NULL DEFAULT 0,
  research_fetch_allocation integer NOT NULL,
  research_fetch_spent integer NOT NULL DEFAULT 0,
  research_bytes_allocation bigint NOT NULL,
  research_bytes_spent bigint NOT NULL DEFAULT 0,
  repair_epoch_state text NOT NULL DEFAULT 'unopened',
  repair_chunks_used integer NOT NULL DEFAULT 0,
  review_epochs integer NOT NULL DEFAULT 0,
  stagnant_epochs integer NOT NULL DEFAULT 0,
  control_seq integer NOT NULL DEFAULT 0,
  control_request text,
  control_revision integer,
  control_requested_at text,
  awaiting_decision_id text,
  import_intent_digest text,
  import_idempotency_key text,
  import_id text,
  implementation_transferred integer,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, run_id),
  CONSTRAINT ccc_planning_runs_task_unique UNIQUE (project_id, planning_task_id),
  CONSTRAINT ccc_planning_runs_import_unique UNIQUE (project_id, import_id),
  CONSTRAINT ccc_planning_runs_import_key_unique UNIQUE (project_id, import_idempotency_key),
  CONSTRAINT ccc_planning_runs_authority_receipt_unique UNIQUE (project_id, authority_receipt_sha256),
  -- 0006 rebuilt tasks' key as (project_id, id) (0006_project_ownership.sql:329-356); a single-column FK cannot be
  -- created and the boot ownership audit (schema-applier.ts:640-706) refuses any key without project_id.
  -- Precedent for the deferrable composite form: 0037_ccc_campaign_governance.sql:103.
  -- FNXC:CccPlanningRuns 2026-10-14-13:36 (errata E2-60): the import key is deferrable for the same reason, and for
  -- project-partition promotion (migration-stamping.ts rekeyFallbackProjectPartition): it treats a non-deferrable,
  -- non-CASCADE key between two re-keyed tables as unsafe whenever either side holds a row under the stand-in project
  -- id, so a plain ccc_prd_imports row, with no planning run at all, would make the whole project unpromotable.
  CONSTRAINT ccc_planning_runs_task_fkey FOREIGN KEY (project_id, planning_task_id)
    REFERENCES project.tasks(project_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_planning_runs_import_fkey FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_planning_runs_run_id_check CHECK (run_id ~ '^ccc-plan:[0-9a-f]{24}$'),
  CONSTRAINT ccc_planning_runs_mode_check CHECK (mode IN ('spec', 'build')),
  CONSTRAINT ccc_planning_runs_budget_profile_check CHECK (budget_profile IN ('standard', 'large')),
  CONSTRAINT ccc_planning_runs_role_profile_check CHECK (role_profile IN ('full-v2', 'adaptive-v2', 'lean-v2')),
  CONSTRAINT ccc_planning_runs_digest_check CHECK (
    policy_digest ~ '^[a-f0-9]{64}$' AND request_digest ~ '^[a-f0-9]{64}$'
    AND grant_digest ~ '^[a-f0-9]{64}$' AND authority_receipt_sha256 ~ '^[a-f0-9]{64}$'
    AND runtime_dist_manifest_sha256 ~ '^[a-f0-9]{64}$'
    AND (import_intent_digest IS NULL OR import_intent_digest ~ '^[a-f0-9]{64}$')),
  CONSTRAINT ccc_planning_runs_base_check CHECK (admitted_base ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT ccc_planning_runs_request_bytes_check CHECK (request_bytes BETWEEN 1 AND 4194304),
  -- FNXC:CccPlanningRuns 2026-10-14-13:36 (errata E2-64): the guard casts deadline_at with ::timestamptz, and PostgreSQL
  -- reads 'tomorrow' and 'infinity' as valid timestamps, which would make the spend and amendment checks a moving or
  -- absent backstop. Only the ISO-8601 UTC form that Date.prototype.toISOString writes is stored.
  CONSTRAINT ccc_planning_runs_deadline_check CHECK (
    deadline_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'),
  CONSTRAINT ccc_planning_runs_sequence_check CHECK (
    revision BETWEEN 1 AND 999 AND amendment_seq >= 0 AND control_seq >= 0),
  CONSTRAINT ccc_planning_runs_state_check CHECK (state IN (
    'admitted', 'running', 'awaiting_intent', 'awaiting_budget', 'awaiting_execution_authority',
    'blocked_prerequisite', 'blocked_provider', 'budget_exhausted', 'unknown_effect', 'paused',
    'cancelling', 'cancelled', 'spec_ready', 'importing', 'building', 'verification_failed',
    'accepted', 'delivering', 'delivered', 'failed')),
  CONSTRAINT ccc_planning_runs_state_code_check CHECK (
    (state_code IS NULL OR state_code ~ '^CCC_[A-Z0-9_]{1,120}$')
    AND (state NOT IN ('awaiting_budget', 'blocked_prerequisite', 'blocked_provider', 'budget_exhausted',
                       'unknown_effect', 'verification_failed', 'failed') OR state_code IS NOT NULL)),
  CONSTRAINT ccc_planning_runs_decision_check CHECK ((state = 'awaiting_intent') = (awaiting_decision_id IS NOT NULL)),
  CONSTRAINT ccc_planning_runs_planning_spend_check CHECK (planning_spent BETWEEN 0 AND planning_allocation),
  CONSTRAINT ccc_planning_runs_review_spend_check CHECK (review_proof_spent BETWEEN 0 AND review_proof_allocation),
  CONSTRAINT ccc_planning_runs_research_check CHECK (
    research_fetch_spent BETWEEN 0 AND research_fetch_allocation
    AND research_bytes_spent BETWEEN 0 AND research_bytes_allocation
    AND research_fetch_allocation >= 0 AND research_bytes_allocation >= 0),
  CONSTRAINT ccc_planning_runs_allocation_check CHECK (
    planning_allocation > 0 AND implementation_allocation >= 0 AND review_proof_allocation >= 0
    AND (mode = 'build' OR (implementation_allocation = 0 AND review_proof_allocation = 0))),
  CONSTRAINT ccc_planning_runs_repair_check CHECK (
    repair_epoch_state IN ('unopened', 'open', 'closed') AND repair_chunks_used BETWEEN 0 AND 4),
  CONSTRAINT ccc_planning_runs_review_epoch_check CHECK (review_epochs >= 0 AND stagnant_epochs BETWEEN 0 AND 2),
  CONSTRAINT ccc_planning_runs_control_check CHECK (
    (control_request IS NULL OR control_request IN ('pause', 'cancel', 'resume'))
    AND ((control_request IS NULL) = (control_revision IS NULL))
    AND ((control_request IS NULL) = (control_requested_at IS NULL))),
  CONSTRAINT ccc_planning_runs_import_link_check CHECK (
    ((import_idempotency_key IS NULL) = (import_intent_digest IS NULL))
    AND (import_idempotency_key IS NULL OR (
          mode = 'build'
          AND import_idempotency_key ~ '^ccc-plan:[0-9a-f]{24}:r[1-9][0-9]{0,2}$'
          AND starts_with(import_idempotency_key, run_id || ':r')))
    AND (import_id IS NULL OR import_idempotency_key IS NOT NULL)
    AND ((import_id IS NULL) = (implementation_transferred IS NULL))
    AND (implementation_transferred IS NULL
         OR implementation_transferred BETWEEN 1 AND LEAST(implementation_allocation, 10000)))
);

CREATE INDEX IF NOT EXISTS idx_ccc_planning_runs_project_state
  ON project.ccc_planning_runs (project_id, state);

CREATE OR REPLACE FUNCTION project.ccc_planning_run_transition_allowed(from_state text, to_state text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- 65 pairs. v2 adds ('admitted','blocked_prerequisite') for CCC_PLANNING_RUNTIME_NOT_PERMITTED before the first
  -- stage (D44) and ('awaiting_execution_authority','failed') for a campaign that ends before any approved writer call (D43).
  -- Adjudication item 38 adds ('importing','budget_exhausted'): the Build fit check (CCC_PLANNING_BUILD_FIT_INSUFFICIENT)
  -- runs after specready has already moved the run to importing.
  SELECT from_state = to_state OR (from_state, to_state) IN (
    ('admitted', 'running'), ('admitted', 'cancelling'), ('admitted', 'failed'), ('admitted', 'blocked_prerequisite'),
    ('running', 'awaiting_intent'), ('running', 'awaiting_budget'), ('running', 'blocked_prerequisite'),
    ('running', 'blocked_provider'), ('running', 'budget_exhausted'), ('running', 'unknown_effect'),
    ('running', 'paused'), ('running', 'cancelling'), ('running', 'spec_ready'), ('running', 'failed'),
    ('awaiting_intent', 'running'), ('awaiting_intent', 'cancelling'),
    ('awaiting_budget', 'running'), ('awaiting_budget', 'building'), ('awaiting_budget', 'cancelling'),
    ('blocked_prerequisite', 'running'), ('blocked_prerequisite', 'building'), ('blocked_prerequisite', 'cancelling'),
    ('blocked_provider', 'running'), ('blocked_provider', 'building'), ('blocked_provider', 'cancelling'),
    ('budget_exhausted', 'awaiting_budget'), ('budget_exhausted', 'cancelling'), ('budget_exhausted', 'failed'),
    ('unknown_effect', 'running'), ('unknown_effect', 'building'), ('unknown_effect', 'cancelling'),
    ('paused', 'running'), ('paused', 'building'), ('paused', 'cancelling'),
    ('cancelling', 'cancelled'),
    ('spec_ready', 'importing'), ('spec_ready', 'cancelling'), ('spec_ready', 'paused'),
    ('spec_ready', 'blocked_prerequisite'), ('spec_ready', 'budget_exhausted'), ('spec_ready', 'failed'),
    ('importing', 'awaiting_execution_authority'), ('importing', 'building'),
    ('importing', 'blocked_prerequisite'), ('importing', 'budget_exhausted'), ('importing', 'cancelling'),
    ('importing', 'failed'),
    ('awaiting_execution_authority', 'building'), ('awaiting_execution_authority', 'cancelling'),
    ('awaiting_execution_authority', 'failed'),
    ('building', 'verification_failed'), ('building', 'accepted'), ('building', 'paused'),
    ('building', 'cancelling'), ('building', 'blocked_prerequisite'), ('building', 'blocked_provider'),
    ('building', 'budget_exhausted'), ('building', 'unknown_effect'), ('building', 'failed'),
    ('verification_failed', 'cancelling'), ('verification_failed', 'failed'),
    ('accepted', 'delivering'), ('accepted', 'cancelling'),
    ('delivering', 'delivered'), ('delivering', 'failed'))
$$;

CREATE OR REPLACE FUNCTION project.ccc_planning_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'admitted' OR NEW.revision <> 1 OR NEW.amendment_seq <> 0 OR NEW.control_seq <> 0
       OR NEW.planning_spent <> 0 OR NEW.review_proof_spent <> 0 OR NEW.research_fetch_spent <> 0
       OR NEW.research_bytes_spent <> 0 OR NEW.repair_chunks_used <> 0 OR NEW.repair_epoch_state <> 'unopened'
       OR NEW.review_epochs <> 0 OR NEW.stagnant_epochs <> 0 OR NEW.control_request IS NOT NULL
       OR NEW.import_intent_digest IS NOT NULL OR NEW.import_id IS NOT NULL THEN
      RAISE EXCEPTION 'CCC_PLANNING_ANCHOR_INSERT_INVALID: run % must start admitted with zero counters', NEW.run_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('cancelled', 'delivered', 'failed') THEN
    RAISE EXCEPTION 'CCC_PLANNING_RUN_TERMINAL: run % is %', OLD.run_id, OLD.state USING ERRCODE = 'check_violation';
  END IF;

  -- FNXC:CccPlanningRuns 2026-10-14-13:36 (errata E2-63): IS DISTINCT FROM, never <>. An explicit NULL makes <> evaluate
  -- to NULL, not true, and 0006 notes that legacy stores do send NULL project ids. Every column here is NOT NULL, so a
  -- NULL is refused by its column constraint anyway; project_id is the one that was not, because fusion_assign_project_id
  -- replaces a NULL with the session's project. That is also why this trigger is named zz_ccc_planning_runs_guard.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.planning_task_id IS DISTINCT FROM OLD.planning_task_id
     OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.budget_profile IS DISTINCT FROM OLD.budget_profile
     OR NEW.role_profile IS DISTINCT FROM OLD.role_profile
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.policy_digest IS DISTINCT FROM OLD.policy_digest
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.request_bytes IS DISTINCT FROM OLD.request_bytes
     OR NEW.target_repository IS DISTINCT FROM OLD.target_repository OR NEW.admitted_base IS DISTINCT FROM OLD.admitted_base
     OR NEW.authority_receipt_sha256 IS DISTINCT FROM OLD.authority_receipt_sha256
     OR NEW.authority_receipt_json IS DISTINCT FROM OLD.authority_receipt_json
     OR NEW.runtime_dist_manifest_sha256 IS DISTINCT FROM OLD.runtime_dist_manifest_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CCC_PLANNING_ANCHOR_IMMUTABLE: run % identity is immutable', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.planning_spent < OLD.planning_spent OR NEW.review_proof_spent < OLD.review_proof_spent
     OR NEW.research_fetch_spent < OLD.research_fetch_spent OR NEW.research_bytes_spent < OLD.research_bytes_spent
     OR NEW.repair_chunks_used < OLD.repair_chunks_used OR NEW.review_epochs < OLD.review_epochs
     OR NEW.control_seq < OLD.control_seq OR NEW.revision < OLD.revision OR NEW.amendment_seq < OLD.amendment_seq
     OR NEW.control_seq > OLD.control_seq + 1 OR NEW.revision > OLD.revision + 1 THEN
    RAISE EXCEPTION 'CCC_PLANNING_COUNTER_DECREASE: run % counters only move forward one step', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT project.ccc_planning_run_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'CCC_PLANNING_STATE_TRANSITION_REFUSED: run % % -> %', OLD.run_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.planning_spent > OLD.planning_spent OR NEW.review_proof_spent > OLD.review_proof_spent
     OR NEW.research_fetch_spent > OLD.research_fetch_spent THEN
    IF OLD.control_request IS NOT NULL OR NEW.control_request IS NOT NULL OR OLD.state <> NEW.state
       OR (NEW.planning_spent > OLD.planning_spent AND NEW.state <> 'running')
       OR (NEW.research_fetch_spent > OLD.research_fetch_spent AND NEW.state <> 'running')
       OR (NEW.review_proof_spent > OLD.review_proof_spent AND NEW.state <> 'building')
       OR clock_timestamp() + interval '30 seconds' >= NEW.deadline_at::timestamptz
       OR (NEW.planning_spent - OLD.planning_spent) + (NEW.review_proof_spent - OLD.review_proof_spent)
          + (NEW.research_fetch_spent - OLD.research_fetch_spent) <> 1 THEN
      RAISE EXCEPTION 'CCC_PLANNING_SPEND_REFUSED: run % spends one call at a time, uncontrolled, in phase state, before the deadline', OLD.run_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.review_epochs > OLD.review_epochs + 1
     OR (NEW.stagnant_epochs <> OLD.stagnant_epochs
         AND NOT (NEW.review_epochs = OLD.review_epochs + 1
                  AND NEW.stagnant_epochs IN (0, OLD.stagnant_epochs + 1))) THEN
    RAISE EXCEPTION 'CCC_PLANNING_REVIEW_EPOCH_INVALID: run %', OLD.run_id USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.amendment_seq <> OLD.amendment_seq AND NEW.grant_digest = OLD.grant_digest)
     OR ((NEW.deadline_at <> OLD.deadline_at OR NEW.planning_allocation <> OLD.planning_allocation
          OR NEW.implementation_allocation <> OLD.implementation_allocation
          OR NEW.review_proof_allocation <> OLD.review_proof_allocation
          OR NEW.research_fetch_allocation <> OLD.research_fetch_allocation
          OR NEW.research_bytes_allocation <> OLD.research_bytes_allocation
          OR NEW.grant_digest <> OLD.grant_digest)
         AND NOT (NEW.amendment_seq = OLD.amendment_seq + 1
                  AND NEW.grant_digest <> OLD.grant_digest
                  AND NEW.deadline_at::timestamptz >= OLD.deadline_at::timestamptz
                  AND NEW.planning_allocation >= OLD.planning_allocation
                  AND NEW.implementation_allocation >= OLD.implementation_allocation
                  AND NEW.review_proof_allocation >= OLD.review_proof_allocation
                  AND NEW.research_fetch_allocation >= OLD.research_fetch_allocation
                  AND NEW.research_bytes_allocation >= OLD.research_bytes_allocation)) THEN
    RAISE EXCEPTION 'CCC_PLANNING_GRANT_CHANGE_REFUSED: run % grant changes only by one enlarging amendment', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (OLD.repair_epoch_state = 'closed' AND NEW.repair_epoch_state <> 'closed')
     OR (OLD.repair_epoch_state = 'open' AND NEW.repair_epoch_state = 'unopened')
     OR (NEW.repair_chunks_used > OLD.repair_chunks_used
         AND (NEW.repair_chunks_used <> OLD.repair_chunks_used + 1 OR NEW.repair_epoch_state <> 'open')) THEN
    RAISE EXCEPTION 'CCC_PLANNING_REPAIR_EPOCH_CLOSED: run % repair epoch is one-way', OLD.run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (OLD.import_intent_digest IS NOT NULL AND NEW.import_intent_digest IS DISTINCT FROM OLD.import_intent_digest)
     OR (OLD.import_idempotency_key IS NOT NULL AND NEW.import_idempotency_key IS DISTINCT FROM OLD.import_idempotency_key)
     OR (OLD.import_id IS NOT NULL AND NEW.import_id IS DISTINCT FROM OLD.import_id)
     OR (OLD.implementation_transferred IS NOT NULL
         AND NEW.implementation_transferred IS DISTINCT FROM OLD.implementation_transferred) THEN
    RAISE EXCEPTION 'CCC_PLANNING_IMPORT_LINK_WRITE_ONCE: run %', OLD.run_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE row triggers fire in name order; 'zz_' runs after fusion_assign_project_id, as 0043's guard does (errata E2-63).
DROP TRIGGER IF EXISTS ccc_planning_runs_guard ON project.ccc_planning_runs;
DROP TRIGGER IF EXISTS zz_ccc_planning_runs_guard ON project.ccc_planning_runs;
CREATE TRIGGER zz_ccc_planning_runs_guard
  BEFORE INSERT OR UPDATE ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_runs_guard();

ALTER TABLE project.ccc_planning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_planning_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_planning_runs;
CREATE POLICY fusion_project_isolation ON project.ccc_planning_runs
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_planning_runs;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON project.ccc_planning_runs TO fusion_runtime;
    -- FNXC:CccPlanningRuns 2026-10-14-09:24: 0006's default privileges also hand the runtime role DELETE, and the guard above fires on INSERT and UPDATE only. A delete then a fresh insert would reset planning_spent and the epoch counters, so the runtime never deletes or truncates an anchor row. The tasks FK is NO ACTION, so no cascade needs the privilege.
    REVOKE DELETE, TRUNCATE ON project.ccc_planning_runs FROM fusion_runtime;
  END IF;
END
$$;
