-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827051624; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- club_hand_daily STOPS SERIALISING ON ONE ROW
-- ═══════════════════════════════════════════════════════════════════════════
-- `INSERT INTO hand_history` is 8.1% of database CPU at 25.41 ms mean, for a
-- SINGLE-ROW INSERT. The cause is trg_hand_history_club_member_stats, whose
-- last statement upserts club_hand_daily -- a table holding exactly ONE ROW
-- PER CLUB PER DAY. Measured 2026-08-27: 1 row for today, 40,437 hands already
-- contending on it, on course for ~460,000 by midnight. Every hand insert on a
-- club queues behind the same row lock for the length of its transaction.
--
-- (20260823340000 already fought this one level up -- its title is
-- "hand_history stops serialising on one row" -- by moving the upsert to the
-- END of the trigger so the lock is held for less of the transaction. That
-- helped. It could not fix the fact that there is only one row to lock.)
--
-- THE FIX: shard the counter across 16 rows chosen by backend pid, so
-- concurrent writers land on different rows instead of queueing. The name
-- every reader uses becomes a VIEW that sums the shards, so all five reader
-- functions and both app call sites are untouched. Audited across both repos:
-- there is no `.from('club_hand_daily')` anywhere; every application access is
-- a read through an RPC.
--
-- security_invoker ON THE VIEW IS LOAD-BEARING. The base table has RLS ENABLED
-- WITH ZERO POLICIES (deny-all) while its grants still list anon:SELECT. A
-- default view runs as its OWNER and would have handed anon the whole table.
--
-- ca_backfill_club_hand_daily writes ABSOLUTE totals, so it REPLACES every
-- shard rather than adding a seventeenth. Probed: 999 after backfill, not 1016.
--
-- ROLLBACK:
--   DROP VIEW public.club_hand_daily;
--   CREATE TABLE public.club_hand_daily AS
--     SELECT club_id, stat_date, sum(hands)::bigint hands, sum(rake) rake,
--            sum(bbj) bbj, sum(pot_total) pot_total, max(updated_at) updated_at
--       FROM public.club_hand_daily_shard GROUP BY club_id, stat_date;
--   ALTER TABLE public.club_hand_daily ADD CONSTRAINT club_hand_daily_pkey
--     PRIMARY KEY (club_id, stat_date);
--   ALTER TABLE public.club_hand_daily ENABLE ROW LEVEL SECURITY;
--   DROP TABLE public.club_hand_daily_shard;
--   -- then restore both function bodies from migration 20260823340000.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.club_hand_daily RENAME TO club_hand_daily_shard;
ALTER TABLE public.club_hand_daily_shard ADD COLUMN shard smallint NOT NULL DEFAULT 0;
ALTER TABLE public.club_hand_daily_shard DROP CONSTRAINT club_hand_daily_pkey;
ALTER TABLE public.club_hand_daily_shard
  ADD CONSTRAINT club_hand_daily_shard_pkey PRIMARY KEY (club_id, stat_date, shard);

COMMENT ON TABLE public.club_hand_daily_shard IS
  'Sharded per-club daily hand counters. Never read this directly - read the club_hand_daily view, which sums the shards. Sharded 2026-08-27 because one row per club per day was serialising 460,000 hand inserts a day behind a single row lock.';

CREATE VIEW public.club_hand_daily WITH (security_invoker = true) AS
SELECT club_id,
       stat_date,
       sum(hands)::bigint AS hands,
       sum(rake)          AS rake,
       sum(bbj)           AS bbj,
       sum(pot_total)     AS pot_total,
       max(updated_at)    AS updated_at
FROM public.club_hand_daily_shard
GROUP BY club_id, stat_date;

COMMENT ON VIEW public.club_hand_daily IS
  'Sums club_hand_daily_shard. Was a table until 2026-08-27; kept as a view so every reader is unchanged. security_invoker=true is load-bearing: the base table is RLS deny-all and a default view would run as owner and expose it.';

GRANT SELECT ON public.club_hand_daily TO service_role, authenticated, anon;

-- ── Repoint the trigger by SUBSTITUTION, not by retyping 4,676 characters. ──
DO $$
DECLARE src text; nsrc text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_hand_history_club_member_stats';
  IF src IS NULL THEN RAISE EXCEPTION 'trigger function not found'; END IF;

  nsrc := replace(src,
    'INSERT INTO club_hand_daily AS d (club_id, stat_date, hands, rake, bbj, pot_total)',
    'INSERT INTO club_hand_daily_shard AS d (club_id, stat_date, shard, hands, rake, bbj, pot_total)');
  nsrc := replace(nsrc,
    'VALUES (v_club, v_date, 1, coalesce(NEW.rake_amount, 0), coalesce(NEW.bbj_amount, 0), coalesce(NEW.pot_size, 0))',
    'VALUES (v_club, v_date, (pg_backend_pid() % 16)::smallint, 1, coalesce(NEW.rake_amount, 0), coalesce(NEW.bbj_amount, 0), coalesce(NEW.pot_size, 0))');
  nsrc := replace(nsrc,
    'ON CONFLICT (club_id, stat_date) DO UPDATE SET
    hands = d.hands + 1,',
    'ON CONFLICT (club_id, stat_date, shard) DO UPDATE SET
    hands = d.hands + 1,');

  IF nsrc = src THEN RAISE EXCEPTION 'no substitution applied - the body has drifted'; END IF;
  IF nsrc !~ 'club_hand_daily_shard AS d' THEN RAISE EXCEPTION 'shard target not written'; END IF;
  IF nsrc !~ 'pg_backend_pid\(\) % 16' THEN RAISE EXCEPTION 'shard selector not written'; END IF;
  IF nsrc ~ 'ON CONFLICT \(club_id, stat_date\) DO UPDATE SET\s+hands = d\.hands \+ 1' THEN
    RAISE EXCEPTION 'conflict target still unsharded - would error at runtime';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats() RETURNS trigger
       LANGUAGE plpgsql SET search_path = public AS %L', nsrc);
END $$;

-- ── Backfill REPLACES the shards, because it writes absolute totals. ────────
-- DROP first: CREATE OR REPLACE cannot remove the p_force DEFAULT, and the
-- signature must stay identical for the /api/cron/club-stats-maintenance call.
DROP FUNCTION IF EXISTS public.ca_backfill_club_hand_daily(uuid, date, boolean);

CREATE FUNCTION public.ca_backfill_club_hand_daily(
  p_club_id uuid, p_date date, p_force boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_hands bigint;
BEGIN
  IF p_date >= (now() AT TIME ZONE 'UTC')::date AND NOT coalesce(p_force, false) THEN
    RAISE EXCEPTION
      'refusing to overwrite the current day (%) - the trigger maintains it exactly; pass p_force => true only if you know it has drifted',
      p_date
      USING ERRCODE = '55000';
  END IF;

  /* Absolute totals, so every existing shard for this (club, date) goes first.
     Adding one more shard would leave the view summing the recount ON TOP of
     the counts it was meant to replace. */
  DELETE FROM club_hand_daily_shard WHERE club_id = p_club_id AND stat_date = p_date;

  INSERT INTO club_hand_daily_shard (club_id, stat_date, shard, hands, rake, bbj, pot_total)
  SELECT p_club_id, p_date, 0,
         count(*),
         coalesce(sum(hh.rake_amount), 0),
         coalesce(sum(hh.bbj_amount), 0),
         coalesce(sum(hh.pot_size), 0)
  FROM hand_history hh
  JOIN tables t ON t.id = hh.table_id
  WHERE t.club_id = p_club_id
    AND hh.created_at >= p_date::timestamp AT TIME ZONE 'UTC'
    AND hh.created_at <  (p_date + 1)::timestamp AT TIME ZONE 'UTC'
  HAVING count(*) > 0;

  SELECT hands INTO v_hands FROM club_hand_daily
   WHERE club_id = p_club_id AND stat_date = p_date;
  RETURN coalesce(v_hands, 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) TO service_role;

-- ── Assertions. ────────────────────────────────────────────────────────────
DO $$
DECLARE v_secinv boolean; v_kind char; v_shardcol int; v_totals bigint; v_view bigint;
BEGIN
  SELECT relkind INTO v_kind FROM pg_class WHERE relname = 'club_hand_daily';
  IF v_kind <> 'v' THEN RAISE EXCEPTION 'club_hand_daily is not a view (relkind %)', v_kind; END IF;

  SELECT reloptions::text LIKE '%security_invoker=true%' INTO v_secinv
    FROM pg_class WHERE relname = 'club_hand_daily';
  IF NOT v_secinv THEN
    RAISE EXCEPTION 'view is not security_invoker - would expose an RLS deny-all table to anon';
  END IF;

  SELECT count(*) INTO v_shardcol FROM information_schema.columns
   WHERE table_schema='public' AND table_name='club_hand_daily_shard' AND column_name='shard';
  IF v_shardcol <> 1 THEN RAISE EXCEPTION 'shard column missing'; END IF;

  SELECT sum(hands) INTO v_totals FROM public.club_hand_daily_shard;
  SELECT sum(hands) INTO v_view   FROM public.club_hand_daily;
  IF v_totals IS DISTINCT FROM v_view THEN
    RAISE EXCEPTION 'view total % != shard total %', v_view, v_totals;
  END IF;

  RAISE NOTICE 'club_hand_daily sharded; % hands preserved across the reshape', v_totals;
END $$;
