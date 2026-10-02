-- Production correctly refused the welcome allocator's undeclared synthetic
-- counterparty. Keep the audited transfer shape and use the declared opening
-- allocation clearing store instead:
--
--   club_treasury -> opening_setup -> bbj_pool
--   club_treasury -> opening_setup -> spin_reserve
--
-- opening_setup nets to zero in the same transaction. This migration changes
-- no balance, club, player, game, tournament, history, or ledger row.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $repair$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text :=
    'PERFORM set_config(''app.ledger_counterparty'',''welcome_package'',true);';
  v_replacement constant text :=
    'PERFORM set_config(''app.ledger_counterparty'',''opening_setup'',true);';
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
    SELECT 1 FROM public.ca_chip_store_coverage
     WHERE store='opening_setup' AND treatment='counted'
       AND counted_by='leaderboard_liability'
  ) THEN
    RAISE EXCEPTION 'WELCOME_LEDGER_CLEARING_STORE_NOT_DECLARED';
  END IF;

  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)=1
     AND (length(v_def)-length(replace(v_def,v_replacement,'')))/length(v_replacement)=0 THEN
    v_new:=replace(v_def,v_anchor,v_replacement);
    EXECUTE v_new;
  ELSIF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)=0
        AND (length(v_def)-length(replace(v_def,v_replacement,'')))/length(v_replacement)=1 THEN
    NULL; -- a fresh database received the corrected core definition
  ELSE
    RAISE EXCEPTION 'WELCOME_LEDGER_COUNTERPARTY_PREIMAGE_DRIFT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid='public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure
       AND prosrc LIKE '%welcome_package%'
  ) THEN
    RAISE EXCEPTION 'WELCOME_LEDGER_COUNTERPARTY_POSTCONDITION_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid='public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure
       AND prosrc LIKE '%set_config(''app.ledger_counterparty'',''opening_setup'',true)%'
  ) THEN
    RAISE EXCEPTION 'WELCOME_LEDGER_COUNTERPARTY_POSTCONDITION_FAILED';
  END IF;
END
$repair$;

UPDATE public.ca_money_rpc_registry
   SET notes='Private lifetime-first club welcome allocator. Runs only inside the owner-bound idempotent provisioning transaction; moves the reviewed BBJ and Poker Spins seeds from clubs.chip_treasury through the already-declared opening_setup clearing store into bbj_pools and spin_bonus_pools, with keyed club_welcome_allocation ledger context. The clearing store nets to zero atomically. Diamond Spins remain owner-acceptance-required and receive no automatic funds.'
 WHERE proname='fn_apply_club_welcome_economics'
   AND status='approved';

COMMIT;
