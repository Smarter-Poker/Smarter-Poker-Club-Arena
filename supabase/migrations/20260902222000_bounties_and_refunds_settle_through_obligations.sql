-- ===========================================================================
--  BOUNTIES AND REFUNDS SETTLE THROUGH THE OBLIGATION FUNCTION
-- ===========================================================================
--
-- Chip Accounting Roadmap Phase 1.1 (docs/CHIP-ACCOUNTING-ROADMAP.md), the
-- standard's 3.2 MTT steps 6 and 8 and rule R3: the ONLY function that credits
-- a player from a tournament is fn_settle_tournament_obligation. The engine
-- cut over its own payers at 20:58 UTC on 2026-09-02; this migration re-points
-- the eight database-side payers that were still crediting players directly.
--
-- Measured on production 2026-09-02 ~22:00 UTC (SELECT-only, wallet_transactions
-- by description shape):
--
--   fn_collect_bounty              581 credits / 3,168.21 in 24h   (4,899 in 7d)
--   atomic_cancel_tournament       349 credits / 7,880.00 in 24h   (all spin expiries)
--   fn_finalize_bounty_pool         18 credits / 1,868.79 in 24h
--   fn_mystery_bounty_pay            9 credits /   130.60 in 24h
--   fn_mystery_bounty_settle         5 credits /    88.40 in 24h
--   atomic_tournament_unregister     0 in 24h, 3 in 7d (last 2026-08-30)
--   fn_unregister_from_tournament    0 in 24h, 1 in 7d (last 2026-09-01)
--   fn_leave_seat_and_refund         0 in 24h, 1 in 7d (last 2026-08-29)
--
-- Every one of those rows landed in ca_money_path_violations (R3 log-only):
-- 108 bounty rows and 130 refund rows in the six hours before this migration,
-- all with money_path NULL. After it, every row these paths write carries
-- app.money_path = 'fn_settle_tournament_obligation' by construction, because
-- the settle function stamps it around the credit.
--
-- THE PHANTOM ROW (standard 2.6), reproduced in a rolled-back probe before this
-- migration on PKO f56e23ae: with the knockout's idempotency key already spent,
-- fn_collect_bounty paid nothing (credit_player_wallet returned false) and
-- still wrote a wallet_transactions 'bounty' credit of 5.00, reported
-- paid_cash 5.00, and fn_finalize_bounty_pool would then have subtracted that
-- 5.00 from the residual it computes. The log is now inside the settle path
-- and written only when chips moved.
--
-- HOW THE CUMULATIVE TOTAL IS BUILT. Bounty, bounty_residual, mystery_bounty
-- and refund obligations are user-keyed (UNIQUE (tournament, kind, user)) and
-- p_amount is the TOTAL owed. Each caller passes
--     (amount_paid already on that obligation row, 0 when none) + this award
-- so a fresh award always pays exactly the award, an obligation row created
-- before this migration is never double-counted, and legacy credits made
-- under the old key shapes for an event still running at apply time are simply
-- outside the obligation (the obligation begins with the first post-migration
-- award; nothing is re-paid). Refund callers pass the gross entry charge
-- (buy-in + fee, standard S13) plus the refund credits already on the ledger,
-- and the settle function seeds a new refund obligation from those same
-- credits, so a cancel after an unregister pays the difference and a replay
-- pays 0.
--
-- WHAT DOES NOT CHANGE (kept verbatim from the live pg_get_functiondef bodies,
-- read 2026-09-02 22:00 UTC, not from the stale repo mirror): the split-pot
-- claimant validation and cent-exact remainder rule, PKO half-to-head, the
-- hybrid tripwire, the mystery-phase gate, bounty_pool_paid accounting, every
-- refusal reason, every description string (the audits and the escrow shadow
-- read them), the jsonb return shapes the engine reads (keys compared in the
-- probe: added_to_head,capped,funded,head,mode,ok,paid_cash,pool_remaining,
-- shares,split), and every grant.
--
-- WHAT CHANGES BESIDES THE PAYER:
--   * A settle refusal inside a knockout, a residual or a mystery settlement
--     RAISES, so the whole call rolls back and the state stays retryable (no
--     half-recorded knockout with money unpaid). The only refusal the settle
--     function can return for these kinds is payout_frozen, Dan's kill switch
--     (Lane E, ca_payout_freeze); the bounty paths simply honour it now, as
--     every other tournament payment already does.
--   * fn_mystery_bounty_pay keeps its own retryable shape (a refused recipient
--     leaves the award incomplete and files the critical alert, as before).
--   * atomic_cancel_tournament keeps its shape too: a refused refund is
--     skipped and the deferred trigger tournaments_cancel_must_refund refuses
--     the cancel at commit, exactly as it does today for a refused credit.
--   * The unregister and seat-release refunds settle BEFORE the registration
--     row is deleted, so the settle key (tourney:<t>:obl:...) resolves the
--     club the player bought in from (tournament_players.club_id) instead of
--     the home-club fallback.
--   * No tournament_payouts row is written for bounty kinds. None has been
--     written live for bounties since the 2026-08-31 backfill (every
--     source in ('bounty','own_bounty','mystery_bounty_residual') row carries
--     recorded_by = 'backfill_2026_08_31'); the wallet_transactions 'bounty'
--     row that the settle path writes is what fn_finalize_bounty_pool,
--     fn_mystery_bounty_settle and fn_ca_tournament_escrow read, so their
--     residual and bounty_out arithmetic is unchanged.
--
-- NO MONEY MOVES BY THIS MIGRATION. It replaces function bodies only. No
-- table, no trigger, no hot-table lock.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. fn_collect_bounty: every knockout settles kind 'bounty' per claimant
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid, p_claimants jsonb DEFAULT NULL::jsonb)
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
  v_prior numeric; v_settle jsonb; v_desc text;
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

  -- SPLIT-POT RULING (2026-08-31): build the validated claimant list.
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

  v_desc := CASE v_mode WHEN 'pko'         THEN 'PKO bounty (cash half) from eliminated player'
                        WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
                        ELSE 'Bounty collected from eliminated player' END
            || CASE WHEN v_n > 1 THEN ' (split pot, ' || v_n || ' winners)' ELSE '' END;

  -- pay each claimant their weighted share (largest share absorbs remainder
  -- by paying LAST with whatever cents remain - exact conservation)
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
      /* ONE PAYER (Chip Accounting Standard R3, 2026-09-02). The bounty
         obligation for this player is user-keyed and cumulative: what the row
         already paid plus this share is the new total owed, and the settle
         function pays the difference under its own key, stamps
         app.money_path, and writes the 'bounty' ledger row ONLY when chips
         moved. A replay of the same knockout is stopped above by
         tournament_bounties (already_collected) and, below that, by the
         obligation itself (a total that is not higher pays 0). */
      v_prior := COALESCE((SELECT o.amount_paid FROM public.tournament_obligations o
                            WHERE o.tournament_id = p_tournament_id AND o.kind = 'bounty'
                              AND o.place IS NULL AND o.user_id = c.uid), 0);
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id, 'bounty', NULL, c.uid, round(v_prior + v_cash, 2),
        'fn_collect_bounty', v_desc);
      IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'fn_collect_bounty: bounty of % to % in tournament % refused (%); nothing recorded',
          v_cash, c.uid, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
      END IF;
      IF round(COALESCE((v_settle->>'paid')::numeric, 0), 2) <> round(v_cash, 2) THEN
        RAISE EXCEPTION 'fn_collect_bounty: obligation paid % but the share is % for % in tournament %; nothing recorded',
          v_settle->>'paid', v_cash, c.uid, p_tournament_id;
      END IF;
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

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid, uuid, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. fn_finalize_bounty_pool: the champion's residual settles kind 'bounty_residual'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t        record;
  v_residual numeric;
  v_own      numeric;
  v_paid     numeric;
  v_prior    numeric;
  v_settle   jsonb;
BEGIN
  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool, bounty_pool_paid
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
  END IF;

  IF COALESCE(v_t.bounty_pool, 0) <= 0 THEN
    -- Legacy unfunded event: pay the champion their own remaining head, which
    -- is what the pre-funding-model code did.
    SELECT COALESCE(NULLIF(current_bounty,0), NULLIF(mystery_bounty_value,0), 0)
      INTO v_own FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    IF COALESCE(v_own,0) <= 0 OR p_winner_user_id IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'residual', 0, 'funded', false);
    END IF;
    /* ONE PAYER (R3, 2026-09-02): user-keyed cumulative 'bounty_residual'.
       The old key tourney:<t>:ownbounty:<winner> carried no amount, so a
       second run with a larger residual paid nothing (standard 2.6); the
       obligation total rises with it and the difference is what moves. */
    v_prior := COALESCE((SELECT o.amount_paid FROM public.tournament_obligations o
                          WHERE o.tournament_id = p_tournament_id AND o.kind = 'bounty_residual'
                            AND o.place IS NULL AND o.user_id = p_winner_user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id, 'bounty_residual', NULL, p_winner_user_id, round(v_prior + v_own, 2),
      'fn_finalize_bounty_pool', 'Tournament champion: own bounty head collected');
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'fn_finalize_bounty_pool: own bounty head of % to % in tournament % refused (%)',
        v_own, p_winner_user_id, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;
    UPDATE tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_own, 2),
           current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    RETURN jsonb_build_object('ok', true, 'residual', v_own, 'funded', false,
                              'paid_to', p_winner_user_id);
  END IF;

  /**
   * MEASURED FROM THE LEDGER (2026-08-29). `bounty_pool_paid` is a counter
   * that fn_collect_bounty increments as knockouts settle, and this function
   * runs while collections are still landing -- so reading it produced an
   * "unclaimed" residual for money that was about to be claimed, and paid it
   * to the champion on top of a pool the knockers went on to exhaust.
   *
   * The ledger cannot be stale relative to the money: it IS the money. Signed
   * off `type`, because a corrective debit is not a payment.
   */
  SELECT round(COALESCE(SUM(
           CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END
         ), 0), 2)
    INTO v_paid
    FROM wallet_transactions wt
   WHERE wt.related_entity_id = p_tournament_id
     AND wt.category = 'bounty';

  v_residual := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_paid,0), 2);

  -- Keep the counter honest even when nothing is owed, so the next reader is
  -- not misled the way this function was.
  IF COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM COALESCE(v_paid,0) THEN
    UPDATE tournaments SET bounty_pool_paid = COALESCE(v_paid,0) WHERE id = p_tournament_id;
  END IF;

  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'residual', GREATEST(v_residual,0),
                              'funded', true, 'ledger_paid', v_paid);
  END IF;

  /* ONE PAYER (R3, 2026-09-02): see the unfunded branch above. The residual
     is measured net of every 'bounty' ledger row, including any earlier
     residual this obligation already paid, so the new total is prior + this. */
  v_prior := COALESCE((SELECT o.amount_paid FROM public.tournament_obligations o
                        WHERE o.tournament_id = p_tournament_id AND o.kind = 'bounty_residual'
                          AND o.place IS NULL AND o.user_id = p_winner_user_id), 0);
  v_settle := public.fn_settle_tournament_obligation(
    p_tournament_id, 'bounty_residual', NULL, p_winner_user_id, round(v_prior + v_residual, 2),
    'fn_finalize_bounty_pool', 'Unclaimed bounty pool awarded to champion');
  IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool: residual of % to % in tournament % refused (%)',
      v_residual, p_winner_user_id, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
  END IF;

  UPDATE tournaments
     SET bounty_pool_paid = round(COALESCE(v_paid,0) + v_residual, 2)
   WHERE id = p_tournament_id;
  UPDATE tournament_players
     SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_residual, 2),
         current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;

  RETURN jsonb_build_object('ok', true, 'residual', v_residual, 'funded', true,
                            'ledger_paid', v_paid, 'paid_to', p_winner_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. fn_mystery_bounty_pay: each revealed chest settles kind 'mystery_bounty'
--    (user-keyed cumulative: one player can open several chests in one event)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean; v_refused int := 0;
  v_chest_status text;
  v_prior numeric; v_settle jsonb;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;

  -- SETTLED IS SETTLED (2026-08-30). fn_mystery_bounty_settle swept this chest
  -- to the champion and voided the award in the same transaction. Paying it
  -- again mints the chest a second time under a different idempotency key.
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_voided_by_settlement',
                              'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_settled_to_champion',
                              'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id AND paid_at IS NULL AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    /* ONE PAYER (R3, 2026-09-02). The recipient row (paid_at) is the replay
       guard for this chest; the obligation is the cumulative mystery total for
       this player in this event, so a second chest is a higher total, never a
       denied one. A refusal leaves the recipient unpaid and the award
       incomplete, exactly as a refused fn_credit_and_log did. */
    v_prior := COALESCE((SELECT o.amount_paid FROM public.tournament_obligations o
                          WHERE o.tournament_id = v_a.tournament_id AND o.kind = 'mystery_bounty'
                            AND o.place IS NULL AND o.user_id = v_r.user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      v_a.tournament_id, 'mystery_bounty', NULL, v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay', 'Mystery bounty revealed from eliminated player');
    v_credited := COALESCE((v_settle->>'ok')::boolean, false);

    IF COALESCE(v_credited, false) THEN
      UPDATE public.tournament_bounty_award_recipients SET paid_at = now() WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id AND user_id = v_r.user_id;

      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;
    ELSE
      v_refused := v_refused + 1;
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  IF v_refused = 0 THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'paid' WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_mystery_bounty_pay',
            'Mystery bounty award left incomplete: a recipient credit was refused',
            jsonb_build_object('award_id', p_award_id,
                               'tournament_id', v_a.tournament_id,
                               'refused_recipients', v_refused,
                               'paid_cents', v_paid,
                               'award_cents', v_a.amount_cents,
                               'refused_reason', v_settle->>'refused_reason',
                               'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. fn_mystery_bounty_settle: the champion's unclaimed chests settle kind
--    'mystery_bounty' on the same cumulative row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
  v_award record;
  v_funded numeric; v_ledger numeric;
  v_room bigint; v_residual bigint;
  v_prior numeric; v_settle jsonb;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0), COALESCE(bounty_pool, 0)
    INTO v_stage, v_pool, v_funded
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
                              'pool_cents', 0, 'settled_cents', 0, 'balanced', true, 'variance_cents', 0);
  END IF;

  -- AN OPENED CHEST BELONGS TO WHOEVER OPENED IT (2026-08-30). A reveal that
  -- landed just before the event ended used to leave a live award behind while
  -- the sweep below paid the same chest to the champion. Pay it here, inside
  -- the settlement transaction: that marks the chest 'paid' and takes it out
  -- of the unclaimed set, so the two payers can no longer both see it.
  FOR v_award IN
    SELECT id FROM public.tournament_bounty_awards
     WHERE tournament_id = p_tournament_id AND status = 'revealed'
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM public.fn_mystery_bounty_pay(v_award.id);
  END LOOP;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_unclaimed
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');

  v_residual := v_unclaimed;

  -- THE RESIDUAL CANNOT EXCEED WHAT THE POOL STILL HOLDS. Measured from the
  -- ledger for the same reason fn_finalize_bounty_pool measures from it: the
  -- ledger cannot be stale relative to the money, because it IS the money.
  IF v_residual > 0 AND v_funded > 0 THEN
    SELECT round(COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END
           ), 0), 2)
      INTO v_ledger
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    v_room := GREATEST(0, floor((v_funded - COALESCE(v_ledger, 0)) * 100))::bigint;

    IF v_residual > v_room THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_mystery_bounty_settle',
              'Champion residual clamped: the unclaimed chests are worth more than the bounty pool still holds',
              jsonb_build_object('tournament_id', p_tournament_id,
                                 'unclaimed_cents', v_unclaimed,
                                 'room_cents', v_room,
                                 'ledger_paid', v_ledger,
                                 'bounty_pool', v_funded,
                                 'detail', 'the clamp is not the bug, it is the seatbelt -- find the payer that already spent the pool'));
      v_residual := v_room;
    END IF;
  END IF;

  IF p_winner_user_id IS NOT NULL THEN
    IF v_residual > 0 THEN
      -- UNCLAIMED CHESTS GO TO THE CHAMPION. The last player standing was never
      -- knocked out, so their own chest - and any chest a broken elimination
      -- left behind - is theirs.
      /* ONE PAYER (R3, 2026-09-02): the champion's cumulative 'mystery_bounty'
         obligation rises by the residual. A refusal RAISES so the chests are
         not voided below with the money unpaid; the settlement stays
         retryable (stage not 'complete'). */
      v_prior := COALESCE((SELECT o.amount_paid FROM public.tournament_obligations o
                            WHERE o.tournament_id = p_tournament_id AND o.kind = 'mystery_bounty'
                              AND o.place IS NULL AND o.user_id = p_winner_user_id), 0);
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id, 'mystery_bounty', NULL, p_winner_user_id,
        round(v_prior + (v_residual / 100.0), 2),
        'fn_mystery_bounty_settle', 'Unclaimed mystery bounty chests awarded to champion');
      IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'fn_mystery_bounty_settle: residual of % cents to % in tournament % refused (%)',
          v_residual, p_winner_user_id, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
      END IF;
      UPDATE public.tournament_players
         SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_residual / 100.0), 2)
       WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
      UPDATE public.tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_residual / 100.0), 2)
       WHERE id = p_tournament_id;
      v_paid := v_paid + v_residual;
    END IF;

    -- NOTHING MAY PAY THESE CHESTS AFTER THIS POINT. The award is voided in the
    -- same transaction as the sweep, and fn_mystery_bounty_pay refuses a voided
    -- award, so a reveal still in flight cannot mint the chest a second time.
    UPDATE public.tournament_bounty_awards a
       SET status = 'void'
     WHERE a.tournament_id = p_tournament_id
       AND a.status <> 'completed'
       AND EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.id = a.chest_id
                      AND c.status IN ('available','reserved','revealed'));

    UPDATE public.tournament_bounty_chests SET status = 'void'
     WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'residual_paid_cents', v_residual,
    'balanced', v_paid = v_pool,
    'variance_cents', v_paid - v_pool);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. atomic_cancel_tournament: every entrant's refund settles kind 'refund'
--    (total = gross entry debits; the settle function seeds what the ledger
--    already refunded, so a cancel after an unregister pays the difference)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_t RECORD; v_player RECORD;
    v_paid NUMERIC; v_gross NUMERIC; v_fee_net NUMERIC; v_settle jsonb;
    v_refunded_count INT := 0; v_total_refunded NUMERIC := 0; v_fees_reversed NUMERIC := 0;
BEGIN
    SELECT * INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

    IF v_uid IS NOT NULL AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
        RAISE EXCEPTION 'Only a club admin may cancel a tournament' USING ERRCODE = '42501';
    END IF;

    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
        RAISE EXCEPTION 'Tournament is already %', v_t.status;
    END IF;

    UPDATE tournaments
       SET status='CANCELLED', ended_at=NOW(), updated_at=NOW(),
           prize_pool=0, bounty_pool=0
     WHERE id=p_tournament_id;

    FOR v_player IN (
      SELECT tp.id, tp.user_id FROM tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    )
    LOOP
        -- v_gross: everything this entrant paid in (buy-in + fee, rebuys,
        -- add-ons) - the refund obligation's TOTAL (standard S13).
        -- v_paid: what is still owed after the refunds already on the ledger,
        -- the same net figure the old body credited.
        SELECT round(COALESCE(sum(
                 CASE WHEN w.type='debit' AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      ELSE 0 END), 0), 2),
               round(COALESCE(sum(
                 CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      WHEN w.type='credit' AND w.category='refund' THEN -w.amount
                      ELSE 0 END), 0), 2)
          INTO v_gross, v_paid
          FROM wallet_transactions w
         WHERE w.user_id = v_player.user_id AND w.related_entity_id = p_tournament_id;

        IF v_paid > 0 THEN
            /* ONE PAYER (R3, 2026-09-02). User-keyed 'refund' obligation; the
               settle function seeds amount_paid from the refund credits already
               on the ledger and pays gross - seeded. A refused refund is
               skipped here exactly as a refused fn_credit_and_log was, and the
               deferred trigger tournaments_cancel_must_refund then refuses the
               whole cancel at commit because an entrant is still owed. */
            v_settle := public.fn_settle_tournament_obligation(
              p_tournament_id, 'refund', NULL, v_player.user_id, v_gross,
              'atomic_cancel_tournament',
              'Tournament cancellation refund: ' || COALESCE(v_t.name,'Unknown'));
            IF COALESCE((v_settle->>'ok')::boolean, false)
               AND COALESCE((v_settle->>'paid')::numeric, 0) > 0 THEN
                v_refunded_count := v_refunded_count + 1;
                v_total_refunded := v_total_refunded + (v_settle->>'paid')::numeric;
            END IF;
        END IF;

        IF v_t.club_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_fee_net
              FROM rake_records r
             WHERE r.tournament_id = p_tournament_id AND r.is_tournament
               AND r.metadata->>'user_id' = v_player.user_id::text;
            IF v_fee_net > 0 THEN
                INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size,
                  num_players, bbj_contribution, is_tournament, tournament_id, source, metadata)
                VALUES (NULL, NULL, v_t.club_id, -v_fee_net, v_fee_net, 1, 0, true,
                  p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id));
                v_fees_reversed := v_fees_reversed + v_fee_net;
            END IF;
        END IF;
    END LOOP;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = p_tournament_id;
    END IF;

    UPDATE tournament_players SET status='eliminated', eliminated_at=NOW()
     WHERE tournament_id = p_tournament_id AND status IN ('registered','playing');
    UPDATE tables SET status='closed', current_players=0 WHERE tournament_id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;

REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. atomic_tournament_unregister: the caller-supplied refund settles kind
--    'refund' BEFORE the registration row is deleted (so the key resolves the
--    club the player bought in from). 3 uses in 7 days; Phase 3 delete list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_refund_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_reg_id uuid; v_tournament_name TEXT; v_already numeric; v_settle jsonb;
BEGIN
  SELECT id INTO v_reg_id FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered'
   ORDER BY id LIMIT 1
   FOR UPDATE;
  IF v_reg_id IS NULL THEN RETURN FALSE; END IF;

  SELECT name INTO v_tournament_name FROM tournaments WHERE id = p_tournament_id;

  IF COALESCE(p_refund_amount, 0) > 0 THEN
    /* ONE PAYER (R3, 2026-09-02). The refund obligation is user-keyed and
       cumulative: this refund plus every refund credit already on the ledger
       for this player and event is the new total, so a re-registration that
       unregisters again is paid again and a replay pays 0. A refusal RAISES
       before the registration is touched: the player keeps the seat and the
       chips. */
    SELECT round(COALESCE(sum(w.amount), 0), 2) INTO v_already
      FROM wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
       AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id, 'refund', NULL, p_user_id, round(v_already + p_refund_amount, 2),
      'atomic_tournament_unregister',
      'Tournament unregister refund: ' || COALESCE(v_tournament_name, 'Unknown') || ' [club wallet]');
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'atomic_tournament_unregister: refund of % to % for tournament % refused (%)',
        p_refund_amount, p_user_id, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;
  END IF;

  DELETE FROM tournament_players WHERE id = v_reg_id;

  RETURN TRUE;
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_tournament_unregister(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_tournament_unregister(uuid, uuid, numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. fn_unregister_from_tournament (player-facing): the entry charge
--    (buy-in + fee) settles kind 'refund' before the registration is deleted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_t       record;
  v_reg_id  uuid;
  v_amount  numeric;
  v_split   record;
  v_is_bounty boolean;
  v_ms      numeric;
  v_already numeric;
  v_settle  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, bounty_amount,
         is_bounty, is_pko, is_mystery_bounty,
         start_time, current_players, club_id, name
    INTO v_t
  FROM public.tournaments
  WHERE id = p_tournament_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.start_time IS NOT NULL THEN
    v_ms := EXTRACT(EPOCH FROM (v_t.start_time - now())) * 1000;
    IF v_ms <= 60000 AND v_ms > -300000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_close_to_start');
    END IF;
  END IF;

  SELECT id INTO v_reg_id
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = v_uid
     AND status = 'registered'
   ORDER BY id LIMIT 1
   FOR UPDATE;

  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered_or_seated');
  END IF;

  -- POOL SYMMETRY 2026-08-26: reverse the exact fn_tournament_entry_split
  -- components registration added (prize/bounty/rake), not the raw buy_in.
  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  v_amount := v_split.charge;

  IF v_amount > 0 THEN
    /* ONE PAYER (R3, 2026-09-02). This used to call fn_credit_and_log under
       a per-registration key (LEDGER SYMMETRY 2026-08-27); the refund is now
       a user-keyed cumulative obligation: the charge (buy-in + fee, S13) plus
       every refund credit already on the ledger for this player and event.
       Settled BEFORE the registration row is deleted so the settle key
       resolves tournament_players.club_id, the club that was charged. A
       refusal RAISES: the registration stays, the chips stay. */
    SELECT round(COALESCE(sum(w.amount), 0), 2) INTO v_already
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id AND w.user_id = v_uid
       AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id, 'refund', NULL, v_uid, round(v_already + v_amount, 2),
      'fn_unregister_from_tournament',
      'Tournament unregistration refund: ' || COALESCE(v_t.name, 'Unknown'));
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'fn_unregister_from_tournament: refund of % for tournament % refused (%)',
        v_amount, p_tournament_id, COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;
  END IF;

  DELETE FROM public.tournament_players WHERE id = v_reg_id;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES
      (NULL, NULL, v_t.club_id, -v_split.rake, v_split.rake, 1,
       0, true, p_tournament_id, 'fn_unregister_from_tournament',
       jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_uid,
                          'registration_id', v_reg_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 1) - 1, 0),
         prize_pool  = GREATEST(COALESCE(prize_pool, 0)  - v_split.prize, 0),
         bounty_pool = GREATEST(COALESCE(bounty_pool, 0) - v_split.bounty, 0),
         total_rake  = GREATEST(COALESCE(total_rake, 0)  - v_split.rake, 0)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'registration_id', v_reg_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. fn_leave_seat_and_refund (seat-first exit, player-facing): the entry
--    charge settles kind 'refund' before the registration is deleted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leave_seat_and_refund(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tbl record; v_t record; v_split record;
  v_bounty boolean; v_seat integer; v_taken integer; v_club uuid;
  v_already numeric; v_settle jsonb; v_paid numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires an authenticated caller' USING ERRCODE='28000';
  END IF;
  SELECT id, tournament_id INTO v_tbl FROM public.tables WHERE id=p_table_id FOR UPDATE;
  IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  SELECT id, status, variant, max_players, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty, club_id, name
    INTO v_t FROM public.tournaments WHERE id=v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found'); END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;
  SELECT seat_number INTO v_seat FROM public.table_seats
   WHERE table_id=p_table_id AND user_id=v_uid AND left_at IS NULL LIMIT 1;
  IF v_seat IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_seated'); END IF;

  v_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false) OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_bounty);

  -- The club that was charged: the registration's club, else the home club
  -- (the same resolution the settle path's key applies).
  SELECT tp.club_id INTO v_club FROM public.tournament_players tp
   WHERE tp.tournament_id=v_t.id AND tp.user_id=v_uid AND tp.club_id IS NOT NULL
   LIMIT 1;
  IF v_club IS NULL THEN v_club := public.fn_player_home_club(v_uid, NULL); END IF;

  IF COALESCE(v_split.charge,0) > 0 THEN
    IF v_club IS NULL THEN
      RAISE EXCEPTION 'seat refund could not resolve the club wallet that was charged';
    END IF;
    /* ONE PAYER (R3, 2026-09-02). This used to call fn_add_chips plus an
       unconditional log_wallet_transaction. The refund is a user-keyed
       cumulative obligation (charge + refund credits already on the ledger),
       settled BEFORE tournament_players is deleted so the key resolves the
       club that was charged. A refusal RAISES: seat, registration and chips
       all stay as they were. */
    SELECT round(COALESCE(sum(w.amount), 0), 2) INTO v_already
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = v_t.id AND w.user_id = v_uid
       AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    v_settle := public.fn_settle_tournament_obligation(
      v_t.id, 'refund', NULL, v_uid, round(v_already + v_split.charge, 2),
      'fn_leave_seat_and_refund',
      'Seat released: ' || COALESCE(v_t.name,'game') || ' (full refund)');
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'fn_leave_seat_and_refund: refund of % for game % refused (%)',
        v_split.charge, v_t.id, COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;
    v_paid := COALESCE((v_settle->>'paid')::numeric, 0);
  END IF;

  UPDATE public.table_seats SET left_at=now(), is_sitting_out=false
   WHERE table_id=p_table_id AND user_id=v_uid AND left_at IS NULL;
  DELETE FROM public.tournament_players WHERE tournament_id=v_t.id AND user_id=v_uid;
  UPDATE public.tournaments
     SET current_players=GREATEST(COALESCE(current_players,0)-1,0),
         prize_pool=GREATEST(COALESCE(prize_pool,0)-v_split.prize,0),
         bounty_pool=GREATEST(COALESCE(bounty_pool,0)-v_split.bounty,0),
         total_rake=GREATEST(COALESCE(total_rake,0)-v_split.rake,0)
   WHERE id=v_t.id;
  DELETE FROM public.rake_records
   WHERE tournament_id=v_t.id AND source='fn_register_for_tournament'
     AND (metadata->>'user_id')=v_uid::text;

  IF v_paid > 0 THEN
    -- The chip_transactions evidence row this path has always written.
    INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
    VALUES (v_club, v_uid, v_paid, 'tournament_refund',
            'Seat released: ' || COALESCE(v_t.name,'game') || ' (full refund)');
  END IF;

  SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
  UPDATE public.tables SET current_players=v_taken WHERE id=p_table_id;

  RETURN jsonb_build_object('ok', true, 'refunded', COALESCE(v_split.charge,0),
    'seat_number', v_seat, 'seats_taken', v_taken, 'club_id', v_club);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leave_seat_and_refund(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-apply assertions: every re-pointed body settles through the obligation
-- function and none of them credits a player directly any more.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_name text; v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_settle_tournament_obligation'
                    AND pronamespace = 'public'::regnamespace
                    AND prosrc LIKE '%''bounty_residual''%' AND prosrc LIKE '%''mystery_bounty''%') THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation does not accept the bounty kinds this migration relies on';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['fn_collect_bounty','fn_finalize_bounty_pool','fn_mystery_bounty_pay',
                                'fn_mystery_bounty_settle','atomic_cancel_tournament',
                                'atomic_tournament_unregister','fn_unregister_from_tournament',
                                'fn_leave_seat_and_refund']
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc
     WHERE proname = v_name AND pronamespace = 'public'::regnamespace;
    IF v_src IS NULL THEN
      RAISE EXCEPTION '% is missing after apply', v_name;
    END IF;
    IF v_src NOT LIKE '%fn_settle_tournament_obligation(%' THEN
      RAISE EXCEPTION '% does not settle through fn_settle_tournament_obligation', v_name;
    END IF;
    IF v_src LIKE '%credit_player_wallet(%' OR v_src LIKE '%fn_credit_and_log(%'
       OR v_src LIKE '%log_wallet_transaction(%' OR v_src LIKE '%fn_add_chips(%'
       OR v_src LIKE '%UPDATE club_members%' THEN
      RAISE EXCEPTION '% still credits a player outside the obligation function', v_name;
    END IF;
  END LOOP;
END $$;

COMMIT;
