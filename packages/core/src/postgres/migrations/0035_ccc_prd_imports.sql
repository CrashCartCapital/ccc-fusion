-- FNXC:CCCPrdImport 2026-07-24:
-- Durable ownership for one generated CCC PRD bundle import. Native Fusion
-- entities remain the read/execution authority; these tables bind idempotency,
-- source custody, semantic identity, and restart-safe filesystem projection.
CREATE TABLE IF NOT EXISTS project.ccc_prd_imports (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  idempotency_key text NOT NULL,
  import_id text NOT NULL,
  identity_hash text NOT NULL,
  bundle_hash text NOT NULL,
  packet_hash text NOT NULL,
  sidecar_hash text NOT NULL,
  source_version text NOT NULL,
  target_repository text NOT NULL,
  target_base text NOT NULL,
  root_dir text NOT NULL,
  staging_relative_path text NOT NULL,
  state text NOT NULL,
  runnable integer NOT NULL DEFAULT 0,
  canonical_bundle jsonb NOT NULL,
  transaction_witness jsonb NOT NULL,
  projection_digest text NOT NULL,
  projection_owner text,
  projection_lease_until text,
  last_error text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  activated_at text,
  PRIMARY KEY (project_id, idempotency_key),
  CONSTRAINT ccc_prd_imports_project_import_unique UNIQUE (project_id, import_id),
  CONSTRAINT ccc_prd_imports_state_check CHECK (state IN ('prepared', 'projecting', 'active')),
  CONSTRAINT ccc_prd_imports_runnable_check CHECK (runnable IN (0, 1)),
  CONSTRAINT ccc_prd_imports_state_runnable_check
    CHECK ((state = 'active' AND runnable = 1) OR (state <> 'active' AND runnable = 0))
);

CREATE INDEX IF NOT EXISTS idx_ccc_prd_imports_state
  ON project.ccc_prd_imports(project_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_ccc_prd_imports_identity
  ON project.ccc_prd_imports(project_id, target_repository, target_base, identity_hash);

CREATE TABLE IF NOT EXISTS project.ccc_prd_import_sources (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  import_id text NOT NULL,
  ordinal integer NOT NULL,
  path text NOT NULL,
  role text NOT NULL,
  authoritative integer NOT NULL,
  raw_sha256 text NOT NULL,
  byte_length integer NOT NULL,
  PRIMARY KEY (project_id, import_id, path),
  CONSTRAINT ccc_prd_import_sources_import_fkey
    FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_prd_import_sources_authoritative_check CHECK (authoritative IN (0, 1)),
  CONSTRAINT ccc_prd_import_sources_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT ccc_prd_import_sources_byte_length_check CHECK (byte_length >= 0)
);

CREATE TABLE IF NOT EXISTS project.ccc_prd_import_entities (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  import_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  native_id text NOT NULL,
  ordinal integer NOT NULL,
  content_digest text NOT NULL,
  PRIMARY KEY (project_id, import_id, entity_type, entity_id),
  CONSTRAINT ccc_prd_import_entities_import_fkey
    FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ccc_prd_import_entities_type_check
    CHECK (entity_type IN ('campaign', 'task', 'dependency_edge', 'workflow', 'document', 'artifact', 'source', 'work_item', 'run_audit')),
  CONSTRAINT ccc_prd_import_entities_ordinal_check CHECK (ordinal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ccc_prd_import_entities_native
  ON project.ccc_prd_import_entities(project_id, import_id, entity_type, native_id);

ALTER TABLE project.ccc_prd_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_prd_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_prd_imports;
CREATE POLICY fusion_project_isolation ON project.ccc_prd_imports
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_prd_imports;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_prd_imports
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.ccc_prd_import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_prd_import_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_prd_import_sources;
CREATE POLICY fusion_project_isolation ON project.ccc_prd_import_sources
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_prd_import_sources;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_prd_import_sources
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.ccc_prd_import_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_prd_import_entities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_prd_import_entities;
CREATE POLICY fusion_project_isolation ON project.ccc_prd_import_entities
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_prd_import_entities;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_prd_import_entities
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
