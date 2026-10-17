-- Club Data Report fixture (20261017204111), layered on
-- tests/fixtures/club-data-fact-db/fixture.sql. The Report tables, and the
-- writers and readers this migration changes, AS PRODUCTION HELD THEM before it:
-- the five functions below are production's text verbatim (md5 of each body
-- matched pg_proc on 2026-10-17); the Report readers are reduced to the one
-- line the migration rewrites, so the asserted rewrite is exercised for real.
ALTER TABLE rake_records ADD COLUMN club_id uuid, ADD COLUMN bbj_contribution numeric, ADD COLUMN pot_size numeric;
ALTER TABLE rake_attributions ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN rake_amount numeric;
CREATE TABLE ca_club_player_daily (club_id uuid NOT NULL, user_id uuid NOT NULL, stat_date date NOT NULL, cash_net numeric NOT NULL DEFAULT 0,
  tournament_net numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (club_id, user_id, stat_date));
CREATE TABLE ca_club_tournament_daily (club_id uuid NOT NULL, tournament_id uuid NOT NULL, stat_date date NOT NULL, fee numeric NOT NULL DEFAULT 0,
  winnings numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (club_id, tournament_id, stat_date));
CREATE TABLE ca_club_tournament_player_daily (club_id uuid NOT NULL, tournament_id uuid NOT NULL, user_id uuid NOT NULL, stat_date date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (club_id, tournament_id, user_id, stat_date));
CREATE FUNCTION fn_ca_launch_reporting_wallet_accepts(uuid, timestamptz, text, uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION fn_ca_launch_reporting_fee_credit(uuid, uuid, timestamptz, jsonb, numeric, numeric) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT $6 $$;
CREATE FUNCTION fn_is_union_overseer(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
-- Production's: owner / co_owner / admin / SUPER AGENT (the gap being closed).
CREATE FUNCTION ca_can_view_club_finances(p_club_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT session_user IN ('postgres','supabase_admin') OR COALESCE(auth.role(),'') = 'service_role'
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
                  AND cm.role IN ('owner','co_owner','admin','super_agent'))
      OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid()) $$;
CREATE FUNCTION ca_can_read_club_production(p_club_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.ca_can_view_club_finances(p_club_id) $$;

CREATE OR REPLACE FUNCTION public.ca_reporting_tournament_clubs_for_user(
  p_user_id uuid
)
RETURNS TABLE(club_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT h.club_id
    FROM (
      SELECT DISTINCT ON (uc.union_id) cm.club_id, uc.union_id
        FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id = cm.club_id
       WHERE cm.user_id = p_user_id
       ORDER BY uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
    ) h
  UNION
  SELECT cm.club_id
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id
     AND NOT EXISTS (
       SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = cm.club_id
     );
$function$;

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

CREATE TABLE ca_club_rake_daily (club_id uuid NOT NULL, stat_date date NOT NULL, hands bigint, rake numeric, bbj numeric, pot numeric,
  source_rows bigint, updated_at timestamptz, PRIMARY KEY (club_id, stat_date));
CREATE FUNCTION fn_club_table_daily_refresh_day(p_day date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

-- The live reporting triggers, as production attaches them. They replace the
-- base fixture's stand-in, which called only the cash rollup.
DROP TRIGGER fixture_rake_daily ON rake_records;
CREATE TRIGGER ca_reporting_rake_insert AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_rake_insert();
CREATE TRIGGER ca_reporting_wallet_insert AFTER INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_wallet_insert();
CREATE FUNCTION pg_advisory_xact_lock_shared_stub() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;

-- The Report readers, reduced to the line the migration rewrites.
CREATE FUNCTION ca_club_data_snapshot(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  RETURN '{}'::jsonb;
END $$;
CREATE FUNCTION ca_club_game_page_core_20261006(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text, p_sort text, p_cursor jsonb, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  RETURN '{}'::jsonb;
END $$;
CREATE FUNCTION ca_club_game_export_start(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text, p_sort text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  RETURN '{}'::jsonb;
END $$;
CREATE FUNCTION ca_club_union_invoices(p_club_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501'; END IF;
  RETURN '[]'::jsonb;
END $$;
CREATE FUNCTION ca_club_data_export_page(p_export_id uuid, p_offset integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_authorized boolean := false;
BEGIN
  IF p_offset = 0 THEN
    v_authorized := public.ca_can_view_club_finances(p_export_id);
  ELSIF p_offset = 1 THEN
    v_authorized := public.ca_can_read_club_production(p_export_id);
  END IF;
  RETURN jsonb_build_object('authorized', v_authorized);
END $$;
CREATE FUNCTION ca_rake_snapshot(p_scope text, p_club_id uuid, p_union_id uuid, p_start date, p_end date, p_agent_user_id uuid, p_limit integer, p_offset integer, p_search text, p_sort text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT public.ca_can_read_club_production(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  RETURN '{}'::jsonb;
END $$;

CREATE FUNCTION ca_club_player_breakdown(p_club_id uuid, p_start date, p_end date, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
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
  )
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id), '[]'::jsonb) INTO v_out FROM att_club;
  RETURN v_out;
END $$;

CREATE FUNCTION ca_club_player_page_core_20261006(p_club_id uuid, p_start date, p_end date, p_sort text, p_search text, p_cursor jsonb, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
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
  )
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id), '[]'::jsonb) INTO v_out FROM att_club;
  RETURN v_out;
END $$;

CREATE FUNCTION ca_club_player_export_start(p_club_id uuid, p_start date, p_end date, p_sort text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
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
  )
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id), '[]'::jsonb) INTO v_out FROM att_club;
  RETURN v_out;
END $$;
