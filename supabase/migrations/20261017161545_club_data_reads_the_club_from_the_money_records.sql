-- 20261017161545_club_data_reads_the_club_from_the_money_records.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-17: Club Data must be "ACCURATE REAL
-- TIME DATA AT ALL TIMES"):
--
-- 20261017105645 (#7262) left four things wrong, each read from production on
-- 2026-10-17 between 16:00 and 16:20 UTC:
--
--   1. The new club lookup, fn_ca_cash_reporting_club, credited a player's rake
--      to the club of the seat they took MOST RECENTLY AT ANY TABLE, not their
--      seat at the table where the hand was played, and it never looked at the
--      union. 150 players sat at more than one cash table, 63 of them seated
--      in two or more clubs, so their rake moved between clubs hand by hand.
--   2. Its header said the tournament club lookup was updated. Its SQL never
--      touched it: ca_reporting_tournament_clubs_for_user still credited every
--      union player's tournament fees and results to the FIRST club they ever
--      joined in the union. Every Club JAQK member joined SHARK CLUB first, so
--      JAQK's tournament fees for the day read 1.10.
--   3. Nothing re-counted a past day. club_table_daily for Club JAQK on
--      2026-10-16 read 41 games and 1,250.32 in fees; the money records for
--      that day hold 81,926.00 of cash rake taken for JAQK across 193 tables.
--   4. (client) the footer's Data button showed while the role was loading.
--
-- THE CLUB IS READ FROM THE MONEY RECORDS, NOT GUESSED FROM MEMBERSHIP.
-- The platform already records, at the moment the money moves, which club it
-- moved for:
--
--   * cash rake       rake_attributions: one row per player per raked hand,
--                     with the club the rake was taken for. Measured: equal to
--                     rake_records to the cent on 2026-09-20 (61,430.89) and
--                     2026-10-16 (165,952.61), every hand covered since
--                     2026-09-18.
--   * tournament fee  accounting_tournament_fee_sources: one row per entrant
--                     per fee, with the club the entry was paid from. Equal to
--                     rake_records to the cent on both days.
--   * cash buy-in/out chip_ledger: the leg that moved the chips between the
--                     player's club wallet and the table, written in the same
--                     transaction as the wallet row (11,068 of 11,068 cash
--                     wallet rows on 2026-10-16 have it, same instant).
--   * tournament P&L  tournament_players.club_id: the club the entry was paid
--                     from (agrees with the ledger buy-in leg on 16,482 of
--                     16,482 entries; never null since 2026-09-15).
--
-- Where a record is missing (cash hands of 2026-09-16/17, before attributions
-- were written; tournament fee REVERSALS, which never get a fee source), the
-- fallback is the player's seat AT THAT TABLE / their entry INTO THAT EVENT,
-- never their newest seat anywhere and never their first membership.
--
-- WHAT IS IN HERE
--   fn_ca_cash_hand_club            a player's club at ONE table at ONE moment
--   fn_ca_tournament_entry_club     a player's club in ONE event
--   fn_ca_club_data_tournament_fee_split  a fee with no fee source
--   fn_ca_club_data_stage / _publish      the one day computation every
--                                   rebuild uses; publish replaces only rows
--                                   that differ
--   fn_ca_club_data_rebuild_day     re-count one day (the live day holds the
--                                   reporting lock only for its last minutes)
--   live writers                    rake_attributions and fee-source insert
--                                   triggers; the wallet trigger; the rake
--                                   trigger keeps only fee reversals
--   fn_club_table_daily_refresh_day, fn_club_table_daily_catchup,
--   ca_refresh_reporting_rollups_base, ca_refresh_reporting_cash_rollup
--                                   the existing rebuild entry points, now
--                                   attributing exactly like the live writers
--   fn_ca_club_cash_felt            the seat's own club
--   fn_ca_cash_reporting_club       back to union-only (it is no longer used
--                                   by Club Data and must not leak across
--                                   tables for anything else)
--   ca_club_data_access             the screen's own access rule, for the
--                                   footer
--
-- Past days are re-counted one at a time after this applies, from 2026-09-16,
-- with fn_ca_club_data_rebuild_day (docs/changelog/2026-10-17-club-data-reads-
-- the-club-from-the-money-records.md records each day's result). That is the
-- damage settled once (CLAUDE.md 10.11 step 3), not a job.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Which club a player was playing for, at one table, at one moment
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_cash_hand_club(p_table uuid, p_user uuid, p_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_union uuid; v_table_club uuid; v_found boolean;
  v_club uuid; v_seat_club uuid; v_seat_at timestamptz; v_leg_club uuid; v_leg_at timestamptz;
BEGIN
  IF p_table IS NULL THEN RETURN NULL; END IF;
  SELECT t.union_id, t.club_id, true INTO v_union, v_table_club, v_found
    FROM public.tables t WHERE t.id = p_table;
  IF v_found IS NOT TRUE THEN RETURN NULL; END IF;
  -- A table outside a union has one club to take its money for.
  IF v_union IS NULL OR p_user IS NULL THEN RETURN v_table_club; END IF;

  -- (a) The chip movement itself: the leg that took these chips from the
  --     player's club wallet to this table, or brought them back, at this
  --     exact instant (the wallet row and its ledger leg share a transaction).
  IF p_at IS NOT NULL THEN
    SELECT cl.club_id INTO v_club FROM public.chip_ledger cl
     WHERE cl.from_entity_id = p_user AND cl.created_at = p_at AND cl.table_id = p_table
       AND cl.from_type = 'player_wallet' AND cl.to_type = 'table_stack' AND cl.club_id IS NOT NULL
     LIMIT 1;
    IF v_club IS NULL THEN
      SELECT cl.club_id INTO v_club FROM public.chip_ledger cl
       WHERE cl.to_entity_id = p_user AND cl.created_at = p_at AND cl.table_id = p_table
         AND cl.from_type = 'table_stack' AND cl.to_type = 'player_wallet' AND cl.club_id IS NOT NULL
       LIMIT 1;
    END IF;
    IF v_club IS NOT NULL AND EXISTS (SELECT 1 FROM public.union_clubs uc
                                       WHERE uc.union_id = v_union AND uc.club_id = v_club) THEN
      RETURN v_club;
    END IF;
  END IF;

  -- (b) The seat at THIS table, and (c) the last buy-in AT THIS TABLE, both no
  --     later than the moment asked about. The newer of the two wins: a
  --     Lightning player moved onto this table carries the seat, a player who
  --     bought in here and was later re-seated carries the buy-in.
  SELECT ts.club_id, ts.joined_at INTO v_seat_club, v_seat_at
    FROM public.table_seats ts
    JOIN public.union_clubs uc ON uc.club_id = ts.club_id AND uc.union_id = v_union
   WHERE ts.table_id = p_table AND ts.user_id = p_user
     AND (p_at IS NULL OR ts.joined_at <= p_at)
   ORDER BY ts.joined_at DESC NULLS LAST
   LIMIT 1;
  --     One probe per club of the union on idx_chip_ledger_risk_out_player_window
  --     (club, player, time over posted wallet-to-table legs), so a player with
  --     thousands of tournament legs costs the same as one with none.
  SELECT x.club_id, x.created_at INTO v_leg_club, v_leg_at
    FROM public.union_clubs uc
    CROSS JOIN LATERAL (
      SELECT cl.club_id, cl.created_at
        FROM public.chip_ledger cl
       WHERE cl.club_id = uc.club_id AND cl.from_entity_id = p_user
         AND cl.status = 'posted' AND cl.from_type = 'player_wallet' AND cl.to_type = 'table_stack'
         AND cl.created_at <= COALESCE(p_at, now())
         AND cl.created_at >= COALESCE(p_at, now()) - interval '3 days'
         AND cl.table_id = p_table
       ORDER BY cl.created_at DESC
       LIMIT 1) x
   WHERE uc.union_id = v_union
   ORDER BY x.created_at DESC
   LIMIT 1;
  IF v_seat_club IS NOT NULL AND (v_leg_club IS NULL OR v_seat_at >= v_leg_at) THEN
    RETURN v_seat_club;
  END IF;
  IF v_leg_club IS NOT NULL THEN RETURN v_leg_club; END IF;

  -- (d) Any seat this player holds or held at this table.
  SELECT ts.club_id INTO v_club
    FROM public.table_seats ts
    JOIN public.union_clubs uc ON uc.club_id = ts.club_id AND uc.union_id = v_union
   WHERE ts.table_id = p_table AND ts.user_id = p_user
   ORDER BY ts.joined_at DESC NULLS LAST
   LIMIT 1;
  IF v_club IS NOT NULL THEN RETURN v_club; END IF;

  -- (e) Nothing at this table recorded a club: their membership in this union.
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
    JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = v_union
   WHERE cm.user_id = p_user
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN COALESCE(v_club, v_table_club);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_hand_club(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_hand_club(uuid, uuid, timestamptz) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Which club a player entered one event from
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_entry_club(p_tournament uuid, p_user uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(
    (SELECT tp.club_id FROM public.tournament_players tp
      WHERE tp.tournament_id = p_tournament AND tp.user_id = p_user),
    (SELECT cl.club_id FROM public.chip_ledger cl
      WHERE cl.tournament_id = p_tournament AND cl.from_entity_id = p_user
        AND cl.from_type = 'player_wallet' AND cl.club_id IS NOT NULL
      ORDER BY cl.created_at LIMIT 1),
    (SELECT t.club_id FROM public.tournaments t
      WHERE t.id = p_tournament AND t.union_id IS NULL),
    (SELECT cm.club_id FROM public.tournaments t
       JOIN public.union_clubs uc ON uc.union_id = t.union_id
       JOIN public.club_members cm ON cm.club_id = uc.club_id AND cm.user_id = p_user
      WHERE t.id = p_tournament
      ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id LIMIT 1),
    (SELECT t.club_id FROM public.tournaments t WHERE t.id = p_tournament));
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_entry_club(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_entry_club(uuid, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A tournament fee with no fee source (2026-09-16/17, and every reversal):
--    the named player's entry club, else split by the entrants' entry clubs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_tournament_fee_split(p_record uuid)
RETURNS TABLE(club_id uuid, fee numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  WITH r AS (
    SELECT rr.id, rr.tournament_id, rr.created_at, rr.metadata, rr.rake_amount,
           CASE WHEN rr.metadata ? 'user_id'
                 AND (rr.metadata->>'user_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (rr.metadata->>'user_id')::uuid END AS named
      FROM public.rake_records rr
     WHERE rr.id = p_record AND rr.tournament_id IS NOT NULL AND COALESCE(rr.rake_amount, 0) <> 0
  ), shares AS (
    SELECT public.fn_ca_tournament_entry_club(r.tournament_id, r.named) AS club_id,
           r.rake_amount AS share
      FROM r WHERE r.named IS NOT NULL
    UNION ALL
    SELECT e.club_id, r.rake_amount * e.n / NULLIF(tot.n, 0)
      FROM r
      CROSS JOIN LATERAL (
        SELECT COALESCE(tp.club_id, public.fn_ca_tournament_entry_club(tp.tournament_id, tp.user_id)) AS club_id,
               count(*)::numeric AS n
          FROM public.tournament_players tp
         WHERE tp.tournament_id = r.tournament_id
         GROUP BY 1) e
      CROSS JOIN LATERAL (
        SELECT count(*)::numeric AS n FROM public.tournament_players tp
         WHERE tp.tournament_id = r.tournament_id) tot
     WHERE r.named IS NULL
  )
  SELECT s.club_id,
         public.fn_ca_launch_reporting_fee_credit(s.club_id, r.id, r.created_at, r.metadata,
                                                  r.rake_amount, SUM(s.share))
    FROM shares s CROSS JOIN r
   WHERE s.club_id IS NOT NULL
   GROUP BY s.club_id, r.id, r.created_at, r.metadata, r.rake_amount;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_tournament_fee_split(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_data_tournament_fee_split(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Stage: count [p_from, p_to) into this transaction's scratch tables.
--    Additive, so the live day can be counted in two parts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_stage(
  p_from timestamptz, p_to timestamptz, p_cash boolean DEFAULT true, p_players boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_num constant text := '^-?[0-9]+(\.[0-9]+)?$';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS cd_cash (club_id uuid, table_id uuid, union_id uuid, rake numeric,
    hands bigint, src bigint, buyins numeric, cashouts numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_cash_players (club_id uuid, table_id uuid, user_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_player (club_id uuid, user_id uuid, cash_net numeric,
    tournament_net numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_tour (club_id uuid, tournament_id uuid, fee numeric,
    winnings numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_tour_players (club_id uuid, tournament_id uuid, user_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_hand (club_id uuid, table_id uuid, union_id uuid, hand_id uuid,
    user_id uuid, rake numeric, at timestamptz) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_wallet_cash (user_id uuid, table_id uuid, union_id uuid, club_id uuid,
    at timestamptz, category text, type text, amount numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS cd_wallet_tour (user_id uuid, tournament_id uuid, club_id uuid,
    at timestamptz, category text, net numeric) ON COMMIT DROP;
  TRUNCATE pg_temp.cd_hand, pg_temp.cd_wallet_cash, pg_temp.cd_wallet_tour;

  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN RETURN; END IF;

  -- Cash table money in and out: the club whose wallet the chips left or
  -- returned to, read from the chip movement at that table.
  INSERT INTO pg_temp.cd_wallet_cash
  SELECT wt.user_id, wt.table_id, t.union_id,
         COALESCE(public.fn_ca_cash_hand_club(wt.table_id, wt.user_id, wt.created_at), t.club_id),
         wt.created_at, wt.category, wt.type, wt.amount
    FROM public.wallet_transactions wt
    JOIN public.tables t ON t.id = wt.table_id AND t.tournament_id IS NULL
   WHERE wt.created_at >= p_from AND wt.created_at < p_to
     AND wt.table_id IS NOT NULL
     AND wt.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund');
  -- A club under a launch-accounting boundary counts only what it accepts.
  DELETE FROM pg_temp.cd_wallet_cash w
   WHERE w.club_id IS NULL
      OR (EXISTS (SELECT 1 FROM public.ca_launch_accounting_boundaries b
                   WHERE b.scope_kind = 'club' AND b.scope_id = w.club_id AND b.undone_at IS NULL)
          AND public.fn_ca_launch_reporting_wallet_accepts(w.club_id, w.at, w.category, NULL, w.user_id) IS NOT TRUE);

  IF p_cash THEN
    -- (1) Every raked hand the accounting attributed: whose rake, for which club.
    --     An attribution naming no club, or (at a union table) a club outside
    --     the union, is read from the table instead.
    INSERT INTO pg_temp.cd_hand
    SELECT CASE WHEN a.club_id IS NOT NULL
                 AND (t.union_id IS NULL
                      OR EXISTS (SELECT 1 FROM public.union_clubs uc
                                  WHERE uc.union_id = t.union_id AND uc.club_id = a.club_id))
                THEN a.club_id
                ELSE COALESCE(public.fn_ca_cash_hand_club(r.table_id, a.player_id, r.created_at), t.club_id) END,
           r.table_id, t.union_id, r.id, a.player_id, a.rake_amount, r.created_at
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      JOIN public.rake_attributions a ON a.rake_record_id = r.id
     WHERE r.created_at >= p_from AND r.created_at < p_to
       AND r.rake_amount > 0 AND NOT COALESCE(r.is_tournament, false);

    -- (2) A raked hand the accounting never attributed (2026-09-16/17): split
    --     by contribution, each contributor's club read AT THAT TABLE; a hand
    --     with no usable contribution is the table club's, whole.
    WITH h AS MATERIALIZED (
      SELECT r.id, r.table_id, r.rake_amount, r.created_at, r.player_contributions,
             t.union_id, t.club_id AS table_club
        FROM public.rake_records r
        JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= p_from AND r.created_at < p_to
         AND r.rake_amount > 0 AND NOT COALESCE(r.is_tournament, false)
         AND NOT EXISTS (SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id = r.id)
    ), e AS MATERIALIZED (
      SELECT h.*, x.key::uuid AS uid,
             GREATEST(CASE WHEN x.value ~ c_num THEN x.value::numeric ELSE 0 END, 0) AS contrib
        FROM h
        CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(h.player_contributions) = 'object'
                                                THEN h.player_contributions ELSE '{}'::jsonb END) x
       WHERE x.key ~ c_uuid
    ), tot AS (
      SELECT e.id, SUM(e.contrib) AS tot FROM e GROUP BY e.id
    )
    INSERT INTO pg_temp.cd_hand
    SELECT COALESCE(public.fn_ca_cash_hand_club(e.table_id, e.uid, e.created_at), e.table_club),
           e.table_id, e.union_id, e.id, e.uid, e.rake_amount * e.contrib / tt.tot, e.created_at
      FROM e JOIN tot tt ON tt.id = e.id AND tt.tot > 0
    UNION ALL
    SELECT h.table_club, h.table_id, h.union_id, h.id, NULL::uuid, h.rake_amount, h.created_at
      FROM h
     WHERE NOT EXISTS (SELECT 1 FROM tot tt WHERE tt.id = h.id AND tt.tot > 0);

    DELETE FROM pg_temp.cd_hand x
     WHERE x.club_id IS NULL
        OR EXISTS (SELECT 1 FROM public.ca_launch_accounting_boundaries b
                    WHERE b.scope_kind = 'club' AND b.scope_id = x.club_id AND b.undone_at IS NULL
                      AND public.fn_ca_launch_accounting_accepts(x.club_id, x.at) IS NOT TRUE);

    INSERT INTO pg_temp.cd_cash_players
    SELECT DISTINCT x.club_id, x.table_id, x.user_id FROM pg_temp.cd_hand x WHERE x.user_id IS NOT NULL;
    INSERT INTO pg_temp.cd_cash
    SELECT x.club_id, x.table_id, x.union_id, SUM(x.rake), COUNT(DISTINCT x.hand_id), COUNT(*), 0, 0
      FROM pg_temp.cd_hand x GROUP BY 1, 2, 3;
    INSERT INTO pg_temp.cd_cash
    SELECT w.club_id, w.table_id, w.union_id, 0, 0, 0,
           SUM(CASE WHEN w.type = 'debit' THEN w.amount ELSE 0 END),
           SUM(CASE WHEN w.type = 'credit' THEN w.amount ELSE 0 END)
      FROM pg_temp.cd_wallet_cash w GROUP BY 1, 2, 3;
  END IF;

  IF p_players THEN
    INSERT INTO pg_temp.cd_player
    SELECT w.club_id, w.user_id,
           SUM(CASE WHEN w.type = 'credit' THEN w.amount WHEN w.type = 'debit' THEN -w.amount ELSE 0 END), 0
      FROM pg_temp.cd_wallet_cash w GROUP BY 1, 2;

    -- Tournament money: the club the entry was paid from.
    INSERT INTO pg_temp.cd_wallet_tour
    SELECT wt.user_id, wt.related_entity_id,
           COALESCE(tp.club_id, public.fn_ca_tournament_entry_club(wt.related_entity_id, wt.user_id)),
           wt.created_at, wt.category,
           CASE WHEN wt.type = 'credit' THEN wt.amount WHEN wt.type = 'debit' THEN -wt.amount ELSE 0 END
      FROM public.wallet_transactions wt
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = wt.related_entity_id AND tp.user_id = wt.user_id
     WHERE wt.created_at >= p_from AND wt.created_at < p_to
       AND wt.category IN ('tournament_buyin', 'prize', 'bounty', 'addon', 'rebuy', 'refund', 'prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL;
    DELETE FROM pg_temp.cd_wallet_tour w
     WHERE w.club_id IS NULL
        OR (EXISTS (SELECT 1 FROM public.ca_launch_accounting_boundaries b
                     WHERE b.scope_kind = 'club' AND b.scope_id = w.club_id AND b.undone_at IS NULL)
            AND public.fn_ca_launch_reporting_wallet_accepts(w.club_id, w.at, w.category, w.tournament_id, w.user_id) IS NOT TRUE);

    INSERT INTO pg_temp.cd_player
    SELECT w.club_id, w.user_id, 0, SUM(w.net) FROM pg_temp.cd_wallet_tour w GROUP BY 1, 2;
    INSERT INTO pg_temp.cd_tour
    SELECT w.club_id, w.tournament_id, 0, SUM(w.net) FROM pg_temp.cd_wallet_tour w GROUP BY 1, 2;
    INSERT INTO pg_temp.cd_tour_players
    SELECT DISTINCT w.club_id, w.tournament_id, w.user_id FROM pg_temp.cd_wallet_tour w;

    -- Tournament fees: the accounting's own fee source, per entrant, per club.
    INSERT INTO pg_temp.cd_tour
    SELECT f.club_id, f.tournament_id, SUM(f.rake_credit), 0
      FROM public.rake_records r
      JOIN public.accounting_tournament_fee_sources f ON f.rake_record_id = r.id
     WHERE r.created_at >= p_from AND r.created_at < p_to
       AND r.is_tournament AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND f.club_id IS NOT NULL AND f.tournament_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.ca_launch_accounting_boundaries b
                        WHERE b.scope_kind = 'club' AND b.scope_id = f.club_id
                          AND b.undone_at IS NULL AND f.charged_at < b.cutoff_at)
     GROUP BY 1, 2;
    -- ... and a fee that has none.
    INSERT INTO pg_temp.cd_tour
    SELECT s.club_id, r.tournament_id, SUM(s.fee), 0
      FROM public.rake_records r
      CROSS JOIN LATERAL public.fn_ca_club_data_tournament_fee_split(r.id) s
     WHERE r.created_at >= p_from AND r.created_at < p_to
       AND r.is_tournament AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id = r.id)
     GROUP BY 1, 2;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_stage(timestamptz, timestamptz, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_data_stage(timestamptz, timestamptz, boolean, boolean) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Publish what was staged as the day's rows. A row that already says the
--    right thing is left alone, so the live day's swap writes only what changed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_publish(p_day date, p_cash boolean DEFAULT true, p_players boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_cash int := 0; v_cash_players int := 0; v_players int := 0; v_tours int := 0; v_tour_players int := 0;
BEGIN
  -- Scratch tables have no statistics until asked; the anti-joins below need them.
  ANALYZE pg_temp.cd_cash, pg_temp.cd_cash_players, pg_temp.cd_player, pg_temp.cd_tour, pg_temp.cd_tour_players;
  IF p_cash THEN
    WITH tgt AS (
      SELECT c.club_id, c.table_id, c.union_id
        FROM pg_temp.cd_cash c WHERE c.club_id IS NOT NULL AND c.table_id IS NOT NULL
       GROUP BY 1, 2, 3
    )
    DELETE FROM public.club_table_daily d
     WHERE d.stat_date = p_day
       AND NOT EXISTS (SELECT 1 FROM tgt WHERE tgt.club_id = d.club_id AND tgt.table_id = d.table_id);

    DELETE FROM public.ca_club_table_player_daily d
     WHERE d.stat_date = p_day
       AND NOT EXISTS (SELECT 1 FROM pg_temp.cd_cash_players p
                        WHERE p.club_id = d.club_id AND p.table_id = d.table_id AND p.user_id = d.user_id);
    INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
    SELECT DISTINCT p.club_id, p.table_id, p_day, p.user_id FROM pg_temp.cd_cash_players p
     WHERE p.club_id IS NOT NULL AND p.table_id IS NOT NULL AND p.user_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO public.club_table_daily AS d
      (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
    SELECT c.club_id, c.table_id, p_day, c.union_id,
           SUM(c.rake), SUM(c.hands)::int, COALESCE(MAX(p.n), 0)::int,
           round(SUM(c.buyins), 2), round(SUM(c.cashouts), 2), round(SUM(c.cashouts) - SUM(c.buyins), 2),
           SUM(c.src)::int, now()
      FROM pg_temp.cd_cash c
      LEFT JOIN (SELECT x.club_id, x.table_id, count(DISTINCT x.user_id) AS n
                   FROM pg_temp.cd_cash_players x GROUP BY 1, 2) p
        ON p.club_id = c.club_id AND p.table_id = c.table_id
     WHERE c.club_id IS NOT NULL AND c.table_id IS NOT NULL
     GROUP BY c.club_id, c.table_id, c.union_id
     ORDER BY c.club_id, c.table_id
    ON CONFLICT (club_id, table_id, stat_date) DO UPDATE
       SET union_id = EXCLUDED.union_id, rake = EXCLUDED.rake, hands = EXCLUDED.hands,
           players = EXCLUDED.players, buyins = EXCLUDED.buyins, cashouts = EXCLUDED.cashouts,
           net = EXCLUDED.net, source_rows = EXCLUDED.source_rows, updated_at = now()
     WHERE (d.union_id, d.rake, d.hands, d.players, d.buyins, d.cashouts, d.net, d.source_rows)
           IS DISTINCT FROM
           (EXCLUDED.union_id, EXCLUDED.rake, EXCLUDED.hands, EXCLUDED.players, EXCLUDED.buyins,
            EXCLUDED.cashouts, EXCLUDED.net, EXCLUDED.source_rows);
    GET DIAGNOSTICS v_cash = ROW_COUNT;
    SELECT count(*) INTO v_cash_players FROM public.ca_club_table_player_daily WHERE stat_date = p_day;
    TRUNCATE pg_temp.cd_cash, pg_temp.cd_cash_players;
  END IF;

  IF p_players THEN
    DELETE FROM public.ca_club_player_daily d
     WHERE d.stat_date = p_day
       AND NOT EXISTS (SELECT 1 FROM pg_temp.cd_player p WHERE p.club_id = d.club_id AND p.user_id = d.user_id);
    INSERT INTO public.ca_club_player_daily AS d (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
    SELECT p.club_id, p.user_id, p_day, SUM(p.cash_net), SUM(p.tournament_net), now()
      FROM pg_temp.cd_player p WHERE p.club_id IS NOT NULL AND p.user_id IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1, 2
    ON CONFLICT (club_id, user_id, stat_date) DO UPDATE
       SET cash_net = EXCLUDED.cash_net, tournament_net = EXCLUDED.tournament_net, updated_at = now()
     WHERE (d.cash_net, d.tournament_net) IS DISTINCT FROM (EXCLUDED.cash_net, EXCLUDED.tournament_net);
    GET DIAGNOSTICS v_players = ROW_COUNT;

    DELETE FROM public.ca_club_tournament_daily d
     WHERE d.stat_date = p_day
       AND NOT EXISTS (SELECT 1 FROM pg_temp.cd_tour t WHERE t.club_id = d.club_id AND t.tournament_id = d.tournament_id);
    INSERT INTO public.ca_club_tournament_daily AS d (club_id, tournament_id, stat_date, fee, winnings, updated_at)
    SELECT t.club_id, t.tournament_id, p_day, SUM(t.fee), SUM(t.winnings), now()
      FROM pg_temp.cd_tour t WHERE t.club_id IS NOT NULL AND t.tournament_id IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1, 2
    ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
       SET fee = EXCLUDED.fee, winnings = EXCLUDED.winnings, updated_at = now()
     WHERE (d.fee, d.winnings) IS DISTINCT FROM (EXCLUDED.fee, EXCLUDED.winnings);
    GET DIAGNOSTICS v_tours = ROW_COUNT;

    DELETE FROM public.ca_club_tournament_player_daily d
     WHERE d.stat_date = p_day
       AND NOT EXISTS (SELECT 1 FROM pg_temp.cd_tour_players t
                        WHERE t.club_id = d.club_id AND t.tournament_id = d.tournament_id AND t.user_id = d.user_id);
    INSERT INTO public.ca_club_tournament_player_daily (club_id, tournament_id, user_id, stat_date, updated_at)
    SELECT DISTINCT t.club_id, t.tournament_id, t.user_id, p_day, now() FROM pg_temp.cd_tour_players t
     WHERE t.club_id IS NOT NULL AND t.tournament_id IS NOT NULL AND t.user_id IS NOT NULL
    ON CONFLICT (club_id, tournament_id, user_id, stat_date) DO NOTHING;
    GET DIAGNOSTICS v_tour_players = ROW_COUNT;
    TRUNCATE pg_temp.cd_player, pg_temp.cd_tour, pg_temp.cd_tour_players;
  END IF;

  RETURN jsonb_build_object('day', p_day, 'table_rows_written', v_cash,
    'table_player_rows', v_cash_players, 'player_rows_written', v_players,
    'tournament_rows_written', v_tours, 'tournament_player_rows_added', v_tour_players);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_publish(date, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_data_publish(date, boolean, boolean) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Re-count one day. A past day takes only its own day lock. The live day is
--    counted up to five minutes before this began without stopping anything,
--    then the reporting lock is taken (every in-flight writer has finished, the
--    next one waits) only to count those last minutes and swap what changed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_rebuild_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_mark timestamptz;
  v_out jsonb;
BEGIN
  IF p_day IS NULL OR p_day > v_today THEN
    RAISE EXCEPTION 'club data rebuild: day % is not a day that has happened', p_day;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ca_club_data_day'), p_day - DATE '2000-01-01');
  IF p_day < v_today THEN
    PERFORM public.fn_ca_club_data_stage(v_from, v_to, true, true);
    v_out := public.fn_ca_club_data_publish(p_day, true, true);
  ELSE
    v_mark := GREATEST(v_from, clock_timestamp() - interval '5 minutes');
    PERFORM public.fn_ca_club_data_stage(v_from, v_mark, true, true);
    PERFORM pg_advisory_xact_lock(918273645);
    PERFORM public.fn_ca_club_data_stage(v_mark, v_to, true, true);
    v_out := public.fn_ca_club_data_publish(p_day, true, true);
  END IF;
  RETURN v_out || jsonb_build_object('rebuilt_at', clock_timestamp());
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_rebuild_day(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_data_rebuild_day(date) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. The existing rebuild entry points attribute exactly like the live writers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_out jsonb;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;
  /* The live day belongs to the insert triggers; the hourly catch-up still asks
     for it and is declined. A deliberate re-count of the live day goes through
     fn_ca_club_data_rebuild_day, which holds the reporting lock for its swap. */
  IF p_day = (now() AT TIME ZONE 'UTC')::date
     AND COALESCE(current_setting('ca.club_data_seed_live_day', true), '') <> 'on' THEN
    RETURN jsonb_build_object('success', true, 'day', p_day, 'skipped', 'live_day_is_kept_by_triggers');
  END IF;
  IF p_day = (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', true) || public.fn_ca_club_data_rebuild_day(p_day);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ca_club_data_day'), p_day - DATE '2000-01-01');
  PERFORM public.fn_ca_club_data_stage(v_from, v_to, true, false);
  v_out := public.fn_ca_club_data_publish(p_day, true, false);
  RETURN jsonb_build_object('success', true, 'rows', v_out->'table_rows_written') || v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_table_daily_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
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
  v_today_drift numeric;
BEGIN
  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    -- The rows the rebuild counts: one per attributed player per raked hand;
    -- for a hand the accounting never attributed, one per contributor (or one
    -- for the hand when no contribution is usable).
    WITH h AS MATERIALIZED (
      SELECT r.id, r.player_contributions,
             EXISTS (SELECT 1 FROM rake_attributions a WHERE a.rake_record_id = r.id) AS attributed
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.rake_amount > 0 AND NOT COALESCE(r.is_tournament, false)
    ), legacy AS (
      SELECT h.id,
             count(*) FILTER (WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') AS keys,
             bool_or(x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0) AS usable
        FROM h
        LEFT JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(h.player_contributions) = 'object'
                                               THEN h.player_contributions ELSE '{}'::jsonb END) x ON true
       WHERE NOT h.attributed
       GROUP BY h.id
    )
    SELECT (SELECT count(*) FROM h JOIN rake_attributions a ON a.rake_record_id = h.id WHERE h.attributed)
         + COALESCE((SELECT SUM(CASE WHEN l.usable THEN l.keys ELSE 1 END) FROM legacy l), 0)
      INTO v_actual;

    IF d >= v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

    -- Rake is conserved across attribution, so a COMPLETE day's rollup total
    -- must equal the ledger's cash rake for that day. Today is excluded on
    -- purpose: the triggers are exact on a live day and a recount is not.
    IF d < v_today THEN
      v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
      SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
        FROM ca_club_rake_daily x WHERE x.stat_date = d;
      IF abs(v_ledger - v_rollup) > 0.005 THEN
        PERFORM fn_ca_club_rake_daily_rebuild_range(d, d, false);
        v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
          'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
      END IF;
    END IF;
  END LOOP;

  v_today_drift := round(public.fn_ca_club_rake_daily_ledger_total(v_today)
                         - COALESCE((SELECT SUM(x.rake) FROM ca_club_rake_daily x
                                      WHERE x.stat_date = v_today), 0), 4);

  RETURN jsonb_build_object('success', true, 'days', v_done,
                            'rake_daily_rebuilt', v_reconciled,
                            'today_drift', v_today_drift);
END;
$function$;

-- The changed-fact repair (a wallet or rake row UPDATEd or DELETEd) re-counts
-- through the same stage/publish, under the exclusive reporting lock it always
-- held. It now re-counts the cash table rows too, which it used to leave behind.
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  d date;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  FOR d IN SELECT gs::date FROM generate_series(v_start, v_end, interval '1 day') gs LOOP
    PERFORM pg_advisory_xact_lock(hashtext('ca_club_data_day'), d - DATE '2000-01-01');
    PERFORM public.fn_ca_club_data_stage((d::timestamp AT TIME ZONE 'UTC'),
                                         ((d + 1)::timestamp AT TIME ZONE 'UTC'), true, true);
    PERFORM public.fn_ca_club_data_publish(d, true, true);
  END LOOP;
  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start', v_start, 'end', v_end, 'player_facts', v_players,
    'tournament_facts', v_tournaments, 'participant_facts', v_participants,
    'refreshed_at', now());
END;
$function$;

-- Cash results are now re-counted by ca_refresh_reporting_rollups_base with
-- the same club the live trigger reads; this second pass used to overwrite
-- them with the first-membership guess, so it only reports.
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_cash_rollup(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_start date := LEAST(p_start, p_end); v_end date := GREATEST(p_start, p_end); v_rows bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'cash reporting refresh requires a 0-400 day range'; END IF;
  SELECT count(*) INTO v_rows FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end AND cash_net <> 0;
  RETURN jsonb_build_object('start', v_start, 'end', v_end, 'cash_facts', v_rows, 'refreshed_at', now());
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The live writers
-- ─────────────────────────────────────────────────────────────────────────────

-- Cash rake: the moment the accounting attributes a raked hand.
CREATE OR REPLACE FUNCTION public.trg_ca_club_data_cash_attribution_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(918273645);
  WITH n AS MATERIALIZED (
    SELECT a.id, a.rake_record_id, a.player_id, a.rake_amount, a.club_id AS recorded_club,
           r.table_id, r.created_at, (r.created_at AT TIME ZONE 'UTC')::date AS stat_date, t.union_id,
           -- exactly as fn_ca_club_data_stage reads it
           CASE WHEN a.club_id IS NOT NULL
                 AND (t.union_id IS NULL
                      OR EXISTS (SELECT 1 FROM public.union_clubs uc
                                  WHERE uc.union_id = t.union_id AND uc.club_id = a.club_id))
                THEN a.club_id
                ELSE COALESCE(public.fn_ca_cash_hand_club(r.table_id, a.player_id, r.created_at), t.club_id) END AS club_id
      FROM new_rows a
      JOIN public.rake_records r ON r.id = a.rake_record_id
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE COALESCE(r.rake_amount, 0) > 0 AND NOT COALESCE(r.is_tournament, false)
  ), k AS MATERIALIZED (
    SELECT n.*,
           -- this hand is new for this club unless an earlier statement already counted it
           (row_number() OVER (PARTITION BY n.rake_record_id, n.club_id ORDER BY n.id) = 1
            AND NOT EXISTS (SELECT 1 FROM public.rake_attributions o
                             WHERE o.rake_record_id = n.rake_record_id
                               AND o.club_id IS NOT DISTINCT FROM n.recorded_club
                               AND o.id NOT IN (SELECT x.id FROM new_rows x))) AS first_for_club
      FROM n
     WHERE n.club_id IS NOT NULL
       AND public.fn_ca_launch_accounting_accepts(n.club_id, n.created_at) IS TRUE
  ), newp AS (
    INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
    SELECT DISTINCT k.club_id, k.table_id, k.stat_date, k.player_id FROM k WHERE k.player_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING club_id, table_id, stat_date
  ), newp_n AS (
    SELECT club_id, table_id, stat_date, count(*)::int AS c FROM newp GROUP BY 1, 2, 3
  )
  INSERT INTO public.club_table_daily AS d
    (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
  SELECT g.club_id, g.table_id, g.stat_date, g.union_id, g.rake, g.hands, COALESCE(p.c, 0), 0, 0, 0, g.src, now()
    FROM (SELECT k.club_id, k.table_id, k.stat_date, k.union_id, SUM(k.rake_amount) AS rake,
                 count(*) FILTER (WHERE k.first_for_club)::int AS hands, count(*)::int AS src
            FROM k GROUP BY 1, 2, 3, 4) g
    LEFT JOIN newp_n p ON p.club_id = g.club_id AND p.table_id = g.table_id AND p.stat_date = g.stat_date
   ORDER BY g.club_id, g.table_id, g.stat_date
  ON CONFLICT (club_id, table_id, stat_date) DO UPDATE
     SET rake = d.rake + EXCLUDED.rake,
         hands = d.hands + EXCLUDED.hands,
         players = d.players + EXCLUDED.players,
         source_rows = d.source_rows + EXCLUDED.source_rows,
         union_id = COALESCE(d.union_id, EXCLUDED.union_id),
         updated_at = now();
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never fail a raked hand for a reporting table.
  RAISE WARNING 'Club Data cash attribution rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_ca_club_data_cash_attribution_insert() FROM PUBLIC, anon, authenticated;

-- Tournament fees: the moment the accounting records whose entry paid them.
CREATE OR REPLACE FUNCTION public.trg_ca_club_data_tournament_fee_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(918273645);
  INSERT INTO public.ca_club_tournament_daily AS d (club_id, tournament_id, stat_date, fee, winnings, updated_at)
  SELECT f.club_id, f.tournament_id, (r.created_at AT TIME ZONE 'UTC')::date, SUM(f.rake_credit), 0, now()
    FROM new_rows f
    JOIN public.rake_records r ON r.id = f.rake_record_id
   WHERE f.club_id IS NOT NULL AND f.tournament_id IS NOT NULL
     AND r.is_tournament AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
     AND public.fn_ca_launch_accounting_accepts(f.club_id, f.charged_at) IS TRUE
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
  ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
     SET fee = d.fee + EXCLUDED.fee, updated_at = now();
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data tournament fee rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_ca_club_data_tournament_fee_insert() FROM PUBLIC, anon, authenticated;

-- rake_records: cash rake now arrives through its attributions and a tournament
-- fee through its fee source. A fee REVERSAL (a negative tournament rake row)
-- never gets a fee source, so it is attributed here, to the same entry clubs.
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_day date; r record;
BEGIN
  IF NOT COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NULL
     OR COALESCE(NEW.rake_amount, 0) >= 0 THEN
    RETURN NULL;
  END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;
  FOR r IN SELECT s.club_id, s.fee FROM public.fn_ca_club_data_tournament_fee_split(NEW.id) s
            WHERE s.fee <> 0 ORDER BY s.club_id LOOP
    INSERT INTO public.ca_club_tournament_daily AS d (club_id, tournament_id, stat_date, fee, updated_at)
    VALUES (r.club_id, NEW.tournament_id, v_day, r.fee, now())
    ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
       SET fee = d.fee + EXCLUDED.fee, updated_at = now();
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric := 0; v_tournament numeric := 0;
BEGIN
  -- A row with a table is cash; a row with a tournament and no table is
  -- tournament. The sign is the row's own type, never its name (2026-09-04).
  IF NOT ((NEW.category IN ('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215): shared holders never block each
     other; only the rebuilds take the lock exclusively. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id, t.club_id, (t.tournament_id IS NOT NULL)
      INTO v_union, v_table_club, v_is_tournament_table
      FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club := v_table_club;
    ELSE
      -- A union table: the club whose wallet these chips left or returned to,
      -- read from the chip movement AT THIS TABLE (fn_ca_cash_hand_club).
      v_club := COALESCE(public.fn_ca_cash_hand_club(NEW.table_id, NEW.user_id, NEW.created_at), v_table_club);
    END IF;
    v_cash := CASE WHEN NEW.type = 'credit' THEN NEW.amount
                   WHEN NEW.type = 'debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL
       AND public.fn_ca_launch_reporting_wallet_accepts(v_club, NEW.created_at, NEW.category, NULL, NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
      VALUES (v_club, NEW.user_id, v_day, v_cash, 0, now())
      ON CONFLICT (club_id, user_id, stat_date) DO UPDATE
       SET cash_net = d.cash_net + EXCLUDED.cash_net, updated_at = now();
      /* Its own block, so a failure here never costs the player rollup above. */
      BEGIN
        INSERT INTO public.club_table_daily AS d
          (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
        VALUES (v_club, NEW.table_id, v_day, v_union, 0, 0, 0,
                CASE WHEN NEW.type = 'debit' THEN NEW.amount ELSE 0 END,
                CASE WHEN NEW.type = 'credit' THEN NEW.amount ELSE 0 END,
                v_cash, 0, now())
        ON CONFLICT (club_id, table_id, stat_date) DO UPDATE
         SET buyins = d.buyins + EXCLUDED.buyins,
             cashouts = d.cashouts + EXCLUDED.cashouts,
             net = d.net + EXCLUDED.net,
             union_id = COALESCE(d.union_id, EXCLUDED.union_id),
             updated_at = now();
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Club Data cash table rollup failed for tx %: %', NEW.id, SQLERRM;
      END;
    END IF;
  ELSE
    v_tournament := CASE WHEN NEW.type = 'credit' THEN NEW.amount
                         WHEN NEW.type = 'debit' THEN -NEW.amount ELSE 0 END;
    -- ONE club: the club this entry was paid from, never every club the player
    -- belongs to and never the first one they joined.
    v_club := public.fn_ca_tournament_entry_club(NEW.related_entity_id, NEW.user_id);
    IF v_club IS NOT NULL
       AND public.fn_ca_launch_reporting_wallet_accepts(v_club, NEW.created_at, NEW.category, NEW.related_entity_id, NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
      VALUES (v_club, NEW.user_id, v_day, 0, v_tournament, now())
      ON CONFLICT (club_id, user_id, stat_date) DO UPDATE
       SET tournament_net = d.tournament_net + EXCLUDED.tournament_net, updated_at = now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id, tournament_id, stat_date, winnings, updated_at)
      VALUES (v_club, NEW.related_entity_id, v_day, v_tournament, now())
      ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
       SET winnings = d.winnings + EXCLUDED.winnings, updated_at = now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id, tournament_id, user_id, stat_date, updated_at)
      VALUES (v_club, NEW.related_entity_id, NEW.user_id, v_day, now())
      ON CONFLICT (club_id, tournament_id, user_id, stat_date) DO UPDATE SET updated_at = now();
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. The felt: a live seat's chips belong to the club that seat was bought for.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_cash_felt(p_club_id uuid, p_start date, p_end date,
  p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
RETURNS TABLE(table_id uuid, felt numeric, seated integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
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
     AND (CASE WHEN t.union_id IS NULL THEN t.club_id
               ELSE COALESCE(s.club_id, public.fn_ca_cash_hand_club(s.table_id, s.user_id, s.joined_at)) END) = p_club_id
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

-- #7262's cross-table lookup, withdrawn. Club Data no longer calls this; it
-- stays for any other reader with its pre-#7262 meaning (the player's club in
-- THIS union), so it can never again hand one table's rake to another table's club.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_reporting_club(p_union uuid, p_table_club uuid, p_user uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE((
    SELECT cm.club_id FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union
     WHERE p_union IS NOT NULL AND p_user IS NOT NULL AND cm.user_id = p_user
     ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
     LIMIT 1
  ), p_table_club);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_reporting_club(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. The footer asks the same question the screen answers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_club_data_access(p_club_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR p_club_id IS NULL THEN RETURN 'none'; END IF;
  -- Exactly ca_club_data_screen's rule: an agent sees their downline, club
  -- staff and owners see the club, everyone else is refused.
  IF public.fn_ca_club_user_reporting_scope(p_club_id, v_caller) = 'downline' THEN RETURN 'downline'; END IF;
  IF public.ca_can_view_club_finances(p_club_id) THEN RETURN 'club'; END IF;
  RETURN 'none';
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_data_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_access(uuid) TO authenticated, service_role;

-- The scope helper takes any user id; only definer functions need it.
REVOKE EXECUTE ON FUNCTION public.fn_ca_club_user_reporting_scope(uuid, uuid) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Attach the live writers (last, so the table locks are held briefly)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS ca_club_data_cash_attribution_insert ON public.rake_attributions;
CREATE TRIGGER ca_club_data_cash_attribution_insert
  AFTER INSERT ON public.rake_attributions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_data_cash_attribution_insert();

DROP TRIGGER IF EXISTS ca_club_data_tournament_fee_insert ON public.accounting_tournament_fee_sources;
CREATE TRIGGER ca_club_data_tournament_fee_insert
  AFTER INSERT ON public.accounting_tournament_fee_sources
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_data_tournament_fee_insert();

COMMIT;
