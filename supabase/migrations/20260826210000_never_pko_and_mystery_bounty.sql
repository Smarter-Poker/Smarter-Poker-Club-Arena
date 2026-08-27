-- ─────────────────────────────────────────────────────────────────────────────
-- A TOURNAMENT IS NEVER BOTH PKO AND MYSTERY BOUNTY
--
-- Dan 2026-08-26, ruling on handoff ITEM C, verbatim: "no, never pko+mystery
-- bounty ever."
--
-- Why the question existed: fn_collect_bounty's CASE puts pko first, so a
-- hybrid event would pay `paid_cash` as HALF a head while the mystery ladder
-- ranks whole heads — prizeRank would name a rung nobody pulled, so the
-- engine deliberately computes no rank for that mode and the celebration
-- stays silent. Rather than defining semantics for a format that will never
-- exist, the format is now impossible to configure.
--
-- Verified before applying: zero rows in tournaments' entire history carry
-- both flags (both_flags=0, live_both=0), so this validates cleanly.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_never_pko_and_mystery
  CHECK (NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false)));

-- Post-apply assertion: the constraint exists and is validated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournaments'::regclass
       AND conname = 'tournaments_never_pko_and_mystery'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'tournaments_never_pko_and_mystery missing or NOT VALID — migration did not take';
  END IF;
END $$;

-- ROLLBACK:
--   ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_never_pko_and_mystery;
