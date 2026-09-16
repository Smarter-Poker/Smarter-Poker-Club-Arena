BEGIN;

-- THE SUPPLY METER COUNTS THE TICKETS IT ISSUED
--
-- Five open drift incidents, 2026-09-11 01:00 to 05:00 UTC, each saying the
-- chip supply moved beyond ledgered issuance. It did not. The meter was
-- looking away.
--
-- ticket_issue moves chips from prize_liability into the store 'escrow'.
-- fn_ca_supply_snapshot counts fourteen stores and 'escrow' is not one of
-- them, and fn_ca_noncirculating_chip_stores does not name it either, so the
-- move was neither counted nor treated as retirement: every ticket issued
-- read as chips leaving the world, and every redeem as chips arriving.
--
-- Measured over the sixty hours to 15:00 UTC, every single hour with a
-- nonzero unexplained figure has a matching escrow movement of the opposite
-- sign, and the six incident hours sum to exactly -1400.00 against exactly
-- +1400.00 of escrow. Adding the store collapses the residual to the
-- straddle pairs that already cancel within the hour.
--
-- The second half of this migration is the general case. A store can be
-- added to the chip_ledger enum and be in neither the basis nor the
-- non-circulating list, and nothing says so. Now every store declares its
-- treatment, an undeclared one is refused at first use, and a store the
-- basis does not count raises a finding the moment it moves.

-- 1. the store, and what is in it

ALTER TABLE public.ca_supply_snapshots ADD COLUMN IF NOT EXISTS ticket_escrow numeric;

CREATE OR REPLACE FUNCTION public.fn_ca_ticket_escrow_float()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT COALESCE(sum(t.value), 0)::numeric
    FROM public.tournament_tickets t
   WHERE t.status = 'issued';
$$;

COMMENT ON FUNCTION public.fn_ca_ticket_escrow_float() IS
  'Chips held against outstanding tournament tickets. An issued ticket is a chip liability the world still owes: ticket_issue put the chips into the escrow store, ticket_redeem takes them out, and a cancel releases them. Counted in the supply basis since ticket-escrow-v3.';

REVOKE ALL ON FUNCTION public.fn_ca_ticket_escrow_float() FROM PUBLIC, anon, authenticated;

-- 2. every store says how the basis treats it

CREATE TABLE IF NOT EXISTS public.ca_chip_store_coverage (
  store      text PRIMARY KEY,
  treatment  text NOT NULL CHECK (treatment IN ('counted','noncirculating','uncounted')),
  counted_by text,
  notes      text,
  added_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_chip_store_coverage IS
  'Every from_type/to_type the chip journal allows, and how the supply basis treats it. counted: inside fn_ca_supply_snapshot total, counted_by names the component. noncirculating: issuance or retirement, so a move across it is mint or burn. uncounted: known to be outside the basis, so any movement raises a finding rather than passing as drift. An undeclared store is refused at first use.';

ALTER TABLE public.ca_chip_store_coverage ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) VALUES
  ('player_wallet',       'counted', 'member_wallets + member_promo', 'club_members chip_balance and promo_balance'),
  ('club_treasury',       'counted', 'treasuries',                    'clubs chip_treasury'),
  ('union_bank',          'counted', 'union_wallets',                 'union_wallets chip_balance'),
  ('agent_wallet',        'counted', 'agent_wallets',                 'agents agent_wallet_balance and promo_wallet_balance'),
  ('table_stack',         'counted', 'felt',                          'table_seats stack on cash tables. Tournament felt is deliberately excluded and carried by tournament_liability instead'),
  ('promo_wallet',        'counted', 'club_promo + agent_promo + union promo_wallet', 'the promo floats, brought inside the total on 2026-09-03'),
  ('club_wallet',         'counted', 'club_wallets',                  'club_wallets chip_balance'),
  ('union_wallet',        'counted', 'union_wallets',                 'the union rake, bbj, promo, insurance and spin reserve wallets'),
  ('bbj_pool',            'counted', 'bbj_pools',                     'main, backup and promo'),
  ('spin_reserve',        'counted', 'spin_pools + union spin_reserve_wallet', 'spin_bonus_pools balance'),
  ('insurance_bank',      'counted', 'club_insurance + union insurance_wallet', 'clubs insurance_balance'),
  ('escrow',              'counted', 'ticket_escrow',                 'Outstanding tournament tickets. ADDED 2026-09-11: it was in no list at all, which is the whole of the five supply incidents of that morning'),
  ('prize_liability',     'counted', 'tournament_liability',          'tournament_escrow prize_balance, or the counters where an event has no escrow row yet'),
  ('bounty_liability',    'counted', 'tournament_liability',          'tournament_escrow bounty_balance'),
  ('opening_setup',       'counted', 'leaderboard_liability',         'club_opening_setups leaderboard_seed_remaining'),
  ('leaderboard_round',   'counted', 'leaderboard_liability',         'the same seed, while a round is being settled'),
  ('system_mint',         'noncirculating', NULL, 'issuance. A move out of it is a mint'),
  ('system_burn',         'noncirculating', NULL, 'retirement. A move into it is a burn'),
  ('issuance_reserve',    'noncirculating', NULL, 'issuance held before it enters circulation'),
  ('chip_retirement',     'noncirculating', NULL, 'retirement holding'),
  ('settlement_suspense', 'uncounted', NULL,
   'NOT in the basis and NOT verified as a routing label. It holds a large historical net and has not moved in the sixty hours to 2026-09-11 15:00, so it is not implicated in the incidents this migration fixes. Declared uncounted deliberately rather than guessed into the total, where a wrong guess would double count. Any movement now raises a finding, which is the point'),
  ('rakeback_payable',    'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('refund_payable',      'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('credit_facility',     'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('credit_receivable',   'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money')
ON CONFLICT (store) DO NOTHING;

-- 3. the meter reads the ticket float

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  /* The ledger window must not overlap the next one: captured BEFORE the
     balance reads, stored as taken_at, and used as the ceiling below. */
  v_cut timestamptz := clock_timestamp();
  v_basis CONSTANT text := 'ticket-escrow-v3';
BEGIN
  SELECT
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_wallets,
    (SELECT COALESCE(sum(cm.promo_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS chip_pools,
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_insurance,
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
    (SELECT COALESCE(sum(
              CASE WHEN e.tournament_id IS NOT NULL
                   THEN COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                        + COALESCE(e.fee_balance,0)
                   ELSE COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                        - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
              END),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE (e.tournament_id IS NOT NULL
             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                 + COALESCE(e.fee_balance,0) <> 0)
         OR (e.tournament_id IS NULL
             AND t.status NOT IN ('COMPLETED','CANCELLED')))            AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* THE TICKET IS A CHIP LIABILITY (2026-09-11). ticket_issue moves chips
       into the escrow store and ticket_redeem takes them out. The store was
       in neither the basis nor fn_ca_noncirculating_chip_stores, so for as
       long as tickets have existed every issue read as chips leaving the
       world and every redeem as chips arriving. Five incidents on the
       morning of 2026-09-11 were this and nothing else. */
    public.fn_ca_ticket_escrow_float()                                  AS ticket_escrow,
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin
           + s.tourn_liab + s.lb_liab + s.ticket_escrow;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(v_outside)),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(v_outside)),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at AND created_at <= v_cut
       AND NOT (category = 'correction'
                AND metadata->>'posted_via' = 'fn_ca_post_correction');
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained, taken_at, basis_version)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo,
     s.ticket_escrow, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END,
     v_cut, v_basis)
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

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,
    format('the supply meter read %s unexplained in one hour (trailing 4h %s)', round(COALESCE(v_unexplained, 0), 2), round(COALESCE(v_trailing, 0), 2)));

  RETURN v_unexplained;
END
$function$;

-- 4. a store the basis does not know about cannot stay quiet

CREATE OR REPLACE FUNCTION public.fn_ca_chip_store_coverage_gaps()
RETURNS TABLE(store text, gap text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_allowed text[];
BEGIN
  /* The enumerated stores, read from the journal's own constraint, so the
     coverage list is checked against the real domain and not a copy of it. */
  SELECT array_agg(DISTINCT m[1]) INTO v_allowed
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
   WHERE c.conrelid = 'public.chip_ledger'::regclass
     AND c.conname IN ('chip_ledger_from_type_check','chip_ledger_to_type_check');

  RETURN QUERY
  SELECT a.s, 'undeclared'::text,
         ('the chip journal accepts ' || a.s || ' but ca_chip_store_coverage does not say whether the supply basis counts it')::text
    FROM unnest(v_allowed) a(s)
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = a.s);

  RETURN QUERY
  SELECT g.store, 'uncounted store moved'::text,
         ('the supply basis does not count ' || g.store || ' and it moved '
          || round(x.net, 2)::text || ' in the last 24h, so that movement reads as drift')::text
    FROM public.ca_chip_store_coverage g
    JOIN LATERAL (
      SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = g.store), 0)
           - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = g.store), 0) AS net
        FROM public.chip_ledger l
       WHERE l.created_at > now() - interval '24 hours'
    ) x ON true
   WHERE g.treatment = 'uncounted' AND x.net <> 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_chip_store_coverage_gaps() FROM PUBLIC, anon, authenticated;

-- 5. an undeclared store is refused at first use

CREATE OR REPLACE FUNCTION public.fn_ca_chip_store_declared()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_missing text;
BEGIN
  SELECT s INTO v_missing FROM (VALUES (NEW.from_type), (NEW.to_type)) v(s)
   WHERE s IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = s)
   LIMIT 1;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSED: chip store % is not declared in ca_chip_store_coverage', v_missing
      USING ERRCODE = '23514',
            DETAIL  = 'A store the supply basis has never heard of would move chips out of the meter '
                   || 'silently, which is exactly the five supply incidents of 2026-09-11.',
            HINT    = 'Declare it first: INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) '
                   || 'VALUES (' || quote_literal(v_missing) || ', ''counted''|''noncirculating''|''uncounted'', '
                   || '<which fn_ca_supply_snapshot component holds it>, <why>). '
                   || 'If it is counted, add it to the basis in the same migration.';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ab_ca_chip_store_declared ON public.chip_ledger;
CREATE TRIGGER ab_ca_chip_store_declared
  BEFORE INSERT ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_chip_store_declared();

-- 6. the sweep carries the coverage check

CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  c record; v_n bigint; v_rows jsonb; v_verdict jsonb;
  v_found int := 0; v_failed int := 0; v_ran int := 0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_absent_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_absent_tournament_players(10) limit 20) t',
       'critical'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning'),
      ('fn_ca_chip_store_coverage_gaps',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_chip_store_coverage_gaps() limit 20) t',
       'warning')
    ) v(check_name, q, sev)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_n, v_rows;
      IF COALESCE(v_n,0) > 0 THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', c.sev,
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, v_n::numeric, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' returned ' || v_n || ' finding(s) - an invariant does not hold',
          false, jsonb_build_object('rows', v_rows, 'row_count', v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM
          || ' - a check that errors is as silent as one that never runs',
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',   'select public.fn_bbj_conservation_check()',   'healthy'),
      ('fn_bbj_promo_bank_check',     'select public.fn_bbj_promo_bank_check()',     'reconciles'),
      ('fn_settler_lag_check',        'select public.fn_settler_lag_check()',        'healthy'),
      ('fn_tournament_guarantee_check','select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name, q, health_key)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_verdict;

      IF (c.health_key = '__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0) > 0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0) > 0))
         OR (c.health_key <> '__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean, true) IS NOT TRUE)
      THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', 'warning',
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric, 0),
          NULL, NULL, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' reports a conservation failure',
          false, v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM,
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_conservation_sweep',
          jsonb_build_object('checks_run', v_ran, 'with_findings', v_found, 'errored', v_failed));

  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,
                            'with_findings', v_found, 'errored', v_failed);
END;
$function$;

-- 7. prove it
--
-- NOTE: the refusal is NOT probed by inserting into chip_ledger. That table is
-- the money journal and carries its own triggers; a probe row, even one rolled
-- back, is not something to fire at production. The trigger is proved armed and
-- pointed at the refusing function, and the behaviour is pinned in
-- tests/the-supply-meter-counts-the-tickets-it-issued.law.test.ts.

DO $$
DECLARE
  v_float numeric;
  v_ledger numeric;
  v_gaps int;
  v_trg record;
BEGIN
  -- The store the basis now counts must equal what the journal says is in it.
  SELECT public.fn_ca_ticket_escrow_float() INTO v_float;
  SELECT COALESCE(sum(amount) FILTER (WHERE to_type='escrow'),0)
       - COALESCE(sum(amount) FILTER (WHERE from_type='escrow'),0)
    INTO v_ledger FROM public.chip_ledger;
  IF round(v_float,2) <> round(v_ledger,2) THEN
    RAISE EXCEPTION 'ABORT: the ticket float (%) and the journal net for the escrow store (%) disagree', v_float, v_ledger;
  END IF;

  -- Every store the journal accepts is now declared.
  SELECT count(*) INTO v_gaps FROM public.fn_ca_chip_store_coverage_gaps() WHERE gap = 'undeclared';
  IF v_gaps <> 0 THEN
    RAISE EXCEPTION 'ABORT: % chip store(s) are still undeclared', v_gaps;
  END IF;

  -- The escrow store must be counted, not merely declared: this whole
  -- migration is that one word.
  IF NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage
                  WHERE store = 'escrow' AND treatment = 'counted'
                    AND counted_by = 'ticket_escrow') THEN
    RAISE EXCEPTION 'ABORT: the escrow store is not declared as counted by ticket_escrow';
  END IF;

  -- The basis version must have moved, or the first snapshot on the new basis
  -- would be compared against a total measured on the old one and read as a
  -- jump the size of the whole ticket float.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_supply_snapshot'
                  AND prosrc LIKE '%ticket-escrow-v3%') THEN
    RAISE EXCEPTION 'ABORT: the supply meter did not move to the ticket-escrow-v3 basis';
  END IF;

  -- The coverage trigger must be armed on the journal.
  SELECT t.tgname AS tgname, t.tgenabled AS tgenabled, p.proname AS proname INTO v_trg
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.chip_ledger'::regclass
     AND t.tgname = 'ab_ca_chip_store_declared' AND NOT t.tgisinternal;
  IF v_trg.tgname IS NULL THEN
    RAISE EXCEPTION 'ABORT: the chip store coverage trigger is not installed on chip_ledger';
  END IF;
  IF v_trg.tgenabled = 'D' THEN
    RAISE EXCEPTION 'ABORT: the chip store coverage trigger is installed but DISABLED';
  END IF;
  IF v_trg.proname <> 'fn_ca_chip_store_declared' THEN
    RAISE EXCEPTION 'ABORT: the coverage trigger points at % instead of the refusing function', v_trg.proname;
  END IF;
END $$;

COMMIT;
