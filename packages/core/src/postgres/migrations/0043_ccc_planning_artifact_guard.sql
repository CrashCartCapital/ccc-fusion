-- FNXC:CccPlanningArtifacts 2026-10-14: planning artifacts are task documents under the reserved
-- key prefix 'cccplan-'. Insert-once, publisher-gated, digest-checked, anchored to the run,
-- fence-guarded, closure-checked and design-sealed. Ordinary documents pay one LIKE test.
CREATE OR REPLACE FUNCTION project.ccc_planning_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  envelope jsonb;
  fence jsonb;
  input_ref jsonb;
  stage text;
  expected_key text;
  anchor project.ccc_planning_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be deleted', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.key LIKE 'cccplan-%' OR NEW.key LIKE 'cccplan-%' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_IMMUTABLE: % on task % cannot be updated', OLD.key, OLD.task_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.key NOT LIKE 'cccplan-%' THEN
    RETURN NEW;
  END IF;
  IF current_setting('fusion.ccc_planning_publication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_PUBLISHER_REQUIRED: % is a reserved planning artifact key', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  envelope := NEW.metadata;
  stage := envelope->>'stageId';
  IF envelope IS NULL OR jsonb_typeof(envelope) <> 'object'
     OR envelope->>'schema' IS DISTINCT FROM 'ccc-planning.artifact-envelope.v1'
     OR envelope->>'artifactKey' IS DISTINCT FROM NEW.key
     OR stage IS NULL OR stage NOT IN (
       'preflight', 'intent', 'research', 'design', 'design-review', 'spec', 'plan', 'verifier', 'review',
       'repair', 'specready', 'import', 'admission', 'operator', 'invalidate', 'g7', 'g8')
     OR coalesce(envelope->>'slot', '') !~ '^[a-z0-9]{1,20}$'
     OR coalesce(envelope->>'runRevision', '') !~ '^[1-9][0-9]{0,2}$'
     OR coalesce(envelope->>'version', '') !~ '^[1-9][0-9]?$'
     OR coalesce(envelope->>'kind', '') = ''
     OR jsonb_typeof(envelope->'inputs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(envelope->'fence') IS DISTINCT FROM 'object'
     OR NEW.revision <> 1
     OR NEW.author IS DISTINCT FROM ('ccc-planning:' || coalesce(envelope->'producer'->>'roleId', '')) THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  expected_key := 'cccplan-r' || lpad(envelope->>'runRevision', 3, '0') || '-' || stage || '-'
    || (envelope->>'slot') || '-v' || lpad(envelope->>'version', 2, '0');
  IF NEW.key <> expected_key THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID: key % expected %', NEW.key, expected_key
      USING ERRCODE = 'P0001';
  END IF;
  IF octet_length(NEW.content) > 4194304 THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_TOO_LARGE: %', NEW.key USING ERRCODE = 'P0001';
  END IF;
  IF envelope->>'outputDigest' IS DISTINCT FROM encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_DIGEST_MISMATCH: %', NEW.key USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO anchor FROM project.ccc_planning_runs r
   WHERE r.project_id = NEW.project_id AND r.planning_task_id = NEW.task_id
   FOR SHARE;
  IF NOT FOUND OR anchor.run_id IS DISTINCT FROM envelope->>'runId'
     OR (envelope->>'runRevision')::integer <> anchor.revision THEN
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_RUN_MISMATCH: % does not belong to the current revision of the run on task %',
      NEW.key, NEW.task_id USING ERRCODE = 'P0001';
  END IF;

  fence := envelope->'fence';
  IF fence->>'kind' = 'admission' THEN
    IF stage <> 'admission' OR anchor.state <> 'admitted' THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % admission fence', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'work_item_lease' THEN
    IF stage IN ('admission', 'operator', 'g7', 'g8') OR fence->>'runId' IS DISTINCT FROM anchor.run_id
       OR NOT EXISTS (
         SELECT 1 FROM project.workflow_work_items w
          WHERE w.project_id = NEW.project_id AND w.id = fence->>'workItemId'
            AND w.task_id = NEW.task_id AND w.run_id = fence->>'runId' AND w.state = 'running'
            AND w.lease_owner = fence->>'leaseOwner' AND w.attempt = (fence->>'attempt')::integer
            AND w.lease_expires_at IS NOT NULL AND w.lease_expires_at::timestamptz > clock_timestamp()) THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % work item lease', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'campaign_work_item_lease' THEN
    IF stage NOT IN ('g7', 'g8') OR anchor.import_id IS NULL
       OR anchor.state NOT IN ('building', 'awaiting_execution_authority')
       OR fence->>'runId' IS DISTINCT FROM ('ccc-prd:' || anchor.import_id)
       OR NOT EXISTS (
         SELECT 1 FROM project.workflow_work_items w
          WHERE w.project_id = NEW.project_id AND w.id = fence->>'workItemId'
            AND w.run_id = fence->>'runId' AND w.state = 'running'
            AND w.lease_owner = fence->>'leaseOwner' AND w.attempt = (fence->>'attempt')::integer
            AND w.lease_expires_at IS NOT NULL AND w.lease_expires_at::timestamptz > clock_timestamp()) THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % campaign work item lease', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSIF fence->>'kind' = 'operator' THEN
    IF stage <> 'operator'
       OR envelope->>'kind' NOT IN ('operator_answer', 'build_grant', 'budget_amendment')
       OR coalesce(fence->>'runRevision', '') !~ '^[1-9][0-9]{0,2}$'
       OR coalesce(fence->>'controlSeq', '') !~ '^[0-9]{1,9}$'
       OR (fence->>'runRevision')::integer <> anchor.revision
       OR (fence->>'controlSeq')::integer <> anchor.control_seq THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % operator fence', NEW.key USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_FENCE_REFUSED: % unknown fence kind', NEW.key USING ERRCODE = 'P0001';
  END IF;

  FOR input_ref IN SELECT value FROM jsonb_array_elements(envelope->'inputs') LOOP
    IF NOT EXISTS (
      SELECT 1 FROM project.task_documents d
       WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
         AND d.key LIKE 'cccplan-%' AND d.key = input_ref->>'artifactKey'
         AND d.metadata->>'outputDigest' = input_ref->>'digest') THEN
      RAISE EXCEPTION 'CCC_PLANNING_ARTIFACT_INPUT_UNPUBLISHED: % requires % at %',
        NEW.key, input_ref->>'artifactKey', input_ref->>'digest' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF envelope->>'kind' = 'design_alternative' AND EXISTS (
    WITH RECURSIVE closure(artifact_key) AS (
      SELECT value->>'artifactKey' FROM jsonb_array_elements(envelope->'inputs')
      UNION
      SELECT parent.value->>'artifactKey'
        FROM closure c
        JOIN project.task_documents d
          ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
        CROSS JOIN LATERAL jsonb_array_elements(d.metadata->'inputs') AS parent(value)
    )
    SELECT 1 FROM closure c
      JOIN project.task_documents d
        ON d.project_id = NEW.project_id AND d.task_id = NEW.task_id AND d.key = c.artifact_key
     WHERE d.metadata->>'kind' = 'design_alternative'
  ) THEN
    RAISE EXCEPTION 'CCC_PLANNING_DESIGN_SEAL_BROKEN: % may not depend on another design alternative', NEW.key
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE row triggers fire in name order; 'zz_' runs after project-id assignment.
DROP TRIGGER IF EXISTS zz_ccc_planning_artifact_guard ON project.task_documents;
CREATE TRIGGER zz_ccc_planning_artifact_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project.task_documents
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_artifact_guard();
