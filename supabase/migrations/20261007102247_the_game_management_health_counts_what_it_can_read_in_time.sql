-- 20261007102247_the_game_management_health_counts_what_it_can_read_in_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- 1. The Game Management health strip never loads for the two busiest scopes.
--
--    fn_get_game_management_scale_health returned an exact
--    count(*) of public.game_management_events for the scope. Measured
--    2026-10-07 on production:
--
--      scope union fade0000-...-0001   4,212,266 rows
--      scope club  2a1132b9-...        2,529,360 rows
--      count(*) for the union scope    38,111 ms (parallel index-only scan,
--                                      1,404,186 rows per worker)
--
--    The authenticated role's statement_timeout ends it first, so every read
--    of that scope fails: 47 of the 171 statement timeouts in postgres_logs
--    between 07:20 and 10:20 UTC were this function (the largest single
--    source), and GameManagementService.getHealth turns the failure into
--    "Management health is not available for this scope." The figure it was
--    computing is one label on the strip ("N Realtime Events").
--
--    The count now stops at 10,001 rows and the function also returns
--    event_rows_capped. Measured with the same scope in a rolled-back probe:
--    100,001-row cap 1,070 ms; the 10,001-row cap is a tenth of that. The
--    oldest event is read as ORDER BY created_at LIMIT 1 on
--    idx_game_management_events_scope_created_cover (7 ms). Every other key,
--    the authorization, owner, SECURITY DEFINER, search_path and grants are
--    unchanged; CREATE OR REPLACE keeps the ACL.
--
-- 2. The 30-day retention could never keep up.
--
--    Job 'game-management-events-retention' ran once a day at 04:17 and
--    deleted at most 5,000 rows (fn_prune_game_management_events caps a call
--    at 10,000). The table receives 200,000-600,000 rows a day (368,342 on
--    2026-10-06), so it held 6.7 million rows reaching back to 2026-09-02,
--    about 1.6 million of them past the 30 days the health strip itself
--    advertises (retention_days 30). The job reported success every day.
--
--    It now runs at :07 :17 :27 :37 :47 (never inside the :50-:03 break
--    window) with the function's full 10,000 batch: 1.2 million rows a day of
--    capacity. A 10,000-row call took 145 ms in a rolled-back probe. The
--    function, its append-only guard and its 7-day floor are unchanged. This
--    is the retention schedule itself (CLAUDE.md 10.12: a job whose schedule
--    is the product), not a repair.
--
-- Probe before apply: one execute_sql DO block ran the bounded count, the
-- oldest-row read and one 10,000-row prune, then RAISE EXCEPTION:
--   PROBE_ROLLBACK capped_count=100001 in 1070 ms; oldest=2026-09-02 00:52:59
--   in 7 ms; prune deleted 10000 in 145 ms

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pin$
BEGIN
  IF md5(pg_get_functiondef('public.fn_get_game_management_scale_health(text,uuid)'::regprocedure))
     <> '3020c23e99d79e24c9a1c56d609e7595' THEN
    RAISE EXCEPTION 'fn_get_game_management_scale_health changed since it was measured; re-read it before replacing it';
  END IF;
END
$pin$;

CREATE OR REPLACE FUNCTION public.fn_get_game_management_scale_health(p_scope text, p_scope_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_access jsonb; v_authorized boolean; v_scope_clubs uuid[];
  v_event_rows bigint;
BEGIN
  IF p_scope='club' THEN
    v_access:=public.fn_game_creation_access(p_scope_id);
    v_authorized:=COALESCE((v_access->>'allowed')::boolean,false)
      AND v_access->>'union_id' IS NULL;
  ELSIF p_scope='union' THEN
    v_authorized:=public.fn_is_union_operator(p_scope_id,auth.uid());
  ELSE
    v_authorized:=false;
  END IF;
  IF NOT COALESCE(v_authorized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF p_scope='union' THEN
    SELECT COALESCE(array_agg(x.club_id),'{}'::uuid[]) INTO v_scope_clubs
    FROM (
      SELECT p_scope_id AS club_id
      UNION SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id
      UNION SELECT c.id FROM public.clubs c WHERE c.union_id=p_scope_id
    ) x;
  END IF;
  -- Bounded: an exact count of a multi-million-row scope outlived the
  -- caller's statement_timeout (38 s measured), and the strip shows "10,000+".
  SELECT count(*) INTO v_event_rows
    FROM (SELECT 1 FROM public.game_management_events
           WHERE scope_kind=p_scope AND scope_id=p_scope_id
           LIMIT 10001) bounded;
  RETURN jsonb_build_object('ok',true,
    'scheduled_pending',(SELECT count(*) FROM public.managed_game_schedules s
      WHERE s.status IN ('scheduled','executing') AND (
        (s.game_kind='table' AND EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
            OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))))
        OR (s.game_kind='tournament' AND EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
            OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))))
      )),
    'scheduled_rejected_24h',(SELECT count(*) FROM public.managed_game_schedules s
      WHERE s.status='rejected' AND s.completed_at>=now()-interval '24 hours' AND (
        (s.game_kind='table' AND EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
            OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))))
        OR (s.game_kind='tournament' AND EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
            OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))))
      )),
    'event_rows',LEAST(v_event_rows,10000),
    'event_rows_capped',v_event_rows>10000,
    'oldest_event_at',(SELECT e.created_at FROM public.game_management_events e
      WHERE e.scope_kind=p_scope AND e.scope_id=p_scope_id
      ORDER BY e.created_at ASC LIMIT 1),
    'retention_days',30,'page_limit',100);
END;
$function$;

-- The retention schedule. cron.alter_job is a row update in the cron schema,
-- not DDL; it is inside this transaction so both halves land together.
DO $retention$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname='game-management-events-retention';
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'cron job game-management-events-retention is missing';
  END IF;
  PERFORM cron.alter_job(
    job_id := v_job,
    schedule := '7,17,27,37,47 * * * *',
    command := $cmd$SELECT public.fn_prune_game_management_events(now() - interval '30 days', 10000)$cmd$
  );
END
$retention$;

COMMIT;
