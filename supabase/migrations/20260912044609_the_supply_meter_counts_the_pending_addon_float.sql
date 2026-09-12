-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260912044609; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260912044609   (the stamp IS the apply time, UTC: 2026-09-12 04:46:09)
--   name        the_supply_meter_counts_the_pending_addon_float
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 16057 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260912044609 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_ca_supply_snapshot, public.fn_ca_trial_balance
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS pending_addons numeric;

COMMENT ON COLUMN public.ca_supply_snapshots.pending_addons IS
 'Unresolved table_pending_addons at taken_at: chips a mid-hand add-on has already debited and journalled to table_stack, which have not yet reached table_seats.stack. NULL on snapshots taken before basis pending-addon-v4.';

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  /* The ledger window must not overlap the next one: captured BEFORE the
     balance reads, stored as taken_at, and used as the ceiling below. */
  v_cut timestamptz := clock_timestamp();
  v_basis CONSTANT text := 'pending-addon-v4';
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
    /* THE FELT IS OWED WHAT A MID-HAND ADD-ON ALREADY PAID FOR (2026-09-12).
       atomic_table_addon debits the wallet and posts its
       player_wallet -> table_stack leg at REQUEST time, but with
       p_apply_to_seat = false the chips wait in table_pending_addons until
       resolve_pending_addon delivers them. The store was in neither the basis
       nor ca_chip_store_coverage, so every snapshot that landed inside that
       window read the chips as destroyed and the next one read them as minted.
       Incident b39556cb: -118.78 at 17:05Z on 2026-09-11 was ONE row of
       115.68, open for 25.7 seconds. Scoped exactly like `felt` above. */
    (SELECT COALESCE(sum(pa.amount),0) FROM public.table_pending_addons pa
      WHERE pa.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = pa.table_id
                           AND t.tournament_id IS NOT NULL))            AS pending_addons,
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
       into the escrow store and ticket_redeem takes them out. */
    public.fn_ca_ticket_escrow_float()                                  AS ticket_escrow,
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.pending_addons
           + s.treasuries + s.chip_pools
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
    (member_wallets, member_promo, felt, pending_addons, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained, taken_at, basis_version)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.pending_addons, s.treasuries, s.chip_pools,
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

  IF s0.id IS NULL OR s1.id IS NULL OR s0.id = s1.id THEN
    RETURN QUERY
      SELECT a.account, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
             s0.taken_at, s1.taken_at
        FROM (VALUES ('player_wallets'), ('promo_wallets'), ('table_stack'),
                     ('tournament_liability'), ('bbj_pools'), ('spin_reserve'),
                     ('club_treasuries'), ('club_chip_pools'), ('union_banks'),
                     ('agent_wallets'), ('club_wallets'), ('leaderboard_liability'),
                     ('ticket_escrow'),
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
      ('settlement_suspense',   ARRAY['settlement_suspense'],                            0::numeric)
  ),
  led AS (
    SELECT l.from_type, l.to_type, l.amount,
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
