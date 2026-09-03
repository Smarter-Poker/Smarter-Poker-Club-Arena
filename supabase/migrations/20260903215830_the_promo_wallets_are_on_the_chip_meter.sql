-- THE PROMO WALLETS ARE ON THE CHIP METER, AND THE TRIAL BALANCE WATCHES ALL THREE.
--
-- 2026-09-03, Dan (binding): "PROMO CHIPS ARE A PART OF THE BBJ RAKE, PART GOES
-- INTO THE MAIN BBJ, PART GOES INTO THE BACK UP BBJ WALLET AND PART GOES INTO
-- THE PROMO WALLET. WHAT LIABILITY OR ISSUES DO WE HAVE TO ADDRESS WITH IT?"
--
-- The first issue is that the meter cannot see the promo chips.
--
-- The promo slice of the BBJ drop is real chips cut from the rake. It is swept
-- out of bbj_pools (a measured store) into one of three places:
--
--     club_members.promo_balance   measured, as ca_supply_snapshots.member_promo
--     union_wallets.promo_wallet   measured, inside union_wallets
--     clubs.promo_balance          NOT MEASURED AT ALL
--
-- fn_ca_supply_snapshot sums clubs.chip_treasury and clubs.chip_pool and stops.
-- Every sweep into a standalone club's promo wallet - about 220 chips an hour,
-- 5,010.18 over the last seven days - therefore reads to the meter as chips
-- leaving the world, and 6,166.18 chips sit today in a store the supply total
-- has never counted. That is a large part of the negative unexplained drift the
-- hourly snapshot has been reporting (-4,866.94 over the last 24h against
-- 4,799.77 of club promo sweeps) and of the 58 supply incidents raised this
-- week. clubs.insurance_balance is unmeasured for the same reason; it is 0.00
-- everywhere today, so it is added here before it is ever used.
--
-- The second issue is that the trial balance's promo account watches a third of
-- the promo money. The ledger writes one account name, promo_wallet, from three
-- different balances (club_members.promo_balance, clubs.promo_balance,
-- agents.promo_wallet_balance - see the trg_ca_autoledger definitions), while
-- fn_ca_trial_balance measures it as member_promo alone. So the promo row has
-- been reporting balance 0.00 against ledger 5,955.77 over seven days: a
-- -5,955.77 phantom that is not a leak. Agent promo is worse than unwatched: it
-- is journalled as promo_wallet but measured inside agent_wallets, so it is
-- counted against the wrong account in both directions.
--
-- This migration is telemetry only. It moves no chips, touches no money path,
-- and changes no function that any player, club or union action calls. It adds
-- three snapshot columns, puts the two unmeasured club stores into the supply
-- total, and points each trial-balance account at the balances that actually
-- back its ledger names.
--
-- The latest snapshot is rebaselined in the same transaction so the first
-- snapshot taken on the new basis does not report the 6,166.18 as a one-time
-- swing and raise a false drift incident. The rebaseline reconstructs the club
-- promo balance as it stood when that snapshot was taken, from the ledger rows
-- written since.

ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS club_promo     numeric,
  ADD COLUMN IF NOT EXISTS club_insurance numeric,
  ADD COLUMN IF NOT EXISTS agent_promo    numeric;

COMMENT ON COLUMN public.ca_supply_snapshots.club_promo IS
  'sum(clubs.promo_balance): the club-held promo float. In total since 2026-09-03.';
COMMENT ON COLUMN public.ca_supply_snapshots.club_insurance IS
  'sum(clubs.insurance_balance): the club-held insurance float. In total since 2026-09-03.';
COMMENT ON COLUMN public.ca_supply_snapshots.agent_promo IS
  'sum(agents.promo_wallet_balance). Already inside agent_wallets; broken out so the '
  'trial balance can measure it against the promo_wallet ledger account, not agent_wallet.';

-- Rebaseline the most recent snapshot onto the new basis: the club stores as
-- they stood at taken_at, reconstructed by unwinding the ledger rows written
-- since, and its total raised by the same amount so the next interval's
-- delta_vs_prev and unexplained are computed like for like.
WITH latest AS (
  SELECT id, taken_at FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1
),
since AS (
  SELECT
    COALESCE(sum(CASE WHEN l.to_label = 'clubs.promo_balance'     THEN l.amount
                      WHEN l.from_label = 'clubs.promo_balance'   THEN -l.amount END), 0) AS promo_in,
    COALESCE(sum(CASE WHEN l.to_label = 'clubs.insurance_balance' THEN l.amount
                      WHEN l.from_label = 'clubs.insurance_balance' THEN -l.amount END), 0) AS ins_in
  FROM public.chip_ledger l, latest
  WHERE l.created_at > latest.taken_at
    AND (l.to_label   IN ('clubs.promo_balance','clubs.insurance_balance')
      OR l.from_label IN ('clubs.promo_balance','clubs.insurance_balance'))
),
now_bal AS (
  SELECT COALESCE(sum(COALESCE(c.promo_balance, 0)), 0)     AS promo,
         COALESCE(sum(COALESCE(c.insurance_balance, 0)), 0) AS ins,
         (SELECT COALESCE(sum(COALESCE(a.promo_wallet_balance, 0)), 0) FROM public.agents a) AS agent_promo
    FROM public.clubs c
)
UPDATE public.ca_supply_snapshots s
   SET club_promo     = round(now_bal.promo - since.promo_in, 2),
       club_insurance = round(now_bal.ins   - since.ins_in, 2),
       agent_promo    = round(now_bal.agent_promo, 2),
       total          = s.total + round(now_bal.promo - since.promo_in, 2)
                                + round(now_bal.ins   - since.ins_in, 2)
  FROM latest, since, now_bal
 WHERE s.id = latest.id;

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
    (SELECT COALESCE(sum(COALESCE(prize_pool,0) + COALESCE(bounty_pool,0)
                         - COALESCE(bounty_pool_paid,0) + COALESCE(total_rake,0)),0)
       FROM tournaments
      WHERE status NOT IN ('COMPLETED','CANCELLED'))                    AS tourn_liab,
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

  RETURN v_unexplained;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance(
  p_since timestamp with time zone DEFAULT (now() - '01:15:00'::interval))
RETURNS TABLE(account text, balance_delta numeric, ledger_net numeric, difference numeric,
              writers text, window_start timestamp with time zone, window_end timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s0 public.ca_supply_snapshots%ROWTYPE;
  s1 public.ca_supply_snapshots%ROWTYPE;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO s0 FROM public.ca_supply_snapshots
   WHERE taken_at >= COALESCE(p_since, now() - interval '75 minutes')
   ORDER BY taken_at ASC LIMIT 1;
  SELECT * INTO s1 FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;

  -- No window (no snapshot at/after p_since, or it IS the latest): report the
  -- chart with NULL deltas rather than a zero that reads as "reconciled".
  IF s0.id IS NULL OR s1.id IS NULL OR s0.id = s1.id THEN
    RETURN QUERY
      SELECT a.account, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
             s0.taken_at, s1.taken_at
        FROM (VALUES ('player_wallets'), ('promo_wallets'), ('table_stack'),
                     ('tournament_liability'), ('bbj_pools'), ('spin_reserve'),
                     ('club_treasuries'), ('club_chip_pools'), ('union_banks'),
                     ('agent_wallets'), ('club_wallets'), ('leaderboard_liability'),
                     ('settlement_suspense'), ('total_supply')) AS a(account);
    RETURN;
  END IF;

  RETURN QUERY
  WITH acct(account, ledger_types, bal_delta) AS (
    VALUES
      ('player_wallets',        ARRAY['player_wallet'],                                  s1.member_wallets        - s0.member_wallets),
      /* CHIP STANDARD (2026-09-03): the promo_wallet ledger account is written
         from THREE balances - club_members.promo_balance, clubs.promo_balance
         and agents.promo_wallet_balance (see trg_ca_autoledger). Measuring it
         as member promo alone reported a -5,955.77 phantom over seven days.
         Snapshots taken before this change carry NULL in the two new columns;
         COALESCE keeps the old basis for those windows rather than inventing a
         delta out of a NULL. */
      ('promo_wallets',         ARRAY['promo_wallet'],
                                (s1.member_promo + COALESCE(s1.club_promo, 0) + COALESCE(s1.agent_promo, 0))
                              - (s0.member_promo + COALESCE(s0.club_promo, 0) + COALESCE(s0.agent_promo, 0))),
      ('table_stack',           ARRAY['table_stack'],                                    s1.felt                  - s0.felt),
      ('tournament_liability',  ARRAY['prize_liability','bounty_liability','refund_payable'],
                                                                                         s1.tournament_liability  - s0.tournament_liability),
      ('bbj_pools',             ARRAY['bbj_pool'],                                       s1.bbj_pools             - s0.bbj_pools),
      ('spin_reserve',          ARRAY['spin_reserve'],                                   s1.spin_pools            - s0.spin_pools),
      ('club_treasuries',       ARRAY['club_treasury'],                                  s1.treasuries            - s0.treasuries),
      ('club_chip_pools',       ARRAY[]::text[],                                         s1.chip_pools            - s0.chip_pools),
      /* insurance_bank is written from clubs.insurance_balance as well as the
         union's insurance_wallet, so both back this account. */
      ('union_banks',           ARRAY['union_bank','union_wallet','insurance_bank'],
                                (s1.union_wallets + COALESCE(s1.club_insurance, 0))
                              - (s0.union_wallets + COALESCE(s0.club_insurance, 0))),
      /* agent promo is journalled as promo_wallet, so it belongs to the promo
         account above and not to this one. */
      ('agent_wallets',         ARRAY['agent_wallet'],
                                (s1.agent_wallets - COALESCE(s1.agent_promo, 0))
                              - (s0.agent_wallets - COALESCE(s0.agent_promo, 0))),
      ('club_wallets',          ARRAY['club_wallet'],                                    s1.club_wallets          - s0.club_wallets),
      ('leaderboard_liability', ARRAY['opening_setup','leaderboard_round'],              s1.leaderboard_liability - s0.leaderboard_liability),
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
    -- ISSUED is the sum of the accounts (standard 1.2), never a stored column.
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

REVOKE ALL ON FUNCTION public.fn_ca_trial_balance(timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance(timestamp with time zone) TO service_role;

-- Self-check: the rebaselined snapshot carries the club stores, and a snapshot
-- taken right now on the new basis does not report the club promo float as a
-- one-time swing. Rolled back either way; the real snapshot is the cron's.
DO $selfcheck$
DECLARE
  v_before      numeric;
  v_club_promo  numeric;
  v_unexplained numeric;
  v_swing       numeric;
BEGIN
  SELECT COALESCE(club_promo, -1) INTO v_before
    FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF v_before < 0 THEN
    RAISE EXCEPTION 'PROMO_METER_SELFCHECK: the latest snapshot was not rebaselined';
  END IF;

  SELECT COALESCE(sum(COALESCE(promo_balance, 0)), 0) INTO v_club_promo FROM public.clubs;

  -- A plpgsql sub-block is a subtransaction: take a real snapshot on the new
  -- basis inside it, read the swing, then throw the sentinel so everything the
  -- probe wrote (the snapshot row, any incident it raised) is rolled back.
  BEGIN
    v_unexplained := public.fn_ca_supply_snapshot();
    v_swing := COALESCE(v_unexplained, 0);
    RAISE EXCEPTION 'PROMO_METER_PROBE_ROLLBACK %', v_swing
      USING ERRCODE = 'raise_exception';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'PROMO_METER_PROBE_ROLLBACK %' THEN
      RAISE;
    END IF;
    v_swing := replace(SQLERRM, 'PROMO_METER_PROBE_ROLLBACK ', '')::numeric;
  END;

  IF v_club_promo > 100 AND abs(v_swing) >= v_club_promo THEN
    RAISE EXCEPTION
      'PROMO_METER_SELFCHECK: the first snapshot on the new basis swung by %, which is the club promo float itself (%)',
      v_swing, v_club_promo;
  END IF;

  RAISE NOTICE 'PROMO_METER_SELFCHECK_OK: club promo % is on the meter, probe swing %',
    v_club_promo, v_swing;
END
$selfcheck$;