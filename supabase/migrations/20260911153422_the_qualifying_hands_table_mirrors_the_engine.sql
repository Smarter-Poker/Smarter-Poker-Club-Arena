-- ═══════════════════════════════════════════════════════════════════════════
--  THE QUALIFYING-HANDS TABLE TELLS THE TRUTH, AND SAYS IT IS NOT THE RULE
--  BBJ programme phase 4 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `public.bbj_qualifying_hands` is a THIRD copy of the jackpot's qualifying
-- rule. The rule is actually enforced by `BBJ_QUALIFYING_HANDS` in
-- `server/src/config/RakeConfig.ts`; the client mirrors it in
-- `src/config/RakeConfig.ts`; this table mirrors nothing and is read by
-- NOTHING. The only references to it anywhere in the tree are a cleanup
-- DELETE (20260901145900) and a GRANT revoke (20260907161706).
--
-- Read by nothing, it had quietly become false in three separate ways:
--
--   * `plo6` was marked ELIGIBLE with an 8-high straight-flush bar. Both code
--     halves mark PLO6 ineligible, and production agrees with the code: 18,737
--     PLO6 tables exist and they have contributed ZERO BBJ rake and taken ZERO
--     hits. The table was the only thing on the platform claiming PLO6 has a
--     jackpot.
--   * It carried an `ofc` row that neither code half has. Open Face Chinese
--     is not a variant the BBJ evaluates at all.
--   * It was MISSING five variants the engine knows: `flh`, `plo`, `plo8`,
--     `flo8`, `plo_hilo` - and `pineapple`, which is live (293 tables, 11,606
--     BBJ-raked hands in seven days, four jackpot hits already paid).
--
-- This migration makes the table agree with the engine, row for row, and then
-- says in a COMMENT what it is - descriptive, never authoritative - so the
-- next agent who finds it does not mistake it for the rule. The rule stays in
-- one place, and `tests/one-qualifying-rule-for-one-jackpot.law.test.ts` keeps
-- the two CODE halves identical to each other.
--
-- Data only: no DDL on the table's shape, so no PostgREST schema reload beyond
-- the COMMENT (section 2 rule 1 - one transaction).

BEGIN;

-- The engine's table, verbatim. `eligible = false` rows keep a null bar.
CREATE TEMP TABLE zz_engine_rule (
  variant           text PRIMARY KEY,
  label             text NOT NULL,
  min_losing_hand   text,
  description       text NOT NULL,
  hand_rank         text,
  eligible          boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO zz_engine_rule (variant, label, min_losing_hand, description, hand_rank, eligible) VALUES
  ('nlh',        'NLH / FLH',                 'AAAJJ', 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush', 'full_house',     true),
  ('flh',        'NLH / FLH',                 'AAAJJ', 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush', 'full_house',     true),
  ('plo4',       'PLO4 / FLO4',               'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE',                                     'four_of_a_kind', true),
  ('plo',        'PLO4 / FLO4',               'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE',                                     'four_of_a_kind', true),
  ('plo8',       'PLO8 (Hi-Lo 8 Or Better)',  'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',       'four_of_a_kind', true),
  ('flo8',       'FLO8 (Hi-Lo 8 Or Better)',  'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',       'four_of_a_kind', true),
  ('plo_hilo',   'PLO8 (Hi-Lo 8 Or Better)',  'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',       'four_of_a_kind', true),
  ('plo5',       'PLO5 / FLO5',               '87654', 'Straight Flush (8-High) Or Better Must LOSE',                                    'straight_flush', true),
  ('pineapple',  'Pineapple',                 'KKKK2', 'Four Of A Kind (Kings) Or Better Must LOSE',                                     'four_of_a_kind', true),
  ('plo6',       'PLO6',                      NULL,    'BBJ Not Available For PLO6',                                                     NULL,             false),
  ('short_deck', 'Short Deck',                NULL,    'BBJ Not Available For Short Deck',                                               NULL,             false);

-- 1. Correct every row the table already has.
UPDATE public.bbj_qualifying_hands q
   SET label           = e.label,
       min_losing_hand = e.min_losing_hand,
       description     = e.description,
       hand_rank       = e.hand_rank,
       eligible        = e.eligible
  FROM zz_engine_rule e
 WHERE q.variant = e.variant
   AND (q.label, q.min_losing_hand, q.description, q.hand_rank, q.eligible)
       IS DISTINCT FROM
       (e.label, e.min_losing_hand, e.description, e.hand_rank, e.eligible);

-- 2. Add the variants the engine knows and the table never had.
INSERT INTO public.bbj_qualifying_hands (variant, label, min_losing_hand, description, hand_rank, eligible)
SELECT e.variant, e.label, e.min_losing_hand, e.description, e.hand_rank, e.eligible
  FROM zz_engine_rule e
 WHERE NOT EXISTS (SELECT 1 FROM public.bbj_qualifying_hands q WHERE q.variant = e.variant);

-- 3. Remove rows describing a variant the engine does not evaluate. `ofc` is
--    the only one today; it is deleted rather than marked ineligible because
--    the engine has no concept of it at all, and an "ineligible" row implies
--    the jackpot considered it and declined.
DELETE FROM public.bbj_qualifying_hands q
 WHERE NOT EXISTS (SELECT 1 FROM zz_engine_rule e WHERE e.variant = q.variant);

-- 4. Say what this table is, on the table, so nobody has to guess again.
COMMENT ON TABLE public.bbj_qualifying_hands IS
  'DESCRIPTIVE MIRROR, NOT THE RULE. The Bad Beat Jackpot qualifying rule is '
  'enforced by BBJ_QUALIFYING_HANDS in server/src/config/RakeConfig.ts and is '
  'mirrored for player-facing surfaces in src/config/RakeConfig.ts; those two '
  'are held identical by tests/one-qualifying-rule-for-one-jackpot.law.test.ts. '
  'Nothing reads this table. It is kept in step with the engine by migration '
  '20260911153422 because a stale copy that LOOKS authoritative is worse than '
  'no copy - before that migration it marked PLO6 eligible (the engine refuses '
  'PLO6), carried an ofc row the engine has never had, and omitted six '
  'variants including the live pineapple. If you change the rule, change the '
  'engine; then update this table in the same pull request or delete it.';

-- 5. Assert the mirror is exact, or abort. The migration is worthless if it
--    leaves the table half-corrected.
DO $$
DECLARE v_diff integer; v_extra integer; v_missing integer;
BEGIN
  SELECT count(*) INTO v_diff
    FROM public.bbj_qualifying_hands q
    JOIN zz_engine_rule e ON e.variant = q.variant
   WHERE (q.label, q.min_losing_hand, q.description, q.hand_rank, q.eligible)
         IS DISTINCT FROM
         (e.label, e.min_losing_hand, e.description, e.hand_rank, e.eligible);

  SELECT count(*) INTO v_extra
    FROM public.bbj_qualifying_hands q
   WHERE NOT EXISTS (SELECT 1 FROM zz_engine_rule e WHERE e.variant = q.variant);

  SELECT count(*) INTO v_missing
    FROM zz_engine_rule e
   WHERE NOT EXISTS (SELECT 1 FROM public.bbj_qualifying_hands q WHERE q.variant = e.variant);

  IF v_diff <> 0 OR v_extra <> 0 OR v_missing <> 0 THEN
    RAISE EXCEPTION
      'bbj_qualifying_hands does not mirror the engine: % differing, % extra, % missing',
      v_diff, v_extra, v_missing;
  END IF;
END $$;

COMMIT;
