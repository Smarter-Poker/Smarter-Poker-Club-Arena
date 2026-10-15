-- 20261015024956_the_knockout_door_counts_only_candidates_of_events_still_bei.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE KNOCKOUT DOOR COUNTS ONLY CANDIDATES OF EVENTS STILL BEING PLAYED
-- (2026-10-15)
--
-- fn_ca_conservation_sweep:fn_ca_knockout_door_stalled (34 open alert rows,
-- plus its drift_incident receipts) fired in episodes for weeks, the latest on
-- 2026-10-14 14:52-16:23 UTC, each one reading "1 candidate(s) are waiting
-- with no open rebuy decision, the oldest for 37002.3 minute(s)".
--
-- Read from rows on 2026-10-15: exactly one candidate in
-- public.tournament_knockout_candidates has been unresolved for more than a
-- day, 607ad6b3 (state pending, created 2026-09-18 22:09 UTC). Its tournament,
-- 5a387a75, was CANCELLED on 2026-09-27 14:32 UTC by atomic_cancel_tournament,
-- which refunded the field and marked the entrant eliminated. Nobody is behind
-- that door: the event it belonged to no longer exists. But the read counts
-- every unresolved candidate in the table, so whenever the whole platform went
-- 15 minutes without a knockout (a quiet hour, or a held floor) this one
-- stale row turned the quiet door into a "stopped" one and paged.
--
-- A detector that fires on a non-defect is itself the defect (CLAUDE.md
-- 10.11). The fix is in the read: an unresolved candidate counts only while
-- its tournament is still being played, that is, not COMPLETED, CANCELLED or
-- CANCELED. COMPLETING stays counted (its last knockout may still be owed).
-- Resolved rows still count for last_resolved_at, so the door's clock is
-- unchanged. A real stall (a pending candidate of a RUNNING event) still
-- fires exactly as before. The tournament status is read per pending row
-- through the primary key (measured read-only on production 2026-10-15: one
-- index probe, 307 ms for the 979,933-row scan, the same as today's read).
--
-- HOW: the pinned-preimage exact-substitution pattern of 20261007212545. The
-- live text must hash to today's measured md5, the anchor must occur exactly
-- once (measured read-only on production 2026-10-15: 1), and the result must
-- hash to the postimage derived read-only on production with replace();
-- owner, SECURITY, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-knockout-door-terminal-events.py (native
-- PostgreSQL), run by .github/workflows/knockout-door-terminal-events.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_knockout_door_stalled(integer)'::regprocedure)) = '0ac830e35079db87132632bab2e6cf37')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_knockout_door_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_knockout_door_subst(
  'public.fn_ca_knockout_door_stalled(integer)',
  'd127587cb49af85834ad5144b9401f29', '0ac830e35079db87132632bab2e6cf37',
  ARRAY[$ko1$      FROM public.tournament_knockout_candidates
  )$ko1$],
  ARRAY[$kn1$      FROM public.tournament_knockout_candidates c
     -- A CANDIDATE OF A FINISHED EVENT IS NOBODY WAITING (2026-10-15). A
     -- cancelled or completed event has no door left: its terminal authority
     -- refunded or paid its players. Counting its stale candidate kept this
     -- read firing for 25 days on one candidate of a tournament cancelled on
     -- 2026-09-27. Resolved rows still date the door; the status is read per
     -- pending row only, through the tournaments primary key.
     WHERE c.resolved_at IS NOT NULL
        OR upper(COALESCE((SELECT t.status FROM public.tournaments t
                            WHERE t.id = c.tournament_id), ''))
           NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
  )$kn1$]
);

COMMIT;
