BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS ca_club_data_game_ct_cash_day_idx
    ON public.ca_club_data_game_ct (club_id, stat_date) INCLUDE (game_id, fee, winnings)
 WHERE kind = 'CASH';

DO $migration$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_old := $o$(SELECT max(g.last_at) FROM public.ca_club_data_game_ct g WHERE g.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND g.stat_date BETWEEN v_start AND v_end)$o$;
  v_new := $n$(SELECT max(x.m) FROM unnest(public.fn_ca_club_data_clubs(p_club_id)) c(id)
       CROSS JOIN LATERAL (SELECT max(g.last_at) m FROM public.ca_club_data_game_ct g
         WHERE g.club_id = c.id AND g.stat_date = (SELECT max(d.stat_date) FROM public.ca_club_data_game_ct d
           WHERE d.club_id = c.id AND d.stat_date BETWEEN v_start AND v_end)) x)$n$;
  v_def := pg_get_functiondef('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'snapshot data_updated_at statement not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  v_old := 'f.stat_date = ANY (v_days)';
  v_new := 'f.stat_date BETWEEN v_start AND v_end';
  v_def := pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 4 THEN
    RAISE EXCEPTION 'screen v_days probes not found exactly four times';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$migration$;

COMMIT;
