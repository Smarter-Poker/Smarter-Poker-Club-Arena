-- Correct the attribution edge cases exposed by the first reporting-fact
-- parity run before this phase ships.
--
-- Tournament performance in Club Data is member-centric: a player's activity
-- is attributed to their home club in each union (and each standalone club),
-- independent of which tournament hosted it. Cash performance is table-union
-- centric. The initial fact backfill incorrectly treated both alike, causing
-- union clubs to absorb standalone cash tables and omit cross-event tournament
-- performance. Rebuild the facts with the established semantics.

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

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups(
  p_start date,
  p_end date
)
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
    SELECT wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IS NOT NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.category IN ('buyin','cashout')
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.category='tournament_buyin' THEN -m.amount
                  WHEN m.category IN ('prize','bounty') THEN m.amount ELSE 0 END),now()
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
           CASE WHEN wt.category='tournament_buyin' THEN -wt.amount ELSE wt.amount END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IS NOT NULL
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
     AND wt.category IN ('tournament_buyin','prize','bounty')
     AND wt.related_entity_id IS NOT NULL;

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

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  IF NOT ((NEW.category IN ('buyin','cashout') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN ('tournament_buyin','prize','bounty') AND NEW.related_entity_id IS NOT NULL))
    THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.category IN ('buyin','cashout') THEN
    SELECT t.union_id INTO v_union FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_union IS NULL THEN RETURN NULL; END IF;
    SELECT cm.club_id INTO v_club FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
     WHERE cm.user_id=NEW.user_id
     ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
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
    v_tournament:=CASE WHEN NEW.category='tournament_buyin' THEN -NEW.amount ELSE NEW.amount END;
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

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_day date; r record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,NEW.rake_amount,now())
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
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             NEW.rake_amount*r.club_players/NULLIF(r.total_players,0),now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

-- The old RPC joined member stats only by user/date and therefore counted the
-- same player's hands in unrelated clubs. Pin the read to the requested club.
CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown(
  p_club_id uuid,p_start date DEFAULT NULL::date,p_end date DEFAULT NULL::date,
  p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
      JOIN att_club a ON a.user_id=u.user_id WHERE u.union_id=v_union
       AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
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
      'username',COALESCE(pr.display_name,pr.username,'Player'),'avatar_url',pr.avatar_url,
      'is_horse',COALESCE(pr.is_horse,false),'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands) ORDER BY q.net DESC)
      FROM (SELECT * FROM merged ORDER BY net DESC LIMIT v_lim) q
      LEFT JOIN public.profiles pr ON pr.id=q.user_id),'[]'::jsonb),
    'player_count',(SELECT count(*) FROM merged),'generated_at',now()) INTO v_out;
  RETURN v_out;
END;
$function$;

SELECT public.ca_refresh_reporting_rollups(
  ((now() AT TIME ZONE 'UTC')::date-185),(now() AT TIME ZONE 'UTC')::date
);

REVOKE ALL ON FUNCTION public.ca_reporting_tournament_clubs_for_user(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups(date,date)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups(date,date) TO service_role;
REVOKE ALL ON FUNCTION public.ca_club_player_breakdown(uuid,date,date,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_breakdown(uuid,date,date,integer)
  TO authenticated,service_role;

