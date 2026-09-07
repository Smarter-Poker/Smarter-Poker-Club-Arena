BEGIN;
SET LOCAL lock_timeout = '8s';

/* "I COULD NOT TELL" HAD NO NAME, AND IT COST SEVENTEEN DAYS (CLAUDE.md 10.86).
   ---------------------------------------------------------------------------
   Measured 2026-09-07: the main Bad Beat Jackpot last paid on 2026-08-21
   06:04:16. In the seventeen days since, `bbj_contributions` took the highest
   volume in the platform's history - 277,332 rows in the week of 2026-08-31
   against 175,939 in the week of 2026-08-17, which produced NINE hits - and the
   jackpot paid nothing at all. At the 08-17 rate that week alone expected ~14.

   And the platform could not say why, because "no qualifying hand occurred" and
   "a qualifying hand occurred and something refused it" were THE SAME
   OBSERVATION. `detectBBJNearMiss` has run on every showdown since 2026-08-18
   and its answer goes to a `console.log` and a hub event that expires in
   seconds. `bbj_hand_evidence_log` looks like the place this would live and is
   written only by triggers on the PAYOUT path, so it is empty by construction
   whenever nothing pays - it can only ever describe jackpots that happened.

   This table is the missing third outcome. One row per hand that reached the
   jackpot decision with a losing hand good enough to be interesting, carrying
   WHICH GATE refused it. It is not a monitor standing in for a fix (10.12): it
   is the instrument that makes "are the rules too strict" a question anyone can
   answer from rows instead of from an argument.

   VOLUME. This is deliberately NOT one row per hand - 221k hands a day would be
   another `hand_history`. `detectBBJNearMiss` fires only on a showdown where
   somebody held a genuinely big losing hand; the comparable population, the
   mini's qualifying set, was measured at 4.29 a day across the whole estate.
   Ninety days of retention at that rate is under 400 rows. */

CREATE TABLE IF NOT EXISTS public.bbj_near_misses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  table_id      uuid,
  club_id       uuid,
  hand_number   bigint,
  variant       text,
  big_blind     numeric,
  pot_size      numeric,
  players_dealt integer,
  user_id       uuid,
  hand_name     text,
  /* WHICH GATE REFUSED. The whole point of the row: `pot_below_floor`,
     `not_enough_dealt`, `no_ace_in_hand`, `both_cards_did_not_play`,
     `winner_not_strong_enough`, and so on. A near miss with no reason is a
     detector that answered without knowing, which is what 10.86 forbids. */
  reason        text,
  message       text
);

COMMENT ON TABLE public.bbj_near_misses IS
  'Hands that reached the Bad Beat Jackpot decision, made a qualifying-sized losing hand, and were refused - with the gate that refused them. Written by the engine at settlement, fire-and-forget, and never able to gate a payout. Exists because between 2026-08-21 and 2026-09-07 the jackpot paid nothing on record volume and nothing in this database could say whether that was the rules working or the rules broken (CLAUDE.md 10.86).';

CREATE INDEX IF NOT EXISTS idx_bbj_near_misses_at ON public.bbj_near_misses (at DESC);
CREATE INDEX IF NOT EXISTS idx_bbj_near_misses_reason ON public.bbj_near_misses (reason, at DESC);

ALTER TABLE public.bbj_near_misses ENABLE ROW LEVEL SECURITY;

/* Operator telemetry, not a public page - the same ruling phase 5 applied to
   the jackpot books in 20260907171547. No browser role may read or write it. */
REVOKE ALL ON TABLE public.bbj_near_misses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.bbj_near_misses TO service_role;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.bbj_near_misses', 'SELECT')
     OR has_table_privilege('authenticated', 'public.bbj_near_misses', 'SELECT')
     OR has_table_privilege('anon', 'public.bbj_near_misses', 'INSERT')
     OR has_table_privilege('authenticated', 'public.bbj_near_misses', 'INSERT') THEN
    RAISE EXCEPTION 'a browser role can reach the near-miss log';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.bbj_near_misses', 'INSERT') THEN
    RAISE EXCEPTION 'the engine cannot write the near-miss log, so it would be empty by construction - which is the defect this closes';
  END IF;
END $$;

COMMIT;
