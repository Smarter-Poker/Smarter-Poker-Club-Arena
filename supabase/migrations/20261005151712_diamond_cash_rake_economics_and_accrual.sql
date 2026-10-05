-- ============================================================================
-- DIAMOND CASH RAKE: THE SETTINGS, THE ACCRUAL, THE SWEEP AND THE RECOMPUTE
-- ============================================================================
--
-- Phase 9 line (b) of the programme, "Implement rake/fees/BBJ destinations only
-- in Diamond accounts, where approved", for the CASH-GAME half. It follows
-- docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 5 step by step and
-- builds section 3.2's settings table underneath it. It redesigns nothing.
--
-- WHY THIS MIGRATION CARRIES NUMBERS AT ALL. Section 1 of that document calls
-- B4 to B13 "The Decisions Dan Must Make" and proposes no value. Dan answered
-- the whole list on 2026-10-05, verbatim: "NOTHING IS MINE, EVER.... THEY ARE
-- ALWAYS YOURS TO DO." That is a later explicit owner instruction and under
-- CLAUDE.md 10.8 it governs over the earlier framing. It delegates the
-- decision; it does not license inventing a figure. Every number below is
-- DERIVED from what this platform already runs, each row records its basis in
-- its own column, and any one of them is changed by inserting a new row - never
-- by editing code.
--
-- THE DERIVATION, MEASURED 2026-10-05 ON PRODUCTION (READ-ONLY).
--
-- The Diamond Arena is a diamonds-only 1:1 clone of a chip club, and the stake
-- ladder proves it. The seventeen live Diamond cash tables are dealt at these
-- blinds, in whole Diamonds:
--
--   1/2  2/5  5/10  10/20  10/25  25/50  50/100  100/200  200/400  200/500
--   300/600  400/800  500/1000  1000/2000  1000/2500  2500/5000  5000/10000
--
-- Every one of those seventeen pairs is a row of the chip schedule in
-- server/src/config/rakeSpec.ts read in the chip indivisible unit: chip
-- $0.01/$0.02 is 1/2 cents, chip $0.25/$0.50 is 25/50 cents, chip $50/$100 is
-- 5000/10000 cents. Not one Diamond stake is missing from the chip schedule and
-- not one needs a tier fallback. The two ladders are the same ladder with the
-- indivisible unit swapped: one cent becomes one Diamond.
--
-- So the chip CAP carries exactly, and it carries as a whole number. The chip
-- caps are absolute money amounts per stake, not big-blind multiples; read in
-- cents they are 30, 75, 150, 300, 500, 750, 800, 1000, 1250, 1500 and 2000,
-- and every single one is an integer. The Diamond cap at a stake is the chip cap
-- at the same rung, in Diamonds. Nothing is rounded and nothing is invented.
--
-- The chip PERCENT carries because a percentage has no unit: all nineteen chip
-- schedule rows and all six ca_rake_tier rows read rake_percent = 10, and Dan
-- set it in those words on 2026-08-27 ("Rake is 10% with a max cap. Heads up is
-- 5% rake.").
--
-- WHERE THE DERIVATION DOES NOT CARRY, AND WHAT REPLACES IT. The design warns
-- about two items by name and both warnings are honoured:
--
--   B7, short-handed. "The chip short-handed rules are chip rules and carry
--   nothing to Diamonds." They do not, and for a measurable reason: the chip
--   rules are cap MULTIPLIERS (0.5 heads-up, 0.75 three-handed) and a multiplier
--   on a whole-Diamond cap is not a whole Diamond - 0.75 of the bb:5 cap is
--   56.25 Diamonds, which no door can take. So no multiplier runs at settlement
--   time. The heads-up ladder is published as explicit whole Diamonds per stake,
--   floored (B10) where the half is not exact; sixteen of the seventeen halve
--   exactly, and only bb:5 (75 -> 37.5) floors, to 37. The three-handed chip
--   discount is not carried at all: Dan gated it on nine seats on 2026-09-14
--   ("once any 6-8 handed game reaches 3+ players full rake + BBJ is applied"),
--   so even in chips it is a rule about one table shape rather than a rule about
--   three-handed play, and eleven of the seventeen Diamond tables are six-max,
--   where the chip rule itself charges the full cap. A three-handed Diamond pot
--   therefore pays the ordinary percent and the ordinary cap - recorded as rows
--   of its own at scope dealt:3, not as silence.
--
--   B13, VIP points. "Chip VIP points are earned by a trigger on the chip rake
--   records, which a Diamond rake will never write." Exactly so:
--   trg_award_vip_points_from_rake fires on rake_records, this migration fences
--   rake_records against a Diamond Arena row, and there is no Diamond VIP ledger
--   to derive a rate from. No.
--
-- B10 was not a free choice: fn_ca_unit_floor_cents floors, the Diamond
-- tournament fee floors, and the Diamond creation door floors. Rake floors.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH. cash_games_enabled stays exactly as it is
-- found; opening it is a separate, owner-held step. tournaments_enabled stays
-- exactly as it is found. The Diamond table rows keep rake_percent, rake_cap_bb
-- and bbj_percent at an explicit 0 for ever (design 3.2), so boundary layers 1
-- and 2 keep refusing any table that inherits a chip schedule, and the Diamond
-- rake is read from ca_diamond_economics and from nowhere else. The jackpot
-- amount stays held at zero: B14 to B22 and the jackpot pool belong to the BBJ
-- lane, and this settler still refuses a non-zero p_bbj by name. Insurance stays
-- refused, for ever.
--
-- ONE TRANSACTION. One BEGIN, one COMMIT.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. ca_diamond_economics: one table owned by Dan, with no defaults anywhere
-- ----------------------------------------------------------------------------
--
-- Design 3.2. Append-only rows; a new answer is a new row and the current value
-- is the latest row for its name and scope. The reader never returns NULL,
-- never falls back to another scope, to a chip value or to a literal.
--
-- SHARED WITH THE A-LANE. This table is the single place every Diamond economic
-- number lives, for line (a) as well as line (b). It is created here if absent
-- and extended, never replaced: the name list is a function another migration
-- adds names to, and nothing in this file assumes it holds only cash-rake rows.

CREATE TABLE IF NOT EXISTS public.ca_diamond_economics (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  scope         text        NOT NULL,
  value         numeric     NULL,
  value_text    text        NULL,
  units         text        NOT NULL,
  approved_quote text       NOT NULL,
  basis         text        NOT NULL,
  approved_on   date        NOT NULL,
  recorded_by   text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- The quote may not be empty (design 3.2) and neither may the basis: a number
-- with no derivation recorded beside it is the thing CLAUDE.md forbids.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.ca_diamond_economics'::regclass
                    AND conname='ca_diamond_economics_quote_and_basis_are_stated') THEN
    ALTER TABLE public.ca_diamond_economics
      ADD CONSTRAINT ca_diamond_economics_quote_and_basis_are_stated
      CHECK (length(btrim(approved_quote)) > 0 AND length(btrim(basis)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.ca_diamond_economics'::regclass
                    AND conname='ca_diamond_economics_has_exactly_one_value') THEN
    ALTER TABLE public.ca_diamond_economics
      ADD CONSTRAINT ca_diamond_economics_has_exactly_one_value
      CHECK ((value IS NULL) <> (value_text IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.ca_diamond_economics'::regclass
                    AND conname='ca_diamond_economics_scope_is_stated') THEN
    ALTER TABLE public.ca_diamond_economics
      ADD CONSTRAINT ca_diamond_economics_scope_is_stated
      CHECK (length(btrim(scope)) > 0 AND scope = lower(scope));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ca_diamond_economics_current_idx
  ON public.ca_diamond_economics (name, scope, id DESC);

-- The CLOSED NAME LIST. One row per question of the design's section 1 that this
-- lane answers, with the units its answer is measured in. A name that is not on
-- this list cannot be inserted; a value whose units disagree with the name
-- cannot be inserted. Another lane adds its own names by redefining this
-- function and keeping every name already here.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_names()
RETURNS TABLE(name text, units text, question text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT * FROM (VALUES
    ('cash_rake_enabled',          'switch',   'B4 is rake taken from Diamond cash-game pots'),
    ('cash_rake_percent',          'percent',  'B5/B7 percentage of the pot, by players dealt in'),
    ('cash_rake_cap_diamonds',     'diamonds', 'B6/B7 most rake one hand may pay, by stake and players dealt in'),
    ('cash_rake_preflop_raked',    'switch',   'B8 is a hand that ends before the flop raked'),
    ('cash_rake_min_pot_diamonds', 'diamonds', 'B9 smallest pot that is raked'),
    ('cash_rake_rounding',         'rounding', 'B10 which way a fraction of a Diamond is rounded'),
    ('cash_rake_destination',      'account',  'B11 where Diamond cash-game rake goes'),
    ('cash_rakeback_percent',      'percent',  'B12 what part of Diamond rake goes back to the players who paid it'),
    ('cash_rake_vip_points',       'switch',   'B13 does Diamond rake earn VIP points')
  ) AS t(name, units, question);
$function$;

-- An account-valued answer names an account whose STORAGE EXISTS (design 3.2).
-- There is exactly one platform-owned Diamond account today, and "retired from
-- supply" needs no storage because the payers' own spend rows retire it.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_accounts()
RETURNS TABLE(account text, storage text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT * FROM (VALUES
    ('diamond_house',      'public.ca_diamond_house row 1'),
    ('retired_from_supply', 'none: the payers'' spend rows retire it')
  ) AS t(account, storage);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economics_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_units text;
BEGIN
  -- APPEND ONLY. A row is never updated or deleted; a new answer is a new row
  -- (design 3.2). Without this the audit trail of what was approved when is a
  -- story anyone with UPDATE can rewrite.
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'diamond_economics_is_append_only' USING ERRCODE='23514';
  END IF;
  SELECT n.units INTO v_units FROM public.fn_ca_diamond_economic_names() n WHERE n.name = NEW.name;
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', NEW.name USING ERRCODE='23514';
  END IF;
  IF NEW.units IS DISTINCT FROM v_units THEN
    RAISE EXCEPTION 'diamond_economics_units_disagree:% is %, not %', NEW.name, v_units, NEW.units
      USING ERRCODE='23514';
  END IF;
  -- Each unit has a shape, and a shape nobody checks is a shape that drifts.
  IF v_units = 'switch' AND (NEW.value IS NULL OR NEW.value NOT IN (0,1)) THEN
    RAISE EXCEPTION 'diamond_economics_switch_is_0_or_1:%', NEW.name USING ERRCODE='23514';
  END IF;
  IF v_units = 'percent' AND (NEW.value IS NULL OR NEW.value < 0 OR NEW.value > 100) THEN
    RAISE EXCEPTION 'diamond_economics_percent_out_of_range:%', NEW.name USING ERRCODE='23514';
  END IF;
  IF v_units = 'diamonds' AND (NEW.value IS NULL OR NEW.value < 0 OR NEW.value <> trunc(NEW.value)) THEN
    RAISE EXCEPTION 'diamond_economics_diamonds_are_whole_and_not_negative:%', NEW.name
      USING ERRCODE='23514';
  END IF;
  IF v_units = 'rounding'
     AND (NEW.value_text IS NULL OR NEW.value_text NOT IN ('down','nearest','up')) THEN
    RAISE EXCEPTION 'diamond_economics_rounding_is_down_nearest_or_up:%', NEW.name
      USING ERRCODE='23514';
  END IF;
  IF v_units = 'account' AND NOT EXISTS (
       SELECT 1 FROM public.fn_ca_diamond_economic_accounts() a WHERE a.account = NEW.value_text) THEN
    RAISE EXCEPTION 'diamond_economics_unknown_account:%', COALESCE(NEW.value_text,'(null)')
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS zz_ca_diamond_economics_guard ON public.ca_diamond_economics;
CREATE TRIGGER zz_ca_diamond_economics_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ca_diamond_economics
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_economics_guard();

-- ----------------------------------------------------------------------------
-- 1b. The refusing reader
-- ----------------------------------------------------------------------------
--
-- "returns the current value, and when there is none raises
-- diamond_economics_unset:<name>/<scope> under one SQLSTATE no Diamond door uses
-- today. It never returns NULL and never falls back to another scope, to a chip
-- value or to a literal." (design 3.2)
--
-- P0D01 is that SQLSTATE. Measured 2026-10-05: no migration in this repository
-- raises any P0D code, so no existing handler can swallow this one.

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_value numeric; v_found boolean;
BEGIN
  SELECT e.value, true INTO v_value, v_found
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = p_scope AND e.value IS NOT NULL
   ORDER BY e.id DESC LIMIT 1;
  IF NOT COALESCE(v_found,false) THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'(null)')
      USING ERRCODE='P0D01';
  END IF;
  RETURN v_value;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_value text; v_found boolean;
BEGIN
  SELECT e.value_text, true INTO v_value, v_found
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = p_scope AND e.value_text IS NOT NULL
   ORDER BY e.id DESC LIMIT 1;
  IF NOT COALESCE(v_found,false) THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'(null)')
      USING ERRCODE='P0D01';
  END IF;
  RETURN v_value;
END $function$;

-- A money setting is not a public read.
REVOKE ALL ON TABLE public.ca_diamond_economics FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_diamond_economics FROM anon, authenticated;
GRANT SELECT ON TABLE public.ca_diamond_economics TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic(text,text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_text(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_text(text,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_text(text,text) TO service_role;
-- The table itself is readable by nobody through RLS and has no policy; the two
-- readers are SECURITY DEFINER so a money door can read a setting while a
-- browser cannot read the table, and EXECUTE on them is service_role only.
ALTER TABLE public.ca_diamond_economics ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. The answers to B4 to B13, each with the derivation that produced it
-- ----------------------------------------------------------------------------
--
-- approved_quote is Dan's words, verbatim, delegating these decisions. basis is
-- how the number was derived; it is NOT a quote and does not pretend to be one.
-- Every row here is insert-only: changing any number is one INSERT, no rebuild.
--
-- The quote is deliberately the SAME on every row, because one instruction
-- answered the whole list. Reading nine different quotes into nine rows would
-- be inventing approvals that were never given separately.

INSERT INTO public.ca_diamond_economics
  (name, scope, value, value_text, units, approved_quote, basis, approved_on, recorded_by)
VALUES
  -- B4. Yes.
  ('cash_rake_enabled', 'all', 1, NULL, 'switch',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B4. Derived from the clone: the Diamond Arena is a diamonds-only 1:1 clone of a chip club, '
   'every chip cash pot is raked by the schedule in server/src/config/rakeSpec.ts, and cash play '
   'is the arena''s only cash revenue. The switch being on moves nothing while cash_games_enabled '
   'is closed, which is where this migration leaves it.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B5 and B7, the percentage. Four or more dealt in, three dealt in, two dealt in.
  ('cash_rake_percent', 'dealt:4plus', 10, NULL, 'percent',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B5. All nineteen rows of the chip schedule and all six ca_rake_tier rows read rake_percent = 10; '
   'Dan set it in those words on 2026-08-27 ("Rake is 10% with a max cap"). A percentage has no unit, '
   'so it carries from chips to Diamonds unchanged.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),
  ('cash_rake_percent', 'dealt:3', 10, NULL, 'percent',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B7. The ordinary percentage. The chip estate has no three-handed PERCENT discount at all - only a '
   'cap multiplier, and that one is gated on nine seats by Dan 2026-09-14 ("once any 6-8 handed game '
   'reaches 3+ players full rake + BBJ is applied"), so it is a rule about one chip table shape and '
   'carries nothing. Recorded as its own row rather than left silent.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),
  ('cash_rake_percent', 'dealt:2', 5, NULL, 'percent',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B7. Dan, 2026-08-27, verbatim in rakeSpec.ts RULES: "Heads up is 5% rake." Stated as a percentage, '
   'which has no unit, so it is the one short-handed chip rule that does carry.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B8. No flop, no drop.
  ('cash_rake_preflop_raked', 'all', 0, NULL, 'switch',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B8. No. RAKE_SPEC.rules.noFlopNoDrop is true, cited to Bible V8 section 2.9 / Appendix A and to '
   'Dan 2026-08-29 ("no flop, no drop"). It is a rule of the game, not an amount, so it carries.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B9. No minimum of its own.
  ('cash_rake_min_pot_diamonds', 'all', 0, NULL, 'diamonds',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B9. No separate minimum, which is the chip answer: effectiveRake applies no pot floor, and '
   'RAKE_SPEC.rules.bbjMinPotBB is commented "PAYOUT floor only (Dan 2026-08-29); never a fee gate". '
   'Reasoning from the indivisible unit, the floor in B10 already makes a pot under 10 Diamonds pay '
   'nothing at 10 percent, so the smallest raked pot is 10 Diamonds as an arithmetic consequence '
   'rather than as a gate anyone has to maintain.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B10. Down.
  ('cash_rake_rounding', 'all', NULL, 'down', 'rounding',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B10. Down. The estate already has a whole-unit convention and it floors: fn_ca_unit_floor_cents '
   'truncates, the Diamond tournament entry fee floors to a whole Diamond, and the Diamond rebuy fee '
   'floors. The chip engine rounds to the nearest CENT, which is a different indivisible unit; '
   'diverging from the estate''s own Diamond convention would need a reason and there is none.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B11. The house.
  ('cash_rake_destination', 'all', NULL, 'diamond_house', 'account',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B11. The house. It is the only platform-owned Diamond account that exists (design R1), and it is '
   'already where the Diamond tournament FEE lands: fn_poker_diamond_tournament_settle_fee credits '
   'ca_diamond_house with a ca_mint_ledger mint row, reason DR14 (poker_tournament_fee). The rebuild '
   'contract warns that the house is one row and "it will jam the day rake starts flowing"; that is '
   'answered by design R4, which is why the rake accrues per hand and crosses to the house once per '
   'sweep rather than once per hand.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B12. No rakeback.
  ('cash_rakeback_percent', 'all', 0, NULL, 'percent',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B12. None. The database refuses any rakeback, agent or commission record for the Diamond Arena '
   'today: trigger poker_arena_no_hierarchy raises "Diamond Arena Has No Agents Or Commissions" on '
   'eleven tables, five of them the rakeback tables, and ruling 16 says "No unions, agents, '
   'commissions, chip wallets, chip ledgers or chip conversion". There is no Diamond rakeback door and '
   'no Diamond period to derive a rate or a frequency from, so the derivation gives zero.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

  -- B13. No VIP points.
  ('cash_rake_vip_points', 'all', 0, NULL, 'switch',
   'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
   'B13. No, for the reason the design states: chip VIP points are awarded by '
   'trg_award_vip_points_from_rake, a trigger on rake_records, and a Diamond rake will never write '
   'that table - section 6 of this migration makes writing it a refusal. There is no Diamond VIP '
   'points ledger to derive a rate from.',
   '2026-10-05', 'claude-opus-5 for Smarter-Poker');

-- B6 and B7, the caps. One row per stake per dealt-in bracket, in whole
-- Diamonds, published rather than computed: the chip cap FACTORS (0.5, 0.75) are
-- multipliers on a denominated cap and a multiplier can land between two
-- Diamonds, so no factor runs at settlement time.
--
-- chip_sb/chip_bb are the chip schedule row this stake IS, in cents.
-- chip_cap is that row's rakeCap in dollars; cap_diamonds is the same amount in
-- cents, which is the same integer read in Diamonds.
DO $$
DECLARE
  v_quote constant text := 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.';
  r record;
  v_hu numeric;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (   2::numeric,    1::numeric, '0.01/0.02', 0.30::numeric,   30::numeric),
      (   5,             2,          '0.02/0.05', 0.75,            75),
      (  10,             5,          '0.05/0.10', 1.50,           150),
      (  20,            10,          '0.10/0.20', 3.00,           300),
      (  25,            10,          '0.10/0.25', 3.00,           300),
      (  50,            25,          '0.25/0.50', 3.00,           300),
      ( 100,            50,          '0.50/1.00', 5.00,           500),
      ( 200,           100,          '1/2',       5.00,           500),
      ( 400,           200,          '2/4',       7.50,           750),
      ( 500,           200,          '2/5',       7.50,           750),
      ( 600,           300,          '3/6',       8.00,           800),
      ( 800,           400,          '4/8',      10.00,          1000),
      (1000,           500,          '5/10',     12.50,          1250),
      (2000,          1000,          '10/20',    15.00,          1500),
      (2500,          1000,          '10/25',    15.00,          1500),
      (5000,          2500,          '25/50',    20.00,          2000),
      (10000,         5000,          '50/100',   20.00,          2000)
    ) AS t(bb, sb, chip_row, chip_cap, cap_diamonds)
  LOOP
    v_hu := trunc(r.cap_diamonds / 2);

    INSERT INTO public.ca_diamond_economics
      (name, scope, value, units, approved_quote, basis, approved_on, recorded_by)
    VALUES
      ('cash_rake_cap_diamonds', 'bb:'||r.bb::bigint||'/dealt:4plus', r.cap_diamonds, 'diamonds',
       v_quote,
       format('B6. The Diamond %s/%s table IS chip schedule row %s read in the indivisible unit '
              '(chip $%s/$%s is %s/%s cents). That row''s rakeCap is $%s, which is %s cents, and %s '
              'cents read in Diamonds is %s Diamonds - a whole number, so nothing is rounded and '
              'nothing is invented.',
              r.sb::bigint, r.bb::bigint, r.chip_row,
              (r.sb/100)::text, (r.bb/100)::text, r.sb::bigint, r.bb::bigint,
              r.chip_cap::text, (r.chip_cap*100)::bigint, (r.chip_cap*100)::bigint,
              r.cap_diamonds::bigint),
       '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

      ('cash_rake_cap_diamonds', 'bb:'||r.bb::bigint||'/dealt:3', r.cap_diamonds, 'diamonds',
       v_quote,
       format('B7. Three dealt in pays the ordinary cap of %s Diamonds. The chip three-handed cap '
              'factor of 0.75 is gated on a nine-seat table by Dan 2026-09-14, so it is a rule about '
              'one chip table shape rather than about three-handed play, and eleven of the seventeen '
              'live Diamond tables are six-max, where the chip rule itself charges the full cap. '
              'It carries nothing and nothing replaces it.', r.cap_diamonds::bigint),
       '2026-10-05', 'claude-opus-5 for Smarter-Poker'),

      ('cash_rake_cap_diamonds', 'bb:'||r.bb::bigint||'/dealt:2', v_hu, 'diamonds',
       v_quote,
       format('B7. Two dealt in pays %s Diamonds, half the %s Diamond cap%s. The chip heads-up cap '
              'factor is 0.5 and a ratio has no unit, but the RESULT must be a whole Diamond, so the '
              'ladder is published as explicit whole amounts instead of a multiplier applied at '
              'settlement time.',
              v_hu::bigint, r.cap_diamonds::bigint,
              CASE WHEN v_hu*2 = r.cap_diamonds THEN ', which halves exactly'
                   ELSE format(' (%s halves to %s, floored to %s by B10)',
                               r.cap_diamonds::bigint, (r.cap_diamonds/2)::text, v_hu::bigint) END),
       '2026-10-05', 'claude-opus-5 for Smarter-Poker');
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 3. The rake accrual: per-hand money that never touches the house row
-- ----------------------------------------------------------------------------
--
-- Design R4, verbatim: "Every house write locks ca_diamond_house row 1. Per-hand
-- rake and jackpot drops therefore accrue in append-only player-side rows inside
-- the arena float and cross to their destination by R2 in a periodic sweep: one
-- house write per sweep, not per hand." The rebuild contract says the same thing
-- from the other side: "ca_diamond_house.balance is still a single row today. If
-- the new arena sends rake there, fix that first - it will jam the day rake
-- starts flowing."
--
-- THE SWEEP IS NOT A BAND-AID. CLAUDE.md 10.12 forbids a cron, sweep, backfill
-- or reconciler offered as the answer to a defect. This sweep is not that: it is
-- the product's own design for a per-hand amount that must not serialize on one
-- row, it is named in the design before any defect existed, and nothing is wrong
-- if it has not run yet - the Diamonds are accounted for, in the arena float,
-- attributed to their payers, every hour they sit there. No cron is installed by
-- this migration.
--
-- WHOSE ROWS THESE ARE. A payer is a payer. There is no is_horse filter here,
-- in the attribution, in the sweep or in any total: CLAUDE.md 10.5 - a horse
-- earns and is paid everything a human is from the same action, rake included.
-- An earlier agent's invented is_horse filter in a rake function cost 39
-- tournaments their whole rake attribution; nothing in this file repeats it.

CREATE TABLE IF NOT EXISTS public.ca_diamond_rake_accrual (
  id           bigserial   PRIMARY KEY,
  table_id     uuid        NOT NULL,
  hand_number  bigint      NOT NULL,
  arena_id     uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  kind         text        NOT NULL,
  amount       bigint      NOT NULL,
  swept_at     timestamptz NULL,
  sweep_id     uuid        NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_diamond_rake_accrual_amount_is_whole_and_positive CHECK (amount > 0),
  CONSTRAINT ca_diamond_rake_accrual_kind CHECK (kind IN ('rake')),
  CONSTRAINT ca_diamond_rake_accrual_sweep_is_whole
    CHECK ((swept_at IS NULL) = (sweep_id IS NULL))
);

-- One row per payer per hand per kind. A replay cannot write a second one, and a
-- duplicate is a loud failure rather than a silent ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS ca_diamond_rake_accrual_one_per_payer_per_hand
  ON public.ca_diamond_rake_accrual (table_id, hand_number, user_id, kind);
CREATE INDEX IF NOT EXISTS ca_diamond_rake_accrual_unswept_idx
  ON public.ca_diamond_rake_accrual (id) WHERE swept_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rake_accrual_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- APPEND ONLY, with one exception that is itself append-only: the sweep stamp
  -- is written once and never cleared. Everything else about the row is fixed,
  -- because the row is the record of Diamonds a named player paid.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'diamond_rake_accrual_is_append_only' USING ERRCODE='23514';
  END IF;
  IF NEW.table_id    IS DISTINCT FROM OLD.table_id
     OR NEW.hand_number IS DISTINCT FROM OLD.hand_number
     OR NEW.arena_id  IS DISTINCT FROM OLD.arena_id
     OR NEW.user_id   IS DISTINCT FROM OLD.user_id
     OR NEW.kind      IS DISTINCT FROM OLD.kind
     OR NEW.amount    IS DISTINCT FROM OLD.amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'diamond_rake_accrual_is_append_only' USING ERRCODE='23514';
  END IF;
  IF OLD.swept_at IS NOT NULL THEN
    RAISE EXCEPTION 'diamond_rake_accrual_is_swept_once' USING ERRCODE='23514';
  END IF;
  IF NEW.swept_at IS NULL OR NEW.sweep_id IS NULL THEN
    RAISE EXCEPTION 'diamond_rake_accrual_is_swept_once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS zz_ca_diamond_rake_accrual_guard ON public.ca_diamond_rake_accrual;
CREATE TRIGGER zz_ca_diamond_rake_accrual_guard
  BEFORE UPDATE OR DELETE ON public.ca_diamond_rake_accrual
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_rake_accrual_guard();

REVOKE ALL ON TABLE public.ca_diamond_rake_accrual FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_diamond_rake_accrual FROM anon, authenticated;
GRANT SELECT ON TABLE public.ca_diamond_rake_accrual TO service_role;
ALTER TABLE public.ca_diamond_rake_accrual ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3b. A new holding is counted in the migration that creates it (design R5)
-- ----------------------------------------------------------------------------
--
-- Unswept rake is player-side money inside the arena float: it left custody and
-- has not yet crossed to the house, so it must be in fn_ca_arena_diamonds() or
-- the identity breaks by exactly the accrued amount on the first raked hand.
-- SWEPT rows are excluded: once swept the Diamonds are in ca_diamond_house, and
-- counting them in both places would double them.
--
-- This also keeps the accounting contract the-books-do-not-depend-on-the-arena
-- pins: whatever parks diamonds outside the player wallet provides
-- fn_ca_arena_diamonds(), and the books need no other change.
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open')
   +(SELECT COALESCE(sum(amount),0)::numeric FROM public.ca_diamond_rake_accrual WHERE swept_at IS NULL);
$function$;

-- THE FLOAT METER IS NOT PUBLIC SURFACE, AND THE MIGRATION SAYS SO ITSELF.
-- Measured on production 2026-10-05: this function's ACL is already
-- {postgres=X/postgres, service_role=X/postgres}, so PUBLIC and the two
-- pre-login roles hold nothing and these two statements change nothing there.
-- They are here because CREATE OR REPLACE preserves whatever grants exist and
-- a FRESH database would hand a new SECURITY DEFINER function to PUBLIC by
-- default: a migration that only works because of state it did not create is a
-- migration that stops working the first time it is replayed. PUBLIC is named
-- as well as the roles, because anon inherits whatever PUBLIC holds.
--
-- Nothing is weakened: an unauthenticated caller could not read the arena float
-- before this migration and cannot read it after. No RLS policy calls it
-- (checked against pg_policy on production: none), and its six callers are all
-- server-side functions that reach it as the owner.
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;

-- ----------------------------------------------------------------------------
-- 4. The settler recomputes; it does not take the engine's number on trust
-- ----------------------------------------------------------------------------
--
-- Design section 5, steps 3, 4 and 5. Three things change and nothing else does.
--
--   (a) CONSERVATION. It was "the stack deltas sum to exactly zero". It becomes
--       "the stack deltas sum to minus (rake plus jackpot drop)". With both
--       amounts zero that is the same rule, which is why today's behaviour is
--       unchanged until a rake is actually taken.
--   (b) THE RECOMPUTE. The engine's p_rake is checked against the rake the
--       Diamond settings produce for this hand, and a disagreement refuses by
--       name. The settings are read from ca_diamond_economics and from nowhere
--       else - never RAKE_SPEC, never ca_rake_tier, never tables.rake_percent.
--   (c) THE ACCRUAL. The rake is attributed to the pot's contributors by
--       WEIGHTED_CONTRIBUTED and written to ca_diamond_rake_accrual.
--
-- THE FACTS THE RECOMPUTE NEEDS, AND WHERE THEY COME FROM. Section 7 of the
-- design flagged this as unverified: "The settler's recomputation of rake
-- assumes the accepted hand row carries whether a flop was dealt and how many
-- were dealt in; the row's exact fields for that were not read." They were read
-- on 2026-10-05, and it does not. p_stacks carries user_id, seat_id,
-- seat_joined_at, stack_before and stack, and nothing else; the router
-- fn_ca_settle_hand_stacks_absolute forwards it unchanged.
--
-- Rather than thread a new parameter through the chip commit doors for a Diamond
-- feature, the facts ride on the payload the router already forwards. Each
-- element gains three keys:
--
--   contributed    whole Diamonds this player put into the pot and did not get
--                  back as an uncalled bet. The pot is their sum.
--   dealt_in       whether this player was dealt a hand. Their count is "dealt".
--   hand_saw_flop  whether a flop was dealt. This is a fact about the HAND, not
--                  about a player, and the payload is an array, so it rides on
--                  every element and they must agree. A payload whose elements
--                  disagree about one hand is refused rather than resolved.
--
-- WHEN THEY ARE REQUIRED. Whenever the rake switch is on - not merely when
-- p_rake is non-zero. A zero that nobody can verify is not a verified zero: if
-- the facts were optional, an engine that silently stopped raking would settle
-- every hand without a word. So with the switch on, a hand arriving without its
-- facts refuses by name. THE CONSEQUENCE IS DELIBERATE AND MUST BE READ: the
-- engine must learn to send these three keys BEFORE cash_games_enabled is
-- opened, or every Diamond cash hand refuses. That switch is closed today and is
-- the owner's to open.
--
-- WATCHED GUARD. fn_poker_diamond_settle_cash_hand is on
-- fn_ca_guard_watchlist(); this transaction declares the redefinition below.

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_settle_cash_hand(
  p_table_id uuid, p_hand_number bigint, p_stacks jsonb,
  p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid;
  v_bb bigint;
  v_request jsonb;
  v_stacks jsonb;
  v_prior public.poker_diamond_hand_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_e jsonb;
  v_lot record;
  v_before bigint;
  v_after bigint;
  v_loss bigint;
  v_take bigint;
  v_written jsonb := '{}'::jsonb;
  v_result jsonb;
  -- The rake arithmetic, all of it integer.
  v_rake_on boolean;
  v_rake bigint;
  v_facts jsonb := NULL;
  v_pot bigint;
  v_dealt integer;
  v_saw_flop boolean;
  v_dealt_key text;
  v_pct numeric;
  v_cap numeric;
  v_min_pot numeric;
  v_preflop numeric;
  v_rounding text;
  v_expected bigint;
  v_attributed bigint;
BEGIN
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_bbj,0) <> 0 OR COALESCE(p_inflow,0) <> 0 THEN
    -- THE JACKPOT AND INSURANCE AMOUNTS STAY HELD AT ZERO. B14 to B22 are not
    -- answered and the Diamond jackpot pool does not exist, so a drop has
    -- nowhere to sit; insurance is refused for ever (the counterparty is a chip
    -- wallet). Only the rake amount is admitted here.
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  IF COALESCE(p_rake,0) < 0 OR COALESCE(p_rake,0) <> trunc(COALESCE(p_rake,0)) THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  v_rake := COALESCE(p_rake,0)::bigint;

  -- THE SWITCH IS AN ANSWER (design 3.2). Absent or off means the amount is
  -- exactly zero and this door keeps refusing anything else; on with a required
  -- value unset refuses by name, never "on with a default".
  BEGIN
    v_rake_on := public.fn_ca_diamond_economic('cash_rake_enabled','all') = 1;
  EXCEPTION WHEN SQLSTATE 'P0D01' THEN
    v_rake_on := false;
  END;
  IF NOT v_rake_on AND v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'diamond_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_stacks) < 2 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'diamond_exact_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE NOT pg_input_is_valid(x->>'user_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_joined_at','timestamp with time zone')
       OR (x->>'stack')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack_before')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack')::numeric <> trunc((x->>'stack')::numeric)
       OR (x->>'stack_before')::numeric <> trunc((x->>'stack_before')::numeric)
  ) OR (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid)
         OR count(*) <> count(DISTINCT (x->>'seat_id')::uuid)
        FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'diamond_invalid_hand_amount_or_generation' USING ERRCODE='22023';
  END IF;

  -- CONSERVATION, RESTATED. The stacks after the hand are short by exactly the
  -- rake and the jackpot drop, and by nothing else. With both zero this is the
  -- rule that ran before this migration, unchanged.
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> -(v_rake + COALESCE(p_bbj,0)) THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;

  SELECT t.club_id, t.big_blind INTO v_arena, v_bb FROM public.tables t
  JOIN public.clubs c ON c.id=t.club_id
  WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
    AND c.union_id IS NULL AND t.union_id IS NULL
    AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)
    AND t.big_blind = trunc(t.big_blind) AND t.big_blind > 0
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;

  -- THE RECOMPUTE. With the switch on, every hand carries its facts and the
  -- rake is recomputed from the Diamond schedule. A hand whose facts are
  -- missing, malformed or self-contradictory is refused, not resolved.
  IF v_rake_on THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_stacks) x
      WHERE jsonb_typeof(x->'contributed') IS DISTINCT FROM 'number'
         OR jsonb_typeof(x->'dealt_in') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(x->'hand_saw_flop') IS DISTINCT FROM 'boolean'
         OR (x->>'contributed')::numeric < 0
         OR (x->>'contributed')::numeric <> trunc((x->>'contributed')::numeric)
         OR (x->>'contributed')::numeric > 2147483647
    ) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_required' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(DISTINCT (x->>'hand_saw_flop')) FROM jsonb_array_elements(p_stacks) x) <> 1 THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    SELECT sum((x->>'contributed')::bigint),
           count(*) FILTER (WHERE (x->>'dealt_in')::boolean),
           bool_or((x->>'hand_saw_flop')::boolean)
      INTO v_pot, v_dealt, v_saw_flop
      FROM jsonb_array_elements(p_stacks) x;
    -- A player who contributed cannot have been sitting out.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE (x->>'contributed')::bigint > 0 AND NOT (x->>'dealt_in')::boolean) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    -- TWO BOUNDS THAT TIE THE CLAIMED CONTRIBUTIONS TO THE STACKS THAT MOVED.
    -- Without them "contributed" is a number the engine asserts about itself and
    -- the attribution rests on nothing.
    --   A player cannot lose more than they put in. This is what makes the
    --   per-player weights trustworthy, and summed it also gives pot >= losses.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE greatest((x->>'stack_before')::bigint-(x->>'stack')::bigint,0)
                      > (x->>'contributed')::bigint) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    --   Nobody contributes Diamonds they did not bring to the hand.
    IF v_pot > (SELECT COALESCE(sum((x->>'stack_before')::bigint),0)
                  FROM jsonb_array_elements(p_stacks) x) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;

    v_dealt_key := CASE WHEN v_dealt <= 2 THEN 'dealt:2'
                        WHEN v_dealt = 3 THEN 'dealt:3'
                        ELSE 'dealt:4plus' END;
    -- EVERY NUMBER IS READ, NONE IS A LITERAL, AND NONE FALLS BACK. An unset
    -- name raises diamond_economics_unset:<name>/<scope> out of this door and on
    -- to the client, which is the design's rule: "the settler refuses a raked
    -- hand with the unset name of B5". A Diamond stake with no published cap row
    -- therefore refuses by name rather than being raked at some other stake's
    -- cap.
    v_pct      := public.fn_ca_diamond_economic('cash_rake_percent', v_dealt_key);
    v_cap      := public.fn_ca_diamond_economic('cash_rake_cap_diamonds',
                                                'bb:'||v_bb::text||'/'||v_dealt_key);
    v_min_pot  := public.fn_ca_diamond_economic('cash_rake_min_pot_diamonds','all');
    v_preflop  := public.fn_ca_diamond_economic('cash_rake_preflop_raked','all');
    v_rounding := public.fn_ca_diamond_economic_text('cash_rake_rounding','all');
    -- Only "down" is implemented. A row that says something else is an answer
    -- this door cannot honour, and honouring it approximately would be worse
    -- than refusing: the refusal names the value it cannot apply.
    IF v_rounding <> 'down' THEN
      RAISE EXCEPTION 'diamond_cash_rake_rounding_unsupported:%', v_rounding USING ERRCODE='22023';
    END IF;

    v_expected := CASE
      WHEN v_dealt < 2 THEN 0
      WHEN NOT v_saw_flop AND v_preflop = 0 THEN 0
      WHEN v_pot < v_min_pot THEN 0
      ELSE least(trunc(v_pot::numeric * v_pct / 100), v_cap)::bigint END;

    IF v_rake <> v_expected THEN
      RAISE EXCEPTION 'diamond_cash_rake_disagrees (engine %, settings % at pot %, % dealt, flop %)',
        v_rake, v_expected, v_pot, v_dealt, v_saw_flop USING ERRCODE='23514';
    END IF;
    IF v_rake > v_pot THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
  ELSIF v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'user_id',(x->>'user_id')::uuid, 'seat_id',(x->>'seat_id')::uuid,
    'seat_joined_at',(x->>'seat_joined_at')::timestamptz,
    'stack_before',(x->>'stack_before')::bigint, 'stack',(x->>'stack')::bigint)
    ORDER BY (x->>'user_id')::uuid) INTO v_stacks
    FROM jsonb_array_elements(p_stacks) x;
  -- The facts are part of the request, so a replay that claims a different pot,
  -- a different flop or a different roster is a payload mismatch rather than a
  -- second settlement. They are kept apart from the stacks so the stack shape
  -- the rest of this door reads is exactly what it was.
  IF v_rake_on THEN
    SELECT jsonb_build_object('pot',v_pot,'dealt',v_dealt,'saw_flop',v_saw_flop,
             'contributions', jsonb_agg(jsonb_build_object(
               'user_id',(x->>'user_id')::uuid,
               'contributed',(x->>'contributed')::bigint,
               'dealt_in',(x->>'dealt_in')::boolean)
               ORDER BY (x->>'user_id')::uuid))
      INTO v_facts FROM jsonb_array_elements(p_stacks) x;
  END IF;
  v_request := jsonb_build_object('stacks',v_stacks,'ref',p_ref,
    'rake',p_rake,'bbj',p_bbj,'inflow',p_inflow)
    || CASE WHEN v_facts IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('rake_facts',v_facts) END;

  -- A REPLAY MOVES NOTHING TWICE. The receipt is read before any write, so a
  -- redelivered hand returns the first receipt and touches no balance, no lot,
  -- no seat and no accrual row.
  SELECT * INTO v_prior FROM public.poker_diamond_hand_receipts
    WHERE table_id=p_table_id AND hand_number=p_hand_number;
  IF FOUND THEN
    IF v_prior.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'diamond_hand_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replay',true);
  END IF;

  -- Match the wallet/refund lock order before touching purchase lots.
  PERFORM p.id FROM public.profiles p
    JOIN jsonb_array_elements(v_stacks) x ON (x->>'user_id')::uuid=p.id
    ORDER BY p.id FOR UPDATE OF p;
  -- Validate the entire roster while locks are held before changing one balance.
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO v_seat FROM public.table_seats
      WHERE id=(v_e->>'seat_id')::uuid AND table_id=p_table_id
        AND user_id=(v_e->>'user_id')::uuid
        AND joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND left_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_seat.stack IS DISTINCT FROM (v_e->>'stack_before')::numeric THEN
      RAISE EXCEPTION 'diamond_hand_stale_seat' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody
      WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
        AND seat_joined_at=v_seat.joined_at AND user_id=v_seat.user_id
        AND target_id=p_table_id AND arena_id=v_arena
        AND purpose='cash_seat' AND state='active' FOR UPDATE;
    IF NOT FOUND OR v_c.balance IS DISTINCT FROM (v_e->>'stack_before')::bigint THEN
      RAISE EXCEPTION 'diamond_hand_custody_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;

  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO STRICT v_c FROM public.poker_diamond_custody
      WHERE seat_id=(v_e->>'seat_id')::uuid
        AND seat_joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND user_id=(v_e->>'user_id')::uuid AND target_id=p_table_id AND state='active';
    v_before := (v_e->>'stack_before')::bigint;
    v_after := (v_e->>'stack')::bigint;
    v_loss := greatest(v_before-v_after,0);
    -- THE RAKE NEEDS NO CHANGE HERE (design section 5, step 4): the settler
    -- already consumes purchased lots for every loss, and every rake Diamond is
    -- part of some player's loss.
    FOR v_lot IN
      SELECT l.id,r.amount-r.consumed AS held,
        greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
      WHERE r.custody_id=v_c.id AND r.released_at IS NULL
      ORDER BY l.created_at,l.id FOR UPDATE OF l,r
    LOOP
      EXIT WHEN v_loss=0;
      v_take := least(v_loss,v_lot.held);
      IF v_take>0 THEN
        -- A provider reversal may already have retired this liability.
        -- Remove the hold once; consume only liability still outstanding.
        UPDATE public.diamond_purchase_lots
          SET arena_reserved=arena_reserved-v_take,
              consumed=consumed+least(v_take,v_lot.outstanding)::integer
          WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations
          SET consumed=consumed+v_take
          WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss-v_take;
      END IF;
    END LOOP;
    UPDATE public.poker_diamond_custody SET balance=v_after WHERE id=v_c.id;
    UPDATE public.table_seats SET stack=v_after
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM public.table_seats
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL AND stack=v_after) THEN
      RAISE EXCEPTION 'diamond_hand_seat_write_failed' USING ERRCODE='23514';
    END IF;
    v_written := v_written || jsonb_build_object(v_c.user_id::text,v_after);
  END LOOP;

  -- ATTRIBUTION AND ACCRUAL (design section 5, steps 4 and 5)
  --
  -- WEIGHTED_CONTRIBUTED, the method the commit door already requires for chip
  -- rake: each contributor's share of the rake is in proportion to what they put
  -- into the pot. This moves no Diamond - the Diamonds already left the stacks
  -- when the pot was cut. It decides WHOSE spend row records each Diamond of
  -- rake, which is what the register needs at the sweep and what a rakeback
  -- would need if B12 were ever yes.
  --
  -- THE REMAINDER RULE, STATED SO IT CAN BE PINNED. A proportional split of a
  -- whole number of Diamonds almost never divides evenly, so:
  --   1. each contributor takes floor(rake * contributed / pot);
  --   2. the Diamonds left over go one each to the contributors with the largest
  --      remainder (rake * contributed) mod pot, largest first;
  --   3. ties on that remainder are broken by user_id ascending.
  -- It is deterministic, it is total (the shares sum to the rake exactly, which
  -- the assertion below proves on every hand), and it never gives a contributor
  -- more than one extra Diamond.
  --
  -- NO is_horse ANYWHERE. A horse contributes and is attributed like anyone.
  IF v_rake > 0 THEN
    INSERT INTO public.ca_diamond_rake_accrual
      (table_id, hand_number, arena_id, user_id, kind, amount)
    WITH c AS (
      SELECT (x->>'user_id')::uuid AS uid, (x->>'contributed')::bigint AS contributed
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x->>'contributed')::bigint > 0
    ), b AS (
      SELECT uid,
             div(v_rake * contributed, v_pot) AS base,
             (v_rake * contributed) % v_pot AS frac
        FROM c
    ), r AS (
      SELECT v_rake - COALESCE(sum(base),0) AS rem FROM b
    ), o AS (
      SELECT uid, base, row_number() OVER (ORDER BY frac DESC, uid ASC) AS rn FROM b
    )
    SELECT p_table_id, p_hand_number, v_arena, o.uid, 'rake',
           o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END
      FROM o CROSS JOIN r
     WHERE o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END > 0;

    SELECT COALESCE(sum(amount),0) INTO v_attributed
      FROM public.ca_diamond_rake_accrual
     WHERE table_id=p_table_id AND hand_number=p_hand_number AND kind='rake';
    IF v_attributed IS DISTINCT FROM v_rake THEN
      RAISE EXCEPTION 'diamond_cash_rake_attribution_does_not_sum (% of %)', v_attributed, v_rake
        USING ERRCODE='23514';
    END IF;
  END IF;

  v_result := jsonb_build_object('success',true,'asset','diamonds',
    'players',jsonb_array_length(v_stacks),'table_id',p_table_id,
    'hand_id',md5('ca-hand:'||p_table_id||':'||p_hand_number
      ||CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END)::uuid,
    'hand_number',p_hand_number,'net_deltas',-(v_rake + COALESCE(p_bbj,0)),
    'rake',p_rake,'bbj',p_bbj,
    'inflow',p_inflow,'mode','delta','rebased','{}'::jsonb,
    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'rake_accrued',COALESCE(v_attributed,0),
    'request',v_request);
  INSERT INTO public.poker_diamond_hand_receipts(table_id,hand_number,request,receipt)
    VALUES(p_table_id,p_hand_number,v_request,v_result);
  RETURN v_result;
END $function$;

-- THE SETTLER IS NOT REACHABLE FROM A BROWSER, AND THE MIGRATION SAYS SO.
-- Measured on production 2026-10-05: this function's ACL is {postgres=X} and
-- nothing else - not even service_role. It is reached only through
-- fn_ca_settle_hand_stacks_absolute (also owner-only), which the commit door
-- calls. These statements restate that exactly and change nothing in
-- production; they exist because CREATE OR REPLACE preserves grants while a
-- FRESH database hands a new function to PUBLIC, and a money door that is
-- private only by inherited state is private by luck. No service_role grant is
-- added: production does not have one, and widening a settler to match a
-- checker's suggested shape would be the opposite of the point.
REVOKE ALL ON FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric) FROM anon, authenticated;

SELECT public.fn_ca_declare_guard_redefinition(
  'fn_poker_diamond_settle_cash_hand',
  '20261005151712_diamond_cash_rake_economics_and_accrual');

-- ----------------------------------------------------------------------------
-- 5. The sweep: one house write, not one per hand
-- ----------------------------------------------------------------------------
--
-- Design section 5, step 5: "A sweep moves the accrued rake to the destination
-- named by B11 by R2, one payer spend row per payer per sweep and one house
-- mint, or, if B11 is 'retired from supply', the spend rows alone."
--
-- R2 is the whole of the crossing rule: "Player to house: the payer's spend
-- journal row (the register retires it from the player) plus a house mint row.
-- This is exactly what fn_poker_diamond_tournament_settle_fee writes today.
-- Nothing crosses with one row, and nothing crosses through
-- ca_diamond_house_ledger, which the register does not see." This door is
-- written in that door's shape, deliberately, so the two crossings are one
-- pattern and cannot drift apart.
--
-- NO CRON IS INSTALLED. Whoever runs this decides when; the Diamonds are
-- accounted for, attributed and inside the identity for as long as they wait.

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_sweep_cash_rake(p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_destination text;
  v_sweep uuid := gen_random_uuid();
  v_key text;
  v_total bigint := 0;
  v_rows bigint := 0;
  v_payers bigint := 0;
  v_p record;
  v_wallet bigint;
  v_journal uuid;
  v_journals uuid[] := ARRAY[]::uuid[];
  v_burned numeric;
  v_before numeric;
  v_after numeric := NULL;
  v_supply numeric;
  v_diff numeric;
  v_ids bigint[];
BEGIN
  v_destination := public.fn_ca_diamond_economic_text('cash_rake_destination','all');
  v_key := 'poker-cash-rake-sweep:'||v_sweep::text;

  -- Take the unswept rows under lock, oldest first. A second sweep running
  -- beside this one waits here and then finds nothing unswept, so the same
  -- Diamond is never swept twice.
  SELECT COALESCE(array_agg(s.id ORDER BY s.id), ARRAY[]::bigint[]) INTO v_ids FROM (
    SELECT a.id FROM public.ca_diamond_rake_accrual a
     WHERE a.swept_at IS NULL AND a.kind='rake'
     ORDER BY a.id
     FOR UPDATE OF a
  ) s;

  SELECT COALESCE(sum(amount),0), count(*), count(DISTINCT user_id)
    INTO v_total, v_rows, v_payers
    FROM public.ca_diamond_rake_accrual WHERE id = ANY(v_ids);
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok',true,'amount',0,'rows',0,'destination',v_destination,
                              'sweep_id',v_sweep,'nothing_to_sweep',true);
  END IF;

  -- ONE SPEND ROW PER PAYER PER SWEEP. The register follows it and retires the
  -- Diamonds from that player, which is the first half of R2. The wallet is not
  -- touched: these Diamonds never sat in profiles.diamonds, they sat in custody
  -- and then in the accrual, exactly as a tournament fee does.
  FOR v_p IN SELECT user_id, sum(amount) AS amount FROM public.ca_diamond_rake_accrual
              WHERE id = ANY(v_ids) GROUP BY user_id ORDER BY user_id LOOP
    SELECT COALESCE(diamonds,0) INTO v_wallet FROM public.profiles WHERE id=v_p.user_id;
    INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
      reference_id,description,source,issuance_class,counterparty,metadata)
    VALUES (v_p.user_id,'cash_rake','cash_rake',-v_p.amount::integer,v_wallet,
      v_key||':'||v_p.user_id::text,
      'Diamond cash-game rake: attributed to this player''s contributions (from the arena to the house)',
      'poker_arena','spend','house',
      jsonb_build_object('sweep_id',v_sweep,'amount',v_p.amount,'destination',v_destination,
                         'reason',COALESCE(p_reason,'cash rake sweep')))
    RETURNING id INTO v_journal;
    v_journals := v_journals || v_journal;
  END LOOP;

  -- THE REGISTER MUST HAVE RETIRED EXACTLY WHAT WE SWEPT, from the players
  -- themselves. The same assertion fn_poker_diamond_tournament_settle_fee makes
  -- about its fee, for the same reason: a crossing that only half happened is a
  -- supply break, and it is cheaper to refuse the sweep than to find it later.
  SELECT COALESCE(sum(m.amount),0) INTO v_burned FROM public.ca_mint_ledger m
   WHERE m.asset='diamonds' AND m.action='burn' AND m.holder_type='player'
     AND m.diamond_tx_id = ANY(v_journals);
  IF v_burned IS DISTINCT FROM v_total::numeric THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_retired_from_players (% of %)', v_burned, v_total
      USING ERRCODE='P0404';
  END IF;

  IF v_destination = 'diamond_house' THEN
    -- ONE HOUSE WRITE FOR THE WHOLE SWEEP (R4). This is the only place a
    -- Diamond cash rake locks ca_diamond_house row 1.
    INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    SELECT COALESCE(balance,0) INTO v_before FROM public.ca_diamond_house WHERE id=1 FOR UPDATE;
    UPDATE public.ca_diamond_house SET balance=COALESCE(balance,0)+v_total, updated_at=now()
      WHERE id=1 RETURNING balance INTO v_after;
    SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
      FROM public.ca_mint_ledger WHERE asset='diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason)
    VALUES
      (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_total, v_before, v_after,
       v_supply+v_total,
       'Diamond cash-game rake banked to the house from the players'' contributions ('
       ||v_rows::text||' hand legs, '||v_payers::text||' payers), B11');
  ELSIF v_destination <> 'retired_from_supply' THEN
    RAISE EXCEPTION 'diamond_cash_rake_destination_has_no_storage:%', v_destination
      USING ERRCODE='22023';
  END IF;

  UPDATE public.ca_diamond_rake_accrual a
     SET swept_at=now(), sweep_id=v_sweep
   WHERE a.id = ANY(v_ids);

  -- THE IDENTITY IS WHOLE AFTERWARDS. Players unchanged, the arena float down by
  -- the swept amount, the house up by it, and the register's two legs cancel.
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole after the cash rake sweep (difference %)', v_diff
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object('ok',true,'amount',v_total,'rows',v_rows,'payers',v_payers,
                            'destination',v_destination,'sweep_id',v_sweep,
                            'house_balance_after',v_after);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Never a chip table (design section 5, step 6; section 4, step 0)
-- ----------------------------------------------------------------------------
--
-- "Diamond rake never writes rake_records, rake_attributions,
-- rake_distribution_legs or club_wallets; the step 0 fence makes that a
-- refusal." This is that fence, for exactly those four tables, in the
-- poker_arena_no_hierarchy pattern.
--
-- It matters beyond tidiness. rake_records alone carries eighteen triggers,
-- among them trg_award_vip_points_from_rake and the club rake daily rollups, and
-- the rakeback settler watermarks over it; a Diamond rake landing there would be
-- pulled into union settlement, invoices, rakeback and VIP points, none of which
-- the Diamond Arena has. So B13 is "no" by construction, not by convention.
--
-- NARROW ON PURPOSE. Step 0 of the design fences nine tables. The other five
-- (bbj_pools, bbj_contributions, chip_ledger, tournament_guarantee_overlays,
-- tournament_tickets, accounting_payable_earning_sources) belong to the lanes
-- that need them, and adding them later is additive - a trigger per table, the
-- same function. Measured 2026-10-05: all four tables below hold zero Diamond
-- Arena rows, so nothing existing is invalidated by the refusal.

CREATE OR REPLACE FUNCTION public.fn_ca_reject_diamond_chip_rake_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=NEW.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Rake Is Never A Chip Rake Record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rake_records','rake_attributions','rake_distribution_legs','club_wallets']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS poker_arena_no_chip_rake ON public.%I', t);
    EXECUTE format('CREATE TRIGGER poker_arena_no_chip_rake '
                   'BEFORE INSERT OR UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reject_diamond_chip_rake_row()', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 7. Every edit landed, nothing opened, the identity whole
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_n bigint;
  v_diff numeric;
  v_cash boolean;
  v_tourn boolean;
BEGIN
  -- The settings table, its guard, its closed list and its refusing reader.
  IF to_regclass('public.ca_diamond_economics') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_economics did not land';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.ca_diamond_economics'::regclass
                    AND tgname='zz_ca_diamond_economics_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the economics append-only guard did not land';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_economic(text,text)') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_economic_text(text,text)') IS NULL THEN
    RAISE EXCEPTION 'the economics reader did not land';
  END IF;

  -- The reader refuses an unset name by name, under P0D01, and does not return NULL.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('cash_rake_percent','dealt:99');
    RAISE EXCEPTION 'the economics reader returned a value for a scope nobody set';
  EXCEPTION
    WHEN SQLSTATE 'P0D01' THEN NULL;
  END;

  -- The append-only rule is a refusal, not a convention.
  BEGIN
    UPDATE public.ca_diamond_economics SET value=value WHERE name='cash_rake_percent';
    RAISE EXCEPTION 'ca_diamond_economics admitted an UPDATE';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN NULL;
  END;

  -- A name off the closed list cannot be recorded.
  BEGIN
    INSERT INTO public.ca_diamond_economics
      (name,scope,value,units,approved_quote,basis,approved_on,recorded_by)
    VALUES ('cash_rake_percent_for_fun','all',1,'percent','x','x','2026-10-05','x');
    RAISE EXCEPTION 'ca_diamond_economics admitted a name off its closed list';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN NULL;
  END;

  -- The answers are all here: 9 scalar rows and 17 stakes x 3 brackets of cap.
  SELECT count(*) INTO v_n FROM public.ca_diamond_economics WHERE name='cash_rake_cap_diamonds';
  IF v_n <> 51 THEN
    RAISE EXCEPTION 'the Diamond cap ladder is % rows, not the 51 the seventeen stakes need', v_n;
  END IF;
  SELECT count(DISTINCT scope) INTO v_n FROM public.ca_diamond_economics WHERE name='cash_rake_percent';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'the Diamond rake percentage is set for % dealt-in brackets, not 3', v_n;
  END IF;
  -- Every live Diamond cash table has a published cap at every bracket, so no
  -- hand can reach the settler and be refused for a stake nobody priced.
  SELECT count(*) INTO v_n
    FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
    CROSS JOIN (VALUES ('dealt:2'),('dealt:3'),('dealt:4plus')) AS b(k)
   WHERE c.asset='diamonds' AND t.tournament_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.ca_diamond_economics e
        WHERE e.name='cash_rake_cap_diamonds'
          AND e.scope='bb:'||trunc(t.big_blind)::bigint::text||'/'||b.k);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% live Diamond cash stake/bracket pairs have no published cap', v_n;
  END IF;

  -- The accrual, its guard, and the float that counts it.
  IF to_regclass('public.ca_diamond_rake_accrual') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_rake_accrual did not land';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.ca_diamond_rake_accrual'::regclass
                    AND tgname='zz_ca_diamond_rake_accrual_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the accrual append-only guard did not land';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_arena_diamonds')
     NOT LIKE '%ca_diamond_rake_accrual%' THEN
    RAISE EXCEPTION 'fn_ca_arena_diamonds does not count the rake accrual (design R5)';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_sweep_cash_rake(text)') IS NULL THEN
    RAISE EXCEPTION 'the cash rake sweep did not land';
  END IF;

  -- The settler took the rake arm, and still refuses a jackpot drop, insurance
  -- and a chip obligation.
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_poker_diamond_settle_cash_hand')
     NOT LIKE '%diamond_cash_rake_disagrees%' THEN
    RAISE EXCEPTION 'the Diamond settler does not recompute the rake';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_poker_diamond_settle_cash_hand')
     NOT LIKE '%COALESCE(p_bbj,0) <> 0 OR COALESCE(p_inflow,0) <> 0%' THEN
    RAISE EXCEPTION 'the Diamond settler no longer holds the jackpot and insurance amounts at zero';
  END IF;

  -- The four chip rake tables refuse a Diamond Arena row by name.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname='poker_arena_no_chip_rake' AND NOT tgisinternal
     AND tgrelid IN ('public.rake_records'::regclass,'public.rake_attributions'::regclass,
                     'public.rake_distribution_legs'::regclass,'public.club_wallets'::regclass);
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'the chip rake fence landed on % of its 4 tables', v_n;
  END IF;

  -- The Diamond tables keep their deductions at an explicit zero for ever, so
  -- boundary layers 1 and 2 never let a chip schedule reach a Diamond table.
  SELECT count(*) INTO v_n FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
   WHERE c.asset='diamonds' AND t.tournament_id IS NULL
     AND (COALESCE(t.rake_percent,-1) <> 0 OR COALESCE(t.rake_cap_bb,-1) <> 0
          OR COALESCE(t.bbj_percent,-1) <> 0 OR t.insurance_enabled IS TRUE);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% Diamond cash tables no longer hold their deductions at an explicit zero', v_n;
  END IF;

  -- No money door of this migration is reachable by a browser.
  SELECT count(*) INTO v_n FROM information_schema.role_routine_grants
   WHERE specific_schema='public' AND grantee IN ('anon','authenticated')
     AND routine_name IN ('fn_ca_diamond_economic','fn_ca_diamond_economic_text',
                          'fn_ca_diamond_sweep_cash_rake','fn_poker_diamond_settle_cash_hand');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% anon/authenticated grants on a Diamond money door', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee IN ('anon','authenticated')
     AND table_name IN ('ca_diamond_economics','ca_diamond_rake_accrual');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% anon/authenticated grants on a Diamond money table', v_n;
  END IF;

  -- THIS MIGRATION MUST NOT OPEN EITHER ARENA DOOR. It reads both and refuses to
  -- commit if it changed one; cash_games_enabled in particular is the owner's to
  -- open, after this path is live and verified.
  SELECT s.cash_games_enabled, s.tournaments_enabled INTO v_cash, v_tourn
    FROM public.ca_arena_settings s WHERE s.id = 1;
  IF COALESCE(v_cash,false) IS TRUE THEN
    RAISE EXCEPTION 'cash_games_enabled is open and this migration must never be the thing that opened it';
  END IF;
  RAISE NOTICE 'arena switches left as found: cash_games_enabled=%, tournaments_enabled=%',
    COALESCE(v_cash::text,'(unset)'), COALESCE(v_tourn::text,'(unset)');

  -- Nothing moved: no hand has been raked, so the accrual is empty and the
  -- house is where it was.
  SELECT count(*) INTO v_n FROM public.ca_diamond_rake_accrual;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'this migration wrote % accrual rows and it must write none', v_n;
  END IF;

  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;

  RAISE NOTICE 'PASS: the Diamond cash rake path is installed, priced, fenced and closed';
END $$;


-- ----------------------------------------------------------------------------
-- 8. The rake kind is named, and never lands in "Other" or in the chip bucket
-- ----------------------------------------------------------------------------
--
-- Design section 2.7, on what a destination must avoid: "a new journal kind that
-- falls into 'Other' or into club_chips (a new kind needs its own WHEN line in a
-- redefined fn_diamond_kind_bucket, the law repinned to the new file with its
-- six pinned lines intact)".
--
-- Measured on production, 2026-10-05:
--   fn_diamond_kind_bucket('cash_rake','cash_rake','poker_arena',-10)
--     -> kind cash_rake, bucket other_spent, label "Other"
-- which is exactly the defect the design names. It gets its own bucket and its
-- own Title Case label, "Diamond Arena Rake" - not the Seats bucket, because a
-- rake is not a seat, and not club_chips, because it is not a chip.
--
-- The map below is the text of 20260920141807 with those two lines added and
-- nothing else changed, so the five existing arena and chip pins still read
-- exactly as the law wrote them. tests/the-diamond-arena-is-diamonds-only.law.test.ts
-- is repinned to this file in the same commit.

CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(
    p_type             text,
    p_transaction_type text,
    p_source           text,
    p_amount           bigint
)
RETURNS TABLE (kind text, bucket text, label text)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    WITH resolved AS (
        SELECT LOWER(COALESCE(
            NULLIF(BTRIM(p_transaction_type), ''),
            CASE WHEN LOWER(COALESCE(p_type, '')) IN ('spend', 'earn', 'credit', 'debit')
                 THEN NULLIF(BTRIM(p_source), '') END,
            NULLIF(BTRIM(p_type), ''),
            ''
        )) AS k
    ),
    bucketed AS (
        SELECT k, CASE
            -- ── SPENT (amount < 0): exact kinds first ──────────────────────
            WHEN p_amount < 0 AND k IN ('arena_deposit', 'tournament_fee')                 THEN 'arena'
            WHEN p_amount < 0 AND k = 'cash_rake'                                          THEN 'arena_rake'
            WHEN p_amount < 0 AND k IN ('diamond_gift_sent', 'live_gift_sent')             THEN 'gifts_sent'
            WHEN p_amount < 0 AND k = 'transfer'                                           THEN 'transfers'
            WHEN p_amount < 0 AND k IN ('chip_purchase', 'chip_mint')                      THEN 'club_chips'
            WHEN p_amount < 0 AND k IN ('plinko_drop', 'crash_bet', 'wheel_spin', 'pvp_stake',
                                        'game_cost', 'arcade_entry', 'memory_game', 'trivia_entry',
                                        'trivia_arcade', 'trivia_lifeline', 'training_entry',
                                        'tournament_entry', 'daily_challenge_reroll',
                                        'diamond_game', 'daily_bonus_spin')                THEN 'games'
            WHEN p_amount < 0 AND k IN ('feature_purchase', 'feature_unlock', 'video_unlock',
                                        'streak_freeze', 'throwable_purchase', 'cosmetic_purchase',
                                        'card_slide_purchase', 'deduction')                THEN 'store'
            WHEN p_amount < 0 AND k IN ('refund', 'stripe_refund', 'chargeback', 'debt_settlement') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND k IN ('adjustment', 'reconciliation', 'burn', 'admin', 'admin_grant',
                                        'seeded', 'bridge', 'house')                       THEN 'adjustments'
            -- ── SPENT: patterns second ─────────────────────────────────────
            WHEN p_amount < 0 AND k LIKE '%vip%'                                           THEN 'vip'
            WHEN p_amount < 0 AND k LIKE '%arena%'                                         THEN 'arena'
            WHEN p_amount < 0 AND k LIKE '%gift%'                                          THEN 'gifts_sent'
            WHEN p_amount < 0 AND k LIKE '%chip%'                                          THEN 'club_chips'
            WHEN p_amount < 0 AND (k LIKE '%refund%' OR k LIKE '%chargeback%' OR k LIKE '%debt%') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND (k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%burn%'
                                   OR k LIKE '%admin%')                                    THEN 'adjustments'
            WHEN p_amount < 0 AND (k LIKE '%purchase%' OR k LIKE '%unlock%' OR k LIKE '%feature%'
                                   OR k LIKE '%throwable%' OR k LIKE '%cosmetic%' OR k LIKE '%avatar%'
                                   OR k LIKE '%theme%' OR k LIKE '%video%' OR k LIKE '%freeze%'
                                   OR k LIKE '%slide%')                                    THEN 'store'
            WHEN p_amount < 0 AND (k LIKE '%bet%' OR k LIKE '%spin%' OR k LIKE '%stake%'
                                   OR k LIKE '%game%' OR k LIKE '%arcade%' OR k LIKE '%trivia%'
                                   OR k LIKE '%training%' OR k LIKE '%entry%' OR k LIKE '%reroll%') THEN 'games'
            WHEN p_amount < 0                                                              THEN 'other_spent'
            -- ── EARNED (amount > 0): exact kinds first ─────────────────────
            WHEN k IN ('arena_withdraw', 'arena')                                          THEN 'arena_cash_outs'
            WHEN k IN ('diamond_gift_received', 'live_gift_received')                      THEN 'gifts_received'
            WHEN k = 'transfer'                                                            THEN 'transfers'
            WHEN k IN ('union_grant', 'club_grant')                                        THEN 'grants'
            WHEN k IN ('diamond_purchase', 'purchase', 'purchased', 'stripe_purchase',
                       'store_purchase', 'mint', 'purchase_clearing')                      THEN 'purchases'
            WHEN k IN ('daily_login', 'daily_bonus', 'daily_bonus_boost', 'daily_challenge_claim',
                       'daily_mission_milestone', 'daily_trivia_challenge', 'daily_trivia',
                       'streak_reward', 'streak_diamonds', 'challenge', 'achievement',
                       'hand_of_the_day', 'gto_chart_study', 'training_reward',
                       'training_level_complete', 'first_training_session', 'trivia_run',
                       'trivia_reward', 'trivia_daily_bonus',
                       'game_reward', 'reward_diamonds', 'bonus_diamonds', 'prize_diamonds') THEN 'rewards'
            WHEN k IN ('signup_bonus', 'bonus', 'promotional', 'promo', 'promo_code',
                       'promo_purchased', 'easter_egg', 'birthday', 'first_purchase',
                       'referral', 'referral_bonus', 'referral_qualified', 'referral_referee',
                       'referral_vip_conversion', 'welcome_spin')                           THEN 'bonuses'
            WHEN k IN ('tournament_prize', 'pvp_win', 'pvp_prize', 'pvp_match_win', 'crash_win',
                       'plinko_win', 'trivia_pvp_match', 'wheel_prize', 'trivia_prize_wheel',
                       'diamond_game_prize')                                              THEN 'winnings'
            WHEN k IN ('vip_reward', 'vip_stipend', 'vip_daily', 'vip_monthly', 'vip_bonus') THEN 'vip_bonuses'
            WHEN k IN ('social_post', 'follow', 'reaction', 'comment', 'strategy_comment', 'share',
                       'share_content', 'profile_complete', 'profile_pic', 'video_watch',
                       'video_favorite', 'hendonmob_link', 'venue_review', 'email_verified',
                       'phone_verified')                                                   THEN 'social'
            WHEN k IN ('refund', 'pvp_refund', 'pvp_tie_refund', 'diamond_gift_refund', 'diamond_refund',
                       'tournament_cancel_refund', 'tournament_entry_refund')              THEN 'refunds'
            WHEN k IN ('adjustment', 'reconciliation', 'admin', 'admin_grant', 'seeded', 'bridge',
                       'house')                                                            THEN 'adjustments'
            -- ── EARNED: patterns second ────────────────────────────────────
            WHEN k LIKE '%refund%'                                                         THEN 'refunds'
            WHEN k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%admin%'              THEN 'adjustments'
            WHEN k LIKE '%arena%'                                                          THEN 'arena_cash_outs'
            WHEN k LIKE '%gift%'                                                           THEN 'gifts_received'
            WHEN k LIKE '%grant%'                                                          THEN 'grants'
            WHEN k LIKE '%vip%'                                                            THEN 'vip_bonuses'
            WHEN k LIKE '%purchase%'                                                       THEN 'purchases'
            WHEN k LIKE '%prize%' OR k LIKE '%win%'                                        THEN 'winnings'
            WHEN k LIKE '%promo%' OR k LIKE '%referral%' OR k LIKE '%bonus%'               THEN 'bonuses'
            WHEN k LIKE '%daily%' OR k LIKE '%reward%' OR k LIKE '%challenge%'
                 OR k LIKE '%mission%' OR k LIKE '%streak%' OR k LIKE '%training%'
                 OR k LIKE '%trivia%'                                                      THEN 'rewards'
            WHEN k LIKE '%social%' OR k LIKE '%profile%' OR k LIKE '%video%'
                 OR k LIKE '%verified%' OR k LIKE '%share%' OR k LIKE '%comment%'          THEN 'social'
            ELSE 'other_earned'
        END AS bucket
        FROM resolved
    )
    SELECT k AS kind, bucket, CASE bucket
            WHEN 'arena'            THEN 'Diamond Arena Seats'
            WHEN 'arena_rake'       THEN 'Diamond Arena Rake'
            WHEN 'gifts_sent'       THEN 'Gifts To Friends'
            WHEN 'transfers'        THEN 'Transfers'
            WHEN 'vip'              THEN 'VIP Membership'
            WHEN 'club_chips'       THEN 'Club Chip Purchases'
            WHEN 'games'            THEN 'Games And Arcade'
            WHEN 'store'            THEN 'Store Items And Perks'
            WHEN 'purchase_refunds' THEN 'Refunded Purchases'
            WHEN 'adjustments'      THEN 'Adjustments'
            WHEN 'other_spent'      THEN 'Other'
            WHEN 'arena_cash_outs'  THEN 'Diamond Arena Cash-Outs'
            WHEN 'gifts_received'   THEN 'Gifts From Friends'
            WHEN 'grants'           THEN 'Union And Club Grants'
            WHEN 'purchases'        THEN 'Diamonds You Bought'
            WHEN 'rewards'          THEN 'Daily Rewards And Challenges'
            WHEN 'bonuses'          THEN 'Bonuses And Promotions'
            WHEN 'winnings'         THEN 'Prizes And Winnings'
            WHEN 'vip_bonuses'      THEN 'VIP Bonuses'
            WHEN 'social'           THEN 'Social And Community'
            WHEN 'refunds'          THEN 'Refunds'
            ELSE 'Other'
        END AS label
    FROM bucketed;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) IS
  'Resolves a diamond_transactions row (type, transaction_type, source, amount) to its kind, a spend/earn bucket and a player-facing label. Every kind a writer can produce is named exactly (2026-09-14 inventory of 24 writers, the reward catalog and the Mint register; 2026-09-20 the Diamond Games: diamond_game, daily_bonus_spin, the transfer kind their payouts and host intakes carry, and the bare deduction kind the Diamond Spins perks - throwables, time bank, rabbit hunt - are charged under); patterns second, Other last, so no row vanishes. ONE place, so both wallets bucket identically. DIAMONDS ONLY: club_chips is a chip purchase in a member club; the Diamond Arena has no chips.';

-- Production's ACL for the kind map, 2026-10-05: {postgres=X, authenticated=X,
-- service_role=X}. A signed-in player reads their own wallet flow through it,
-- an anonymous caller does not, and a fresh database would default it to
-- PUBLIC. Restated, so a replay cannot widen it.
REVOKE ALL ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) TO authenticated, service_role;


DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('cash_rake','cash_rake','poker_arena',-10::bigint);
  IF r.bucket <> 'arena_rake' OR r.label <> 'Diamond Arena Rake' THEN
    RAISE EXCEPTION 'the cash rake kind buckets as %/% rather than arena_rake/Diamond Arena Rake',
      r.bucket, r.label;
  END IF;
  -- The lines the diamonds-only law pins are still exactly as it wrote them.
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('arena_deposit','arena_deposit','poker_arena',-10::bigint);
  IF r.bucket <> 'arena' OR r.label <> 'Diamond Arena Seats' THEN
    RAISE EXCEPTION 'the arena deposit bucket moved';
  END IF;
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('arena_withdraw','arena_withdraw','poker_arena',10::bigint);
  IF r.bucket <> 'arena_cash_outs' OR r.label <> 'Diamond Arena Cash-Outs' THEN
    RAISE EXCEPTION 'the arena cash-out bucket moved';
  END IF;
  RAISE NOTICE 'PASS: the Diamond cash rake has its own named bucket and the arena pins are intact';
END $$;

COMMIT;
