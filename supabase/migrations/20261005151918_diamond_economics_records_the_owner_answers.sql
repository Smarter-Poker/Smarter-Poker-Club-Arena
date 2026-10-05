-- ============================================================================
-- DIAMOND ECONOMICS RECORDS THE OWNER ANSWERS
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, line (a) "Fund guarantees and
-- promotional entries from authorized diamond house/budgets": the settings
-- table and its refusing reader of
-- docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 3.2, plus the twenty
-- answers to that document's questions A1 to A20.
--
-- WHY THE ANSWERS ARE IN THIS MIGRATION AND NOT IN A QUESTION. The design
-- lists A1 to A20 under the heading "The Decisions Dan Must Make" and says of
-- itself "It proposes no value". Dan answered that framing on 2026-10-05,
-- verbatim: "NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO." He was
-- replying to a list handed back to him as owner decisions, A1 to A20 among
-- them. Under CLAUDE.md 10.8 a later explicit owner instruction governs over
-- a document's framing, and under 10.9 the money decisions are the agent's to
-- take when the path is clear. So the twenty are decided here.
--
-- THE STANDARD EVERY ANSWER MEETS: DERIVE, THEN RECORD. No number below is
-- invented. Each row carries both the owner words that give it authority
-- (approved_quote) and the chain that produced the value (basis), and every
-- chain is one of three kinds:
--
--   1. Read off the chip estate this arena is a diamonds-only clone of
--      (A6 from how fn_ca_fund_overlay_on_lock computes its shortfall).
--   2. Read off a standing Dan ruling (A10 and A18 to A20 from ruling 16 and
--      CLAUDE.md 10.5; A17 from ruling 14's fourteen-day Diamond window).
--   3. Reasoned from the Mint's existing limits and the arena's shape, where
--      derivation does not carry, and SAID SO in the row (A3, A4, A5, A13,
--      A14, A15). The arena has no unions and no agents, the Diamond house
--      holds 0 Diamonds, the reward budget lines hold no Diamonds, and the
--      chip treasury fallback has no Diamond counterpart.
--
-- Every one of the twenty is a ROW, so any of them is changed by recording a
-- new row and never by editing code. That is the point of the table.
--
-- MEASURED IN PRODUCTION 2026-10-05 15:13 UTC, read inside
-- BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY:
--   ca_diamond_economics            does not exist (0 relations by that name)
--   fn_ca_diamond_economic          does not exist (0 procs by that name)
--   any relation named %earmark%    0
--   ca_diamond_house row 1 balance  0
--   ca_arena_settings               tournaments_enabled true, cash_games_enabled false
--   fn_ca_diamond_register_vs_supply().difference  0.00
--   fn_poker_diamond_create_tournament  md5 05e4ae642e1a3949da8bb34bc62f7f3d
--
-- Two claims handed to this work were checked by reading rather than trusted,
-- and both were wrong in the same direction - something was said to be built
-- or gone that is not:
--
--   * "Step 0 already built the settings table and the earmark ledger."
--     It did not. 20260929160000 and 20260929160100 are the section 4 step 0
--     FENCES only. Neither ca_diamond_economics nor any earmark object exists
--     in production or in this repository. This migration is therefore the
--     first of the two spine pieces, not an extension of them.
--   * "The 'diamond horse funding not open' refusal is gone from every
--     function body." The phrase with spaces is absent; the refusal itself is
--     LIVE. fn_register_horse_for_tournament(uuid,uuid,boolean), md5
--     84c0354e68fb129b5373bc6024cba334, still returns
--     jsonb_build_object('ok',false,'reason','diamond_horse_funding_not_open')
--     for every Diamond event, under the comment "DIAMOND PHASE 8:
--     house-funded horse entries are Phase 9". That comment records the very
--     assumption CLAUDE.md 10.5 forbids, and A18 below settles it the other
--     way. This migration records the answer; the door itself is untouched
--     here and named as remaining work in the changelog.
--
-- One defect this round did NOT have to fix, because it is already fixed:
-- section 6 item 3 of the design, the creation door dropping a guarantee
-- silently. The live body now refuses guaranteedPrize, isRebuy, isReentry,
-- addOnAvailable, addOnCost and addOnFromStart by name with
-- 'diamond_tournament_money_key_not_read: %', installed by
-- 20260929160000_the_chip_legs_refuse_a_diamond_row. Read, not assumed.
--
-- WHAT THIS MIGRATION DOES NOT DO. It prices nothing that is not a row in a
-- table Dan owns, it opens no door, it moves no Diamond, it reads no chip
-- account, and it touches neither arena switch: tournaments_enabled stays
-- true and cash_games_enabled stays false, exactly as found. No Diamond door
-- is redefined by it at all - the doors learn to read the reader in the
-- migrations that follow, which is why the fee rows (B1, B2) are deliberately
-- NOT seeded: section 3.2 says the creation door keeps its inherited rule
-- until an answer exists, and seeding one here would silently change a
-- running fee.
--
-- SHARED WITH OTHER LANES. ca_diamond_economics is the one table section 3.2
-- gives the whole of Phase 9, so the Diamond cash rake lane (B4 to B11), the
-- Diamond BBJ lane (B14 to B22) and the budget-lines lane all write to it.
-- The closed name list below therefore already carries every name in section
-- 1 - A1 to A20, B1 to B22 and C1 - so that those lanes add ROWS and never
-- have to alter the list, the check constraint or the units map. Only the A
-- rows are seeded here.
--
-- RULING 21 (Dan, 2026-09-08: "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS
-- LIKE THIS, ONLY A USER BUDGET."). Three of the twenty are caps on a pot
-- (A3, A5, A8) and three more cap a giveaway (A13, A14, A15). Ruling 21 says
-- a platform pot never refuses a PLAYER. Every one of these six falls on an
-- operator action and never on a player:
--
--   * A3 caps a Mint issuance. The actor is an admin or the service role.
--   * A4, A5 and A8 refuse the CREATION of a guaranteed event, before any
--     player has been told a prize exists. The alternative - admit the event
--     and only report - is what ruling 21 actually forbids: a player would
--     register against an advertised guarantee the platform cannot fund and
--     be short-paid at close, which is a platform pot refusing a player after
--     they have paid. Refusing at creation is how ruling 21 is HONOURED here.
--   * A13, A14 and A15 refuse the ISSUE of a promotional entry - a gift
--     nobody has earned - and never its redemption.
--
-- The boundary, recorded as part of the answers and asserted by the law test:
-- once an event exists and its guarantee is earmarked, NO value in this table
-- may refuse any player a registration, a prize, a bounty, a refund or a
-- payout, and no promotional cap may refuse the redemption of an entry already
-- issued. A cap in this table stops a promise being MADE. It never stops one
-- being KEPT.
--
-- CLAUDE.md 10.5 (horses are players). A18, A19 and A20 are not preferences;
-- they are the law applied. A horse pays the same buy-in out of the same
-- wallet through the same door and is treated identically to a human in
-- everything, and Dan rejected outright the argument that a different
-- mechanism reaching an equal outcome is acceptable. So a horse funds its
-- Diamond entry from its own balance (A18), and is seeded into a short
-- guaranteed event (A19) and into a freeroll (A20) exactly as it is for
-- chips under the 2026-08-27 rules. Nothing in this migration reads is_horse.
--
-- HOW IT WAS PROVED. One self-aborting DO block through the Supabase MCP
-- (CLAUDE.md 11.5 rule 1: one call, one transaction, an error is the success
-- case), with every helper in pg_temp and never in public. The rehearsal is
-- recorded in docs/changelog/2026-10-05-diamond-destinations-decisions.md.
--
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE TABLE DAN OWNS
-- ---------------------------------------------------------------------------
-- Append-only by trigger, not by convention. A row is never updated and never
-- deleted; a changed answer is a NEW row, and the current value is the latest
-- row for a name and a scope. That is what makes "any number can be changed
-- by editing a row rather than code" true, and it is what keeps the history of
-- what was approved when.

CREATE TABLE public.ca_diamond_economics (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text        NOT NULL,
  scope          text        NOT NULL DEFAULT 'all',
  value          numeric     NULL,
  value_text     text        NULL,
  units          text        NOT NULL,
  approved_quote text        NOT NULL,
  basis          text        NOT NULL,
  approved_on    date        NOT NULL,
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  -- The closed name list: one name per question in section 1 of the design.
  -- Every lane in Phase 9 writes to this table, so the list carries the B and
  -- C names too and no lane has to alter this constraint to record an answer.
  CONSTRAINT ca_diamond_economics_name_is_a_question CHECK (name IN (
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
  )),

  -- A scope is 'all' or a stake key such as bb:2. Nothing else.
  CONSTRAINT ca_diamond_economics_scope_shape CHECK (
    scope = 'all' OR scope ~ '^bb:[0-9]+$'
  ),

  -- Exactly one of the two value columns carries the answer, and which one is
  -- decided by the units, not by the writer.
  CONSTRAINT ca_diamond_economics_one_value CHECK (
    (units IN ('diamonds','diamonds_per_month','diamonds_per_event',
               'diamonds_per_rebuy','diamonds_per_addon','diamonds_per_hand',
               'entries_per_player_per_day','entries_per_event',
               'days','percent','players','big_blinds')
       AND value IS NOT NULL AND value_text IS NULL)
    OR
    (units IN ('boolean','account','choice','role','hand','game_list','shares','period')
       AND value_text IS NOT NULL AND btrim(value_text) <> '' AND value IS NULL)
  ),

  -- Nothing negative, and nothing fractional where the unit is a whole
  -- Diamond or a count. A Diamond is indivisible; so is a seat and a day.
  CONSTRAINT ca_diamond_economics_value_is_sane CHECK (
    value IS NULL OR (
      value >= 0
      AND (units = 'percent' OR value = trunc(value))
      AND (units <> 'percent' OR value <= 100)
    )
  ),

  -- A boolean answer says yes or no, and never NULL, '' or 'maybe'.
  CONSTRAINT ca_diamond_economics_boolean_shape CHECK (
    units <> 'boolean' OR value_text IN ('yes','no')
  ),

  -- An account-valued answer names an account whose storage exists today.
  -- ca_diamond_house is the only platform-owned Diamond account there is;
  -- 'retired_from_supply' is the Mint's burn, which is storage of a kind.
  CONSTRAINT ca_diamond_economics_account_exists CHECK (
    units <> 'account' OR value_text IN ('ca_diamond_house','retired_from_supply')
  ),

  -- Dan's words are what give a row its authority, so they may not be empty.
  CONSTRAINT ca_diamond_economics_quote_not_empty CHECK (btrim(approved_quote) <> ''),
  -- And the derivation may not be empty either: "derive, then record".
  CONSTRAINT ca_diamond_economics_basis_not_empty CHECK (btrim(basis) <> ''),
  CONSTRAINT ca_diamond_economics_recorder_not_empty CHECK (btrim(recorded_by) <> '')
);

COMMENT ON TABLE public.ca_diamond_economics IS
  'Every number, switch, account and choice the Diamond economy runs on, one append-only row each, with the owner words that authorise it and the derivation that produced it. Section 3.2 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md. The current value of a name is its LATEST row for a scope; a changed answer is a new row, never an edit. Read only through fn_ca_diamond_economic and fn_ca_diamond_economic_text, which refuse by name when a value is unset. Shared by every Phase 9 lane: guarantees and promotional entries (A rows), cash rake and BBJ (B rows), the chip-leg refusals (C rows).';
COMMENT ON COLUMN public.ca_diamond_economics.approved_quote IS
  'The owner words this row rests on, verbatim. Never empty.';
COMMENT ON COLUMN public.ca_diamond_economics.basis IS
  'How the value was derived: from the chip estate this arena clones, from a standing ruling, or - said plainly where it is so - reasoned from the Mint''s limits and the arena''s shape.';
COMMENT ON COLUMN public.ca_diamond_economics.scope IS
  'all, or a stake key such as bb:2. The reader never falls back from a stake to all.';

CREATE UNIQUE INDEX ux_ca_diamond_economics_name_scope_recorded
  ON public.ca_diamond_economics (name, scope, recorded_at DESC, id DESC);
CREATE INDEX ix_ca_diamond_economics_name ON public.ca_diamond_economics (name);

-- ---------------------------------------------------------------------------
-- 2. THE UNITS ARE CHECKED AGAINST THE NAME
-- ---------------------------------------------------------------------------
-- Section 3.2: "units is checked against the name". Without this a monthly
-- ceiling could be recorded in percent, or a count of entries in Diamonds,
-- and the reader would hand a door a number in the wrong unit. The map is one
-- IMMUTABLE function so the check constraint can use it and so a lane adding
-- a B or C row cannot choose its own unit for a name.

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

ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_units_match_name
  CHECK (units = public.fn_ca_diamond_economics_units_of(name));

-- ---------------------------------------------------------------------------
-- 3. APPEND-ONLY, AND NOT REACHABLE FROM A BROWSER
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_diamond_economics_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ca_diamond_economics is append-only: a changed answer is a new row, never an edit'
    USING ERRCODE = '42501';
END $$;
COMMENT ON FUNCTION public.fn_ca_diamond_economics_append_only() IS
  'Refuses every UPDATE, DELETE and TRUNCATE on ca_diamond_economics. The history of what was approved when is part of the answer.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economics_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_ca_diamond_economics_append_only
  BEFORE UPDATE OR DELETE ON public.ca_diamond_economics
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_economics_append_only();
CREATE TRIGGER trg_ca_diamond_economics_no_truncate
  BEFORE TRUNCATE ON public.ca_diamond_economics
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_diamond_economics_append_only();

ALTER TABLE public.ca_diamond_economics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_economics FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ca_diamond_economics_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_economics TO service_role;

-- ---------------------------------------------------------------------------
-- 4. A CONFIGURED-BUT-UNSET VALUE REFUSES BY NAME
-- ---------------------------------------------------------------------------
-- Section 3.2: the reader "never returns NULL and never falls back to another
-- scope, to a chip value or to a literal". Two readers because an answer is
-- either a number or a word, and handing a door the wrong kind is itself a
-- defect: asking for a number and getting an account name back would be read
-- as NULL by a caller that forgot to check. So the number reader refuses a
-- word-valued name by name, and the word reader refuses a number-valued one.
--
-- SQLSTATE PDE01 is "a Diamond economic value is unset" and PDE02 is "the
-- wrong reader for this name". Neither is used by any door in this estate
-- today: the survey of every ERRCODE literal in supabase/migrations on
-- 2026-10-05 found 57 distinct codes and no PDE class among them.

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
-- 5. A CHOICE COMES FROM ITS QUESTION'S OWN CLOSED LIST
-- ---------------------------------------------------------------------------
-- Each "one of the two" or "one of the three" in section 1 has its options
-- written into the question. A choice recorded outside them would be a value
-- no door knows how to act on.
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
-- A priced rebuy or add-on in a freeroll is a number, not a choice, so if a
-- later answer prices one it is recorded under a new name with a numeric unit
-- rather than squeezed into this list. Today both are 'none_offered'.

-- A role answer names a role the doors already enforce, or the owner alone.
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_role_is_real CHECK (
    units <> 'role' OR value_text IN ('platform_admin','owner_only')
  );

-- ---------------------------------------------------------------------------
-- 6. THE TWENTY ANSWERS (A1 TO A20)
-- ---------------------------------------------------------------------------
-- recorded_by is the agent and the session, not a person: nobody signed in to
-- write these, and CLAUDE.md 10.10 says a script never wears a person's face.

INSERT INTO public.ca_diamond_economics
  (name, scope, value, value_text, units, approved_quote, basis, approved_on, recorded_by)
VALUES

-- A1. Which Diamond account pays a guarantee's overlay.
('guarantee_overlay_account', 'all', NULL, 'ca_diamond_house', 'account',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED from rule R1 of the design and from what exists. R1: platform-owned Diamonds live in ca_diamond_house and player-owned Diamonds live in profiles.diamonds or in an arena holding fn_ca_arena_diamonds() counts, and nothing platform-owned may be parked in the arena float. Measured 2026-10-05: ca_diamond_house is the only platform-owned Diamond account there is. The diamond_reward_budgets lines hold no Diamonds and under ruling 21 are forecasts that refuse nobody, so they cannot pay anything. Ruling 16 requires guarantees to stay diamond-funded. Naming any other account would force fn_ca_diamond_trial_balance and fn_ca_diamond_snapshot, which read only ca_diamond_house row 1, to learn a second platform row in the same migration; the house needs no such change. The house holds 0 Diamonds today, which is what A2 and A3 are for.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A2. May the Mint issue into that account for this purpose.
('guarantee_mint_may_issue', 'all', NULL, 'yes', 'boolean',
 'Rake/fees, guarantees, freerolls and any BBJ/spin reserves stay diamond-funded, with current approved budget rules; horses retain player parity and must use diamond-only funding.',
 'DERIVED from ruling 16 (quoted) and from the Mint as it already runs. The route exists: fn_ca_mint can issue to the house and fn_poker_diamond_tournament_settle_fee already writes a house mint row, so no new path is being opened. The house holds 0 Diamonds, so without issuance every guaranteed event would be refused for want of funds forever, which would make A1 a name for an empty account and ruling 16''s "stay diamond-funded" impossible to satisfy. The answer is yes, and it changes nothing about who may operate the Mint: issuance stays limited to the house, admins and the service role, at most 1,000,000 per operation and 2,000,000 per rolling 24 hours, exactly as today.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A3. The monthly ceiling on issuance for this purpose.
('guarantee_mint_monthly_ceiling', 'all', 2000000, NULL, 'diamonds_per_month',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'REASONED FROM THE MINT''S EXISTING LIMITS, and said so plainly because no chip equivalent carries here. The Mint already permits 1,000,000 per operation and 2,000,000 per rolling 24 hours. This ceiling is that rolling-24-hour figure taken as a CALENDAR MONTH allowance for this one purpose: what the Mint already allows in a day, guarantees and promotional entries together may draw in a month. It is therefore strictly tighter than the Mint''s own limits, which remain the outer bound and are unchanged, and it is tighter by roughly thirty times. For scale, the whole Diamond register read 5,357,442 on 2026-09-21, so this is about 37 percent of total supply per month and nothing like a blank cheque. Ruling 21 is respected because the actor this refuses is the Mint operator - an admin or the service role - and never a player: no registration, prize, bounty, refund or payout consults this row.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A4. The largest guarantee one event may advertise.
('guarantee_max_per_event', 'all', 1000000, NULL, 'diamonds_per_event',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'REASONED FROM THE MINT''S PER-OPERATION CEILING, and said so plainly: the chip estate has no per-event guarantee cap at all, only an affordability check against a treasury less a floor, so there is nothing to clone. An event may advertise no more than the funding account can be topped up by in ONE Mint operation, which is 1,000,000. That keeps the chain whole and self-consistent: A4 (1,000,000 per event) is at most A5 (2,000,000 outstanding) is at most A3 (2,000,000 a month), so the platform can never advertise more than it can fund, nor owe more than one month''s issuance covers. Ruling 21 is respected because this refuses the CREATION of an event, before any player has been told a prize exists.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A5. The most overlay outstanding at one time.
('guarantee_max_outstanding', 'all', 2000000, NULL, 'diamonds',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'REASONED FROM A3, and said so plainly. The platform may never owe more overlay, summed over every guaranteed Diamond event not yet settled, than one month of issuance into the funding account can cover - otherwise a month exists in which an advertised guarantee cannot be funded whatever the operator does. So A5 equals A3 at 2,000,000, which is also the Mint''s rolling-24-hour ceiling. Exposure is measured as open earmarks plus the unfunded guarantees of live events, as the design''s creation-time exposure check states. Ruling 21: this refuses an event''s creation, never a player.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A6. Does a guarantee cover bounties.
('guarantee_covers', 'all', NULL, 'prize_pool_only', 'choice',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'READ OFF THE CHIP ESTATE, the strongest kind of derivation available here, because the Diamond Arena is a diamonds-only clone of a chip club. fn_ca_fund_overlay_on_lock (md5 93f3e46a957abb7a42d4a2cfaff42fcb) computes its shortfall as the guarantee less prize_pool; bounty_pool is a separate column and is not in that arithmetic. fn_apply_prize_guarantee (md5 b7e8618d519c4aa6d714ff3e248234d0) likewise closes a PRIZE pool. So in chips a guarantee covers the prize pool only, and the Diamond clone follows it. The Diamond ledger already keeps prize_part and bounty_part apart and the design''s overlay row sets prize_part = amount with no bounty part, so this answer is the one the existing row shape was built for. Overlay = max(0, guarantee less the PRIZE parts of every entry, rebuy, re-entry and add-on).',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A7. Set aside at creation, or checked at creation and paid at close.
('guarantee_funding_moment', 'all', NULL, 'set_aside_at_creation', 'choice',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED from what the Diamond side lacks and what rule R3 supplies. The chip estate checks at creation, pays at lock, and falls back to the club treasury when the union bank is short (Dan, 2026-09-04); when BOTH are short it files a critical alert and starts the event with no overlay. The Diamond side has no treasury fallback, so cloning "checked at creation, paid at close" would clone the failure without its safety net: an event could advertise a prize, take real player Diamonds, and find the house short at close. R3 supplies what the chip estate never had - an earmark is append-only, lowers only the house''s AVAILABLE balance, and moves nothing, so setting the whole guarantee aside at creation costs nothing and changes no identity. Choosing set-aside-at-creation is therefore the only answer that replaces the chip fallback instead of dropping it, and it is the reason A8 can refuse at creation and never at close.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A8. May a cap refuse a staff member's creation request.
('guarantee_cap_refuses_creation', 'all', NULL, 'yes', 'boolean',
 'THERE SHOULDN''T BE A PLATFORM BUDGET ON THINGS LIKE THIS, ONLY A USER BUDGET.',
 'DERIVED FROM RULING 21 ITSELF, quoted above, rather than in tension with it. Ruling 21 forbids a platform pot refusing a PLAYER, and its reasoning is that a shared pool makes the players who arrive late pay for the players who arrived early, for something they did nothing to deserve. Admitting a guaranteed event the account cannot fund and only REPORTING it produces exactly that harm with interest: a player reads an advertised guarantee, pays a real entry, and is short-paid at close, which is a platform pot refusing a player AFTER they have paid. Refusing at creation harms nobody who has not been told anything yet, and the person refused is a staff member with the ability to lower the guarantee, pick another date or ask for an issuance. So the caps refuse, and they refuse ONLY there. THE BOUNDARY, which the law test pins: once an event exists and its guarantee is earmarked, no value in ca_diamond_economics may refuse any player a registration, a prize, a bounty, a refund or a payout. A cap stops a promise being made; it never stops one being kept.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A9. Who may create a guaranteed event and issue a promotional entry.
('guarantee_authority', 'all', NULL, 'platform_admin', 'role',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED from the rule the creation door already enforces and from ruling 16''s population. fn_poker_diamond_create_tournament is platform admins only today, and ruling 16 gives the Diamond Arena players and platform staff and nobody else. "Only me" would put the owner in the path of every guaranteed event and every promotional entry, which is the holding pattern CLAUDE.md 10.9 exists to end and the opposite of the instruction this migration rests on. So the authority is unchanged - any platform admin - and the answer records the approval the running rule lacked. It is not a loosening: 20260930131500 already requires a live session on every Diamond staff door, 20260929213000 puts staff-run Diamond games on the record, and the promotional door is bounded besides by A13, A14 and A15.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A10. May a Diamond tournament be a freeroll.
('freeroll_allowed', 'all', NULL, 'yes', 'boolean',
 'Rake/fees, guarantees, freerolls and any BBJ/spin reserves stay diamond-funded, with current approved budget rules; horses retain player parity and must use diamond-only funding.',
 'READ OFF A STANDING RULING. Ruling 16, quoted above and amended by Dan on 2026-09-08, names freerolls among the things that exist in the Diamond Arena and stay diamond-funded. The question is therefore already answered by the owner; this row records it where a door can read it. Yes. The creation door admits a zero buy-in ONLY together with a guarantee, since a freeroll''s prize IS its guarantee, which is why this answer depends on A1 to A8 and not merely on itself.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A11. What a rebuy and an add-on cost in a Diamond freeroll.
('freeroll_rebuy_cost', 'all', NULL, 'none_offered', 'choice',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED from the arena''s own treatment of its other guarantee-shaped format, rather than invented as a price. The chip Free Buy prices (Dan, 2026-09-02 and 2026-09-04) are chip amounts and carry nothing to Diamonds, as the design says. The Diamond Arena already makes its one other format whose seats are promised in advance a freezeout: the creation door raises diamond_satellite_is_a_freezeout, read live on 2026-10-05. A Diamond freeroll follows it. Choosing "none offered" also avoids inventing two prices nobody derived, and keeps the freeroll''s prize pool wholly the guarantee, so the overlay formula of A6 has one term and not two. If a priced rebuy is ever wanted it is a NEW row under a numeric name, not an edit here.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),
('freeroll_addon_cost', 'all', NULL, 'none_offered', 'choice',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED as for freeroll_rebuy_cost: a Diamond freeroll is a freezeout, following the Diamond satellite the creation door already makes one. The chip add-on price is a chip amount and carries nothing. No add-on is offered, so no Diamond add-on price is invented.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A12. May the funding account pay a player's entry.
('promo_entry_allowed', 'all', NULL, 'yes', 'boolean',
 'Fund guarantees and promotional entries from authorized diamond house/budgets.',
 'READ OFF THE PROGRAMME LINE ITSELF, quoted above: line (a) of Phase 9 of docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md names promotional entries as a thing to be funded from the Diamond house. The chip estate has the same product and it is live - 631 tournament tickets, 575 of them unredeemed, issued by fn_issue_tournament_ticket_phase2_core_20260831. So the answer is yes, and the Diamond shape differs from the chip one in one way that matters: the chip door debits the issuer''s own balance into escrow before the ticket exists, while under R3 the Diamond entry is an EARMARK on the house and no Diamond moves until it is redeemed.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A13. Promotional entries per player per calendar day.
('promo_entry_per_player_per_day', 'all', 10, NULL, 'entries_per_player_per_day',
 'THERE SHOULDN''T BE A PLATFORM BUDGET ON THINGS LIKE THIS, ONLY A USER BUDGET.',
 'REASONED FROM THE ONE PER-USER DAILY COUNT THE PLATFORM ALREADY SETS, and said so plainly because the chip estate sets no count at all. Ruling 21 left the per-user daily cap as "the whole of the control", and the only existing per-user, per-day limit expressed as a COUNT rather than in Diamonds is ruling 15''s referral rule: a maximum of 10 qualified referees a day. Ten is taken from there. The count cannot live in diamond_engine_daily_caps, which is Diamond-denominated, so the promotional door enforces it, exactly as the design says. This is a user budget in ruling 21''s own sense - a rule about one player and their own gifts - and it bounds only the ISSUE of an entry, never the redemption of one already issued. It applies identically to a horse and a human (CLAUDE.md 10.5).',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A14. Promotional entries per event.
('promo_entry_per_event', 'all', 9, NULL, 'entries_per_event',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'REASONED FROM THE ARENA''S OWN TABLE SIZE, and said so plainly: no chip per-event ticket cap exists to clone. The one structural field count the arena has is its maximum table size, nine, which the creation door enforces with LEAST(9, GREATEST(2, ...)). So at most one full table of an event''s field may be seats the house gave away, which keeps an advertised field from being substantially the house''s own players. Ruling 21: this refuses the ISSUE of a promotional entry into an event, never a paying player''s registration and never the redemption of an entry already issued.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A15. The monthly Diamond value of promotional entries.
('promo_entry_monthly_diamonds', 'all', 500000, NULL, 'diamonds_per_month',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'REASONED FROM A3, and said so plainly. Promotional entries draw on the same account as guarantees under the same monthly ceiling, so without a share of its own they could consume the whole of A3 and starve the guarantees, which are the larger commitment and the one a player is shown in advance. 500,000 is one quarter of A3''s 2,000,000, leaving three quarters - enough for the largest single event A4 permits, with headroom - to the guarantees. Ruling 21: this bounds what the house may GIVE AWAY in a month and is consulted only when an entry is issued, never when one is redeemed, and never by any paying player''s door.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A16. Where a refunded promotional entry's value goes.
('promo_entry_refund_destination', 'all', NULL, 'funding_account', 'choice',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'DERIVED DIRECTLY FROM RULE R3, which is the strongest basis any of the three options has. Under R3 nothing moves when a promotional entry is issued: the earmark is open and the Diamonds are still the house''s. A refund is therefore the earmark closing, and the design says it in those words - "Nothing moved, so nothing moves back". The other two options each require a MOVEMENT the design does not have: paying the value into the player''s wallet would hand them Diamonds they never owned and the house never meant to give, turning a seat into cash; re-issuing it as a fresh unused entry would let a player bank entries past A17''s expiry and around A13''s daily cap. Back to the funding account. This is a change from the chip behaviour, where every Diamond tournament refund pays the player''s wallet today, and that is the point: a refund returns what was PAID, and in a promotional entry the player paid nothing.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A17. How long a promotional entry may go unused.
('promo_entry_expiry_days', 'all', 14, NULL, 'days',
 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.',
 'READ OFF A STANDING RULING. Ruling 14 sets the Diamond purchase-settlement window at 14 days - the one expiry period the Diamond economy already runs on - so an unused promotional entry follows it rather than inventing a second clock. The sweep that returns an expired entry to the funding account is PRODUCT DESIGN, not a repair: it exists because an entry has a shelf life, not to paper over a defect, so CLAUDE.md 10.12 is not engaged by it. Under R3 the sweep closes an earmark and moves no Diamond.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A18. Horse entry funding. GOVERNED BY CLAUDE.md 10.5.
('horse_entry_funding', 'all', NULL, 'own_balance', 'choice',
 'HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!',
 'NOT A PREFERENCE: CLAUDE.md 10.5 APPLIED. The law reads "A horse pays the same buy-in, out of the same club wallet, through the same RPCs, and sits in the same seat as anybody else", and ruling 16 adds that horses "retain player parity and must use diamond-only funding". A horse''s Diamonds live in profiles.diamonds and follow it into the arena like anyone''s (ruling 9). If the funding account paid every horse''s entry while humans paid their own, that is precisely the "equal outcome by a different mechanism" Dan rejected outright on 2026-08-27: "EVERY HORSE OR HUMAN PLAYER NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING FOR THE CLUB ARENA." So a horse funds its Diamond entry from its own balance, through the ordinary Diamond registration door a person uses. READ LIVE 2026-10-05: fn_register_horse_for_tournament(uuid,uuid,boolean), md5 84c0354e68fb129b5373bc6024cba334, still returns ok:false reason:diamond_horse_funding_not_open for every Diamond event, under the comment "DIAMOND PHASE 8: house-funded horse entries are Phase 9" - that comment is the assumption 10.5 forbids, and this row is the answer that retires it. A horse may ALSO receive a promotional entry on exactly the same terms as a human, under the same A13, A14 and A15 caps - never more and never less - and any p_include_horses on this path defaults to true.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A19. Automatic horse entry into a short guaranteed event. GOVERNED BY 10.5.
('horse_overlay_autofill', 'all', NULL, 'yes', 'boolean',
 'TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING FOR THE CLUB ARENA.',
 'NOT A PREFERENCE: CLAUDE.md 10.5 APPLIED. Horses are entered automatically into a chip event that is short of its guarantee under Dan''s overlay rule of 2026-08-27. 10.5 requires identical treatment - "same features, same functionality" - and the test it sets is "is it identical", not "is it equivalent". A Diamond guaranteed event short of its guarantee therefore gets the same fill, so the overlay guard gains a Diamond arm. Two things this does NOT change: the horse pays its own entry when it is so entered (A18), because the guard seeds horses and never funds them; and it may never reach fn_horse_fund_from_treasury, which is a chip account ruling 16 forbids in a Diamond format.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane'),

-- A20. Automatic horse entry into freerolls. GOVERNED BY 10.5.
('horse_freeroll_autofill', 'all', NULL, 'yes', 'boolean',
 'TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING FOR THE CLUB ARENA.',
 'NOT A PREFERENCE: CLAUDE.md 10.5 APPLIED. Horses fill chip freerolls under Dan''s freeroll rule of 2026-08-27, so they fill Diamond freerolls, and the freeroll fill gains a Diamond arm. A Diamond freeroll costs nothing to enter (A10, A11), so there is no funding question here at all: the horse pays what a human pays, which is nothing, and is paid what a human is paid. Not reaching fn_horse_fund_from_treasury is automatic, since nothing is charged.',
 DATE '2026-10-05', 'claude-code:diamond-destinations-lane');

-- ---------------------------------------------------------------------------
-- 7. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_n int; v_bad text; v_txt text; r record; v_err text;
BEGIN
  -- 7a. The table, its guards and its readers exist.
  IF to_regclass('public.ca_diamond_economics') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_economics was not created';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.ca_diamond_economics'::regclass AND NOT tgisinternal;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ca_diamond_economics carries % user triggers, expected 2 (append-only and no-truncate)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.ca_diamond_economics'::regclass AND contype = 'c';
  IF v_n < 9 THEN
    RAISE EXCEPTION 'ca_diamond_economics carries only % check constraints, expected at least 9', v_n;
  END IF;
  FOR r IN SELECT unnest(ARRAY[
      'fn_ca_diamond_economic','fn_ca_diamond_economic_text','fn_ca_diamond_economic_on',
      'fn_ca_diamond_economics_units_of','fn_ca_diamond_economics_append_only']) AS fn
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn) THEN
      RAISE EXCEPTION '% was not created', r.fn;
    END IF;
  END LOOP;

  -- 7b. Twenty-one rows for twenty questions (A11 is two names: a rebuy and
  --     an add-on), each one of the twenty answered exactly once.
  SELECT count(*) INTO v_n FROM public.ca_diamond_economics;
  IF v_n <> 21 THEN
    RAISE EXCEPTION 'ca_diamond_economics holds % rows, expected 21', v_n;
  END IF;
  SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO v_bad
    FROM (VALUES
      ('guarantee_overlay_account'),('guarantee_mint_may_issue'),
      ('guarantee_mint_monthly_ceiling'),('guarantee_max_per_event'),
      ('guarantee_max_outstanding'),('guarantee_covers'),
      ('guarantee_funding_moment'),('guarantee_cap_refuses_creation'),
      ('guarantee_authority'),('freeroll_allowed'),('freeroll_rebuy_cost'),
      ('freeroll_addon_cost'),('promo_entry_allowed'),
      ('promo_entry_per_player_per_day'),('promo_entry_per_event'),
      ('promo_entry_monthly_diamonds'),('promo_entry_refund_destination'),
      ('promo_entry_expiry_days'),('horse_entry_funding'),
      ('horse_overlay_autofill'),('horse_freeroll_autofill')
    ) AS x(name)
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_diamond_economics e
                      WHERE e.name = x.name AND e.scope = 'all');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these A answers were not recorded: %', v_bad;
  END IF;

  -- 7c. No fee row was seeded. Section 3.2 is explicit: until an answer
  --     exists the creation door keeps its inherited rule, and seeding one
  --     here would silently change a fee that is running in production.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_economics
              WHERE name LIKE 'tournament_%fee%' OR name LIKE 'cash_rake%'
                 OR name LIKE 'bbj_%' OR name LIKE 'rakeback_%') THEN
    RAISE EXCEPTION 'a B answer was seeded; the fee, rake and BBJ rows belong to their own lanes and their own owner answers';
  END IF;

  -- 7d. The readers return what was recorded, in the right kind.
  IF public.fn_ca_diamond_economic('guarantee_max_per_event') <> 1000000 THEN
    RAISE EXCEPTION 'the reader does not return A4';
  END IF;
  IF public.fn_ca_diamond_economic('guarantee_mint_monthly_ceiling') <> 2000000
     OR public.fn_ca_diamond_economic('guarantee_max_outstanding') <> 2000000
     OR public.fn_ca_diamond_economic('promo_entry_monthly_diamonds') <> 500000
     OR public.fn_ca_diamond_economic('promo_entry_per_player_per_day') <> 10
     OR public.fn_ca_diamond_economic('promo_entry_per_event') <> 9
     OR public.fn_ca_diamond_economic('promo_entry_expiry_days') <> 14 THEN
    RAISE EXCEPTION 'the reader does not return the recorded numbers';
  END IF;
  IF public.fn_ca_diamond_economic_text('guarantee_overlay_account') <> 'ca_diamond_house'
     OR public.fn_ca_diamond_economic_text('guarantee_covers') <> 'prize_pool_only'
     OR public.fn_ca_diamond_economic_text('guarantee_funding_moment') <> 'set_aside_at_creation'
     OR public.fn_ca_diamond_economic_text('horse_entry_funding') <> 'own_balance'
     OR public.fn_ca_diamond_economic_text('guarantee_authority') <> 'platform_admin' THEN
    RAISE EXCEPTION 'the reader does not return the recorded words';
  END IF;
  -- 10.5: the three horse answers are the law, not a preference.
  IF NOT public.fn_ca_diamond_economic_on('horse_overlay_autofill')
     OR NOT public.fn_ca_diamond_economic_on('horse_freeroll_autofill')
     OR public.fn_ca_diamond_economic_text('horse_entry_funding') <> 'own_balance' THEN
    RAISE EXCEPTION 'a horse answer does not read as player parity (CLAUDE.md 10.5)';
  END IF;
  IF NOT public.fn_ca_diamond_economic_on('freeroll_allowed')
     OR NOT public.fn_ca_diamond_economic_on('promo_entry_allowed')
     OR NOT public.fn_ca_diamond_economic_on('guarantee_mint_may_issue')
     OR NOT public.fn_ca_diamond_economic_on('guarantee_cap_refuses_creation') THEN
    RAISE EXCEPTION 'a switch answer does not read as yes';
  END IF;
  -- The chain A4 <= A5 <= A3 is the whole reason those three numbers hold
  -- together. If a later row breaks it, the platform can advertise more than
  -- it can fund, so it is asserted here and pinned by the law test.
  IF NOT (public.fn_ca_diamond_economic('guarantee_max_per_event')
            <= public.fn_ca_diamond_economic('guarantee_max_outstanding')
          AND public.fn_ca_diamond_economic('guarantee_max_outstanding')
            <= public.fn_ca_diamond_economic('guarantee_mint_monthly_ceiling')) THEN
    RAISE EXCEPTION 'the guarantee chain is broken: per event must not exceed outstanding, which must not exceed the monthly ceiling';
  END IF;
  -- Promotional entries must not be able to eat the whole month.
  IF public.fn_ca_diamond_economic('promo_entry_monthly_diamonds')
       >= public.fn_ca_diamond_economic('guarantee_mint_monthly_ceiling') THEN
    RAISE EXCEPTION 'promotional entries could consume the whole monthly ceiling and starve the guarantees';
  END IF;

  -- 7e. An unset value refuses BY NAME, under PDE01, and never returns NULL.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('cash_rake_percent', 'bb:2');
    RAISE EXCEPTION 'an unset Diamond economic value did not refuse';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    v_err := SQLERRM;
    IF v_err <> 'diamond_economics_unset:cash_rake_percent/bb:2' THEN
      RAISE EXCEPTION 'the unset refusal does not name the value: %', v_err;
    END IF;
  END;
  -- And it does not fall back from a stake scope to 'all'.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('guarantee_max_per_event', 'bb:2');
    RAISE EXCEPTION 'the reader fell back from a stake scope to all';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN NULL;
  END;
  -- A switch nobody has set is not "off".
  BEGIN
    PERFORM public.fn_ca_diamond_economic_on('cash_rake_enabled');
    RAISE EXCEPTION 'an unset switch read as a value instead of refusing';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN NULL;
  END;
  -- Asking for a word with the number reader is a defect, not a NULL.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('guarantee_overlay_account');
    RAISE EXCEPTION 'the number reader returned an account';
  EXCEPTION WHEN SQLSTATE 'PDE02' THEN NULL;
  END;
  BEGIN
    PERFORM public.fn_ca_diamond_economic_text('guarantee_max_per_event');
    RAISE EXCEPTION 'the word reader returned a number';
  EXCEPTION WHEN SQLSTATE 'PDE02' THEN NULL;
  END;
  -- A name outside the closed list is refused, not answered.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('whatever_an_agent_felt_like');
    RAISE EXCEPTION 'the reader answered a name that is not a question';
  EXCEPTION WHEN SQLSTATE 'PDE02' THEN NULL;
  END;

  -- 7f. The table is append-only in fact, not only in comment.
  BEGIN
    UPDATE public.ca_diamond_economics SET value = 1 WHERE name = 'guarantee_max_per_event';
    RAISE EXCEPTION 'ca_diamond_economics admitted an UPDATE';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    DELETE FROM public.ca_diamond_economics WHERE name = 'guarantee_max_per_event';
    RAISE EXCEPTION 'ca_diamond_economics admitted a DELETE';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  -- A value in the wrong unit for its name is refused.
  BEGIN
    INSERT INTO public.ca_diamond_economics
      (name, scope, value, units, approved_quote, basis, approved_on, recorded_by)
    VALUES ('guarantee_max_per_event','all',5,'percent','x','y',DATE '2026-10-05','z');
    RAISE EXCEPTION 'a value was admitted in the wrong unit for its name';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  -- A row with no owner words is refused.
  BEGIN
    INSERT INTO public.ca_diamond_economics
      (name, scope, value, units, approved_quote, basis, approved_on, recorded_by)
    VALUES ('cash_rake_min_pot','all',5,'diamonds','  ','y',DATE '2026-10-05','z');
    RAISE EXCEPTION 'a value was admitted with no owner words behind it';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  -- A fractional Diamond is refused: a Diamond is whole.
  BEGIN
    INSERT INTO public.ca_diamond_economics
      (name, scope, value, units, approved_quote, basis, approved_on, recorded_by)
    VALUES ('cash_rake_min_pot','all',2.5,'diamonds','q','y',DATE '2026-10-05','z');
    RAISE EXCEPTION 'a fractional Diamond was admitted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;

  -- 7g. Nothing here is reachable from a browser, and nothing reads is_horse.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_diamond_economic','fn_ca_diamond_economic_text',
                                'fn_ca_diamond_economic_on','fn_ca_diamond_economics_units_of',
                                'fn_ca_diamond_economics_append_only')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser', r.proname;
    END IF;
    IF position('is_horse' IN pg_get_functiondef(r.oid)) > 0 THEN
      RAISE EXCEPTION '% branches on horse status (CLAUDE.md 10.5)', r.proname;
    END IF;
  END LOOP;
  IF has_table_privilege('anon','public.ca_diamond_economics','SELECT')
     OR has_table_privilege('authenticated','public.ca_diamond_economics','SELECT') THEN
    RAISE EXCEPTION 'ca_diamond_economics is readable from a browser';
  END IF;

  -- 7h. No Diamond door was redefined by this migration, so the creation door
  --     is exactly as it was read. The doors learn the reader later.
  IF md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure))
       <> '05e4ae642e1a3949da8bb34bc62f7f3d' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament moved; this migration must not touch a door';
  END IF;
  -- And the creation door still refuses the money keys its builder sends
  -- (section 6 item 3, already fixed by 20260929160000; proved, not assumed).
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF position('diamond_tournament_money_key_not_read' IN v_txt) = 0
     OR position('guaranteedPrize' IN v_txt) = 0
     OR position('addOnFromStart' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door no longer refuses the money keys it does not read';
  END IF;

  -- 7i. The estate is as it was. The cash door stays shut; tournaments_enabled
  --     was ALREADY true when this work began (read 2026-10-05 15:13 UTC) and
  --     this migration neither reads nor writes ca_arena_settings, so it is
  --     left exactly as found and is not asserted to a value another lane owns.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the Diamond cash door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  -- No Diamond moved: this migration records answers and holds no money.
  IF (SELECT balance FROM public.ca_diamond_house WHERE id = 1) <> 0 THEN
    RAISE EXCEPTION 'the Diamond house balance moved; this migration moves no Diamond';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;

  RAISE NOTICE 'diamond economics records the owner answers: A1 to A20 are 21 append-only rows, each with the owner words behind it and the derivation that produced it, and an unset value refuses by name under PDE01';
END $m$;

COMMIT;
