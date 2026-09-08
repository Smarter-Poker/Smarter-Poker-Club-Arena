-- 20260908203000_certified_solver_identity_text_is_canonical
--
-- Pio startup attests show_version byte-for-byte.  The original manifest
-- reader trimmed that value only for the executable comparison while keeping
-- the untrimmed text in signed provenance, allowing one logical solver build
-- to acquire two identities.  Preserve exact provenance by refusing leading
-- or trailing whitespace, control characters, and oversized identity text at
-- the database authority as well as at both gateway clients.

ALTER TABLE public.gto_v31_datasets
  ADD CONSTRAINT gto_v31_datasets_solver_version_canonical_chk CHECK (
    length(solver_version) BETWEEN 1 AND 120
    AND solver_version !~ '^[[:space:]]|[[:space:]]$'
    AND solver_version !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT gto_v31_datasets_manifest_version_canonical_chk CHECK (
    length(manifest_version) BETWEEN 1 AND 160
    AND manifest_version !~ '^[[:space:]]|[[:space:]]$'
    AND manifest_version !~ '[[:cntrl:]]'
  );

DO $assert$
DECLARE
  v_solver_check text;
  v_manifest_check text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO v_solver_check
    FROM pg_constraint
   WHERE conrelid='public.gto_v31_datasets'::regclass
     AND conname='gto_v31_datasets_solver_version_canonical_chk';
  SELECT pg_get_constraintdef(oid)
    INTO v_manifest_check
    FROM pg_constraint
   WHERE conrelid='public.gto_v31_datasets'::regclass
     AND conname='gto_v31_datasets_manifest_version_canonical_chk';
  IF v_solver_check IS NULL OR v_manifest_check IS NULL
     OR position('solver_version' IN v_solver_check)=0
     OR position('manifest_version' IN v_manifest_check)=0 THEN
    RAISE EXCEPTION 'certified solver identity constraints were not installed';
  END IF;
END;
$assert$;
