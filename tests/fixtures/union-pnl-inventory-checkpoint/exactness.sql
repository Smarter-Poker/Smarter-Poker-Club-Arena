-- One randomized history: the new reader must equal the previous reader at
-- every boundary, with no checkpoint, with checkpoints sealed in order, with a
-- legacy-verified seal, and with an earlier boundary sealed last.
\set ON_ERROR_STOP 1
SELECT public.fixture_generate(:seed, :rows, :clean);
CREATE TABLE fixture_legacy AS SELECT b, public.fn_union_pnl_inventory_as_of_legacy(b) r FROM public.fixture_boundaries() b;
SELECT public.fixture_check('no checkpoint');
SELECT public.fn_union_pnl_inventory_checkpoint_seal('2026-08-17 07:00+00')->>'status';
SELECT public.fixture_check('sealed 08-17 from the capture');
SELECT public.fn_union_pnl_inventory_checkpoint_seal('2026-08-24 07:00+00')->>'status';
SELECT public.fixture_check('sealed 08-24 from 08-17');
SELECT public.fn_union_pnl_inventory_checkpoint_seal('2026-08-31 07:00+00', true)->>'legacy_verified';
SELECT public.fixture_check('sealed 08-31 from 08-24, legacy verified');
SELECT public.fn_union_pnl_inventory_checkpoint_seal('2026-08-10 07:00+00')->>'status';
SELECT public.fixture_check('sealed 08-10 after the later ones');
SELECT 'COVERAGE '||(public.fixture_coverage()||jsonb_build_object('observed_boundaries',(SELECT count(*) FROM fixture_legacy WHERE r->>'status'='observed')))::text;
