-- ===========================================================================
--  THE SUPPLY METER COUNTS A LEG THAT COMMITS AFTER ITS READING, AND THE
--  MONEY-PATH CHECK NAMES THE REGISTRATION DOOR THAT IS LIVE
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-02. Read from rows, production, read-only.
--
-- 1. THE KILL SWITCH AT 15:05 UTC WAS THE METER, NOT A LEAK.
--
--    fn_ca_supply_snapshot read -100,005.30 unexplained for 14:05 -> 15:05 and
--    tripped fn_ca_kill_switch_trip (incidents 2e00634c, d9ebce90, 035e55db,
--    verdict UNCONFIRMED). Snapshot 778 (14:05:00.176) recorded
--    burn_since_prev 802,036.92. The same window read now returns 902,036.92:
--    a 100,000.00 certification burn (club_treasury -> chip_retirement) is
--    stamped inside 13:05 -> 14:05 but committed after 14:05:00.176. The
--    balance it drained was invisible to snapshot 778 and visible to 779, while
--    its leg sat in 778's window, so 779 saw a treasury fall with no leg.
--    779 + 778 together: -100,005.30 + 100,000.00 + 0.68 = -4.62, inside the
--    meter's ordinary single-digit noise (16:05 read 6.01).
--
--    Why. chip_ledger.created_at is the writer's TRANSACTION START (now()),
--    not its commit - the same defect 20260927144455 fixed in the rakeback
--    settler. The meter windows the ledger by created_at, so a writer open
--    across a reading always lands its leg in one window and its balance in
--    the next. The certification cleanup holds 100,000.00-sized transactions
--    open for seconds, at any minute of the hour.
--
--    A second, smaller instance of the same race: the cut was taken by
--    clock_timestamp() BEFORE the balance read, and the ledger was summed in
--    a later statement with a later snapshot, so a writer committing between
--    the statements was counted in the ledger and not in the balances.
--
--    FIX (fn_ca_supply_snapshot):
--      * the balances, this window's mint and burn, and a re-read of the
--        previous six windows are taken in ONE statement, so all of them see
--        the same committed set; the cut is clock_timestamp() inside that
--        statement, which is later than its snapshot, so every visible leg is
--        at or below the cut;
--      * a leg that became visible since a window was recorded (its writer
--        committed after that reading) is LATE: it is added to this reading as
--        late_mint / late_burn - the reading in which its balance first
--        appears - and the earlier window is marked restated_mint /
--        restated_burn so the leg is never counted twice. The original
--        mint_since_prev / burn_since_prev stay as recorded;
--      * unexplained = delta - mint + burn - late_mint + late_burn.
--    Nothing is explained away: a late amount is a posted ledger leg, read
--    from the ledger. A chip that moves with no leg still reads unexplained.
--
--    The 13:05 -> 14:05 window (snapshot 778) is restated here, once, so the
--    first new reading does not attribute that 100,000.00 burn a second time.
--
-- 2. fn_union_money_path_check REPORTED A RETIRED FUNCTION AS A BREACH.
--
--    20261002140203 retired atomic_tournament_register (EXECUTE was closed to
--    clients and nothing called it; it now only raises
--    atomic_tournament_register_retired). The check still listed it, so from
--    15:52 the conservation sweep filed "money path no longer reaches club
--    scope" (incident 696b3666). Registration is fn_register_for_tournament,
--    which reaches club scope; it takes the retired name's place in the list.
--
-- CLAUDE.md section 2: one migration, one transaction; ADD COLUMN with no
-- default rewrite and CREATE OR REPLACE FUNCTION only. Applied outside
-- :50-:03 UTC.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.ca_supply_snapshots WHERE id = 778 AND restated_burn = 902036.92) = 1

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Preimage
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_supply_snapshot',     '05bf43e4990f11cbf0f20b6788c64449'),
      ('fn_union_money_path_check', 'd933d503e37d2ce33d0842aff8157fda')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body read on 2026-10-02 (md5 %, expected %)', r.f, v_live, r.m;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname = 'atomic_tournament_register'
                    AND p.prosrc LIKE '%atomic_tournament_register_retired%') THEN
    RAISE EXCEPTION 'preimage: atomic_tournament_register is not the retired stub';
  END IF;
  IF NOT public.fn_money_path_reaches_club_scope('fn_register_for_tournament', 6) THEN
    RAISE EXCEPTION 'preimage: fn_register_for_tournament does not reach club scope';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ca_supply_snapshots
                  WHERE id = 778 AND burn_since_prev = 802036.92) THEN
    RAISE EXCEPTION 'preimage: snapshot 778 is not the reading recorded at 14:05 UTC';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. Where a late leg is recorded
-- ---------------------------------------------------------------------------

ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS late_mint     numeric,
  ADD COLUMN IF NOT EXISTS late_burn     numeric,
  ADD COLUMN IF NOT EXISTS restated_mint numeric,
  ADD COLUMN IF NOT EXISTS restated_burn numeric,
  ADD COLUMN IF NOT EXISTS restated_at   timestamptz;

COMMENT ON COLUMN public.ca_supply_snapshots.late_mint IS
  'Issuance legs stamped inside an EARLIER window that committed after that window was read; their balance first appears in this reading (20261002164500).';
COMMENT ON COLUMN public.ca_supply_snapshots.late_burn IS
  'Retirement legs stamped inside an EARLIER window that committed after that window was read; their balance first appears in this reading (20261002164500).';
COMMENT ON COLUMN public.ca_supply_snapshots.restated_mint IS
  'This window''s issuance as read again by a later reading, once a late leg appeared in it. mint_since_prev keeps what was read at the time.';
COMMENT ON COLUMN public.ca_supply_snapshots.restated_burn IS
  'This window''s retirement as read again by a later reading, once a late leg appeared in it. burn_since_prev keeps what was read at the time.';

-- ---------------------------------------------------------------------------
-- 2. The meter
-- ---------------------------------------------------------------------------

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
  v_basis CONSTANT text := 'pending-addon-v4';
BEGIN
  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

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
           + s.tourn_liab + s.lb_liab + s.ticket_escrow;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, pending_addons, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, total,
     mint_since_prev, burn_since_prev, late_mint, late_burn,
     delta_vs_prev, unexplained, taken_at, basis_version)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.pending_addons, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo,
     s.ticket_escrow, v_total,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.mint END,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.burn END,
     v_late_mint, v_late_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL
          ELSE v_total - prev.total - s.mint + s.burn - v_late_mint + v_late_burn END,
     s.cut, v_basis)
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

REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The 13:05 -> 14:05 window is restated once, by the same rule
-- ---------------------------------------------------------------------------
-- Its 100,000.00 late burn was already absorbed by snapshot 779's
-- unexplained (-100,005.30). Marking 778 restated stops the first new reading
-- from counting that burn a second time; 779's recorded unexplained stays as
-- history, explained by this header.

DO $restate$
DECLARE
  r record; v_m numeric; v_b numeric;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  FOR r IN SELECT s.id, s.taken_at AS hi, s.mint_since_prev, s.burn_since_prev,
                  (SELECT p.taken_at FROM public.ca_supply_snapshots p
                    WHERE p.taken_at < s.taken_at ORDER BY p.taken_at DESC LIMIT 1) AS lo
             FROM public.ca_supply_snapshots s
            ORDER BY s.taken_at DESC LIMIT 6
  LOOP
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0),
           COALESCE(sum(l.amount) FILTER (WHERE l.to_type   = ANY(v_outside)),0)
      INTO v_m, v_b
      FROM public.chip_ledger l
     WHERE l.created_at > r.lo AND l.created_at <= r.hi
       AND NOT (l.category = 'correction'
                AND l.metadata->>'posted_via' = 'fn_ca_post_correction');
    IF v_m <> COALESCE(r.mint_since_prev,0) OR v_b <> COALESCE(r.burn_since_prev,0) THEN
      UPDATE public.ca_supply_snapshots
         SET restated_mint = v_m, restated_burn = v_b, restated_at = clock_timestamp()
       WHERE id = r.id;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.ca_supply_snapshots
                  WHERE id = 778 AND restated_burn = 902036.92) THEN
    RAISE EXCEPTION 'restatement: snapshot 778 did not restate to 902,036.92';
  END IF;
END $restate$;

-- ---------------------------------------------------------------------------
-- 4. The money-path check names the live registration door
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 6 levels) - club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('fn_register_for_tournament'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback')
            -- atomic_tournament_register was here. 20261002140203 retired it
            -- (it only raises atomic_tournament_register_retired; nothing
            -- calls it); registration is fn_register_for_tournament, which
            -- takes its place (20261002164500).
            --
            -- transfer_chips_agent_to_player was here. It is dropped: it
            -- debited the agent's PLAYER wallet, its only caller was an unused
            -- World Hub route, and fn_agent_wallet_send is the path.
            --
            -- atomic_pay_agent_settlement was here until phase 7, and is
            -- dropped for the same shape of reason: staff paying an agent out
            -- of a column nothing maintained, against Dan's ruling that agents
            -- claim their own. What replaces it, fn_agent_claim_commission, is
            -- club-scoped by construction - it takes p_club_id, locks that
            -- club's row and debits that club's treasury - so there is nothing
            -- here for this check to discover about it.
         ) AS x(fn)
   -- A function that has been deleted outright is still a breach; one that
   -- exists but cannot reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = x.fn)
      -- SIX, NOT FOUR (2026-09-09). process_tournament_rebuy reaches its
      -- club_members debit at hop five since the rebuy chain was put back;
      -- four hops made a longer corridor read as a missing door.
      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 6);
$function$;

-- ---------------------------------------------------------------------------
-- 5. Postimage
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_union_money_path_check()) THEN
    RAISE EXCEPTION 'postimage: fn_union_money_path_check still reports a finding';
  END IF;
END $post$;

COMMIT;
