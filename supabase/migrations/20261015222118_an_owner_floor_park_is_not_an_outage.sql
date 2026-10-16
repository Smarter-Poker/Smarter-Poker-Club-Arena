-- 20261015222118_an_owner_floor_park_is_not_an_outage.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- AN OWNER FLOOR PARK IS NOT AN OUTAGE
-- ============================================================================
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh) on 2026-10-15:
--
--   16:53:27Z  the owner parked the floor (operation 3d9c1ba1, "Owner Horse
--              Wallet Reset: Cash Floor Closed For One Hour From The 16:55 UTC
--              Break"), scoped to 7 clubs/unions. Those 7 hold 11,067 of the
--              11,076 non-deleted cash tables and every cash hand dealt that
--              day.
--   17:01:09Z  close_cash (fb484cc1) closed 115 cash tables.
--   17:04:00Z  fn_ca_operator_floor_hold_watchdog raised a CRITICAL financial
--              alert because the hold was 10 minutes old (three alert rows).
--   17:15Z     TournamentNeverStarted: two 17:00 MTTs (248 and 530 entrants)
--              whose start fn_ca_launch_tournament_admission_guard refused
--              because the park held their club.
--   17:26-17:48Z  SpinUnfilledBacklog, SpinFleetProducingNothing: Spin boards
--              the park refused to start counted as open and unfilled.
--   17:41:32Z  the owner's program renewed the lease to 18:53 (an off-cycle
--              freeze interrupted the reset).
--   18:10:56Z  the owner's program resumed the floor (b930a4a2). By 18:19
--              2,665 hands had been dealt, 71 tournaments were RUNNING and
--              both MTTs had started.
--   18:19Z     the watchdog alert was still open: nine closes of fb484cc1
--              name tables that no longer exist, fn_ca_launch_cash_close_resumed
--              joins tables and can never prove them resumed, and the
--              resolution (d) waited on every close platform-wide.
--
-- Every one of those pages measured a deliberate, owner-renewed park as an
-- outage. The lease of 20261014231111 already guarantees a park ends: within
-- one TTL (60 minutes) unless the program that took it renews it, which it can
-- only do as service_role for its own operation, and it is released by the
-- watchdog the minute it lapses.
--
-- WHAT CHANGES
--
-- 1. fn_ca_operator_floor_park_holds(club, union): the exact predicate
--    fn_ca_launch_tournament_held enforces (a 'park' hold whose launch scope
--    names the club or union), without its advisory locks, because a read
--    for a gauge must never queue behind the operator lane.
-- 2. fn_tournament_metrics.overdue_start, fn_spin_metrics.open_boards and
--    fn_spin_fill_waits leave out events the park holds. They count again the
--    moment the hold row is gone, so an event still unstarted after a park
--    still pages, and an event in a club outside the park pages as before.
-- 3. fn_ca_operator_floor_park_share() reports, for the engine gauge
--    poker_operator_floor_park_share, how much of the cash floor the current
--    hold refuses: tables open now or closed by a close not yet resumed, in
--    the hold's scope, over all of them (1 for an unscoped hold, 0 with no
--    hold). Measured on 2026-10-15 for 3d9c1ba1: every cash table open or
--    closed under it was in its scope (share 1.0); its seven clubs hold
--    11,067 of the 11,076 non-deleted cash tables. The fleet rules stand
--    down only at a share >= 0.5, because their thresholds sit at half the
--    healthy floor or below
--    (HorseCashActionsStopped 150 of 313/min, HorseFleetThroughputRelativeDrop
--    0.5 of the same hour), so a park of less than half the floor cannot
--    explain their breach and does not silence them.
-- 4. The watchdog pages when nobody is keeping the hold, not because it is
--    ten minutes old: when the lease runs out with no renewal and no resume
--    (the program that took it is gone; the watchdog releases it in the same
--    pass), or when renewals carry it past the ceiling
--    fn_ca_operator_floor_hold_page_after(), now 180 minutes. Basis: the only
--    two parks ever taken were this one (planned 60 minutes, renewed once,
--    resumed at 77) and the abandoned 2026-10-13 park (34 hours). 180 minutes
--    is the planned hour plus two renewals: a deliberate program still at it
--    after three hours is worth a person's attention. The alert resolves
--    when the hold is gone and no EXISTING table is still refused; a close of
--    a deleted table refuses nothing.
--
-- Nothing here moves money, a seat or a hold. It changes what three reads
-- count and when one watch pages.
--
-- HOW: the pinned-preimage substitution of 20261007212545. Each live text
-- must hash to the md5 measured read-only on production on 2026-10-15, every
-- anchor must occur exactly once, and each result must hash to the postimage
-- derived on production with replace(); owner, SECURITY DEFINER, proconfig
-- and grants must not move.
--
-- Regression: scripts/ci/test-owner-floor-park.py (native PostgreSQL), run by
-- .github/workflows/owner-floor-park.yml.
--
-- V2 (replaces held PR #7006, migration 20261015181538, refused at install with
-- "substituted text is not the derived postimage"). Re-derived on
-- 2026-10-15 22:2x UTC over the live text with a fresh version: every live
-- preimage md5 still equals the pinned one, every anchor occurs exactly once,
-- and each postimage below is the md5 of replace() run read-only on production
-- over this file's own anchors and replacements. The replacements carry this
-- migration's version in their comments, so the postimages are new. The
-- pg_temp helper has a name no other held body uses (the diamond cluster body
-- also defined pg_temp.ca_floor_subst), so two bodies run in one session can
-- never meet each other's helper.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_ca_operator_floor_park_share()')) AND md5(pg_get_functiondef('public.fn_tournament_metrics(integer,integer,integer)'::regprocedure)) = '26e08b560250346a619faeb3bc1353af' AND md5(pg_get_functiondef('public.fn_spin_metrics(integer)'::regprocedure)) = 'c3eec000c70e31cfcc3c38b8bac998fe' AND md5(pg_get_functiondef('public.fn_spin_fill_waits()'::regprocedure)) = '48c2dd2b931210349e412ea139a8a16a' AND md5(pg_get_functiondef('public.fn_ca_operator_floor_hold_page_after()'::regprocedure)) = '3a43a57ded6d67fdbf6f6db9b67bff7e' AND md5(pg_get_functiondef('public.fn_ca_operator_floor_hold_watchdog()'::regprocedure)) = 'a75ce8a90eaf1bbf6f6b28187233628e')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The park predicate, lock-free.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_park_holds(p_club uuid, p_union uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The predicate fn_ca_launch_tournament_held enforces for creation and start
  -- (a scoped 'park' hold naming the club or union), read without its locks.
  SELECT EXISTS (
    SELECT 1
      FROM public.ca_operator_floor_hold h
      JOIN public.ca_launch_operator_scopes m ON m.operation_id = h.operation_id
     WHERE h.mode = 'park'
       AND (p_club = ANY (m.club_ids) OR p_union = ANY (m.club_ids)))
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_park_holds(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_park_holds(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. How much of the cash floor the current hold refuses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_park_share()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '10s'
AS $function$
  WITH h AS (
    SELECT h.operation_id, h.mode, h.held_since, h.expires_at, m.club_ids
      FROM public.ca_operator_floor_hold h
      LEFT JOIN public.ca_launch_operator_scopes m ON m.operation_id = h.operation_id
  ),
  -- The cash floor: tables open now, and tables an operator close has closed
  -- and nobody has resumed yet (they are the floor the park took away).
  floor AS MATERIALIZED (
    SELECT t.club_id, t.union_id
      FROM public.tables t
     WHERE t.tournament_id IS NULL
       AND NOT coalesce(t.is_deleted, false)
       AND (lower(coalesce(t.status, '')) IN ('waiting', 'running', 'playing', 'active')
            OR EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                        WHERE c.table_id = t.id
                          AND public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE))
  ),
  counted AS (
    SELECT h.*,
           (SELECT count(*) FROM floor) AS floor_tables,
           CASE WHEN h.club_ids IS NULL THEN (SELECT count(*) FROM floor)
                ELSE (SELECT count(*) FROM floor f
                       WHERE f.club_id = ANY (h.club_ids) OR f.union_id = ANY (h.club_ids)) END AS held_tables
      FROM h
  )
  SELECT COALESCE(
    (SELECT jsonb_build_object(
              'held', true, 'operation_id', c.operation_id, 'mode', c.mode,
              'scoped', c.club_ids IS NOT NULL, 'held_since', c.held_since, 'expires_at', c.expires_at,
              'floor_tables', c.floor_tables, 'held_tables', c.held_tables,
              'share', CASE WHEN c.club_ids IS NULL THEN 1
                            WHEN c.floor_tables = 0 THEN 0
                            ELSE round(c.held_tables::numeric / c.floor_tables, 4) END)
       FROM counted c LIMIT 1),
    jsonb_build_object('held', false, 'share', 0))
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_park_share() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_park_share() TO service_role;

-- ---------------------------------------------------------------------------
-- 2 and 4. The reads and the watch, edited in place.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.ca_owner_park_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_owner_park_subst(
  'public.fn_tournament_metrics(integer,integer,integer)',
  '31e04dd645cb7605b968ecd17d992d27', '26e08b560250346a619faeb3bc1353af',
  ARRAY[$o1$      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type = 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int,$o1$],
  ARRAY[$n1$      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type = 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0))
        -- An MTT an owner floor park refuses to start is HELD, not overdue:
        -- fn_ca_launch_tournament_admission_guard refuses its start on exactly
        -- this predicate. It counts again the moment the park ends
        -- (2026-10-15, migration 20261015222118).
        AND NOT public.fn_ca_operator_floor_park_holds(club_id, union_id))::int,$n1$]
);

SELECT pg_temp.ca_owner_park_subst(
  'public.fn_spin_metrics(integer)',
  '7e92b1acfd7b86b557a464c6f4e00a6f', 'c3eec000c70e31cfcc3c38b8bac998fe',
  ARRAY[$o1$    where t.variant = 'spin' and t.status = 'REGISTERING'
  ),
  up as ($o1$],
  ARRAY[$n1$    where t.variant = 'spin' and t.status = 'REGISTERING'
      -- A board an owner floor park refuses to start is held, not open
      -- (2026-10-15, migration 20261015222118).
      and not public.fn_ca_operator_floor_park_holds(t.club_id, t.union_id)
  ),
  up as ($n1$]
);

SELECT pg_temp.ca_owner_park_subst(
  'public.fn_spin_fill_waits()',
  '854aa5e365a23d4a0e18636d158c86b1', '48c2dd2b931210349e412ea139a8a16a',
  ARRAY[$o1$      and t.started_at is null
  ),$o1$],
  ARRAY[$n1$      and t.started_at is null
      -- A Spin an owner floor park refuses to start is held, not unfilled
      -- (2026-10-15, migration 20261015222118).
      and not public.fn_ca_operator_floor_park_holds(t.club_id, t.union_id)
  ),$n1$]
);

SELECT pg_temp.ca_owner_park_subst(
  'public.fn_ca_operator_floor_hold_page_after()',
  'c6db5997e05882d94d12be245ff05dda', '3a43a57ded6d67fdbf6f6db9b67bff7e',
  ARRAY[$o1$SELECT interval '10 minutes'$o1$],
  ARRAY[$n1$SELECT interval '180 minutes'$n1$]
);

SELECT pg_temp.ca_owner_park_subst(
  'public.fn_ca_operator_floor_hold_watchdog()',
  '9f8b378e6a8cf3a340fe9c007e680e8a', 'a75ce8a90eaf1bbf6f6b28187233628e',
  ARRAY[$o1$    -- (a) A hold older than the page threshold is an incident, once.
    IF h.held_since <= v_now - public.fn_ca_operator_floor_hold_page_after()
       AND public.fn_ca_operator_floor_hold_open_alert(h.operation_id) IS NULL THEN$o1$,
        $o2$        format('The operator floor has been %s for %s minutes by operation %s ("%s"), %s. It is refusing every seat on %s open cash table(s)%s. '$o2$,
        $o3$'scoped', scope.operation_id IS NOT NULL, 'club_ids', to_jsonb(scope.club_ids), 'refusing_tables', v_refusing_tables));$o3$,
        $o4$     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                      WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE);$o4$],
  ARRAY[$n1$    -- (a) A hold is an incident when nobody is keeping it: its lease ran out
    -- with no renewal and no resume (the program that took it is gone, and
    -- (b) releases it in this same pass), or it has been renewed past the
    -- ceiling fn_ca_operator_floor_hold_page_after(). A park inside a lease
    -- its owner keeps renewing is deliberate and is not an outage
    -- (2026-10-15, migration 20261015222118). Once per operation.
    IF (h.expires_at <= v_now
        OR h.held_since <= v_now - public.fn_ca_operator_floor_hold_page_after())
       AND public.fn_ca_operator_floor_hold_open_alert(h.operation_id) IS NULL THEN$n1$,
        $n2$        format(CASE WHEN h.expires_at <= v_now
                    THEN 'Nobody renewed or resumed this floor hold before its lease ran out; this watchdog releases it now. '
                    ELSE 'This floor hold has been renewed past its ceiling. ' END
               || 'The operator floor has been %s for %s minutes by operation %s ("%s"), %s. It is refusing every seat on %s open cash table(s)%s. '$n2$,
        $n3$'scoped', scope.operation_id IS NOT NULL, 'club_ids', to_jsonb(scope.club_ids), 'refusing_tables', v_refusing_tables,
          'page_reason', CASE WHEN h.expires_at <= v_now THEN 'lease_expired_unrenewed' ELSE 'held_past_ceiling' END));$n3$,
        $n4$     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                      WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE
                        -- A close whose table no longer exists refuses no seat,
                        -- and it can never be proven resumed (the proof joins
                        -- tables). Nine such closes kept the 2026-10-15 alert
                        -- open after the floor reopened (migration 20261015222118).
                        AND EXISTS (SELECT 1 FROM public.tables t
                                     WHERE t.id = c.table_id AND NOT coalesce(t.is_deleted, false)));$n4$]
);

COMMIT;
