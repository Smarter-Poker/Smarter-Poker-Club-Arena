-- 20261002010726_welcome_allocations_use_the_declared_opening_category
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 01:07:26 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Production correctly refused the welcome allocator's new category because
-- chip_ledger_category_check admits the existing opening-allocation category,
-- not a welcome-only alias. Preserve the reviewed transfer and idempotency
-- shape while using the declared category already owned by opening setup.
-- This migration changes no balance, club, player, game, tournament, history,
-- or ledger row.
-- @live-proof: (SELECT p.prosrc LIKE '%set_config(''app.ledger_category'',''club_opening_allocation'',true)%' AND p.prosrc NOT LIKE '%club_welcome_allocation%' FROM pg_proc p WHERE p.oid = 'public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $repair$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text :=
    'PERFORM set_config(''app.ledger_category'',''club_welcome_allocation'',true);';
  v_replacement constant text :=
    'PERFORM set_config(''app.ledger_category'',''club_opening_allocation'',true);';
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure
  ) INTO v_def;

  IF NOT EXISTS (
    SELECT 1 FROM public.ca_money_rpc_registry
     WHERE proname='fn_apply_club_welcome_economics' AND status='approved'
  ) THEN
    RAISE EXCEPTION 'WELCOME_ECONOMICS_WRITER_NOT_APPROVED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.chip_ledger'::regclass
       AND conname='chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%club_opening_allocation%'
  ) THEN
    RAISE EXCEPTION 'WELCOME_LEDGER_OPENING_CATEGORY_NOT_DECLARED';
  END IF;

  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)=1
     AND (length(v_def)-length(replace(v_def,v_replacement,'')))/length(v_replacement)=0 THEN
    v_new:=replace(v_def,v_anchor,v_replacement);
    EXECUTE v_new;
  ELSIF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)=0
        AND (length(v_def)-length(replace(v_def,v_replacement,'')))/length(v_replacement)=1 THEN
    NULL; -- a fresh database received the corrected core definition
  ELSE
    RAISE EXCEPTION 'WELCOME_LEDGER_CATEGORY_PREIMAGE_DRIFT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid='public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure
       AND prosrc LIKE '%club_welcome_allocation%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid='public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure
       AND prosrc LIKE '%set_config(''app.ledger_category'',''club_opening_allocation'',true)%'
  ) THEN
    RAISE EXCEPTION 'WELCOME_LEDGER_CATEGORY_POSTCONDITION_FAILED';
  END IF;
END
$repair$;

UPDATE public.ca_money_rpc_registry
   SET notes=replace(notes,'club_welcome_allocation','club_opening_allocation')
 WHERE proname='fn_apply_club_welcome_economics'
   AND status='approved';

COMMIT;
