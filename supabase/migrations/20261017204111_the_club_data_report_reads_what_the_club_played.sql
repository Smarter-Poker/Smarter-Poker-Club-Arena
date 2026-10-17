-- 20261017204111_the_club_data_report_reads_what_the_club_played.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Dan 2026-10-17, after the Club Data screen was moved onto the money
-- (20261017160125): "FINISH THESE UP NOW" -
--   * "The separate advanced Report page still reads its older daily totals.
--      New activity there is now credited correctly, but past days on that
--      page weren't re-counted."
--   * "Super agents can still open that Report page and see the whole club."
--   * "The 14-day view of the main screen takes about 4 seconds for a club as
--      busy as JAQK."
--
-- THE REPORT'S NUMBERS. The Report, its game and player pages, its rake panel
-- and its exports read club_table_daily, ca_club_table_player_daily,
-- ca_club_player_daily, ca_club_tournament_daily and
-- ca_club_tournament_player_daily. Every writer of those tables still decided
-- the club with the earliest-joined-union-club guess, and the tournament
-- writers did worse: ca_reporting_tournament_clubs_for_user returns EVERY
-- club the player belongs to (one per union plus every standalone club), so
-- one prize was counted once per club. The hourly catch-up then rebuilt
-- yesterday with the guess, undoing any live fix every hour.
--
-- THE FIX, AT EVERY WRITER:
--   * Live: trg_ca_reporting_wallet_insert takes the club from the row's own
--     ledger leg, else the seat at THAT table (fn_ca_cash_table_reporting_club);
--     tournament rows take ONE club, the entry's (fn_ca_tournament_reporting_club).
--     trg_ca_reporting_rake_insert's tournament fees do the same.
--     fn_ca_club_rake_daily_compute (ca_club_rake_daily, the club rake totals
--     behind the dashboard, revenue and union rake views) reads
--     rake_attributions, then the seat at the table.
--   * Rebuilds: fn_ca_reporting_rollups_from_facts rebuilds the five Report
--     tables for one day from ca_club_data_fact, which balances to the cent
--     against rake_records and the ledger. The hourly catch-up
--     (fn_club_table_daily_refresh_day) and both range rebuilds
--     (ca_refresh_reporting_rollups_base / _cash_rollup) use it for every day
--     the facts cover, and keep their old reading only for the days before.
--   * The Report's player pages listed only players whose EARLIEST union club
--     was this one; they list this club's members.
--
-- WHO SEES THE WHOLE CLUB. ca_can_view_club_finances admits super agents and is
-- left as it is for the other reads that use it (the cashier among them). The
-- Report's own reads ask ca_can_view_whole_club_report: the owner, co-owner,
-- admins and platform admins (fn_ca_club_data_scope = 'club'). Agents of every
-- rank keep their own and their downline's figures on the Club Data screen.
--
-- THE FOURTEEN DAYS. See section 6.
--
-- NOT CHANGED, ON PURPOSE: the union settlement reads that use the same guess
-- (fn_union_rake_basis_by_club, fn_union_rake_paid_*, the union wallet and
-- seat/tournament funding choices). Those decide what clubs owe and which
-- wallet pays; changing them changes money, and that is its own decision.
--
-- One transaction. No trigger is created or dropped and no table is altered,
-- so no lock is taken on any money table. History is rebuilt afterwards by
-- hand, one day per call, through the functions defined here.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Helpers.
-- ---------------------------------------------------------------------------
-- The first UTC day the Club Data facts cover (the earliest history chunk the
-- seed loaded, else the live cutover day).
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_facts_from()
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT (min(l.from_at) AT TIME ZONE 'UTC')::date FROM public.ca_club_data_fact_seed_log l),
    (SELECT (s.live_from AT TIME ZONE 'UTC')::date FROM public.ca_club_data_fact_state s WHERE s.id));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_facts_from() FROM PUBLIC, anon, authenticated;

-- The club a tournament wallet row or fee belongs to: the entry's own club,
-- else the ledger leg written beside the wallet row, and only then the
-- union-scoped last resort. ONE club - never every club the player belongs to.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_reporting_club(
  p_tournament uuid, p_user uuid, p_amount numeric, p_type text, p_at timestamptz)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT tp.club_id FROM public.tournament_players tp
      WHERE tp.tournament_id = p_tournament AND tp.user_id = p_user AND tp.club_id IS NOT NULL),
    CASE WHEN p_amount IS NOT NULL THEN public.fn_ca_ledger_leg_club(p_user, p_amount, p_type, p_at, NULL) END,
    (SELECT public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, p_user)
       FROM public.tournaments tr WHERE tr.id = p_tournament));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_reporting_club(uuid, uuid, numeric, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- The whole-club Report (Dan 2026-10-17: "CLUB OWNERS SEE EVERYTHING, AGENTS
-- SEE THERE GENERATED STATS + DOWNLINES"): the owner, co-owner, admins and
-- platform admins - the same answer fn_ca_club_data_scope gives as 'club'.
-- Agents of every rank, super agents included, read their own and their
-- downline's figures on the Club Data screen instead.
CREATE OR REPLACE FUNCTION public.ca_can_view_whole_club_report(p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.fn_ca_club_data_scope(p_club_id) = 'club', false);
$$;
REVOKE ALL ON FUNCTION public.ca_can_view_whole_club_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_view_whole_club_report(uuid) TO authenticated, service_role;

-- The Report's club-scope rake panel: the whole-club Report's people, or an
-- overseer of a union the club belongs to (as ca_can_read_club_production).
CREATE OR REPLACE FUNCTION public.ca_can_read_whole_club_production(p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.ca_can_view_whole_club_report(p_club_id)
      OR EXISTS (SELECT 1 FROM public.union_clubs uc
                  WHERE uc.club_id = p_club_id AND public.fn_is_union_overseer(uc.union_id, auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.ca_can_read_whole_club_production(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_read_whole_club_production(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The Report's daily tables, rebuilt for one day from the facts.
--
--    club_table_daily, ca_club_table_player_daily, ca_club_player_daily,
--    ca_club_tournament_daily and ca_club_tournament_player_daily are what
--    the advanced Report, its game and player pages and its exports read.
--    Their rebuilds filed every union player under the earliest-joined club
--    and every tournament row under EVERY club the player belonged to. For
--    a day the Club Data facts cover, they are now rebuilt from those facts,
--    which balance to the cent against rake_records and the ledger (read
--    2026-10-17: 32 of 32 days). Hands are counted from the same attribution
--    the facts used (rake_attributions, then the buy-in receipt, then the seat
--    at that table). A day a live trigger may still be writing - today, or
--    yesterday within ten minutes of midnight - waits for every in-flight
--    reporting trigger first, as every range rebuild does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_reporting_rollups_from_facts(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from_day date := public.fn_ca_club_data_facts_from();
  v_lo timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_hi timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_tables bigint; v_players bigint; v_tournaments bigint;
BEGIN
  IF p_day IS NULL OR p_day > v_today OR v_from_day IS NULL OR p_day < v_from_day THEN
    RETURN jsonb_build_object('day', p_day, 'skipped', 'outside_club_data_facts', 'facts_from', v_from_day);
  END IF;
  IF now() < v_hi + interval '10 minutes' THEN
    PERFORM pg_advisory_xact_lock(918273645);
  END IF;

  DELETE FROM public.club_table_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_table_player_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_player_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date = p_day;

  WITH rr AS MATERIALIZED (
    SELECT r.id, r.table_id, r.created_at, t.union_id, t.club_id AS table_club,
           CASE WHEN jsonb_typeof(r.player_contributions) = 'object' THEN r.player_contributions ELSE '{}'::jsonb END AS pc
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_lo AND r.created_at < v_hi
       AND r.rake_amount > 0 AND r.tournament_id IS NULL AND NOT COALESCE(r.is_tournament, false)
  ), contrib AS (
    SELECT rr.id, rr.table_id, rr.created_at, rr.union_id, rr.table_club, e.key::uuid AS uid
      FROM rr CROSS JOIN LATERAL jsonb_each_text(rr.pc) e
     WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (CASE WHEN e.value ~ '^[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0
  ), clubbed AS (
    SELECT c.id, c.table_id,
           COALESCE(ra.club_id, rc.club, st.club,
                    public.fn_ca_cash_reporting_club(c.union_id, c.table_club, c.uid)) AS club_id,
           c.created_at
      FROM contrib c
      LEFT JOIN public.rake_attributions ra ON ra.rake_record_id = c.id AND ra.player_id = c.uid
      LEFT JOIN LATERAL (
        SELECT x.funding_club_id AS club FROM public.cash_participant_funding_receipts x
         WHERE ra.club_id IS NULL AND x.operation_kind = 'buyin' AND x.table_id = c.table_id
           AND x.account_entity_id = c.uid AND x.seat_joined_at <= c.created_at
         ORDER BY x.seat_joined_at DESC LIMIT 1) rc ON true
      LEFT JOIN LATERAL (
        SELECT ts.club_id AS club FROM public.table_seats ts
         WHERE ra.club_id IS NULL AND rc.club IS NULL AND ts.table_id = c.table_id
           AND ts.user_id = c.uid AND ts.club_id IS NOT NULL AND ts.joined_at <= c.created_at
         ORDER BY ts.joined_at DESC LIMIT 1) st ON true
  ), hands AS (
    SELECT h.club_id, h.table_id, SUM(h.hands)::int AS hands, SUM(h.src)::int AS src FROM (
      SELECT cl.club_id, cl.table_id, count(DISTINCT cl.id) AS hands, count(*) AS src
        FROM clubbed cl
       WHERE cl.club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(cl.club_id, cl.created_at) IS TRUE
       GROUP BY 1, 2
      UNION ALL
      -- A raked hand that named nobody is the table's club's hand.
      SELECT rr.table_club, rr.table_id, count(*), count(*)
        FROM rr
       WHERE rr.table_club IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM contrib c WHERE c.id = rr.id)
       GROUP BY 1, 2) h
     GROUP BY 1, 2
  )
  INSERT INTO public.club_table_daily
    (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
  SELECT f.club_id, f.game_id, p_day, t.union_id,
         round(SUM(f.fee), 4), COALESCE(MAX(h.hands), 0),
         (count(DISTINCT f.user_id) FILTER (WHERE f.fee > 0 AND f.user_id <> v_zero))::int,
         round(SUM(f.buyins), 2), round(SUM(f.cashouts), 2), round(SUM(f.cashouts) - SUM(f.buyins), 2),
         COALESCE(MAX(h.src), 0), now()
    FROM public.ca_club_data_fact f
    JOIN public.tables t ON t.id = f.game_id
    LEFT JOIN hands h ON h.club_id = f.club_id AND h.table_id = f.game_id
   WHERE f.stat_date = p_day AND f.kind = 'CASH'
   GROUP BY f.club_id, f.game_id, t.union_id;
  GET DIAGNOSTICS v_tables = ROW_COUNT;

  INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
  SELECT DISTINCT f.club_id, f.game_id, p_day, f.user_id
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'CASH' AND f.fee > 0 AND f.user_id <> v_zero
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_club_player_daily (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
  SELECT f.club_id, f.user_id, p_day,
         COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'CASH'), 0),
         COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'TOURNAMENT'), 0), now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.user_id <> v_zero
   GROUP BY f.club_id, f.user_id
  HAVING bool_or(f.buyins <> 0 OR f.cashouts <> 0);
  GET DIAGNOSTICS v_players = ROW_COUNT;

  INSERT INTO public.ca_club_tournament_daily (club_id, tournament_id, stat_date, fee, winnings, updated_at)
  SELECT f.club_id, f.game_id, p_day, SUM(f.fee), SUM(f.winnings), now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT'
   GROUP BY f.club_id, f.game_id;
  GET DIAGNOSTICS v_tournaments = ROW_COUNT;

  INSERT INTO public.ca_club_tournament_player_daily (club_id, tournament_id, user_id, stat_date, updated_at)
  SELECT DISTINCT f.club_id, f.game_id, f.user_id, p_day, now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT' AND f.user_id <> v_zero
     AND (f.buyins <> 0 OR f.cashouts <> 0)
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('day', p_day, 'source', 'ca_club_data_fact', 'table_rows', v_tables,
                            'player_rows', v_players, 'tournament_rows', v_tournaments);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The live writers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_compute(p_from timestamp with time zone, p_to timestamp with time zone, p_ids uuid[])
 RETURNS TABLE(club_id uuid, stat_date date, hands bigint, rake numeric, bbj numeric, pot numeric, source_rows bigint)
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
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
    UNION ALL
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0), coalesce(r.bbj_contribution, 0),
           coalesce(r.pot_size, 0), r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NULL AND r.created_at >= p_from AND r.created_at < p_to
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
  ),
  tbl AS (
    SELECT s.id, s.club_id AS table_club, (s.created_at AT TIME ZONE 'UTC')::date AS day,
           s.rake, s.bbj, s.pot, s.player_contributions, t.union_id, s.table_id
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
           -- 20261017204111: the club of this player's seat at THIS hand -
           -- rake_attributions, else the seat at the table - and only then the
           -- union-scoped last resort.
           coalesce((SELECT ra.club_id FROM rake_attributions ra
                      WHERE ra.rake_record_id = c.id AND ra.player_id = c.uid AND ra.club_id IS NOT NULL
                      LIMIT 1),
                    public.fn_ca_cash_seat_club(b.table_id, c.uid),
                    (SELECT cm.club_id
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
-- Grants as production holds them (postgres and service_role only).
REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_compute(timestamptz, timestamptz, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record; v_table_row_club uuid;
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
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    /* 20261017204111: the club the chips moved through - this row's own
       ledger leg, else the seat at THIS table - and only then the
       union-scoped last resort (a standalone table's own club). */
    v_club:=COALESCE(
      public.fn_ca_ledger_leg_club(NEW.user_id,NEW.amount,NEW.type,NEW.created_at,NEW.table_id),
      public.fn_ca_cash_table_reporting_club(v_union,v_table_club,NEW.user_id,NEW.table_id));
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL AND public.fn_ca_launch_reporting_wallet_accepts(v_club,NEW.created_at,NEW.category,NULL,NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
    /* 2026-10-15: the live writer for the Club Data cash table rows. Same
       club as the player rollup above (20261017204111). Its
       own block, so a failure here never costs the player rollup above. */
    BEGIN
      v_table_row_club := COALESCE(v_club, v_table_club);
      IF v_table_row_club IS NOT NULL
         AND public.fn_ca_launch_reporting_wallet_accepts(v_table_row_club,NEW.created_at,NEW.category,NULL,NEW.user_id) THEN
        INSERT INTO public.club_table_daily AS d
          (club_id,table_id,stat_date,union_id,rake,hands,players,buyins,cashouts,net,source_rows,updated_at)
        VALUES(v_table_row_club,NEW.table_id,v_day,v_union,0,0,0,
               CASE WHEN NEW.type='debit' THEN NEW.amount ELSE 0 END,
               CASE WHEN NEW.type='credit' THEN NEW.amount ELSE 0 END,
               v_cash,0,now())
        ON CONFLICT(club_id,table_id,stat_date) DO UPDATE
         SET buyins=d.buyins+EXCLUDED.buyins,
             cashouts=d.cashouts+EXCLUDED.cashouts,
             net=d.net+EXCLUDED.net,
             union_id=COALESCE(d.union_id,EXCLUDED.union_id),
             updated_at=now();
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Club Data cash table rollup failed for tx %: %',NEW.id,SQLERRM;
    END;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    /* 20261017204111: ONE club - the entry's own, else this row's ledger
       leg - never every club the player belongs to, which counted one prize
       once per union and once per standalone club. */
    FOR r IN SELECT x.club_id FROM (SELECT public.fn_ca_tournament_reporting_club(
                NEW.related_entity_id,NEW.user_id,NEW.amount,NEW.type,NEW.created_at) AS club_id) x
              WHERE x.club_id IS NOT NULL LOOP
      IF NOT public.fn_ca_launch_reporting_wallet_accepts(r.club_id,NEW.created_at,NEW.category,NEW.related_entity_id,NEW.user_id) THEN CONTINUE; END IF;
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
$$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_day date; r record; v_fee numeric;
BEGIN
  IF NEW.tournament_id IS NULL AND NOT COALESCE(NEW.is_tournament, false)
     AND NEW.table_id IS NOT NULL AND COALESCE(NEW.rake_amount, 0) > 0 THEN
    /* 2026-10-15: the live writer for cash. SHARED lock, like every other
       reporting trigger; only range rebuilds take it exclusive. */
    PERFORM pg_advisory_xact_lock_shared(918273645);
    PERFORM public.fn_ca_club_table_daily_add_rake(NEW.table_id, NEW.rake_amount, NEW.created_at, NEW.player_contributions);
    RETURN NULL;
  END IF;
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      /* 20261017204111: the named player's entry club (one club). */
      SELECT x.club_id FROM (
        SELECT public.fn_ca_tournament_reporting_club(NEW.tournament_id,(NEW.metadata->>'user_id')::uuid,NULL,NULL,NULL) AS club_id
         WHERE (NEW.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') x
       WHERE x.club_id IS NOT NULL
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount);
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        /* 20261017204111: each entry under its own club, once. */
        SELECT public.fn_ca_tournament_reporting_club(tp.tournament_id,tp.user_id,NULL,NULL,NULL) AS club_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t WHERE m.club_id IS NOT NULL GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount*r.club_players/NULLIF(r.total_players,0));
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The rebuilds.
-- ---------------------------------------------------------------------------
-- The hourly catch-up (fn_club_rake_rollup_catchup -> fn_club_table_daily_catchup)
-- rebuilds the last two days every hour. It used to rebuild yesterday with the
-- earliest-joined-club guess, undoing the live writers every hour. A day the
-- facts cover is rebuilt from them; the live day still belongs to the triggers.
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from_day date := public.fn_ca_club_data_facts_from();
BEGIN
  IF p_day IS NULL OR p_day > v_today THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;
  IF p_day = v_today THEN
    RETURN jsonb_build_object('success', true, 'day', p_day, 'skipped', 'live_day_is_kept_by_triggers');
  END IF;
  IF v_from_day IS NULL OR p_day < v_from_day THEN
    RETURN jsonb_build_object('success', true, 'day', p_day, 'skipped', 'before_club_data_facts');
  END IF;
  RETURN jsonb_build_object('success', true) || public.fn_ca_reporting_rollups_from_facts(p_day);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_club_table_daily_refresh_day(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_refresh_day(date) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
  v_facts_from date;
  v_d date;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  -- 20261017204111: every day the Club Data facts cover is rebuilt from them
  -- (fn_ca_reporting_rollups_from_facts); this rebuild keeps only the days
  -- before them, which nothing else holds.
  v_facts_from := public.fn_ca_club_data_facts_from();
  IF v_facts_from IS NOT NULL AND v_end >= v_facts_from THEN
    FOR v_d IN SELECT gs::date FROM generate_series(GREATEST(v_start, v_facts_from),
                 LEAST(v_end, (now() AT TIME ZONE 'UTC')::date), interval '1 day') gs LOOP
      PERFORM public.fn_ca_reporting_rollups_from_facts(v_d);
    END LOOP;
    IF v_start >= v_facts_from THEN
      RETURN jsonb_build_object('start',v_start,'end',v_end,'source','ca_club_data_fact','refreshed_at',now());
    END IF;
    v_end := v_facts_from - 1;
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
       AND public.fn_ca_launch_reporting_wallet_accepts(h.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    -- standalone tables, which this rollup never read.
    SELECT 'cash',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           tb.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
       AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(tb.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT 'tournament',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
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
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
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
           public.fn_ca_launch_reporting_fee_credit(CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END,r.id,r.created_at,r.metadata,r.rake_amount,CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount ELSE r.rake_amount*ec.club_players/NULLIF(et.total_players,0) END) AS fee
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
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL AND rm.fee<>0 GROUP BY 1,2,3
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
     AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
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
$$;
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups_base(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups_base(date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_cash_rollup(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start date:=LEAST(p_start,p_end); v_end date:=GREATEST(p_start,p_end);
  v_from timestamptz; v_to timestamptz; v_rows bigint;
  v_facts_from date; v_d date;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end-v_start>400 THEN
    RAISE EXCEPTION 'cash reporting refresh requires a 0-400 day range'; END IF;
  -- 20261017204111: every day the Club Data facts cover is rebuilt from them
  -- (fn_ca_reporting_rollups_from_facts); this rebuild keeps only the days
  -- before them, which nothing else holds.
  v_facts_from := public.fn_ca_club_data_facts_from();
  IF v_facts_from IS NOT NULL AND v_end >= v_facts_from THEN
    FOR v_d IN SELECT gs::date FROM generate_series(GREATEST(v_start, v_facts_from),
                 LEAST(v_end, (now() AT TIME ZONE 'UTC')::date), interval '1 day') gs LOOP
      PERFORM public.fn_ca_reporting_rollups_from_facts(v_d);
    END LOOP;
    IF v_start >= v_facts_from THEN
      RETURN jsonb_build_object('start',v_start,'end',v_end,'source','ca_club_data_fact','refreshed_at',now());
    END IF;
    v_end := v_facts_from - 1;
  END IF;
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

-- ---------------------------------------------------------------------------
-- 5. The whole-club Report readers: who may open them, and whose players they
--    list. These functions are long and otherwise unchanged, so the one line
--    that changes is rewritten in place on their installed definitions, and
--    the migration aborts unless each pattern matches exactly as many times
--    as expected (pg_temp helper; nothing is left behind).
--
--    a. Access: ca_can_view_club_finances admits super agents and stays as it
--       is for the eighteen other reads that use it (the cashier among them).
--       The Report's own reads ask ca_can_view_whole_club_report.
--    b. Players listed: "players whose EARLIEST-joined union club is this
--       club" left JAQK's own members out of JAQK's list. The list is this
--       club's members; the figures beside them come from the rebuilt facts.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ca_rewrite(p_fn regprocedure, p_pattern text, p_replacement text, p_expect int)
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE v_def text := pg_get_functiondef(p_fn); v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM regexp_matches(v_def, p_pattern, 'g');
  IF v_n <> p_expect THEN
    RAISE EXCEPTION 'rewrite of % expected % match(es) of %, found %', p_fn, p_expect, p_pattern, v_n;
  END IF;
  EXECUTE regexp_replace(v_def, p_pattern, p_replacement, 'g');
END $rw$;

SELECT pg_temp.ca_rewrite(f::regprocedure, 'ca_can_view_club_finances\(', 'ca_can_view_whole_club_report(', 1)
  FROM unnest(ARRAY[
    'public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer)',
    'public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)',
    'public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)',
    'public.ca_club_player_breakdown(uuid,date,date,integer)',
    'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)',
    'public.ca_club_union_invoices(uuid,integer)',
    'public.ca_club_data_export_page(uuid,integer,integer)']) f;

SELECT pg_temp.ca_rewrite(f::regprocedure, 'ca_can_read_club_production\(', 'ca_can_read_whole_club_production(', 1)
  FROM unnest(ARRAY[
    'public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)',
    'public.ca_club_data_export_page(uuid,integer,integer)']) f;

SELECT pg_temp.ca_rewrite(f::regprocedure,
  'SELECT a\.user_id FROM \(\s*SELECT DISTINCT ON\s*\(cm\.user_id\)\s*cm\.user_id,\s*cm\.club_id\s+FROM public\.club_members cm JOIN public\.union_clubs uc\s+ON uc\.club_id=cm\.club_id AND uc\.union_id=v_union\s+WHERE v_union IS NOT NULL\s+ORDER BY cm\.user_id,\s*cm\.joined_at ASC NULLS LAST,\s*cm\.club_id\s*\)\s*a\s+WHERE a\.club_id=p_club_id\s+UNION\s+SELECT cm\.user_id FROM public\.club_members cm\s+WHERE v_union IS NULL AND cm\.club_id=p_club_id',
  'SELECT DISTINCT cm.user_id FROM public.club_members cm WHERE cm.club_id=p_club_id', 1)
  FROM unnest(ARRAY[
    'public.ca_club_player_breakdown(uuid,date,date,integer)',
    'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)']) f;

-- ---------------------------------------------------------------------------
-- 6. The screen, without the four-second fourteen days.
--
--    Measured on production at 20:33 UTC, Club JAQK, 14 days: 3.81 s. Of it,
--    1.1 s grouped 423,000 fact rows into 245,000 games WHILE counting every
--    game's distinct players, and 1.1 s hash-joined all 700,000 tournaments to
--    describe games the page never shows. The page shows 200 rows.
--
--    Now: one pass totals every game (no distinct count), the summary is taken
--    from those totals, and only the rows the page shows are described and
--    have their players counted. Tournament attributes are read for every
--    game only when a filter needs them (MTT / SNG, or a search). Same answer,
--    1.05 s on the same window.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_data_screen(
  p_club_id uuid, p_start date DEFAULT NULL, p_end date DEFAULT NULL,
  p_game text DEFAULT 'ALL', p_stakes text DEFAULT 'ALL',
  p_search text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET work_mem = '96MB' AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end);
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_scope text := public.fn_ca_club_data_scope(p_club_id);
  v_attrs boolean;
  v_users uuid[];
  v_role text;
  v_club_name text;
  v_union uuid;
  v_facts_from date;
  v_sum jsonb;
  v_rows jsonb;
BEGIN
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_scope = 'downline' THEN
    v_users := public.fn_ca_club_data_downline(p_club_id, auth.uid());
  END IF;
  -- Tournament attributes for every game only when a filter reads them.
  v_attrs := v_game IN ('MTT', 'SNG') OR v_q IS NOT NULL;
  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;
  SELECT cm.role INTO v_role FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
  v_facts_from := public.fn_ca_club_data_facts_from();

  WITH g AS MATERIALIZED (
    SELECT d.kind, d.game_id, SUM(d.fee) AS fee, SUM(d.winnings) AS winnings, max(d.last_at) AS activity_at
      FROM public.ca_club_data_fact d
     WHERE d.club_id = p_club_id AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users))
       AND (v_game = 'ALL'
            OR (v_game IN ('HOLDEM', 'OMAHA', 'MIXED') AND d.kind = 'CASH')
            OR (v_game IN ('MTT', 'SNG') AND d.kind = 'TOURNAMENT'))
       AND (v_stakes = 'ALL' OR d.kind = 'CASH')
     GROUP BY d.kind, d.game_id
  ), felt AS MATERIALIZED (
    -- Chips still in front of this club's seated players: part of the result,
    -- not a loss. The seat's own club, as the money was.
    SELECT s.table_id, SUM(s.stack) AS felt, count(*)::int AS seated
      FROM public.table_seats s
      JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
     WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
       AND COALESCE(s.status, 'active') <> 'left' AND COALESCE(s.stack, 0) > 0
       AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
       AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = p_club_id
       AND (v_users IS NULL OR s.user_id = ANY (v_users))
       AND v_game IN ('ALL', 'HOLDEM', 'OMAHA', 'MIXED')
     GROUP BY s.table_id
  ), running AS MATERIALIZED (
    SELECT tr.id FROM public.tournaments tr WHERE tr.status = 'RUNNING'
  ), cash AS (
    -- Cash games are few; every one is described.
    SELECT t.id AS game_id, COALESCE(t.name, 'Unnamed') AS name,
           CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                ELSE 'HOLDEM' END AS game_class,
           CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           COALESCE(pr.username, '') AS creator_name,
           COALESCE(gg.fee, 0) AS fee,
           COALESCE(gg.winnings, 0) + COALESCE(fe.felt, 0) AS winnings,
           COALESCE(gg.activity_at, now()) AS activity_at,
           (fe.felt IS NOT NULL) AS live, fe.seated, fe.felt AS on_felt
      FROM (SELECT * FROM g WHERE g.kind = 'CASH') gg
      FULL JOIN felt fe ON fe.table_id = gg.game_id
      JOIN public.tables t ON t.id = COALESCE(gg.game_id, fe.table_id)
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
  ), tour AS (
    SELECT g.game_id, g.fee, g.winnings, g.activity_at,
           (g.game_id IN (SELECT r.id FROM running r)) AS live
      FROM g WHERE g.kind = 'TOURNAMENT'
  ), tour_described AS (
    -- Read only when a filter needs it: v_attrs is a one-time filter, so the
    -- tournaments join is never executed for the plain screen.
    SELECT tu.*, COALESCE(tr.name, 'Tournament') AS name,
           CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS game_class
      FROM tour tu JOIN public.tournaments tr ON tr.id = tu.game_id
     WHERE v_attrs
  ), filtered AS (
    SELECT 'CASH'::text AS k, c.game_id, c.fee, c.winnings, c.activity_at, c.live, c.seated, c.on_felt
      FROM cash c
     WHERE (v_game = 'ALL' OR c.game_class = v_game)
       AND (v_stakes = 'ALL' OR c.stakes_tier = v_stakes)
       AND (v_q IS NULL OR c.name ILIKE '%' || v_q || '%' OR c.game_id::text ILIKE '%' || v_q || '%'
            OR c.creator_name ILIKE '%' || v_q || '%')
    UNION ALL
    SELECT 'TOURNAMENT', tu.game_id, tu.fee, tu.winnings, tu.activity_at, tu.live, NULL::int, NULL::numeric
      FROM tour tu WHERE NOT v_attrs
    UNION ALL
    SELECT 'TOURNAMENT', td.game_id, td.fee, td.winnings, td.activity_at, td.live, NULL::int, NULL::numeric
      FROM tour_described td
     WHERE v_attrs
       AND (v_game = 'ALL' OR td.game_class = v_game)
       AND (v_q IS NULL OR td.name ILIKE '%' || v_q || '%' OR td.game_id::text ILIKE '%' || v_q || '%')
  ), summary AS (
    SELECT jsonb_build_object(
      'games', count(*),
      'total_winnings', round(COALESCE(SUM(winnings), 0), 2),
      'mtt_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k <> 'CASH'), 0), 2),
      'cash_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'CASH'), 0), 2),
      'fee', round(COALESCE(SUM(fee), 0), 2),
      'cash_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'CASH'), 0), 2),
      'mtt_fee', round(COALESCE(SUM(fee) FILTER (WHERE k <> 'CASH'), 0), 2),
      'on_felt', round(COALESCE(SUM(on_felt), 0), 2),
      'live_games', count(*) FILTER (WHERE live)) AS s
      FROM filtered
  ), top AS MATERIALIZED (
    SELECT * FROM filtered ORDER BY live DESC, activity_at DESC NULLS LAST, k, game_id LIMIT v_lim
  ), pl AS (
    SELECT f.game_id, count(DISTINCT f.user_id) AS n
      FROM public.ca_club_data_fact f
     WHERE f.club_id = p_club_id AND f.stat_date BETWEEN v_start AND v_end
       AND f.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
       AND (v_users IS NULL OR f.user_id = ANY (v_users))
       AND f.game_id IN (SELECT tp.game_id FROM top tp)
     GROUP BY f.game_id
  ), described AS (
    SELECT CASE WHEN tp.k = 'CASH' THEN 'CASH'
                WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS kind,
           tp.game_id::text AS id,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(t.name, 'Unnamed') ELSE COALESCE(tr.name, 'Tournament') END AS name,
           CASE WHEN tp.k = 'CASH' THEN UPPER(COALESCE(t.game_variant, 'nlh'))
                ELSE UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) END AS variant,
           CASE WHEN tp.k = 'CASH' THEN
                  CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                       WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                       ELSE 'HOLDEM' END
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS game_class,
           CASE WHEN tp.k <> 'CASH' THEN 'NA'
                WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           CASE WHEN tp.k = 'CASH' AND COALESCE(t.big_blind,0) > 0 THEN
             trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
             trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
           CASE WHEN tp.k = 'CASH' THEN t.created_at ELSE tr.start_time END AS started_at,
           CASE WHEN tp.k = 'CASH' THEN t.status ELSE tr.status END AS status,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(pr.username, '') ELSE '' END AS creator_name,
           round(tp.fee, 2) AS fee, round(tp.winnings, 2) AS winnings,
           GREATEST(COALESCE(pl.n, 0), COALESCE(tp.seated, 0))::int AS players,
           tp.activity_at, tp.live, tp.seated, round(tp.on_felt, 2) AS on_felt, tp.k
      FROM top tp
      LEFT JOIN public.tables t ON tp.k = 'CASH' AND t.id = tp.game_id
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
      LEFT JOIN public.tournaments tr ON tp.k = 'TOURNAMENT' AND tr.id = tp.game_id
      LEFT JOIN pl ON pl.game_id = tp.game_id
  )
  SELECT (SELECT s FROM summary),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind', kind, 'id', id, 'name', name, 'variant', variant,
           'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
           'started_at', started_at, 'activity_at', activity_at, 'status', status,
           'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
           'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
           'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY live DESC, activity_at DESC NULLS LAST, k, id) FROM described), '[]'::jsonb)
    INTO v_sum, v_rows;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'scope', v_scope,
    'viewer_role', v_role,
    'club_name', v_club_name,
    'facts_from', v_facts_from,
    'summary', v_sum,
    'rows', v_rows,
    'row_count', (v_sum->>'games')::int,
    'union_id', v_union,
    'generated_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) TO authenticated, service_role;

COMMIT;
