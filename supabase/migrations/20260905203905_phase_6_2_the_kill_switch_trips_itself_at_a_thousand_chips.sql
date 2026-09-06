-- 20260905203905_phase_6_2_the_kill_switch_trips_itself_at_a_thousand_chips.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 6.2, 2026-09-05 20:4x UTC):
--
-- A kill switch existed for humans: ca_payout_freeze, opened by management
-- through fn_ca_open_payout_freeze, read by fn_settle_tournament_obligation,
-- which refuses every tournament payout while a freeze on tournament_payouts
-- is open (Lane E). Nothing tripped it. The three meters that would know a
-- leak first - the hourly supply meter, the BBJ meter, the escrow drift
-- check - filed incidents and kept paying.
--
-- Dan's threshold, proposed in the roadmap: 1,000 chips an hour on the
-- escrow or the BBJ. The meters read under 7 an hour all day, so 1,000 is
-- far from noise. ca_kill_switch_policy holds the threshold per detector,
-- armed; fn_ca_kill_switch_trip is called by each meter with its figure and
-- opens the payout freezes named in the policy (tournament_payouts and
-- bbj_payouts) when the figure crosses the threshold, files a critical
-- incident, pages the senior list, and raises a financial alert. Clearing
-- stays human: fn_ca_clear_payout_freeze. A new scope, bbj_payouts, is read
-- by bbj_atomic_payout_v2, which refuses with a message the engine's payout
-- queue retries, so a jackpot hit during a freeze is paid when it clears.
-- The full platform break (every table parked) is the next notch and is
-- named, not built: the payout doors are where a leak becomes a loss.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- The new scope the jackpot payout reads.
ALTER TABLE public.ca_payout_freeze DROP CONSTRAINT IF EXISTS ca_payout_freeze_scope_check;
ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_scope_check
  CHECK (scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text]));

CREATE TABLE IF NOT EXISTS public.ca_kill_switch_policy (
  detector        text PRIMARY KEY,
  threshold_chips numeric NOT NULL CHECK (threshold_chips > 0),
  armed           boolean NOT NULL DEFAULT true,
  scopes          text[] NOT NULL DEFAULT ARRAY['tournament_payouts', 'bbj_payouts'],
  note            text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_kill_switch_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_kill_switch_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_kill_switch_policy TO service_role;
COMMENT ON TABLE public.ca_kill_switch_policy IS 'Chip standard Phase 6.2: the threshold at which each meter trips the payout freezes. Dan''s threshold: 1,000 chips an hour on the escrow or the BBJ (roadmap 6.2).';

INSERT INTO public.ca_kill_switch_policy (detector, threshold_chips, note) VALUES
  ('fn_ca_supply_snapshot', 1000, 'one hour of unexplained supply change, either sign'),
  ('fn_bbj_reconcile', 1000, 'one pool, two snapshots, beyond the journal'),
  ('fn_ca_escrow_balance_drift', 1000, 'one run, total disagreement between balances and the shadow')
ON CONFLICT (detector) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_kill_switch_trip(p_detector text, p_amount numeric, p_detail text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE pol public.ca_kill_switch_policy%ROWTYPE; v_scope text; v_opened text[] := ARRAY[]::text[]; v_inc uuid; v_hour text := to_char(now(), 'YYYY-MM-DD-HH24');
BEGIN
  SELECT * INTO pol FROM public.ca_kill_switch_policy WHERE detector = p_detector;
  IF NOT FOUND OR NOT pol.armed OR p_amount IS NULL OR abs(p_amount) < pol.threshold_chips THEN
    RETURN false;
  END IF;
  FOREACH v_scope IN ARRAY pol.scopes LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = v_scope AND f.cleared_at IS NULL) THEN
      INSERT INTO public.ca_payout_freeze (scope, reason, opened_by, opened_by_label)
      VALUES (v_scope, format('KILL SWITCH %s: %s (threshold %s)', p_detector, p_detail, pol.threshold_chips), NULL, 'kill switch: ' || p_detector);
      v_opened := v_opened || v_scope;
    END IF;
  END LOOP;
  v_inc := public.fn_ca_raise_drift_incident(
    'fn_ca_kill_switch_trip', 'ledger_imbalance', 'critical',
    'kill-switch:' || p_detector || ':' || v_hour,
    round(p_amount, 2), NULL, NULL, 'ledger', 'ca_kill_switch_policy', NULL,
    'fade0000-0000-0000-0000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    format('KILL SWITCH TRIPPED by %s: %s. Payouts frozen on %s until a human clears them (fn_ca_clear_payout_freeze). Nothing is lost while frozen: obligations stay owed and are paid when cleared.',
           p_detector, p_detail, array_to_string(pol.scopes, ', ')),
    false, jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips, 'opened', v_opened, 'scopes', pol.scopes));
  IF v_inc IS NOT NULL THEN
    PERFORM public.fn_ca_incident_notify(v_inc, 'escalated', format('KILL SWITCH: %s read %s; payouts frozen', p_detector, round(p_amount, 2)), true);
  END IF;
  PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
    format('KILL SWITCH TRIPPED by %s: %s. Payouts frozen on %s.', p_detector, p_detail, array_to_string(pol.scopes, ', ')),
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips, 'opened', v_opened),
    'kill-switch:' || p_detector || ':' || v_hour);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- The switch must never take the meter down with it: a failure to page is
  -- logged as its own alert and the freeze rows already written stand.
  BEGIN
    PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
      format('KILL SWITCH by %s could not complete its paging: %s', p_detector, SQLERRM), jsonb_build_object('detector', p_detector), 'kill-switch-error:' || v_hour);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,
    /* CHIP STANDARD (2026-09-03): the club-held promo and insurance floats are
       chips like any other. They were outside the total, so every BBJ promo
       sweep into a standalone club read as chips leaving the world. */
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs)                  AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs)              AS club_insurance,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(COALESCE(promo_wallet_balance,0)),0) FROM agents) AS agent_promo,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    /* CHIP STANDARD PHASE 5.1 (2026-09-05): a tournament's liability is its
       ESCROW BALANCE where the balance enforces the event (every non-spin
       event with a row since part two), and the old counters where it does
       not: an event with no row yet, and every SPIN, whose money sits in
       spin_reserve until the draw funds its prize and whose escrow row is
       tracked, not enforced (part four: reading spins from the escrow
       double-counted their entries against the reserve). */
    /* PHASE 5.2 (2026-09-05): the spin escrow now carries the reserve legs
       (reserve_out at pool completion, reserve_in at the draw), so its banks
       are exact and journal-consistent; the meter reads the escrow for EVERY
       event with a row, and the counters only for an event with no row yet. */
    (SELECT COALESCE(sum(COALESCE(e.prize_balance + e.bounty_balance + e.fee_balance,
                                  COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                                  - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0))),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                  AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* phase 4: cert-held chips, reported not excluded */
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab + s.lb_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  IF prev.id IS NOT NULL THEN
    -- Symmetric: out of a non-circulating store is issuance, into one is
    -- retirement. A store-to-store row appears in each sum once and nets to
    -- zero, which is correct -- it never touched circulation.
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(v_outside)),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(v_outside)),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at
       /* A correction moves no balance (see a_correction_is_not_a_mint):
          counting it as issuance invents drift equal to itself. */
       AND NOT (category = 'correction'
                AND metadata->>'posted_via' = 'fn_ca_post_correction');
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 100 AND abs(v_trailing) > 300 THEN
    v_critical := abs(v_unexplained) > 25000
               OR (abs(v_trailing) > 2000
                   AND v_prev_unexplained IS NOT NULL
                   AND abs(v_prev_unexplained) > 100
                   AND sign(v_prev_unexplained) = sign(v_unexplained));
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN v_critical THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval; trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2)));
  END IF;

  -- PHASE 6.2 (2026-09-05): the kill switch reads every hour's figure.
  PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,
    format('the supply meter read %s unexplained in one hour (trailing 4h %s)', round(COALESCE(v_unexplained, 0), 2), round(COALESCE(v_trailing, 0), 2)));

  RETURN v_unexplained;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_reconcile_all()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p record; s public.ca_bbj_pool_snapshots%ROWTYPE; prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_out jsonb := '[]'::jsonb; v_two numeric; v_alerts int := 0; v_opened int := 0;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_reconcile_all is service only' USING ERRCODE = '42501';
  END IF;
  FOR p IN SELECT b.id, b.union_id, b.club_id FROM public.bbj_pools b WHERE b.status = 'active' ORDER BY b.created_at LOOP
    -- A pool the meter has never seen opens its own balance (second cut).
    IF NOT EXISTS (SELECT 1 FROM public.ca_bbj_pool_snapshots x WHERE x.pool_id = p.id) THEN
      PERFORM public.fn_bbj_open_pool_baseline(p.id);
      v_opened := v_opened + 1;
    END IF;
    s := public.fn_bbj_reconcile(p.id);
    SELECT * INTO prev FROM public.ca_bbj_pool_snapshots WHERE id = s.prev_id;
    -- Two consecutive snapshots: a leg that commits after a read straddles one
    -- boundary and reverses at the next, so a single-interval swing is noise
    -- and a two-interval sum is a finding.
    v_two := (s.unexplained_main + s.unexplained_backup + s.unexplained_promo)
           + COALESCE(CASE WHEN prev.is_baseline THEN 0 ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF abs(v_two) > 0.01 OR s.write_failures > 0 THEN
      v_alerts := v_alerts + 1;
      -- PHASE 6.2 (2026-09-05): the kill switch reads every pool's two-snapshot figure.
      PERFORM public.fn_ca_kill_switch_trip('fn_bbj_reconcile', v_two,
        format('BBJ pool %s moved %s beyond the journal over two snapshots', p.id, round(v_two, 2)));
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_bbj_reconcile', 'bbj_error', CASE WHEN abs(v_two) >= 100 OR s.write_failures > 0 THEN 'critical' ELSE 'warning' END,
        'bbj-meter:' || p.id::text || ':' || to_char(s.taken_at, 'YYYY-MM-DD-HH24'),
        round(v_two, 2), 0, round(v_two, 2), 'ledger', 'bbj_pools', p.id, p.club_id, p.union_id,
        NULL, NULL, NULL, NULL, NULL, NULL,
        format('BBJ pool banks moved by %s beyond the journal over the last two snapshots (main %s, backup %s, promo %s this interval; %s ledger write failure(s)): a bbj_pools write without a leg, or a leg without a write',
               round(v_two, 2), s.unexplained_main, s.unexplained_backup, s.unexplained_promo, s.write_failures),
        false,
        jsonb_build_object('snapshot_id', s.id, 'pool_id', p.id, 'unexplained_main', s.unexplained_main,
                           'unexplained_backup', s.unexplained_backup, 'unexplained_promo', s.unexplained_promo,
                           'write_failures', s.write_failures));
    END IF;
    v_out := v_out || jsonb_build_object('pool_id', p.id, 'snapshot_id', s.id,
                'main', s.main, 'backup', s.backup, 'promo', s.promo,
                'unexplained', round(s.unexplained_main + s.unexplained_backup + s.unexplained_promo, 2),
                'drops', s.drops_since, 'payouts', s.payouts_since, 'sweeps', s.sweeps_since);
  END LOOP;
  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts, 'opened', v_opened);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_reconcile_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reconcile_all() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_balance_drift(p_hours integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; e record; v_n int := 0; v_bad int := 0; v_list jsonb := '[]'::jsonb; v_gap numeric := 0;
BEGIN
  FOR r IN SELECT x.* FROM public.tournament_escrow x
            WHERE x.updated_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 3), 1))
              AND x.updated_at < now() - interval '2 minutes'   -- a row mid-flight is not a finding
            ORDER BY x.updated_at DESC LIMIT 5000
  LOOP
    v_n := v_n + 1;
    /* Same instant (2026-09-05): the cursor read this row when the loop began,
       and the loop takes tens of seconds over thousands of rows; a payout that
       lands in between moves the shadow and not the row in hand. Re-read the
       balance right before the shadow so both reads are milliseconds apart. */
    SELECT * INTO r FROM public.tournament_escrow x WHERE x.tournament_id = r.tournament_id;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(r.tournament_id);
    IF abs(r.prize_balance - (e.prize_balance - r.reserve_out + r.reserve_in)) > 0.01 OR abs(r.bounty_balance - e.bounty_balance) > 0.01 OR abs(r.fee_balance - e.fee_balance) > 0.01 THEN
      v_bad := v_bad + 1;
      v_gap := v_gap + abs((r.prize_balance + r.bounty_balance + r.fee_balance) - (e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance));
      IF v_bad <= 20 THEN
        v_list := v_list || jsonb_build_object('tournament_id', r.tournament_id,
                    'balance', jsonb_build_object('prize', r.prize_balance, 'bounty', r.bounty_balance, 'fee', r.fee_balance),
                    'shadow', jsonb_build_object('prize', e.prize_balance - r.reserve_out + r.reserve_in, 'bounty', e.bounty_balance, 'fee', e.fee_balance));
      END IF;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_escrow_balance_drift', 'settlement_error', 'warning',
        'escrow-balance-drift:' || r.tournament_id::text,
        round((r.prize_balance + r.bounty_balance + r.fee_balance) - (e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance), 2),
        round(e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance, 2), round(r.prize_balance + r.bounty_balance + r.fee_balance, 2),
        'ledger', 'tournament', r.tournament_id, NULL, NULL, NULL, r.tournament_id, NULL, NULL, NULL, NULL,
        format('the maintained escrow balance (prize %s, bounty %s, fee %s) disagrees with the shadow (prize %s, bounty %s, fee %s): a path wrote an operational row the escrow triggers do not read, or the other way round',
               r.prize_balance, r.bounty_balance, r.fee_balance, e.prize_balance, e.bounty_balance, e.fee_balance),
        false, jsonb_build_object('tournament_id', r.tournament_id));
    END IF;
  END LOOP;
  -- PHASE 6.2 (2026-09-05): the kill switch reads the run's total disagreement.
  PERFORM public.fn_ca_kill_switch_trip('fn_ca_escrow_balance_drift', v_gap,
    format('%s escrow rows disagree with the shadow by %s in total', v_bad, round(v_gap, 2)));
  RETURN jsonb_build_object('checked', v_n, 'disagree', v_bad, 'sample', v_list, 'gap', round(v_gap, 2));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_balance_drift(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_balance_drift(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_payout_total_percent numeric, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, recovered boolean, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, balance_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_main numeric; v_backup numeric;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric;
  v_per numeric; v_remainder numeric; v_payout_id uuid; v_existing uuid;
  v_club_id uuid; v_pre_hit_balance numeric; v_winner_name text; v_loser_name text;
  v_table_ids uuid[]; v_n_table integer; v_recovered boolean := false; v_uid uuid;
  v_hand_id uuid;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 is service only' USING ERRCODE = '42501';
  END IF;
  IF p_payout_total_percent IS NULL OR p_payout_total_percent <= 0 OR p_payout_total_percent > 100 THEN
    RAISE EXCEPTION 'bbj payout percent % out of range (0,100]', p_payout_total_percent;
  END IF;
  /* PHASE 6.2 (2026-09-05): the kill switch. An open freeze on jackpot payouts
     refuses the payout with a message the engine's queue retries (it retries
     everything but 'out of range', 'service only' and 42501), so a jackpot
     hit during a freeze is paid the moment the freeze is cleared. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  SELECT id INTO v_existing FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table FROM bbj_payouts bp WHERE bp.id = v_existing;
    IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      IF bbj_credit_one_recipient(v_existing, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    END LOOP;

    -- A replay is also the second chance to attach the hand: on the first pass
    -- the hand_history insert may have been the step that failed.
    UPDATE bbj_payouts bp
       SET hand_id = h.id
      FROM public.hand_history h
     WHERE bp.id = v_existing AND bp.hand_id IS NULL
       AND h.table_id = p_table_id AND h.hand_number = p_hand_number;

    RETURN QUERY SELECT false, true, v_recovered, v_existing, v_total, v_loser, v_winner, v_table, v_per, NULL::numeric;
    RETURN;
  END IF;

  SELECT main_balance, COALESCE(backup_balance,0) INTO v_main, v_backup FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_main IS NULL OR v_main <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, COALESCE(v_main,0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_main;
  v_total  := ROUND(v_main * (p_payout_total_percent / 100.0), 2);
  -- CLAMP TO MAIN ONLY. The backup jackpot is a reserve and is never a payout
  -- source (Dan, 2026-08-18). This replaces the earlier LEAST(v_total,
  -- main+backup), which had authorised spending the reserve.
  v_total  := LEAST(v_total, v_main);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
  v_remainder := ROUND(v_table - (v_per * v_n_table), 2);
  v_loser := v_loser + v_remainder;
  v_table := v_per * v_n_table;

  -- THE HAND. Written before the payout by postHandTasks, so it is normally
  -- here. NULL when that step failed, which is exactly the case worth being
  -- able to see.
  SELECT h.id INTO v_hand_id FROM public.hand_history h
   WHERE h.table_id = p_table_id AND h.hand_number = p_hand_number
   ORDER BY h.created_at DESC LIMIT 1;

  INSERT INTO bbj_payouts (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_winner, v_loser, v_table, v_n_table, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    RETURN QUERY SELECT false, true, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_main;
    RETURN;
  END IF;

  /* THE PAYOUT IS DECLARED (chip standard Phase 4.3, 2026-09-04): the main
     jackpot pays the felt of the hitting table. Seated recipients hold their
     share on that felt; a departed recipient's share leaves the felt for the
     wallet in bbj_credit_one_recipient, declared there. Before today this
     debit fell to settlement_suspense. */
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
                                      'bbj_payout:' || v_payout_id::text, NULL);
  -- MAIN ONLY. backup_balance is deliberately absent from this statement: a
  -- jackpot payout must never touch the reserve.
  UPDATE bbj_pools
     SET main_balance   = GREATEST(0, main_balance - v_total),
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         hit_count      = COALESCE(hit_count, 0) + 1,
         last_hit_at    = now(), last_hit_amount = v_total,
         last_winner_id = p_loser_user_id, last_loser_id = p_winner_user_id, updated_at = now()
   WHERE id = p_pool_id RETURNING main_balance, club_id INTO v_main, v_club_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  -- RESEED (Dan 2026-08-18): the back-up jackpot exists so that when a hit
  -- takes 100% of main, the jackpot does not restart at zero. If main is now
  -- empty, TRANSFER the reserve into it. A transfer, not a payout: no player
  -- is ever paid from the reserve, and chips are conserved. Recorded as a
  -- bank move; an empty reserve raises an incident (Phase 4.3).
  IF v_main <= 0 THEN
    v_main := GREATEST(v_main, fn_bbj_reseed_main_from_backup(p_pool_id));
  END IF;

  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids));
  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids));
  FOREACH v_uid IN ARRAY v_table_ids LOOP
    PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids));
  END LOOP;

  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  /* THE CLUB THE HAND WAS PLAYED IN (BBJ audit 2026-09-05). A union pool has
     no club_id of its own, so v_club_id from the pool row above is NULL for
     every union hit and the Previous Winners row said the jackpot happened
     nowhere. The hitting table always knows its club. */
  SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = p_table_id AND t.club_id IS NOT NULL;
  IF v_club_id IS NULL THEN
    SELECT bp2.club_id INTO v_club_id FROM public.bbj_pools bp2 WHERE bp2.id = p_pool_id;
  END IF;
  INSERT INTO bbj_winners (pool_id, club_id, winner_id, loser_id, winner_display_name, loser_display_name,
    winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout,
    pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (p_pool_id, v_club_id, p_loser_user_id, p_winner_user_id, v_winner_name, v_loser_name,
    COALESCE(p_metadata->>'winner_hand_name', 'Unknown'), COALESCE(p_metadata->>'loser_hand_name', 'Unknown'),
    v_loser, v_winner, v_table, v_total, v_pre_hit_balance, p_table_id, p_hand_number, now())
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, false, false, v_payout_id, v_total, v_loser, v_winner, v_table, v_per, v_main;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_atomic_payout_v2(uuid, uuid, bigint, numeric, uuid, uuid, uuid[], uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_atomic_payout_v2(uuid, uuid, bigint, numeric, uuid, uuid, uuid[], uuid[], jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_open_payout_freeze(p_scope text, p_reason text, p_actor_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scope text := lower(btrim(COALESCE(p_scope, '')));
  v_uid   uuid := auth.uid();
  v_label text := COALESCE(NULLIF(btrim(p_actor_label), ''),
                           NULLIF(current_setting('application_name', true), ''),
                           session_user::text);
  v_row   public.ca_payout_freeze%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_scope NOT IN ('tournament_payouts', 'bbj_payouts', 'diamond_issuance',
                     'diamond_tournament_payouts', 'arena_withdrawals') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'unknown_scope');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'reason_too_short');
  END IF;

  SELECT * INTO v_row FROM public.ca_payout_freeze
   WHERE scope = v_scope AND cleared_at IS NULL
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_open', true, 'freeze_id', v_row.id,
      'scope', v_row.scope, 'opened_at', v_row.opened_at, 'opened_by', v_row.opened_by,
      'opened_by_label', v_row.opened_by_label, 'reason', v_row.reason);
  END IF;

  INSERT INTO public.ca_payout_freeze (scope, reason, opened_by, opened_by_label)
  VALUES (v_scope, btrim(p_reason), v_uid, v_label)
  RETURNING * INTO v_row;

  PERFORM public.fn_raise_server_financial_alert(
    'warning', 'ca_payout_freeze',
    format('Payouts FROZEN on scope %s by %s: %s', v_scope, v_label, btrim(p_reason)),
    jsonb_build_object('freeze_id', v_row.id, 'scope', v_scope, 'opened_by', v_uid,
                       'opened_by_label', v_label, 'opened_at', v_row.opened_at),
    'freeze:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'already_open', false, 'freeze_id', v_row.id,
    'scope', v_row.scope, 'opened_at', v_row.opened_at, 'opened_by', v_uid,
    'opened_by_label', v_label, 'reason', v_row.reason);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_kill_switch_trip', 'approved', 'chip standard Phase 6.2 (2026-09-05): opens the payout freezes when a meter crosses its threshold; moves nothing')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note) VALUES
  ('fn_ca_kill_switch_trip', 'chip standard', 1, 'the kill switch itself; a human clears the freeze within the hour or says why')
ON CONFLICT (source) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.ca_kill_switch_policy WHERE armed) <> 3 THEN RAISE EXCEPTION 'the policy is not armed on three meters'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_supply_snapshot') NOT LIKE '%fn_ca_kill_switch_trip%' THEN RAISE EXCEPTION 'the supply meter does not read the switch'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_bbj_reconcile_all') NOT LIKE '%fn_ca_kill_switch_trip%' THEN RAISE EXCEPTION 'the BBJ meter does not read the switch'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_escrow_balance_drift') NOT LIKE '%fn_ca_kill_switch_trip%' THEN RAISE EXCEPTION 'the drift check does not read the switch'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'bbj_atomic_payout_v2') NOT LIKE '%bbj_payouts%' THEN RAISE EXCEPTION 'the jackpot payout does not read the freeze'; END IF;
END $$;

COMMIT;
