-- 20261019093951_the_cashier_conservation_bank_side_reads_the_bank_entity.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE CASHIER CONSERVATION REPORT READS THE BANK BY ITS OWN ENTITY (issue #7321)
--
-- WHAT WAS WRONG, READ FROM PRODUCTION (2026-10-19 09:29-09:37 UTC):
--
-- Reconcile Now showed Midway Union's bank at drift -3,038.33 and Deep Stack
-- Society's at -81.14. Neither bank is short a chip. The bank side of
-- fn_cashier_conservation_report summed chip_ledger legs into and out of the
-- club treasury filtered by
--   l.club_id = p_club_id AND to/from_type = 'club_treasury'
--   AND to/from_entity_id = p_club_id
-- but club_id on a bank leg names the wallet club of the OTHER side, not the
-- bank. 20261003092151 (the owner-authorized overdue agent commission,
-- operation c419b506-79a3-465a-99ba-adca6e0e5c2e, 2026-10-03 10:25:23 UTC)
-- paid 79 commission pairs whose payee had no wallet in the paying club into
-- their wallet in another club, deliberately (its header, PAYEE WALLET):
--   from_type club_treasury, from_entity_id = the paying bank,
--   to_type player_wallet, club_id = the payee's wallet club.
-- The bank was debited (clubs.chip_treasury) and the leg names it, but the
-- report's club_id filter dropped the leg, so the bank's expected balance never
-- came down by it:
--   Midway Union fade0000-...0001   20 legs  3,038.33 (18 filed under Deep
--     Stack Society 4.95, 2 under Club JAQK 3,033.38)
--   Deep Stack Society 2a1132b9-... 59 legs     81.14 (filed under Club JAQK)
--   79 legs, 3,119.47, every one category commission, status posted.
--
-- THE ROOT FIX: the bank side selects bank movement by the bank entity only
-- (to_type='club_treasury' AND to_entity_id = club for credits, from_type=
-- 'club_treasury' AND from_entity_id = club for debits), whatever club_id the
-- leg is filed under. That is the definition fn_ca_treasury_positions, and so
-- reconcile_ledger_nightly, already uses, and those banks have always read
-- 0.00 there. The player side is unchanged: it still reads player-wallet legs
-- by club_id, which is the wallet's club, so those 79 credits keep counting for
-- the payee's wallet where they landed. Every other field, guard, grant and the
-- STABLE / SECURITY DEFINER / search_path posture is unchanged; the sealed-day
-- player read of 20261017184739 is byte-for-byte the same.
--
-- MEASURED (read-only SELECTs, the report's two bank sums by hand, 09:37 UTC):
-- every one of the seven baselined banks reads drift 0.00 with this read;
-- under the old read Midway Union was -3,038.33 and Deep Stack Society -81.14,
-- all others unchanged. The sums are index-only scans of
-- idx_chip_ledger_treasury_in/_out (entity, created_at) INCLUDE (amount):
-- 3.5 ms for Club JAQK, 179 ms for all seven banks together.
--
-- NOTHING IS PAID, MOVED OR REWRITTEN. No chip is missing; no player is
-- affected; no ledger row, balance or settlement is touched. No repair job,
-- no compensating leg (CLAUDE.md 10.11/10.12): the reader was wrong, so the
-- reader is fixed.
--
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)') AND md5(prosrc)='bec5a65e6af9bdf7c823ac1e7fd9b138' AND prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE'))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';

-- The installed definition is exactly 20261017184739's (applied in production
-- as 20261017211312): pg_get_functiondef 884cbcbfae7f556ef0d5972e7e9b24c9,
-- prosrc 30cbcd45524b32a3a74ff1d10872fe8c, owner postgres, SECURITY DEFINER,
-- STABLE, search_path=public, pg_temp, EXECUTE to postgres, authenticated and
-- service_role only. Anything else is a different preimage and refuses whole.
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_cashier_conservation_report(uuid)')))
     IS DISTINCT FROM '884cbcbfae7f556ef0d5972e7e9b24c9' THEN
    RAISE EXCEPTION 'Cashier Conservation Preimage Changed Or Migration Already Applied'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)')
      AND md5(prosrc)='30cbcd45524b32a3a74ff1d10872fe8c'
      AND prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres'
      AND proconfig=ARRAY['search_path=public, pg_temp']
      AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'Cashier Conservation Preimage Posture Changed' USING ERRCODE = '55000';
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
  --
  -- The bank is read by its own entity: every leg into or out of this club's
  -- treasury, whatever club_id it is filed under. A bank leg's club_id names
  -- the wallet club of the other side (a commission this bank pays into the
  -- payee's wallet in another club is filed under that club), so it never
  -- selects bank movement. These are the legs fn_ca_treasury_positions and
  -- the nightly reconcile read, from idx_chip_ledger_treasury_in/_out.
  WITH bank AS MATERIALIZED (
    SELECT c.chip_treasury AS actual,b.opening_balance,b.taken_at,
      b.opening_balance
        + coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.to_type='club_treasury'
            AND l.to_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0)
        - coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.from_type='club_treasury'
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
    -- Late-member baselines reuse min(original taken_at), so they cannot add
    -- a cutoff. Read the same set from its analyzed table: the UNION-derived
    -- materialization otherwise estimates 200 cutoffs and batches a huge hash.
    SELECT DISTINCT taken_at FROM public.ca_chip_baseline WHERE club_id=p_club_id
  ), spans AS MATERIALIZED (
    -- Each cutoff reads its own UTC day raw from the cutoff, then the run of
    -- consecutive SEALED days after it, then everything from the first day
    -- that is not sealed, raw. A seal counts only while it carries its day's
    -- current manifest hash: a restated or newly attested day is read raw
    -- again until it is sealed again. The three parts are disjoint and cover
    -- [cutoff, now) exactly, so the result is the full-journal result. A NULL
    -- cutoff yields NULL bounds and reads nothing, exactly as before.
    SELECT c.taken_at, f.first_day,
      coalesce((
        SELECT min(g.d)::date
        FROM generate_series(f.first_day::timestamp,
          (statement_timestamp() AT TIME ZONE 'UTC')::date::timestamp + interval '1 day',
          interval '1 day') g(d)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.ca_chip_wallet_day_seals s
          LEFT JOIN public.ca_ledger_day_manifests m ON m.day=s.day
          WHERE s.day=g.d::date AND s.manifest_sha256 IS NOT DISTINCT FROM m.sha256)
      ), f.first_day) AS open_from
    FROM cutoffs c
    CROSS JOIN LATERAL (SELECT (c.taken_at AT TIME ZONE 'UTC')::date + 1 AS first_day) f
  ), ranges AS MATERIALIZED (
    SELECT taken_at, taken_at AS lo, (first_day::timestamp AT TIME ZONE 'UTC') AS hi FROM spans
    UNION ALL
    SELECT taken_at, (open_from::timestamp AT TIME ZONE 'UTC'), 'infinity'::timestamptz FROM spans
  ), legs AS MATERIALIZED (
    -- The raw parts are bounded index ranges over the club's covering
    -- player-wallet legs. Both wallet sides are grouped from one scan per
    -- range with grouping sets; a leg whose side is not a player wallet
    -- collapses into one NULL key. Sealed days add their stored per-member
    -- nets. Each position still uses its own baseline cutoff in the join below.
    SELECT r.taken_at, g.uid, g.amt
    FROM ranges r
    CROSS JOIN LATERAL (
      SELECT coalesce(x.credit_user,x.debit_user) AS uid,
        CASE WHEN GROUPING(x.credit_user)=0 THEN sum(x.a) ELSE -sum(x.a) END AS amt
      FROM (
        SELECT CASE WHEN l.to_type='player_wallet' THEN l.to_entity_id END AS credit_user,
          CASE WHEN l.from_type='player_wallet' THEN l.from_entity_id END AS debit_user,
          l.amount AS a
        FROM public.chip_ledger l
        WHERE l.club_id=p_club_id AND l.created_at>=r.lo AND l.created_at<r.hi
          AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
      ) x
      GROUP BY GROUPING SETS ((x.credit_user),(x.debit_user))
    ) g
    UNION ALL
    -- One row per member per cutoff, however many days are sealed.
    SELECT s.taken_at, t.user_id, sum(t.net)
    FROM spans s
    JOIN public.ca_chip_wallet_day_totals t
      ON t.club_id=p_club_id AND t.day>=s.first_day AND t.day<s.open_from
    GROUP BY s.taken_at, t.user_id
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
      AND md5(prosrc)='bec5a65e6af9bdf7c823ac1e7fd9b138'
      AND prosecdef AND provolatile='s'
      AND pg_get_userbyid(proowner)='postgres'
      AND proconfig=ARRAY['search_path=public, pg_temp']
      AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
      AND NOT has_function_privilege('anon',oid,'EXECUTE')
      AND has_function_privilege('authenticated',oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Cashier Conservation Install Verification Failed' USING ERRCODE='55000';
  END IF;
END;
$postcondition$;
COMMIT;
