-- 20260905102140_phase_5_gate_every_new_door_is_registered_and_no_sweep_moves.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5 gate, 2026-09-05 10:2x UTC):
--
-- The gate before Phase 6 read fn_ca_money_rpc_drift() and found four doors
-- other agents created since the registry was last reconciled, each already
-- filed as rpc-drift:<name>. Each was read, not assumed:
--
--   fn_cash_seat_move_execute / fn_cash_seat_swap_execute: move a stack
--     between two cash tables of one game (source stack set to 0 then left,
--     destination seat created or filled with the same stack). The felt total
--     is unchanged, no wallet is touched, no leg is owed; both check the
--     freeze. Approved as felt-internal.
--   fn_cash_cluster_tick: the cluster's minute tick; its only money path is a
--     forced second-chair cash-out through atomic_seat_cashout_locked with
--     table_cashout declared; checks the freeze. Approved.
--   fn_union_clawback_promo_from_club: club promo wallet back to the union
--     promo wallet, declared (promo, union_wallet counterparty, keyed
--     union_promo_clawback:<op>, autoskip union_wallets), union manager check
--     on auth.uid(), FOR UPDATE on both rows, refuses below zero. Approved.
--
-- And the one sweep named for its owner in the 07:57 note is closed here:
-- fn_redrive_unbanked_rake runs from the same minute tick as the BBJ repair
-- and now returns empty while the platform is frozen (section 13 rule 5).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_redrive_unbanked_rake(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_hand uuid; v_ok int := 0; v_failed int := 0; v_already int := 0;
BEGIN
  -- CHIP STANDARD (2026-09-05): a sweep that moves money checks the freeze
  -- (CLAUDE.md section 13 rule 5). This runs every minute from pg_cron, which
  -- does not stop for the break; during it every redrive hit the guard on
  -- clubs and burned an attempt. It returns empty and redrives after play
  -- resumes.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', true, 'frozen', true, 'redriven', 0, 'already_banked', 0, 'failed', 0);
  END IF;
  FOR r IN SELECT p.* FROM public.pending_fee_distributions p
           WHERE p.resolved_at IS NULL AND p.kind = 'rake'
           ORDER BY p.created_at
           LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    v_hand := r.hand_id;
    IF v_hand IS NULL AND r.hand_number >= 1000000 THEN
      SELECT id INTO v_hand FROM public.hand_history WHERE hand_number = r.hand_number LIMIT 1;
    END IF;
    IF v_hand IS NOT NULL AND EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = v_hand) THEN
      UPDATE public.pending_fee_distributions
         SET resolved_at = now(), last_error = COALESCE(last_error, '') || ' [already banked]'
       WHERE id = r.id;
      v_already := v_already + 1;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.club_id, v_hand, r.hand_number::integer, r.rake, r.bbj,
        r.pot, r.num_players, r.contributions, r.tournament_id,
        r.returned_uncalled, COALESCE(r.rake_method, 'DEALT_EQUAL'));
      UPDATE public.pending_fee_distributions
         SET resolved_at = now(), attempts = COALESCE(attempts, 0) + 1, last_attempt_at = now()
       WHERE id = r.id;
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      UPDATE public.pending_fee_distributions
         SET attempts = COALESCE(attempts, 0) + 1, last_attempt_at = now(),
             last_error = left(SQLERRM, 500)
       WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'redriven', v_ok,
    'already_banked', v_already, 'failed', v_failed);
END $function$;
REVOKE ALL ON FUNCTION public.fn_redrive_unbanked_rake(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_redrive_unbanked_rake(integer) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_cash_seat_move_execute', 'approved', 'chip standard gate 2026-09-05: moves a stack between two cash tables of one game; felt total unchanged, no wallet touched, no leg owed; checks the freeze'),
  ('fn_cash_seat_swap_execute', 'approved', 'chip standard gate 2026-09-05: swaps two stacks between cash tables of one game; felt total unchanged, no wallet touched, no leg owed; checks the freeze'),
  ('fn_cash_cluster_tick', 'approved', 'chip standard gate 2026-09-05: cluster minute tick; the only money path is a forced second-chair cash-out through atomic_seat_cashout_locked with table_cashout declared; checks the freeze'),
  ('fn_union_clawback_promo_from_club', 'approved', 'chip standard gate 2026-09-05: club promo wallet -> union promo wallet, declared promo with union_wallet counterparty, keyed union_promo_clawback:<op>; union manager check; refuses below zero'),
  ('fn_redrive_unbanked_rake', 'approved', 'chip standard gate 2026-09-05: redrives pending rake distributions through atomic_distribute_rake; moves nothing itself; returns empty while the platform is frozen')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905102140_phase_5_gate_every_new_door_is_registered_and_no_sweep_moves',
       root_cause = 'a money door was created by another agent without a ca_money_rpc_registry row; the drift check filed it. Read at the Phase 5 gate: the door declares its ledger or moves nothing off the felt, and is registered with what it does',
       resolution = 'registered; fn_ca_money_rpc_drift() returns no rows'
 WHERE dedupe_key IN ('rpc-drift:fn_cash_seat_move_execute', 'rpc-drift:fn_cash_seat_swap_execute', 'rpc-drift:fn_cash_cluster_tick', 'rpc-drift:fn_union_clawback_promo_from_club')
   AND status = 'open';

-- Two rpc-drift incidents from 09-02 outlived the registrations that answered
-- them (fn_ca_burn: the Mint, registered 09-04; fn_ca_backpay_guarantee_shortfalls:
-- registered by its own migration). The check has not returned either since.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905102140_phase_5_gate_every_new_door_is_registered_and_no_sweep_moves',
       root_cause = 'the door was registered after the incident was filed and the incident was never closed; fn_ca_money_rpc_drift() has not returned it since',
       resolution = 'closed at the Phase 5 gate; the registry row stands'
 WHERE dedupe_key IN ('rpc-drift:fn_ca_burn', 'rpc-drift:fn_ca_backpay_guarantee_shortfalls') AND status = 'open'
   AND EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = substr(dedupe_key, 11));

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_ca_money_rpc_drift();
  IF v_n <> 0 THEN RAISE EXCEPTION 'money rpc drift is not zero: %', v_n; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_redrive_unbanked_rake') NOT LIKE '%fn_platform_frozen()%' THEN
    RAISE EXCEPTION 'fn_redrive_unbanked_rake does not check the freeze';
  END IF;
  IF (SELECT count(*) FROM public.ca_drift_incidents WHERE dedupe_key LIKE 'rpc-drift:%' AND status = 'open') <> 0 THEN
    RAISE EXCEPTION 'an rpc-drift incident is still open';
  END IF;
END $$;

COMMIT;
