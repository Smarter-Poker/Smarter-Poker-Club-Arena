-- Rollback for 20260918064540_the_fee_cutover_cannot_strand_a_game_it_did_not_witness.sql
--
-- Removing this guard restores the state in which a fee-evidence cutover can be
-- armed over games whose fees were already charged. That is what happened at
-- 2026-09-17 18:24:02: 550 tournaments froze, decided by the cards with their
-- winners unpaid and 1,901 horse entries seated in games that could not end,
-- and the engine raised a critical money alert on every one of the 1,491 finish
-- refusals that followed. There is no reason to run this.

BEGIN;

DROP TRIGGER IF EXISTS ca_fee_cutover_is_drained ON public.accounting_tournament_fee_cutover;
DROP FUNCTION IF EXISTS public.fn_ca_guard_fee_cutover_is_drained();
DROP FUNCTION IF EXISTS public.fn_ca_fee_cutover_stranded_by(timestamptz);

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid = 'public.accounting_tournament_fee_cutover'::regclass
       AND t.tgname = 'ca_fee_cutover_is_drained'
  ) THEN
    RAISE EXCEPTION 'rollback: the guard trigger is still installed';
  END IF;
END
$post$;

COMMIT;
