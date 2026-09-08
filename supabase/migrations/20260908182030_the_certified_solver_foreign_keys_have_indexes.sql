-- The Phase 4 certification tables are empty at installation, but their
-- parent-row updates and deletes must not become full scans once the corpus
-- is populated. Cover both foreign keys reported by the production advisor.

BEGIN;

CREATE INDEX IF NOT EXISTS gto_v31_datasets_input_bundle_id_idx
  ON public.gto_v31_datasets (input_bundle_id);

CREATE INDEX IF NOT EXISTS gto_v31_release_evaluations_source_result_id_idx
  ON public.gto_v31_release_evaluations (source_result_id);

COMMIT;
