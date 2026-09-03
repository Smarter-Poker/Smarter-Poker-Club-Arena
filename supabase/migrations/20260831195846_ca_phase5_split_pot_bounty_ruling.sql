-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831195846; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_split_pot_bounty_ruling (prod 20260831195846). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5 ruling: tied pots split the bounty by claim weight (cents, largest remainder, conserving); fn_collect_bounty(p_claimants jsonb).

-- ZERO-DRIFT phase 5 — THE SPLIT-POT BOUNTY RULING, IMPLEMENTED.
-- Ruling (industry standard, chip-conserving): when a tied pot busts a
-- bounty player, the bounty splits across the tied winners BY CLAIM WEIGHT,
-- in cents, largest-remainder — the shares always sum to the payable bounty
-- exactly. In a PKO each winner's SHARE splits in half as usual: half cash,
-- half onto that winner's OWN head. The eliminated head is consumed once.
-- Single-winner knockouts behave byte-for-byte as before.
--
-- fn_collect_bounty gains p_claimants jsonb DEFAULT NULL
-- ([{user_id, weight}, ...]). The 3-arg form is dropped in the same
-- transaction so calls that omit the new argument resolve unambiguously to
-- this definition (no PostgREST overload ambiguity). Claimants not seated in
-- the tournament are ignored; if none survive validation the single-collector
-- path runs, so a knockout is never left unpaid by malformed input.
DROP FUNCTION IF EXISTS public.fn_collect_bounty(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.fn_collect_bounty(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_collector_user_id uuid,
  p_claimants jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_elim record;
  v_head numeric; v_available numeric; v_payable numeric;
  v_cash numeric; v_to_head numeric;
  v_cents integer; v_cash_cents integer;
  v_mode text; v_funded boolean;
  v_claimants jsonb; v_n integer; v_total_weight numeric;
  v_shares jsonb := '[]'::jsonb; v_paid_total numeric := 0; v_head_total numeric := 0;
  c record; v_share_cents integer; v_assigned_cents integer := 0; v_i integer := 0;
BEGIN
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         bounty_pool, bounty_pool_paid, mystery_bounty_stage
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
  END IF;

  -- HYBRID TRIPWIRE 2026-08-27. See migration header (a).
  IF COALESCE(v_t.is_pko, false) AND COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'undefined_pko_mystery_hybrid',
      'detail', 'PKO heads claim against bounty_pool; mystery chests are a sealed '
             || 'inventory. No split satisfies both. This event should not exist.');
  END IF;

  IF COALESCE(v_t.is_mystery_bounty, false) AND v_t.mystery_bounty_stage = 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_bounties
              WHERE tournament_id = p_tournament_id
                AND eliminated_player_id = p_eliminated_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;

  SELECT current_bounty INTO v_elim
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'eliminated_player_not_in_tournament');
  END IF;

  v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                 WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                 ELSE 'regular' END;

  v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;

  v_funded  := COALESCE(v_t.bounty_pool, 0) > 0;
  SELECT round(COALESCE(v_t.bounty_pool,0) - COALESCE(SUM(CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END), 0), 2) INTO v_available FROM wallet_transactions wt WHERE wt.related_entity_id = p_tournament_id AND wt.category = 'bounty';

  IF v_funded THEN
    IF v_available <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := LEAST(v_head, v_available);
  ELSE
    v_payable := v_head;
  END IF;

  -- ── SPLIT-POT RULING (2026-08-31): build the validated claimant list ──
  -- Claimants must be seated in this tournament with positive weight; a list
  -- that validates to nothing falls back to the single collector.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', x.uid, 'weight', x.w)), '[]'::jsonb)
    INTO v_claimants
  FROM (
    SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
    FROM jsonb_array_elements(COALESCE(p_claimants, '[]'::jsonb)) e
    WHERE (e->>'user_id') IS NOT NULL AND COALESCE((e->>'weight')::numeric, 0) > 0
      AND EXISTS (SELECT 1 FROM tournament_players tp
                  WHERE tp.tournament_id = p_tournament_id
                    AND tp.user_id = (e->>'user_id')::uuid)
  ) x;
  v_n := jsonb_array_length(v_claimants);
  IF v_n <= 1 THEN
    v_claimants := jsonb_build_array(jsonb_build_object('user_id', p_collector_user_id, 'weight', 1));
    v_n := 1;
  END IF;
  SELECT sum((e->>'weight')::numeric) INTO v_total_weight
    FROM jsonb_array_elements(v_claimants) e;

  v_cents := round(v_payable * 100)::integer;

  -- pay each claimant their weighted share (largest share absorbs remainder
  -- by paying LAST with whatever cents remain — exact conservation)
  FOR c IN
    SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
    FROM jsonb_array_elements(v_claimants) e
    ORDER BY (e->>'weight')::numeric ASC, (e->>'user_id')
  LOOP
    v_i := v_i + 1;
    IF v_i < v_n THEN
      v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;
    ELSE
      v_share_cents := v_cents - v_assigned_cents;  -- remainder to the last (largest) share
    END IF;
    v_assigned_cents := v_assigned_cents + v_share_cents;
    CONTINUE WHEN v_share_cents <= 0;

    IF v_mode = 'pko' THEN
      v_cash_cents := (v_share_cents / 2)::integer;
      v_cash       := v_cash_cents / 100.0;
      v_to_head    := (v_share_cents - v_cash_cents) / 100.0;
    ELSE
      v_cash := v_share_cents / 100.0; v_to_head := 0;
    END IF;

    IF v_cash > 0 THEN
      PERFORM public.credit_player_wallet(
        c.uid, v_cash,
        'tourney:' || p_tournament_id || ':bounty:' || p_eliminated_user_id
          || ':' || c.uid);
      PERFORM public.log_wallet_transaction(
        c.uid, 'PLAYER', v_cash, 'credit', 'bounty',
        CASE v_mode WHEN 'pko'         THEN 'PKO bounty (cash half) from eliminated player'
                    WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
                    ELSE 'Bounty collected from eliminated player' END
          || CASE WHEN v_n > 1 THEN ' (split pot, ' || v_n || ' winners)' ELSE '' END,
        NULL, NULL, p_tournament_id);
    END IF;

    UPDATE tournament_players
       SET bounties_collected = COALESCE(bounties_collected,0) + 1,
           bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
           current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
     WHERE tournament_id = p_tournament_id AND user_id = c.uid;

    INSERT INTO tournament_bounties
      (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
       added_to_collector_bounty, is_mystery_revealed)
    VALUES (p_tournament_id, p_eliminated_user_id, c.uid, round(v_share_cents / 100.0, 2),
            CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
            false);

    v_paid_total := v_paid_total + v_cash;
    v_head_total := v_head_total + v_to_head;
    v_shares := v_shares || jsonb_build_object('user_id', c.uid, 'cash', v_cash, 'to_head', v_to_head);
  END LOOP;

  UPDATE tournament_players SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  IF v_funded THEN
    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_paid_total, 2)
     WHERE id = p_tournament_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'funded', v_funded,
    'head', v_head, 'paid_cash', round(v_paid_total, 2), 'added_to_head', round(v_head_total, 2),
    'split', v_n > 1, 'shares', v_shares,
    'capped', v_funded AND v_payable < v_head,
    'pool_remaining', CASE WHEN v_funded THEN round(v_available - v_paid_total, 2) END);
END;
$function$;

INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_collect_bounty', 'phase 5: split-pot bounty ruling — weighted shares, largest-remainder cents, conserving')
ON CONFLICT (proname) DO NOTHING;
