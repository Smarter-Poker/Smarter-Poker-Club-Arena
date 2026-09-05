-- 20260905015127_the_bbj_page_names_players_by_their_arena_alias.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE BBJ PAGE NAMES PLAYERS BY THEIR ARENA ALIAS
--  BBJ build plan phase 1, 2026-09-05 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
-- POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
--
-- 20260903122000 fixed the SNAPSHOT names that bbj_atomic_payout_v2 writes
-- into bbj_winners (the ticker's source) to fn_arena_name. It left the LIVE
-- read untouched: fn_bbj_recent_hits, which feeds the Bad Beat Jackpot page's
-- Recent Hits list and the club-wide pop-up's winner name, still resolves the
-- bad-beat holder and the hand winner as
--
--     COALESCE(bb.display_name, bb.username, x.winner_display_name, 'Player')
--
-- display_name FIRST - and display_name is an exact copy of full_name on 264
-- of 1,308 profiles. So the same jackpot showed one name on the ticker and,
-- for those players, a real name on the page. Found in the 2026-09-04 audit.
--
-- The recipients breakdown three lines lower in the same function already
-- used fn_arena_name (20260903). This makes the two headline names match it.
--
-- GENERATED REWRITE, same technique as 20260903122000: the live definition is
-- read back, the two name expressions are replaced, and the round-trip
-- assertion proves nothing else moved. Idempotent.
--
-- ROLLBACK: the inverse replacement; both strings are verbatim below.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $mig$
DECLARE
  v_old text;
  v_new text;
  v_bb_old text := $a$COALESCE(bb.display_name, bb.username, x.winner_display_name, 'Player')$a$;
  v_bb_new text := $b$COALESCE(public.fn_arena_name(bb.alias, bb.username, bb.display_name, bb.first_name, bb.last_name, bb.full_name), x.winner_display_name, 'Player')$b$;
  v_hw_old text := $c$COALESCE(hw.display_name, hw.username, x.loser_display_name, 'Player')$c$;
  v_hw_new text := $d$COALESCE(public.fn_arena_name(hw.alias, hw.username, hw.display_name, hw.first_name, hw.last_name, hw.full_name), x.loser_display_name, 'Player')$d$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'fn_bbj_recent_hits';
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits not found';
  END IF;

  IF position(v_bb_new IN v_old) > 0 AND position(v_hw_new IN v_old) > 0 THEN
    RAISE NOTICE 'fn_bbj_recent_hits already names by arena alias; untouched';
  ELSE
    IF (length(v_old) - length(replace(v_old, v_bb_old, ''))) / length(v_bb_old) <> 1
       OR (length(v_old) - length(replace(v_old, v_hw_old, ''))) / length(v_hw_old) <> 1 THEN
      RAISE EXCEPTION 'fn_bbj_recent_hits: expected exactly one bad-beat and one hand-winner name expression';
    END IF;
    v_new := replace(replace(v_old, v_bb_old, v_bb_new), v_hw_old, v_hw_new);
    IF v_new = v_old THEN
      RAISE EXCEPTION 'fn_bbj_recent_hits rewrite produced no change';
    END IF;
    EXECUTE v_new;
    SELECT pg_get_functiondef(p.oid) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = 'fn_bbj_recent_hits';
    IF replace(replace(v_new, v_bb_new, v_bb_old), v_hw_new, v_hw_old) <> v_old THEN
      RAISE EXCEPTION 'fn_bbj_recent_hits round-trip assertion failed: more than the two names changed';
    END IF;
  END IF;
END
$mig$;

DO $$
BEGIN
  IF position('bb.display_name, bb.username' IN pg_get_functiondef('public.fn_bbj_recent_hits'::regproc)) > 0 THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits still prefers display_name for the bad-beat holder';
  END IF;
  IF position('hw.display_name, hw.username' IN pg_get_functiondef('public.fn_bbj_recent_hits'::regproc)) > 0 THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits still prefers display_name for the hand winner';
  END IF;
END $$;

COMMIT;
