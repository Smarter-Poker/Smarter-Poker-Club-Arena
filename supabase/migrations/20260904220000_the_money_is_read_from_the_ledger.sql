-- ═══════════════════════════════════════════════════════════════════════════
--  THE MONEY IS READ FROM THE LEDGER
--  Club Operations upgrade, phase 6 of 8 (finance truth). 2026-09-04.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every figure below was measured on Deep Stack Society (2a1132b9) before it
-- was changed. The club is four days old and dealt 216,140 hands on
-- 2026-09-03, which makes it the hardest case on the platform today.
--
-- WHAT WAS WRONG
--
-- 1. The Financials page summed the OLDEST 5,000 rake_records rows in the
--    browser and called that the week. 124,549 cash rake rows were written
--    in the three complete days the club has existed. Its rakeback line read
--    chip_transactions under RLS that returns only the viewer's OWN rows, so
--    an owner saw the rakeback paid to nobody but themselves. Its union-fee
--    line read invoice_type 'union_to_club', which the weekly square-up never
--    writes. Its export, its ledger panel and both report pages passed the
--    route slug into uuid arguments and failed on every slug URL.
--
-- 2. Four different numbers were called "hands" and two were called "rake":
--
--      rake_records cash, 2026-09-03      93,465 hands   190,144.32 rake
--      rake_attributions                  93,274         189,745.69
--      club_table_daily                   93,450         190,117.95
--      club_hand_daily (hand_history)    216,140         189,772.06
--      hand_history cash rows            177,022 dealt, 93,289 raked
--
--    rake_records is the money ledger: the row is written in the transaction
--    that credits the club (credit_club_wallet_rake), and 176 of its rows on
--    that day (372.26 chips) have NO hand_history row at all, so anything
--    derived from hand_history under-reports what the club was paid.
--    club_table_daily is derived from rake_records and was short by exactly
--    the 109 rows (173.38) whose player_contributions were never recorded,
--    because its refresh required them.
--
-- 3. club_hand_daily.pot_total adds tournament chips to cash pots:
--    118,254,757 tournament chips against 5,239,484 of cash on 2026-09-03.
--    The dashboard's "Total Pots" and "Average Pot" (phase 4, my own work)
--    read it, and were wrong by a factor of twenty.
--
-- 4. Per-player rake on Club Data was 0.00 for every player of a club not in
--    a union: the rake CTE joined union_rake_paid_daily_user on a NULL union.
--    club_rake_daily_user has held the per-player figure for every club since
--    the rake rollup was built (257 players, 189,745.69 on 2026-09-03).
--
-- 5. Summing agent_commissions for one club is a 608,280-row scan today
--    (~450 ms) that grows by ~300,000 rows a day; the Financials page ran it
--    on every load through fn_club_commission_accrued.
--
-- 6. The insurance report's headline used a rolling timestamp window and its
--    day rows used UTC dates, so the rows could never sum to the headline,
--    and its funnel counted EVENTS rather than OFFERS.
--
-- 7. Per-player CASH results were never written for a club outside a union:
--    the three writers of ca_club_player_daily.cash_net only knew union
--    tables. 415 players, 1,304 rows, not one non-zero cash row (section 4b).
--    The same three writers, and club_table_daily's wallet side, knew only
--    'buyin' and 'cashout' of the cash categories and only buy-in, prize and
--    bounty of the tournament ones: table add-ons (713,968.61 chips in the
--    last seven days), rebuys, refunds and prize reversals were not money.
--
-- WHAT THIS DOES
--
-- ONE SOURCE FOR MONEY: rake_records, kept as an exact per-club-per-day
-- rollup (ca_club_rake_daily) by statement-level triggers, attributed the
-- way club_table_daily attributes it (a union player's rake goes to their
-- home club; anything unattributable stays with the table's club). Tournament
-- fees keep their existing live rollup (ca_club_tournament_daily). Agent
-- commissions get the same treatment (ca_club_commission_daily) off the
-- triggers phase 4 already put on agent_commissions.
--
-- ONE GATED READ PER PAGE: ca_club_financials (totals, daily series, top
-- tables, recent raked hands, freshness), ca_club_chip_ledger (the audit
-- trail, staff only). The dashboard's revenue read and today's rake come off
-- the same rollup. club_table_daily's refresh now keeps the unrecorded
-- contribution rows, so Club Data's per-table fees agree with the Financials
-- headline to the cent for every complete day.
--
-- Nothing here filters on is_horse. Horses are players (CLAUDE.md 10.5).
--
-- Locks: CREATE TRIGGER on rake_records takes SHARE ROW EXCLUSIVE for the
-- length of this transaction, and CREATE INDEX on chip_ledger (1.37M rows)
-- blocks its writers while it builds. This file therefore contains NO
-- backfill: it is applied inside the :55 maintenance freeze, and
-- fn_ca_club_rake_daily_rebuild / fn_rebuild_ca_club_commission_daily are
-- run afterwards, with the triggers already live, which is safe (an upsert
-- from a concurrent insert waits on the rebuilt row and adds to it).
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- ─────────────────────────────────────────────────────────────────────────
--  1. ca_club_rake_daily: the cash rake ledger, per club, per UTC day
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_club_rake_daily (
  club_id     uuid        NOT NULL,
  stat_date   date        NOT NULL,
  hands       bigint      NOT NULL DEFAULT 0,
  rake        numeric     NOT NULL DEFAULT 0,
  bbj         numeric     NOT NULL DEFAULT 0,
  pot         numeric     NOT NULL DEFAULT 0,
  source_rows bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, stat_date)
);

COMMENT ON TABLE public.ca_club_rake_daily IS
  'Cash rake_records per (club, UTC day), attributed like club_table_daily: a union player''s share goes to their home club in that union, everything unattributable stays with the table''s club. hands = raked hands in which one of the club''s players contributed (every raked hand at the club''s tables for a standalone club); rake = attributed gross rake; bbj = bad-beat drop at the club''s tables; pot = gross pot of raked hands at the club''s tables. Maintained by statement-level triggers on rake_records; rebuild a day range with fn_ca_club_rake_daily_rebuild(start, end); reconciled hourly by fn_club_table_daily_catchup.';

ALTER TABLE public.ca_club_rake_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_club_rake_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_club_rake_daily TO service_role;

-- The attribution, written once. p_ids names the rows (the insert trigger);
-- a NULL p_ids reads the [p_from, p_to) window (rebuild). The two branches
-- are a UNION so each gets its own index: the primary key for ids, the
-- created_at index for the window.
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_compute(
  p_from timestamptz, p_to timestamptz, p_ids uuid[]
)
RETURNS TABLE(club_id uuid, stat_date date, hands bigint, rake numeric,
              bbj numeric, pot numeric, source_rows bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0) AS rake, coalesce(r.bbj_contribution, 0) AS bbj,
           coalesce(r.pot_size, 0) AS pot, r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NOT NULL AND r.id = ANY (p_ids)
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
    UNION ALL
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0), coalesce(r.bbj_contribution, 0),
           coalesce(r.pot_size, 0), r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NULL AND r.created_at >= p_from AND r.created_at < p_to
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
  ),
  tbl AS (
    SELECT s.id, s.club_id AS table_club, (s.created_at AT TIME ZONE 'UTC')::date AS day,
           s.rake, s.bbj, s.pot, s.player_contributions, t.union_id
      FROM src s
      LEFT JOIN tables t ON t.id = s.table_id
     WHERE t.id IS NULL OR t.tournament_id IS NULL
  ),
  -- Only a union table needs its contributions read: a standalone table's
  -- rake has exactly one place to go. A key that is not a uuid or a value
  -- that is not a number is ignored, never raised: a reporting rollup must
  -- not fail a ledger write. A contribution of zero still counts the hand
  -- for that player's club, as club_table_daily counts it.
  contrib AS (
    SELECT b.id, b.union_id,
           CASE WHEN e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN e.key::uuid END AS uid,
           CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric END AS contrib
      FROM tbl b
      CROSS JOIN LATERAL jsonb_each_text(
        CASE WHEN jsonb_typeof(b.player_contributions) = 'object'
             THEN b.player_contributions ELSE '{}'::jsonb END) e
     WHERE b.union_id IS NOT NULL
  ),
  attributed AS (
    SELECT c.id, c.contrib,
           coalesce((SELECT cm.club_id
                       FROM club_members cm
                       JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = c.union_id
                      WHERE cm.user_id = c.uid
                      ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
                      LIMIT 1),
                    b.table_club) AS club_id
      FROM contrib c JOIN tbl b ON b.id = c.id
     WHERE c.uid IS NOT NULL AND c.contrib IS NOT NULL AND c.contrib >= 0
  ),
  split AS (
    SELECT a.id, a.club_id, sum(a.contrib) AS contrib, count(*) AS src_rows
      FROM attributed a GROUP BY a.id, a.club_id
  ),
  split_total AS (
    SELECT s.id, sum(s.contrib) AS tot FROM split s GROUP BY s.id
  ),
  hand_rows AS (
    SELECT b.*, EXISTS (SELECT 1 FROM split_total st WHERE st.id = b.id AND st.tot > 0) AS has_split
      FROM tbl b
  ),
  parts AS (
    -- A union hand with a usable split: rake by contribution share, and one
    -- hand for every club that contributed.
    SELECT h.day, s.club_id, 1::bigint AS hands, h.rake * s.contrib / st.tot AS rake,
           0::numeric AS bbj, 0::numeric AS pot, s.src_rows
      FROM split s
      JOIN split_total st ON st.id = s.id AND st.tot > 0
      JOIN hand_rows h ON h.id = s.id
    UNION ALL
    -- The table's club: the drop and the pot volume of every hand it hosted,
    -- plus the whole hand when nothing could be attributed.
    SELECT h.day, h.table_club,
           CASE WHEN h.has_split THEN 0 ELSE 1 END,
           CASE WHEN h.has_split THEN 0 ELSE h.rake END,
           h.bbj, h.pot,
           CASE WHEN h.has_split THEN 0 ELSE 1 END
      FROM hand_rows h
  )
  SELECT p.club_id, p.day, sum(p.hands)::bigint, sum(p.rake), sum(p.bbj), sum(p.pot),
         sum(p.src_rows)::bigint
    FROM parts p
   GROUP BY p.club_id, p.day;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamptz, timestamptz, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_apply(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_n integer := 0;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  INSERT INTO public.ca_club_rake_daily AS d
         (club_id, stat_date, hands, rake, bbj, pot, source_rows, updated_at)
  SELECT c.club_id, c.stat_date, c.hands, c.rake, c.bbj, c.pot, c.source_rows, now()
    FROM public.fn_ca_club_rake_daily_compute(now(), now(), p_ids) c
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET hands = d.hands + EXCLUDED.hands,
         rake = d.rake + EXCLUDED.rake,
         bbj = d.bbj + EXCLUDED.bbj,
         pot = d.pot + EXCLUDED.pot,
         source_rows = d.source_rows + EXCLUDED.source_rows,
         updated_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_apply(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_apply(uuid[]) TO service_role;

-- Rebuild a day range from the ledger. Ungated: this is what the change
-- trigger and the operator wrapper call. Each day is recounted under its own
-- advisory lock; a concurrent insert's upsert waits on the deleted row and
-- lands on the rebuilt one, so nothing is counted twice or missed.
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild_range(p_start date, p_end date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_s date := LEAST(coalesce(p_start, v_today), coalesce(p_end, v_today));
  v_e date := LEAST(GREATEST(coalesce(p_start, v_today), coalesce(p_end, v_today)), v_today);
  d date;
  v_days integer := 0;
BEGIN
  IF v_s > v_e THEN RETURN 0; END IF;
  FOR d IN SELECT gs::date FROM generate_series(v_s, v_e, interval '1 day') gs LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ca_club_rake_daily:' || d::text, 42));
    DELETE FROM public.ca_club_rake_daily r WHERE r.stat_date = d;
    INSERT INTO public.ca_club_rake_daily AS x
           (club_id, stat_date, hands, rake, bbj, pot, source_rows, updated_at)
    SELECT c.club_id, c.stat_date, c.hands, c.rake, c.bbj, c.pot, c.source_rows, now()
      FROM public.fn_ca_club_rake_daily_compute(
             (d::timestamp AT TIME ZONE 'UTC'), ((d + 1)::timestamp AT TIME ZONE 'UTC'), NULL) c
    ON CONFLICT (club_id, stat_date) DO UPDATE
       SET hands = x.hands + EXCLUDED.hands,
           rake = x.rake + EXCLUDED.rake,
           bbj = x.bbj + EXCLUDED.bbj,
           pot = x.pot + EXCLUDED.pot,
           source_rows = x.source_rows + EXCLUDED.source_rows,
           updated_at = now();
    v_days := v_days + 1;
  END LOOP;
  RETURN v_days;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) TO service_role;

-- The operator wrapper.
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild(p_start date, p_end date)
RETURNS TABLE(stat_date date, clubs bigint, hands bigint, rake numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;
  v_n := public.fn_ca_club_rake_daily_rebuild_range(p_start, p_end);
  RETURN QUERY
  SELECT r.stat_date, count(*)::bigint, coalesce(sum(r.hands), 0)::bigint, coalesce(sum(r.rake), 0)
    FROM public.ca_club_rake_daily r
   WHERE r.stat_date BETWEEN LEAST(p_start, p_end) AND GREATEST(p_start, p_end)
   GROUP BY r.stat_date ORDER BY r.stat_date;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild(date, date) TO service_role;

-- The triggers. Statement-level, one pass per statement, and a failure is a
-- WARNING plus the hourly reconcile, never a refused ledger write.
CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(n.id) INTO v_ids
    FROM new_rows n
   WHERE NOT coalesce(n.is_tournament, false) AND n.club_id IS NOT NULL;
  IF v_ids IS NOT NULL THEN
    PERFORM public.fn_ca_club_rake_daily_apply(v_ids);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_lo date; v_hi date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list, so the
    -- trigger fires on every UPDATE and the filter is here. A hand_id relink
    -- or a metadata touch names no day.
    SELECT min(x.d), max(x.d) INTO v_lo, v_hi
      FROM (
        SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
        UNION ALL
        SELECT (n.created_at AT TIME ZONE 'UTC')::date
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
      ) x;
  ELSE
    SELECT min((o.created_at AT TIME ZONE 'UTC')::date), max((o.created_at AT TIME ZONE 'UTC')::date)
      INTO v_lo, v_hi
      FROM old_rows o;
  END IF;
  IF v_lo IS NOT NULL THEN
    PERFORM public.fn_ca_club_rake_daily_rebuild_range(v_lo, v_hi);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily change rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_ins ON public.rake_records;
CREATE TRIGGER trg_ca_club_rake_daily_ins
  AFTER INSERT ON public.rake_records
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_insert();

DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_upd ON public.rake_records;
CREATE TRIGGER trg_ca_club_rake_daily_upd
  AFTER UPDATE ON public.rake_records
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_change();

DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_del ON public.rake_records;
CREATE TRIGGER trg_ca_club_rake_daily_del
  AFTER DELETE ON public.rake_records
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_change();

-- ─────────────────────────────────────────────────────────────────────────
--  2. ca_club_commission_daily, off the triggers phase 4 already installed
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_club_commission_daily (
  club_id      uuid        NOT NULL,
  stat_date    date        NOT NULL,
  amount       numeric     NOT NULL DEFAULT 0,
  rows_counted bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, stat_date)
);

COMMENT ON TABLE public.ca_club_commission_daily IS
  'Sum of agent_commissions.amount per (club, UTC day of created_at), settled or not. Maintained by the statement-level triggers on agent_commissions; rebuild with fn_rebuild_ca_club_commission_daily().';

ALTER TABLE public.ca_club_commission_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_club_commission_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_club_commission_daily TO service_role;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();

  -- Phase 6: the per-day total the Financials page reads.
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, sum(n.amount), count(*), now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL
   GROUP BY n.club_id, (n.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pairs jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list on the
    -- trigger, so the trigger fires on every UPDATE and the filter is here:
    -- only rows whose outstanding amount, settlement or ownership changed
    -- name a pair to recompute. A notes-only update names none.
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', x.club_id, 'user_id', x.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM (
        SELECT o.club_id, o.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
        UNION
        SELECT n.club_id, n.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
      ) x;

    -- Phase 6: the day total moves only when amount, club or day moved.
    -- Subtract the old row, add the new one; a settlement changes neither.
    INSERT INTO public.ca_club_commission_daily AS c
           (club_id, stat_date, amount, rows_counted, updated_at)
    SELECT x.club_id, x.d, sum(x.amount), sum(x.n), now()
      FROM (
        SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date AS d, -o.amount AS amount, -1 AS n
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.created_at IS DISTINCT FROM n.created_at
        UNION ALL
        SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, n.amount, 1
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.created_at IS DISTINCT FROM n.created_at
      ) x
     WHERE x.club_id IS NOT NULL
     GROUP BY x.club_id, x.d
    ON CONFLICT (club_id, stat_date) DO UPDATE
       SET amount       = c.amount + EXCLUDED.amount,
           rows_counted = c.rows_counted + EXCLUDED.rows_counted,
           updated_at   = now();
  ELSE
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', o.club_id, 'user_id', o.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o;

    INSERT INTO public.ca_club_commission_daily AS c
           (club_id, stat_date, amount, rows_counted, updated_at)
    SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date, -sum(o.amount), -count(*), now()
      FROM old_rows o
     WHERE o.club_id IS NOT NULL
     GROUP BY o.club_id, (o.created_at AT TIME ZONE 'UTC')::date
    ON CONFLICT (club_id, stat_date) DO UPDATE
       SET amount       = c.amount + EXCLUDED.amount,
           rows_counted = c.rows_counted + EXCLUDED.rows_counted,
           updated_at   = now();
  END IF;
  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_change() FROM PUBLIC, anon, authenticated;

-- Full rebuild: one pass over the ledger. agent_commissions has no index on
-- created_at, so a day-range rebuild would scan the table anyway.
CREATE OR REPLACE FUNCTION public.fn_rebuild_ca_club_commission_daily()
RETURNS TABLE(club_days bigint, amount numeric, rows_counted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_club_commission_daily:rebuild', 42));
  DELETE FROM public.ca_club_commission_daily;
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT ac.club_id, (ac.created_at AT TIME ZONE 'UTC')::date, sum(ac.amount), count(*), now()
    FROM agent_commissions ac
   WHERE ac.club_id IS NOT NULL
   GROUP BY ac.club_id, (ac.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  RETURN QUERY
  SELECT count(*)::bigint, coalesce(sum(x.amount), 0), coalesce(sum(x.rows_counted), 0)::bigint
    FROM public.ca_club_commission_daily x;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_rebuild_ca_club_commission_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rebuild_ca_club_commission_daily() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  3. club_table_daily keeps the unrecorded-contribution rows, and the
--     hourly catch-up reconciles the new rollup
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_rows int;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;

  DELETE FROM club_table_daily WHERE stat_date = p_day;

  WITH att AS (
    SELECT DISTINCT ON (cm.user_id, uc.union_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY cm.user_id, uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  rr AS (
    SELECT r.id, r.table_id, r.rake_amount, t.union_id, t.club_id AS table_club,
           e.key AS uid, (e.value)::numeric AS contrib,
           SUM((e.value)::numeric) OVER (PARTITION BY r.id) AS tot
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.player_contributions IS NOT NULL
       AND r.rake_amount > 0
       AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) x
          WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    UNION ALL
    -- 2026-09-04: a raked hand with no usable contribution (none recorded,
    -- not an object, no uuid keys, nothing positive) used to vanish from this
    -- rollup: 109 rows and 173.38 chips on the reference club's three days.
    -- It is the table's club's rake and it goes there whole, as one synthetic
    -- row of weight 1 and no player.
    SELECT r.id, r.table_id, r.rake_amount, t.union_id, t.club_id,
           NULL::text, 1::numeric, 1::numeric
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) e
          WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
  ),
  raked AS (
    SELECT COALESCE(a.club_id, rr.table_club) AS club_id,
           rr.table_id,
           rr.union_id,
           SUM(rr.rake_amount * rr.contrib / rr.tot) AS rake,
           COUNT(DISTINCT rr.id)  AS hands,
           COUNT(DISTINCT rr.uid) AS players,
           COUNT(*)               AS src
      FROM rr
      LEFT JOIN att a ON a.user_id::text = rr.uid AND a.union_id IS NOT DISTINCT FROM rr.union_id
     WHERE rr.tot > 0
     GROUP BY 1, 2, 3
  ),
  -- 2026-09-04: a table add-on (a top-up, 'addon'), a rebuy and a refund are
  -- buy-in money too; this read 'buyin' and 'cashout' alone and so put every
  -- top-up (1.76M chips across the platform in 30 days) on the players' side
  -- of the table net. Debits are money onto the table, credits money off it.
  wal AS (
    SELECT COALESCE(a.club_id, t.club_id) AS club_id,
           wt.table_id,
           t.union_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN tables t ON t.id = wt.table_id AND t.tournament_id IS NULL
      LEFT JOIN att a ON a.user_id = wt.user_id AND a.union_id IS NOT DISTINCT FROM t.union_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND wt.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund')
     GROUP BY 1, 2, 3
  ),
  merged AS (
    SELECT COALESCE(k.club_id,  w.club_id)  AS club_id,
           COALESCE(k.table_id, w.table_id) AS table_id,
           COALESCE(k.union_id, w.union_id) AS union_id,
           COALESCE(k.rake, 0)     AS rake,
           COALESCE(k.hands, 0)    AS hands,
           COALESCE(k.players, 0)  AS players,
           COALESCE(k.src, 0)      AS src,
           COALESCE(w.buyins, 0)   AS buyins,
           COALESCE(w.cashouts, 0) AS cashouts
      FROM raked k
      FULL OUTER JOIN wal w
        ON w.club_id = k.club_id AND w.table_id = k.table_id
  )
  INSERT INTO club_table_daily (club_id, table_id, stat_date, union_id,
                                rake, hands, players, buyins, cashouts, net,
                                source_rows, updated_at)
  SELECT m.club_id, m.table_id, p_day, m.union_id,
         round(m.rake, 4), m.hands, m.players,
         round(m.buyins, 2), round(m.cashouts, 2),
         round(m.cashouts - m.buyins, 2),
         m.src, now()
    FROM merged m
   WHERE m.club_id IS NOT NULL AND m.table_id IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'day', p_day, 'rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_table_daily_refresh_day(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_refresh_day(date) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_club_table_daily_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_n int := GREATEST(LEAST(COALESCE(p_days, 3), 30), 1);
  d date;
  v_done jsonb := '[]'::jsonb;
  v_stored bigint;
  v_actual bigint;
  v_ledger numeric;
  v_rollup numeric;
  v_reconciled jsonb := '[]'::jsonb;
BEGIN
  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    -- The same reading of contributions the refresh uses (uuid-keyed rows,
    -- plus one synthetic row per hand with no usable contribution), so a
    -- stored count matches an actual count exactly when nothing has changed.
    SELECT (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
        CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.player_contributions IS NOT NULL
         AND r.rake_amount > 0
         AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) x
            WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    ) + (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.rake_amount > 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) e
            WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
    ) INTO v_actual;

    IF d >= v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

    -- Phase 6 reconcile of ca_club_rake_daily: rake is conserved across
    -- attribution, so the rollup's day total must equal the ledger's cash
    -- rake for the day. A drift (a trigger that warned instead of writing)
    -- rebuilds the day.
    SELECT COALESCE(SUM(r.rake_amount), 0) INTO v_ledger
      FROM rake_records r
     WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
       AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
       AND r.club_id IS NOT NULL AND NOT COALESCE(r.is_tournament, false)
       AND EXISTS (SELECT 1 FROM tables t WHERE t.id = r.table_id AND t.tournament_id IS NULL);
    SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
      FROM ca_club_rake_daily x WHERE x.stat_date = d;
    IF abs(v_ledger - v_rollup) > 0.005 THEN
      PERFORM fn_ca_club_rake_daily_rebuild_range(d, d);
      v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
        'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'days', v_done, 'rake_daily_rebuilt', v_reconciled);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_table_daily_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_catchup(integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  4. Per-player rake for a club that is not in a union
-- ─────────────────────────────────────────────────────────────────────────
-- Same bodies as before with one CTE changed: a union club reads
-- union_rake_paid_daily_user as it did; a standalone club reads
-- club_rake_daily_user, which fn_club_rake_rollup_day has kept for every
-- club since it was built. Complete days only, as the page already says.
CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'UTC')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13);
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
  WITH att_club AS MATERIALIZED (
    SELECT a.user_id FROM (SELECT DISTINCT ON(cm.user_id) cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc
       ON uc.club_id=cm.club_id AND uc.union_id=v_union WHERE v_union IS NOT NULL
      ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a WHERE a.club_id=p_club_id
    UNION SELECT cm.user_id FROM public.club_members cm
      WHERE v_union IS NULL AND cm.club_id=p_club_id
  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d WHERE d.club_id=p_club_id
       AND d.stat_date BETWEEN v_start AND v_end GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake FROM public.union_rake_paid_daily_user u
      JOIN att_club a ON a.user_id=u.user_id WHERE v_union IS NOT NULL AND u.union_id=v_union
       AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount) FROM public.club_rake_daily_user c
      JOIN att_club a ON a.user_id=c.user_id WHERE v_union IS NULL AND c.club_id=p_club_id
       AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands FROM public.club_member_daily_stats s
      JOIN att_club a ON a.user_id=s.user_id WHERE s.club_id=p_club_id
       AND s.stat_date BETWEEN v_start AND v_end GROUP BY s.user_id
  ), merged AS MATERIALIZED (
    SELECT a.user_id,round(COALESCE(w.cash_net,0),2) cash_net,
      round(COALESCE(w.tournament_net,0),2) tournament_net,
      round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) net,
      round(COALESCE(r.rake,0),2) rake,COALESCE(h.hands,0) hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
      WHERE COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
         OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0
  )
  SELECT jsonb_build_object('range',jsonb_build_object('start',v_start,'end',v_end,'days',(v_end-v_start)+1),
    'rake_complete_through',LEAST(v_end,v_today-1),
    'totals',(SELECT jsonb_build_object('players',count(*),'net',round(COALESCE(SUM(net),0),2),
      'rake',round(COALESCE(SUM(rake),0),2),'hands',COALESCE(SUM(hands),0)) FROM merged),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',q.user_id,
      'username',COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player'),'avatar_url',pr.avatar_url,
      'is_horse',(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)),'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands) ORDER BY q.net DESC)
      FROM (SELECT * FROM merged ORDER BY net DESC LIMIT v_lim) q
      LEFT JOIN public.profiles pr ON pr.id=q.user_id),'[]'::jsonb),
    'player_count',(SELECT count(*) FROM merged),'generated_at',now()) INTO v_out;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_player_breakdown(uuid, date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_breakdown(uuid, date, date, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_club_player_page(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_sort text DEFAULT 'winners'::text, p_search text DEFAULT NULL::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'winners'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_union uuid;
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('winners','losers','rake','hands') THEN v_sort := 'winners'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id=p_club_id LIMIT 1;

  WITH att_club AS MATERIALIZED (
    SELECT a.user_id FROM (
      SELECT DISTINCT ON(cm.user_id) cm.user_id,cm.club_id
        FROM public.club_members cm JOIN public.union_clubs uc
          ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE v_union IS NOT NULL
       ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a
     WHERE a.club_id=p_club_id
    UNION
    SELECT cm.user_id FROM public.club_members cm
     WHERE v_union IS NULL AND cm.club_id=p_club_id
  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.club_id=p_club_id AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
  ), merged AS MATERIALIZED (
    SELECT a.user_id,COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player') username,
           pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse,
           round(COALESCE(w.cash_net,0),2) cash_net,
           round(COALESCE(w.tournament_net,0),2) tournament_net,
           round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) net,
           round(COALESCE(r.rake,0),2) rake,COALESCE(h.hands,0) hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
      LEFT JOIN public.profiles pr ON pr.id=a.user_id
     WHERE COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
        OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0
  ), filtered AS MATERIALIZED (
    SELECT m.* FROM merged m
     WHERE v_search IS NULL OR m.username ILIKE '%'||v_search||'%'
        OR m.user_id::text ILIKE '%'||v_search||'%'
  ), scored AS MATERIALIZED (
    SELECT f.*,CASE v_sort WHEN 'losers' THEN -f.net
                           WHEN 'rake' THEN f.rake
                           WHEN 'hands' THEN f.hands::numeric
                           ELSE f.net END sort_value
      FROM filtered f
  ), page_plus_one AS MATERIALIZED (
    SELECT s.* FROM scored s
     WHERE p_cursor IS NULL OR ROW(s.sort_value,s.user_id::text) <
       ROW((p_cursor->>'value')::numeric,p_cursor->>'id')
     ORDER BY s.sort_value DESC,s.user_id::text DESC LIMIT v_limit+1
  ), visible AS MATERIALIZED (
    SELECT * FROM page_plus_one
     ORDER BY sort_value DESC,user_id::text DESC LIMIT v_limit
  ), last_row AS (
    SELECT * FROM visible ORDER BY sort_value ASC,user_id::text ASC LIMIT 1
  )
  SELECT jsonb_build_object(
    'sort',v_sort,
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'user_id',q.user_id,'username',q.username,'avatar_url',q.avatar_url,
      'is_horse',q.is_horse,'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands)
      ORDER BY q.sort_value DESC,q.user_id::text DESC) FROM visible q),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>v_limit THEN
      (SELECT jsonb_build_object('value',l.sort_value,'id',l.user_id) FROM last_row l)
      ELSE NULL END,
    'has_more',(SELECT count(*) FROM page_plus_one)>v_limit,
    'filtered_count',(SELECT count(*) FROM filtered),
    'generated_at',now()) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_player_page(uuid, date, date, text, text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_page(uuid, date, date, text, text, jsonb, integer) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  4b. Per-player CASH results for a club that is not in a union
-- ─────────────────────────────────────────────────────────────────────────
-- Found while proving 4: every one of the reference club's 415 players had
-- cash_net 0.00 in ca_club_player_daily (1,304 rows, tournament_net
-- -52,896.88, not one non-zero cash row) because all three writers of that
-- column only knew union tables. trg_ca_reporting_wallet_insert returned
-- early on `v_union IS NULL`; ca_refresh_reporting_rollups_base and
-- ca_refresh_reporting_cash_rollup joined tables on `union_id IS NOT NULL`.
-- So Club Data's "Net" for a standalone club was its tournament net alone,
-- and "Winners" / "Losers" ranked players on that. The table-level figure
-- beside it (club_table_daily.net, from the same wallet_transactions rows)
-- was right, which is the "+89,166.07 against -11,763.83" the plan document
-- could not explain.
--
-- A standalone table's buy-in or cash-out belongs to the table's club, with
-- no home-club lookup (there is no union to look it up in). Union tables are
-- handled exactly as before.
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    FOR r IN SELECT * FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) LOOP
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_reporting_wallet_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ca_reporting_wallet_insert() TO service_role;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_cash_rollup(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start date:=LEAST(p_start,p_end); v_end date:=GREATEST(p_start,p_end);
  v_from timestamptz; v_to timestamptz; v_rows bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end-v_start>400 THEN
    RAISE EXCEPTION 'cash reporting refresh requires a 0-400 day range'; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from:=v_start::timestamp AT TIME ZONE 'UTC';
  v_to:=(v_end+1)::timestamp AT TIME ZONE 'UTC';
  UPDATE public.ca_club_player_daily SET cash_net=0,updated_at=now()
   WHERE stat_date BETWEEN v_start AND v_end AND cash_net<>0;
  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON(uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), cash AS (
    SELECT x.club_id,x.user_id,x.stat_date,SUM(x.cash_net) AS cash_net FROM (
      SELECT h.club_id,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date stat_date,
             SUM(CASE WHEN wt.type='credit' THEN wt.amount
                      WHEN wt.type='debit' THEN -wt.amount ELSE 0 END) cash_net
        FROM public.wallet_transactions wt
        JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
         AND tb.tournament_id IS NULL
        JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
       WHERE wt.created_at>=v_from AND wt.created_at<v_to
         AND wt.category IN('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
       GROUP BY 1,2,3
      UNION ALL
      -- 2026-09-04: standalone tables, which this rollup never read.
      SELECT tb.club_id,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
             SUM(CASE WHEN wt.type='credit' THEN wt.amount
                      WHEN wt.type='debit' THEN -wt.amount ELSE 0 END)
        FROM public.wallet_transactions wt
        JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
         AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
       WHERE wt.created_at>=v_from AND wt.created_at<v_to
         AND wt.category IN('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
       GROUP BY 1,2,3
    ) x GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_player_daily AS d
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT club_id,user_id,stat_date,cash_net,0,now() FROM cash
  ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
   SET cash_net=EXCLUDED.cash_net,updated_at=now();
  SELECT count(*) INTO v_rows FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end AND cash_net<>0;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'cash_facts',v_rows,'refreshed_at',now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_refresh_reporting_cash_rollup(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_cash_rollup(date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from := v_start::timestamp AT TIME ZONE 'UTC';
  v_to := (v_end + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id, cm.club_id
      FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id, club_id FROM home
    UNION
    SELECT user_id, club_id FROM standalone
  ), mapped AS MATERIALIZED (
    -- 2026-09-04: cash rows are the ones with a table (buy-in, cash-out,
    -- add-on, rebuy, refund); tournament rows have a tournament and no table
    -- (buy-in, add-on, rebuy, refund, prize, bounty, prize reversal). The sign
    -- is the row's type. This read buy-in/cash-out and buy-in/prize/bounty.
    SELECT 'cash'::text AS kind,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
       AND tb.tournament_id IS NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    -- standalone tables, which this rollup never read.
    SELECT 'cash',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           tb.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
       AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT 'tournament',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.kind='cash'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.kind='tournament'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),now()
    FROM mapped m GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id)
           uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  ), wallet_mapped AS MATERIALIZED (
    SELECT a.club_id,wt.related_entity_id AS tournament_id,wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.type='credit' THEN wt.amount
                WHEN wt.type='debit' THEN -wt.amount ELSE 0 END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  ), entrant_totals AS MATERIALIZED (
    SELECT tp.tournament_id,count(*)::numeric AS total_players
      FROM public.tournament_players tp GROUP BY tp.tournament_id
  ), entrant_clubs AS MATERIALIZED (
    SELECT tp.tournament_id,a.club_id,count(*)::numeric AS club_players
      FROM public.tournament_players tp JOIN affiliations a ON a.user_id=tp.user_id
     GROUP BY tp.tournament_id,a.club_id
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,(r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END AS club_id,
           CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount
                ELSE r.rake_amount*ec.club_players/NULLIF(et.total_players,0) END AS fee
      FROM public.rake_records r
      LEFT JOIN affiliations a ON r.metadata ? 'user_id'
       AND a.user_id::text=r.metadata->>'user_id'
      LEFT JOIN entrant_clubs ec ON NOT (r.metadata ? 'user_id')
       AND ec.tournament_id=r.tournament_id
      LEFT JOIN entrant_totals et ON et.tournament_id=r.tournament_id
     WHERE r.created_at>=v_from AND r.created_at<v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount<>0
  ), combined AS (
    SELECT wm.club_id,wm.tournament_id,wm.stat_date,0::numeric AS fee,
           sum(wm.winnings) AS winnings FROM wallet_mapped wm GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id,rm.tournament_id,rm.stat_date,sum(rm.fee),0::numeric
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id,tournament_id,stat_date,fee,winnings,updated_at)
  SELECT club_id,tournament_id,stat_date,sum(fee),sum(winnings),now()
    FROM combined GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id,tournament_id,user_id,stat_date,updated_at)
  SELECT DISTINCT a.club_id,wt.related_entity_id,wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date,now()
    FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
   WHERE wt.created_at>=v_from AND wt.created_at<v_to
     AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
     AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL;

  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'player_facts',v_players,
    'tournament_facts',v_tournaments,'participant_facts',v_participants,
    'refreshed_at',now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups_base(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups_base(date, date) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  5. The insurance report: one window, counted per offer
-- ─────────────────────────────────────────────────────────────────────────
-- The window is the last N UTC days including today, for the funnel, the
-- money and the day rows alike, so the rows sum to the headline. The funnel
-- counts OFFERS (one per table, hand, player), each with at most one outcome:
-- an offer accepted and later cashed out counts once, as cashed out.
CREATE OR REPLACE FUNCTION public.ca_club_insurance_report(p_club_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 90);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from date;
  v_from_ts timestamptz;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  v_from := v_today - (v_days - 1);
  v_from_ts := (v_from::timestamp AT TIME ZONE 'UTC');

  WITH offers AS (
    SELECT e.table_id, coalesce(e.hand_number::text, e.id::text) AS hand_key, e.player_id,
           (min(e.created_at) AT TIME ZONE 'UTC')::date AS day,
           bool_or(e.event = 'cashed_out') AS cashed_out,
           bool_or(e.event = 'accepted')   AS accepted,
           bool_or(e.event = 'declined')   AS declined,
           bool_or(e.event = 'timeout')    AS timed_out,
           avg(e.equity_percent) FILTER (WHERE e.event = 'offered') AS equity,
           avg(e.pot) FILTER (WHERE e.event = 'offered') AS pot
      FROM insurance_offer_events e
     WHERE e.club_id = p_club_id AND e.created_at >= v_from_ts
     GROUP BY e.table_id, coalesce(e.hand_number::text, e.id::text), e.player_id
  ),
  funnel AS (
    SELECT o.day,
           count(*) AS offers,
           count(*) FILTER (WHERE o.cashed_out) AS cashouts,
           count(*) FILTER (WHERE o.accepted AND NOT o.cashed_out) AS accepted,
           count(*) FILTER (WHERE o.declined AND NOT o.accepted AND NOT o.cashed_out) AS declined,
           count(*) FILTER (WHERE o.timed_out AND NOT o.accepted AND NOT o.cashed_out AND NOT o.declined) AS timeouts,
           avg(o.equity) AS equity,
           avg(o.pot) AS pot
      FROM offers o GROUP BY o.day
  ),
  money AS (
    SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS contracts,
           count(*) FILTER (WHERE t.kind = 'insurance') AS insurance_contracts,
           count(*) FILTER (WHERE t.kind = 'ev_cashout') AS cashout_contracts,
           round(coalesce(sum(t.premium), 0), 2) AS bank_in,
           round(coalesce(sum(t.payout), 0), 2) AS bank_out,
           round(coalesce(sum(t.premium - t.payout), 0), 2) AS bank_net
      FROM insurance_transactions t
     WHERE t.club_id = p_club_id AND t.created_at >= v_from_ts
     GROUP BY (t.created_at AT TIME ZONE 'UTC')::date
  )
  SELECT jsonb_build_object(
    'window_days', v_days,
    'window_start', v_from,
    'window_end', v_today,
    'bank', (SELECT CASE WHEN c.union_id IS NOT NULL THEN 'union' ELSE 'club' END
             FROM clubs c WHERE c.id = p_club_id),
    'totals', (
      SELECT jsonb_build_object(
        'offers',   coalesce(sum(f.offers), 0),
        'accepted', coalesce(sum(f.accepted), 0),
        'declined', coalesce(sum(f.declined), 0),
        'timeouts', coalesce(sum(f.timeouts), 0),
        'cashouts', coalesce(sum(f.cashouts), 0),
        'take_rate_pct', CASE WHEN coalesce(sum(f.offers), 0) > 0
                              THEN round(100.0 * (sum(f.accepted) + sum(f.cashouts)) / sum(f.offers), 1) END,
        'avg_offer_equity', round((SELECT avg(o.equity) FROM offers o), 1),
        'avg_offer_pot',    round((SELECT avg(o.pot) FROM offers o), 2)
      )
      FROM funnel f
    ),
    'money', (
      SELECT jsonb_build_object(
        'contracts', coalesce(sum(m.contracts), 0),
        'insurance_contracts', coalesce(sum(m.insurance_contracts), 0),
        'cashout_contracts',   coalesce(sum(m.cashout_contracts), 0),
        'bank_in',  round(coalesce(sum(m.bank_in), 0), 2),
        'bank_out', round(coalesce(sum(m.bank_out), 0), 2),
        'bank_net', round(coalesce(sum(m.bank_net), 0), 2)
      )
      FROM money m
    ),
    'days', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'day', coalesce(f.day, m.day),
               'offers',   coalesce(f.offers, 0),
               'accepted', coalesce(f.accepted, 0),
               'declined', coalesce(f.declined, 0),
               'timeouts', coalesce(f.timeouts, 0),
               'cashouts', coalesce(f.cashouts, 0),
               'contracts', coalesce(m.contracts, 0),
               'bank_in',  coalesce(m.bank_in, 0),
               'bank_out', coalesce(m.bank_out, 0),
               'bank_net', coalesce(m.bank_net, 0))
             ORDER BY coalesce(f.day, m.day) DESC)
      FROM funnel f FULL OUTER JOIN money m ON m.day = f.day
    ), '[]'::jsonb),
    'generated_at', now()
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_insurance_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_insurance_report(uuid, integer) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  6. ca_club_financials: the one read behind the Financials page
-- ─────────────────────────────────────────────────────────────────────────
-- All figures are from the club's side: rake and fees come in; rakeback,
-- commissions and the union fee go out. net_revenue is what is left.
--
--   gross_rake       ca_club_rake_daily.rake (rake_records, attributed)
--   bbj_drop         ca_club_rake_daily.bbj (leaves the club for the pool)
--   net_rake         gross_rake - bbj_drop
--   tournament_fees  ca_club_tournament_daily.fee (rake_records, entry club)
--   rakeback_paid    chip_transactions type 'rakeback' for this club
--   agent_commissions ca_club_commission_daily (agent_commissions)
--   union_fee        breakdown.union_fee_kept of every union_weekly_squareup
--                    statement ISSUED in the window
--   net_revenue      net_rake + tournament_fees - rakeback_paid
--                    - agent_commissions - union_fee
--
-- p_start / p_end are UTC dates. A window before the club existed is
-- clamped to the first day the rollups know about. The daily series is
-- capped at the last 92 days of the window; the totals are not.
CREATE OR REPLACE FUNCTION public.ca_club_financials(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(coalesce(p_end, v_today), v_today);
  v_start date := coalesce(p_start, LEAST(coalesce(p_end, v_today), v_today) - 6);
  v_first date;
  v_series_from date;
  v_union uuid;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v jsonb;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = p_club_id;

  SELECT LEAST(
           (SELECT (c.created_at AT TIME ZONE 'UTC')::date FROM clubs c WHERE c.id = p_club_id),
           (SELECT min(r.stat_date) FROM ca_club_rake_daily r WHERE r.club_id = p_club_id),
           (SELECT min(t.stat_date) FROM ca_club_tournament_daily t WHERE t.club_id = p_club_id),
           (SELECT min(k.stat_date) FROM ca_club_commission_daily k WHERE k.club_id = p_club_id))
    INTO v_first;
  v_first := coalesce(v_first, v_today);

  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_start < v_first THEN v_start := v_first; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_series_from := GREATEST(v_start, v_end - 91);
  v_from_ts := (v_start::timestamp AT TIME ZONE 'UTC');
  v_to_ts := ((v_end + 1)::timestamp AT TIME ZONE 'UTC');

  WITH days AS (
    SELECT gs::date AS d FROM generate_series(v_start, v_end, interval '1 day') gs
  ),
  cash AS (
    SELECT r.stat_date AS d, r.hands, r.rake, r.bbj, r.pot, r.updated_at
      FROM ca_club_rake_daily r
     WHERE r.club_id = p_club_id AND r.stat_date BETWEEN v_start AND v_end
  ),
  mtt AS (
    SELECT t.stat_date AS d, sum(t.fee) AS fee, max(t.updated_at) AS updated_at
      FROM ca_club_tournament_daily t
     WHERE t.club_id = p_club_id AND t.stat_date BETWEEN v_start AND v_end
     GROUP BY t.stat_date
  ),
  comm AS (
    SELECT k.stat_date AS d, k.amount, k.updated_at
      FROM ca_club_commission_daily k
     WHERE k.club_id = p_club_id AND k.stat_date BETWEEN v_start AND v_end
  ),
  rb AS (
    SELECT (x.created_at AT TIME ZONE 'UTC')::date AS d, sum(x.amount) AS amount, count(*) AS n
      FROM chip_transactions x
     WHERE x.club_id = p_club_id AND x.transaction_type = 'rakeback'
       AND x.created_at >= v_from_ts AND x.created_at < v_to_ts
     GROUP BY (x.created_at AT TIME ZONE 'UTC')::date
  ),
  uf AS (
    SELECT (i.created_at AT TIME ZONE 'UTC')::date AS d,
           sum(CASE WHEN coalesce(i.breakdown->>'union_fee_kept', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
                    THEN (i.breakdown->>'union_fee_kept')::numeric ELSE 0 END) AS fee,
           count(*) AS n,
           sum(CASE WHEN i.breakdown->>'direction' = 'club owes union' THEN coalesce(i.net_amount, 0)
                    WHEN i.breakdown->>'direction' = 'union owes club' THEN -coalesce(i.net_amount, 0)
                    ELSE 0 END) AS squareup
      FROM settlement_invoices i
     WHERE i.club_id = p_club_id AND i.invoice_type = 'union_weekly_squareup'
       AND i.created_at >= v_from_ts AND i.created_at < v_to_ts
     GROUP BY (i.created_at AT TIME ZONE 'UTC')::date
  ),
  merged AS (
    SELECT dd.d,
           coalesce(c.hands, 0) AS raked_hands,
           coalesce(c.rake, 0) AS gross_rake,
           coalesce(c.bbj, 0) AS bbj_drop,
           coalesce(c.pot, 0) AS pot_volume,
           coalesce(m.fee, 0) AS tournament_fees,
           coalesce(r.amount, 0) AS rakeback_paid,
           coalesce(r.n, 0) AS rakeback_rows,
           coalesce(k.amount, 0) AS agent_commissions,
           coalesce(u.fee, 0) AS union_fee,
           coalesce(u.n, 0) AS union_statements,
           coalesce(u.squareup, 0) AS union_squareup
      FROM days dd
      LEFT JOIN cash c ON c.d = dd.d
      LEFT JOIN mtt m ON m.d = dd.d
      LEFT JOIN rb r ON r.d = dd.d
      LEFT JOIN comm k ON k.d = dd.d
      LEFT JOIN uf u ON u.d = dd.d
  ),
  tot AS (
    SELECT sum(x.raked_hands)::bigint AS raked_hands,
           round(sum(x.gross_rake), 2) AS gross_rake,
           round(sum(x.bbj_drop), 2) AS bbj_drop,
           round(sum(x.pot_volume), 2) AS pot_volume,
           round(sum(x.tournament_fees), 2) AS tournament_fees,
           round(sum(x.rakeback_paid), 2) AS rakeback_paid,
           sum(x.rakeback_rows)::bigint AS rakeback_rows,
           round(sum(x.agent_commissions), 2) AS agent_commissions,
           round(sum(x.union_fee), 2) AS union_fee,
           sum(x.union_statements)::bigint AS union_statements,
           round(sum(x.union_squareup), 2) AS union_squareup
      FROM merged x
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1,
                                'first_day', v_first, 'series_from', v_series_from),
    'union_id', v_union,
    'totals', (
      SELECT jsonb_build_object(
        'raked_hands', t.raked_hands,
        'gross_rake', t.gross_rake,
        'bbj_drop', t.bbj_drop,
        'net_rake', round(t.gross_rake - t.bbj_drop, 2),
        'pot_volume', t.pot_volume,
        'tournament_fees', t.tournament_fees,
        'rakeback_paid', t.rakeback_paid,
        'rakeback_rows', t.rakeback_rows,
        'agent_commissions', t.agent_commissions,
        'union_fee', t.union_fee,
        'union_statements', t.union_statements,
        'union_squareup', t.union_squareup,
        'net_revenue', round(t.gross_rake - t.bbj_drop + t.tournament_fees
                             - t.rakeback_paid - t.agent_commissions - t.union_fee, 2))
      FROM tot t
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', x.d,
               'raked_hands', x.raked_hands,
               'gross_rake', round(x.gross_rake, 2),
               'bbj_drop', round(x.bbj_drop, 2),
               'pot_volume', round(x.pot_volume, 2),
               'tournament_fees', round(x.tournament_fees, 2),
               'rakeback_paid', round(x.rakeback_paid, 2),
               'agent_commissions', round(x.agent_commissions, 2),
               'union_fee', round(x.union_fee, 2))
             ORDER BY x.d)
      FROM merged x WHERE x.d >= v_series_from
    ), '[]'::jsonb),
    'by_table', coalesce((
      SELECT jsonb_agg(q ORDER BY (q->>'rake')::numeric DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', s.table_id,
                 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes, concat(t.small_blind::text, '/', t.big_blind::text)),
                 'variant', upper(coalesce(t.game_variant, 'nlh')),
                 'raked_hands', sum(s.hands),
                 'rake', round(sum(s.rake), 2),
                 'players', max(s.players),
                 'table_net', round(sum(s.net), 2)) AS q
          FROM club_table_daily s
          LEFT JOIN tables t ON t.id = s.table_id
         WHERE s.club_id = p_club_id AND s.stat_date BETWEEN v_start AND v_end
         GROUP BY s.table_id, t.name, t.status, t.stakes, t.small_blind, t.big_blind, t.game_variant
         ORDER BY sum(s.rake) DESC
         LIMIT 10
      ) z
    ), '[]'::jsonb),
    'recent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id,
               'hand_id', r.hand_id,
               'global_hand_id', r.global_hand_id,
               'table_name', coalesce(t.name, CASE WHEN coalesce(r.is_tournament, false) THEN 'Tournament' ELSE 'Table' END),
               'kind', CASE WHEN coalesce(r.is_tournament, false)
                            THEN coalesce(r.metadata->>'kind', 'tournament_fee') ELSE 'cash_rake' END,
               'rake_amount', round(coalesce(r.rake_amount, 0), 2),
               'bbj_contribution', round(coalesce(r.bbj_contribution, 0), 2),
               'pot_size', round(coalesce(r.pot_size, 0), 2),
               'num_players', r.num_players,
               'created_at', r.created_at)
             ORDER BY r.created_at DESC)
      FROM (
        SELECT * FROM rake_records rr
         WHERE rr.club_id = p_club_id AND rr.rake_amount > 0
           AND rr.created_at >= v_from_ts AND rr.created_at < v_to_ts
         ORDER BY rr.created_at DESC LIMIT 20
      ) r
      LEFT JOIN tables t ON t.id = r.table_id
    ), '[]'::jsonb),
    'data_updated_at', GREATEST(
      (SELECT max(c.updated_at) FROM cash c),
      (SELECT max(m.updated_at) FROM mtt m),
      (SELECT max(k.updated_at) FROM comm k)),
    'club_table_daily_updated_at', (
      SELECT max(s.updated_at) FROM club_table_daily s
       WHERE s.club_id = p_club_id AND s.stat_date BETWEEN v_start AND v_end),
    'generated_at', now()
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_financials(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_financials(uuid, date, date) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  7. ca_club_chip_ledger: the audit trail, for the people allowed to audit
-- ─────────────────────────────────────────────────────────────────────────
-- chip_ledger's RLS gives a caller their own rows, which on a page titled
-- "Club Chip Audit Trail" is the wrong ledger. Per-hand rake and bad-beat
-- rows (508,000 of this club's 570,000) are left out unless asked for: the
-- rake ledger above already shows them.
CREATE INDEX IF NOT EXISTS idx_chip_ledger_club_created_desc
  ON public.chip_ledger (club_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ca_club_chip_ledger(
  p_club_id uuid,
  p_limit integer DEFAULT 25,
  p_before timestamptz DEFAULT NULL::timestamptz,
  p_include_hand_rows boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := GREATEST(LEAST(coalesce(p_limit, 25), 100), 1);
  v jsonb;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH page AS (
    SELECT l.id, l.performed_by, l.from_type, l.from_entity_id, l.from_label,
           l.to_type, l.to_entity_id, l.to_label, l.amount, l.category,
           l.description, l.created_at, l.club_id, l.union_id, l.table_id,
           l.tournament_id, l.status
      FROM chip_ledger l
     WHERE l.club_id = p_club_id
       AND (p_before IS NULL OR l.created_at < p_before)
       AND (coalesce(p_include_hand_rows, false)
            OR l.category NOT IN ('rake', 'bbj_contribution'))
     ORDER BY l.created_at DESC
     LIMIT v_limit + 1
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC)
      FROM (SELECT * FROM page ORDER BY created_at DESC LIMIT v_limit) p
    ), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM page) > v_limit,
    'next_before', (SELECT min(p.created_at) FROM (SELECT * FROM page ORDER BY created_at DESC LIMIT v_limit) p),
    'hand_rows_included', coalesce(p_include_hand_rows, false),
    'generated_at', now()
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_chip_ledger(uuid, integer, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_chip_ledger(uuid, integer, timestamptz, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  8. The dashboard reads the same ledger
-- ─────────────────────────────────────────────────────────────────────────
-- rake_today / rake_week / the 14-day series come off ca_club_rake_daily.
-- hands_today / hands_week stay what they were, hands DEALT (club_hand_daily,
-- every hand the engine finished, tournament hands included), and say so.
CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH days AS (
    SELECT g.day::date AS d,
           coalesce(h.hands, 0)::bigint AS hands,
           coalesce(r.rake, 0)::numeric AS rake,
           coalesce(r.hands, 0)::bigint AS raked_hands,
           coalesce(m.fee, 0)::numeric AS tournament_fees
    FROM generate_series(v_today - 13, v_today, interval '1 day') g(day)
    LEFT JOIN club_hand_daily h ON h.club_id = p_club_id AND h.stat_date = g.day::date
    LEFT JOIN ca_club_rake_daily r ON r.club_id = p_club_id AND r.stat_date = g.day::date
    LEFT JOIN (
      SELECT t.stat_date, sum(t.fee) AS fee FROM ca_club_tournament_daily t
       WHERE t.club_id = p_club_id AND t.stat_date >= v_today - 13
       GROUP BY t.stat_date
    ) m ON m.stat_date = g.day::date
  )
  SELECT jsonb_build_object(
    'total_members', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    ),
    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND cm.last_active > now() - interval '15 minutes'
      ) x
    ),
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    'hands_today', (SELECT hands FROM days WHERE d = v_today),
    'raked_hands_today', (SELECT raked_hands FROM days WHERE d = v_today),
    'rake_today',  (SELECT rake  FROM days WHERE d = v_today),
    'tournament_fees_today', (SELECT tournament_fees FROM days WHERE d = v_today),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', (SELECT sum(hands) FROM days WHERE d >= v_today - 6),
    'raked_hands_week', (SELECT sum(raked_hands) FROM days WHERE d >= v_today - 6),
    'rake_week',  (SELECT sum(rake)  FROM days WHERE d >= v_today - 6),
    'tournament_fees_week', (SELECT sum(tournament_fees) FROM days WHERE d >= v_today - 6),
    -- PEOPLE, not seat rows. A player at two tables is one person seated.
    -- Measured 2026-09-04: 479 seat rows for 243 people at this club.
    'seated_now', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
    ),
    'daily_series', (
      SELECT jsonb_agg(jsonb_build_object('d', d, 'hands', hands, 'rake', rake,
                                          'raked_hands', raked_hands,
                                          'tournament_fees', tournament_fees) ORDER BY d)
      FROM days
    ),
    'rake_source', 'rake_records'
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;

-- 'hands' here is RAKED cash hands, the denominator that belongs under
-- "rake per hand" and "average pot" when the numerators are the rake and
-- the pots of raked hands. 'hands_dealt' is every hand the engine finished.
CREATE OR REPLACE FUNCTION public.ca_club_revenue(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
  v_union uuid;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  SELECT jsonb_build_object(
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'hands', coalesce(sum(d.hands), 0),
        'hands_dealt', coalesce((SELECT sum(h.hands) FROM club_hand_daily h
                                  WHERE h.club_id = p_club_id AND h.stat_date >= v_from), 0),
        'rake',  round(coalesce(sum(d.rake), 0), 2),
        'bbj',   round(coalesce(sum(d.bbj), 0), 2),
        'pot_total', round(coalesce(sum(d.pot), 0), 2),
        'tournament_fees', round(coalesce((SELECT sum(t.fee) FROM ca_club_tournament_daily t
                                            WHERE t.club_id = p_club_id AND t.stat_date >= v_from), 0), 2),
        'avg_pot', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.pot) / sum(d.hands), 4) ELSE 0 END,
        'rake_per_hand', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.rake) / sum(d.hands), 4) ELSE 0 END
      )
      FROM ca_club_rake_daily d
      WHERE d.club_id = p_club_id AND d.stat_date >= v_from
    ),
    'insurance', (
      SELECT jsonb_build_object(
        'contracts', coalesce(count(*), 0),
        'premiums',  round(coalesce(sum(it.premium), 0), 2),
        'payouts',   round(coalesce(sum(it.payout), 0), 2),
        'net',       round(coalesce(sum(it.premium - it.payout), 0), 2),
        'bank',      CASE WHEN v_union IS NULL THEN 'club' ELSE 'union' END)
      FROM insurance_transactions it
      WHERE it.club_id = p_club_id
        AND it.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, 0),
               'hands_dealt', coalesce(h.hands, 0),
               'rake', round(coalesce(d.rake, 0), 2),
               'bbj', round(coalesce(d.bbj, 0), 2),
               'pot_total', round(coalesce(d.pot, 0), 2),
               'tournament_fees', round(coalesce(m.fee, 0), 2),
               'ins_net', coalesce(i.net, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN ca_club_rake_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_hand_daily h ON h.club_id = p_club_id AND h.stat_date = g.day::date
      LEFT JOIN (
        SELECT t.stat_date, sum(t.fee) AS fee FROM ca_club_tournament_daily t
         WHERE t.club_id = p_club_id AND t.stat_date >= v_from GROUP BY t.stat_date
      ) m ON m.stat_date = g.day::date
      LEFT JOIN (
        SELECT (it.created_at AT TIME ZONE 'UTC')::date AS d,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
         WHERE it.club_id = p_club_id AND it.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
         GROUP BY 1
      ) i ON i.d = g.day::date
    ), '[]'::jsonb),
    'by_table', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'hands')::bigint DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', s.table_id,
                 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes,
                            concat(t.small_blind::text, '/', t.big_blind::text)),
                 'hands', sum(s.hands_played),
                 'players', count(DISTINCT s.user_id)
               ) AS x
        FROM club_member_daily_stats s
        LEFT JOIN tables t ON t.id = s.table_id
        WHERE s.club_id = p_club_id AND s.stat_date >= v_from
        GROUP BY s.table_id, t.name, t.status, t.stakes, t.small_blind, t.big_blind
        ORDER BY sum(s.hands_played) DESC
        LIMIT 20
      ) q
    ), '[]'::jsonb),
    'rake_source', 'rake_records',
    'data_updated_at', (SELECT max(d.updated_at) FROM ca_club_rake_daily d
                         WHERE d.club_id = p_club_id AND d.stat_date >= v_from)
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_revenue(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_revenue(uuid, integer) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  9. The hand breakdown answers the club's finance staff, not only its owner
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_hand_rake_breakdown(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rr record;
  v_players jsonb;
  v_allocated numeric;
  v_caller uuid := auth.uid();
BEGIN
  SELECT * INTO v_rr FROM public.rake_records WHERE hand_id = p_hand_id
   ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- The people who may read the club's money may read one hand of it: the
  -- ca_can_view_club_finances gate (owner, co-owner, admin, super agent,
  -- platform admin), a union overseer of the club, or the engine. This used
  -- to admit the owner alone, which left every other reader of the
  -- Financials page a lookup box that answered "not authorised".
  IF NOT public.fn_caller_is_engine() THEN
    IF v_caller IS NULL
       OR (NOT public.ca_can_view_club_finances(v_rr.club_id)
           AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
                            WHERE uc.club_id = v_rr.club_id
                              AND public.fn_is_union_overseer(uc.union_id, v_caller)))
    THEN
      RETURN jsonb_build_object('found', false, 'error', 'not_authorised');
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', ra.player_id,
           'gross_contribution', ra.gross_contribution,
           'returned_uncalled', ra.returned_uncalled,
           'eligible_contribution', ra.eligible_contribution,
           'contribution_weight', ra.contribution_weight,
           'weighted_rake_credit', ra.weighted_rake_credit,
           'bbj_attributed_contribution', ra.bbj_attributed_contribution
         ) ORDER BY ra.weighted_rake_credit DESC), '[]'::jsonb),
         COALESCE(SUM(ra.weighted_rake_credit), 0)
    INTO v_players, v_allocated
    FROM public.rake_attributions ra WHERE ra.hand_id = p_hand_id;

  RETURN jsonb_build_object(
    'found', true,
    'hand_id', p_hand_id,
    'rake_method', v_rr.rake_method,
    'gross_pot', v_rr.pot_size,
    'regular_rake_collected', v_rr.rake_amount,
    'bbj_drop_collected', v_rr.bbj_contribution,
    'net_pot_paid_to_players',
      CASE WHEN v_rr.pot_size IS NULL THEN NULL
           ELSE v_rr.pot_size - v_rr.rake_amount - COALESCE(v_rr.bbj_contribution, 0) END,
    'total_eligible_contributions', (
      SELECT COALESCE(SUM((e.value)::numeric), 0)
        FROM jsonb_each(COALESCE(v_rr.player_contributions, '{}'::jsonb)) e
       WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric > 0),
    'players', v_players,
    'reconciliation', jsonb_build_object(
      'expected_regular_rake', round(v_rr.rake_amount, 2),
      'allocated_regular_rake', round(v_allocated, 2),
      'difference', round(v_rr.rake_amount - v_allocated, 2),
      'valid', (round(v_allocated, 2) = round(v_rr.rake_amount, 2))
    )
  );
END $function$;

REVOKE ALL ON FUNCTION public.fn_hand_rake_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_hand_rake_breakdown(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  10. The migration refuses to commit the old shapes
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_club_player_page'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%club_rake_daily_user%' THEN
    RAISE EXCEPTION 'ca_club_player_page still reads per-player rake from the union rollup alone';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_club_player_breakdown'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%club_rake_daily_user%' THEN
    RAISE EXCEPTION 'ca_club_player_breakdown still reads per-player rake from the union rollup alone';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_club_insurance_report'
     AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%now() - (v_days%' THEN
    RAISE EXCEPTION 'ca_club_insurance_report still mixes a rolling window with UTC day rows';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_club_table_daily_refresh_day'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%NULL::text, 1::numeric, 1::numeric%' THEN
    RAISE EXCEPTION 'fn_club_table_daily_refresh_day still drops raked hands with no recorded contributions';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_club_revenue'
     AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%sum(d.pot_total)%' THEN
    RAISE EXCEPTION 'ca_club_revenue still reads pot volume from club_hand_daily';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'trg_ca_reporting_wallet_insert'
     AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%IF v_union IS NULL OR v_is_tournament_table THEN RETURN NULL%' THEN
    RAISE EXCEPTION 'trg_ca_reporting_wallet_insert still drops cash results at standalone tables';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_refresh_reporting_cash_rollup'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%tb.union_id IS NULL%' THEN
    RAISE EXCEPTION 'ca_refresh_reporting_cash_rollup still reads union tables alone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ca_club_rake_daily_ins'
                    AND tgrelid = 'public.rake_records'::regclass) THEN
    RAISE EXCEPTION 'the rake rollup trigger is not installed';
  END IF;
END $$;

COMMIT;
