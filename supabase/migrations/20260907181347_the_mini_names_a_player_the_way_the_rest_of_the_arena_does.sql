-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINI NAMES A PLAYER THE WAY THE REST OF THE ARENA DOES
--  BBJ build plan phase 6 of 6, correcting 20260907181202
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first cut of `fn_bbj_mini_payout` read `profiles.arena_name` for the
-- ticker's display names. **That column does not exist.** Every mini payout
-- would have aborted at the last statement with
-- `42703: column "arena_name" does not exist` - after the reserve was debited
-- and every recipient credited, so the whole transaction would have rolled
-- back and the jackpot simply would not have paid.
--
-- Nothing reached a player, because a rolled-back probe found it first
-- (CLAUDE.md 11.5: one call, one self-aborting DO block, and the error is the
-- success case). That is the entire argument for the rule.
--
-- The fix is not to invent a column: it is to call `fn_arena_name`, which is
-- what `fn_bbj_recent_hits` and the rest of the arena already use to turn a
-- profile into the name a player recognises. Reusing it is why a mini in the
-- ticker will read exactly like a main one.
--
-- Re-probed after this, rolled back, with zero residue confirmed:
--
--   applied true · kind mini · total 700.00 (the `small` tier)
--   loser 350.00 · winner 175.00 · table 175.00 · per player 87.50
--   backup_balance -700.00 · total_paid_out +700.00
--   4 recipient rows, 700.00 credited  ->  CONSERVES true
--   second call: applied false, already_paid true  (idempotent on the hand)
--   bbj_winners row written, winner_display_name resolved
--
-- ROLLBACK: the previous definition is in 20260907181202.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout(
  p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_tier_id text,
  p_loser_user_id uuid, p_winner_user_id uuid,
  p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(applied boolean, already_paid boolean, refused text,
              payout_id uuid, total_payout numeric, loser_share numeric,
              winner_share numeric, table_share numeric, per_player_share numeric,
              backup_after numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_backup numeric; v_floor numeric; v_amount numeric; v_enabled boolean;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric; v_per numeric;
  v_payout_id uuid; v_existing uuid; v_table_ids uuid[]; v_n_table integer;
  v_club_id uuid; v_uid uuid; v_remainder numeric; v_hand_id uuid;
  v_loser_name text; v_winner_name text;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout is service only' USING ERRCODE = '42501';
  END IF;

  /* The same kill switch the main jackpot honours, and the same error class,
     so the engine's queue retries a mini frozen mid-flight exactly as it
     retries a main one. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
              WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT amount, enabled INTO v_amount, v_enabled
    FROM public.bbj_mini_tiers WHERE tier_id = p_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'no_mini_amount_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* IDEMPOTENT ON THE HAND, and it shares the key with the main jackpot on
     purpose: bbj_payouts_pool_table_hand_uidx means one hand can produce one
     payout of either kind and never both. A mini only ever runs when
     detectBBJHit refused the main, so the two cannot race for the same hand -
     and if that ever stops being true, this is where it stops, not a second
     row nobody reconciles. */
  SELECT id INTO v_existing FROM public.bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table
      FROM public.bbj_payouts bp WHERE bp.id = v_existing;
    SELECT COALESCE(backup_balance,0) INTO v_backup FROM public.bbj_pools WHERE id = p_pool_id;
    RETURN QUERY SELECT false, true, NULL::text, v_existing, v_total, v_loser, v_winner,
      v_table, 0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(backup_balance,0), COALESCE(mini_reserve_floor, 0), club_id
    INTO v_backup, v_floor, v_club_id
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pool_not_found'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* THE FLOOR IS NOT NEGOTIABLE AND THE MINI IS NOT SHRUNK TO FIT.
     Paying a partial mini would publish one number to the player and pay
     another; a mini that cannot be paid in full is simply not owed. */
  IF v_backup - v_amount < v_floor THEN
    RETURN QUERY SELECT false, false, 'reserve_at_floor'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  v_total  := round(v_amount, 2);
  v_loser  := round(v_total * 0.50, 2);
  v_winner := round(v_total * 0.25, 2);
  v_table  := round(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := round(v_table / v_n_table, 2);
  ELSE
    /* Nobody else was dealt in: the table quarter goes to the player who took
       the beat rather than staying in a bank nobody can see. */
    v_per := 0;
    v_loser := round(v_loser + v_table, 2);
    v_table := 0;
  END IF;

  SELECT id INTO v_hand_id FROM public.hand_history
   WHERE table_id = p_table_id AND hand_number = p_hand_number
   ORDER BY created_at DESC LIMIT 1;

  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'bbj_pool', p_pool_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);
  UPDATE public.bbj_pools
     SET backup_balance = GREATEST(0, COALESCE(backup_balance,0) - v_total),
         /* The pool's own paid-out counter moves with every payout of either
            kind. fn_bbj_conservation_check compares that counter against the
            bbj_payouts rows (phase 5.3); a mini that wrote a row and left the
            counter behind would take `paid_without_a_payout_row_since`
            negative and the lifetime verdict false. */
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = now()
   WHERE id = p_pool_id
   RETURNING COALESCE(backup_balance,0) INTO v_backup;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count, kind, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,
          v_total, v_winner, v_loser, v_table, v_n_table, 'mini',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('tier_id', p_tier_id, 'funded_from', 'backup_reserve'))
  RETURNING id INTO v_payout_id;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser,
            p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner,
            p_winner_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  IF v_n_table > 0 AND v_per > 0 THEN
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per,
                v_uid = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END LOOP;
    /* Rounding remainder follows the main's rule: it stays with the beat. */
    v_remainder := round(v_table - (v_per * v_n_table), 2);
    IF v_remainder > 0 THEN
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_remainder,
                p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END IF;
  END IF;

  /* THE ARENA NAME, through the platform's own helper. The first cut of this
     function read `profiles.arena_name`, a column that does not exist, and a
     rolled-back probe (CLAUDE.md 11.5) found it before a single real hand
     could. fn_arena_name is what fn_bbj_recent_hits and the rest of the arena
     already use, and reusing it is why the mini ticker will show the same name
     the main one does. */
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_loser_name FROM public.profiles pr WHERE pr.id = p_loser_user_id;
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_winner_name FROM public.profiles pr WHERE pr.id = p_winner_user_id;

  INSERT INTO public.bbj_winners
    (club_id, pool_id, loser_id, winner_id, loser_payout, winner_payout,
     table_share_payout, total_payout, pool_amount_at_hit, stakes_tier,
     table_id, hand_number, awarded_at, winner_display_name, loser_display_name, kind)
  VALUES (v_club_id, p_pool_id, p_loser_user_id, p_winner_user_id, v_loser, v_winner,
          v_table, v_total, v_backup + v_total, p_tier_id,
          p_table_id, p_hand_number, now(), v_winner_name, v_loser_name, 'mini')
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;

  RETURN QUERY SELECT true, false, NULL::text, v_payout_id, v_total, v_loser, v_winner,
    v_table, v_per, v_backup;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can pay a mini jackpot';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the engine cannot pay a mini jackpot';
  END IF;
END $$;

COMMIT;
