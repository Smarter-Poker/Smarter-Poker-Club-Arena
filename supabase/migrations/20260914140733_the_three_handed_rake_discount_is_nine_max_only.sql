-- 20260914140733_the_three_handed_rake_discount_is_nine_max_only.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
-- ============================================================================
--
-- Dan, 2026-09-14, verbatim:
--
--   "HEADS UP GAMES SHOULD BE REDUCED MAX RAKE (50% OF MAX RAKE) AND 3 HANDED
--    GAMES 75% MAX RAKE (ON 75% RAKE REDUCTION ON 9HANDED GAMES ONLY). ONCE
--    ANY 6-8 HANDED GAME REACHES 3+ PLAYERS FULL RAKE + BBJ IS APPLIED."
--
-- Two changes to the one rake spec (server/src/config/rakeSpec.ts, mirrored
-- here as ca_rake_rules), and nothing else:
--
--   1. short_handed_cap_factor 0.67 -> 0.75. A three-handed pot now pays 75%
--      of the cap where it pays a reduced cap at all.
--
--   2. A NEW RULE, short_handed_min_seats = 9: the three-handed reduction
--      exists only on a table with at least that many SEATS. Three-handed
--      means something different on a 9-max than on a 6-max - on nine seats it
--      is a table that has emptied out, on six it is most of a game - so a
--      6-, 7- or 8-max table pays the FULL cap from three players up.
--
-- HEADS-UP IS NOT GATED. Two players is two players at any table size: 50% of
-- the cap and the 5% heads-up rate, exactly as before, on every table.
--
-- BBJ IS UNCHANGED. bbj_min_players_dealt is already 3, so "full rake + BBJ at
-- 3+" is what a 6-8 handed table has always done on the BBJ side; only the cap
-- was reduced there, and this migration is what stops that.
--
-- WHO PRICES A POT. The engine does - PokerEngine.calculateRake, fed by
-- getPlayerCountCaps(cap, tables.max_players). These functions are the
-- DATABASE MIRROR the rake alarm and the audits measure it against; they must
-- move together or fn_rake_law_violations would report every three-handed
-- hand at a 6-max table as an over_spec deviation. That is the whole reason
-- this migration exists alongside the engine change rather than after it.
--
-- WHAT IT DOES NOT CHANGE: ca_rake_schedule_caps keeps its (bb, players_dealt)
-- shape and keeps publishing the NINE-MAX ladder. It has no seat dimension and
-- does not need one - the gate lives in fn_rake_cap_for_dealt and
-- fn_effective_rake, which take the seat count and fall back to the full cap
-- below short_handed_min_seats. The published rows stay "the ladder at a table
-- where every rung exists", which is what the checksum has always covered.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE RULE
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ca_rake_rules
  ADD COLUMN IF NOT EXISTS short_handed_min_seats integer NOT NULL DEFAULT 9;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ca_rake_rules'::regclass
       AND conname  = 'ca_rake_rules_short_handed_min_seats_check'
  ) THEN
    ALTER TABLE public.ca_rake_rules
      ADD CONSTRAINT ca_rake_rules_short_handed_min_seats_check
      CHECK (short_handed_min_seats >= 2);
  END IF;
END;
$$;

COMMENT ON COLUMN public.ca_rake_rules.short_handed_min_seats IS
  'Seats a table must HAVE (tables.max_players) for the three-handed cap reduction to apply at all. Dan 2026-09-14: nine-max only; a 6/7/8-max table pays the full cap from three players up. Heads-up is never gated.';

-- The column DEFAULT moves too, so a database built from scratch is the same
-- database as this one. The 0.67 default was the number before today.
ALTER TABLE public.ca_rake_rules
  ALTER COLUMN short_handed_cap_factor SET DEFAULT 0.75;

UPDATE public.ca_rake_rules
   SET short_handed_cap_factor = 0.75,
       short_handed_min_seats  = 9,
       updated_at              = now()
 WHERE id = 1;

-- 2026-09-02's comments on this table and on fn_rake_spec_checksum() both said
-- a mismatch "holds cash tables". It does not, and never did: Dan's risk
-- ruling the same day (rakeSpec.ts, THE DRIFT STATE) is that a mismatch is
-- REPORTED - CRITICAL RakeSpec.drift, once per boot - and dealing continues on
-- the compiled-in spec, because a guard that can stop a fleet over a hash is a
-- bigger live-play risk than the drift it would catch. Corrected here so the
-- next person to read either comment is not told the deploy order matters.
COMMENT ON TABLE public.ca_rake_rules IS
  'One row. Every rake/BBJ rule constant the engine compiles in (server/src/config/rakeSpec.ts). Part of fn_rake_spec_checksum(); change it and the engine raises RakeSpec.drift at its next check and keeps dealing on its compiled-in spec until it is redeployed to match.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE CAP LADDER, SEAT-GATED
-- ─────────────────────────────────────────────────────────────────────────────

-- Dropped rather than replaced: a third parameter with a DEFAULT would OVERLOAD
-- the two-argument function rather than replace it, and every existing
-- two-argument call would then be ambiguous ("function is not unique"). Nothing
-- in the database depends on it by catalogue - function bodies resolve their
-- callees at execution - so the dependants below simply pick up the new one.
DROP FUNCTION IF EXISTS public.fn_rake_cap_for_dealt(numeric, integer);

-- capsByPlayersDealt: ladder [(2, hu), (smp, short), (smp+1, full)], highest
-- rung with dealt >= players wins; fewer than 2 dealt (never a hand) -> full.
--
-- p_seats is the table's max_players. NULL (or a nonsense value) means "no
-- table in hand" and keeps the nine-max ladder, which is what
-- ca_rake_schedule_caps publishes and what every table was priced at before
-- today - so a missing seat count can only ever price a pot as it was priced
-- yesterday, never higher.
CREATE OR REPLACE FUNCTION public.fn_rake_cap_for_dealt(
  p_full_cap      numeric,
  p_players_dealt integer,
  p_seats         integer DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_players_dealt >= r.short_handed_max_players + 1 THEN p_full_cap
           WHEN p_players_dealt >= r.short_handed_max_players     THEN
             CASE WHEN p_seats IS NULL OR p_seats <= 0 OR p_seats >= r.short_handed_min_seats
                  THEN round(p_full_cap * r.short_handed_cap_factor, 2)
                  ELSE p_full_cap END
           WHEN p_players_dealt >= 2                              THEN round(p_full_cap * r.heads_up_cap_factor, 2)
           ELSE p_full_cap
         END
    FROM public.ca_rake_rules r
   WHERE r.id = 1;
$$;

COMMENT ON FUNCTION public.fn_rake_cap_for_dealt(numeric, integer, integer) IS
  'The cap for a pot by players dealt, mirroring capsByPlayersDealt in server/src/config/rakeSpec.ts. p_seats is tables.max_players and gates the three-handed reduction (Dan 2026-09-14, nine-max only); NULL keeps the nine-max ladder.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE RAKE
-- ─────────────────────────────────────────────────────────────────────────────

-- Same reason as above: p_seats is appended with a DEFAULT, so the old
-- seven-argument signature is dropped rather than left to collide with it.
DROP FUNCTION IF EXISTS public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.fn_effective_rake(
  p_bb               numeric,
  p_pot              numeric,
  p_players_dealt    integer,
  p_saw_flop         boolean,
  p_sb               numeric DEFAULT NULL,
  p_override_percent numeric DEFAULT NULL,
  p_override_cap_bb  numeric DEFAULT NULL,
  p_seats            integer DEFAULT NULL
)
RETURNS TABLE (rake numeric, cap numeric, percent numeric)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  r          public.ca_rake_rules%ROWTYPE;
  v_pct      numeric;
  v_full     numeric;
  v_sched    boolean := false;
  v_cap      numeric;
  v_cap_key  integer;
  v_cap_ovr  boolean := false;
  v_short_ok boolean;
BEGIN
  SELECT * INTO r FROM public.ca_rake_rules WHERE id = 1;

  SELECT p.rake_percent, p.rake_cap, p.scheduled INTO v_pct, v_full, v_sched
    FROM public.fn_rake_stake_price(p_bb, p_sb) p;
  IF v_pct IS NULL THEN
    SELECT t.rake_percent, t.rake_cap INTO v_pct, v_full FROM public.fn_rake_tier_price(p_bb) t;
    v_sched := false;
  END IF;

  IF p_override_percent IS NOT NULL AND p_override_percent >= 0 THEN
    v_pct := LEAST(LEAST(GREATEST(p_override_percent, 0), r.max_rake_percent), v_pct);
  END IF;
  IF p_override_cap_bb IS NOT NULL AND p_override_cap_bb >= 0 THEN
    v_full := LEAST(round(LEAST(GREATEST(p_override_cap_bb, 0), r.max_rake_cap_bb) * p_bb, 2), v_full);
    v_cap_ovr := true;
  END IF;

  IF COALESCE(p_players_dealt, 0) <= 2 THEN
    v_pct := LEAST(v_pct, r.heads_up_percent);
  END IF;

  -- Does the three-handed reduction exist at this table size at all?
  v_short_ok := p_seats IS NULL OR p_seats <= 0 OR p_seats >= r.short_handed_min_seats;

  v_cap := NULL;
  IF v_sched AND NOT v_cap_ovr THEN
    -- A three-handed pot at a 6/7/8-max table reads the FULL-cap rung (4), not
    -- the three-handed one. ca_rake_schedule_caps publishes the nine-max
    -- ladder and has no seat dimension; choosing the rung here is what applies
    -- the gate without giving that table a second key.
    v_cap_key := CASE WHEN COALESCE(p_players_dealt, 0) >= r.short_handed_max_players + 1 THEN 4
                      WHEN p_players_dealt >= r.short_handed_max_players THEN (CASE WHEN v_short_ok THEN 3 ELSE 4 END)
                      WHEN p_players_dealt >= 2 THEN 2
                      ELSE 4 END;
    SELECT c.rake_cap INTO v_cap
      FROM public.ca_rake_schedule_caps c
     WHERE abs(c.bb - p_bb) < 0.001 AND c.players_dealt = v_cap_key AND c.source = 'schedule';
  END IF;
  IF v_cap IS NULL THEN
    v_cap := public.fn_rake_cap_for_dealt(v_full, COALESCE(p_players_dealt, 0), p_seats);
  END IF;

  IF r.no_flop_no_drop AND NOT COALESCE(p_saw_flop, false) THEN
    RETURN QUERY SELECT 0::numeric, v_cap, v_pct;
  ELSE
    RETURN QUERY SELECT LEAST(round(COALESCE(p_pot, 0) * v_pct, 0) / 100, v_cap), v_cap, v_pct;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric, integer) IS
  'What the engine charges for a pot, mirroring PokerEngine.calculateRake. p_seats is tables.max_players and gates the three-handed cap reduction (Dan 2026-09-14, nine-max only); NULL keeps the nine-max ladder.';

-- The self-check derives a published row, which is the nine-max ladder, so it
-- passes no seats. Recreated (rather than left to re-resolve) so the argument
-- it means is written down.
CREATE OR REPLACE FUNCTION public.fn_rake_spec_self_check()
RETURNS TABLE (bb numeric, players_dealt integer, stored_cap numeric, derived_cap numeric)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.bb, c.players_dealt, c.rake_cap,
         public.fn_rake_cap_for_dealt(
           COALESCE((SELECT p.rake_cap FROM public.fn_rake_stake_price(c.bb) p),
                    (SELECT t.rake_cap FROM public.fn_rake_tier_price(c.bb) t)),
           c.players_dealt, NULL)
    FROM public.ca_rake_schedule_caps c
   WHERE c.rake_cap IS DISTINCT FROM public.fn_rake_cap_for_dealt(
           COALESCE((SELECT p.rake_cap FROM public.fn_rake_stake_price(c.bb) p),
                    (SELECT t.rake_cap FROM public.fn_rake_tier_price(c.bb) t)),
           c.players_dealt, NULL);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE CANONICAL TEXT (and therefore the checksum)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One new key, in the alphabetical position the rule requires:
-- short_handed_max_players, short_handed_min_seats, unscheduled_cap_bb.
-- rakeSpecCanonical() in server/src/config/rakeSpec.ts is edited in the same
-- commit and RakeSpecParity.law.test.ts pins both sides against this file.

CREATE OR REPLACE FUNCTION public.fn_rake_spec_canonical()
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT '{"caps":['
      || COALESCE((SELECT string_agg(
                     format('{"bb":"%s","dealt":%s,"cap":"%s"}',
                            round(c.bb, 2)::text, c.players_dealt, round(c.rake_cap, 2)::text),
                     ',' ORDER BY c.bb, c.players_dealt)
                     FROM public.ca_rake_schedule_caps c), '')
      || '],"rules":'
      || (SELECT format(
            '{"bbj_ineligible_variants":[%s],"bbj_min_players_dealt":%s,"bbj_min_pot_bb":%s,'
            || '"heads_up_cap_factor":"%s","heads_up_percent":"%s","max_rake_cap_bb":"%s",'
            || '"max_rake_percent":"%s","no_flop_no_drop":%s,"short_handed_cap_factor":"%s",'
            || '"short_handed_max_players":%s,"short_handed_min_seats":%s,"unscheduled_cap_bb":"%s"}',
            COALESCE((SELECT string_agg(to_json(v)::text, ',' ORDER BY v COLLATE "C")
                        FROM unnest(r.bbj_ineligible_variants) AS v), ''),
            r.bbj_min_players_dealt,
            r.bbj_min_pot_bb,
            round(r.heads_up_cap_factor, 2)::text,
            round(r.heads_up_percent, 2)::text,
            round(r.max_rake_cap_bb, 2)::text,
            round(r.max_rake_percent, 2)::text,
            CASE WHEN r.no_flop_no_drop THEN 'true' ELSE 'false' END,
            round(r.short_handed_cap_factor, 2)::text,
            r.short_handed_max_players,
            r.short_handed_min_seats,
            round(public.fn_unscheduled_cap_bb(), 2)::text)
            FROM public.ca_rake_rules r WHERE r.id = 1)
      || ',"schedule":['
      || COALESCE((SELECT string_agg(
                     format('{"sb":"%s","bb":"%s","rake_percent":"%s","rake_cap":"%s","bbj_fee_bb":"%s"}',
                            round(s.sb, 2)::text, round(s.bb, 2)::text, round(s.rake_percent, 2)::text,
                            round(s.rake_cap, 2)::text, round(s.bbj_fee_bb, 2)::text),
                     ',' ORDER BY s.bb, s.sb)
                     FROM public.ca_rake_schedule s WHERE s.source = 'engine_mirror'), '')
      || '],"tiers":['
      || COALESCE((SELECT string_agg(
                     format('{"label":%s,"min_bb":"%s","max_bb":%s,"rake_percent":"%s","rake_cap":"%s","bbj_fee_bb":"%s"}',
                            to_json(lower(t.label))::text, round(t.min_bb, 2)::text,
                            CASE WHEN t.max_bb IS NULL THEN 'null' ELSE '"' || round(t.max_bb, 2)::text || '"' END,
                            round(t.rake_percent, 2)::text, round(t.rake_cap, 2)::text, round(t.bbj_fee_bb, 2)::text),
                     ',' ORDER BY t.min_bb)
                     FROM public.ca_rake_tier t), '')
      || ']}';
$$;

COMMENT ON FUNCTION public.fn_rake_spec_checksum() IS
  'md5 of fn_rake_spec_canonical(). The engine compares this with rakeSpecChecksum() at boot and every minute; a mismatch raises CRITICAL RakeSpec.drift and the engine KEEPS DEALING on its compiled-in spec (Dan 2026-09-02: the alert is the enforcement).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE CAPS, REBUILT (the factor moved, so every three-handed row moved)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT public.fn_rake_spec_rebuild_caps();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE ALARM LEARNS THE SEAT COUNT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Without this the audit would price every three-handed hand at a 6/7/8-max
-- table on the nine-max ladder and report the engine's (correct) full-cap rake
-- as an over_spec deviation. The seat count is on the row it already joins.

CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '01:00:00'::interval)
RETURNS TABLE (kind text, hand_id uuid, table_id uuid, occurred_at timestamptz,
               small_blind numeric, big_blind numeric, pot numeric, rake numeric, allowed numeric)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
           hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
           t.max_players AS seats,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           (SELECT count(*) FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
             WHERE a->>'action' IN ('call','raise','bet','allin','all-in')) AS agg,
           CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
           CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb,
           c.bbj_rake_enabled
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
      LEFT JOIN public.clubs c ON c.id = t.club_id
      LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'   -- settlement is not instant
       AND t.tournament_id IS NULL
       AND hh.tournament_id IS NULL
  ), f AS (
    -- Hands with a board on record: the spec is checkable.
    SELECT h.*, e.rake AS exp_rake
      FROM h
      CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
  ), fb AS (
    SELECT f.*, public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake) AS exp_bbj
      FROM f
  ), h0 AS (
    -- The RAKELESS impossible hands: a recorded showdown over fewer than three
    -- board cards is the stale-runout corruption's signature.
    SELECT hh.id, hh.table_id, hh.created_at, hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) = 0
       AND hh.showdown IS NOT NULL
       AND COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  )
  SELECT 'over_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake > exp_rake + 0.005
  UNION ALL
  SELECT 'under_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake < exp_rake - 0.005
  UNION ALL
  SELECT 'bbj_over_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj > exp_bbj + 0.005
  UNION ALL
  SELECT 'bbj_under_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj < exp_bbj - 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0::numeric
    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE board_n = 0 AND (has_showdown OR agg >= 4)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0::numeric, NULL::numeric
    FROM h0
  UNION ALL
  SELECT 'players_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE dealt IS NULL AND board_n >= 3
  UNION ALL
  SELECT 'bbj_club_switch_ignored', id, table_id, created_at, sb, bb, pot, bbj, 0::numeric
    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. GRANTS FOR THE NEW SIGNATURES
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_rake_cap_for_dealt(numeric, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_cap_for_dealt(numeric, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. PROOF, IN THE SAME TRANSACTION
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- rakeSpecChecksum() from server/src/config/rakeSpec.ts on this branch.
  -- RakeSpecParity.law.test.ts reads this literal out of this file and asserts
  -- the two are the same string, so they cannot be edited apart.
  c_expected constant text := 'f9cfc362daedd898780b84f20be3e4e4';
  v_sum   text;
  v_bad   integer;
  v_hu    numeric;
  v_3x9   numeric;
  v_3x6   numeric;
  v_3xnul numeric;
  v_4x6   numeric;
  v_nfnd  numeric;
  v_caps  integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.fn_rake_spec_self_check();
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'rake spec self-check: % caps row(s) disagree with their derivation', v_bad;
  END IF;

  SELECT count(*) INTO v_caps FROM public.ca_rake_schedule_caps;
  IF v_caps <> 60 THEN
    RAISE EXCEPTION 'expected 60 caps rows (20 stakes x 3 rungs), found %', v_caps;
  END IF;

  -- 1/2 is 10% with a 5.00 cap. A 100 pot on the flop:
  SELECT e.rake INTO v_hu    FROM public.fn_effective_rake(2, 100, 2, true, 1, NULL, NULL, 6) e;
  SELECT e.rake INTO v_3x9   FROM public.fn_effective_rake(2, 100, 3, true, 1, NULL, NULL, 9) e;
  SELECT e.rake INTO v_3x6   FROM public.fn_effective_rake(2, 100, 3, true, 1, NULL, NULL, 6) e;
  SELECT e.rake INTO v_3xnul FROM public.fn_effective_rake(2, 100, 3, true, 1) e;
  SELECT e.rake INTO v_4x6   FROM public.fn_effective_rake(2, 100, 4, true, 1, NULL, NULL, 6) e;
  SELECT e.rake INTO v_nfnd  FROM public.fn_effective_rake(2, 100, 6, false, 1, NULL, NULL, 9) e;

  -- Heads-up is NOT seat-gated: half the cap at a 6-max table too.
  IF v_hu <> 2.50 THEN RAISE EXCEPTION 'heads-up rake at 6-max expected 2.50, got %', v_hu; END IF;
  -- Three-handed at 9-max: 75% of 5.00.
  IF v_3x9 <> 3.75 THEN RAISE EXCEPTION 'three-handed rake at 9-max expected 3.75, got %', v_3x9; END IF;
  -- Three-handed at 6-max: the FULL cap. This is the rule this migration adds.
  IF v_3x6 <> 5.00 THEN RAISE EXCEPTION 'three-handed rake at 6-max expected 5.00, got %', v_3x6; END IF;
  -- No seats given: the nine-max ladder, which is what the caps table holds.
  IF v_3xnul <> 3.75 THEN RAISE EXCEPTION 'three-handed rake with no seats expected 3.75, got %', v_3xnul; END IF;
  -- Four-handed is full everywhere, and always was.
  IF v_4x6 <> 5.00 THEN RAISE EXCEPTION 'four-handed rake at 6-max expected 5.00, got %', v_4x6; END IF;
  IF v_nfnd <> 0 THEN RAISE EXCEPTION 'no flop no drop expected 0, got %', v_nfnd; END IF;

  SELECT public.fn_rake_spec_checksum() INTO v_sum;
  IF v_sum IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION 'rake spec checksum % does not match the engine''s %', v_sum, c_expected;
  END IF;
END;
$$;

COMMIT;
