-- ============================================================================
-- A UNION CLUB SAW THE UNION'S TABLES AND NONE OF ITS TOURNAMENTS
--
-- Dan, 2026-08-23, from Shark Club's lobby: "YOU SAY SPINS ARE OPEN AND
-- RUNNING, BUT THE CLUBS CAN'T SEE ANY SPINS, HEADS UP OR MTT'S ANYWHERE...
-- THIS HAS GOT TO STOP HAPPENING!"
--
-- WHAT IT ACTUALLY WAS. get_club_home carried the union scope TWICE, once per
-- list, and only one copy was ever fixed:
--
--   tables       THEN (union_id = v_union_id OR (club_id = v_club.id AND is_private))
--   tournaments  THEN (club_id = v_club.id AND is_private = true)     <-- no union
--
-- Two clauses, fifteen lines apart, meant to say the same thing. Somebody
-- fixed the first and did not notice the second. For a union club that means
-- every union cash table, and only the club's OWN PRIVATE tournaments -- of
-- which Shark Club has none.
--
-- Measured before this migration: get_club_home('25450') returned 43 tables
-- and ZERO tournaments, while the union held 36 joinable Spins, 33 MTTs and
-- 21 heads-up games, every one public and readable. That is precisely the
-- screenshot: "42 Games Are Open In This Club, Just None Of This Type."
--
-- It also explains the intermittency reported earlier ("sometimes it displays,
-- then it disappears"). This RPC is the FAST PATH that paints first; the
-- client's own union query is authoritative and does carry the union branch.
-- With a healthy database the real query overwrote the empty fast paint and
-- the games appeared. When it timed out -- repeatedly, all day -- the empty
-- fast paint was all that was left.
--
-- THE FIX THAT MATTERS IS NOT THE MISSING BRANCH. It is that the scope was
-- WRITABLE TWICE. Two hand-maintained copies of one rule will diverge again,
-- and this is at least the second time. There is now exactly ONE predicate,
-- fn_club_home_in_scope, and both lists call it. A future edit cannot fix one
-- and miss the other, because there is no longer an "other". The assertions
-- below fail if anyone inlines a CASE back into either list.
--
-- Written as a plain SQL IMMUTABLE function so Postgres inlines it rather
-- than calling it per row.
--
-- Applied via the Supabase MCP. Verified after: Shark Club sees 87
-- tournaments (33 Spins, 22 heads-up, 32 MTTs) and 43 tables, and
-- fn_club_home_scope_parity returns zero blind clubs.
-- ============================================================================

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_club_home_in_scope') THEN
    RAISE EXCEPTION 'fn_club_home_in_scope is missing - apply 20260823250000 via the Supabase MCP';
  END IF;

  -- The scope may only be written ONCE, and both lists must use it.
  IF (SELECT count(*) FROM regexp_matches(
        (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='get_club_home'),
        'fn_club_home_in_scope', 'g')) <> 2 THEN
    RAISE EXCEPTION 'get_club_home does not route exactly its two lists through the shared scope';
  END IF;

  -- No union club may be blind to its union's tournaments.
  IF EXISTS (SELECT 1 FROM public.fn_club_home_scope_parity()) THEN
    RAISE EXCEPTION 'a union club still sees no tournaments through get_club_home';
  END IF;

  -- The lobby must be able to classify a Spin by what it IS.
  IF (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='get_club_home')
       NOT LIKE '%variant%' THEN
    RAISE EXCEPTION 'get_club_home no longer returns variant - the lobby is back to guessing from the name';
  END IF;
END $check$;
