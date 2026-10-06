-- Cashout holds remain chips in custody. Count them in the same snapshot as
-- the member/agent wallets they move between. Preserve ticket_escrow semantics
-- and old rows; the first v5 reading is a new basis, never compared with v4.
-- @live-proof: EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ca_supply_snapshots' AND column_name='cashout_escrow')
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';
SET LOCAL transaction_timeout = '15s';
LOCK TABLE public.ca_supply_snapshots IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure)) <> '6d816523832309ffda1e16ea0ce163a7'
 THEN RAISE EXCEPTION 'cashout_supply_preimage_changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_trial_balance(timestamptz)'::regprocedure)) <> '69c6be700a1baec747970d2158d42943'
 THEN RAISE EXCEPTION 'cashout_trial_balance_preimage_changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_kill_switch_trip(text,numeric,text)'::regprocedure)) <> '1e1a1109a78caa1a4f0d1d4f0c9a321f'
 THEN RAISE EXCEPTION 'cashout_supply_escalation_preimage_changed'; END IF;
END $pre$;
ALTER TABLE public.ca_supply_snapshots ADD COLUMN cashout_escrow numeric;
COMMENT ON COLUMN public.ca_supply_snapshots.cashout_escrow IS
 'Outstanding chip_escrow custody at the same committed snapshot; NULL on historical readings before cashout-escrow-v5.';
CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_win RECORD; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_late_mint numeric := 0; v_late_burn numeric := 0;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_basis CONSTANT text := 'cashout-escrow-v5';
BEGIN
  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL OR prev.basis_version IS DISTINCT FROM v_basis
                            THEN NULL ELSE prev.unexplained END;

  /* ONE STATEMENT, ONE SNAPSHOT (20261002164500). Every balance, this
     window's ledger and the re-read of the previous windows see exactly the
     same committed transactions. The cut is clock_timestamp() taken inside
     the statement: later than its snapshot, so every leg it can see is
     stamped at or below the cut. A writer still open is invisible to all of
     it, balance and leg alike; when it commits, its leg is found by the
     re-read below in whichever window its stamp falls. */
  WITH c AS MATERIALIZED (SELECT clock_timestamp() AS cut),
  wins AS MATERIALIZED (
    SELECT r.id, lo.taken_at AS lo, r.taken_at AS hi,
           COALESCE(r.restated_mint, r.mint_since_prev, 0) AS rec_mint,
           COALESCE(r.restated_burn, r.burn_since_prev, 0) AS rec_burn
      FROM (SELECT id, taken_at, mint_since_prev, burn_since_prev,
                   restated_mint, restated_burn
              FROM public.ca_supply_snapshots
             ORDER BY taken_at DESC LIMIT 6) r
      JOIN LATERAL (SELECT p.taken_at FROM public.ca_supply_snapshots p
                     WHERE p.taken_at < r.taken_at
                     ORDER BY p.taken_at DESC LIMIT 1) lo ON true
  )
  SELECT
    c.cut AS cut,
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
       JOIN clubs cl ON cl.id = cm.club_id WHERE NOT COALESCE(cl.is_platform, false)) AS member_wallets,
    (SELECT COALESCE(sum(cm.promo_balance),0) FROM club_members cm
       JOIN clubs cl ON cl.id = cm.club_id WHERE NOT COALESCE(cl.is_platform, false)) AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND (t.tournament_id IS NOT NULL
                                /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond seat holds
                                   Diamonds that no chip_ledger row moves. */
                                OR EXISTS (SELECT 1 FROM public.clubs cl
                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS felt,
    /* THE FELT IS OWED WHAT A MID-HAND ADD-ON ALREADY PAID FOR (2026-09-12). */
    (SELECT COALESCE(sum(pa.amount),0) FROM public.table_pending_addons pa
      WHERE pa.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = pa.table_id
                           AND (t.tournament_id IS NOT NULL
                                OR EXISTS (SELECT 1 FROM public.clubs cl
                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS pending_addons,
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
      WHERE ((e.tournament_id IS NOT NULL
             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                 + COALESCE(e.fee_balance,0) <> 0)
         OR (e.tournament_id IS NULL
             AND t.status NOT IN ('COMPLETED','CANCELLED')))
        /* DIAMOND PHASE 9, STEP 0: a Diamond event's pools are not a chip liability. */
        AND NOT EXISTS (SELECT 1 FROM public.clubs cl
                         WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))            AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    (SELECT COALESCE(sum(amount),0) FROM public.chip_escrow WHERE released_at IS NULL) AS cashout_escrow,
    /* THE TICKET IS A CHIP LIABILITY (2026-09-11). */
    public.fn_ca_ticket_escrow_float()                                  AS ticket_escrow,
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w,
    /* This window's issuance and retirement. */
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS mint,
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS burn,
    /* The previous six windows, read again under this same snapshot. */
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', w.id, 'mint', x.vm, 'burn', x.vb,
               'rec_mint', w.rec_mint, 'rec_burn', w.rec_burn)), '[]'::jsonb)
       FROM wins w
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0) AS vm,
                COALESCE(sum(l.amount) FILTER (WHERE l.to_type   = ANY(v_outside)),0) AS vb
           FROM public.chip_ledger l
          WHERE l.created_at > w.lo AND l.created_at <= w.hi
            AND NOT (l.category = 'correction'
                     AND l.metadata->>'posted_via' = 'fn_ca_post_correction')) x) AS windows
  INTO s
  FROM c;

  /* A leg visible now that its window did not see when it was read is late:
     its writer committed after that reading, so its balance appears in THIS
     reading. Count it here, once, and mark the window restated so the next
     reading does not count it again. */
  FOR v_win IN SELECT (e->>'id')::bigint AS id,
                  (e->>'mint')::numeric AS vm, (e->>'burn')::numeric AS vb,
                  (e->>'rec_mint')::numeric AS rm, (e->>'rec_burn')::numeric AS rb
             FROM jsonb_array_elements(s.windows) e
  LOOP
    IF v_win.vm <> v_win.rm OR v_win.vb <> v_win.rb THEN
      v_late_mint := v_late_mint + (v_win.vm - v_win.rm);
      v_late_burn := v_late_burn + (v_win.vb - v_win.rb);
      UPDATE public.ca_supply_snapshots
         SET restated_mint = v_win.vm, restated_burn = v_win.vb, restated_at = s.cut
       WHERE id = v_win.id;
    END IF;
  END LOOP;

  v_total := s.member_wallets + s.member_promo + s.felt + s.pending_addons
           + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin
           + s.tourn_liab + s.lb_liab + s.ticket_escrow + s.cashout_escrow;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, pending_addons, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, cashout_escrow, total,
     mint_since_prev, burn_since_prev, late_mint, late_burn,
     delta_vs_prev, unexplained, taken_at, basis_version)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.pending_addons, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo,
     s.ticket_escrow, s.cashout_escrow, v_total,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.mint END,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.burn END,
     v_late_mint, v_late_burn,
     CASE WHEN prev.id IS NULL OR prev.basis_version IS DISTINCT FROM v_basis
          THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL
          ELSE v_total - prev.total - s.mint + s.burn - v_late_mint + v_late_burn END,
     s.cut, v_basis)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL
     AND basis_version = v_basis;

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
      v_unexplained, prev.total + s.mint - s.burn + v_late_mint - v_late_burn, v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval (late legs from earlier windows included: mint '
        || round(v_late_mint,2) || ', burn ' || round(v_late_burn,2) || '); trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2),
                                 'late_mint', round(v_late_mint,2),
                                 'late_burn', round(v_late_burn,2)));
  END IF;

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,
    format('the supply meter read %s unexplained in one hour (trailing 4h %s)', round(COALESCE(v_unexplained, 0), 2), round(COALESCE(v_trailing, 0), 2)));

  RETURN v_unexplained;
END
$function$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_supply_snapshot','20261006141326 supply includes held cashouts in the same snapshot');

-- Keep the connected chart and persistence reader on the same accounting basis.
CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(account text, balance_delta numeric, ledger_net numeric, difference numeric, writers text, window_start timestamp with time zone, window_end timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s0 public.ca_supply_snapshots%ROWTYPE;
  s1 public.ca_supply_snapshots%ROWTYPE;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  /* THE WINDOW IS THE SNAPSHOTS, NOT A CLOCK GUESS (2026-09-10). */
  SELECT * INTO s1 FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF p_since IS NULL THEN
    SELECT * INTO s0 FROM public.ca_supply_snapshots
     WHERE taken_at < s1.taken_at ORDER BY taken_at DESC LIMIT 1;
  ELSE
    SELECT * INTO s0 FROM public.ca_supply_snapshots
     WHERE taken_at >= p_since ORDER BY taken_at ASC LIMIT 1;
  END IF;

  IF s0.id IS NULL OR s1.id IS NULL OR s0.id = s1.id
     OR s0.basis_version IS DISTINCT FROM s1.basis_version THEN
    RETURN QUERY
      SELECT a.account, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
             s0.taken_at, s1.taken_at
        FROM (VALUES ('player_wallets'), ('promo_wallets'), ('table_stack'),
                     ('tournament_liability'), ('bbj_pools'), ('spin_reserve'),
                     ('club_treasuries'), ('club_chip_pools'), ('union_banks'),
                     ('agent_wallets'), ('club_wallets'), ('leaderboard_liability'),
                     ('ticket_escrow'), ('cashout_escrow'),
                     ('settlement_suspense'), ('total_supply')) AS a(account);
    RETURN;
  END IF;

  RETURN QUERY
  WITH acct(account, ledger_types, bal_delta) AS (
    VALUES
      ('player_wallets',        ARRAY['player_wallet'],                                  s1.member_wallets        - s0.member_wallets),
      ('promo_wallets',         ARRAY['promo_wallet'],
                                (s1.member_promo + COALESCE(s1.club_promo, 0) + COALESCE(s1.agent_promo, 0))
                              - (s0.member_promo + COALESCE(s0.club_promo, 0) + COALESCE(s0.agent_promo, 0))),
      /* THE FELT IS OWED WHAT A MID-HAND ADD-ON ALREADY PAID FOR (2026-09-12).
         This read s1.felt - s0.felt alone, so it localised incident b39556cb
         entirely to table_stack (-118.78) while every other account balanced to
         the cent - true, and useless, because the account was not short. The
         add-on's table_stack leg is posted at request time; the chips reach the
         seat up to minutes later. COALESCE keeps pre-v4 snapshots on the old
         basis rather than inventing a delta out of a NULL, as promo does. */
      ('table_stack',           ARRAY['table_stack'],
                                (s1.felt + COALESCE(s1.pending_addons, 0))
                              - (s0.felt + COALESCE(s0.pending_addons, 0))),
      ('tournament_liability',  ARRAY['prize_liability','bounty_liability','refund_payable'],
                                                                                         s1.tournament_liability  - s0.tournament_liability),
      ('bbj_pools',             ARRAY['bbj_pool'],                                       s1.bbj_pools             - s0.bbj_pools),
      ('spin_reserve',          ARRAY['spin_reserve'],                                   s1.spin_pools            - s0.spin_pools),
      ('club_treasuries',       ARRAY['club_treasury'],                                  s1.treasuries            - s0.treasuries),
      ('club_chip_pools',       ARRAY[]::text[],                                         s1.chip_pools            - s0.chip_pools),
      ('union_banks',           ARRAY['union_bank','union_wallet','insurance_bank'],
                                (s1.union_wallets + COALESCE(s1.club_insurance, 0))
                              - (s0.union_wallets + COALESCE(s0.club_insurance, 0))),
      ('agent_wallets',         ARRAY['agent_wallet'],
                                (s1.agent_wallets - COALESCE(s1.agent_promo, 0))
                              - (s0.agent_wallets - COALESCE(s0.agent_promo, 0))),
      ('club_wallets',          ARRAY['club_wallet'],                                    s1.club_wallets          - s0.club_wallets),
      ('leaderboard_liability', ARRAY['opening_setup','leaderboard_round'],              s1.leaderboard_liability - s0.leaderboard_liability),
      /* THE TICKET FLOAT HAD NO ACCOUNT HERE (2026-09-12). ticket-escrow-v3
         added ticket_escrow to the meter's basis on 2026-09-11 but never to
         this chart, and total_supply below is the SUM of these rows - so every
         ticket issued or redeemed has shown up here as an unattributable
         total_supply difference ever since. */
      ('ticket_escrow',         ARRAY['escrow'],
                                COALESCE(s1.ticket_escrow, 0) - COALESCE(s0.ticket_escrow, 0)),
      ('cashout_escrow',        ARRAY['cashout_escrow'],
                                s1.cashout_escrow - s0.cashout_escrow),
      ('settlement_suspense',   ARRAY['settlement_suspense'],                            0::numeric)
  ),
  led AS (
    SELECT CASE WHEN l.from_type = 'escrow' AND l.category IN ('escrow_hold', 'escrow_release')
                THEN 'cashout_escrow' ELSE l.from_type END AS from_type,
           CASE WHEN l.to_type = 'escrow' AND l.category IN ('escrow_hold', 'escrow_release')
                THEN 'cashout_escrow' ELSE l.to_type END AS to_type, l.amount,
           COALESCE(l.actor_service, '?') || '/' || COALESCE(l.db_role, '?') AS writer
      FROM public.chip_ledger l
     WHERE l.created_at >  s0.taken_at
       AND l.created_at <= s1.taken_at
       AND NOT (l.category = 'correction'
                AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
  ),
  per_acct AS (
    SELECT a.account, a.bal_delta,
           COALESCE((SELECT sum(led.amount) FROM led WHERE led.to_type   = ANY (a.ledger_types)), 0)
         - COALESCE((SELECT sum(led.amount) FROM led WHERE led.from_type = ANY (a.ledger_types)), 0) AS net,
           (SELECT string_agg(w.writer || ':' || w.n::text, ', ' ORDER BY w.n DESC)
              FROM (SELECT led.writer, count(*) AS n
                      FROM led
                     WHERE led.to_type = ANY (a.ledger_types) OR led.from_type = ANY (a.ledger_types)
                     GROUP BY led.writer
                     ORDER BY count(*) DESC
                     LIMIT 5) w) AS writers
      FROM acct a
  ),
  issuance AS (
    SELECT COALESCE(sum(led.amount) FILTER (WHERE led.from_type = ANY (v_outside)), 0)
         - COALESCE(sum(led.amount) FILTER (WHERE led.to_type   = ANY (v_outside)), 0) AS net,
           (SELECT string_agg(w.writer || ':' || w.n::text, ', ' ORDER BY w.n DESC)
              FROM (SELECT l2.writer, count(*) AS n FROM led l2
                     WHERE l2.from_type = ANY (v_outside) OR l2.to_type = ANY (v_outside)
                     GROUP BY l2.writer ORDER BY count(*) DESC LIMIT 5) w) AS writers
      FROM led
  ),
  total_bal AS (
    SELECT sum(a.bal_delta) AS d FROM acct a
  )
  SELECT p.account,
         round(p.bal_delta, 2),
         round(p.net, 2),
         round(p.bal_delta - p.net, 2),
         p.writers,
         s0.taken_at, s1.taken_at
    FROM per_acct p
  UNION ALL
  SELECT 'total_supply',
         round(t.d, 2),
         round(i.net, 2),
         round(t.d - i.net, 2),
         i.writers,
         s0.taken_at, s1.taken_at
    FROM issuance i, total_bal t
  ORDER BY 1;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_kill_switch_trip(p_detector text, p_amount numeric, p_detail text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  pol public.ca_kill_switch_policy%ROWTYPE;
  v_inc uuid;
  v_hour text := to_char(now(), 'YYYY-MM-DD-HH24');
  v_prev numeric;
  v_prev_at timestamptz;
  v_corr text;
  v_redef text;
  v_explained text;
  v_persists boolean := false;
  v_head text;
BEGIN
  SELECT * INTO pol FROM public.ca_kill_switch_policy WHERE detector = p_detector;
  IF NOT FOUND OR NOT pol.armed OR p_amount IS NULL OR abs(p_amount) < pol.threshold_chips THEN
    RETURN false;
  END IF;

  /* THE SWITCH ESCALATES; A PERSON FREEZES (ruling 2026-09-05, on the
     evidence in this migration's header). This function must never write
     ca_payout_freeze: tests/law/PayoutFreezeIsHumanOnly.law.test.ts pins that
     the only insert into that table is inside the human opener. */

  -- The second opinion, taken now rather than an hour from now.
  IF p_detector = 'fn_ca_supply_snapshot' THEN
    SELECT s.unexplained, s.taken_at INTO v_prev, v_prev_at
      FROM public.ca_supply_snapshots s
     WHERE s.unexplained IS NOT NULL
       AND s.basis_version IS NOT DISTINCT FROM
           (SELECT latest.basis_version FROM public.ca_supply_snapshots latest
             ORDER BY latest.taken_at DESC LIMIT 1)
     ORDER BY s.taken_at DESC OFFSET 1 LIMIT 1;
    v_persists := v_prev IS NOT NULL AND abs(v_prev) > pol.threshold_chips / 4 AND sign(v_prev) = sign(p_amount);
  END IF;

  SELECT string_agg(m.op_id, ', ') INTO v_corr
    FROM public.ca_mint_ledger m
   WHERE m.op_id LIKE 'register-opening-baseline-correction:%'
     AND m.created_at > COALESCE(v_prev_at, now() - interval '2 hours');

  /* A migration that re-created the meter itself, named exactly. The guard
     watch is the backstop for a change no migration explains: it captures a
     new hash within the hour, so it errs toward "explained" for at most one
     hour after a real redefinition - which is exactly the hour the false
     alarms live in. Neither suppresses the incident; both name it. */
  SELECT string_agg(m.version || ' ' || m.name, ', ') INTO v_redef
    FROM supabase_migrations.schema_migrations m
   WHERE m.version >= to_char(COALESCE(v_prev_at, now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS')
     AND m.statements[1] LIKE '%' || p_detector || '%';
  IF v_redef IS NULL THEN
    SELECT string_agg(DISTINCT 'the guard watch saw ' || h.proname || ' change', ', ') INTO v_redef
      FROM public.ca_guard_def_history h
     WHERE h.captured_at > COALESCE(v_prev_at, now() - interval '2 hours')
       AND h.proname = p_detector;
  END IF;

  v_explained := NULLIF(concat_ws('; ',
    CASE WHEN v_corr IS NOT NULL THEN 'a labelled register correction in the window (' || v_corr || ')' END,
    CASE WHEN v_redef IS NOT NULL THEN 'the meter''s own definition changed in the window (' || v_redef || ')' END), '');

  v_head := CASE
    WHEN v_explained IS NOT NULL THEN 'EXPLAINED: ' || v_explained || '. Read it before you freeze anything: a meter that has just changed definition reads like a leak and is not one.'
    WHEN v_persists THEN 'CONFIRMED: the previous reading agreed in sign (' || round(COALESCE(v_prev, 0), 2) || ' at ' || COALESCE(v_prev_at::text, 'n/a') || ') and nothing in the window explains it. A leak persists; an oscillation flips.'
    ELSE 'UNCONFIRMED: one reading over the threshold, nothing in the window explains it, and the previous reading did not agree. Take the next reading before you freeze.'
  END;

  v_inc := public.fn_ca_raise_drift_incident(
    'fn_ca_kill_switch_trip', 'ledger_imbalance',
    CASE WHEN v_explained IS NOT NULL THEN 'warning' ELSE 'critical' END,
    'kill-switch:' || p_detector || ':' || v_hour,
    round(p_amount, 2), NULL, NULL, 'ledger', 'ca_kill_switch_policy', NULL,
    'fade0000-0000-0000-0000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s (threshold %s). %s Payouts are NOT frozen: open the freeze yourself with fn_ca_open_payout_freeze if this is real.',
           p_detector, p_detail, pol.threshold_chips, v_head),
    false,
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips,
                       'freeze', 'human only', 'verdict', split_part(v_head, ':', 1),
                       'previous_reading', v_prev, 'previous_at', v_prev_at,
                       'explained_by', v_explained, 'persists', v_persists));

  IF v_inc IS NOT NULL AND v_explained IS NULL THEN
    PERFORM public.fn_ca_incident_notify(v_inc, 'escalated',
      format('KILL SWITCH: %s read %s. %s', p_detector, round(p_amount, 2), split_part(v_head, '.', 1)), true);
  END IF;

  PERFORM public.fn_raise_server_financial_alert(
    CASE WHEN v_explained IS NOT NULL THEN 'warning' ELSE 'critical' END, 'ca_kill_switch',
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s. %s', p_detector, p_detail, v_head),
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips,
                       'verdict', split_part(v_head, ':', 1), 'explained_by', v_explained),
    'kill-switch:' || p_detector || ':' || v_hour);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
      format('KILL SWITCH by %s could not complete its paging: %s', p_detector, SQLERRM),
      jsonb_build_object('detector', p_detector), 'kill-switch-error:' || v_hour);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN true;
END;
$function$;
COMMIT;
