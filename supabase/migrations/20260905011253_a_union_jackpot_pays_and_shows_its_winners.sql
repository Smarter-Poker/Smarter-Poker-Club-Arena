-- ═══════════════════════════════════════════════════════════════════════════
--  A UNION JACKPOT PAYS, AND SHOWS ITS WINNERS
--  BBJ full audit, 2026-09-04/05 (docs/changelog/2026-09-05-bbj-full-audit.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two defects on the union jackpot, both found by probing the live payout
-- path inside a transaction that was rolled back (CLAUDE.md §11.5). Both are
-- fixed here in ONE transaction: one schema-cache reload (§2 DDL policy), and
-- neither is worth shipping without the other.
--
-- ───────────────────────────────────────────────────────────────────────────
-- DEFECT A - A UNION JACKPOT WITH A DEPARTED RECIPIENT DOES NOT PAY AT ALL
-- ───────────────────────────────────────────────────────────────────────────
--
-- Union tables are owned by the union's shell club (Midway Union,
-- fade0000-...-0001). A player at one of them bought in from SHARK CLUB or
-- Club JAQK - `table_seats.club_id` records which - and is usually NOT a
-- member of the shell club at all.
--
-- `bbj_credit_one_recipient` pays a recipient who has LEFT the table to a
-- club wallet, and resolved that wallet as `tables.club_id` FIRST. On a union
-- table that is the shell club; the player has no `club_members` row there;
-- the UPDATE matches nothing; the function RAISES "did not take the credit";
-- and because every credit runs inside bbj_atomic_payout_v2's single
-- transaction, the WHOLE jackpot payout fails - pool untouched, nobody paid,
-- no bbj_payouts row, no winners row, only a reportError in the engine log.
-- The engine does not retry, and a retry would fail the same way.
--
-- Probe that found it (rolled back): NLH 0.10/0.25 Classic, 7 dealt in, two
-- marked departed ->
--   ERROR P0001: bbj_credit_one_recipient: the club wallet for ccced697-...
--   in fade0000-...-0001 did not take the credit
--
-- Any jackpot on a union table where one dealt-in player had left before
-- postHandTasks ran (a bust-out, a tab close) would have gone unpaid. The
-- comment in the function even says "the wallet of the TABLE's club - the one
-- the seat was bought in from": on a union table those are two different
-- clubs, and it chose the wrong one.
--
-- THE FIX: resolve the wallet in the order the chips actually flow -
--   1. the club the SEAT was bought in from (`table_seats.club_id`, most
--      recent seat, which for a departed player is the row with left_at set),
--      where the player holds an active/approved membership;
--   2. the table's own club, if the player is an active member there
--      (a standalone club: identical to before);
--   3. the player's home club (unchanged last resort).
-- The membership predicate is the same one fn_ensure_club_wallet /
-- fn_player_home_club use, so a club that cannot take the credit is never
-- chosen and the RAISE below it becomes what it was meant to be: unreachable.
--
-- ───────────────────────────────────────────────────────────────────────────
-- DEFECT B - A UNION JACKPOT'S WINNERS ARE VISIBLE TO NOBODY
-- ───────────────────────────────────────────────────────────────────────────
--
-- `bbj_atomic_payout_v2` writes the "Previous Winners" row (`bbj_winners`)
-- with `club_id := bbj_pools.club_id`. A UNION pool has no club_id - the row
-- is keyed by union_id - so every winner the union pool has ever paid was
-- written with `club_id = NULL`. All five rows on the live union pool
-- (f9806a7f, $104k main jackpot, 3 clubs) are NULL.
--
-- The SELECT policy on `bbj_winners` was
--
--     EXISTS (SELECT 1 FROM club_members cm
--              WHERE cm.club_id = bbj_winners.club_id AND cm.user_id = auth.uid())
--
-- which can never be true for a NULL club_id. Verified live as a member of a
-- union club: `SELECT count(*) FROM bbj_winners WHERE pool_id = <union pool>`
-- returns 0 while `fn_bbj_recent_hits(<union pool>)` (SECURITY DEFINER over
-- bbj_payouts) returns 5. So for every union on the platform the lobby ticker
-- (BBJTicker.tsx reads bbj_winners directly) lists no hits, and the Realtime
-- `bbj_winners` INSERT that refreshes the ticker, the Recent Hits list and
-- the BadBeatJackpotPage is delivered to nobody, because Realtime applies the
-- same RLS to every subscriber. A standalone club's winners were visible; a
-- union club's were not - the "same data across the board" asymmetry Dan
-- forbade on 2026-08-25 (20260825_bbj_visible_to_all_lobby_viewers.sql).
--
-- THE FIX (three parts):
--   1. bbj_winners becomes readable by the same rule as bbj_pools: everyone.
--      A club's Bad Beat Jackpot is not private money (Dan 2026-08-25), the
--      pool row is already `USING (true)`, the lobby prints the winners with
--      the anon key, and fn_bbj_recent_hits already returns MORE than this
--      table holds (hole cards, board, per-recipient amounts) to anyone who
--      knows the pool id. Names here are arena aliases since 20260903122000.
--      Writes stay closed: no INSERT/UPDATE/DELETE policy; the payout RPC is
--      SECURITY DEFINER.
--   2. The winner row records the club the hand was PLAYED in
--      (`tables.club_id`), falling back to the pool's club.
--   3. Backfill the NULL rows the same way.
--
-- ───────────────────────────────────────────────────────────────────────────
-- GENERATED REWRITES, same technique and same reason as 20260903122000: these
-- are money functions. Each live definition is read back, ONE anchor block is
-- replaced, and a round-trip assertion proves nothing else moved. Both are
-- idempotent: a second apply finds the marker and leaves the function alone.
--
-- ROLLBACK: apply the inverse replacement (new block -> old block); every
-- string is written out verbatim below.

BEGIN;

-- ═══ DEFECT A: bbj_credit_one_recipient resolves the SEAT's club first ═════
DO $mig$
DECLARE
  v_old text;
  v_new text;
  v_anchor text := $a$  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = p_table_id;
  IF v_club IS NULL THEN
    SELECT s.club_id INTO v_club FROM public.table_seats s
     WHERE s.table_id = p_table_id AND s.user_id = p_user_id ORDER BY s.joined_at DESC LIMIT 1;
  END IF;
$a$;
  v_replacement text := $r$  /* THE SEAT'S CLUB FIRST (BBJ audit 2026-09-05). On a union table the
     table belongs to the union's shell club and the player is a member of
     SHARK CLUB or Club JAQK - table_seats.club_id says which one the buy-in
     came from. Resolving tables.club_id first picked the shell club, no
     club_members row matched, the UPDATE below took nothing, the RAISE fired,
     and the entire jackpot payout rolled back unpaid. Every candidate is
     checked for an active membership so a club that cannot take the credit is
     never chosen. */
  SELECT s.club_id INTO v_club FROM public.table_seats s
   WHERE s.table_id = p_table_id AND s.user_id = p_user_id AND s.club_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = p_user_id AND cm.club_id = s.club_id
                    AND cm.status IN ('active', 'approved'))
   ORDER BY s.joined_at DESC LIMIT 1;
  IF v_club IS NULL THEN
    SELECT t.club_id INTO v_club FROM public.tables t
     WHERE t.id = p_table_id AND t.club_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.club_members cm
                    WHERE cm.user_id = p_user_id AND cm.club_id = t.club_id
                      AND cm.status IN ('active', 'approved'));
  END IF;
$r$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'bbj_credit_one_recipient';
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient not found';
  END IF;

  IF position('THE SEAT''S CLUB FIRST' IN v_old) > 0 THEN
    RAISE NOTICE 'bbj_credit_one_recipient already resolves the seat club first; untouched';
  ELSE
    IF (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient: expected exactly one wallet-resolution anchor';
    END IF;
    v_new := replace(v_old, v_anchor, v_replacement);
    IF v_new = v_old THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient rewrite produced no change';
    END IF;
    EXECUTE v_new;
    SELECT pg_get_functiondef(p.oid) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = 'bbj_credit_one_recipient';
    IF replace(v_new, v_replacement, v_anchor) <> v_old THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient round-trip assertion failed: more than the wallet resolution changed';
    END IF;
  END IF;
END
$mig$;

-- ═══ DEFECT B (1): bbj_winners read policy = bbj_pools read policy ══════════
DROP POLICY IF EXISTS bbj_winners_select_member ON public.bbj_winners;
DROP POLICY IF EXISTS bbj_winners_select ON public.bbj_winners;
CREATE POLICY bbj_winners_select ON public.bbj_winners
  FOR SELECT USING (true);

COMMENT ON POLICY bbj_winners_select ON public.bbj_winners IS
  'Previous Winners are lobby data (Dan 2026-08-25: the jackpot is the same for everyone who can see the lobby). World-readable like bbj_pools; the old membership rule matched club_id, which a union pool leaves NULL, so union winners were visible to nobody and their Realtime INSERTs reached nobody.';

-- ═══ DEFECT B (3): backfill - the club the hand was played in ═══════════════
UPDATE public.bbj_winners w
   SET club_id = t.club_id
  FROM public.tables t
 WHERE w.club_id IS NULL
   AND t.id = w.table_id
   AND t.club_id IS NOT NULL;

-- ═══ DEFECT B (2): the payout RPC stamps the hitting table's club ═══════════
DO $mig$
DECLARE
  v_old text;
  v_new text;
  v_anchor text := $a$  INSERT INTO bbj_winners (pool_id, club_id, winner_id, loser_id, winner_display_name, loser_display_name,$a$;
  v_resolve text := $r$  /* THE CLUB THE HAND WAS PLAYED IN (BBJ audit 2026-09-05). A union pool has
     no club_id of its own, so v_club_id from the pool row above is NULL for
     every union hit and the Previous Winners row said the jackpot happened
     nowhere. The hitting table always knows its club. */
  SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = p_table_id AND t.club_id IS NOT NULL;
  IF v_club_id IS NULL THEN
    SELECT bp2.club_id INTO v_club_id FROM public.bbj_pools bp2 WHERE bp2.id = p_pool_id;
  END IF;
$r$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'bbj_atomic_payout_v2';
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 not found';
  END IF;

  IF position('THE CLUB THE HAND WAS PLAYED IN' IN v_old) > 0 THEN
    RAISE NOTICE 'bbj_atomic_payout_v2 already resolves the hitting club; untouched';
  ELSE
    IF (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'bbj_atomic_payout_v2: expected exactly one bbj_winners INSERT anchor';
    END IF;
    v_new := replace(v_old, v_anchor, v_resolve || v_anchor);
    IF v_new = v_old THEN
      RAISE EXCEPTION 'bbj_atomic_payout_v2 rewrite produced no change';
    END IF;
    EXECUTE v_new;
    SELECT pg_get_functiondef(p.oid) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = 'bbj_atomic_payout_v2';
    IF replace(v_new, v_resolve, '') <> v_old THEN
      RAISE EXCEPTION 'bbj_atomic_payout_v2 round-trip assertion failed: more than the club resolution changed';
    END IF;
  END IF;
END
$mig$;

-- ═══ Assertions: abort if the board moved underneath this ═══════════════════
DO $$
DECLARE v_null integer; v_pol integer;
BEGIN
  SELECT count(*) INTO v_null FROM public.bbj_winners w
   WHERE w.club_id IS NULL
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = w.table_id AND t.club_id IS NOT NULL);
  IF v_null <> 0 THEN
    RAISE EXCEPTION 'bbj_winners backfill left % row(s) with a resolvable NULL club_id', v_null;
  END IF;
  SELECT count(*) INTO v_pol FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'bbj_winners' AND policyname = 'bbj_winners_select' AND cmd = 'SELECT';
  IF v_pol <> 1 THEN
    RAISE EXCEPTION 'bbj_winners_select policy missing after apply';
  END IF;
  IF position('THE SEAT''S CLUB FIRST' IN pg_get_functiondef('public.bbj_credit_one_recipient'::regproc)) = 0 THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient was not rewritten';
  END IF;
  IF position('THE CLUB THE HAND WAS PLAYED IN' IN pg_get_functiondef('public.bbj_atomic_payout_v2'::regproc)) = 0 THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 was not rewritten';
  END IF;
END $$;

COMMIT;
