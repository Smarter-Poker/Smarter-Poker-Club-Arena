-- 20261017160101_a_deleted_account_leaves_the_club_data_player_rankings.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: position('dp.status = ''deleted''' in pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure)) > 0 AND position('dp.status = ''deleted''' in pg_get_functiondef('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure)) > 0
--
-- OWNER RULE (Dan, 2026-10-16): deleted players must never appear "inside of
-- any searches or cashier pages or anywhere for that matter. for all clubs and
-- unions. once they are deleted, they should be removed for good, not linger
-- as a deleted stat."
--
-- WHAT WAS LEFT, READ FROM ROWS (2026-10-17): 20261016224731 removed deleted
-- accounts from the directories, rosters, cashier and leaderboards, but the
-- Club Data player ranking (ca_club_player_breakdown and the page core behind
-- ca_club_player_page) builds its list from club_members without asking the
-- profile's status. Club JAQK's last 14 days: 17 players with a result, 12 of
-- them deleted accounts (the retired patterned identities, now SUSPENDED
-- members), listed as "Deleted-xxxxxxxxxxxx" in the Players tab - seen in the
-- 2026-10-17 post-deploy Club Data report.
--
-- WHAT THIS DOES: both functions' `merged` set (the one list that feeds the
-- rows, the totals, player_count and filtered_count alike) now excludes
-- profiles with status 'deleted'. The breakdown and the page therefore still
-- agree with each other (the client refuses a page whose filtered_count
-- differs from the breakdown's player_count), and nothing else in either
-- function changes. Club-level game totals (ca_club_data_snapshot) are not
-- touched. Patched by exact text replacement guarded by the reviewed md5, so
-- a definition changed since review refuses the migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  v_patches jsonb := jsonb_build_array(
    jsonb_build_object(
      'fn', 'public.ca_club_player_breakdown(uuid,date,date,integer)',
      'md5', 'eeae15ae895151d2194c5962f2247b1d'),
    jsonb_build_object(
      'fn', 'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
      'md5', '4c5af1a0f2c251df57e02d18a048b9fc')
  );
  v_edits jsonb := jsonb_build_array(
    jsonb_build_array(
      $o$WHERE COALESCE(w.cash_net,0)<>0$o$,
      $n$WHERE (COALESCE(w.cash_net,0)<>0$n$),
    jsonb_build_array(
      $o$OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0$o$,
      $n$OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0)
        AND NOT EXISTS (SELECT 1 FROM public.profiles dp
                         WHERE dp.id = a.user_id AND dp.status = 'deleted')$n$)
  );
  p jsonb; e jsonb; v_def text; v_new text; v_old text; v_rep text;
BEGIN
  FOR p IN SELECT * FROM jsonb_array_elements(v_patches) LOOP
    v_def := pg_get_functiondef((p->>'fn')::regprocedure);
    IF md5(v_def) <> p->>'md5' THEN
      RAISE EXCEPTION 'CLUB_DATA_DELETED_PATCH_REFUSED: % changed since review (md5 %, expected %)',
        p->>'fn', md5(v_def), p->>'md5';
    END IF;
    v_new := v_def;
    FOR e IN SELECT * FROM jsonb_array_elements(v_edits) LOOP
      v_old := e->>0; v_rep := e->>1;
      IF (length(v_new) - length(replace(v_new, v_old, ''))) / length(v_old) <> 1 THEN
        RAISE EXCEPTION 'CLUB_DATA_DELETED_PATCH_REFUSED: % does not contain exactly one [%]', p->>'fn', v_old;
      END IF;
      v_new := replace(v_new, v_old, v_rep);
    END LOOP;
    EXECUTE v_new;
  END LOOP;
END
$migration$;

COMMIT;
