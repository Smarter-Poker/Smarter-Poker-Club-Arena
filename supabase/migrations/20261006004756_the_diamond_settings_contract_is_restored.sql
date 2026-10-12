-- ============================================================================
-- THE DIAMOND SETTINGS CONTRACT IS RESTORED
-- ============================================================================
--
-- 20261005151712_diamond_cash_rake_economics_and_accrual RAN IN PRODUCTION on
-- 2026-10-05 between 21:55 and 22:40 UTC - the file whose own first line reads
-- "SUPERSEDED BY 20261005183028" and whose header says "THIS FILE MUST NEVER
-- RUN". It is recorded in supabase_migrations.schema_migrations as
-- version 20261005151712. BY WHAT ROUTE IS NOT KNOWN: it did not come through
-- apply-merged-migration.yml, and this migration does not guess. The applier is
-- taught to refuse a superseded file in the same pull request as this file
-- (scripts/ci/apply-recorded-migration.mjs), so whatever the route was, the
-- sanctioned one can no longer be it.
--
-- Two lanes answered one design and each built public.ca_diamond_economics.
-- The A-lane's 20261005151918_diamond_economics_records_the_owner_answers is
-- the version the estate reads and the contract that stands. Because 151712
-- carries the LOWER version but RAN LAST, it overwrote the A-lane's table
-- contract and, with it, the narrow extension 20261005152000 had made to that
-- contract. This migration puts the contract back and takes 151712's
-- replacement vocabulary out of the way of it.
--
-- MEASURED IN PRODUCTION 2026-10-06 00:42 to 00:55 UTC, every read inside
-- BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY:
--
--   fn_ca_diamond_economic(p_name text, p_scope text)        pronargdefaults 0
--   fn_ca_diamond_economic_text(p_name text, p_scope text)   pronargdefaults 0
--   fn_ca_diamond_economic_on(p_name text, p_scope text DEFAULT 'all')   intact
--   ca_diamond_economics CHECK constraints present                            9
--   ca_diamond_economics rows                                               141
--   triggers: trg_..._append_only, trg_..._no_truncate, zz_..._guard
--   ca_arena_settings: tournaments_enabled true, cash_games_enabled false
--
-- THE LIVE DAMAGE THIS REPAIRS. A DEFAULT cannot be added by CREATE OR REPLACE
-- (that is the 42P13 151712 refused itself with in CI), so losing it needs a
-- DROP and a CREATE to put back. Six live functions call a ONE-ARGUMENT form
-- of a reader. PL/pgSQL resolves a call at execution time, so all six compiled
-- clean and every one of them raises 42883 the moment it runs:
--
--   fn_ca_diamond_earmark_guard - the TRIGGER trg_ca_diamond_earmark_guard on
--     ca_diamond_house_earmarks, reading guarantee_max_per_event,
--     guarantee_max_outstanding, promo_entry_expiry_days,
--     promo_entry_per_player_per_day, promo_entry_per_event and
--     promo_entry_monthly_diamonds. Every guarantee earmark and every
--     promotional entry was failing.
--   fn_poker_diamond_jackpot_allocate          (bbj_pool_split)
--   fn_poker_diamond_jackpot_pay               (bbj_min_dealt_in)
--   fn_poker_diamond_jackpot_game_qualifies    (bbj_excluded_games)
--   fn_poker_diamond_jackpot_qualifying_hand   (bbj_qualifying_hand)
--   fn_poker_diamond_jackpot_withdraw          (bbj_withdrawal_destination)
--
-- Diamond Arena tournaments are OPEN (tournaments_enabled true), and
-- guarantees and promotional entries are tournament features, so this was
-- live breakage and not a latent one. Neither arena switch is touched here:
-- tournaments_enabled stays true and cash_games_enabled stays false.
--
-- WHAT 151712 PUT IN THEIR PLACE, and why it goes. It created two functions
-- the A-lane never had - fn_ca_diamond_economic_names() listing NINE names in
-- its own vocabulary (cash_rake_cap_diamonds, cash_rake_min_pot_diamonds,
-- cash_rake_preflop_raked, cash_rakeback_percent, cash_rake_vip_points) and
-- fn_ca_diamond_economic_accounts() naming the house account "diamond_house" -
-- and a trigger zz_ca_diamond_economics_guard enforcing them. That guard is
-- why NO A-lane setting could be recorded any more, and it is what refused the
-- correct successor:
--
--   ERROR 23514: diamond_economics_units_disagree:cash_rake_enabled is switch,
--                not boolean
--
-- The A-lane's contract is its CHECK constraints plus
-- trg_ca_diamond_economics_append_only, so the guard is redundant where it is
-- right and wrong where it differs. It is dropped, with its two functions.
-- trg_ca_diamond_economics_append_only and trg_ca_diamond_economics_no_truncate
-- are NOT touched.
--
-- fn_ca_diamond_economic_names() is REBUILT rather than dropped, because an
-- inventory of the closed name list is worth having and one existed. It now
-- reads out the A-lane's own 55 names and takes each one's unit from
-- fn_ca_diamond_economics_units_of, so it cannot disagree with the units map;
-- tests/the-diamond-settings-contract.guard.test.ts holds it to the same 55
-- names the constraint carries.
--
-- ONE CORRECTION TO THE BRIEF THIS LANE WAS HANDED. It said to restore all
-- seven missing constraints "exactly as the A-lane wrote them". Six are
-- restored exactly. ca_diamond_economics_account_exists is NOT, and must not
-- be: 20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side
-- legitimately replaced it, adding surviving_diamond_jackpot_pool and
-- contributing_players_pro_rata beside the A-lane's two, because a jackpot pool
-- is money owed to players and may never sit in the house. That migration is
-- applied, and its row id 32 (bbj_withdrawal_destination =
-- surviving_diamond_jackpot_pool, recorded 19:22 UTC by the BBJ lane) depends
-- on it. Restoring the A-lane's two-account expression would have regressed a
-- later lane's landed work and refused a row that is correct. The FOUR-account
-- expression 152000 wrote is what is restored.
--
-- ----------------------------------------------------------------------------
-- THE EXISTING ROWS: THE DECISION, AND WHY
-- ----------------------------------------------------------------------------
-- The table is append-only. A settled record is never rewritten and never
-- deleted, and nothing here deletes or edits a row. But ALTER TABLE ... ADD
-- CONSTRAINT validates what is already there, so each of the seven was
-- measured against all 141 rows first. Counts read 2026-10-06 00:48 UTC:
--
--   ca_diamond_economics_value_is_sane            0 rows fail
--   ca_diamond_economics_choice_is_an_option      0 rows fail
--   ca_diamond_economics_account_exists (152000)  1 row fails   - id 1780
--   ca_diamond_economics_one_value                4 rows fail   - ids 1773,
--                                                   1777, 1779, 1782
--   ca_diamond_economics_scope_shape             54 rows fail
--   ca_diamond_economics_name_is_a_question      55 rows fail
--   ca_diamond_economics_units_match_name        57 rows fail
--
-- Every failing row is one of 151712's own, inserted by it at 22:15:07 UTC.
-- No A-lane row and no row from 152000 or 152200 fails any of the seven.
-- (Under the A-lane's narrower two-account expression a SECOND row would fail
-- account_exists - id 32, the BBJ lane's - which is the measurement that found
-- the correction above.)
--
--   name_is_a_question: 55 rows under five names that are not questions on the
--     closed list - cash_rake_cap_diamonds (51 rows), cash_rake_min_pot_diamonds,
--     cash_rake_preflop_raked, cash_rakeback_percent, cash_rake_vip_points.
--   scope_shape: 54 rows whose scope is a compound 151712 invented -
--     51 of the form bb:<n>/dealt:<2|3|4plus> and 3 of the form dealt:<...>.
--   units_match_name: those 55, plus id 1773 (cash_rake_enabled recorded as
--     "switch" where the name's unit is boolean) and id 1779
--     (cash_rake_rounding as "rounding" where it is choice).
--   one_value: ids 1773, 1777, 1782 put a 0/1 number in value under unit
--     "switch", and id 1779 puts a word in value_text under unit "rounding".
--   account_exists: id 1780, cash_rake_destination = "diamond_house", an
--     account name that names no storage; the account is ca_diamond_house.
--
-- THE CHOICE: the two constraints no row offends are added VALIDATED, and the
-- five that 151712's rows offend are added NOT VALID. A NOT VALID CHECK binds
-- every INSERT and UPDATE from the moment it exists; it only declines to
-- re-examine rows already written. So the contract is whole going forward -
-- including for 20261005183028, which is applied straight after this and whose
-- fourteen answers are all on the closed list, in its units, at scope all or
-- bb:<n> - while the history of what was recorded when stays exactly as it was
-- recorded. Not one constraint expression is weakened to make an old row pass,
-- which is the alternative that was available and is the one that would have
-- cost something real: account_exists would have had to admit a wrong account
-- name for ever.
--
-- WHY THOSE ROWS ARE INERT. A door reaches this table only through
-- fn_ca_diamond_economic and fn_ca_diamond_economic_text, and both ask
-- fn_ca_diamond_economics_units_of for the name first. With the A-lane map
-- restored that function returns NULL for all five of 151712's invented names,
-- so every one of those 55 rows answers PDE02 diamond_economics_unknown_name
-- and can never be handed to a door as a value. The three dealt:<...> scoped
-- cash_rake_percent rows carry a real name, but the readers never fall back
-- from one scope to another, and no door asks for a dealt:<...> scope: 183028
-- reads cash_rake_percent at scope all. Two rows are readable and wrong -
-- id 1779 cash_rake_rounding "down" and id 1780 cash_rake_destination
-- "diamond_house" - and both are superseded BY APPEND within minutes: 183028
-- records cash_rake_rounding "down" as a choice and cash_rake_destination
-- "ca_diamond_house" as an account, and the reader takes the latest row for a
-- name and scope. Until 183028 is applied nothing reads either name, because
-- the settler that reads them is what 183028 installs.
--
-- WHAT THIS MIGRATION DOES NOT DO. It moves no Diamond, opens no door, prices
-- nothing, touches neither arena switch, writes no row to
-- ca_diamond_economics, and does not go near supabase_migrations.
-- schema_migrations: 151712's record of having run is left alone, and its file
-- header on main is corrected to say so.
--
-- HOW IT WAS PROVED. One self-aborting DO block through the Supabase MCP
-- (CLAUDE.md 11.5 rule 1: one call, one transaction, the error is the success
-- case), helpers in pg_temp and never in public.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. THE GROUND THIS STANDS ON
-- ---------------------------------------------------------------------------
-- Each of these is a thing that was measured, so if one of them is not true
-- the measurement is stale and nothing should be changed on the strength of it.
DO $pre$
BEGIN
  IF to_regclass('public.ca_diamond_economics') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_economics is absent; there is nothing here to repair';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_economic(text,text)') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_economic_text(text,text)') IS NULL THEN
    RAISE EXCEPTION 'a Diamond economics reader is absent; apply 20261005151918 first';
  END IF;
  -- The append-only pair is the A-lane contract and is never replaced here.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ca_diamond_economics'::regclass
                   AND tgname = 'trg_ca_diamond_economics_append_only')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ca_diamond_economics'::regclass
                   AND tgname = 'trg_ca_diamond_economics_no_truncate') THEN
    RAISE EXCEPTION 'the append-only triggers are not both present; stopping rather than guessing';
  END IF;
  -- 152000 is applied and its four-account expression is the one restored
  -- below, so the row that depends on it must be there.
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_economics
                  WHERE name = 'bbj_withdrawal_destination'
                    AND value_text = 'surviving_diamond_jackpot_pool') THEN
    RAISE EXCEPTION 'the 20261005152000 jackpot-destination row is absent; re-measure before restoring account_exists';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. 151712'S REPLACEMENT GUARD COMES OFF
-- ---------------------------------------------------------------------------
-- This is what refused every A-lane name, and it is the only thing that
-- referenced either of the two functions it came with (measured: no other live
-- function body names them).
DROP TRIGGER IF EXISTS zz_ca_diamond_economics_guard ON public.ca_diamond_economics;
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economics_guard();
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economic_accounts();

-- ---------------------------------------------------------------------------
-- 2. THE UNITS MAP IS THE A-LANE'S AGAIN
-- ---------------------------------------------------------------------------
-- Dropped and recreated rather than replaced: the live body differs in what it
-- returns for cash_rake_enabled ("switch" where the A-lane says "boolean") and
-- a CHECK constraint is about to depend on it, so it is rebuilt from the
-- A-lane's text rather than patched.
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economics_units_of(text);
CREATE FUNCTION public.fn_ca_diamond_economics_units_of(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_name
    -- Line (a)
    WHEN 'guarantee_overlay_account'              THEN 'account'
    WHEN 'guarantee_mint_may_issue'               THEN 'boolean'
    WHEN 'guarantee_mint_monthly_ceiling'         THEN 'diamonds_per_month'
    WHEN 'guarantee_max_per_event'                THEN 'diamonds_per_event'
    WHEN 'guarantee_max_outstanding'              THEN 'diamonds'
    WHEN 'guarantee_covers'                       THEN 'choice'
    WHEN 'guarantee_funding_moment'               THEN 'choice'
    WHEN 'guarantee_cap_refuses_creation'         THEN 'boolean'
    WHEN 'guarantee_authority'                    THEN 'role'
    WHEN 'freeroll_allowed'                       THEN 'boolean'
    WHEN 'freeroll_rebuy_cost'                    THEN 'choice'
    WHEN 'freeroll_addon_cost'                    THEN 'choice'
    WHEN 'promo_entry_allowed'                    THEN 'boolean'
    WHEN 'promo_entry_per_player_per_day'         THEN 'entries_per_player_per_day'
    WHEN 'promo_entry_per_event'                  THEN 'entries_per_event'
    WHEN 'promo_entry_monthly_diamonds'           THEN 'diamonds_per_month'
    WHEN 'promo_entry_refund_destination'         THEN 'choice'
    WHEN 'promo_entry_expiry_days'                THEN 'days'
    WHEN 'horse_entry_funding'                    THEN 'choice'
    WHEN 'horse_overlay_autofill'                 THEN 'boolean'
    WHEN 'horse_freeroll_autofill'                THEN 'boolean'
    -- Line (b)
    WHEN 'tournament_fee_percent'                 THEN 'percent'
    WHEN 'tournament_fee_percent_heads_up'        THEN 'percent'
    WHEN 'tournament_rebuy_fee_percent'           THEN 'percent'
    WHEN 'tournament_reentry_fee_percent'         THEN 'percent'
    WHEN 'tournament_addon_fee_percent'           THEN 'percent'
    WHEN 'tournament_fee_destination'             THEN 'account'
    WHEN 'cash_rake_enabled'                      THEN 'boolean'
    WHEN 'cash_rake_percent'                      THEN 'percent'
    WHEN 'cash_rake_cap'                          THEN 'diamonds_per_hand'
    WHEN 'cash_rake_percent_heads_up'             THEN 'percent'
    WHEN 'cash_rake_cap_heads_up'                 THEN 'diamonds_per_hand'
    WHEN 'cash_rake_percent_three_handed'         THEN 'percent'
    WHEN 'cash_rake_cap_three_handed'             THEN 'diamonds_per_hand'
    WHEN 'cash_rake_no_flop_no_drop'              THEN 'boolean'
    WHEN 'cash_rake_min_pot'                      THEN 'diamonds'
    WHEN 'cash_rake_rounding'                     THEN 'choice'
    WHEN 'cash_rake_destination'                  THEN 'account'
    WHEN 'rakeback_percent'                       THEN 'percent'
    WHEN 'rakeback_period'                        THEN 'period'
    WHEN 'rake_earns_vip_points'                  THEN 'boolean'
    WHEN 'bbj_enabled'                            THEN 'boolean'
    WHEN 'bbj_drop_per_hand'                      THEN 'diamonds_per_hand'
    WHEN 'bbj_qualifying_hand'                    THEN 'hand'
    WHEN 'bbj_excluded_games'                     THEN 'game_list'
    WHEN 'bbj_min_pot'                            THEN 'diamonds'
    WHEN 'bbj_min_dealt_in'                       THEN 'players'
    WHEN 'bbj_pool_split'                         THEN 'shares'
    WHEN 'bbj_hit_shares'                         THEN 'shares'
    WHEN 'bbj_seed'                               THEN 'diamonds'
    WHEN 'bbj_seed_account'                       THEN 'account'
    WHEN 'bbj_pool_ceiling'                       THEN 'diamonds'
    WHEN 'bbj_pool_ceiling_destination'           THEN 'account'
    WHEN 'bbj_withdrawal_destination'             THEN 'account'
    -- Line (c)
    WHEN 'chip_account_may_fund_a_diamond_format' THEN 'boolean'
  END
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_economics_units_of(text) IS
  'The one unit each Diamond economic name may be recorded in. Used by the ca_diamond_economics check constraint so a value can never be stored in the wrong unit. IMMUTABLE because a check constraint requires it: a name''s unit is a fact about the name, not a setting.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economics_units_of(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE READERS CARRY THEIR DEFAULT AGAIN
-- ---------------------------------------------------------------------------
-- DROP then CREATE, because a parameter default cannot be added by CREATE OR
-- REPLACE - PostgreSQL answers 42P13, "cannot remove parameter defaults from
-- existing function", which is exactly the error 151712 refused itself with.
-- Measured before writing this: nothing holds a hard dependency on either
-- reader (no view, no constraint, no column default), and the six callers are
-- PL/pgSQL bodies that resolve the call at execution time.
--
-- All three are rebuilt from the A-lane's own text, verbatim - bodies, STABLE,
-- SET search_path, the PDE01/PDE02 error contract, COMMENT, REVOKE and GRANT.
-- fn_ca_diamond_economic_on keeps its default either way, and is recreated
-- with the other two so the trio is one block from one source.
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economic_on(text,text);
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economic_text(text,text);
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economic(text,text);
CREATE FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text DEFAULT 'all')
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_units text;
  v_value numeric;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'diamond_economics_unset:<null>/%', COALESCE(p_scope,'<null>')
      USING ERRCODE = 'PDE01';
  END IF;
  v_units := public.fn_ca_diamond_economics_units_of(p_name);
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', p_name USING ERRCODE = 'PDE02';
  END IF;
  IF v_units IN ('boolean','account','choice','role','hand','game_list','shares','period') THEN
    RAISE EXCEPTION 'diamond_economics_not_a_number:% (units %, read it with fn_ca_diamond_economic_text)',
      p_name, v_units USING ERRCODE = 'PDE02';
  END IF;
  -- No fallback: the scope asked for is the scope read.
  SELECT e.value INTO v_value
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'all')
      USING ERRCODE = 'PDE01';
  END IF;
  RETURN v_value;
END $$;
COMMENT ON FUNCTION public.fn_ca_diamond_economic(text,text) IS
  'The current number recorded for a Diamond economic name and scope. Raises diamond_economics_unset:<name>/<scope> (PDE01) when there is none. Never returns NULL, never falls back to another scope, to a chip value or to a literal: an unset number is a refusal a client can read, not a zero.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic(text,text) TO service_role;

CREATE FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text DEFAULT 'all')
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_units text;
  v_value text;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'diamond_economics_unset:<null>/%', COALESCE(p_scope,'<null>')
      USING ERRCODE = 'PDE01';
  END IF;
  v_units := public.fn_ca_diamond_economics_units_of(p_name);
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', p_name USING ERRCODE = 'PDE02';
  END IF;
  IF v_units NOT IN ('boolean','account','choice','role','hand','game_list','shares','period') THEN
    RAISE EXCEPTION 'diamond_economics_not_a_word:% (units %, read it with fn_ca_diamond_economic)',
      p_name, v_units USING ERRCODE = 'PDE02';
  END IF;
  SELECT e.value_text INTO v_value
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'all')
      USING ERRCODE = 'PDE01';
  END IF;
  RETURN v_value;
END $$;
COMMENT ON FUNCTION public.fn_ca_diamond_economic_text(text,text) IS
  'The current word recorded for a Diamond economic name and scope - an account, a switch, a choice or a role. Raises diamond_economics_unset:<name>/<scope> (PDE01) when there is none. A switch that is absent is not "off with a default": the door refuses by name.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_text(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_text(text,text) TO service_role;

-- A switch read as a boolean, for the doors that want one. It still refuses
-- by name when unset: there is no "false because nobody said".
CREATE FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text DEFAULT 'all')
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT public.fn_ca_diamond_economic_text(p_name, p_scope) = 'yes'
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_economic_on(text,text) IS
  'A yes/no Diamond economic answer as a boolean. Raises PDE01 when unset - never false by omission (section 3.2: "Never on with a default", and never off with one either).';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_on(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_on(text,text) TO service_role;


-- ---------------------------------------------------------------------------
-- 4. THE NAME INVENTORY TELLS THE TRUTH ABOUT THE CLOSED LIST
-- ---------------------------------------------------------------------------
-- 151712 invented this function and listed its own nine names in it. The
-- A-lane never had one. Rather than drop an inventory that is useful, it is
-- rebuilt over the A-lane's 55 names, and it takes each unit from
-- fn_ca_diamond_economics_units_of rather than restating it, so the two can
-- never drift apart. The return type changes, so it is dropped first.
DROP FUNCTION IF EXISTS public.fn_ca_diamond_economic_names();
CREATE FUNCTION public.fn_ca_diamond_economic_names()
RETURNS TABLE(name text, units text)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT t.n, public.fn_ca_diamond_economics_units_of(t.n)
    FROM (VALUES
    ('guarantee_overlay_account'),
    ('guarantee_mint_may_issue'),
    ('guarantee_mint_monthly_ceiling'),
    ('guarantee_max_per_event'),
    ('guarantee_max_outstanding'),
    ('guarantee_covers'),
    ('guarantee_funding_moment'),
    ('guarantee_cap_refuses_creation'),
    ('guarantee_authority'),
    ('freeroll_allowed'),
    ('freeroll_rebuy_cost'),
    ('freeroll_addon_cost'),
    ('promo_entry_allowed'),
    ('promo_entry_per_player_per_day'),
    ('promo_entry_per_event'),
    ('promo_entry_monthly_diamonds'),
    ('promo_entry_refund_destination'),
    ('promo_entry_expiry_days'),
    ('horse_entry_funding'),
    ('horse_overlay_autofill'),
    ('horse_freeroll_autofill'),
    ('tournament_fee_percent'),
    ('tournament_fee_percent_heads_up'),
    ('tournament_rebuy_fee_percent'),
    ('tournament_reentry_fee_percent'),
    ('tournament_addon_fee_percent'),
    ('tournament_fee_destination'),
    ('cash_rake_enabled'),
    ('cash_rake_percent'),
    ('cash_rake_cap'),
    ('cash_rake_percent_heads_up'),
    ('cash_rake_cap_heads_up'),
    ('cash_rake_percent_three_handed'),
    ('cash_rake_cap_three_handed'),
    ('cash_rake_no_flop_no_drop'),
    ('cash_rake_min_pot'),
    ('cash_rake_rounding'),
    ('cash_rake_destination'),
    ('rakeback_percent'),
    ('rakeback_period'),
    ('rake_earns_vip_points'),
    ('bbj_enabled'),
    ('bbj_drop_per_hand'),
    ('bbj_qualifying_hand'),
    ('bbj_excluded_games'),
    ('bbj_min_pot'),
    ('bbj_min_dealt_in'),
    ('bbj_pool_split'),
    ('bbj_hit_shares'),
    ('bbj_seed'),
    ('bbj_seed_account'),
    ('bbj_pool_ceiling'),
    ('bbj_pool_ceiling_destination'),
    ('bbj_withdrawal_destination'),
    ('chip_account_may_fund_a_diamond_format')
    ) AS t(n)
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_economic_names() IS
  'Every name ca_diamond_economics_name_is_a_question admits, with the one unit fn_ca_diamond_economics_units_of allows it - the 55 questions of section 1 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md, A1 to A20, B1 to B22 and C1. An inventory for a reader, never a second source of truth: the constraint is what refuses a name and the units map is what fixes its unit. tests/the-diamond-settings-contract.guard.test.ts holds this list and that constraint to the same 55 names.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_names() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. THE SEVEN CONSTRAINTS GO BACK ON
-- ---------------------------------------------------------------------------
-- Two are added VALIDATED because no existing row offends them. Five are added
-- NOT VALID because 151712's own rows do, and a settled record is not rewritten
-- to make a constraint pass. A NOT VALID CHECK still binds every INSERT and
-- UPDATE from this moment; it declines only to re-examine the 141 rows already
-- written. The header above names every offending row and says why each is
-- inert.

-- Nothing offends these two, so they are validated.
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_value_is_sane CHECK (
    value IS NULL OR (
      value >= 0
      AND (units = 'percent' OR value = trunc(value))
      AND (units <> 'percent' OR value <= 100)
    )
  );

ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_choice_is_an_option CHECK (
    units <> 'choice' OR CASE name
      WHEN 'guarantee_covers'               THEN value_text IN ('prize_pool_only','prize_pool_and_bounties')
      WHEN 'guarantee_funding_moment'       THEN value_text IN ('set_aside_at_creation','checked_at_creation_paid_at_close')
      WHEN 'freeroll_rebuy_cost'            THEN value_text = 'none_offered'
      WHEN 'freeroll_addon_cost'            THEN value_text = 'none_offered'
      WHEN 'promo_entry_refund_destination' THEN value_text IN ('funding_account','unused_promotional_entry','player_wallet')
      WHEN 'horse_entry_funding'            THEN value_text IN ('own_balance','funding_account')
      WHEN 'cash_rake_rounding'             THEN value_text IN ('down','nearest','up')
      ELSE false
    END
  );

-- 55 rows under five names 151712 invented offend this one.
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_name_is_a_question CHECK (name IN (
    -- Line (a): guarantees, freerolls and promotional entries
    'guarantee_overlay_account',               -- A1
    'guarantee_mint_may_issue',                -- A2
    'guarantee_mint_monthly_ceiling',          -- A3
    'guarantee_max_per_event',                 -- A4
    'guarantee_max_outstanding',               -- A5
    'guarantee_covers',                        -- A6
    'guarantee_funding_moment',                -- A7
    'guarantee_cap_refuses_creation',          -- A8
    'guarantee_authority',                     -- A9
    'freeroll_allowed',                        -- A10
    'freeroll_rebuy_cost',                     -- A11
    'freeroll_addon_cost',                     -- A11
    'promo_entry_allowed',                     -- A12
    'promo_entry_per_player_per_day',          -- A13
    'promo_entry_per_event',                   -- A14
    'promo_entry_monthly_diamonds',            -- A15
    'promo_entry_refund_destination',          -- A16
    'promo_entry_expiry_days',                 -- A17
    'horse_entry_funding',                     -- A18
    'horse_overlay_autofill',                  -- A19
    'horse_freeroll_autofill',                 -- A20
    -- Line (b): tournament fee, cash rake, BBJ. Other lanes seed these.
    'tournament_fee_percent',                  -- B1
    'tournament_fee_percent_heads_up',         -- B1
    'tournament_rebuy_fee_percent',            -- B2
    'tournament_reentry_fee_percent',          -- B2
    'tournament_addon_fee_percent',            -- B2
    'tournament_fee_destination',              -- B3
    'cash_rake_enabled',                       -- B4
    'cash_rake_percent',                       -- B5
    'cash_rake_cap',                           -- B6
    'cash_rake_percent_heads_up',              -- B7
    'cash_rake_cap_heads_up',                  -- B7
    'cash_rake_percent_three_handed',          -- B7
    'cash_rake_cap_three_handed',              -- B7
    'cash_rake_no_flop_no_drop',               -- B8
    'cash_rake_min_pot',                       -- B9
    'cash_rake_rounding',                      -- B10
    'cash_rake_destination',                   -- B11
    'rakeback_percent',                        -- B12
    'rakeback_period',                         -- B12
    'rake_earns_vip_points',                   -- B13
    'bbj_enabled',                             -- B14
    'bbj_drop_per_hand',                       -- B15
    'bbj_qualifying_hand',                     -- B16
    'bbj_excluded_games',                      -- B17
    'bbj_min_pot',                             -- B17
    'bbj_min_dealt_in',                        -- B17
    'bbj_pool_split',                          -- B18
    'bbj_hit_shares',                          -- B19
    'bbj_seed',                                -- B20
    'bbj_seed_account',                        -- B20
    'bbj_pool_ceiling',                        -- B21
    'bbj_pool_ceiling_destination',            -- B21
    'bbj_withdrawal_destination',              -- B22
    -- Line (c)
    'chip_account_may_fund_a_diamond_format'   -- C1
  ))
  NOT VALID;

-- 54 rows carrying 151712's compound scopes offend this one.
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_scope_shape CHECK (
    scope = 'all' OR scope ~ '^bb:[0-9]+$'
  )
  NOT VALID;

-- 4 rows of 151712's put the value in the wrong column for their unit.
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_one_value CHECK (
    (units IN ('diamonds','diamonds_per_month','diamonds_per_event',
               'diamonds_per_rebuy','diamonds_per_addon','diamonds_per_hand',
               'entries_per_player_per_day','entries_per_event',
               'days','percent','players','big_blinds')
       AND value IS NOT NULL AND value_text IS NULL)
    OR
    (units IN ('boolean','account','choice','role','hand','game_list','shares','period')
       AND value_text IS NOT NULL AND btrim(value_text) <> '' AND value IS NULL)
  )
  NOT VALID;

-- 57 rows: the 55 unknown names, plus cash_rake_enabled recorded as "switch"
-- and cash_rake_rounding as "rounding".
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_units_match_name
  CHECK (units = public.fn_ca_diamond_economics_units_of(name))
  NOT VALID;

-- RESTORED AS 20261005152000 WROTE IT, not as the A-lane did. That migration
-- added the two accounts its own storage provides beside the A-lane's two,
-- because a jackpot pool is money owed to players and may never sit in the
-- house (design rule R1, CLAUDE.md 10.9 condition 3). It is applied, and its
-- bbj_withdrawal_destination row depends on the wider list. One row offends
-- even this: id 1780, cash_rake_destination = "diamond_house".
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_account_exists CHECK (
    units <> 'account' OR value_text IN (
      'ca_diamond_house',
      'retired_from_supply',
      -- B22, from 20261005152000: poker_diamond_jackpot_pools holds the
      -- surviving pool, and the contributors of a pool are the payer rows of
      -- its own ledger.
      'surviving_diamond_jackpot_pool',
      'contributing_players_pro_rata'
    )
  )
  NOT VALID;

-- ---------------------------------------------------------------------------
-- 6. EVERY EDIT LANDED
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_n integer;
  v_t text;
BEGIN
  -- The two readers carry a default again, which is the whole point.
  IF (SELECT pronargdefaults FROM pg_proc
        WHERE oid = to_regprocedure('public.fn_ca_diamond_economic(text,text)')) <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_economic did not come back with its p_scope default';
  END IF;
  IF (SELECT pronargdefaults FROM pg_proc
        WHERE oid = to_regprocedure('public.fn_ca_diamond_economic_text(text,text)')) <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_economic_text did not come back with its p_scope default';
  END IF;
  IF (SELECT pronargdefaults FROM pg_proc
        WHERE oid = to_regprocedure('public.fn_ca_diamond_economic_on(text,text)')) <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_economic_on did not come back with its p_scope default';
  END IF;

  -- The one-argument form the six broken callers use now resolves, and answers.
  v_t := public.fn_ca_diamond_economic_text('horse_entry_funding');
  IF v_t <> 'own_balance' THEN
    RAISE EXCEPTION 'the one-argument text reader answered % for horse_entry_funding', v_t;
  END IF;
  IF public.fn_ca_diamond_economic('guarantee_max_per_event') <> 1000000 THEN
    RAISE EXCEPTION 'the one-argument number reader did not read guarantee_max_per_event';
  END IF;
  IF public.fn_ca_diamond_economic_text('guarantee_overlay_account') <> 'ca_diamond_house' THEN
    RAISE EXCEPTION 'guarantee_overlay_account is not the house any more';
  END IF;
  IF public.fn_ca_diamond_economic_text('bbj_withdrawal_destination')
       <> 'surviving_diamond_jackpot_pool' THEN
    RAISE EXCEPTION 'the 152000 jackpot destination no longer reads back';
  END IF;

  -- The units map is the A-lane's, including the name the guard disagreed on.
  IF public.fn_ca_diamond_economics_units_of('cash_rake_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'the units map still calls cash_rake_enabled a switch';
  END IF;
  IF public.fn_ca_diamond_economics_units_of('cash_rake_cap_diamonds') IS NOT NULL THEN
    RAISE EXCEPTION 'cash_rake_cap_diamonds is still a name the units map knows';
  END IF;

  -- The inventory carries all 55, and agrees with the units map on every one.
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_economic_names();
  IF v_n <> 55 THEN
    RAISE EXCEPTION 'fn_ca_diamond_economic_names lists % names, not 55', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_economic_names() n WHERE n.units IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% name(s) in the inventory have no unit', v_n;
  END IF;

  -- The seven are on, and so are the nine that survived.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.ca_diamond_economics'::regclass
     AND conname IN ('ca_diamond_economics_name_is_a_question',
                     'ca_diamond_economics_units_match_name',
                     'ca_diamond_economics_one_value',
                     'ca_diamond_economics_value_is_sane',
                     'ca_diamond_economics_scope_shape',
                     'ca_diamond_economics_account_exists',
                     'ca_diamond_economics_choice_is_an_option');
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'only % of the seven constraints are present', v_n;
  END IF;

  -- 151712's guard is gone and the A-lane's append-only pair is not.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ca_diamond_economics'::regclass
               AND tgname = 'zz_ca_diamond_economics_guard') THEN
    RAISE EXCEPTION 'zz_ca_diamond_economics_guard is still on the table';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_economics_guard()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_diamond_economic_accounts()') IS NOT NULL THEN
    RAISE EXCEPTION 'a 151712 guard function is still installed';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.ca_diamond_economics'::regclass
     AND tgname IN ('trg_ca_diamond_economics_append_only',
                    'trg_ca_diamond_economics_no_truncate');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the append-only triggers did not survive this migration';
  END IF;

  -- No row was written, edited or removed by this file.
  SELECT count(*) INTO v_n FROM public.ca_diamond_economics;
  IF v_n <> 141 THEN
    RAISE EXCEPTION 'the row count is % and was 141; this migration writes no rows', v_n;
  END IF;

  -- The A-lane name list and the restored constraint agree. Read the
  -- constraint's own expression rather than a copy of it.
  SELECT count(*) INTO v_n
    FROM public.fn_ca_diamond_economic_names() n
   WHERE strpos(
           (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
             WHERE c.conrelid = 'public.ca_diamond_economics'::regclass
               AND c.conname = 'ca_diamond_economics_name_is_a_question'),
           quote_literal(n.name)) = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% inventory name(s) are not on the restored closed list', v_n;
  END IF;

  -- Neither arena switch was touched.
  IF (SELECT cash_games_enabled FROM public.ca_arena_settings LIMIT 1) IS DISTINCT FROM false
     OR (SELECT tournaments_enabled FROM public.ca_arena_settings LIMIT 1) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'an arena switch moved; this migration touches neither';
  END IF;
END $post$;

COMMIT;
