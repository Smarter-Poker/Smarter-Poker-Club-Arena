-- 20260909034714_the_stranded_pko_bounties_can_settle.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  FORTY-NINE BOUNTIES THAT COULD NEVER BE PAID
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_claim_bounty_legacy_candidate` refuses any bounty claim for a hand BEFORE
-- the tournament's PKO settlement watermark - `pko_order_already_advanced` -
-- because a progressive bounty's halves must settle in hand order. The guard is
-- correct. But a hand number never changes, so a claim that arrives late is
-- refused for ever.
--
-- The elimination sweep was handing busts over in the WRONG order: it sorted by
-- chips, and every busted candidate holds zero, so the comparator returned 0 for
-- every pair and the order was whatever Postgres returned. #3920 fixed that -
-- busts are now processed in the hand they happened in, so the watermark advances
-- monotonically and cannot overtake a claim that has not been made yet.
--
-- #3920 stops NEW strandings. It cannot release the ones already behind. This
-- migration does exactly that, and nothing else.
--
-- WHAT IS THERE, READ AND NOT ASSUMED (2026-09-09 03:40 UTC):
--
--   tournament                        stranded  window  elim  obligations
--   1776979f Late Night PKO (PLO4)          12      19     7            7
--   32994c65 DSS Tuesday $16.50 NLH         15      21     6            6
--   a50be0b4 Union PKO Afternoon (PLO4)     22      33    11           11
--
-- All three are RUNNING and DEAD - last hands at 22:46, 01:14 and 19:00, so
-- between two and eight and a half hours of nothing. Each holds 16, 18 and 27
-- players still `playing`, of whom 12, 15 and 22 hold zero chips: the stranded
-- ones. They block the field count, so the events cannot progress or end.
--
-- THE SAFETY ARGUMENT, WHICH IS THE WHOLE POINT:
--
--   * In every window this re-exposes, the number of bounty obligations EQUALS
--     the number of already-ELIMINATED candidates - 7/7, 6/6, 11/11. Every one
--     of those is already settled and its candidate row already reads
--     `eliminated`, which the claim RPC treats as processed.
--   * Every one of the 49 PENDING candidates has ZERO obligations. Their
--     bounties have never been paid to anybody. There is nothing to duplicate,
--     so re-exposing them cannot pay twice - it pays a FIRST time.
--
-- So the money risk this guard exists to prevent is provably absent here, and
-- the migration asserts that invariant itself and ABORTS rather than commit if
-- it does not hold at apply time.
--
-- PROVED FIRST IN A TRANSACTION THAT ABORTED ITSELF (CLAUDE.md 11.5 rule 1):
--   PROBE OK rows=3 invariant_violations=0
--     | 1776979f mark=8364652 stranded=0
--     | 32994c65 mark=8403336 stranded=0
--     | a50be0b4 mark=8222597 stranded=0
--
-- NOT A BAND-AID (CLAUDE.md 10.12). This builds no back-pay job, no sweep and
-- no compensating write. It corrects ONE cursor value per tournament so the
-- platform's own live elimination path can do the work it was always supposed
-- to do, and the root fix that stops it recurring (#3920) is already shipped.
-- Nothing here runs twice, and nothing here runs again.
--
-- WHO GETS WHAT: each of the 49 is a player who busted and was never recorded
-- as out. Their knocker receives the bounty share the platform's own claim path
-- computes, through that path, once. Nobody is charged, nobody is reversed, and
-- no player who was already paid is touched - their candidates read `eliminated`
-- and are skipped.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- (This migration is DML only, so it triggers no reload at all.)

BEGIN;

DO $migration$
DECLARE
  v_rows integer;
  v_bad  integer;
  v_left integer;
BEGIN
  -- ── THE INVARIANT, CHECKED BEFORE ANYTHING MOVES ───────────────────────────
  -- In every window about to be re-exposed, obligations must equal the
  -- already-eliminated candidates. If one extra obligation exists, something in
  -- that window was settled without its candidate being closed, and lowering the
  -- watermark could pay it again.
  SELECT count(*) INTO v_bad FROM (
    SELECT c.tournament_id,
           count(*) FILTER (WHERE c.state = 'eliminated') AS elim,
           (SELECT count(*) FROM public.tournament_bounty_obligations o
             WHERE o.tournament_id = c.tournament_id
               AND o.hand_number >= min(c.hand_number))   AS obl
      FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id
      JOIN public.tournament_pko_settlement_watermarks w ON w.tournament_id = t.id
     WHERE coalesce(t.is_pko, false)
       AND t.status = 'RUNNING'
       AND c.hand_number >= (
         SELECT min(c2.hand_number)
           FROM public.tournament_knockout_candidates c2
          WHERE c2.tournament_id = c.tournament_id
            AND c2.state = 'pending'
            AND c2.hand_number < w.last_settled_hand_number)
     GROUP BY c.tournament_id
  ) x WHERE elim <> obl;

  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'refusing to commit: % tournament(s) hold bounty obligations that do not match their eliminated candidates - re-exposing that window could pay one twice',
      v_bad;
  END IF;

  -- Lower each watermark to just below its OLDEST stranded candidate, so the
  -- engine replays that window in hand order. Already-eliminated candidates in
  -- it are skipped by the claim RPC; the pending ones settle for the first time.
  WITH lowest AS (
    SELECT c.tournament_id, min(c.hand_number) - 1 AS new_mark
      FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id
      JOIN public.tournament_pko_settlement_watermarks w ON w.tournament_id = t.id
     WHERE c.state = 'pending'
       AND coalesce(t.is_pko, false)
       AND t.status = 'RUNNING'
       AND w.last_settled_hand_number IS NOT NULL
       AND c.hand_number < w.last_settled_hand_number
     GROUP BY c.tournament_id
  )
  UPDATE public.tournament_pko_settlement_watermarks w
     SET last_settled_hand_number = l.new_mark
    FROM lowest l
   WHERE w.tournament_id = l.tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Prove the thing this migration exists to do actually happened.
  SELECT count(*) INTO v_left
    FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id = c.tournament_id
    JOIN public.tournament_pko_settlement_watermarks w ON w.tournament_id = t.id
   WHERE c.state = 'pending'
     AND coalesce(t.is_pko, false)
     AND t.status = 'RUNNING'
     AND w.last_settled_hand_number IS NOT NULL
     AND c.hand_number < w.last_settled_hand_number;

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'refusing to commit: % candidate(s) are still behind their watermark', v_left;
  END IF;

  RAISE NOTICE 'released % PKO watermark(s); no candidate remains behind one', v_rows;
END;
$migration$;

COMMIT;
