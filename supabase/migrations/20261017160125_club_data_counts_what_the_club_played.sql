-- 20261017160125_club_data_counts_what_the_club_played.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Dan 2026-10-17, on Club JAQK's Club Data screen: "THERE IS NO SHOT THIS IS
-- CORRECT DATA FOR THE ENTIRE CLUB WITH ONLY 5 GAMES ... CLUB OWNERS SEE
-- EVERYTHING, AGENTS SEE THERE GENERATED STATS + DOWNLINES, REGULAR PLAYER
-- ACCOUNTS DONT SEE THE DATA BUTTON OR PAGES. MAKE SURE THAT THIS IS ACCURATE
-- REAL TIME DATA AT ALL TIMES." Then: "FINISH ALL OF THESE UP".
--
-- Read from production at 2026-10-17 03:30 UTC (1 Day view, 03:25 UTC):
--
--   screen:  5 games, -406.26 winnings, 132.71 fee, 0 MTT.
--   ledger:  Club JAQK players had bought into 2,683 tournaments (4,227
--            entries) through Club JAQK, and generated 13,182.27 of cash rake
--            on 96 Midway Union tables, in the same 3.5 hours.
--
-- THE CAUSE. Every Club Data fact (club_table_daily, ca_club_tournament_daily,
-- the felt) decided a union player's club with a GUESS: "the player's earliest
-- joined club in this union" (fn_ca_cash_reporting_club and its copies). All
-- 585 Club JAQK members are also SHARK CLUB members, and joined SHARK first.
-- So every chip they moved through Club JAQK was reported as SHARK CLUB's.
--
-- 20261017105645 (PR #7262, applied 11:10 UTC) replaced that guess with a
-- different one: "the club of the player's most recently joined seat at ANY
-- table". Read from production at 15:55 UTC that day: 150 players were seated
-- at more than one cash table and 63 in two or more clubs, so a hand at one
-- table was credited to the club of whichever seat the player took last; the
-- union was no longer consulted at all, so a hand at one of the 42 open
-- non-union tables could be credited to a different club entirely. Club JAQK
-- showed 86 cash tables where its seats had played 133. It also left every day
-- before the fix as it was (October 16: 41 games, 1,250.32 fee; September 20:
-- 7 games, 158.97) and never touched tournaments (1.10 of tournament fee for
-- the whole of October 17).
--
-- The platform never had to guess. The club a chip moved through is recorded
-- with the money, every time:
--   * chip_ledger.club_id on every wallet leg (the balance UPDATE writes the
--     ledger row before the wallet_transactions row, in the same transaction:
--     1,169 of 1,169 cash and 2,685 of 2,685 tournament wallet rows matched);
--   * table_seats.club_id on the seat that played the hand AT THAT TABLE
--     (agrees with rake_attributions.club_id on every one of 2,271
--     contributions read);
--   * tournament_players.club_id on the entry (agrees with the ledger on
--     2,685 of 2,685).
--
-- THE FIX.
--
-- 1. fn_ca_cash_reporting_club goes back to never leaving the union it was
--    asked about (its pre-#7262 body, the last resort only), and gains a
--    table-aware sibling, fn_ca_cash_table_reporting_club(union, table club,
--    user, table), that reads the player's seat AT THAT TABLE first. Its two callers
--    pass the table: fn_ca_club_table_daily_add_rake (club_table_daily, which
--    the advanced report reads) and fn_ca_club_cash_felt (which reads the seat
--    it is already looking at).
--
-- 2. One fact table, ca_club_data_fact, one row per club, UTC day, game and
--    PLAYER, written by its own insert triggers on rake_records and
--    wallet_transactions in the transaction that moves the money, with the
--    club read from those records. Per player, because an agent's view is his
--    own and his downline's games, which a per-club total cannot answer.
--    Cash and tournaments alike.
--
-- 3. ca_club_data_screen reads it, scoped by who is asking
--    (fn_ca_club_data_scope, which the footer asks too):
--      owner / co-owner / admin / club owner / platform admin -> the whole club;
--      agent / sub agent / super agent -> themselves and their downline;
--      anyone else -> refused (42501), so a player never sees the page.
--
-- CUTOVER WITHOUT A GAP OR A DOUBLE COUNT. The triggers write only rows created
-- at or after ca_club_data_fact_state.live_from (this migration's time plus
-- three minutes). fn_ca_club_data_fact_seed fills everything before it from
-- 2026-09-16, once per chunk of a day or less (the seed log refuses an
-- overlapping chunk), and refuses to run until live_from has passed. No lock is
-- taken on any money table beyond the moment CREATE TRIGGER needs, which is
-- the last statement before COMMIT.
--
-- Nothing here is scheduled, and nothing repairs anything: the seed is the
-- one-time history load of a new table, run by hand one day at a time.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The fact table and its cutover state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_club_data_fact (
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
  PRIMARY KEY (club_id, stat_date, game_id, user_id)
);
ALTER TABLE public.ca_club_data_fact ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_fact FROM anon, authenticated;
COMMENT ON TABLE public.ca_club_data_fact IS
  'Club Data: one row per club, UTC day, game (cash table or tournament) and player. The club is the one the money moved through (chip_ledger / table_seats / tournament_players), never a guess. user_id 00000000-0000-0000-0000-000000000000 holds rake from a hand that named no contributor. Written by trg_ca_club_data_fact_rake / _wallet and, before live_from, fn_ca_club_data_fact_seed. Read by ca_club_data_screen.';

CREATE TABLE IF NOT EXISTS public.ca_club_data_fact_state (
  id        boolean     PRIMARY KEY DEFAULT true CHECK (id),
  live_from timestamptz NOT NULL
);
ALTER TABLE public.ca_club_data_fact_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_fact_state FROM anon, authenticated;
INSERT INTO public.ca_club_data_fact_state (id, live_from)
VALUES (true, date_trunc('second', now()) + interval '3 minutes')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ca_club_data_fact_seed_log (
  from_at   timestamptz NOT NULL,
  to_at     timestamptz NOT NULL,
  rows_put  bigint      NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_at),
  CHECK (to_at > from_at)
);
ALTER TABLE public.ca_club_data_fact_seed_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_data_fact_seed_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_fact_live_from()
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.live_from FROM public.ca_club_data_fact_state s WHERE s.id;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_fact_live_from() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Which club the money moved through. Read, never guessed; the old guess
--    is only the last resort for a row that carries no club at all.
-- ---------------------------------------------------------------------------

-- The ledger leg written beside a wallet row: same transaction (same now()),
-- same player, same amount, same direction.
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_leg_club(
  p_user uuid, p_amount numeric, p_type text, p_at timestamptz, p_table uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_club uuid;
BEGIN
  IF p_user IS NULL OR p_amount IS NULL OR p_at IS NULL THEN RETURN NULL; END IF;
  IF p_type = 'debit' THEN
    SELECT cl.club_id INTO v_club FROM public.chip_ledger cl
     WHERE cl.from_entity_id = p_user AND cl.created_at = p_at
       AND cl.from_type = 'player_wallet' AND cl.amount = p_amount AND cl.club_id IS NOT NULL
       AND (p_table IS NULL OR cl.table_id IS NULL OR cl.table_id = p_table)
     ORDER BY (cl.table_id IS NOT DISTINCT FROM p_table) DESC LIMIT 1;
  ELSIF p_type = 'credit' THEN
    SELECT cl.club_id INTO v_club FROM public.chip_ledger cl
     WHERE cl.to_entity_id = p_user AND cl.created_at = p_at
       AND cl.to_type = 'player_wallet' AND cl.amount = p_amount AND cl.club_id IS NOT NULL
       AND (p_table IS NULL OR cl.table_id IS NULL OR cl.table_id = p_table)
     ORDER BY (cl.table_id IS NOT DISTINCT FROM p_table) DESC LIMIT 1;
  END IF;
  RETURN v_club;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_leg_club(uuid, numeric, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;

-- The club a cash seat was bought in through: the live seat, else the buy-in
-- receipt that funded the latest seat at this table.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_seat_club(p_table uuid, p_user uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT s.club_id FROM public.table_seats s
      WHERE s.table_id = p_table AND s.user_id = p_user AND s.left_at IS NULL
        AND s.club_id IS NOT NULL LIMIT 1),
    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
      WHERE x.operation_kind = 'buyin' AND x.table_id = p_table AND x.account_entity_id = p_user
      ORDER BY x.seat_joined_at DESC NULLS LAST LIMIT 1));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_seat_club(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The last resort, restored: the player's earliest-joined club IN THIS UNION,
-- else the table's own club. Never another union, never another table's seat.
-- (Its pre-20261017105645 body, verbatim.)
CREATE OR REPLACE FUNCTION public.fn_ca_cash_reporting_club(p_union uuid, p_table_club uuid, p_user uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT cm.club_id FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union
     WHERE p_union IS NOT NULL AND p_user IS NOT NULL AND cm.user_id = p_user
     ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
     LIMIT 1), p_table_club);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_reporting_club(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The table-aware form: the seat this player bought in through AT THIS TABLE,
-- and only when there is none, the last resort above.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_table_reporting_club(p_union uuid, p_table_club uuid, p_user uuid, p_table uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    CASE WHEN p_table IS NOT NULL AND p_user IS NOT NULL THEN public.fn_ca_cash_seat_club(p_table, p_user) END,
    public.fn_ca_cash_reporting_club(p_union, p_table_club, p_user));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_table_reporting_club(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- club_table_daily (the advanced report): each contributor's share to the club
-- of their seat at THIS table. Only the club lookup changes.
CREATE OR REPLACE FUNCTION public.fn_ca_club_table_daily_add_rake(p_table uuid, p_rake numeric, p_at timestamp with time zone, p_contrib jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_union uuid; v_table_club uuid; v_tourn uuid; v_found boolean;
  v_day date := (p_at AT TIME ZONE 'UTC')::date;
  r record; v_new int;
BEGIN
  SELECT t.union_id, t.club_id, t.tournament_id, true
    INTO v_union, v_table_club, v_tourn, v_found
    FROM public.tables t WHERE t.id = p_table;
  IF v_found IS NOT TRUE OR v_tourn IS NOT NULL OR COALESCE(p_rake, 0) <= 0 THEN RETURN; END IF;

  FOR r IN
    WITH e AS (
      SELECT x.key AS uid,
             CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END AS contrib
        FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_contrib) = 'object' THEN p_contrib ELSE '{}'::jsonb END) x
       WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ), usable AS (
      SELECT EXISTS (SELECT 1 FROM e WHERE e.contrib > 0) AS ok
    ), rr AS (
      SELECT e.uid, e.contrib, SUM(e.contrib) OVER () AS tot FROM e, usable WHERE usable.ok
      UNION ALL
      SELECT NULL::text, 1::numeric, 1::numeric FROM usable WHERE NOT usable.ok
    )
    SELECT CASE WHEN rr.uid IS NULL THEN v_table_club
                ELSE public.fn_ca_cash_table_reporting_club(v_union, v_table_club, rr.uid::uuid, p_table) END AS club_id,
           SUM(p_rake * rr.contrib / rr.tot) AS rake,
           COUNT(*) AS src,
           array_agg(DISTINCT rr.uid) FILTER (WHERE rr.uid IS NOT NULL) AS uids
      FROM rr WHERE rr.tot > 0
     GROUP BY 1 ORDER BY 1
  LOOP
    CONTINUE WHEN r.club_id IS NULL;
    CONTINUE WHEN public.fn_ca_launch_accounting_accepts(r.club_id, p_at) IS NOT TRUE;
    v_new := 0;
    IF r.uids IS NOT NULL THEN
      WITH ins AS (
        INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
        SELECT r.club_id, p_table, v_day, u::uuid FROM unnest(r.uids) u
        ON CONFLICT DO NOTHING RETURNING 1)
      SELECT count(*) INTO v_new FROM ins;
    END IF;
    INSERT INTO public.club_table_daily AS d
      (club_id, table_id, stat_date, union_id, rake, hands, players,
       buyins, cashouts, net, source_rows, updated_at)
    VALUES (r.club_id, p_table, v_day, v_union, r.rake, 1, v_new, 0, 0, 0, r.src, now())
    ON CONFLICT (club_id, table_id, stat_date) DO UPDATE
       SET rake = d.rake + EXCLUDED.rake,
           hands = d.hands + 1,
           players = d.players + EXCLUDED.players,
           source_rows = d.source_rows + EXCLUDED.source_rows,
           union_id = COALESCE(d.union_id, EXCLUDED.union_id),
           updated_at = now();
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_table_daily_add_rake(uuid, numeric, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_table_daily_add_rake(uuid, numeric, timestamptz, jsonb) TO service_role;

-- The felt (the advanced report): the seat it is looking at already says
-- which club it was bought in through.
CREATE OR REPLACE FUNCTION public.fn_ca_club_cash_felt(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
RETURNS TABLE(table_id uuid, felt numeric, seated integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH f AS (
    SELECT UPPER(COALESCE(NULLIF(p_game,''),'ALL')) g,
           UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) s,
           NULLIF(btrim(COALESCE(p_search,'')),'') q
  )
  SELECT s.table_id, SUM(s.stack), COUNT(*)::int
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
    LEFT JOIN public.profiles pr ON pr.id = t.created_by
    CROSS JOIN f
   WHERE s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND COALESCE(s.status, 'active') <> 'left'
     AND COALESCE(s.stack, 0) > 0
     AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
     AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = p_club_id
     AND public.fn_ca_launch_accounting_accepts(p_club_id, s.joined_at) IS TRUE
     AND (f.g = 'ALL' OR f.g = CASE
           WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
           WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
           ELSE 'HOLDEM' END)
     AND (f.s = 'ALL' OR f.s = CASE
           WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
           WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
           WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END)
     AND (f.q IS NULL OR COALESCE(t.name,'Unnamed') ILIKE '%'||f.q||'%'
          OR t.id::text ILIKE '%'||f.q||'%' OR COALESCE(pr.username,'') ILIKE '%'||f.q||'%')
   GROUP BY s.table_id;
$function$;
-- Its grants as production holds them (postgres and service_role only).
REVOKE ALL ON FUNCTION public.fn_ca_club_cash_felt(uuid, date, date, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_cash_felt(uuid, date, date, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The one writer. Additive, so concurrent writers and seed chunks merge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_fact_put(
  p_club uuid, p_day date, p_kind text, p_game uuid, p_user uuid,
  p_fee numeric, p_buyins numeric, p_cashouts numeric, p_winnings numeric, p_at timestamptz)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
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
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_fact_put(uuid, date, text, uuid, uuid, numeric, numeric, numeric, numeric, timestamptz) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The live writers: their own triggers, their own failure handling. A
--    reporting failure warns and never touches the money transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_ca_club_data_fact_rake()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day date; v_union uuid; v_table_club uuid; v_tourn uuid; v_found boolean;
  v_uid uuid; v_club uuid; v_n numeric; r record; v_any boolean := false;
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
    END LOOP;
    -- A raked hand that named nobody is the table's club's rake, whole.
    IF NOT v_any AND v_table_club IS NOT NULL
       AND public.fn_ca_launch_accounting_accepts(v_table_club, NEW.created_at) IS TRUE THEN
      PERFORM public.fn_ca_club_data_fact_put(v_table_club, v_day, 'CASH', NEW.table_id, NULL,
                                              NEW.rake_amount, 0, 0, 0, NEW.created_at);
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
$$;
REVOKE ALL ON FUNCTION public.trg_ca_club_data_fact_rake() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_ca_club_data_fact_wallet()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day date; v_union uuid; v_owner_club uuid; v_tourn uuid; v_found boolean;
  v_club uuid; v_in numeric; v_out numeric;
BEGIN
  -- Most wallet rows are none of Club Data's business; leave before any read.
  IF NOT ((NEW.table_id IS NOT NULL AND NEW.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund'))
       OR (NEW.table_id IS NULL AND NEW.related_entity_id IS NOT NULL
           AND NEW.category IN ('tournament_buyin', 'prize', 'bounty', 'addon', 'rebuy', 'refund', 'prize_reversal'))) THEN
    RETURN NULL;
  END IF;
  IF NEW.created_at < public.fn_ca_club_data_fact_live_from() THEN RETURN NULL; END IF;
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;
  v_in  := CASE WHEN NEW.type = 'debit'  THEN NEW.amount ELSE 0 END;
  v_out := CASE WHEN NEW.type = 'credit' THEN NEW.amount ELSE 0 END;

  IF NEW.table_id IS NOT NULL AND NEW.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund') THEN
    SELECT t.union_id, t.club_id, t.tournament_id, true
      INTO v_union, v_owner_club, v_tourn, v_found
      FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_found IS NOT TRUE OR v_tourn IS NOT NULL THEN RETURN NULL; END IF;
    v_club := COALESCE(
      public.fn_ca_ledger_leg_club(NEW.user_id, NEW.amount, NEW.type, NEW.created_at, NEW.table_id),
      public.fn_ca_cash_seat_club(NEW.table_id, NEW.user_id),
      public.fn_ca_cash_reporting_club(v_union, v_owner_club, NEW.user_id));
    IF v_club IS NULL OR public.fn_ca_launch_accounting_accepts(v_club, NEW.created_at) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
    PERFORM public.fn_ca_club_data_fact_put(v_club, v_day, 'CASH', NEW.table_id, NEW.user_id,
                                            0, v_in, v_out, v_out - v_in, NEW.created_at);

  ELSIF NEW.table_id IS NULL AND NEW.related_entity_id IS NOT NULL
        AND NEW.category IN ('tournament_buyin', 'prize', 'bounty', 'addon', 'rebuy', 'refund', 'prize_reversal') THEN
    SELECT tr.union_id, tr.club_id, true INTO v_union, v_owner_club, v_found
      FROM public.tournaments tr WHERE tr.id = NEW.related_entity_id;
    IF v_found IS NOT TRUE THEN RETURN NULL; END IF;
    SELECT tp.club_id INTO v_club FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.related_entity_id AND tp.user_id = NEW.user_id;
    v_club := COALESCE(
      v_club,
      public.fn_ca_ledger_leg_club(NEW.user_id, NEW.amount, NEW.type, NEW.created_at, NULL),
      public.fn_ca_cash_reporting_club(v_union, v_owner_club, NEW.user_id));
    IF v_club IS NULL OR public.fn_ca_launch_accounting_accepts(v_club, NEW.created_at) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
    PERFORM public.fn_ca_club_data_fact_put(v_club, v_day, 'TOURNAMENT', NEW.related_entity_id, NEW.user_id,
                                            0, v_in, v_out, v_out - v_in, NEW.created_at);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data fact (wallet) failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_ca_club_data_fact_wallet() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The seed: everything before live_from, set-based, read from the same
--    records the triggers read (plus rake_attributions, which is written after
--    the hand and so is only available to a reader looking back). One chunk at
--    a time; an overlapping chunk is refused, so nothing is counted twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_fact_seed(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_live timestamptz := public.fn_ca_club_data_fact_live_from();
  v_to timestamptz := LEAST(p_to, v_live);
  v_rows bigint := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR v_to <= p_from THEN
    RAISE EXCEPTION 'seed needs a window that ends after it starts and before live_from (%)', v_live;
  END IF;
  IF now() < v_live + interval '1 minute' THEN
    RAISE EXCEPTION 'seed waits until a minute after live_from (%), so every row before it has committed', v_live;
  END IF;
  IF v_to - p_from > interval '1 day' THEN
    RAISE EXCEPTION 'seed one day or less at a time';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_club_data_fact_seed_log l
              WHERE l.from_at < v_to AND l.to_at > p_from) THEN
    RAISE EXCEPTION 'this window overlaps one already seeded';
  END IF;

  WITH cash_c AS (
    SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id AS table_club,
           e.key::uuid AS uid, (CASE WHEN e.value ~ '^[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) AS contrib
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                              THEN r.player_contributions ELSE '{}'::jsonb END) e
     WHERE r.created_at >= p_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.tournament_id IS NULL AND NOT COALESCE(r.is_tournament, false)
       AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (CASE WHEN e.value ~ '^[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0
  ), cash_s AS (
    SELECT c.*, SUM(c.contrib) OVER (PARTITION BY c.id) AS tot FROM cash_c c
  ), cash_rake AS (
    SELECT COALESCE(ra.club_id, rc.club, st.club,
                    public.fn_ca_cash_reporting_club(s.union_id, s.table_club, s.uid)) AS club_id,
           (s.created_at AT TIME ZONE 'UTC')::date AS stat_date, 'CASH'::text AS kind,
           s.table_id AS game_id, s.uid AS user_id,
           s.rake_amount * s.contrib / s.tot AS fee, 0::numeric AS buyins, 0::numeric AS cashouts,
           0::numeric AS winnings, s.created_at AS at
      FROM cash_s s
      LEFT JOIN public.rake_attributions ra ON ra.rake_record_id = s.id AND ra.player_id = s.uid
      LEFT JOIN LATERAL (
        SELECT x.funding_club_id AS club FROM public.cash_participant_funding_receipts x
         WHERE ra.club_id IS NULL AND x.operation_kind = 'buyin' AND x.table_id = s.table_id
           AND x.account_entity_id = s.uid AND x.seat_joined_at <= s.created_at
         ORDER BY x.seat_joined_at DESC LIMIT 1) rc ON true
      LEFT JOIN LATERAL (
        SELECT ts.club_id AS club FROM public.table_seats ts
         WHERE ra.club_id IS NULL AND rc.club IS NULL AND ts.table_id = s.table_id
           AND ts.user_id = s.uid AND ts.club_id IS NOT NULL AND ts.joined_at <= s.created_at
         ORDER BY ts.joined_at DESC LIMIT 1) st ON true
  ), cash_unnamed AS (
    SELECT t.club_id, (r.created_at AT TIME ZONE 'UTC')::date, 'CASH'::text, r.table_id,
           '00000000-0000-0000-0000-000000000000'::uuid, r.rake_amount, 0::numeric, 0::numeric,
           0::numeric, r.created_at
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= p_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.tournament_id IS NULL AND NOT COALESCE(r.is_tournament, false)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                            THEN r.player_contributions ELSE '{}'::jsonb END) e
          WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN e.value ~ '^[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
  ), tour_named AS (
    SELECT COALESCE(tp.club_id, public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, (r.metadata->>'user_id')::uuid)),
           (r.created_at AT TIME ZONE 'UTC')::date, 'TOURNAMENT'::text, r.tournament_id,
           (r.metadata->>'user_id')::uuid, r.rake_amount, 0::numeric, 0::numeric, 0::numeric, r.created_at
      FROM public.rake_records r
      LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = r.tournament_id AND tp.user_id::text = r.metadata->>'user_id'
     WHERE r.created_at >= p_from AND r.created_at < v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND (r.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), tour_split AS (
    SELECT COALESCE(tp.club_id, public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, tp.user_id)),
           (r.created_at AT TIME ZONE 'UTC')::date, 'TOURNAMENT'::text, r.tournament_id,
           tp.user_id, r.rake_amount / n.n, 0::numeric, 0::numeric, 0::numeric, r.created_at
      FROM public.rake_records r
      LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
      JOIN LATERAL (SELECT count(*)::numeric AS n FROM public.tournament_players x
                     WHERE x.tournament_id = r.tournament_id) n ON n.n > 0
      JOIN public.tournament_players tp ON tp.tournament_id = r.tournament_id
     WHERE r.created_at >= p_from AND r.created_at < v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND NOT ((r.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
         IS TRUE
  ), wal AS (
    SELECT w.id, w.user_id, w.amount, w.type, w.created_at, w.table_id, w.related_entity_id,
           CASE WHEN w.table_id IS NOT NULL THEN 'CASH' ELSE 'TOURNAMENT' END AS kind
      FROM public.wallet_transactions w
     WHERE w.created_at >= p_from AND w.created_at < v_to
       AND ((w.table_id IS NOT NULL AND w.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund'))
         OR (w.table_id IS NULL AND w.related_entity_id IS NOT NULL
             AND w.category IN ('tournament_buyin', 'prize', 'bounty', 'addon', 'rebuy', 'refund', 'prize_reversal')))
  ), wal_cash AS (
    SELECT COALESCE(public.fn_ca_ledger_leg_club(w.user_id, w.amount, w.type, w.created_at, w.table_id),
                    rc.club,
                    public.fn_ca_cash_reporting_club(t.union_id, t.club_id, w.user_id)),
           (w.created_at AT TIME ZONE 'UTC')::date, 'CASH'::text, w.table_id, w.user_id, 0::numeric,
           CASE WHEN w.type = 'debit' THEN w.amount ELSE 0 END,
           CASE WHEN w.type = 'credit' THEN w.amount ELSE 0 END,
           CASE WHEN w.type = 'credit' THEN w.amount WHEN w.type = 'debit' THEN -w.amount ELSE 0 END,
           w.created_at
      FROM wal w
      JOIN public.tables t ON t.id = w.table_id AND t.tournament_id IS NULL
      LEFT JOIN LATERAL (
        SELECT x.funding_club_id AS club FROM public.cash_participant_funding_receipts x
         WHERE x.operation_kind = 'buyin' AND x.table_id = w.table_id AND x.account_entity_id = w.user_id
           AND x.seat_joined_at <= w.created_at
         ORDER BY x.seat_joined_at DESC LIMIT 1) rc ON true
     WHERE w.kind = 'CASH'
  ), wal_tour AS (
    SELECT COALESCE(tp.club_id,
                    public.fn_ca_ledger_leg_club(w.user_id, w.amount, w.type, w.created_at, NULL),
                    public.fn_ca_cash_reporting_club(tr.union_id, tr.club_id, w.user_id)),
           (w.created_at AT TIME ZONE 'UTC')::date, 'TOURNAMENT'::text, w.related_entity_id, w.user_id,
           0::numeric,
           CASE WHEN w.type = 'debit' THEN w.amount ELSE 0 END,
           CASE WHEN w.type = 'credit' THEN w.amount ELSE 0 END,
           CASE WHEN w.type = 'credit' THEN w.amount WHEN w.type = 'debit' THEN -w.amount ELSE 0 END,
           w.created_at
      FROM wal w
      JOIN public.tournaments tr ON tr.id = w.related_entity_id
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = w.related_entity_id AND tp.user_id = w.user_id
     WHERE w.kind = 'TOURNAMENT'
  ), all_facts (club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, at) AS (
    SELECT * FROM cash_rake
    UNION ALL SELECT * FROM cash_unnamed
    UNION ALL SELECT * FROM tour_named
    UNION ALL SELECT * FROM tour_split
    UNION ALL SELECT * FROM wal_cash
    UNION ALL SELECT * FROM wal_tour
  ), accepted AS (
    SELECT a.* FROM all_facts a
     WHERE a.club_id IS NOT NULL AND a.user_id IS NOT NULL
       AND public.fn_ca_launch_accounting_accepts(a.club_id, a.at) IS TRUE
  ), grouped AS (
    SELECT club_id, stat_date, min(kind) AS kind, game_id, user_id,
           SUM(fee) AS fee, SUM(buyins) AS buyins, SUM(cashouts) AS cashouts,
           SUM(winnings) AS winnings, max(at) AS last_at
      FROM accepted GROUP BY club_id, stat_date, game_id, user_id
  ), put AS (
    INSERT INTO public.ca_club_data_fact AS f
      (club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, last_at)
    SELECT club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings, last_at FROM grouped
    ON CONFLICT (club_id, stat_date, game_id, user_id) DO UPDATE
       SET fee = f.fee + EXCLUDED.fee,
           buyins = f.buyins + EXCLUDED.buyins,
           cashouts = f.cashouts + EXCLUDED.cashouts,
           winnings = f.winnings + EXCLUDED.winnings,
           last_at = GREATEST(f.last_at, EXCLUDED.last_at)
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM put;

  INSERT INTO public.ca_club_data_fact_seed_log (from_at, to_at, rows_put) VALUES (p_from, v_to, v_rows);
  RETURN jsonb_build_object('from', p_from, 'to', v_to, 'rows', v_rows, 'live_from', v_live);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_fact_seed(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Who may see what.
-- ---------------------------------------------------------------------------
-- 'club' for the club's owner, co-owner and admins (and platform admins and
-- the service); 'downline' for its agents of every rank; NULL for anyone else.
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_scope(p_club_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN session_user IN ('postgres', 'supabase_admin')
      OR COALESCE(auth.role(), '') = 'service_role' THEN 'club'
    WHEN auth.uid() IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND COALESCE(pr.is_admin, false))
      THEN 'club'
    WHEN EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND COALESCE(cm.status, 'active') NOT IN ('banned', 'suspended')
         AND cm.role IN ('owner', 'co_owner', 'admin')
         AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)) THEN 'club'
    WHEN EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND COALESCE(cm.status, 'active') NOT IN ('banned', 'suspended')
         AND cm.role IN ('super_agent', 'agent', 'sub_agent')
         AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)) THEN 'downline'
    ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_data_scope(uuid) TO authenticated, service_role;

-- An agent and everyone under them in this club, at any depth.
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_downline(p_club_id uuid, p_user uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
  ), tree AS (
    SELECT p_user AS uid, 0 AS depth WHERE p_user IS NOT NULL
    UNION
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.uid WHERE t.depth < 20
  )
  SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::uuid[]) FROM tree;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_downline(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. The screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_data_screen(
  p_club_id uuid, p_start date DEFAULT NULL, p_end date DEFAULT NULL,
  p_game text DEFAULT 'ALL', p_stakes text DEFAULT 'ALL',
  p_search text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end);
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_scope text := public.fn_ca_club_data_scope(p_club_id);
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
  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;
  SELECT cm.role INTO v_role FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
  SELECT (min(l.from_at) AT TIME ZONE 'UTC')::date INTO v_facts_from FROM public.ca_club_data_fact_seed_log l;
  v_facts_from := COALESCE(v_facts_from, (public.fn_ca_club_data_fact_live_from() AT TIME ZONE 'UTC')::date);

  WITH f AS (
    SELECT d.kind, d.game_id, d.user_id, d.fee, d.winnings, d.last_at
      FROM public.ca_club_data_fact d
     WHERE d.club_id = p_club_id AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users))
  ), g AS (
    SELECT f.kind, f.game_id, SUM(f.fee) AS fee, SUM(f.winnings) AS winnings,
           count(DISTINCT f.user_id) FILTER (WHERE f.user_id <> '00000000-0000-0000-0000-000000000000'::uuid) AS players,
           max(f.last_at) AS activity_at
      FROM f GROUP BY f.kind, f.game_id
  ), felt AS (
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
     GROUP BY s.table_id
  ), cash AS (
    SELECT 'CASH'::text AS kind, t.id::text AS id, COALESCE(t.name, 'Unnamed') AS name,
           UPPER(COALESCE(t.game_variant, 'nlh')) AS variant,
           CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                ELSE 'HOLDEM' END AS game_class,
           CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           CASE WHEN COALESCE(t.big_blind,0) > 0 THEN
             trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
             trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
           t.created_at AS started_at, t.status, COALESCE(pr.username, '') AS creator_name,
           round(COALESCE(g.fee, 0), 2) AS fee,
           round(COALESCE(g.winnings, 0) + COALESCE(fe.felt, 0), 2) AS winnings,
           GREATEST(COALESCE(g.players, 0), COALESCE(fe.seated, 0))::int AS players,
           COALESCE(g.activity_at, now()) AS activity_at,
           (fe.felt IS NOT NULL) AS live,
           fe.seated, round(fe.felt, 2) AS on_felt
      FROM (SELECT gg.* FROM g gg WHERE gg.kind = 'CASH') g
      FULL JOIN felt fe ON fe.table_id = g.game_id
      JOIN public.tables t ON t.id = COALESCE(g.game_id, fe.table_id)
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
  ), tour AS (
    SELECT CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS kind,
           tr.id::text AS id, COALESCE(tr.name, 'Tournament') AS name,
           UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) AS variant,
           CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS game_class,
           'NA'::text AS stakes_tier, NULL::text AS blinds,
           tr.start_time AS started_at, tr.status, ''::text AS creator_name,
           round(g.fee, 2) AS fee, round(g.winnings, 2) AS winnings,
           g.players::int AS players, g.activity_at,
           (tr.status = 'RUNNING') AS live,
           NULL::int AS seated, NULL::numeric AS on_felt
      FROM g JOIN public.tournaments tr ON tr.id = g.game_id
     WHERE g.kind = 'TOURNAMENT'
  ), all_rows AS (
    SELECT * FROM cash UNION ALL SELECT * FROM tour
  ), filtered AS (
    SELECT * FROM all_rows r
     WHERE (v_game = 'ALL' OR r.game_class = v_game)
       AND (v_stakes = 'ALL' OR r.stakes_tier = v_stakes)
       AND (v_q IS NULL OR r.name ILIKE '%' || v_q || '%' OR r.id ILIKE '%' || v_q || '%'
            OR r.creator_name ILIKE '%' || v_q || '%')
  ), summary AS (
    SELECT jsonb_build_object(
      'games', count(*),
      'total_winnings', round(COALESCE(SUM(winnings), 0), 2),
      'mtt_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE kind <> 'CASH'), 0), 2),
      'cash_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE kind = 'CASH'), 0), 2),
      'fee', round(COALESCE(SUM(fee), 0), 2),
      'cash_fee', round(COALESCE(SUM(fee) FILTER (WHERE kind = 'CASH'), 0), 2),
      'mtt_fee', round(COALESCE(SUM(fee) FILTER (WHERE kind <> 'CASH'), 0), 2),
      'on_felt', round(COALESCE(SUM(on_felt), 0), 2),
      'live_games', count(*) FILTER (WHERE live)) AS s
      FROM filtered
  ), ranked AS (
    SELECT * FROM filtered ORDER BY live DESC, activity_at DESC NULLS LAST, kind, id LIMIT v_lim
  )
  SELECT (SELECT s FROM summary),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind', kind, 'id', id, 'name', name, 'variant', variant,
           'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
           'started_at', started_at, 'activity_at', activity_at, 'status', status,
           'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
           'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
           'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY live DESC, activity_at DESC NULLS LAST, kind, id) FROM ranked), '[]'::jsonb)
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

-- ---------------------------------------------------------------------------
-- 8. The triggers, last, so the lock CREATE TRIGGER takes on each money table
--    is held for the moment it takes to commit, not for this whole migration.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS ca_club_data_fact_rake ON public.rake_records;
CREATE TRIGGER ca_club_data_fact_rake AFTER INSERT ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.trg_ca_club_data_fact_rake();

DROP TRIGGER IF EXISTS ca_club_data_fact_wallet ON public.wallet_transactions;
CREATE TRIGGER ca_club_data_fact_wallet AFTER INSERT ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_ca_club_data_fact_wallet();

COMMIT;
