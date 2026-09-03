-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828023923; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27, follow-on to the three guards.
--
-- (a) fn_collect_bounty: explicit refusal for the PKO+Mystery hybrid. The CHECK
--     constraint tournaments_no_pko_mystery_hybrid makes the combination
--     unconstructible, so this branch should never fire - it exists so that if
--     the constraint is ever dropped, a hybrid knockout refuses loudly instead of
--     quietly paying PKO arithmetic against a chest-funded pool. Everything else
--     is byte-identical: the 50/50 integer-cents split, the mystery_phase_active
--     hand-off to the chest path, the funded/unfunded ceiling, and the deliberate
--     exclusion of mystery_bounty_value.
--
--     The ruling, and why: a PKO head is a claim against (bounty_pool -
--     bounty_pool_paid). A mystery chest is a sealed inventory where
--     sum(chests) = pool. Two different pools. Paying a chest 50/50 into cash and
--     head - the obvious way to "support both" - would create head liability
--     backed by chest money and break the sealed-set invariant that makes the
--     inventory auditable. No arithmetic satisfies both formats at once.
--
-- (b) fn_apply_prize_guarantee: a club treasury driven negative by funding
--     advertised guarantees was raising severity 'warning'. Midway Union is at
--     -4,346.80 with 29,667.30 still promised on live events; that is not a
--     warning. Raised to 'critical' and the alert now carries the shortfall as a
--     sortable number. Dedupe-one-open-alert-per-club, the rakeback-timing note,
--     and every money operation are unchanged. p_source keeps its 'engine'
--     default - dropping it is what failed the first attempt at this migration.

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(
  p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_t record; v_elim record;
  v_head numeric; v_available numeric; v_payable numeric;
  v_cash numeric; v_to_head numeric;
  v_cents integer; v_cash_cents integer;
  v_mode text; v_funded boolean;
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

  -- THE CHEST PATH OWNS THIS KNOCKOUT once the mystery phase is open. Two
  -- paths paying one knockout is how a funded pool goes negative.
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
  -- 2026-08-27: a knockout of a player with NO row must refuse, not fall
  -- through to the tournament's default head and pay a bounty for a ghost.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'eliminated_player_not_in_tournament');
  END IF;

  v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                 WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                 ELSE 'regular' END;

  -- mystery_bounty_value is deliberately NOT in this COALESCE any more. It was
  -- a Postgres random() roll taken at REGISTRATION, and 9,000 historical rows
  -- still carry one; a re-swept old tournament must not pay from it.
  v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;

  v_funded  := COALESCE(v_t.bounty_pool, 0) > 0;
  v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);

  IF v_funded THEN
    IF v_available <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := LEAST(v_head, v_available);
  ELSE
    v_payable := v_head;
  END IF;

  IF v_mode = 'pko' THEN
    v_cents      := round(v_payable * 100)::integer;
    v_cash_cents := (v_cents / 2)::integer;
    v_cash       := v_cash_cents / 100.0;
    v_to_head    := (v_cents - v_cash_cents) / 100.0;
  ELSE
    v_cash := v_payable; v_to_head := 0;
  END IF;

  IF v_cash > 0 THEN
    PERFORM public.credit_player_wallet(
      p_collector_user_id, v_cash,
      'tourney:' || p_tournament_id || ':bounty:' || p_eliminated_user_id
        || ':' || p_collector_user_id);
    PERFORM public.log_wallet_transaction(
      p_collector_user_id, 'PLAYER', v_cash, 'credit', 'bounty',
      CASE v_mode WHEN 'pko'         THEN 'PKO bounty (cash half) from eliminated player'
                  WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
                  ELSE 'Bounty collected from eliminated player' END,
      NULL, NULL, p_tournament_id);
  END IF;

  UPDATE tournament_players
     SET bounties_collected = COALESCE(bounties_collected,0) + 1,
         bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
         current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
   WHERE tournament_id = p_tournament_id AND user_id = p_collector_user_id;

  UPDATE tournament_players SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  IF v_funded THEN
    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_cash, 2)
     WHERE id = p_tournament_id;
  END IF;

  INSERT INTO tournament_bounties
    (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
     added_to_collector_bounty, is_mystery_revealed)
  VALUES (p_tournament_id, p_eliminated_user_id, p_collector_user_id, v_payable,
          CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
          false);

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'funded', v_funded,
    'head', v_head, 'paid_cash', v_cash, 'added_to_head', v_to_head,
    'capped', v_funded AND v_payable < v_head,
    'pool_remaining', CASE WHEN v_funded THEN round(v_available - v_cash, 2) END);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(
  p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_treasury numeric; v_club_name text; v_updated integer;
  v_note text := 'Guarantees are funded daily; union rake returns to club '
              || 'treasuries at the weekly 90% rakeback close, so a '
              || 'mid-week negative is usually timing. Escalate if it '
              || 'survives a close.';
BEGIN
  SELECT t.id, t.club_id, t.name, COALESCE(t.prize_pool, 0) AS pool,
         COALESCE(t.guaranteed_prize, 0) AS gtd, COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  END IF;

  v_final := GREATEST(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  IF v_overlay > 0 THEN
    INSERT INTO public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source)
    VALUES (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final, COALESCE(p_source, 'engine'))
    ON CONFLICT (tournament_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;

    IF v_claimed = 0 THEN
      UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = p_tournament_id;
      RETURN jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    END IF;

    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) - v_overlay,
           updated_at = now()
     WHERE id = v_t.club_id
     RETURNING chip_treasury, name INTO v_treasury, v_club_name;

    UPDATE public.tournament_guarantee_overlays
       SET treasury_after = v_treasury
     WHERE tournament_id = p_tournament_id;

    IF v_treasury IS NOT NULL AND v_treasury < 0 THEN
      -- ONE ALERT PER CLUB. Refresh the open one if it exists (so the figure
      -- stays current), otherwise raise it. Keyed on club_id in context.
      -- SEVERITY 2026-08-27: raised warning -> critical. A treasury that has
      -- gone negative paying advertised guarantees is chips being created.
      UPDATE public.financial_alerts
         SET severity = 'critical',
             message = 'Club treasury is negative from funding advertised guarantees: '
                       || COALESCE(v_club_name, v_t.club_id::text),
             context = jsonb_build_object(
                         'club_id', v_t.club_id,
                         'treasury_after', v_treasury,
                         'shortfall', round(-v_treasury, 2),
                         'latest_tournament_id', p_tournament_id,
                         'latest_overlay', v_overlay,
                         'note', v_note),
             created_at = now()
       WHERE source = 'fn_apply_prize_guarantee'
         AND resolved IS NOT TRUE
         AND context->>'club_id' = v_t.club_id::text;
      GET DIAGNOSTICS v_updated = ROW_COUNT;

      IF v_updated = 0 THEN
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('critical', 'fn_apply_prize_guarantee',
                'Club treasury is negative from funding advertised guarantees: '
                  || COALESCE(v_club_name, v_t.club_id::text),
                jsonb_build_object(
                  'club_id', v_t.club_id,
                  'treasury_after', v_treasury,
                  'shortfall', round(-v_treasury, 2),
                  'latest_tournament_id', p_tournament_id,
                  'latest_overlay', v_overlay,
                  'note', v_note));
      END IF;
    END IF;
  END IF;

  UPDATE public.tournaments
     SET prize_pool = v_final, prize_pool_finalized = true
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', COALESCE(v_overlay, 0), 'treasury_after', v_treasury);
END;
$fn$;
