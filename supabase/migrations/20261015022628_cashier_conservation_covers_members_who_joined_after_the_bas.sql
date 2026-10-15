-- 20261015022628_cashier_conservation_covers_members_who_joined_after_the_bas.sql
-- Cashier conservation covers members who joined after the club baseline.
-- Reserved by scripts/new-migration.mjs; earlier installed migrations are immutable.
--
-- ROOT CAUSE (read live 2026-10-15 through the signed-in owner's Advanced
-- Cashier, SHARK CLUB): the Reconciliation Console reads "Coverage Incomplete,
-- 590 of 594 checked, 4 unverified positions". public.ca_chip_baseline was
-- taken once, 2026-08-27 01:08:13 UTC, and nothing ever adds a row for a member
-- who joins later, so every new member is permanently "unverified" and the gap
-- grows with every join (428 members across all clubs today).
--
-- THE FIX: a member with no baseline row who joined at or after the club's
-- baseline cutoff is checked from an opening balance of zero at that same
-- cutoff. club_members.chip_balance is NOT NULL DEFAULT 0, membership is created
-- empty, and every chip since is a booked chip_ledger leg. Read before install:
-- all 428 such members across every club equal their full ledger net from zero,
-- zero differing, and none joined before the cutoff. Reusing the existing cutoff
-- adds no extra ledger scan. A balance written without a leg still surfaces as a
-- mismatch, so this widens the check rather than hiding anything.
--
-- Authority, chip-club scope, bank leg, inventory and the JSON contract are
-- unchanged. Read-only report: it moves no chips and repairs no balance.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)') AND md5(prosrc)='e7deb39b8249dcafe6849a81df6f714a' AND prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE'))
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_cashier_conservation_report(uuid)')))
     IS DISTINCT FROM '7e64f42dd89bd5b50d4e92c8971ca5e5' THEN
    RAISE EXCEPTION 'Cashier Conservation Preimage Changed Or Migration Already Applied'
      USING ERRCODE = '55000';
  END IF;
END;
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $conservation_report$
DECLARE v_report jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE='42501';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'Club Required' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND status='deleted')
    OR NOT public.fn_cashier_member_is_active(p_club_id,auth.uid())
    OR coalesce(public.fn_club_bank_role(p_club_id,auth.uid()),'')
      NOT IN ('owner','co_owner','admin') THEN
    RAISE EXCEPTION 'Active Club Finance Access Required' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='chips') THEN
    RAISE EXCEPTION 'Accounting Report Covers Chip Clubs Only' USING ERRCODE='22023';
  END IF;

  -- chip_ledger records booked movement, including correction/reversal legs.
  -- Its validated NOT NULL status contract admits only posted/correction/reversal.
  -- Read every leg; filtering only posted would omit real money and force heap
  -- reads instead of the existing covering player-wallet index.
  WITH bank AS MATERIALIZED (
    SELECT c.chip_treasury AS actual,b.opening_balance,b.taken_at,
      b.opening_balance
        + coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.club_id=p_club_id AND l.to_type='club_treasury'
            AND l.to_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0)
        - coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.club_id=p_club_id AND l.from_type='club_treasury'
            AND l.from_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0) AS expected
    FROM public.clubs c LEFT JOIN public.ca_treasury_baseline b ON b.club_id=c.id
    WHERE c.id=p_club_id
  ), baselines AS MATERIALIZED (
    SELECT user_id,opening_balance,taken_at FROM public.ca_chip_baseline WHERE club_id=p_club_id
    UNION ALL
    -- A member who joined after the club baseline was taken entered with no
    -- chips: every chip they have held since is a booked ledger leg. They are
    -- checked from zero at the club's existing cutoff, so no new scan is added.
    -- A balance written without a leg still surfaces as a mismatch.
    SELECT m.user_id,0::numeric,f.taken_at
    FROM public.club_members m
    CROSS JOIN (SELECT min(taken_at) AS taken_at FROM public.ca_chip_baseline
      WHERE club_id=p_club_id) f
    WHERE m.club_id=p_club_id AND f.taken_at IS NOT NULL AND m.joined_at>=f.taken_at
      AND NOT EXISTS (SELECT 1 FROM public.ca_chip_baseline x
        WHERE x.club_id=p_club_id AND x.user_id=m.user_id)
  ), cutoffs AS MATERIALIZED (
    SELECT DISTINCT taken_at FROM baselines
  ), legs AS MATERIALIZED (
    -- One pass over the club's covering player-wallet legs per distinct baseline
    -- cutoff. Both wallet sides are grouped from that single scan with grouping
    -- sets; a leg whose side is not a player wallet collapses into one NULL key,
    -- so only real wallet positions are hashed and nothing spills to disk. Each
    -- position still uses its own baseline cutoff in the join below.
    SELECT c.taken_at, g.uid, g.amt
    FROM cutoffs c
    CROSS JOIN LATERAL (
      SELECT coalesce(x.credit_user,x.debit_user) AS uid,
        CASE WHEN GROUPING(x.credit_user)=0 THEN sum(x.a) ELSE -sum(x.a) END AS amt
      FROM (
        SELECT CASE WHEN l.to_type='player_wallet' THEN l.to_entity_id END AS credit_user,
          CASE WHEN l.from_type='player_wallet' THEN l.from_entity_id END AS debit_user,
          l.amount AS a
        FROM public.chip_ledger l
        WHERE l.club_id=p_club_id AND l.created_at>=c.taken_at
          AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
      ) x
      GROUP BY GROUPING SETS ((x.credit_user),(x.debit_user))
    ) g
  ), moves AS MATERIALIZED (
    SELECT b.user_id, sum(g.amt) AS net
    FROM baselines b
    JOIN legs g ON g.taken_at=b.taken_at AND g.uid=b.user_id
    GROUP BY b.user_id
  ), positions AS MATERIALIZED (
    SELECT coalesce(m.user_id,b.user_id) AS user_id,m.chip_balance AS actual,
      b.opening_balance,b.taken_at,b.opening_balance+coalesce(mv.net,0) AS expected
    FROM (SELECT user_id,chip_balance FROM public.club_members WHERE club_id=p_club_id) m
    FULL JOIN baselines b USING(user_id)
    LEFT JOIN moves mv ON mv.user_id=b.user_id
  ), classified AS (
    SELECT *,actual IS NOT NULL AND opening_balance IS NOT NULL
      AND taken_at IS NOT NULL AND taken_at<=statement_timestamp() AS covered
    FROM positions
  ), totals AS (
    SELECT count(*) AS positions,count(*) FILTER(WHERE covered) AS checked,
      count(*) FILTER(WHERE NOT covered) AS missing,
      count(*) FILTER(WHERE covered AND actual<>expected) AS mismatches,
      coalesce(sum(abs(actual-expected)) FILTER(WHERE covered),0) AS absolute_drift,
      coalesce(sum(actual-expected) FILTER(WHERE covered),0) AS net_drift,
      sum(actual) FILTER(WHERE covered) AS actual,sum(expected) FILTER(WHERE covered) AS expected
    FROM classified
  )
  SELECT jsonb_build_object(
    'schema_version',1,'club_id',p_club_id,'as_of',statement_timestamp(),
    'scope','bank_and_player_baselines',
    'bank',jsonb_build_object(
      'status',CASE WHEN b.actual IS NULL OR b.opening_balance IS NULL OR b.taken_at IS NULL
        OR b.taken_at>statement_timestamp() THEN 'incomplete'
        WHEN b.actual<>b.expected THEN 'attention' ELSE 'verified' END,
      'actual',b.actual::text,'expected',b.expected::text,
      'drift',CASE WHEN b.taken_at<=statement_timestamp() THEN (b.actual-b.expected)::text END,
      'baseline_at',b.taken_at),
    'players',jsonb_build_object(
      'status',CASE WHEN t.mismatches>0 THEN 'attention'
        WHEN t.missing>0 OR t.checked=0 THEN 'incomplete' ELSE 'verified' END,
      'positions',t.positions,'checked',t.checked,'missing',t.missing,'mismatches',t.mismatches,
      'actual',t.actual::text,'expected',t.expected::text,
      'net_drift',t.net_drift::text,'absolute_drift',t.absolute_drift::text),
    'inventory',jsonb_build_object(
      'agent_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE agent_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(agent_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'promo_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE promo_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(promo_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'held_chips',(SELECT CASE WHEN count(*) FILTER(WHERE held_chips IS NULL)>0
        THEN NULL ELSE coalesce(sum(held_chips),0)::text END FROM public.club_members WHERE club_id=p_club_id),
      'cash_stacks',(SELECT CASE WHEN count(*) FILTER(WHERE s.stack IS NULL)>0
        THEN NULL ELSE coalesce(sum(s.stack),0)::text END FROM public.table_seats s
        JOIN public.tables t ON t.id=s.table_id WHERE t.club_id=p_club_id
          AND t.tournament_id IS NULL AND s.left_at IS NULL)
    )
  ) INTO v_report FROM bank b CROSS JOIN totals t;
  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE='22023';
  END IF;
  RETURN v_report;
END;
$conservation_report$;

DO $postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)')
      AND md5(prosrc)='e7deb39b8249dcafe6849a81df6f714a'
      AND prosecdef AND provolatile='s'
      AND pg_get_userbyid(proowner)='postgres'
      AND proconfig @> ARRAY['search_path=public, pg_temp']
      AND NOT has_function_privilege('anon',oid,'EXECUTE')
      AND has_function_privilege('authenticated',oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Cashier Conservation Install Verification Failed' USING ERRCODE='55000';
  END IF;
END;
$postcondition$;
COMMIT;
