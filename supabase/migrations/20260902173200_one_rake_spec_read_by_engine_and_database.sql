-- ═══════════════════════════════════════════════════════════════════════════════
--  ONE RAKE SPEC, READ BY THE ENGINE AND THE DATABASE
--  Chip Accounting Standard rule R7 (docs/CHIP-ACCOUNTING-STANDARD.md 3.3),
--  Lane C of the 2026-09-02 swarm. Engine twin: server/src/config/rakeSpec.ts
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. The rake spec lived in four places that could not read each
-- other: `tables.rake_percent = -1 / rake_cap_bb = -1` (a sentinel),
-- `ca_rake_schedule` (per-stake percent + cap + BBJ drop, no players-dealt
-- dimension, no row for the live 3.00 stake), `ca_rake_tier`, and engine
-- constants (`playerCountCaps` 0.5x/0.67x, `HEADS_UP_RAKE_PERCENT = 5`,
-- `noFlopNoDrop`, `BBJ_RULES.minPlayersDealt = 3`). The audit functions could
-- not reproduce the engine's number, so 421 of 2,044 flop hands read as
-- "under-raked" when the engine was right on every one: heads-up 5% at half
-- cap, 3-dealt at 67% cap, 3.00 BB priced by the tier fallback, plo6 and
-- short-deck dropping no BBJ. Measured the other way: 0 hands over spec, 0
-- raked without a flop, 0 over 10%.
--
-- WHAT THIS DOES.
--   1. `ca_rake_rules` (one row): every rule constant the engine used to keep
--      to itself. `ca_rake_schedule_caps (bb, players_dealt)`: the cap ladder
--      for every stake the engine deals, including the tier-priced 3.00.
--   2. `fn_effective_rake(bb, pot, dealt, saw_flop [, sb, override%, override
--      cap bb])` and `fn_effective_bbj_drop(...)`: EXACTLY the engine's
--      arithmetic (rakeSpec.ts effectiveRake / effectiveBbjDrop; the parity
--      law test holds them together).
--   3. `fn_rake_spec_canonical()` / `fn_rake_spec_checksum()`: the canonical
--      text and its md5, built by the SAME rule as rakeSpecCanonical() in TS.
--      The engine compares the two at boot and every minute; on a mismatch it
--      raises CRITICAL `RakeSpec.drift` and holds cash tables at their next
--      hand boundary until they agree. The assertion at the end of this file
--      pins the checksum to the value the engine computes for this spec.
--   4. `fn_rake_law_violations` / `fn_rake_law_check` / `fn_rake_bbj_invariants`
--      rewritten on the two functions above, so a finding is a real deviation.
--
-- ARITHMETIC NOTE. The engine computes in IEEE-754 doubles; this file in
-- numeric. Verified before writing: for every 2-decimal pot from 0.01 to
-- 1000.00 at 10% and 5%, for every cap x 0.5 / x 0.67 on the schedule, for
-- every bb x bbj fee on the schedule, and for every override cap 0..10 BB in
-- half-BB steps at every scheduled bb, Math.round(x*100)/100 equals
-- round(x, 2). The two sides agree exactly on every input the engine sees.
--
-- CANONICAL TEXT RULE (identical to rakeSpec.ts, keep in sync):
--   compact JSON, no whitespace, keys in the order written; every
--   money/percent/factor number is a STRING with exactly two decimals
--   (round(x,2)::text here, toFixed(2) there); counts are bare integers;
--   flags true/false; an open-ended tier max_bb is null; caps sorted by
--   (bb, players_dealt), schedule by (bb, sb), tiers by min_bb, rules keys
--   alphabetical, ineligible variants in byte order.
--
-- One transaction: one PostgREST reload (CLAUDE.md 2, production DDL policy).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE RULES ROW
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_rake_rules (
  id                       smallint PRIMARY KEY CHECK (id = 1),
  -- Dan 2026-08-27: "Rake is 10% with a max cap. Heads up is 5% rake."
  heads_up_percent         numeric  NOT NULL DEFAULT 5    CHECK (heads_up_percent >= 0),
  -- FIX 166 / Bible V8 7.19: heads-up 50% of cap, 3-handed 67%, 4+ full.
  heads_up_cap_factor      numeric  NOT NULL DEFAULT 0.5  CHECK (heads_up_cap_factor BETWEEN 0 AND 1),
  short_handed_cap_factor  numeric  NOT NULL DEFAULT 0.67 CHECK (short_handed_cap_factor BETWEEN 0 AND 1),
  short_handed_max_players integer  NOT NULL DEFAULT 3    CHECK (short_handed_max_players >= 3),
  -- Bible V8 2.9 / Appendix A, Dan 2026-08-29: no flop, no drop.
  no_flop_no_drop          boolean  NOT NULL DEFAULT true,
  -- FIX 145: the BBJ drop needs 3+ dealt in. PAYOUT floor is bbj_min_pot_bb.
  bbj_min_players_dealt    integer  NOT NULL DEFAULT 3    CHECK (bbj_min_players_dealt >= 2),
  bbj_min_pot_bb           integer  NOT NULL DEFAULT 10   CHECK (bbj_min_pot_bb >= 0),
  -- Owner override ceilings (an override may only move DOWNWARD from the schedule).
  max_rake_percent         numeric  NOT NULL DEFAULT 10   CHECK (max_rake_percent >= 0),
  max_rake_cap_bb          numeric  NOT NULL DEFAULT 10   CHECK (max_rake_cap_bb >= 0),
  -- Variants that never drop a BBJ fee and can never win one.
  bbj_ineligible_variants  text[]   NOT NULL DEFAULT ARRAY['plo6','short_deck'],
  -- Stakes with no schedule row that live cash tables are dealt at; they get
  -- a caps row so the cap the engine charges there is published. Not part of
  -- the checksum directly (the caps rows it produces are).
  tier_priced_big_blinds   numeric[] NOT NULL DEFAULT ARRAY[3::numeric],
  updated_at               timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_rake_rules IS
  'One row. Every rake/BBJ rule constant the engine compiles in (server/src/config/rakeSpec.ts). Part of fn_rake_spec_checksum(); change it and the engine holds cash tables until it is redeployed to match.';

INSERT INTO public.ca_rake_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE CAP LADDER BY PLAYERS DEALT
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_rake_schedule_caps (
  bb            numeric NOT NULL CHECK (bb > 0),
  -- 2 = heads-up, 3 = three-handed, 4 = four or more (the full cap)
  players_dealt integer NOT NULL CHECK (players_dealt IN (2, 3, 4)),
  rake_cap      numeric NOT NULL CHECK (rake_cap >= 0),
  source        text    NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule', 'tier_fallback')),
  PRIMARY KEY (bb, players_dealt)
);
COMMENT ON TABLE public.ca_rake_schedule_caps IS
  'Rake cap by big blind and players dealt: the engine''s playerCountCaps materialised for every stake it deals. Rebuilt by fn_rake_spec_rebuild_caps(); part of fn_rake_spec_checksum().';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE ARITHMETIC
-- ─────────────────────────────────────────────────────────────────────────────

-- The engine derives this from its schedule (max rakeCap/bb over published
-- rows = 15 BB); a 'proposed' row must not move it, so filter to the mirror.
CREATE OR REPLACE FUNCTION public.fn_unscheduled_cap_bb()
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(max(s.rake_cap / s.bb), 0)
    FROM public.ca_rake_schedule s
   WHERE s.bb > 0 AND s.source = 'engine_mirror';
$$;

-- Base price for a stake: the schedule row, else the tier fallback held to the
-- ladder (rakeSpec.ts resolveStake). p_sb NULL resolves by big blind alone,
-- which is unique in the published schedule.
CREATE OR REPLACE FUNCTION public.fn_rake_stake_price(p_bb numeric, p_sb numeric DEFAULT NULL)
RETURNS TABLE (rake_percent numeric, rake_cap numeric, bbj_fee_bb numeric, scheduled boolean)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT s.rake_percent, s.rake_cap, s.bbj_fee_bb, true
    FROM public.ca_rake_schedule s
   WHERE s.source = 'engine_mirror'
     AND abs(s.bb - p_bb) < 0.001
     AND (p_sb IS NULL OR abs(s.sb - p_sb) < 0.001)
   ORDER BY s.sb
   LIMIT 1;
$$;

-- The tier fallback, as its own function so the price above stays one query.
CREATE OR REPLACE FUNCTION public.fn_rake_tier_price(p_bb numeric)
RETURNS TABLE (rake_percent numeric, rake_cap numeric, bbj_fee_bb numeric)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT t.rake_percent,
         CASE WHEN p_bb > 0
              THEN LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
              ELSE t.rake_cap END,
         t.bbj_fee_bb
    FROM public.ca_rake_tier t
   WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
   ORDER BY t.max_bb ASC NULLS LAST
   LIMIT 1;
$$;

-- capsByPlayersDealt: ladder [(2, hu), (smp, short), (smp+1, full)], highest
-- rung with dealt >= players wins; fewer than 2 dealt (never a hand) -> full.
CREATE OR REPLACE FUNCTION public.fn_rake_cap_for_dealt(p_full_cap numeric, p_players_dealt integer)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_players_dealt >= r.short_handed_max_players + 1 THEN p_full_cap
           WHEN p_players_dealt >= r.short_handed_max_players     THEN round(p_full_cap * r.short_handed_cap_factor, 2)
           WHEN p_players_dealt >= 2                              THEN round(p_full_cap * r.heads_up_cap_factor, 2)
           ELSE p_full_cap
         END
    FROM public.ca_rake_rules r
   WHERE r.id = 1;
$$;

-- Materialise ca_rake_schedule_caps from the schedule, the rules and the
-- tier-priced stakes. Idempotent; the post-apply assertion and
-- fn_rake_spec_self_check() prove the table equals this derivation.
CREATE OR REPLACE FUNCTION public.fn_rake_spec_rebuild_caps()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.ca_rake_schedule_caps;
  INSERT INTO public.ca_rake_schedule_caps (bb, players_dealt, rake_cap, source)
  SELECT s.bb, d.dealt, public.fn_rake_cap_for_dealt(s.rake_cap, d.dealt), 'schedule'
    FROM public.ca_rake_schedule s
    CROSS JOIN (VALUES (2), (3), (4)) AS d(dealt)
   WHERE s.source = 'engine_mirror';
  INSERT INTO public.ca_rake_schedule_caps (bb, players_dealt, rake_cap, source)
  SELECT x.bb, d.dealt, public.fn_rake_cap_for_dealt(tp.rake_cap, d.dealt), 'tier_fallback'
    FROM public.ca_rake_rules r
    CROSS JOIN LATERAL unnest(r.tier_priced_big_blinds) AS x(bb)
    CROSS JOIN LATERAL public.fn_rake_tier_price(x.bb) tp
    CROSS JOIN (VALUES (2), (3), (4)) AS d(dealt)
   WHERE r.id = 1
     AND NOT EXISTS (SELECT 1 FROM public.ca_rake_schedule s
                      WHERE s.source = 'engine_mirror' AND abs(s.bb - x.bb) < 0.001);
  SELECT count(*) INTO v_n FROM public.ca_rake_schedule_caps;
  RETURN v_n;
END;
$$;

SELECT public.fn_rake_spec_rebuild_caps();

-- THE RAKE. Exactly PokerEngine.calculateRake(pot, sawFlop,
-- getRakeConfig(sb, bb), playersDealt), in this order:
--   1. base percent/cap from the schedule row, else the tier fallback;
--   2. an owner override moves DOWNWARD only: clamp to the ceilings, then
--      min() against the published price (RakeConfig.getFullRakeConfig);
--   3. heads-up (dealt <= 2): percent = least(percent, heads_up_percent);
--   4. cap by players dealt (ca_rake_schedule_caps when the stake is
--      scheduled and the cap is not overridden; the same derivation otherwise);
--   5. no flop, no drop -> 0; else least(round(pot * percent) / 100, cap).
CREATE OR REPLACE FUNCTION public.fn_effective_rake(
  p_bb               numeric,
  p_pot              numeric,
  p_players_dealt    integer,
  p_saw_flop         boolean,
  p_sb               numeric DEFAULT NULL,
  p_override_percent numeric DEFAULT NULL,
  p_override_cap_bb  numeric DEFAULT NULL
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

  v_cap := NULL;
  IF v_sched AND NOT v_cap_ovr THEN
    v_cap_key := CASE WHEN COALESCE(p_players_dealt, 0) >= r.short_handed_max_players + 1 THEN 4
                      WHEN p_players_dealt >= r.short_handed_max_players THEN 3
                      WHEN p_players_dealt >= 2 THEN 2
                      ELSE 4 END;
    SELECT c.rake_cap INTO v_cap
      FROM public.ca_rake_schedule_caps c
     WHERE abs(c.bb - p_bb) < 0.001 AND c.players_dealt = v_cap_key AND c.source = 'schedule';
  END IF;
  IF v_cap IS NULL THEN
    v_cap := public.fn_rake_cap_for_dealt(v_full, COALESCE(p_players_dealt, 0));
  END IF;

  IF r.no_flop_no_drop AND NOT COALESCE(p_saw_flop, false) THEN
    RETURN QUERY SELECT 0::numeric, v_cap, v_pct;
  ELSE
    RETURN QUERY SELECT LEAST(round(COALESCE(p_pot, 0) * v_pct, 0) / 100, v_cap), v_cap, v_pct;
  END IF;
END;
$$;

-- THE BBJ DROP. Exactly HandController.priceDeductions' BBJ leg: collected on
-- every flop with bbj_min_players_dealt+ dealt, on an eligible variant, on a
-- table whose bbj_percent is not an explicit 0 - pot size never gates it -
-- and it yields to the pot ceiling before rake does (rake + drop <= pot).
--
-- ON p_club_id: `clubs.bbj_rake_enabled` is written by ClubSettingsPage and
-- read by NOTHING in the engine (verified 2026-09-02: the only enable the
-- engine consults is `tables.bbj_percent`). This function therefore does not
-- gate on it either - gating here would make the audit report a deviation
-- that the engine cannot see, which is the exact split this migration ends.
-- fn_rake_law_violations reports 'bbj_club_switch_ignored' separately when a
-- club has turned the switch off and its tables keep dropping, so that
-- product gap is visible without being mistaken for a rake bug. 0 clubs have
-- it off today. Making the engine honour the switch is Dan's call.
CREATE OR REPLACE FUNCTION public.fn_effective_bbj_drop(
  p_bb            numeric,
  p_players_dealt integer,
  p_saw_flop      boolean,
  p_club_id       uuid,
  p_table_id      uuid    DEFAULT NULL,
  p_variant       text    DEFAULT 'nlh',
  p_sb            numeric DEFAULT NULL,
  p_pot           numeric DEFAULT NULL,
  p_rake          numeric DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  r        public.ca_rake_rules%ROWTYPE;
  v_fee_bb numeric;
  v_fee    numeric;
  v_tblpct numeric := 100;
  v_over   numeric;
BEGIN
  SELECT * INTO r FROM public.ca_rake_rules WHERE id = 1;

  IF lower(COALESCE(p_variant, 'nlh')) = ANY (r.bbj_ineligible_variants) THEN RETURN 0; END IF;
  IF NOT COALESCE(p_saw_flop, false) THEN RETURN 0; END IF;
  IF COALESCE(p_players_dealt, 0) < r.bbj_min_players_dealt THEN RETURN 0; END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT COALESCE(t.bbj_percent, 100) INTO v_tblpct FROM public.tables t WHERE t.id = p_table_id;
    IF NOT COALESCE(v_tblpct, 100) > 0 THEN RETURN 0; END IF;
  END IF;

  SELECT p.bbj_fee_bb INTO v_fee_bb FROM public.fn_rake_stake_price(p_bb, p_sb) p;
  IF v_fee_bb IS NULL THEN
    SELECT t.bbj_fee_bb INTO v_fee_bb FROM public.fn_rake_tier_price(p_bb) t;
  END IF;
  v_fee := round(p_bb * COALESCE(v_fee_bb, 0), 2);

  IF p_pot IS NOT NULL AND p_rake IS NOT NULL AND p_rake + v_fee > p_pot THEN
    v_over := round(p_rake + v_fee - p_pot, 2);
    v_fee := CASE WHEN v_over <= v_fee THEN round(v_fee - v_over, 2) ELSE 0 END;
  END IF;
  RETURN v_fee;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CANONICAL TEXT + CHECKSUM (rule in the header; twin: rakeSpecCanonical())
-- ─────────────────────────────────────────────────────────────────────────────

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
            || '"short_handed_max_players":%s,"unscheduled_cap_bb":"%s"}',
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

CREATE OR REPLACE FUNCTION public.fn_rake_spec_checksum()
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT md5(public.fn_rake_spec_canonical());
$$;
COMMENT ON FUNCTION public.fn_rake_spec_checksum() IS
  'md5 of fn_rake_spec_canonical(). The engine compares this with rakeSpecChecksum() at boot and every minute; a mismatch raises RakeSpec.drift and holds cash tables at their next hand boundary until the two agree.';

-- Self-consistency: every caps row equals its derivation from the schedule,
-- the tiers and the rules. Returns the rows that do not; empty is healthy.
CREATE OR REPLACE FUNCTION public.fn_rake_spec_self_check()
RETURNS TABLE (bb numeric, players_dealt integer, stored_cap numeric, derived_cap numeric)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.bb, c.players_dealt, c.rake_cap,
         public.fn_rake_cap_for_dealt(
           COALESCE((SELECT p.rake_cap FROM public.fn_rake_stake_price(c.bb) p),
                    (SELECT t.rake_cap FROM public.fn_rake_tier_price(c.bb) t)),
           c.players_dealt)
    FROM public.ca_rake_schedule_caps c
   WHERE c.rake_cap IS DISTINCT FROM public.fn_rake_cap_for_dealt(
           COALESCE((SELECT p.rake_cap FROM public.fn_rake_stake_price(c.bb) p),
                    (SELECT t.rake_cap FROM public.fn_rake_tier_price(c.bb) t)),
           c.players_dealt);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE AUDIT, REWRITTEN ON THE SPEC - a finding is now a real deviation
-- ─────────────────────────────────────────────────────────────────────────────

-- Same signature as before (fn_rake_law_check reads it). Kinds:
--   over_spec / under_spec          rake differs from fn_effective_rake by > 0.005
--   bbj_over_spec / bbj_under_spec  drop differs from fn_effective_bbj_drop by > 0.005
--                                   (rake = actual drop, allowed = expected drop)
--   no_flop_no_drop                 money taken with no board and no showdown
--   board_not_recorded              a showdown or 4+ aggressive actions but no
--                                   board on record: the recorder, not the rake
--   impossible_showdown             showdown over fewer than 3 board cards, rake 0
--   players_not_recorded            no dealt-in count anywhere; spec not checkable
--   bbj_club_switch_ignored         club turned BBJ off, table still drops
--                                   (engine reads tables.bbj_percent only)
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
      CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb) e
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
  SELECT 'bbj_club_switch_ignored', id, table_id, created_at, sb, bb, pot, bbj, 0
    FROM fb WHERE bbj > 0 AND bbj_rake_enabled IS FALSE
  UNION ALL
  SELECT 'players_not_recorded', id, table_id, created_at, sb, bb, pot, rake, rake
    FROM h WHERE board_n >= 3 AND dealt IS NULL AND (rake > 0 OR bbj > 0)
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake + bbj, 0
    FROM h WHERE board_n < 3 AND (rake > 0 OR bbj > 0) AND NOT has_showdown AND agg <= 3
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, rake
    FROM h WHERE board_n < 3 AND (rake > 0 OR bbj > 0) AND (has_showdown OR agg > 3)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0, 0
    FROM h0;
$$;

-- Files each new finding once into ledger_reconcile_log (unchanged shape);
-- the recorder-side kinds are warnings, every spec deviation is critical.
CREATE OR REPLACE FUNCTION public.fn_rake_law_check(p_window interval DEFAULT '02:00:00'::interval)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_rake_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'rake_law', v.table_id,
           v.allowed, v.rake,
           CASE WHEN v.kind IN ('board_not_recorded', 'players_not_recorded', 'bbj_club_switch_ignored')
                THEN 'warn' ELSE 'critical' END,
           jsonb_build_object(
             'kind', v.kind,
             'hand_id', v.hand_id,
             'occurred_at', v.occurred_at,
             'stake', v.small_blind::text || '/' || v.big_blind::text,
             'pot', v.pot,
             'spec_checksum', public.fn_rake_spec_checksum()),
           v.kind || ': took ' || v.rake::text || ' where the spec says ' || v.allowed::text
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'rake_law'
          AND l.metadata->>'hand_id' = v.hand_id::text
          AND l.metadata->>'kind' = v.kind)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

-- fn_rake_bbj_invariants: I1, I2 and I4 now read the spec (rules row and
-- fn_effective_bbj_drop) instead of literal 3 / literal variant names /
-- a hand-rolled eligibility test. I3, I5, I6, I7 are verbatim from the live
-- body (read from pg_proc 2026-09-02).
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_invariants(p_hours integer DEFAULT 2)
RETURNS TABLE (check_name text, violations bigint, detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 2), 1));
  -- Rule checks: settlement is not instant, but nothing heals a broken rule.
  v_grace timestamptz := now() - interval '5 minutes';
  -- Self-healing checks: must outlast the healers' own grace + a cycle, or
  -- the alarm reports the net's patience as a failure.
  v_heal_grace timestamptz := now() - interval '15 minutes';
  v_min_dealt integer;
  v_inelig text[];
BEGIN
  SELECT r.bbj_min_players_dealt, r.bbj_ineligible_variants INTO v_min_dealt, v_inelig
    FROM public.ca_rake_rules r WHERE r.id = 1;

  RETURN QUERY
  WITH scope AS (
    SELECT r.hand_id, r.rake_amount, COALESCE(r.bbj_contribution, 0) AS bbj,
           r.pot_size, r.num_players, r.rake_method, r.player_contributions,
           r.created_at,
           t.id AS tid, t.small_blind, t.big_blind, t.club_id,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(array_length(hh.community_cards, 1), 0) AS board
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id
      LEFT JOIN hand_history hh ON hh.id = r.hand_id
     WHERE r.source = 'atomic_distribute_rake'
       AND r.created_at >= v_since AND r.created_at < v_grace
       AND t.tournament_id IS NULL AND r.is_tournament IS NOT TRUE
  )
  SELECT 'I1_drop_under_3_dealt'::text, count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players)) FILTER (WHERE true), '[]'::jsonb)
    FROM (SELECT hand_id, num_players FROM scope
           WHERE bbj > 0 AND num_players IS NOT NULL AND num_players < v_min_dealt LIMIT 20) x
  UNION ALL
  SELECT 'I2_drop_on_ineligible_variant', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'variant', variant)), '[]'::jsonb)
    FROM (SELECT hand_id, variant FROM scope
           WHERE bbj > 0 AND variant = ANY (v_inelig) LIMIT 20) x
  UNION ALL
  SELECT 'I3_deductions_exceed_pot', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'pot', pot_size, 'take', take)), '[]'::jsonb)
    FROM (SELECT hand_id, pot_size, rake_amount + bbj AS take FROM scope
           WHERE pot_size IS NOT NULL AND pot_size > 0
             AND rake_amount + bbj > pot_size + 0.001 LIMIT 20) x
  UNION ALL
  SELECT 'I4_eligible_flop_no_drop', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players, 'board', board, 'expected', expected)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.num_players, s.board,
                 public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) AS expected
            FROM scope s
           WHERE s.bbj = 0 AND s.board >= 3
             AND public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) > 0
           LIMIT 20) x
  UNION ALL
  SELECT 'I5_drop_not_banked_to_pool', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'bbj', bbj)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.bbj FROM scope s
           WHERE s.bbj > 0 AND s.hand_id IS NOT NULL
             AND s.created_at < v_heal_grace          -- outlast fn_bbj_repair_unbanked
             AND NOT EXISTS (SELECT 1 FROM bbj_contributions b
                              WHERE b.hand_id = s.hand_id
                                AND abs(b.amount - s.bbj) <= 0.01) LIMIT 20) x
  UNION ALL
  SELECT 'I6_ledger_not_reconciled', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'rake', rake_amount, 'alloc', alloc)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.rake_amount,
                 (SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                    FROM rake_attributions ra WHERE ra.hand_id = s.hand_id) AS alloc
            FROM scope s
           WHERE s.rake_method = 'WEIGHTED_CONTRIBUTED' AND s.rake_amount > 0
             AND s.hand_id IS NOT NULL AND s.player_contributions IS NOT NULL
             AND round((SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                          FROM rake_attributions ra WHERE ra.hand_id = s.hand_id), 2)
                 <> round(s.rake_amount, 2) LIMIT 20) x
  UNION ALL
  SELECT 'I7_raked_hand_never_banked', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb)
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since
             AND hh.created_at < v_heal_grace          -- outlast fn_rake_repair_unbanked
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
           LIMIT 20) x;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. GRANTS. The browser has no business here; the engine reads through the
--    service role. GRANT/REVOKE do not trigger a PostgREST reload.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ca_rake_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_rake_schedule_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_rake_rules, public.ca_rake_schedule_caps FROM anon, authenticated;
GRANT SELECT ON public.ca_rake_rules, public.ca_rake_schedule_caps TO service_role;

REVOKE ALL ON FUNCTION public.fn_rake_stake_price(numeric, numeric)                                                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_tier_price(numeric)                                                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_cap_for_dealt(numeric, integer)                                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_spec_rebuild_caps()                                                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_effective_bbj_drop(numeric, integer, boolean, uuid, uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_spec_canonical()                                                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_spec_checksum()                                                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_spec_self_check()                                                                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_stake_price(numeric, numeric)                                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_tier_price(numeric)                                                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_cap_for_dealt(numeric, integer)                                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_spec_rebuild_caps()                                                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake(numeric, numeric, integer, boolean, numeric, numeric, numeric)            TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_effective_bbj_drop(numeric, integer, boolean, uuid, uuid, text, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_spec_canonical()                                                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_spec_checksum()                                                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_spec_self_check()                                                                   TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. POST-APPLY ASSERTIONS. The transaction aborts if the spec this file
--    builds is not the spec the engine was compiled with, or is not
--    self-consistent. The live findings are REPORTED (NOTICE), never used to
--    abort: a real deviation is a bug to file, not a reason to leave the
--    audit blind.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- rakeSpecChecksum() for server/src/config/rakeSpec.ts at this commit
  -- (pinned by server/src/engine/RakeSpecParity.law.test.ts).
  c_expected constant text := '24f571834759564ce7929c33e50bb983';
  v_actual   text;
  v_caps     integer;
  v_bad      integer;
  v_hu       numeric;
  v_three    numeric;
  v_bbj      numeric;
  v_nfnd     numeric;
  v_over     integer;
  v_under    integer;
  v_bover    integer;
  v_bunder   integer;
  v_nf       integer;
BEGIN
  SELECT count(*) INTO v_caps FROM public.ca_rake_schedule_caps;
  IF v_caps <> 60 THEN
    RAISE EXCEPTION 'ca_rake_schedule_caps has % rows, expected 60 (19 scheduled stakes + 3.00) x 3', v_caps;
  END IF;

  SELECT count(*) INTO v_bad FROM public.fn_rake_spec_self_check();
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ca_rake_schedule_caps disagrees with its own derivation on % row(s)', v_bad;
  END IF;

  -- The engine's known answers (RakeSchedule.enforcement / HeadsUpRake tests).
  SELECT e.rake INTO v_hu    FROM public.fn_effective_rake(2, 100, 2, true, 1) e;   -- HU 5%, cap 2.50
  SELECT e.rake INTO v_three FROM public.fn_effective_rake(2, 100, 3, true, 1) e;   -- 3-dealt cap 3.35
  SELECT e.rake INTO v_nfnd  FROM public.fn_effective_rake(2, 100, 6, false, 1) e;  -- no flop, no drop
  v_bbj := public.fn_effective_bbj_drop(2, 5, true, NULL, NULL, 'nlh', 1);          -- 0.25 BB = 0.50
  IF v_hu <> 2.5 OR v_three <> 3.35 OR v_nfnd <> 0 OR v_bbj <> 0.5 THEN
    RAISE EXCEPTION 'fn_effective_rake/bbj do not reproduce the engine: hu=% three=% nfnd=% bbj=%',
      v_hu, v_three, v_nfnd, v_bbj;
  END IF;
  -- Tier-priced 3.00 (no schedule row): small tier, 10% / 5.00 / 0.25 BB.
  SELECT e.rake INTO v_three FROM public.fn_effective_rake(3, 100, 6, true, 1) e;
  IF v_three <> 5 OR public.fn_effective_bbj_drop(3, 4, true, NULL, NULL, 'nlh', 1) <> 0.75 THEN
    RAISE EXCEPTION 'tier fallback for 3.00 BB does not reproduce the engine (rake %, drop %)',
      v_three, public.fn_effective_bbj_drop(3, 4, true, NULL, NULL, 'nlh', 1);
  END IF;
  -- An override can only move downward: 20% / 50 BB collapses to the schedule.
  SELECT e.rake INTO v_hu FROM public.fn_effective_rake(2, 100, 6, true, 1, 20, 50) e;
  IF v_hu <> 5 THEN
    RAISE EXCEPTION 'override ceiling not honoured: expected 5.00, got %', v_hu;
  END IF;

  v_actual := public.fn_rake_spec_checksum();
  IF v_actual IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION 'rake spec checksum % does not match the engine''s % - canonical: %',
      v_actual, c_expected, public.fn_rake_spec_canonical();
  END IF;

  SELECT count(*) FILTER (WHERE kind = 'over_spec'),
         count(*) FILTER (WHERE kind = 'under_spec'),
         count(*) FILTER (WHERE kind = 'bbj_over_spec'),
         count(*) FILTER (WHERE kind = 'bbj_under_spec'),
         count(*) FILTER (WHERE kind = 'no_flop_no_drop')
    INTO v_over, v_under, v_bover, v_bunder, v_nf
    FROM public.fn_rake_law_violations(interval '2 hours');
  RAISE NOTICE 'rake spec % applied; last 2h vs spec: over=% under=% bbj_over=% bbj_under=% no_flop_no_drop=%',
    v_actual, v_over, v_under, v_bover, v_bunder, v_nf;
END $$;

COMMIT;
