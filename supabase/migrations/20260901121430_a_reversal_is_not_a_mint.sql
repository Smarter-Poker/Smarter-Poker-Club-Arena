-- A reversal is not a mint.
--
-- WHAT BROKE
-- ----------
-- fn_ca_supply_snapshot classifies supply movement against the chip ledger:
--
--     mint = sum(amount) where from_type IN ('system_mint','issuance_reserve')
--     burn = sum(amount) where to_type   IN ('system_burn','chip_retirement')
--
-- That is asymmetric. 'chip_retirement' is recognised as a SINK but never as a
-- SOURCE, and 'issuance_reserve' is recognised as a SOURCE but never as a SINK.
-- So the moment anybody REVERSES a retirement -- chips coming back out of
-- quarantine and into circulation -- the supply legitimately rises, a perfectly
-- good ledger row explains why, and the snapshot still books the whole thing as
-- "unexplained".
--
-- It had never fired because until today no retirement had ever been reversed.
-- Ledger history at the time of writing:
--
--     to_type   = 'chip_retirement'   38 rows   9,908,714.22
--     from_type = 'chip_retirement'    1 row    4,159,644.00   <- 2026-09-01 11:13
--     issuance_reserve                 0 rows   (either side, ever)
--
-- That one row is idempotency_key 'deep-stack-horse-memberships:restore-20260901',
-- a ledgered, hash-chained reversal restoring 416 Deep Stack Society horse
-- memberships that an earlier quarantine had retired. Both directions were
-- recorded correctly. Only the accounting had no term for the return trip.
--
-- WHAT IT COST
-- ------------
-- The 12:05 snapshot recorded unexplained = 4,159,902.13. scripts/ci/
-- check-chip-conservation.mjs fails the build when the trailing 4h sum of
-- unexplained exceeds 5,000, and that check is the Financial health-gate in
-- .github/workflows/auto-deploy-hetzner.yml. So from 10:26 onward EVERY engine
-- deploy was refused, the engine froze on an old commit, and issue #2435
-- (engine watchdog) opened. A bug in a diagnostic stopped the platform from
-- shipping.
--
-- Worth stating plainly: the guard was not wrong to shout. Supply really did
-- move by 4.16M. The defect is that it could not tell a ledgered reversal from
-- an unbacked mint, and it is precisely that distinction the gate exists to
-- make.
--
-- THE FIX
-- -------
-- Classify by DIRECTION ACROSS THE CIRCULATION BOUNDARY, not by a hand-listed
-- pair. Chips entering circulation from any non-circulating store are issuance;
-- chips leaving circulation into any non-circulating store are retirement. The
-- boundary set is named once, so a new store cannot be added to one side and
-- forgotten on the other.
--
-- Verified against production before applying, on the exact interval:
--     delta_vs_prev            4,159,902.13
--     as shipped               4,159,902.13   unexplained  (gate FAILS)
--     with this classification         258.13 unexplained  (gate passes)
-- 258.13 sits inside the ordinary hourly noise band (the ten preceding
-- intervals ran between -954.57 and +44.89).
--
-- This migration moves no money. It corrects an accounting classification and
-- recomputes the snapshot rows that classification had already mis-stated.
--
-- ONE THING THE DRY RUN CAUGHT, recorded because it would trap the next person
-- ------------------------------------------------------------------------
-- Recomputing EVERY historical row from the ledger is the obvious move and it
-- is wrong. The 10:05 row carries delta_vs_prev = 9,901,483.86 with unexplained
-- stored as 0 -- arithmetic the shipped function cannot produce. Somebody has
-- already reconciled that interval by hand. A blanket recompute would revert
-- their correction and re-break the very gate this migration is unblocking
-- (dry run: trailing 4h would go from 4,162,167.65 to 9,904,007.51).
--
-- So the UPDATE below is scoped to intervals containing a movement the OLD rule
-- could not see, and nothing else. That predicate matches exactly one row.
-- The assertions are scoped the same way, deliberately: this migration proves
-- its own work and does not sit in judgement on anybody else's.

-- ---------------------------------------------------------------------------
-- 1. The circulation boundary, named once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_noncirculating_chip_stores()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  -- Stores that sit OUTSIDE the circulating supply totalled by
  -- fn_ca_supply_snapshot. A ledger row whose from_type is one of these puts
  -- chips INTO circulation (issuance); a row whose to_type is one of these
  -- takes chips OUT (retirement). Both directions must be honoured or a
  -- reversal reads as a mint -- see the header of
  -- 20260902060000_a_reversal_is_not_a_mint.sql.
  SELECT ARRAY['system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement']::text[];
$function$;

COMMENT ON FUNCTION public.fn_ca_noncirculating_chip_stores() IS
  'The chip_ledger from_type/to_type values that sit outside circulating supply. Used symmetrically by fn_ca_supply_snapshot: out of one = issuance, into one = retirement.';

REVOKE ALL ON FUNCTION public.fn_ca_noncirculating_chip_stores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_noncirculating_chip_stores() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The snapshot, classifying symmetrically.
--    Everything below is byte-identical to the shipped function except the
--    two lines computing v_mint / v_burn.
-- ---------------------------------------------------------------------------
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
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
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
           + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab + s.lb_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  IF prev.id IS NOT NULL THEN
    -- Symmetric: out of a non-circulating store is issuance, into one is
    -- retirement. A row that is both (store to store) nets to zero by
    -- appearing in each sum once, which is correct -- it never touched
    -- circulation.
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(v_outside)),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(v_outside)),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at;
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, v_total,
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
END $function$;

-- ---------------------------------------------------------------------------
-- 3. Recompute the rows the old classification mis-stated.
--
--    Only rows whose interval contains a ledger movement the old rule could
--    not see are touched, and each is recomputed FROM THE LEDGER rather than
--    adjusted by a hand-typed figure. Every other row is left exactly as it
--    was recorded.
-- ---------------------------------------------------------------------------
WITH intervals AS (
  SELECT id,
         taken_at,
         lag(taken_at) OVER (ORDER BY taken_at) AS prev_at,
         delta_vs_prev,
         unexplained AS unexplained_old
    FROM public.ca_supply_snapshots
), affected AS (
  SELECT i.*,
         (SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(public.fn_ca_noncirculating_chip_stores())),0)
            FROM public.chip_ledger cl
           WHERE cl.created_at > i.prev_at AND cl.created_at <= i.taken_at) AS mint_new,
         (SELECT COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(public.fn_ca_noncirculating_chip_stores())),0)
            FROM public.chip_ledger cl
           WHERE cl.created_at > i.prev_at AND cl.created_at <= i.taken_at) AS burn_new
    FROM intervals i
   WHERE i.prev_at IS NOT NULL
     AND i.unexplained_old IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger cl
        WHERE cl.created_at > i.prev_at AND cl.created_at <= i.taken_at
          AND (cl.from_type IN ('chip_retirement')
            OR cl.to_type   IN ('issuance_reserve'))
     )
)
UPDATE public.ca_supply_snapshots t
   SET mint_since_prev = a.mint_new,
       burn_since_prev = a.burn_new,
       unexplained     = a.delta_vs_prev - a.mint_new + a.burn_new
  FROM affected a
 WHERE t.id = a.id
   AND t.unexplained IS DISTINCT FROM (a.delta_vs_prev - a.mint_new + a.burn_new);

-- ---------------------------------------------------------------------------
-- 4. Assert the outcome rather than trusting it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_trailing numeric;
  v_worst    numeric;
BEGIN
  SELECT COALESCE(sum(unexplained),0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;

  IF abs(v_trailing) > 5000 THEN
    RAISE EXCEPTION
      'trailing 4h unexplained is still % after reclassification - the deploy gate would still refuse; investigate rather than widening the threshold',
      round(v_trailing,2);
  END IF;

  -- Scoped to the rows this migration is responsible for: intervals carrying a
  -- movement the old rule could not see. Rows reconciled by hand elsewhere are
  -- intentionally out of scope (see the header).
  SELECT COALESCE(max(abs(diff)),0) INTO v_worst FROM (
    SELECT s.unexplained
         - ( s.delta_vs_prev
             - (SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(public.fn_ca_noncirculating_chip_stores())),0)
                  FROM public.chip_ledger cl
                 WHERE cl.created_at > p.taken_at AND cl.created_at <= s.taken_at)
             + (SELECT COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(public.fn_ca_noncirculating_chip_stores())),0)
                  FROM public.chip_ledger cl
                 WHERE cl.created_at > p.taken_at AND cl.created_at <= s.taken_at) ) AS diff
      FROM public.ca_supply_snapshots s
      JOIN LATERAL (SELECT taken_at FROM public.ca_supply_snapshots x
                     WHERE x.taken_at < s.taken_at ORDER BY x.taken_at DESC LIMIT 1) p ON true
     WHERE s.unexplained IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.chip_ledger cl
                    WHERE cl.created_at > p.taken_at AND cl.created_at <= s.taken_at
                      AND (cl.from_type = 'chip_retirement' OR cl.to_type = 'issuance_reserve'))
  ) q;

  IF v_worst > 0.01 THEN
    RAISE EXCEPTION 'a reclassified snapshot still disagrees with the ledger by %', round(v_worst,2);
  END IF;

  RAISE NOTICE 'reversal-aware supply accounting applied; trailing 4h unexplained now %', round(v_trailing,2);
END $$;
