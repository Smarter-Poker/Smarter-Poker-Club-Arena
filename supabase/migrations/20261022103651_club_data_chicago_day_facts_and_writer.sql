-- 20261022103651_club_data_chicago_day_facts_and_writer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLUB DATA COUNTS CHICAGO DAYS AT THE SOURCE (Dan, 2026-10-22)
--
-- Club Data and Union Data read public.ca_club_data_fact, which the live
-- money path writes one row per (club, UTC day, game, player). A "Day" on the
-- page therefore rolls over at 7 PM Chicago (6 PM in winter). A report window
-- can only be as fine as the bucket under it, so the fix is the bucket.
--
-- WHAT THIS ADDS (report-only; no money, ledger, rake, rakeback, invoice,
-- settlement or weekly-accounting row or rule is touched):
--
--  1. public.ca_club_data_fact_ct, the same facts keyed by America/Chicago
--     calendar day (DST aware: (at AT TIME ZONE 'America/Chicago')::date),
--     public.ca_club_data_game_ct, the same summed per game (the game page's
--     ranking set, as club_table_daily / ca_club_tournament_daily were), and
--     public.ca_club_data_hands_ct, raked cash hands per (club, Chicago day,
--     table) for the same reader.
--  2. The live writer fn_ca_club_data_fact_put now writes BOTH buckets, in the
--     same statement that moves the money, from the same arguments. A row is
--     never written to one bucket and not the other. The Chicago bucket starts
--     at a cutover instant (ca_club_data_ct_state.live_from, this migration's
--     commit plus three minutes, like 20261017160125's own cutover) so the
--     history load below and the live writer can never both count one event.
--  3. trg_ca_club_data_fact_rake also counts the raked hand itself (its
--     existing club resolution, unchanged), from the same cutover.
--  4. fn_ca_club_data_ct_seed(p_day), the ONE-TIME history load of the new
--     table, exactly the pattern of 20261017160125's fn_ca_club_data_fact_seed:
--     one UTC day per call, refused until a minute after the cutover, refused
--     for an overlapping or repeated day by its own log, and refused for a day
--     the live writer has already begun. It is not a repair: it fills a new
--     derived table once and is then inert; nothing schedules it.
--
-- NO LOCK IS EVER SHARED WITH A HAND. Every row carries src (0 = written by
-- the live writer, 1 = written by the history load), and src is part of the
-- key, so a load can never hold a row a settling hand needs to update, even
-- on the cutover day. Readers sum across src.
--
-- HOW THE HISTORY LOAD IS EXACT
--
-- The UTC-day facts already hold the club attribution the live path made for
-- every (UTC day, game, player). Chicago midnight falls inside each UTC day
-- (05:00 or 06:00 UTC), so each UTC day d splits into an early slice
-- [d 00:00 UTC, Chicago midnight of d) that belongs to Chicago day d-1 and a
-- late slice that belongs to Chicago day d. The seed re-reads the early
-- slice's rake_records and wallet_transactions with the fact table's own
-- formulas, attributes each event to the club that already holds its key in
-- the UTC fact (the club resolution the live writer used; a key held by two
-- clubs is resolved by the original seed's own chain), and writes
--   ct(d-1) += early slice,  ct(d) += fact(d) - early slice.
-- Every fact row's total is therefore preserved exactly (sum over Chicago
-- days = sum over UTC days, per club, game and player), and only the day
-- moves. Hands are split the same way from club_table_daily.
--
-- Measured on production (read-only, 2026-10-22): for 2026-10-20 and
-- 2026-10-04 the slice re-derived every fact row whose last activity was
-- inside the slice to the exact numeric value (0 differences over 17,203 and
-- 27,846 keys), no slice event lacked a fact row, and no slice hand count
-- exceeded club_table_daily. One day's slice reads in ~25 s.
--
-- One migration, one transaction, lock_timeout bounded. The only lock on a
-- money table is the moment CREATE OR REPLACE FUNCTION needs; no trigger is
-- created, dropped or re-declared on any table.
--
-- @live-proof: to_regclass('public.ca_club_data_fact_ct') IS NOT NULL
-- @live-proof: to_regclass('public.ca_club_data_game_ct') IS NOT NULL
-- @live-proof: to_regclass('public.ca_club_data_fact_ct_game_idx') IS NOT NULL
-- @live-proof: position('ca_club_data_fact_ct' IN pg_get_functiondef('public.fn_ca_club_data_fact_put(uuid,date,text,uuid,uuid,numeric,numeric,numeric,numeric,timestamp with time zone)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$ BEGIN
  IF to_regclass('public.ca_club_data_fact_ct') IS NOT NULL THEN
    RAISE EXCEPTION 'Club Data Chicago facts already installed';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_club_data_fact_put(uuid,date,text,uuid,uuid,numeric,numeric,numeric,numeric,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '3b39ccf28d8fc6e6a1bc5c027104a56e' THEN
    RAISE EXCEPTION 'Club Data fact writer preimage changed';
  END IF;
  IF md5(pg_get_functiondef('public.trg_ca_club_data_fact_rake()'::regprocedure))
       IS DISTINCT FROM '897794d0efd4f6aed96ea4e9c03d7c78' THEN
    RAISE EXCEPTION 'Club Data rake fact trigger preimage changed';
  END IF;
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'club data migration requires the maintained installer';
  END IF;
END $guard$;

-- ---------------------------------------------------------------------------
-- 1. The Chicago-day tables and the cutover.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_club_data_fact_ct (
  club_id   uuid        NOT NULL,
  stat_date date        NOT NULL,
  kind      text        NOT NULL CHECK (kind IN ('CASH', 'TOURNAMENT')),
  game_id   uuid        NOT NULL,
  user_id   uuid        NOT NULL,
  fee       numeric     NOT NULL DEFAULT 0,
  buyins    numeric     NOT NULL DEFAULT 0,
  cashouts  numeric     NOT NULL DEFAULT 0,
  winnings  numeric     NOT NULL DEFAULT 0,
  last_at   timestamptz NOT NULL DEFAULT now(),
  src       smallint    NOT NULL DEFAULT 0 CHECK (src IN (0, 1)),
  PRIMARY KEY (club_id, stat_date, game_id, user_id, src)
);
-- A visible game's own rows, by key (the game page reads players per row).
CREATE INDEX ca_club_data_fact_ct_game_idx ON public.ca_club_data_fact_ct (club_id, game_id, stat_date) INCLUDE (user_id, kind);
ALTER TABLE public.ca_club_data_fact_ct ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_fact_ct FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ca_club_data_fact_ct IS
  'Club Data facts keyed by America/Chicago calendar day (DST aware). Same rows, clubs and formulas as ca_club_data_fact (UTC day), written by the same writer fn_ca_club_data_fact_put from ca_club_data_ct_state.live_from, and before it by the one-time load fn_ca_club_data_ct_seed. Report-only: read by Club Data and Union Data.';

CREATE TABLE public.ca_club_data_hands_ct (
  club_id   uuid    NOT NULL,
  stat_date date    NOT NULL,
  table_id  uuid    NOT NULL,
  hands     bigint  NOT NULL DEFAULT 0,
  src       smallint NOT NULL DEFAULT 0 CHECK (src IN (0, 1)),
  PRIMARY KEY (club_id, stat_date, table_id, src)
);
ALTER TABLE public.ca_club_data_hands_ct ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_hands_ct FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ca_club_data_hands_ct IS
  'Raked cash hands per club, America/Chicago day and table, for Club Data. Counted by trg_ca_club_data_fact_rake with the club resolution club_table_daily uses for the same hand; history loaded once by fn_ca_club_data_ct_seed.';

CREATE TABLE public.ca_club_data_game_ct (
  club_id   uuid        NOT NULL,
  stat_date date        NOT NULL,
  kind      text        NOT NULL CHECK (kind IN ('CASH', 'TOURNAMENT')),
  game_id   uuid        NOT NULL,
  fee       numeric     NOT NULL DEFAULT 0,
  buyins    numeric     NOT NULL DEFAULT 0,
  cashouts  numeric     NOT NULL DEFAULT 0,
  winnings  numeric     NOT NULL DEFAULT 0,
  last_at   timestamptz NOT NULL DEFAULT now(),
  src       smallint    NOT NULL DEFAULT 0 CHECK (src IN (0, 1)),
  PRIMARY KEY (club_id, stat_date, game_id, src)
);
CREATE INDEX ca_club_data_game_ct_game_idx ON public.ca_club_data_game_ct (club_id, game_id, stat_date) INCLUDE (kind, fee, winnings);
ALTER TABLE public.ca_club_data_game_ct ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_game_ct FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ca_club_data_game_ct IS
  'ca_club_data_fact_ct summed over players: one row per club, America/Chicago day and game, written by the same statement. Lets the Club Data game page and export rank games without reading every player row.';

CREATE TABLE public.ca_club_data_ct_state (
  id        boolean     PRIMARY KEY DEFAULT true CHECK (id),
  live_from timestamptz NOT NULL
);
ALTER TABLE public.ca_club_data_ct_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_ct_state FROM PUBLIC, anon, authenticated;
INSERT INTO public.ca_club_data_ct_state (id, live_from)
VALUES (true, date_trunc('second', now()) + interval '3 minutes');

CREATE TABLE public.ca_club_data_ct_seed_log (
  utc_day   date        PRIMARY KEY,
  rows_put  bigint      NOT NULL,
  hand_rows bigint      NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_club_data_ct_seed_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_ct_seed_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_ct_live_from()
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT s.live_from FROM public.ca_club_data_ct_state s WHERE s.id;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_ct_live_from() FROM PUBLIC, anon, authenticated;

-- The Chicago calendar day of an instant. DST is the zone database's.
CREATE OR REPLACE FUNCTION public.fn_ca_chicago_day(p_at timestamptz)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $function$
  SELECT (p_at AT TIME ZONE 'America/Chicago')::date;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_ca_chicago_day(timestamptz) TO authenticated, service_role;

-- [start of Chicago day p_start, start of Chicago day p_end + 1), as instants.
CREATE OR REPLACE FUNCTION public.fn_ca_chicago_day_start(p_day date)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $function$
  SELECT (p_day::timestamp AT TIME ZONE 'America/Chicago');
$function$;
GRANT EXECUTE ON FUNCTION public.fn_ca_chicago_day_start(date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The one writer writes both buckets.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_fact_put(p_club uuid, p_day date, p_kind text, p_game uuid, p_user uuid, p_fee numeric, p_buyins numeric, p_cashouts numeric, p_winnings numeric, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.ca_club_data_fact AS f
    (club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, last_at)
  VALUES (p_club, p_day, p_kind, p_game,
          COALESCE(p_user, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(p_fee, 0), COALESCE(p_buyins, 0), COALESCE(p_cashouts, 0),
          COALESCE(p_winnings, 0), COALESCE(p_at, now()))
  ON CONFLICT (club_id, stat_date, game_id, user_id) DO UPDATE
     SET fee = f.fee + EXCLUDED.fee,
         buyins = f.buyins + EXCLUDED.buyins,
         cashouts = f.cashouts + EXCLUDED.cashouts,
         winnings = f.winnings + EXCLUDED.winnings,
         last_at = GREATEST(f.last_at, EXCLUDED.last_at);
  -- 20261022103651: the same event, keyed by its America/Chicago day, from the
  -- Chicago cutover on (the one-time load owns everything before it).
  INSERT INTO public.ca_club_data_fact_ct AS c
    (club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, last_at)
  SELECT p_club, public.fn_ca_chicago_day(COALESCE(p_at, now())), p_kind, p_game,
         COALESCE(p_user, '00000000-0000-0000-0000-000000000000'::uuid),
         COALESCE(p_fee, 0), COALESCE(p_buyins, 0), COALESCE(p_cashouts, 0),
         COALESCE(p_winnings, 0), COALESCE(p_at, now())
   WHERE COALESCE(p_at, now()) >= public.fn_ca_club_data_ct_live_from()
  ON CONFLICT (club_id, stat_date, game_id, user_id, src) DO UPDATE
     SET fee = c.fee + EXCLUDED.fee,
         buyins = c.buyins + EXCLUDED.buyins,
         cashouts = c.cashouts + EXCLUDED.cashouts,
         winnings = c.winnings + EXCLUDED.winnings,
         last_at = GREATEST(c.last_at, EXCLUDED.last_at);
  INSERT INTO public.ca_club_data_game_ct AS g
    (club_id, stat_date, kind, game_id, fee, buyins, cashouts, winnings, last_at)
  SELECT p_club, public.fn_ca_chicago_day(COALESCE(p_at, now())), p_kind, p_game,
         COALESCE(p_fee, 0), COALESCE(p_buyins, 0), COALESCE(p_cashouts, 0),
         COALESCE(p_winnings, 0), COALESCE(p_at, now())
   WHERE COALESCE(p_at, now()) >= public.fn_ca_club_data_ct_live_from()
  ON CONFLICT (club_id, stat_date, game_id, src) DO UPDATE
     SET fee = g.fee + EXCLUDED.fee,
         buyins = g.buyins + EXCLUDED.buyins,
         cashouts = g.cashouts + EXCLUDED.cashouts,
         winnings = g.winnings + EXCLUDED.winnings,
         last_at = GREATEST(g.last_at, EXCLUDED.last_at);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_fact_put(uuid, date, text, uuid, uuid, numeric, numeric, numeric, numeric, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_hand_put(p_club uuid, p_table uuid, p_at timestamptz)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.ca_club_data_hands_ct AS h (club_id, stat_date, table_id, hands)
  SELECT p_club, public.fn_ca_chicago_day(p_at), p_table, 1
   WHERE p_club IS NOT NULL AND p_table IS NOT NULL AND p_at >= public.fn_ca_club_data_ct_live_from()
  ON CONFLICT (club_id, stat_date, table_id, src) DO UPDATE SET hands = h.hands + 1;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_hand_put(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The rake trigger also counts the hand, once per club that shares it.
--    The club is the one fn_ca_club_table_daily_add_rake (club_table_daily)
--    resolves for the same hand: seat club, else reporting club; a hand that
--    named nobody is the table club's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_ca_club_data_fact_rake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_day date; v_union uuid; v_table_club uuid; v_tourn uuid; v_found boolean;
  v_uid uuid; v_club uuid; v_n numeric; r record; v_any boolean := false;
  v_hand_clubs uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NEW.created_at < public.fn_ca_club_data_fact_live_from() THEN RETURN NULL; END IF;
  IF COALESCE(NEW.rake_amount, 0) = 0 THEN RETURN NULL; END IF;
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;

  IF NEW.tournament_id IS NULL AND NOT COALESCE(NEW.is_tournament, false) THEN
    -- A cash hand: each contributor's share, to the club their seat was bought in through.
    IF NEW.table_id IS NULL OR NEW.rake_amount <= 0 THEN RETURN NULL; END IF;
    SELECT t.union_id, t.club_id, t.tournament_id, true
      INTO v_union, v_table_club, v_tourn, v_found
      FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_found IS NOT TRUE OR v_tourn IS NOT NULL THEN RETURN NULL; END IF;
    FOR r IN
      WITH e AS (
        SELECT x.key::uuid AS uid, (CASE WHEN x.value ~ '^[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) AS contrib
          FROM jsonb_each_text(CASE WHEN jsonb_typeof(NEW.player_contributions) = 'object'
                                    THEN NEW.player_contributions ELSE '{}'::jsonb END) x
         WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           AND (CASE WHEN x.value ~ '^[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0
      ), s AS (SELECT e.uid, e.contrib, SUM(e.contrib) OVER () AS tot FROM e)
      SELECT COALESCE(public.fn_ca_cash_seat_club(NEW.table_id, s.uid),
                      public.fn_ca_cash_reporting_club(v_union, v_table_club, s.uid)) AS club_id,
             s.uid, NEW.rake_amount * s.contrib / s.tot AS fee
        FROM s ORDER BY 1, 2
    LOOP
      v_any := true;
      CONTINUE WHEN r.club_id IS NULL;
      CONTINUE WHEN public.fn_ca_launch_accounting_accepts(r.club_id, NEW.created_at) IS NOT TRUE;
      PERFORM public.fn_ca_club_data_fact_put(r.club_id, v_day, 'CASH', NEW.table_id, r.uid,
                                              r.fee, 0, 0, 0, NEW.created_at);
      IF NOT (r.club_id = ANY (v_hand_clubs)) THEN
        v_hand_clubs := v_hand_clubs || r.club_id;
        PERFORM public.fn_ca_club_data_hand_put(r.club_id, NEW.table_id, NEW.created_at);
      END IF;
    END LOOP;
    -- A raked hand that named nobody is the table's club's rake, whole.
    IF NOT v_any AND v_table_club IS NOT NULL
       AND public.fn_ca_launch_accounting_accepts(v_table_club, NEW.created_at) IS TRUE THEN
      PERFORM public.fn_ca_club_data_fact_put(v_table_club, v_day, 'CASH', NEW.table_id, NULL,
                                              NEW.rake_amount, 0, 0, 0, NEW.created_at);
      PERFORM public.fn_ca_club_data_hand_put(v_table_club, NEW.table_id, NEW.created_at);
    END IF;
    RETURN NULL;
  END IF;

  -- A tournament fee: the named player's entry club, else split across the entries.
  IF NEW.tournament_id IS NULL THEN RETURN NULL; END IF;
  SELECT tr.union_id, tr.club_id INTO v_union, v_table_club
    FROM public.tournaments tr WHERE tr.id = NEW.tournament_id;
  IF NEW.metadata ? 'user_id'
     AND (NEW.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_uid := (NEW.metadata->>'user_id')::uuid;
    SELECT tp.club_id INTO v_club FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.tournament_id AND tp.user_id = v_uid;
    v_club := COALESCE(v_club, public.fn_ca_cash_reporting_club(v_union, v_table_club, v_uid));
    IF v_club IS NOT NULL AND public.fn_ca_launch_accounting_accepts(v_club, NEW.created_at) IS TRUE THEN
      PERFORM public.fn_ca_club_data_fact_put(v_club, v_day, 'TOURNAMENT', NEW.tournament_id, v_uid,
                                              NEW.rake_amount, 0, 0, 0, NEW.created_at);
    END IF;
  ELSE
    SELECT count(*)::numeric INTO v_n FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.tournament_id;
    IF COALESCE(v_n, 0) = 0 THEN RETURN NULL; END IF;
    FOR r IN
      SELECT COALESCE(tp.club_id, public.fn_ca_cash_reporting_club(v_union, v_table_club, tp.user_id)) AS club_id,
             tp.user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.tournament_id
       ORDER BY 1, 2
    LOOP
      CONTINUE WHEN r.club_id IS NULL;
      CONTINUE WHEN public.fn_ca_launch_accounting_accepts(r.club_id, NEW.created_at) IS NOT TRUE;
      PERFORM public.fn_ca_club_data_fact_put(r.club_id, v_day, 'TOURNAMENT', NEW.tournament_id, r.user_id,
                                              NEW.rake_amount / v_n, 0, 0, 0, NEW.created_at);
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data fact (rake) failed for row %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_ca_club_data_fact_rake() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The one-time history load: one UTC day per call, before the cutover.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_ct_seed(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '600s' SET work_mem = '128MB' AS $function$
DECLARE
  v_live timestamptz := public.fn_ca_club_data_ct_live_from();
  v_live_day date := (public.fn_ca_club_data_ct_live_from() AT TIME ZONE 'UTC')::date;
  v_lo timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_b timestamptz := public.fn_ca_chicago_day_start(p_day);
  v_from timestamptz; v_to timestamptz; v_part int;
  v_rows bigint := 0; v_hand_rows bigint := 0;
  v_bad bigint; v_bounded bigint;
BEGIN
  IF p_day IS NULL OR p_day < public.fn_ca_club_data_facts_from() THEN
    RAISE EXCEPTION 'Chicago seed day % is before the Club Data facts begin', p_day;
  END IF;
  IF p_day > v_live_day THEN
    RAISE EXCEPTION 'Chicago seed day % is after the cutover day %; the live writer owns it', p_day, v_live_day;
  END IF;
  IF now() < v_live + interval '1 minute' THEN
    RAISE EXCEPTION 'Chicago seed waits until a minute after its cutover (%)', v_live;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_club_data_ct_seed_log l WHERE l.utc_day = p_day) THEN
    RAISE EXCEPTION 'Chicago seed day % is already loaded', p_day;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('ca-club-data-ct-seed')) THEN
    RAISE EXCEPTION 'another Chicago seed day is loading';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS ca_ct_seed_early (
    part int, club uuid, kind text, game uuid, usr uuid, fee numeric, bi numeric, co numeric, last_at timestamptz
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS ca_ct_seed_hands (part int, club uuid, game uuid, hands bigint) ON COMMIT DROP;
  TRUNCATE ca_ct_seed_early, ca_ct_seed_hands;

  -- Part 0: [UTC midnight, Chicago midnight) of p_day -> Chicago day p_day - 1.
  -- Part 1, the cutover day only: [Chicago midnight, cutover) -> Chicago day
  -- p_day. On every whole day before it, part 1 is the UTC fact minus part 0.
  FOR v_part, v_from, v_to IN
    SELECT 0, v_lo, LEAST(v_b, v_live)
    UNION ALL
    SELECT 1, v_b, v_live WHERE p_day = v_live_day AND v_live > v_b
  LOOP
  WITH fk AS MATERIALIZED (
    SELECT f.game_id g, f.user_id u, CASE WHEN count(*) = 1 THEN min(f.club_id::text)::uuid END club
      FROM public.ca_club_data_fact f
     WHERE f.club_id = ANY (ARRAY(SELECT c.id FROM public.clubs c)) AND f.stat_date = p_day
     GROUP BY 1, 2
  ), rc AS MATERIALIZED (
    SELECT r.id, r.table_id g, r.rake_amount ra, r.created_at at, t.union_id un, t.club_id tclub,
           CASE WHEN jsonb_typeof(r.player_contributions) = 'object' THEN r.player_contributions ELSE '{}'::jsonb END pc
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.tournament_id IS NULL AND NOT COALESCE(r.is_tournament, false)
  ), rce AS MATERIALIZED (
    SELECT rc.id, rc.g, rc.ra, rc.at, rc.un, rc.tclub, x.key::uuid u,
           (CASE WHEN x.value ~ '^[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) c
      FROM rc CROSS JOIN LATERAL jsonb_each_text(rc.pc) x
     WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (CASE WHEN x.value ~ '^[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0
  ), cash_share AS MATERIALIZED (
    SELECT s.id, s.g, s.u, s.at, s.un, s.tclub, s.ra * s.c / sum(s.c) OVER (PARTITION BY s.id) fee, fk.club fclub
      FROM rce s LEFT JOIN fk ON fk.g = s.g AND fk.u = s.u
  ), cash_rake AS (
    SELECT s.id hid, 'CASH'::text kind, s.g, s.u, s.at, s.fee, 0::numeric bi, 0::numeric co, s.fclub club
      FROM cash_share s WHERE s.fclub IS NOT NULL
    UNION ALL
    SELECT s.id, 'CASH', s.g, s.u, s.at, s.fee, 0, 0,
           COALESCE((SELECT ra.club_id FROM public.rake_attributions ra
                      WHERE ra.rake_record_id = s.id AND ra.player_id = s.u AND ra.club_id IS NOT NULL LIMIT 1),
                    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
                      WHERE x.operation_kind = 'buyin' AND x.table_id = s.g AND x.account_entity_id = s.u
                        AND x.seat_joined_at <= s.at ORDER BY x.seat_joined_at DESC LIMIT 1),
                    (SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = s.g AND ts.user_id = s.u AND ts.club_id IS NOT NULL
                        AND ts.joined_at <= s.at ORDER BY ts.joined_at DESC LIMIT 1),
                    public.fn_ca_cash_reporting_club(s.un, s.tclub, s.u))
      FROM cash_share s WHERE s.fclub IS NULL
  ), cash_unnamed AS (
    SELECT rc.id, 'CASH'::text, rc.g, '00000000-0000-0000-0000-000000000000'::uuid, rc.at, rc.ra,
           0::numeric, 0::numeric, rc.tclub
      FROM rc WHERE NOT EXISTS (SELECT 1 FROM rce WHERE rce.id = rc.id)
  ), tour_named AS (
    SELECT NULL::uuid, 'TOURNAMENT'::text, r.tournament_id, (r.metadata->>'user_id')::uuid, r.created_at,
           r.rake_amount, 0::numeric, 0::numeric,
           COALESCE(fk.club, tp.club_id,
                    public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, (r.metadata->>'user_id')::uuid))
      FROM public.rake_records r
      LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = r.tournament_id AND tp.user_id = (r.metadata->>'user_id')::uuid
      LEFT JOIN fk ON fk.g = r.tournament_id AND fk.u = (r.metadata->>'user_id')::uuid
     WHERE r.created_at >= v_from AND r.created_at < v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND (r.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), tour_split AS (
    SELECT NULL::uuid, 'TOURNAMENT'::text, r.tournament_id, tp.user_id, r.created_at, r.rake_amount / n.n,
           0::numeric, 0::numeric,
           COALESCE(fk.club, tp.club_id, public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, tp.user_id))
      FROM public.rake_records r
      LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
      JOIN LATERAL (SELECT count(*)::numeric AS n FROM public.tournament_players x
                     WHERE x.tournament_id = r.tournament_id) n ON n.n > 0
      JOIN public.tournament_players tp ON tp.tournament_id = r.tournament_id
      LEFT JOIN fk ON fk.g = r.tournament_id AND fk.u = tp.user_id
     WHERE r.created_at >= v_from AND r.created_at < v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND NOT ((r.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') IS TRUE
  ), wal AS MATERIALIZED (
    SELECT x.id, x.user_id, x.amount, x.type, x.created_at, x.table_id, x.related_entity_id
      FROM public.wallet_transactions x
     WHERE x.created_at >= v_from AND x.created_at < v_to
       AND ((x.table_id IS NOT NULL AND x.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund'))
         OR (x.table_id IS NULL AND x.related_entity_id IS NOT NULL
             AND x.category IN ('tournament_buyin', 'prize', 'bounty', 'addon', 'rebuy', 'refund', 'prize_reversal')))
  ), wal_cash AS (
    SELECT NULL::uuid, 'CASH'::text, x.table_id, x.user_id, x.created_at, 0::numeric,
           CASE WHEN x.type = 'debit' THEN x.amount ELSE 0 END,
           CASE WHEN x.type = 'credit' THEN x.amount ELSE 0 END,
           COALESCE(fk.club,
                    public.fn_ca_ledger_leg_club(x.user_id, x.amount, x.type, x.created_at, x.table_id),
                    (SELECT y.funding_club_id FROM public.cash_participant_funding_receipts y
                      WHERE y.operation_kind = 'buyin' AND y.table_id = x.table_id AND y.account_entity_id = x.user_id
                        AND y.seat_joined_at <= x.created_at ORDER BY y.seat_joined_at DESC LIMIT 1),
                    public.fn_ca_cash_reporting_club(t.union_id, t.club_id, x.user_id))
      FROM wal x JOIN public.tables t ON t.id = x.table_id AND t.tournament_id IS NULL
      LEFT JOIN fk ON fk.g = x.table_id AND fk.u = x.user_id
     WHERE x.table_id IS NOT NULL
  ), wal_tour AS (
    SELECT NULL::uuid, 'TOURNAMENT'::text, x.related_entity_id, x.user_id, x.created_at, 0::numeric,
           CASE WHEN x.type = 'debit' THEN x.amount ELSE 0 END,
           CASE WHEN x.type = 'credit' THEN x.amount ELSE 0 END,
           COALESCE(fk.club, tp.club_id,
                    public.fn_ca_ledger_leg_club(x.user_id, x.amount, x.type, x.created_at, NULL),
                    public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, x.user_id))
      FROM wal x JOIN public.tournaments tr ON tr.id = x.related_entity_id
      LEFT JOIN public.tournament_players tp ON tp.tournament_id = x.related_entity_id AND tp.user_id = x.user_id
      LEFT JOIN fk ON fk.g = x.related_entity_id AND fk.u = x.user_id
     WHERE x.table_id IS NULL
  ), ev (hid, kind, g, u, at, fee, bi, co, club) AS (
    SELECT * FROM cash_rake UNION ALL SELECT * FROM cash_unnamed UNION ALL SELECT * FROM tour_named
    UNION ALL SELECT * FROM tour_split UNION ALL SELECT * FROM wal_cash UNION ALL SELECT * FROM wal_tour
  ), evm AS MATERIALIZED (
    SELECT * FROM ev WHERE club IS NOT NULL AND u IS NOT NULL
  ), cut AS MATERIALIZED (
    SELECT c.club, public.fn_ca_launch_accounting_cutoff('club', c.club) cutoff
      FROM (SELECT DISTINCT club FROM evm) c
  ), acc AS MATERIALIZED (
    SELECT e.* FROM evm e JOIN cut ON cut.club = e.club
     WHERE cut.cutoff IS NULL OR (e.at IS NOT NULL AND isfinite(e.at) AND e.at >= cut.cutoff)
  ), put_early AS (
    INSERT INTO ca_ct_seed_early (part, club, kind, game, usr, fee, bi, co, last_at)
    SELECT v_part, club, min(kind), g, u, sum(fee), sum(bi), sum(co), max(at) FROM acc GROUP BY club, g, u
    RETURNING 1
  )
  INSERT INTO ca_ct_seed_hands (part, club, game, hands)
  SELECT v_part, club, g, count(DISTINCT hid) FROM acc WHERE hid IS NOT NULL AND kind = 'CASH' GROUP BY club, g;
  END LOOP;

  -- Every slice can only ever be a part of what the UTC fact already holds:
  -- the fact is the record of what the live path counted for that key. A
  -- slice key the fact does not hold, or a slice amount beyond the fact's own
  -- (an event the live path did not count), is not moved; each amount is
  -- bounded to the interval between zero and the fact's, so no day is ever
  -- given money the UTC report never had and no remainder goes below zero.
  DELETE FROM ca_ct_seed_early e
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_data_fact f
                      WHERE f.club_id = e.club AND f.stat_date = p_day
                        AND f.game_id = e.game AND f.user_id = e.usr);
  GET DIAGNOSTICS v_bad = ROW_COUNT;
  UPDATE ca_ct_seed_early e
     SET kind = f.kind,
         fee = CASE WHEN f.fee >= 0 THEN LEAST(GREATEST(e.fee, 0), f.fee) ELSE GREATEST(LEAST(e.fee, 0), f.fee) END,
         bi  = CASE WHEN f.buyins >= 0 THEN LEAST(GREATEST(e.bi, 0), f.buyins) ELSE GREATEST(LEAST(e.bi, 0), f.buyins) END,
         co  = CASE WHEN f.cashouts >= 0 THEN LEAST(GREATEST(e.co, 0), f.cashouts) ELSE GREATEST(LEAST(e.co, 0), f.cashouts) END
    FROM public.ca_club_data_fact f
   WHERE f.club_id = e.club AND f.stat_date = p_day AND f.game_id = e.game AND f.user_id = e.usr
     AND (e.kind IS DISTINCT FROM f.kind
          OR e.fee <> CASE WHEN f.fee >= 0 THEN LEAST(GREATEST(e.fee, 0), f.fee) ELSE GREATEST(LEAST(e.fee, 0), f.fee) END
          OR e.bi  <> CASE WHEN f.buyins >= 0 THEN LEAST(GREATEST(e.bi, 0), f.buyins) ELSE GREATEST(LEAST(e.bi, 0), f.buyins) END
          OR e.co  <> CASE WHEN f.cashouts >= 0 THEN LEAST(GREATEST(e.co, 0), f.cashouts) ELSE GREATEST(LEAST(e.co, 0), f.cashouts) END);
  GET DIAGNOSTICS v_bounded = ROW_COUNT;
  UPDATE ca_ct_seed_hands h SET hands = LEAST(h.hands, COALESCE(c.hands, 0))
    FROM (SELECT x.club, x.game, max(d.hands) AS hands
            FROM ca_ct_seed_hands x
            LEFT JOIN public.club_table_daily d ON d.club_id = x.club AND d.stat_date = p_day AND d.table_id = x.game
           GROUP BY 1, 2) c
   WHERE c.club = h.club AND c.game = h.game AND h.hands > COALESCE(c.hands, 0);

  CREATE TEMP TABLE IF NOT EXISTS ca_ct_seed_parts (
    club uuid, d date, kind text, game uuid, usr uuid, fee numeric, bi numeric, co numeric, win numeric, last_at timestamptz
  ) ON COMMIT DROP;
  TRUNCATE ca_ct_seed_parts;
  INSERT INTO ca_ct_seed_parts
  WITH early AS (SELECT * FROM ca_ct_seed_early WHERE part = 0), parts AS (
    SELECT e.club, p_day - 1 AS d, e.kind, e.game, e.usr, e.fee, e.bi, e.co, e.co - e.bi AS win, e.last_at
      FROM early e
    UNION ALL
    SELECT e.club, p_day, e.kind, e.game, e.usr, e.fee, e.bi, e.co, e.co - e.bi, e.last_at
      FROM ca_ct_seed_early e WHERE e.part = 1
    UNION ALL
    SELECT f.club_id, p_day, f.kind, f.game_id, f.user_id,
           f.fee - COALESCE(e.fee, 0), f.buyins - COALESCE(e.bi, 0), f.cashouts - COALESCE(e.co, 0),
           f.winnings - COALESCE(e.co - e.bi, 0), f.last_at
      FROM public.ca_club_data_fact f
      LEFT JOIN early e ON e.club = f.club_id AND e.game = f.game_id AND e.usr = f.user_id
     WHERE f.stat_date = p_day AND p_day < v_live_day
       AND (e.club IS NULL OR f.last_at >= v_b
            OR f.fee <> e.fee OR f.buyins <> e.bi OR f.cashouts <> e.co)
  )
  SELECT club, d, kind, game, usr, fee, bi, co, win, last_at FROM parts;

  WITH put AS (
    INSERT INTO public.ca_club_data_fact_ct AS c
      (club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, last_at, src)
    SELECT club, d, kind, game, usr, fee, bi, co, win, last_at, 1 FROM ca_ct_seed_parts
    ON CONFLICT (club_id, stat_date, game_id, user_id, src) DO UPDATE
       SET fee = c.fee + EXCLUDED.fee,
           buyins = c.buyins + EXCLUDED.buyins,
           cashouts = c.cashouts + EXCLUDED.cashouts,
           winnings = c.winnings + EXCLUDED.winnings,
           last_at = GREATEST(c.last_at, EXCLUDED.last_at)
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM put;

  INSERT INTO public.ca_club_data_game_ct AS g
    (club_id, stat_date, kind, game_id, fee, buyins, cashouts, winnings, last_at, src)
  SELECT club, d, min(kind), game, sum(fee), sum(bi), sum(co), sum(win), max(last_at), 1
    FROM ca_ct_seed_parts GROUP BY club, d, game
  ON CONFLICT (club_id, stat_date, game_id, src) DO UPDATE
     SET fee = g.fee + EXCLUDED.fee,
         buyins = g.buyins + EXCLUDED.buyins,
         cashouts = g.cashouts + EXCLUDED.cashouts,
         winnings = g.winnings + EXCLUDED.winnings,
         last_at = GREATEST(g.last_at, EXCLUDED.last_at);

  WITH early AS (SELECT * FROM ca_ct_seed_hands WHERE part = 0), parts AS (
    SELECT h.club, p_day - 1 AS d, h.game, h.hands FROM early h WHERE h.hands > 0
    UNION ALL
    SELECT h.club, p_day, h.game, h.hands FROM ca_ct_seed_hands h WHERE h.part = 1 AND h.hands > 0
    UNION ALL
    SELECT c.club_id, p_day, c.table_id, c.hands - COALESCE(h.hands, 0)
      FROM public.club_table_daily c
      LEFT JOIN early h ON h.club = c.club_id AND h.game = c.table_id
     WHERE c.stat_date = p_day AND p_day < v_live_day AND c.hands - COALESCE(h.hands, 0) > 0
  ), put AS (
    INSERT INTO public.ca_club_data_hands_ct AS t (club_id, stat_date, table_id, hands, src)
    SELECT club, d, game, hands, 1 FROM parts
    ON CONFLICT (club_id, stat_date, table_id, src) DO UPDATE SET hands = t.hands + EXCLUDED.hands
    RETURNING 1
  )
  SELECT count(*) INTO v_hand_rows FROM put;

  INSERT INTO public.ca_club_data_ct_seed_log (utc_day, rows_put, hand_rows) VALUES (p_day, v_rows, v_hand_rows);
  RETURN jsonb_build_object('utc_day', p_day, 'rows', v_rows, 'hand_rows', v_hand_rows,
                            'unmatched_slice_keys', v_bad, 'bounded_slice_keys', v_bounded,
                            'chicago_midnight', v_b, 'cutover', v_live);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_ct_seed(date) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
