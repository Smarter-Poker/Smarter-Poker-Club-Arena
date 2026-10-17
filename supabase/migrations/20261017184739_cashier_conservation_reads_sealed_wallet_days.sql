-- 20261017184739_cashier_conservation_reads_sealed_wallet_days.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG, READ FROM PRODUCTION (2026-10-17):
--
-- Reconcile Now returned HTTP 500 in post-deploy run 39051205956
-- (production-cashier.spec.ts:92): Postgres logged "canceling statement due to
-- statement timeout" at 17:03:18.361 UTC, the second the request failed, and
-- `authenticated` runs with statement_timeout=8s. Issue #7309.
--
-- fn_cashier_conservation_report re-added EVERY player-wallet leg in
-- chip_ledger since the club's chip baseline, on every call. For Club JAQK
-- that is one cutoff (2026-08-27 01:08 UTC) and 1,069,678 legs: 4,543 ms cold
-- for that one CTE, measured with EXPLAIN ANALYZE. Eight earlier migrations
-- (20261011..20261016) each made that same full read cheaper; none stopped it
-- growing, and horse play adds ~180k JAQK legs a day. The read was O(history).
--
-- THE ROOT FIX: a finished day is summed once, and then never re-read.
--
-- chip_ledger is append-only (trg_ca_append_only refuses UPDATE of any
-- amount, side, entity or created_at, and DELETE, unless app.ledger_maintenance
-- is set and recorded), and every UTC day is attested by
-- ca_ledger_day_manifests at 04:25 with a SHA-256 over its rows - a hash that
-- fn_ca_attested_day_is_restated rewrites whenever authorised maintenance
-- touches that day. created_at is the inserting transaction's now(): no SQL
-- function supplies one and no engine or client code writes chip_ledger.
--
--   ca_chip_wallet_day_seals    one row per sealed UTC day: the manifest
--                               hash it was sealed against and its row count.
--   ca_chip_wallet_day_totals   per (club, day, member) net of that day's
--                               player-wallet legs, both sides, every status.
--   fn_ca_chip_wallet_day_seal  seals finished days. A day is sealed only
--                               when its manifest exists and counts exactly
--                               the rows the journal holds (or the day has no
--                               rows and no manifest), and only when no client
--                               transaction that began before the day ended
--                               is still open - so no late row can land in it.
--                               It also withdraws any seal whose manifest
--                               changed, and re-counts each sealed day about
--                               once a day, withdrawing any that no longer
--                               match.
--
-- The report now reads, per baseline cutoff: the cutoff's own day raw from
-- the cutoff, the consecutive run of VALID sealed days after it from the
-- totals, and everything from the first unsealed day raw. A seal is valid only
-- while it carries its day's current manifest hash; anything in doubt is read
-- raw, so the worst case is the old cost, never a different answer. The three
-- parts are disjoint and cover [cutoff, now) exactly. Every field, guard,
-- grant and the STABLE / SECURITY DEFINER / search_path posture of the report
-- is unchanged; only the cutoffs -> legs read changes.
--
-- What the read costs now: the cutoff day (once, bounded), today, and
-- yesterday until its manifest lands - no longer the whole history.
--
-- periodic-work: ca-chip-wallet-day-seal runs hourly at :30 to seal finished
-- days for the conservation report's read. It writes only its own two derived
-- tables, never a balance, ledger row or payout, and the report is exact
-- without it (an unsealed day is read raw); it only keeps the read bounded.
--
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)') AND md5(prosrc)='30cbcd45524b32a3a74ff1d10872fe8c' AND prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE')) AND to_regprocedure('public.fn_ca_chip_wallet_day_seal(integer)') IS NOT NULL AND NOT has_function_privilege('authenticated','public.fn_ca_chip_wallet_day_seal(integer)','EXECUTE') AND EXISTS (SELECT 1 FROM cron.job WHERE jobname='ca-chip-wallet-day-seal' AND schedule='30 * * * *' AND active)
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_cashier_conservation_report(uuid)')))
     IS DISTINCT FROM 'f3728357280a30789ff8d7bb30140eae' THEN
    RAISE EXCEPTION 'Cashier Conservation Preimage Changed Or Migration Already Applied'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.ca_chip_wallet_day_seals') IS NOT NULL
     OR to_regclass('public.ca_chip_wallet_day_totals') IS NOT NULL THEN
    RAISE EXCEPTION 'Sealed Wallet Day Tables Already Exist' USING ERRCODE = '55000';
  END IF;
END;
$preimage$;

-- No foreign key to any hot table (CLAUDE.md production DDL policy rule 7);
-- the only one is totals -> seals, both owned here, so withdrawing a seal
-- withdraws its totals in the same statement.
CREATE TABLE public.ca_chip_wallet_day_seals (
  day date PRIMARY KEY,
  manifest_sha256 text,
  ledger_rows bigint NOT NULL CHECK (ledger_rows >= 0),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  CHECK (manifest_sha256 IS NOT NULL OR ledger_rows = 0)
);
CREATE TABLE public.ca_chip_wallet_day_totals (
  club_id uuid NOT NULL,
  day date NOT NULL REFERENCES public.ca_chip_wallet_day_seals(day) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  net numeric NOT NULL,
  PRIMARY KEY (club_id, day, user_id)
);
CREATE INDEX ca_chip_wallet_day_totals_by_day ON public.ca_chip_wallet_day_totals (day);
COMMENT ON TABLE public.ca_chip_wallet_day_seals IS
  'UTC days whose player-wallet legs are summed in ca_chip_wallet_day_totals. Valid only while manifest_sha256 equals the day''s ca_ledger_day_manifests hash. Written only by fn_ca_chip_wallet_day_seal; read only by fn_cashier_conservation_report.';
COMMENT ON TABLE public.ca_chip_wallet_day_totals IS
  'Per club, UTC day and member: the net of that day''s chip_ledger player-wallet legs (credits minus debits, every status). Derived; holds no chips.';
ALTER TABLE public.ca_chip_wallet_day_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_chip_wallet_day_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_chip_wallet_day_seals FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.ca_chip_wallet_day_totals FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_wallet_day_seal(p_max_days integer DEFAULT 4)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $seal$
DECLARE
  v_today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
  v_first date;
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_sha text;
  v_manifest_rows bigint;
  v_rows bigint;
  v_sealed date[] := '{}';
  v_withdrawn date[] := '{}';
  v_checked integer := 0;
  v_waiting text;
  r record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('fn_ca_chip_wallet_day_seal')) THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'another seal is running');
  END IF;

  -- 1. A seal whose day's manifest changed (restated after maintenance, or
  --    attested after a zero-row seal) no longer describes the journal.
  FOR r IN
    SELECT s.day FROM public.ca_chip_wallet_day_seals s
    LEFT JOIN public.ca_ledger_day_manifests m ON m.day = s.day
    WHERE s.manifest_sha256 IS DISTINCT FROM m.sha256
  LOOP
    DELETE FROM public.ca_chip_wallet_day_seals WHERE day = r.day;
    v_withdrawn := v_withdrawn || r.day;
  END LOOP;

  -- 2. Re-count each sealed day about once a day. A row that reached a sealed
  --    day afterwards changes its count, and the seal is withdrawn.
  FOR r IN
    SELECT s.day, s.ledger_rows FROM public.ca_chip_wallet_day_seals s
    WHERE s.checked_at < now() - interval '20 hours'
    ORDER BY s.checked_at, s.day
    LIMIT 12
  LOOP
    SELECT count(*) INTO v_rows FROM public.chip_ledger
     WHERE created_at >= (r.day::timestamp AT TIME ZONE 'UTC')
       AND created_at < ((r.day + 1)::timestamp AT TIME ZONE 'UTC');
    v_checked := v_checked + 1;
    IF v_rows <> r.ledger_rows THEN
      DELETE FROM public.ca_chip_wallet_day_seals WHERE day = r.day;
      v_withdrawn := v_withdrawn || r.day;
    ELSE
      UPDATE public.ca_chip_wallet_day_seals SET checked_at = now() WHERE day = r.day;
    END IF;
  END LOOP;

  -- 3. Seal finished days, oldest first, from the first day any baseline
  --    reads from the totals (the day after the earliest cutoff).
  SELECT min((taken_at AT TIME ZONE 'UTC')::date) + 1 INTO v_first
    FROM public.ca_chip_baseline WHERE taken_at IS NOT NULL;

  IF v_first IS NOT NULL THEN
    FOR v_day IN
      SELECT g.d::date FROM generate_series(v_first::timestamp, (v_today - 1)::timestamp, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.ca_chip_wallet_day_seals s WHERE s.day = g.d::date)
      ORDER BY 1
      LIMIT greatest(coalesce(p_max_days, 0), 0)
    LOOP
      v_start := v_day::timestamp AT TIME ZONE 'UTC';
      v_end := (v_day + 1)::timestamp AT TIME ZONE 'UTC';

      -- A client transaction that began before the day ended could still
      -- insert a row dated inside it. Wait for it rather than seal around it.
      IF EXISTS (SELECT 1 FROM pg_stat_activity a
                  WHERE a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'
                    AND (a.state IS NULL OR a.xact_start < v_end))
         OR EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
        v_waiting := format('%s: a transaction that began before it ended is still open', v_day);
        EXIT;
      END IF;

      SELECT m.sha256, m.row_count INTO v_sha, v_manifest_rows
        FROM public.ca_ledger_day_manifests m WHERE m.day = v_day;
      SELECT count(*) INTO v_rows FROM public.chip_ledger
       WHERE created_at >= v_start AND created_at < v_end;

      IF v_sha IS NULL AND v_rows > 0 THEN
        v_waiting := format('%s: its ledger manifest has not been attested yet', v_day);
        EXIT;
      END IF;
      IF v_sha IS NOT NULL AND v_rows <> v_manifest_rows THEN
        v_waiting := format('%s: the journal holds %s rows and its manifest attests %s', v_day, v_rows, v_manifest_rows);
        EXIT;
      END IF;

      INSERT INTO public.ca_chip_wallet_day_seals (day, manifest_sha256, ledger_rows)
      VALUES (v_day, v_sha, v_rows);

      -- The same legs the report reads (club set, either side a player
      -- wallet, every status), grouped by side in one pass over the day.
      INSERT INTO public.ca_chip_wallet_day_totals (club_id, day, user_id, net)
      SELECT y.club_id, v_day, y.uid, sum(y.amt)
      FROM (
        SELECT x.club_id, coalesce(x.credit_user, x.debit_user) AS uid,
          CASE WHEN GROUPING(x.credit_user)=0 THEN sum(x.a) ELSE -sum(x.a) END AS amt
        FROM (
          SELECT l.club_id,
            CASE WHEN l.to_type='player_wallet' THEN l.to_entity_id END AS credit_user,
            CASE WHEN l.from_type='player_wallet' THEN l.from_entity_id END AS debit_user,
            l.amount AS a
          FROM public.chip_ledger l
          WHERE l.created_at >= v_start AND l.created_at < v_end
            AND l.club_id IS NOT NULL
            AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
        ) x
        GROUP BY GROUPING SETS ((x.club_id, x.credit_user), (x.club_id, x.debit_user))
      ) y
      WHERE y.uid IS NOT NULL
      GROUP BY y.club_id, y.uid;

      v_sealed := v_sealed || v_day;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ran', true, 'sealed', to_jsonb(v_sealed),
    'withdrawn', to_jsonb(v_withdrawn), 'rechecked', v_checked, 'waiting', v_waiting);
END;
$seal$;
REVOKE ALL ON FUNCTION public.fn_ca_chip_wallet_day_seal(integer) FROM PUBLIC, anon, authenticated, service_role;

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

SELECT cron.schedule('ca-chip-wallet-day-seal', '30 * * * *', 'SELECT public.fn_ca_chip_wallet_day_seal()');

DO $postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)')
      AND md5(prosrc)='30cbcd45524b32a3a74ff1d10872fe8c'
      AND prosecdef AND provolatile='s'
      AND pg_get_userbyid(proowner)='postgres'
      AND proconfig @> ARRAY['search_path=public, pg_temp']
      AND NOT has_function_privilege('anon',oid,'EXECUTE')
      AND has_function_privilege('authenticated',oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Cashier Conservation Install Verification Failed' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid=to_regprocedure('public.fn_ca_chip_wallet_day_seal(integer)')
      AND prosecdef AND provolatile='v'
      AND pg_get_userbyid(proowner)='postgres'
      AND proconfig @> ARRAY['search_path=public, pg_temp']
      AND NOT has_function_privilege('anon',oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.ca_chip_wallet_day_seals'::regclass, 'public.ca_chip_wallet_day_totals'::regclass)
      AND (NOT relrowsecurity
        OR has_table_privilege('anon', oid, 'SELECT') OR has_table_privilege('authenticated', oid, 'SELECT'))
  ) OR NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname='ca-chip-wallet-day-seal' AND schedule='30 * * * *'
      AND command='SELECT public.fn_ca_chip_wallet_day_seal()'
  ) THEN
    RAISE EXCEPTION 'Sealed Wallet Day Install Verification Failed' USING ERRCODE='55000';
  END IF;
END;
$postcondition$;
COMMIT;
