-- FNXC:CccPrdImportStoppedState 2026-09-04:
-- Terminal state for an import an operator has closed.
--
-- A campaign whose stored manifest no longer reconstructs cannot be stopped
-- through any control that needs a product status, because status rebuilds
-- campaign custody. `fn prd stop-drifted` closes it without that rebuild, and
-- the close ends with the import row moving to 'stopped' so reconcile and a
-- replayed import both refuse it and stop re-projecting its task directories.
--
-- Only the state vocabulary widens. The state/runnable correlation is
-- unchanged and already covers the new value through its non-active branch
-- (state <> 'active' AND runnable = 0); it is restated here so the pairing is
-- visible in one place alongside the widened check, and because a database
-- created before that constraint existed would otherwise carry only the older
-- of the two.
--
-- Nothing transitions out of 'stopped'. There is deliberately no reverse
-- transition: the recorded stop reason on the row is the only durable record of
-- why the campaign was closed, and reopening would strand it.
ALTER TABLE project.ccc_prd_imports
  DROP CONSTRAINT IF EXISTS ccc_prd_imports_state_check;
ALTER TABLE project.ccc_prd_imports
  ADD CONSTRAINT ccc_prd_imports_state_check
    CHECK (state IN ('prepared', 'projecting', 'active', 'stopped'));

ALTER TABLE project.ccc_prd_imports
  DROP CONSTRAINT IF EXISTS ccc_prd_imports_state_runnable_check;
ALTER TABLE project.ccc_prd_imports
  ADD CONSTRAINT ccc_prd_imports_state_runnable_check
    CHECK ((state = 'active' AND runnable = 1) OR (state <> 'active' AND runnable = 0));
