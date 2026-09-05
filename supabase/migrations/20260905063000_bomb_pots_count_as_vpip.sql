-- ═══════════════════════════════════════════════════════════════════════════════
-- BOMB POTS COUNT AS VPIP (Dan 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan: "VPIP NEEDS TO WORK FOR EVERY HAND, BOMB POTS COUNT AS A HAND. ANY HAND
-- YOU VOLUNTARILY PUT IN POT BUT INCLUDING ALL BOMB POTS."
--
-- The hand row was always written for a bomb hand (hands counted); the vpip
-- flag was derived from the preflop action log, and a bomb hand has no
-- preflop street, so nobody was ever marked as having put money in. The
-- engine now writes vpip = true for everyone dealt into a bomb hand
-- (server/src/services/supabase/handFacts.ts, isBombPot). This is the
-- backfill for the rows already on file: 1,682 fact rows across 713 bomb
-- hands since 2026-09-01. DML only; no DDL, no PostgREST reload.
-- Applied to production 2026-09-05 03:06 UTC.
--
-- ROLLBACK: none - a bomb hand IS a voluntary pot.

BEGIN;
UPDATE public.ca_hand_facts f
   SET vpip = true
  FROM public.hand_history h
 WHERE h.id = f.hand_id
   AND h.bomb_pot IS NOT NULL
   AND f.vpip = false
   AND f.played_at > now() - interval '14 days';
COMMIT;
