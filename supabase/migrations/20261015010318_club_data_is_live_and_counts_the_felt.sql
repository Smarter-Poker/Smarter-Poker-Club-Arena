-- 20261015010318_club_data_is_live_and_counts_the_felt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-14: "THE DATA PAGE IS NOT ACCURATE
-- ... MAKE SURE THAT ALL THE DATA IS REAL TIME ACCURATE DATA"):
--
-- Two defects, both read from production on 2026-10-15 00:59 UTC.
--
-- 1. CASH FIGURES WERE UP TO AN HOUR OLD. The tournament half of Club Data
--    (ca_club_tournament_daily) is written by triggers as each fee and prize
--    lands. The cash half (club_table_daily) had no writer except
--    fn_club_table_daily_refresh_day, which club-rake-rollup-catchup runs at
--    :25 every hour. So a cash hand raked at :26 was not on the screen until
--    the next :25, and the Club Data screen's "1 Day" view stayed empty for
--    the first 25 minutes of every UTC day. Root fix: the same two insert
--    triggers that feed the tournament rollup now feed club_table_daily too,
--    in the transaction that writes the rake or the wallet row, with the exact
--    attribution the rebuild uses. A live day is the triggers' to keep; the
--    hourly job no longer rewrites today, and only recounts a COMPLETE day
--    whose source count disagrees (plus yesterday once, as before).
--
-- 2. CASH WINNINGS LEFT THE FELT OUT. club_table_daily.net is cash-outs minus
--    buy-ins. A player still seated has bought in and not cashed out, so every
--    chip on the felt read as a loss: SHARK CLUB showed -120,379.07 cash
--    winnings for 2026-10-14 on 14,707.89 of fee, with 53,904.92 sitting on
--    its players' seats. ca_club_data_snapshot now adds the live stack of every
--    seated club player to the window the seat was taken in, so a window's
--    winnings are buy-ins, cash-outs AND what is still in front of them.
--
-- No foreign keys, no DDL on a hot table: the trigger FUNCTIONS are replaced,
-- the triggers themselves are untouched, so rake_records and
-- wallet_transactions take no lock from this migration.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Who played at a cash table on a day, so the live writer can count players
-- the way the rebuild does (distinct contributors per club, table and day).
CREATE TABLE IF NOT EXISTS public.ca_club_table_player_daily (
  club_id   uuid NOT NULL,
  table_id  uuid NOT NULL,
  stat_date date NOT NULL,
  user_id   uuid NOT NULL,
  PRIMARY KEY (club_id, table_id, stat_date, user_id)
);
ALTER TABLE public.ca_club_table_player_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_table_player_daily FROM anon, authenticated;
COMMENT ON TABLE public.ca_club_table_player_daily IS
  'Distinct contributors per club, cash table and UTC day. Written by fn_ca_club_table_daily_add_rake and fn_club_table_daily_refresh_day; read by nothing but those two.';

-- The club a cash-table row belongs to: the player's first club in the
-- table's union, else the table's own club. Identical to the rebuild's att.
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

-- One raked cash hand, added to club_table_daily the moment it is written.
CREATE OR REPLACE FUNCTION public.fn_ca_club_table_daily_add_rake(
  p_table uuid, p_rake numeric, p_at timestamptz, p_contrib jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      -- A raked hand with no usable contribution is the table's club's rake,
      -- whole, as one row with no player (same rule as the rebuild).
      SELECT NULL::text, 1::numeric, 1::numeric FROM usable WHERE NOT usable.ok
    )
    SELECT CASE WHEN rr.uid IS NULL THEN v_table_club
                ELSE public.fn_ca_cash_reporting_club(v_union, v_table_club, rr.uid::uuid) END AS club_id,
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
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_table_daily_add_rake(uuid, numeric, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;

-- The rake insert trigger: cash hands now land in club_table_daily live.
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
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
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
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
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

-- The wallet insert trigger: cash buy-ins, add-ons, rebuys, refunds and
-- cash-outs now land in club_table_daily live, beside the player rollup.
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
    IF v_club IS NOT NULL AND public.fn_ca_launch_reporting_wallet_accepts(v_club,NEW.created_at,NEW.category,NULL,NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
    /* 2026-10-15: the live writer for the Club Data cash table rows. Same
       club the rebuild picks (first union club, else the table's club). Its
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
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
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

-- The rebuild: also rebuilds the contributor set, and merges additively so a
-- live trigger that commits while it runs is kept rather than refused.
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_rows int;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;

  DELETE FROM club_table_daily WHERE stat_date = p_day;
  DELETE FROM ca_club_table_player_daily WHERE stat_date = p_day;

  CREATE TEMP TABLE IF NOT EXISTS ctd_rr (
    id uuid, table_id uuid, rake_amount numeric, created_at timestamptz,
    union_id uuid, table_club uuid, uid text, contrib numeric, tot numeric
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.ctd_rr;

  INSERT INTO pg_temp.ctd_rr
  SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id,
         e.key, (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END),
         SUM(CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) OVER (PARTITION BY r.id)
    FROM rake_records r
    JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
    CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
   WHERE r.created_at >= v_from AND r.created_at < v_to
     AND r.player_contributions IS NOT NULL
     AND jsonb_typeof(r.player_contributions) = 'object'
     AND r.rake_amount > 0
     AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND EXISTS (
       SELECT 1 FROM jsonb_each_text(r.player_contributions) x
        WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
  UNION ALL
  -- 2026-09-04: a raked hand with no usable contribution is the table's
  -- club's rake, whole, as one synthetic row of weight 1 and no player.
  SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id,
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
          AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0);

  WITH att AS (
    SELECT DISTINCT ON (cm.user_id, uc.union_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY cm.user_id, uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  attributed AS (
    SELECT COALESCE(a.club_id, rr.table_club) AS club_id, rr.*
      FROM pg_temp.ctd_rr rr
      LEFT JOIN att a ON a.user_id::text = rr.uid AND a.union_id IS NOT DISTINCT FROM rr.union_id
     WHERE rr.tot > 0 AND public.fn_ca_launch_accounting_accepts(COALESCE(a.club_id, rr.table_club), rr.created_at)
  ),
  players AS (
    INSERT INTO ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
    SELECT DISTINCT club_id, table_id, p_day, uid::uuid FROM attributed
     WHERE club_id IS NOT NULL AND uid IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  ),
  raked AS (
    SELECT club_id, table_id, union_id,
           SUM(rake_amount * contrib / tot) AS rake,
           COUNT(DISTINCT id)  AS hands,
           COUNT(DISTINCT uid) AS players,
           COUNT(*)            AS src
      FROM attributed
     GROUP BY 1, 2, 3
  ),
  -- 2026-09-04: a table add-on (a top-up, 'addon'), a rebuy and a refund are
  -- buy-in money too. Debits are money onto the table, credits money off it.
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
       AND public.fn_ca_launch_reporting_wallet_accepts(COALESCE(a.club_id,t.club_id),wt.created_at,wt.category,NULL,wt.user_id)
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
  INSERT INTO club_table_daily AS d (club_id, table_id, stat_date, union_id,
                                rake, hands, players, buyins, cashouts, net,
                                source_rows, updated_at)
  SELECT m.club_id, m.table_id, p_day, m.union_id,
         round(m.rake, 4), m.hands, m.players,
         round(m.buyins, 2), round(m.cashouts, 2),
         round(m.cashouts - m.buyins, 2),
         m.src, now()
    FROM merged m
   WHERE m.club_id IS NOT NULL AND m.table_id IS NOT NULL
  ON CONFLICT (club_id, table_id, stat_date) DO UPDATE
     SET rake = d.rake + EXCLUDED.rake,
         hands = d.hands + EXCLUDED.hands,
         players = d.players + EXCLUDED.players,
         buyins = d.buyins + EXCLUDED.buyins,
         cashouts = d.cashouts + EXCLUDED.cashouts,
         net = d.net + EXCLUDED.net,
         source_rows = d.source_rows + EXCLUDED.source_rows,
         union_id = COALESCE(d.union_id, EXCLUDED.union_id),
         updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'day', p_day, 'rows', v_rows);
END;
$$;

-- The hourly job no longer rewrites the live day: the triggers keep it.
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  FOR d IN SELECT gs::date FROM generate_series(v_today - v_n, v_today - 1, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    SELECT (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
        CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.player_contributions IS NOT NULL
         AND jsonb_typeof(r.player_contributions) = 'object'
         AND r.rake_amount > 0
         AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND EXISTS (
           SELECT 1 FROM jsonb_each_text(r.player_contributions) x
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

    -- Yesterday is recounted once its last writer has committed; an older
    -- complete day only when its stored count disagrees with the ledger.
    IF d = v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

    v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
    SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
      FROM ca_club_rake_daily x WHERE x.stat_date = d;
    IF abs(v_ledger - v_rollup) > 0.005 THEN
      PERFORM fn_ca_club_rake_daily_rebuild_range(d, d, false);
      v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
        'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
    END IF;
  END LOOP;

  -- Today is reported, never rewritten. A drift that survives the day is a
  -- trigger that stopped landing, and it will be recounted at midnight.
  v_today_drift := round(public.fn_ca_club_rake_daily_ledger_total(v_today)
                         - COALESCE((SELECT SUM(x.rake) FROM ca_club_rake_daily x
                                      WHERE x.stat_date = v_today), 0), 4);

  RETURN jsonb_build_object('success', true, 'days', v_done,
                            'rake_daily_rebuilt', v_reconciled,
                            'today_drift', v_today_drift);
END;
$$;

-- Chips still in front of a club's seated players, per cash table, for seats
-- taken inside the window, under the same filters the Club Data list uses.
CREATE OR REPLACE FUNCTION public.fn_ca_club_cash_felt(
  p_club_id uuid, p_start date, p_end date,
  p_game text DEFAULT 'ALL', p_stakes text DEFAULT 'ALL', p_search text DEFAULT NULL)
RETURNS TABLE (table_id uuid, felt numeric, seated integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
     AND public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id) = p_club_id
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
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_cash_felt(uuid, date, date, text, text, text) FROM PUBLIC, anon, authenticated;

-- The snapshot: winnings include the felt, and a live game says so.
CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(
  p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'UTC')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13); v_days int; v_pstart date; v_pend date;
  v_game text:=UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text:=UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_q text:=NULLIF(btrim(COALESCE(p_search,'')),'');
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_cur jsonb; v_prev jsonb; v_rows jsonb;
  v_felt numeric; v_pfelt numeric; v_felt_rows jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  v_days:=(v_end-v_start)+1; v_pend:=v_start-1; v_pstart:=v_pend-(v_days-1);
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
  v_cur:=public.fn_ca_club_game_summary(p_club_id,v_start,v_end,v_game,v_stakes,v_q);
  v_prev:=public.fn_ca_club_game_summary(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q);
  v_rows:=public.fn_ca_club_game_rows(p_club_id,v_start,v_end,v_game,v_stakes,v_q,v_lim);

  -- 2026-10-15: a seated player's stack is part of the result, not a loss.
  SELECT COALESCE(SUM(f.felt),0),
         COALESCE(jsonb_object_agg(f.table_id::text, jsonb_build_object('felt', f.felt, 'seated', f.seated)), '{}'::jsonb)
    INTO v_felt, v_felt_rows
    FROM public.fn_ca_club_cash_felt(p_club_id,v_start,v_end,v_game,v_stakes,v_q) f;
  SELECT COALESCE(SUM(f.felt),0) INTO v_pfelt
    FROM public.fn_ca_club_cash_felt(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q) f;
  v_cur:=v_cur||jsonb_build_object(
    'cash_winnings',round(COALESCE((v_cur->>'cash_winnings')::numeric,0)+v_felt,2),
    'total_winnings',round(COALESCE((v_cur->>'total_winnings')::numeric,0)+v_felt,2),
    'on_felt',round(v_felt,2));
  v_prev:=v_prev||jsonb_build_object(
    'cash_winnings',round(COALESCE((v_prev->>'cash_winnings')::numeric,0)+v_pfelt,2),
    'total_winnings',round(COALESCE((v_prev->>'total_winnings')::numeric,0)+v_pfelt,2),
    'on_felt',round(v_pfelt,2));
  SELECT COALESCE(jsonb_agg(
           CASE WHEN e.r->>'kind'='CASH' AND v_felt_rows ? (e.r->>'id') THEN
             e.r||jsonb_build_object(
               'winnings',round(COALESCE((e.r->>'winnings')::numeric,0)
                                +((v_felt_rows->(e.r->>'id'))->>'felt')::numeric,2),
               'on_felt',round(((v_felt_rows->(e.r->>'id'))->>'felt')::numeric,2),
               'seated',((v_felt_rows->(e.r->>'id'))->>'seated')::int,
               'live',true)
           ELSE e.r END ORDER BY e.ord),'[]'::jsonb)
    INTO v_rows
    FROM jsonb_array_elements(COALESCE(v_rows,'[]'::jsonb)) WITH ORDINALITY e(r,ord);

  RETURN jsonb_build_object(
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'filters',jsonb_build_object('game',v_game,'stakes',v_stakes,'search',v_q),
    'summary',v_cur,'previous',v_prev,'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2),
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2)),
    'rows',v_rows,'row_count',(v_cur->>'games')::int,'union_id',v_union,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c WHERE c.club_id=p_club_id AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now());
END;
$function$;

-- Start the live day from the ledger. Inside this transaction nothing else
-- writes club_table_daily (the old trigger bodies never did, and the hourly
-- job runs at :25), so the rebuild is uncontended; from COMMIT on, the new
-- trigger bodies keep it.
SELECT public.fn_club_table_daily_refresh_day((now() AT TIME ZONE 'UTC')::date);

COMMIT;
