-- 20261016013324_an_empty_event_is_not_overdue_until_its_cancel_is.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN EVENT NOBODY ENTERED IS NOT OVERDUE UNTIL ITS CANCEL IS (2026-10-16)
--
-- TournamentNeverStarted (poker_tournaments_overdue_start > 0 for 5m) paged
-- at 19:15 UTC on 2026-10-15 (operational_alert_events 254626, resolved
-- 19:31, 254627) and at 19:16 UTC on 2026-10-12, and will page every day at
-- 19:15. Read from production on 2026-10-16:
--
--   * the overdue event is "Daily 25 Chip Freezeout" (ba1d67c9 on 10-15),
--     an MTT of the one-member Lightning Internal Pilot club spawned daily by
--     schedule 91e49749 for 19:00 UTC. It had 0 tournament_players rows and
--     current_players 0, and it was CANCELLED at 19:30:06;
--   * that cancel is the engine's designed outcome for an event nobody
--     entered (server/src/tournament/emptyPastStartEvent.ts, #6907,
--     EMPTY_PAST_START_CANCEL_AFTER_MS = 30 minutes): no entrant, so nothing
--     to refund and nobody waiting;
--   * fn_tournament_metrics counted that same event as overdue at
--     p_overdue_minutes (10) past start, twenty minutes BEFORE the engine is
--     designed to decide it. The gauge and the engine disagree about one
--     event, and the gauge pages on the engine doing its job.
--
-- The detector is the defect (CLAUDE.md 10.11 and the round 5 brief: a
-- detector that fires on a non-defect is itself the defect). The fix is in
-- the detector's predicate: an MTT with a registered or playing entrant (the
-- same roster the engine reads, tournament_players status registered or
-- playing, or a nonzero counter) counts at p_overdue_minutes exactly as
-- before. An MTT with NO entrant counts only once the engine's 30-minute
-- cancel is itself p_overdue_minutes late, so a cancel path that stops
-- working still pages, 40 minutes past start instead of 10. Nothing else in
-- the function changes: the owner park exclusion (20261015222118), the other
-- five gauges and the seat-first gauge are byte-identical.
--
-- Pinned-preimage substitution: the live pg_get_functiondef md5 is pinned,
-- the one anchor occurs exactly once, the postimage md5 was derived
-- read-only on production with replace(), and owner, SECURITY DEFINER,
-- search_path and grants are proven unchanged after the replace.
--
-- Regression: scripts/ci/test-an-empty-event-is-not-overdue.py on native
-- PostgreSQL (the live definition captured 2026-10-16, md5 26e08b56...), run
-- by .github/workflows/an-empty-event-is-not-overdue.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_tournament_metrics(integer,integer,integer)'::regprocedure)) = '3f79a8eef4de9068eb9f0acbfc303dc0'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_empty_event_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_empty_event_subst(
  'public.fn_tournament_metrics(integer,integer,integer)',
  '26e08b560250346a619faeb3bc1353af', '3f79a8eef4de9068eb9f0acbfc303dc0',
  ARRAY[$eo1$        AND NOT public.fn_ca_operator_floor_park_holds(club_id, union_id))::int,$eo1$],
  ARRAY[$en1$        AND NOT public.fn_ca_operator_floor_park_holds(club_id, union_id)
        -- AN EVENT NOBODY ENTERED IS NOT OVERDUE UNTIL ITS CANCEL IS
        -- (2026-10-16). The engine cancels a registration-first event with no
        -- registered or playing entrant 30 minutes past its start
        -- (server/src/tournament/emptyPastStartEvent.ts, #6907): nobody is
        -- waiting for it and nothing is refunded. Counting it at 10 minutes
        -- paged TournamentNeverStarted every day at 19:15 UTC on the empty
        -- Daily 25 Chip Freezeout of a one-member pilot club, which the
        -- engine then cancelled at 19:30. An empty event counts only once
        -- that cancel is overdue too; an event anyone entered counts at
        -- p_overdue_minutes exactly as before.
        AND (EXISTS (SELECT 1 FROM tournament_players tp
                      WHERE tp.tournament_id = tournaments.id
                        AND tp.status IN ('registered','playing'))
             OR COALESCE(current_players, 0) <> 0
             OR start_time < now() - make_interval(mins => 30 + GREATEST(p_overdue_minutes, 0))))::int,$en1$]
);

COMMIT;
