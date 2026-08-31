-- 2026-08-31 — MTT Phase 3: the final-table deal writes its record ONCE.
--
-- fn_final_table_deal inserted one tournament_payouts row per player and then
-- came back with an UPDATE to add the rounding remainder to the chip leader's
-- row. Harmless on its own — and fatal to 20260831133057, which makes
-- tournament_payouts append-only. A payout record you can UPDATE is not a
-- record, so the fix is not to exempt the deal from the rule; it is to stop
-- the deal needing the exemption.
--
-- The remainder is now computed BEFORE anything is written: every share is
-- floored in one pass, the shortfall against the undistributed pool is worked
-- out, and the leader's single INSERT carries share + remainder. Same money,
-- same recipient, same ordering, one write.
--
-- Two other things this function needed and did not have:
--   * an idempotency_key on each row, in the SAME namespace the engine's
--     settleFinalTableDeal credits under (`tourney:{id}:ftd:{user}`), so the
--     record written here and the credit written there converge on one row
--     instead of producing two;
--   * `position`, which it never set. A deal has no finishing order in the
--     usual sense, so this stores the chip-order rank at the moment of the
--     deal — which IS the order the money was split by, and the only honest
--     answer available.
--
-- BEHAVIOUR PRESERVED EXACTLY: every guard and its reason string, the ordering
-- (chips DESC, registered_at ASC, user_id ASC), the leader selection, the
-- prize write-back to tournament_players, the COMPLETING transition, and the
-- returned jsonb shape.
--
-- PROVEN, NOT ASSERTED (probe inside a rolled-back transaction, three players
-- on 3334/3333/3333 chips against a 1000 pool):
--   return  = {"ok": true, "undistributed": 1000.00, "remainder_to_leader": 1.00}
--   rows    = pos=1 amt=334.00 | pos=2 amt=333 | pos=3 amt=333
--   count=3 sum=1000.00  — exact to the cent, one INSERT each, no UPDATE
--
-- TIER: 3 (money path). ROLLBACK: re-apply the body preserved verbatim in
-- supabase/migrations/20260822100400_fn_final_table_deal.sql. Doing so also
-- requires dropping trg_tournament_payouts_append_only, because the restored
-- insert-then-update body cannot run while it exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_final_table_deal(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t             record;
  v_remaining     integer;
  v_total_chips   numeric;
  v_awarded       numeric;
  v_undistributed numeric;
  v_paid_out      numeric := 0;
  v_share         numeric;
  v_leader        uuid;
  v_remainder     numeric;
  v_p             record;
  v_payouts       jsonb := '[]'::jsonb;
  v_shares        jsonb := '[]'::jsonb;
  v_rank          integer := 0;
  v_amount        numeric;
BEGIN
  SELECT id, status, prize_pool, final_table_deal_enabled, COALESCE(table_size, 9) AS table_size
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT COALESCE(v_t.final_table_deal_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_not_enabled');
  END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts
              WHERE tournament_id = p_tournament_id AND source = 'final_table_deal') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_already_executed');
  END IF;

  SELECT count(*), COALESCE(sum(GREATEST(chips, 0)), 0)
    INTO v_remaining, v_total_chips
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL;

  IF v_remaining < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_enough_players');
  END IF;
  IF v_remaining > v_t.table_size THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_at_final_table',
                              'detail', v_remaining);
  END IF;
  IF v_total_chips <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_chips_in_play');
  END IF;

  SELECT COALESCE(sum(prize), 0) INTO v_awarded
    FROM public.tournament_players WHERE tournament_id = p_tournament_id;
  SELECT v_awarded + COALESCE(sum(amount), 0) INTO v_awarded
    FROM public.tournament_payouts WHERE tournament_id = p_tournament_id;

  v_undistributed := GREATEST(COALESCE(v_t.prize_pool, 0) - v_awarded, 0);
  IF v_undistributed <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_undistributed_prize');
  END IF;

  SELECT user_id INTO v_leader
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL
   ORDER BY chips DESC, registered_at ASC, user_id ASC
   LIMIT 1;

  /* PASS 1 - price every seat, write nothing. */
  FOR v_p IN
    SELECT user_id, chips
      FROM public.tournament_players
     WHERE tournament_id = p_tournament_id
       AND status IN ('registered', 'playing')
       AND eliminated_at IS NULL
     ORDER BY chips DESC, registered_at ASC, user_id ASC
  LOOP
    v_rank  := v_rank + 1;
    v_share := floor(GREATEST(v_p.chips, 0) / v_total_chips * v_undistributed);
    v_paid_out := v_paid_out + v_share;
    v_shares := v_shares || jsonb_build_object(
      'user_id', v_p.user_id, 'share', v_share, 'rank', v_rank);
  END LOOP;

  /* The flooring shortfall, settled on the chip leader - as before, but
     decided before the first row is written instead of by an UPDATE after. */
  v_remainder := v_undistributed - v_paid_out;

  /* PASS 2 - one INSERT per player, final amount, never revisited. */
  FOR v_p IN SELECT * FROM jsonb_to_recordset(v_shares)
                        AS x(user_id uuid, share numeric, rank integer)
  LOOP
    v_amount := v_p.share
              + CASE WHEN v_remainder > 0 AND v_p.user_id = v_leader
                     THEN v_remainder ELSE 0 END;

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source,
       idempotency_key, tournament_type, field_size, prize_pool, recorded_by)
    VALUES
      (p_tournament_id, v_p.user_id, v_p.rank, v_amount, 'final_table_deal',
       'tourney:' || p_tournament_id::text || ':ftd:' || v_p.user_id::text,
       (SELECT tournament_type FROM public.tournaments WHERE id = p_tournament_id),
       v_remaining, v_t.prize_pool, 'final_table_deal')
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

    v_payouts := v_payouts || jsonb_build_object('user_id', v_p.user_id, 'amount', v_amount);
  END LOOP;

  UPDATE public.tournament_players tp
     SET prize = COALESCE(tp.prize, 0) + tpo.amount
    FROM public.tournament_payouts tpo
   WHERE tpo.tournament_id = p_tournament_id
     AND tpo.source = 'final_table_deal'
     AND tp.tournament_id = p_tournament_id
     AND tp.user_id = tpo.user_id;

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'undistributed', v_undistributed,
    'remainder_to_leader', v_remainder,
    'chip_leader', v_leader,
    'payouts', v_payouts);
END; $function$;

/* STATE THE GRANTS, DO NOT INHERIT THEM.
 *
 * CREATE OR REPLACE preserves the existing ACL, and in production this
 * function is already postgres + service_role only - no browser role can
 * reach it. But the file did not SAY so, and check-definer-authorization
 * blocked this push for exactly that reason: it reads the migration, not the
 * database, and a SECURITY DEFINER writer that moves money must not depend on
 * an ACL set somewhere else years ago. The day someone DROPs and re-creates
 * this function, the grant silently becomes EXECUTE to PUBLIC - which is the
 * trap already documented for fn_credit_and_log two migrations from here.
 *
 * fn_final_table_deal takes the actor from nothing at all: it settles a chop
 * for whichever tournament id it is handed. That is safe only while nobody in
 * a browser can call it, so the file now guarantees that itself. */
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid) TO service_role;

COMMIT;
