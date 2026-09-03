-- ═══════════════════════════════════════════════════════════════════════════════
--  THE TRIAL BALANCE TOTAL IS THE SUM OF ITS ROWS, NOT A COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found on the first live run of fn_ca_trial_balance over 24 hours, minutes
-- after 20260902203000_chip_std_controls applied. Every per-account row was
-- sane, and the total_supply row said the supply had grown by 4,364,262.71
-- chips with issuance 0.00.
--
-- It had not. ca_supply_snapshots.total was re-based at 2026-09-01 23:45:22
-- UTC (a snapshot with delta_vs_prev NULL): before it, total sat 4,350,390.20
-- BELOW the sum of the snapshot's own component columns; after it, total
-- equals that sum to the cent. Subtracting two totals across that boundary
-- reports the re-basing as a mint. The components never moved by more than a
-- few thousand.
--
-- The identity in the standard (section 1.2) is that ISSUED is the SUM of the
-- accounts, so the total row is now computed as the sum of the per-account
-- balance deltas the same call just reported. That makes the total row
-- consistent with its own table by construction and immune to any future
-- re-basing of the stored total. Nothing else in the function changes.
--
-- One CREATE OR REPLACE, one transaction, one PostgREST reload.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance(
  p_since timestamptz DEFAULT now() - interval '75 minutes'
)
RETURNS TABLE (
  account        text,
  balance_delta  numeric,
  ledger_net     numeric,
  difference     numeric,
  writers        text,
  window_start   timestamptz,
  window_end     timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
      ('promo_wallets',         ARRAY['promo_wallet'],                                   s1.member_promo          - s0.member_promo),
      ('table_stack',           ARRAY['table_stack'],                                    s1.felt                  - s0.felt),
      ('tournament_liability',  ARRAY['prize_liability','bounty_liability','refund_payable'],
                                                                                         s1.tournament_liability  - s0.tournament_liability),
      ('bbj_pools',             ARRAY['bbj_pool'],                                       s1.bbj_pools             - s0.bbj_pools),
      ('spin_reserve',          ARRAY['spin_reserve'],                                   s1.spin_pools            - s0.spin_pools),
      ('club_treasuries',       ARRAY['club_treasury'],                                  s1.treasuries            - s0.treasuries),
      ('club_chip_pools',       ARRAY[]::text[],                                         s1.chip_pools            - s0.chip_pools),
      ('union_banks',           ARRAY['union_bank','union_wallet','insurance_bank'],     s1.union_wallets         - s0.union_wallets),
      ('agent_wallets',         ARRAY['agent_wallet'],                                   s1.agent_wallets         - s0.agent_wallets),
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
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_trial_balance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance(timestamptz) TO service_role;

DO $$
DECLARE v_tot numeric; v_sum numeric;
BEGIN
  SELECT balance_delta INTO v_tot FROM public.fn_ca_trial_balance(now() - interval '24 hours')
   WHERE account = 'total_supply';
  SELECT sum(balance_delta) INTO v_sum FROM public.fn_ca_trial_balance(now() - interval '24 hours')
   WHERE account <> 'total_supply';
  IF v_tot IS DISTINCT FROM round(v_sum, 2) THEN
    RAISE EXCEPTION 'total_supply % is not the sum of the account rows %', v_tot, v_sum;
  END IF;
END $$;

COMMIT;
