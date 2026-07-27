-- FNXC:CCCEffectReceipts 2026-07-23-21:42:
-- CCC effect receipts must coordinate independently hydrated controllers. Session
-- posture is a cache-local whole-row write, so it cannot be the authority for a
-- reserve/dispatch/commit state machine.
CREATE TABLE IF NOT EXISTS project.ccc_effect_receipts (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  owner_project_id text,
  effect_scope_id text NOT NULL,
  logical_key text NOT NULL,
  turn_key text NOT NULL,
  slot_ordinal integer NOT NULL,
  tool_authority text NOT NULL,
  arguments_digest text NOT NULL,
  repeat_of text,
  state text NOT NULL,
  controller_token text NOT NULL,
  evidence_digest text,
  result_json text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, effect_scope_id, logical_key),
  CONSTRAINT ccc_effect_receipts_state_check
    CHECK (state IN ('reserved', 'dispatched_unknown', 'committed', 'proved_failed')),
  CONSTRAINT ccc_effect_receipts_slot_ordinal_check CHECK (slot_ordinal >= 0),
  CONSTRAINT ccc_effect_receipts_turn_slot_unique UNIQUE (project_id, effect_scope_id, turn_key, slot_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_ccc_effect_receipts_scope_authority_digest
  ON project.ccc_effect_receipts(project_id, effect_scope_id, tool_authority, arguments_digest);
CREATE INDEX IF NOT EXISTS idx_ccc_effect_receipts_turn_slot
  ON project.ccc_effect_receipts(project_id, effect_scope_id, turn_key, slot_ordinal);

CREATE TABLE IF NOT EXISTS project.ccc_effect_turns (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  owner_project_id text,
  effect_scope_id text NOT NULL,
  turn_key text NOT NULL,
  state text NOT NULL,
  controller_token text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, effect_scope_id, turn_key),
  CONSTRAINT ccc_effect_turns_state_check CHECK (state IN ('open', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_ccc_effect_turns_open
  ON project.ccc_effect_turns(project_id, effect_scope_id, state);
ALTER TABLE project.ccc_effect_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_effect_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_effect_turns;
CREATE POLICY fusion_project_isolation ON project.ccc_effect_turns
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_effect_turns;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_effect_turns
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.ccc_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_effect_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_effect_receipts;
CREATE POLICY fusion_project_isolation ON project.ccc_effect_receipts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_effect_receipts;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_effect_receipts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
