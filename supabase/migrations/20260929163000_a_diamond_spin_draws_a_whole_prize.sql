-- ============================================================================
-- A DIAMOND SPIN DRAWS A WHOLE PRIZE
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme: the Spin tournament format (three
-- seats, a multiplier drawn at launch, a prize pool of that multiplier times
-- the buy-in) in Diamonds - its draw and its reserve. This is the tournament
-- format, not the Diamond Spins bonus wheel, which nothing here touches.
--
-- How the chip estate does it (read live, 2026-09-29): the buy-in is the whole
-- charge (buy_in_fee 0) and the house edge is engineered into the multiplier
-- table: E[multiplier] = 3 x (1 - fn_spin_rake_rate()) = 2.76, an equality the
-- draw authority refuses a table for missing. At launch the one authority,
-- fn_spin_draw_and_settle_atomic (lease-, receipt- and freeze-bound), books the
-- three entries into the owner's reserve pool less a fixed rake, rolls
-- extensions.gen_random_bytes over the table, locks out any tier the pool
-- cannot cover or whose reserve threshold it does not meet, draws the whole
-- prize back out of the pool, writes an immutable spin_draw_receipts row and
-- stamps the tournament row, in one transaction. The reserve therefore pays
-- every prize above the entries and keeps every entry above the prize.
--
-- In Diamonds there is no owner pool and no chip rake, and the only holder of
-- Diamonds that is neither a player nor custody is the house (ca_diamond_house)
-- inside the supply identity players + house + custody = register. So:
--
--   * the three entries stay where Phase 8 put them, in custody, whole;
--   * at the draw a pool ABOVE the entries is underwritten by the authorized
--     source into the event's custody (a house burn on the register and a
--     player-side register mint for each custody share it lands in), and a
--     pool BELOW them releases the surplus from custody to the source (each
--     share journaled as its player's spend, which the register retires, and
--     a house mint) - the register pair the Phase 8 fee settlement already
--     uses, so the identity never moves;
--   * the table's expectation is the edge, realised over volume against the
--     source; no per-game rake is booked (8 per cent of three entries is not a
--     whole Diamond at most buy-ins, and nothing here rounds a price);
--   * the source underwrites ONLY what is authorized: a one-row declaration,
--     poker_diamond_spin_reserve_source, names the source and the most one
--     Spin may take from it. This migration writes no row. Until one exists
--     every Diamond Spin is refused by name at creation and at the draw
--     (diamond_spin_reserve_source_not_authorized). The source and the cap are
--     Dan's (CLAUDE.md 10.9); the only Diamond account this code can move
--     against is the house, which holds 0 today.
--   * a Diamond Spin draws from its whole pinned table or not at all: the
--     source must cover every tier - the pool above the entries, and a tier's
--     reserve threshold times its pool, the chip reserve gate with the event's
--     own buy-in as its stake - at creation and again at the draw. What is
--     advertised is what is drawn from; no tier is locked out.
--
-- THE WHOLE-DIAMOND RULE, certified here: the prize pool is the drawn
-- multiplier times the buy-in floored to the unit (one Diamond), and the legs
-- are computed from the floored pool, so a residue below the unit could only
-- ever stay with the source, inside the identity. A residue would silently
-- raise the edge above the table's certified expectation, so a table that
-- would leave one is refused at the creation door by name: every tier's pool
-- AND every place of its ladder must be a whole number of Diamonds at the
-- configured buy-in (diamond_spin_tier_not_whole_at_the_buy_in), and the draw
-- proves the residue is zero before anything moves. The published table
-- (spin_tier_spec with the estate ladders) is whole at a buy-in of one Diamond
-- and therefore at every whole buy-in; the final block below proves it.
--
-- What changes:
--
--   1. poker_diamond_spin_reserve_source: the authorization, one row, empty.
--   2. poker_diamond_spin_contracts: the multiplier table a Diamond Spin was
--      created with, validated at its buy-in and pinned by sha256, immutable.
--   3. The Diamond tournament ledger names the two reserve legs
--      (spin_underwrite, spin_surplus), prize bank only, per custody row.
--   4. fn_poker_diamond_spin_contract: the rule - the chip draw authority's
--      manifest rules, the estate ladder for a multiplier the terminal prices
--      from it, and the whole-Diamond rule.
--   5. The creation door admits 'spin' through fn_poker_diamond_create_spin
--      under the chip seat-first door's rules and refuses a mismatch by name.
--   6. The banks carry the legs: the escrow reads them into the prize bank,
--      the shadow opens with them as reserve_in / reserve_out, the chip-facing
--      router keeps the chip shadow convention, the drain holds an
--      underwritten share as prize and names a surplus.
--   7. The draw: fn_poker_diamond_spin_draw, the Diamond arm of the one
--      authority, reached from fn_spin_draw_and_settle_atomic after its lease,
--      launch-receipt and freeze proofs; fn_poker_diamond_spin_draw_proof
--      reads it back.
--   8. No chip reserve touches a Diamond Spin: the retired chip draw and the
--      chip settle refuse one by name, the unbooked sweep skips it and the
--      third seat books no chip entry for it.
--   9. The contract trigger and the launch completion read the Diamond draw.
--  10. A drawn Diamond Spin is refunded by no door.
--
-- Every chip edit is an asserted substitution (live md5 pinned, the clause
-- occurs once, the reverse substitution proved). Every Diamond door is pinned,
-- redefined in full with the same signature and declared to the guard watch
-- where it is watched. tournaments_enabled stays false and no reserve source
-- is authorized.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_create_tournament                    55c2176b75c5bb1499960f7bb846d3aa
--   fn_poker_diamond_tournament_escrow                    850410a45ed7eefe785d3f17a2403247
--   fn_poker_diamond_tournament_open_shadow               15beba292789e7f1e665c7caa9530304
--   fn_poker_diamond_tournament_drain                     abaf068c32e192f08a1c01c02b089523
--   fn_poker_diamond_tournament_refund                    4dcc2e8556323bf831de3863e218f97a
--   fn_ca_tournament_escrow                               707b4cbeb6f4906c2216cefea6635ca8
--   fn_spin_draw_and_settle_atomic                        19e06d2d13a5f53cd7c59686802dae4a
--   fn_spin_settle_game                                   366a1981c2ea9f0f54b41fe50a5d19b4
--   fn_spin_draw_and_settle                               f1f01a7719faac3b426e6358a37c5873
--   fn_spin_sweep_unbooked                                2b5c7761a1a1ed132f90c66b5a228b7f
--   fn_sync_seat_first_player_count                       0e4acaf0ff080d4dafd1aa85068cf0b2
--   fn_spin_tournament_contract_is_draw                   747fc99476b082256141d42003a6c478
--   fn_complete_tournament_launch_before_lease_generation d1a25ca8de559144fe83b7639634baff
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
  IF to_regclass('public.poker_diamond_spin_reserve_source') IS NOT NULL
     OR to_regclass('public.poker_diamond_spin_contracts') IS NOT NULL THEN
    RAISE EXCEPTION 'the Diamond Spin tables already exist; this migration creates them';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE SOURCE UNDERWRITES ONLY WHAT IS AUTHORIZED
-- ---------------------------------------------------------------------------
CREATE TABLE public.poker_diamond_spin_reserve_source (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_account text NOT NULL CHECK (source_account = 'diamond_house'),
  max_underwrite_per_spin bigint NOT NULL
    CHECK (max_underwrite_per_spin >= 1 AND max_underwrite_per_spin <= 2147483647),
  authorized_by text NOT NULL CHECK (length(btrim(authorized_by)) >= 2),
  ruling text NOT NULL CHECK (length(btrim(ruling)) >= 10),
  authorized_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.poker_diamond_spin_reserve_source IS
  'DIAMOND SPIN RESERVE SOURCE (Phase 9). One row or none, written by a values migration that quotes Dan, never by code. '
  'It names the Diamond account that underwrites a Spin prize pool above its three entries and receives the entries above a '
  'smaller pool (the only account the draw can move against today: the house, ca_diamond_house), and the most one Spin may '
  'take from it. No row: every Diamond Spin is refused at creation and at the draw (diamond_spin_reserve_source_not_authorized). '
  'CLAUDE.md 10.9: the source and the number are Dan''s.';
ALTER TABLE public.poker_diamond_spin_reserve_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.poker_diamond_spin_reserve_source FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.poker_diamond_spin_reserve_source TO service_role;

-- ---------------------------------------------------------------------------
-- 2. A DIAMOND SPIN'S TABLE IS PINNED WHEN IT IS CREATED
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_spin_contract_is_immutable', 'system',
   'Diamond Phase 9. Trigger: a Diamond Spin contract row is never updated or deleted. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_contract_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'A Diamond Spin contract is immutable' USING ERRCODE = '23514';
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_contract_is_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.poker_diamond_spin_contracts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  buy_in bigint NOT NULL CHECK (buy_in >= 1 AND buy_in <= 2147483647),
  starting_chips integer NOT NULL CHECK (starting_chips >= 1),
  rake_rate numeric NOT NULL CHECK (rake_rate >= 0 AND rake_rate < 1),
  rule_manifest jsonb NOT NULL CHECK (jsonb_typeof(rule_manifest) = 'object'),
  rule_sha256 text NOT NULL CHECK (rule_sha256 ~ '^[0-9a-f]{64}$'),
  worst_excess bigint NOT NULL CHECK (worst_excess >= 0),
  required_cover bigint NOT NULL CHECK (required_cover >= worst_excess),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
COMMENT ON TABLE public.poker_diamond_spin_contracts IS
  'DIAMOND SPIN CONTRACT (Phase 9). The multiplier table a Diamond Spin was created with, validated by '
  'fn_poker_diamond_spin_contract at its buy-in and pinned by sha256. The draw rolls over this table and nothing else; '
  'the engine''s compiled manifest cannot change it. worst_excess is the most the source can pay into the pool above the '
  'three entries; required_cover is what the source must hold for every tier to be drawable (the pool above the entries, '
  'and a tier''s reserve threshold times its pool - the chip reserve gate, with the event''s own buy-in as its stake).';
CREATE TRIGGER poker_diamond_spin_contract_is_immutable
  BEFORE UPDATE OR DELETE ON public.poker_diamond_spin_contracts
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_spin_contract_is_immutable();
ALTER TABLE public.poker_diamond_spin_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.poker_diamond_spin_contracts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.poker_diamond_spin_contracts TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE LEDGER NAMES THE RESERVE LEGS
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass
                            AND conname='poker_diamond_tournament_ledger_kind_check'))
     IS DISTINCT FROM 'CHECK ((kind = ANY (ARRAY[''entry''::text, ''rebuy''::text, ''reentry''::text, ''addon''::text, ''prize''::text, ''bounty''::text, ''fee''::text, ''refund''::text])))' THEN
    RAISE EXCEPTION 'the ledger kind check is not the pinned text';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass
                            AND conname='poker_diamond_tournament_ledger_outflow'))
     IS DISTINCT FROM 'CHECK ((((kind = ANY (ARRAY[''prize''::text, ''bounty''::text, ''refund''::text])) AND (user_id IS NOT NULL)) OR ((kind = ''fee''::text) AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0)) OR (kind = ANY (ARRAY[''entry''::text, ''rebuy''::text, ''reentry''::text, ''addon''::text]))))' THEN
    RAISE EXCEPTION 'the ledger outflow check is not the pinned text';
  END IF;
END $m$;

-- A reserve leg moves the prize bank of one custody row, whole: the source's
-- underwriting into it (spin_underwrite) or the entries' surplus out of it to
-- the source (spin_surplus). It names the row, the player whose custody moved
-- and the journal row the register followed.
ALTER TABLE public.poker_diamond_tournament_ledger
  DROP CONSTRAINT poker_diamond_tournament_ledger_kind_check,
  ADD CONSTRAINT poker_diamond_tournament_ledger_kind_check CHECK (kind IN ('entry', 'rebuy', 'reentry', 'addon', 'prize', 'bounty', 'fee', 'refund', 'spin_underwrite', 'spin_surplus')),
  DROP CONSTRAINT poker_diamond_tournament_ledger_outflow,
  ADD CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK ((((kind = ANY (ARRAY['prize'::text, 'bounty'::text, 'refund'::text])) AND (user_id IS NOT NULL)) OR ((kind = 'fee'::text) AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0)) OR (kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])))
    OR (kind IN ('spin_underwrite','spin_surplus') AND user_id IS NOT NULL AND custody_id IS NOT NULL
        AND wallet_journal_id IS NOT NULL AND prize_part = amount AND bounty_part = 0 AND fee_part = 0));

-- ---------------------------------------------------------------------------
-- 4. THE RULE: A TABLE IS HONOURED IN WHOLE DIAMONDS OR IT IS REFUSED
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_spin_contract', 'system',
   'Diamond Phase 9. Validates a Diamond Spin multiplier table at its buy-in (the chip draw authority''s manifest rules, the estate ladder for a multiplier the terminal prices from it, the whole-Diamond rule) and returns the manifest, its worst excess and the cover its source must hold. Reads only; refuses by name. Moves no money.'),
  ('fn_poker_diamond_create_spin', 'system',
   'Diamond Phase 9. The spin branch of fn_poker_diamond_create_tournament under the chip seat-first door''s rules: refuses a non-spin or unknown configuration by name, validates and pins the multiplier table, requires an authorized reserve source that covers the table, writes the tournament row, its contract and its joinable table. Staff only, owner-only. Moves no money.'),
  ('fn_poker_diamond_spin_draw', 'approved',
   'Diamond Phase 9. The Diamond arm of fn_spin_draw_and_settle_atomic, the one Spin draw authority: proves three whole entries in custody, the pinned contract and the authorized source, rolls extensions.gen_random_bytes over the pinned table and moves the reserve legs in whole Diamonds - the source underwrites the pool above the entries into custody (house burn + player-side register mint) or takes back the surplus below them (the drain''s player-side burn + house mint) - then writes the immutable spin_draw_receipts row and stamps the tournament. Owner-only; reached only through the atomic authority after its lease, launch and freeze proofs.'),
  ('fn_poker_diamond_spin_draw_proof', 'system',
   'Diamond Phase 9. Reads a Diamond Spin draw back against the tournament row, the ledger legs and the source''s register rows. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rake numeric; v_b record; v_c jsonb; v_tier jsonb; v_place record; v_key text;
  v_m numeric; v_f numeric; v_thr numeric; v_pool numeric; v_share numeric; v_pct numeric;
  v_ladder jsonb; v_estate jsonb; v_tiers jsonb := '[]'::jsonb;
  v_freq numeric := 0; v_weight numeric := 0; v_worst numeric := 0; v_cover numeric := 0;
BEGIN
  IF p_buy_in IS NULL OR p_buy_in < 1 OR p_buy_in > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  IF p_starting_chips IS NULL OR p_starting_chips < 1 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023';
  END IF;

  -- The blind ladder, under the chip draw authority's manifest rule: twelve
  -- levels in order, no ante, the twelfth carrying the continuation that
  -- prices every level after it (the engine refuses a receipt without it).
  IF jsonb_typeof(p_blinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_blinds) <> 12 THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;
  FOR v_b IN SELECT b.value, b.ordinality FROM jsonb_array_elements(p_blinds) WITH ORDINALITY b ORDER BY b.ordinality LOOP
    IF jsonb_typeof(v_b.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_b.value->'level') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'smallBlind') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'bigBlind') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'duration') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'ante') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
    END IF;
    IF (v_b.value->>'level')::numeric <> v_b.ordinality
       OR (v_b.value->>'smallBlind')::numeric <= 0
       OR (v_b.value->>'bigBlind')::numeric < (v_b.value->>'smallBlind')::numeric
       OR (v_b.value->>'duration')::numeric <= 0
       OR (v_b.value->>'ante')::numeric <> 0 THEN
      RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
    END IF;
  END LOOP;
  v_c := p_blinds->11->'spinContinuation';
  IF jsonb_typeof(v_c) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_c->'version') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'anchorLevel') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'anchorBigBlind') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'growth') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'roundBigTo') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;
  IF (v_c->>'version')::numeric <> 1
     OR (v_c->>'anchorLevel')::numeric <= 0 OR (v_c->>'anchorLevel')::numeric <> trunc((v_c->>'anchorLevel')::numeric)
     OR (v_c->>'anchorBigBlind')::numeric <= 0
     OR (v_c->>'growth')::numeric <= 1
     OR (v_c->>'roundBigTo')::numeric <= 0 THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;

  -- The multiplier table, tier by tier, under the chip draw authority's rules.
  IF jsonb_typeof(p_tiers) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tiers) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
  END IF;
  v_rake := public.fn_spin_rake_rate(p_buy_in);
  FOR v_tier IN SELECT t.value FROM jsonb_array_elements(p_tiers) WITH ORDINALITY t ORDER BY t.ordinality LOOP
    IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_tier->'multiplier') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_tier->'freq') IS DISTINCT FROM 'number'
       OR jsonb_typeof(COALESCE(v_tier->'reserveThresholdX', '0'::jsonb)) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_tier) LOOP
      IF v_key NOT IN ('multiplier','freq','reserveThresholdX','payoutStructure') THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: a tier does not take %', v_key USING ERRCODE='22023';
      END IF;
    END LOOP;
    v_m := (v_tier->>'multiplier')::numeric;
    v_f := (v_tier->>'freq')::numeric;
    v_thr := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);
    IF v_m <= 0 OR v_f <= 0 OR v_thr < 0 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    -- The ladder: the tier's own, or the estate's for this multiplier. The
    -- terminal prices a multiplier the estate knows from the estate's ladder
    -- (fn_ca_tournament_place_amounts), so a tier may not advertise another.
    v_estate := NULL;
    SELECT l.structure INTO v_estate FROM public.spin_payout_ladder l WHERE l.multiplier = v_m;
    v_ladder := COALESCE(v_tier->'payoutStructure', v_estate);
    IF v_ladder IS NULL THEN
      RAISE EXCEPTION 'diamond_spin_tier_needs_a_payout_ladder: %x has no ladder of its own and none in spin_payout_ladder', v_m
        USING ERRCODE='22023';
    END IF;
    IF v_estate IS NOT NULL AND v_ladder IS DISTINCT FROM v_estate THEN
      RAISE EXCEPTION 'diamond_spin_ladder_is_not_the_estate_ladder: %x pays %, the estate pays %', v_m, v_ladder, v_estate
        USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(v_ladder) IS DISTINCT FROM 'array' OR jsonb_array_length(v_ladder) NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    -- THE WHOLE-DIAMOND RULE: the pool, and every place of its ladder, is a
    -- whole number of Diamonds at this buy-in, or the tier cannot be honoured.
    v_pool := v_m * p_buy_in;
    IF v_pool <> trunc(v_pool) OR v_pool < 1 THEN
      RAISE EXCEPTION 'diamond_spin_tier_not_whole_at_the_buy_in: %x at a buy-in of % Diamonds is a prize pool of % Diamonds',
        v_m, p_buy_in, v_pool USING ERRCODE='22023';
    END IF;
    v_pct := 0;
    FOR v_place IN SELECT p.value, p.ordinality FROM jsonb_array_elements(v_ladder) WITH ORDINALITY p ORDER BY p.ordinality LOOP
      IF jsonb_typeof(v_place.value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_place.value->'place') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_place.value->'percentage') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
      END IF;
      IF (v_place.value->>'place')::numeric <> v_place.ordinality
         OR (v_place.value->>'percentage')::numeric <= 0 THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
      END IF;
      v_share := v_pool * (v_place.value->>'percentage')::numeric / 100;
      IF v_share <> trunc(v_share) OR v_share < 1 THEN
        RAISE EXCEPTION 'diamond_spin_tier_not_whole_at_the_buy_in: %x place % takes % of a % Diamond pool',
          v_m, v_place.ordinality, v_share, v_pool USING ERRCODE='22023';
      END IF;
      v_pct := v_pct + (v_place.value->>'percentage')::numeric;
    END LOOP;
    IF v_pct <> 100 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    v_freq := v_freq + v_f;
    v_weight := v_weight + v_f * v_m;
    -- What the source can be asked for: the pool above the three entries.
    -- What it must hold for the tier to be drawable: that, or the tier's
    -- reserve threshold times its pool (the chip reserve gate, with this
    -- event's own buy-in as its stake), whichever is more.
    v_worst := GREATEST(v_worst, v_pool - 3 * p_buy_in);
    v_cover := GREATEST(v_cover, v_pool - 3 * p_buy_in, CASE WHEN v_thr > 0 THEN ceil(v_pool * v_thr) ELSE 0 END);
    v_tiers := v_tiers || jsonb_build_array(jsonb_build_object(
      'multiplier', v_m, 'freq', v_f, 'reserveThresholdX', v_thr,
      'blind_structure', p_blinds, 'payout_structure', v_ladder));
  END LOOP;
  IF (SELECT count(DISTINCT (x->>'multiplier')::numeric) FROM jsonb_array_elements(v_tiers) x) <> jsonb_array_length(v_tiers) THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: a multiplier appears twice' USING ERRCODE='22023';
  END IF;
  -- The chip authority's one pricing rule: E[multiplier] = seats x (1 - rake), exactly.
  IF v_weight <> v_freq * 3 * (1 - v_rake) THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: the table expects %x of three seats, the approved edge prices %x',
      round(v_weight / v_freq, 6), 3 * (1 - v_rake) USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object(
    'manifest', jsonb_build_object('version', 1, 'asset', 'diamonds', 'unit_cents', 100,
      'buy_in', p_buy_in, 'seats', 3, 'starting_chips', p_starting_chips, 'rake_rate', v_rake, 'tiers', v_tiers),
    'worst_excess', v_worst::bigint, 'required_cover', v_cover::bigint);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_contract(bigint, integer, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE CREATION DOOR ADMITS THE SPIN FORMAT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text; v_total numeric; v_buy_in bigint; v_chips numeric; v_game text; v_name text; v_start timestamptz;
  v_blinds jsonb; v_tiers jsonb; v_contract jsonb; v_manifest jsonb; v_sha text;
  v_source public.poker_diamond_spin_reserve_source%ROWTYPE; v_held numeric;
  v_worst bigint; v_cover bigint; v_id uuid; v_table uuid; v_sb numeric; v_bb numeric;
BEGIN
  -- Only the creation door reaches this, after it proved a signed-in platform
  -- operator and found the arena; both are proved again here.
  IF v_actor IS NULL OR NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  IF p_arena IS NULL OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=p_arena
       AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL) THEN
    RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;

  -- The chip seat-first door refuses a configured multiplier: it is drawn.
  IF p_config ?| ARRAY['spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_is_drawn_not_configured' USING ERRCODE='22023';
  END IF;
  -- And it refuses a key it would not keep. A Spin is priced by its buy-in,
  -- fielded by three seats and paid by its drawn ladder: a fee, a bounty, a
  -- rebuy, a guarantee or a ladder of its own means nothing here.
  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('type','name','gameVariant','buyIn','startingStack','blindStructure','spinTiers',
                     'startTime','maxPlayers','minPlayers','tableSize') THEN
      RAISE EXCEPTION 'diamond_spin_rejects_a_non_spin_configuration: %', v_key USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_config ? 'maxPlayers' AND (p_config->>'maxPlayers') IS DISTINCT FROM '3')
     OR (p_config ? 'minPlayers' AND (p_config->>'minPlayers') IS DISTINCT FROM '3')
     OR (p_config ? 'tableSize' AND (p_config->>'tableSize') IS DISTINCT FROM '3') THEN
    RAISE EXCEPTION 'diamond_spin_is_three_handed' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;
  -- The buy-in is the whole charge; no fee rides on top. The table's
  -- expectation is where the edge lives (E[m] = 3 x (1 - rake)).
  BEGIN
    v_total := (p_config->>'buyIn')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_total := NULL;
  END;
  IF v_total IS NULL OR v_total <> trunc(v_total) OR v_total < 1 OR v_total > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_buy_in := v_total::bigint;
  -- The stack is part of the contract the draw receipt carries; the chip
  -- seat-first door requires it, and so does this one.
  BEGIN
    v_chips := (p_config->>'startingStack')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_chips := NULL;
  END;
  IF v_chips IS NULL OR v_chips <> trunc(v_chips) OR v_chips < 1 OR v_chips > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023';
  END IF;
  v_blinds := p_config->'blindStructure';
  -- The multiplier table staff configured, or the published one (spin_tier_spec
  -- with the estate ladders), which is the approved chip table. Either is held
  -- to the same rule at this buy-in; none is invented here.
  v_tiers := p_config->'spinTiers';
  IF v_tiers IS NULL OR jsonb_typeof(v_tiers) = 'null' THEN
    SELECT jsonb_agg(jsonb_build_object('multiplier', s.multiplier, 'freq', s.freq,
                                        'reserveThresholdX', s.reserve_threshold_x) ORDER BY s.multiplier)
      INTO v_tiers FROM public.spin_tier_spec s;
  END IF;
  v_contract := public.fn_poker_diamond_spin_contract(v_buy_in, v_chips::integer, v_tiers, v_blinds);
  v_manifest := v_contract->'manifest';
  v_worst := (v_contract->>'worst_excess')::bigint;
  v_cover := (v_contract->>'required_cover')::bigint;

  -- The reserve: an authorized source, the cap it was authorized with, and a
  -- balance that covers the whole table now (the draw proves the cover again).
  SELECT * INTO v_source FROM public.poker_diamond_spin_reserve_source WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_spin_reserve_source_not_authorized' USING ERRCODE='55000';
  END IF;
  IF v_worst > v_source.max_underwrite_per_spin THEN
    RAISE EXCEPTION 'diamond_spin_reserve_over_its_authorized_cap: this table can ask the source for % Diamonds at a buy-in of %; % are authorized per Spin',
      v_worst, v_buy_in, v_source.max_underwrite_per_spin USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(h.balance, 0) INTO v_held FROM public.ca_diamond_house h WHERE h.id = 1;
  IF COALESCE(v_held, 0) < v_cover THEN
    RAISE EXCEPTION 'diamond_spin_reserve_cannot_cover_the_table: the source holds %, the table needs % at a buy-in of %',
      COALESCE(v_held, 0), v_cover, v_buy_in USING ERRCODE='55000';
  END IF;

  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Spin');
  BEGIN
    v_start := COALESCE((p_config->>'startTime')::timestamptz, now() + interval '1 minute');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_start_time' USING ERRCODE='22023';
  END;
  v_sb := (v_blinds->0->>'smallBlind')::numeric;
  v_bb := (v_blinds->0->>'bigBlind')::numeric;

  -- The listing, as the chip seat-first creator writes a Spin: three seats,
  -- no fee, no late registration, undrawn (no multiplier, no pool), and the
  -- smallest ladder until the draw stamps the drawn one.
  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    is_rebuy, is_reentry, add_on_available, free_buy, is_private, action_time_seconds)
  VALUES (
    p_arena, NULL, v_name, v_game, 'spin', 'SPIN',
    v_buy_in, 0, 0, v_chips::integer, 3, 3, 3,
    0, 'REGISTERING', v_blinds::text, '[{"place":1,"percentage":100}]', v_start,
    0, 0, false, false, false, 0,
    false, false, false, false, false, 15)
  RETURNING id INTO v_id;

  v_sha := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  INSERT INTO public.poker_diamond_spin_contracts
    (tournament_id, buy_in, starting_chips, rake_rate, rule_manifest, rule_sha256, worst_excess, required_cover, created_by)
  VALUES (v_id, v_buy_in, v_chips::integer, (v_manifest->>'rake_rate')::numeric, v_manifest, v_sha, v_worst, v_cover, v_actor);

  -- Its joinable table, in the same transaction, as the chip creator opens it.
  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status)
  VALUES (
    p_arena, v_id, v_name, 'tournament', lower(v_game), v_sb::text || '/' || v_bb::text,
    v_sb, v_bb, 0, 0, 3, 0, 'waiting')
  RETURNING id INTO v_table;

  -- The row this door wrote must be one the money path prices in Diamonds and
  -- the seat door sells as a Spin.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id)
     OR public.fn_ca_tournament_recorded_format(v_id) IS DISTINCT FROM 'spin-v1'
     OR NOT public.fn_ca_tournament_recorded_seat_first(v_id, false) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'table_id',v_table,
    'buy_in_amount',v_buy_in,'buy_in_fee',0,'total',v_buy_in,'bounty_amount',0,'is_mystery_bounty',false,
    'asset','diamonds','format','spin','rule_sha256',v_sha,'multiplier_table',v_manifest->'tiers',
    'max_multiplier',(SELECT max((x->>'multiplier')::numeric) FROM jsonb_array_elements(v_manifest->'tiers') x),
    'worst_excess',v_worst,'required_cover',v_cover);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_spin(jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '55c2176b75c5bb1499960f7bb846d3aa' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_arena uuid; v_id uuid;
  v_total bigint; v_fee bigint; v_buy_in bigint; v_ratio numeric;
  v_max integer; v_min integer; v_type text; v_variant text; v_game text;
  v_start timestamptz; v_payouts jsonb; v_blinds jsonb; v_pct numeric; v_chips integer;
  v_rebuy boolean; v_reentry boolean; v_addon boolean; v_rebuy_cost bigint; v_addon_cost bigint;
  v_rebuy_num numeric; v_addon_num numeric; v_name text;
  v_is_bounty boolean; v_bounty_num numeric; v_bounty bigint;
  v_mystery boolean; v_mb_activation text; v_mb_profile text; v_mb_value numeric; v_mb_top numeric;
  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_unlimited boolean;
  v_satellite boolean; v_target_text text; v_target_id uuid; v_target public.tournaments%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002'; END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;

  v_type := lower(COALESCE(p_config->>'type','mtt'));
  -- DIAMOND PHASE 9: A SPIN IS ADMITTED BY ITS OWN BRANCH, under the chip
  -- seat-first configuration door's rules (fn_poker_diamond_create_spin:
  -- three seats, no fee, a multiplier that is drawn and never configured, a
  -- multiplier table held to the draw authority's rules and to whole Diamonds
  -- at its buy-in). A Spin's configuration on any other format is refused.
  IF v_type = 'spin' THEN
    RETURN public.fn_poker_diamond_create_spin(p_config, v_arena);
  END IF;
  IF p_config ?| ARRAY['spinTiers','spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN
    RAISE EXCEPTION 'diamond_tournament_spin_requires_a_spin_format' USING ERRCODE='22023';
  END IF;
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty','satellite') THEN
    -- spin is admitted above, by fn_poker_diamond_create_spin.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- A satellite is a format, not a flag: its target rides on a 'satellite'
  -- event and on nothing else, and a satellite has exactly one target.
  v_satellite := v_type = 'satellite';
  v_target_text := NULLIF(btrim(COALESCE(p_config->>'satelliteTargetId','')),'');
  IF v_target_text IS NOT NULL AND NOT v_satellite THEN
    RAISE EXCEPTION 'diamond_tournament_target_requires_a_satellite_format' USING ERRCODE='22023';
  END IF;
  IF v_satellite THEN
    IF v_target_text IS NULL
       OR v_target_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'diamond_satellite_requires_a_target' USING ERRCODE='22023';
    END IF;
    v_target_id := v_target_text::uuid;
    -- ASSETS NEVER CROSS: a Diamond satellite seats a Diamond target only.
    IF NOT public.fn_poker_diamond_tournament(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_must_be_a_diamond_tournament' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_cannot_take_a_satellite' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_target FROM public.tournaments t WHERE t.id=v_target_id;
    IF upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR COALESCE(v_target.prize_pool_finalized,false) THEN
      RAISE EXCEPTION 'diamond_satellite_target_is_not_open' USING ERRCODE='55000';
    END IF;
    -- A seat count promised in advance is a guarantee: reserved to the owner.
    IF COALESCE(NULLIF(p_config->>'satelliteSeats','')::numeric,0)<>0 THEN
      RAISE EXCEPTION 'diamond_satellite_seat_guarantee_not_open' USING ERRCODE='55000';
    END IF;
    -- The chip scheduled satellite is a freezeout; so is this one.
    IF COALESCE((p_config->>'rebuy')::boolean,false) OR COALESCE((p_config->>'reentry')::boolean,false)
       OR COALESCE((p_config->>'addOn')::boolean,false) THEN
      RAISE EXCEPTION 'diamond_satellite_is_a_freezeout' USING ERRCODE='22023';
    END IF;
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty', 'progressive_bounty' or 'mystery_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty','mystery_bounty');
  v_mystery := v_type = 'mystery_bounty';
  v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((p_config->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  IF NOT v_mystery AND (p_config ? 'mysteryBountyMin' OR p_config ? 'mysteryBountyMax' OR p_config ? 'mysteryBounty') THEN
    RAISE EXCEPTION 'diamond_tournament_mystery_requires_a_mystery_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric,0);
  IF (p_config->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<1 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END));
  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;
  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);
  IF NOT v_unlimited AND v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;
  v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100;
  v_buy_in := v_total - v_fee;
  IF v_buy_in<1 THEN RAISE EXCEPTION 'diamond_tournament_buy_in_below_one_diamond' USING ERRCODE='22023'; END IF;
  -- The chip door's bounty rule at the Diamond unit: a whole bounty of at
  -- least one Diamond, no larger than the buy-in after the fee (the prize
  -- part is what remains; it may be zero, as the chip split allows).
  IF v_is_bounty THEN
    IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_whole_bounty_within_the_buy_in' USING ERRCODE='22023';
    END IF;
    v_bounty := v_bounty_num;
  ELSE
    v_bounty := 0;
  END IF;
  -- The mystery rules are the chip configuration door's rules
  -- (fn_apply_mystery_bounty_config), stamped here because that door consults
  -- a club owner the arena does not have. The lobby's advertised range is the
  -- chip door's multipliers on the flat bounty, in whole Diamonds.
  IF v_mystery THEN
    v_mb_activation := COALESCE(p_config->'mysteryBounty'->>'activation', 'at_the_money');
    IF v_mb_activation NOT IN ('at_the_money','percent_field','player_count') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_activation_mode' USING ERRCODE='22023';
    END IF;
    v_mb_profile := COALESCE(p_config->'mysteryBounty'->>'profile', 'classic');
    IF v_mb_profile NOT IN ('balanced','classic','jackpot') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_profile' USING ERRCODE='22023';
    END IF;
    v_mb_value := (p_config->'mysteryBounty'->>'activationValue')::numeric;
    IF v_mb_activation = 'percent_field' AND (COALESCE(v_mb_value,0) <= 0 OR v_mb_value > 100) THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    IF v_mb_activation = 'player_count' AND COALESCE(v_mb_value,0) < 2 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_count_too_small' USING ERRCODE='22023';
    END IF;
    v_mb_top := COALESCE((p_config->'mysteryBounty'->>'topPercent')::numeric, 20);
    IF v_mb_top <= 0 OR v_mb_top > 100 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_top_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    v_mb_pool := COALESCE((p_config->'mysteryBounty'->>'poolPercent')::numeric, 50);
    v_mb_regular := COALESCE((p_config->'mysteryBounty'->>'regularPoolPercent')::numeric, 100 - v_mb_pool);
    IF v_mb_pool < 0 OR v_mb_regular < 0 OR v_mb_pool + v_mb_regular <= 0 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_pool_split_invalid' USING ERRCODE='22023';
    END IF;
    v_mb_min_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMin','')::numeric, 0.5);
    v_mb_max_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMax','')::numeric, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_range_invalid' USING ERRCODE='22023';
    END IF;
  END IF;

  v_chips := COALESCE((p_config->>'startingStack')::int, 10000);
  IF v_chips<1 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023'; END IF;
  v_blinds := COALESCE(p_config->'blindStructure','[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure','[]'::jsonb);
  IF jsonb_typeof(v_blinds)<>'array' OR jsonb_array_length(v_blinds)=0 THEN
    RAISE EXCEPTION 'blind_structure_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_payouts)<>'array' OR jsonb_array_length(v_payouts)=0 THEN
    RAISE EXCEPTION 'payout_structure_required' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((e->>'percentage')::numeric),0) INTO v_pct FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct-100)>1 THEN RAISE EXCEPTION 'payouts_must_total_100' USING ERRCODE='22023'; END IF;
  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
  -- A satellite plays before its target, as the chip scheduled satellite does.
  IF v_satellite AND (v_target.start_time IS NULL OR v_start >= v_target.start_time) THEN
    RAISE EXCEPTION 'diamond_satellite_must_start_before_its_target' USING ERRCODE='22023';
  END IF;
  v_rebuy := COALESCE((p_config->>'rebuy')::boolean,false);
  v_reentry := COALESCE((p_config->>'reentry')::boolean,v_rebuy);
  v_addon := COALESCE((p_config->>'addOn')::boolean,false);
  v_rebuy_num := COALESCE((p_config->>'rebuyCost')::numeric, v_total);
  v_addon_num := COALESCE((p_config->>'addonCost')::numeric, v_total);
  IF (v_rebuy OR v_reentry) AND (v_rebuy_num <> trunc(v_rebuy_num) OR v_rebuy_num < 1 OR v_rebuy_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_rebuy_cost' USING ERRCODE='22023';
  END IF;
  IF v_addon AND (v_addon_num <> trunc(v_addon_num) OR v_addon_num < 1 OR v_addon_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_addon_cost' USING ERRCODE='22023';
  END IF;
  v_rebuy_cost := v_rebuy_num; v_addon_cost := v_addon_num;
  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Tournament');
  v_variant := CASE v_type WHEN 'sng' THEN 'sng' WHEN 'bounty' THEN 'bounty'
                           WHEN 'progressive_bounty' THEN 'progressive_bounty'
                           WHEN 'mystery_bounty' THEN 'mystery_bounty'
                           WHEN 'satellite' THEN 'satellite' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,
    mystery_bounty_top_percent, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds,
    satellite_target_id, satellite_seats)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant,
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    CASE WHEN v_satellite THEN 0 ELSE COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END) END,
    CASE WHEN v_satellite THEN 0 ELSE 8 END,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,
    CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,
    CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15,
    CASE WHEN v_satellite THEN v_target_id END, CASE WHEN v_satellite THEN 0 END)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE BANKS CARRY THE RESERVE LEGS
-- ---------------------------------------------------------------------------
-- 6a. The escrow reads the legs into the prize bank, so every Diamond door's
--     "the banks equal the custody" holds across a drawn Spin.
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_escrow(uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '850410a45ed7eefe785d3f17a2403247' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_escrow is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
      -- DIAMOND PHASE 9: a Spin's reserve legs move its prize bank, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, 0::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in + spin_underwrite - spin_surplus - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) TO service_role;

-- 6b. The chip-facing router keeps the chip shadow convention: its
--     prize_balance leaves the reserve legs out, because the escrow row
--     carries them as reserve_in / reserve_out and fn_ca_escrow_balance_drift
--     adds them back (it would otherwise count them twice).
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_ca_tournament_escrow(uuid)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '707b4cbeb6f4906c2216cefea6635ca8' THEN
    RAISE EXCEPTION 'fn_ca_tournament_escrow is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  SELECT * FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)\n   WHERE public.fn_poker_diamond_tournament(p_tournament_id)\n';
  v_new1 := E'  -- DIAMOND PHASE 9: the chip shadow convention - prize_balance without a\n  -- Spin''s reserve legs, which the escrow row carries as reserve_in and\n  -- reserve_out and fn_ca_escrow_balance_drift adds back.\n  SELECT e.prize_in, e.bounty_in, e.fee_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out,\n         e.fee_out, e.refund_out, e.prize_balance - r.spin_underwrite + r.spin_surplus,\n         e.bounty_balance, e.fee_balance\n    FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e\n   CROSS JOIN LATERAL (\n     SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = ''spin_underwrite''), 0)::numeric AS spin_underwrite,\n            COALESCE(sum(l.amount) FILTER (WHERE l.kind = ''spin_surplus''), 0)::numeric AS spin_surplus\n       FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id = p_tournament_id) r\n   WHERE public.fn_poker_diamond_tournament(p_tournament_id)\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_ca_tournament_escrow: the Diamond branch (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> '707b4cbeb6f4906c2216cefea6635ca8' THEN
    RAISE EXCEPTION 'fn_ca_tournament_escrow: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tournament_escrow', 'migration a_diamond_spin_draws_a_whole_prize');

-- 6c. The shadow opens with the legs as the chip escrow names them.
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_open_shadow(uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '15beba292789e7f1e665c7caa9530304' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_open_shadow is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l record; v_x record;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
    COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
    COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
    COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
    COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
    COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
    -- DIAMOND PHASE 9: a Spin's reserve legs, the chip escrow's reserve_in and reserve_out.
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus
    INTO l
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  INSERT INTO public.tournament_escrow
    (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
     prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
     prize_balance, bounty_balance, fee_balance, opened_from)
  VALUES
    (p_tournament_id, true, l.prize_in + l.bounty_in + l.fee_in, l.fee_in, 0, l.bounty_in, 0, 0,
     l.prize_out, l.bounty_out, l.fee_out, l.refund_prize, l.refund_bounty, l.refund_fee, l.spin_surplus, l.spin_underwrite,
     l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite, l.bounty_in - l.bounty_out - l.refund_bounty,
     l.fee_in - l.fee_out - l.refund_fee, 'diamond terminal shadow (from the Diamond ledger)')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT x.* INTO v_x FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id;
  IF v_x.prize_balance IS DISTINCT FROM (l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite)::numeric
     OR v_x.reserve_in IS DISTINCT FROM l.spin_underwrite::numeric
     OR v_x.reserve_out IS DISTINCT FROM l.spin_surplus::numeric
     OR v_x.bounty_balance IS DISTINCT FROM (l.bounty_in - l.bounty_out - l.refund_bounty)::numeric
     OR v_x.fee_balance IS DISTINCT FROM (l.fee_in - l.fee_out - l.refund_fee)::numeric
     OR v_x.prize_balance + v_x.bounty_balance + v_x.fee_balance
        IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'tournament % escrow shadow disagrees with its Diamond banks', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'prize_balance',v_x.prize_balance,'bounty_balance',v_x.bounty_balance,'fee_balance',v_x.fee_balance);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_open_shadow(uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_open_shadow', 'migration a_diamond_spin_draws_a_whole_prize');

-- 6d. The drain holds an underwritten share as prize, and names a surplus.
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'abaf068c32e192f08a1c01c02b089523' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_drain is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
BEGIN
  IF p_tournament_id IS NULL OR p_bank NOT IN ('prize','fee','bounty') OR p_amount IS NULL OR p_amount < 1 OR p_reason IS NULL
     OR p_destination_account IS NULL OR length(btrim(p_destination_account))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_drain' USING ERRCODE='22023';
  END IF;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  SELECT t.name INTO v_name FROM public.tournaments t WHERE t.id=p_tournament_id;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
  FOR v_c IN
    SELECT c.id, c.user_id, c.balance, c.arena_id,
           (SELECT COALESCE(sum(CASE WHEN p_bank='prize' THEN l.prize_part
                                     WHEN p_bank='bounty' THEN l.bounty_part
                                     ELSE l.fee_part END),0)
              FROM public.poker_diamond_tournament_ledger l
             WHERE l.custody_id=c.id AND l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite'))
         - (SELECT COALESCE(sum(m.amount),0) FROM public.poker_diamond_movements m
             WHERE m.custody_id=c.id AND m.action='release'
               AND m.request->>'action'='tournament_drain' AND m.request->>'bank'=p_bank) AS held
      FROM public.poker_diamond_custody c
     WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance > 0
     ORDER BY c.created_at, c.id
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN v_c.held <= 0;
    v_take := LEAST(v_left, v_c.held, v_c.balance);
    -- The lots this row holds are consumed for what leaves it, oldest first,
    -- exactly as fn_poker_diamond_settle_cash_hand consumes a lost stack.
    v_loss := v_take;
    FOR v_lot IN
      SELECT l.id, r.amount-r.consumed AS held, greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
        FROM public.poker_diamond_lot_reservations r
        JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
       WHERE r.custody_id=v_c.id AND r.released_at IS NULL
       ORDER BY l.created_at, l.id FOR UPDATE OF l, r
    LOOP
      EXIT WHEN v_loss = 0;
      IF v_lot.held > 0 THEN
        UPDATE public.diamond_purchase_lots
           SET arena_reserved=arena_reserved-LEAST(v_loss,v_lot.held),
               consumed=consumed+LEAST(LEAST(v_loss,v_lot.held),v_lot.outstanding)::integer
         WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations SET consumed=consumed+LEAST(v_loss,v_lot.held)
         WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss - LEAST(v_loss,v_lot.held);
      END IF;
    END LOOP;
    -- The journal row the movement carries: the recipient's credit for a
    -- prize or a bounty; for a fee, this player's own spend, which the
    -- register retires.
    IF p_journal_for IS NOT NULL THEN
      v_journal := p_journal_for;
    ELSE
      SELECT COALESCE(diamonds,0) INTO v_wallet FROM public.profiles WHERE id=v_c.user_id;
      INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
        reference_id,description,source,issuance_class,counterparty,metadata)
      -- DIAMOND PHASE 9: only a Spin's surplus leaves the prize bank for the
      -- house; it is named as what it is, not as a fee.
      VALUES (v_c.user_id,
        CASE WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,
        CASE WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,-v_take::integer,v_wallet,
        p_reason||':'||v_c.id::text,
        CASE WHEN p_bank='prize'
             THEN 'Diamond Spin surplus: '||COALESCE(v_name,'spin')||' drew a prize pool below its entries (from custody to the house)'
             ELSE 'Tournament entry fee: '||COALESCE(v_name,'tournament')||' (from custody to the house)' END,
        'poker_arena','spend','house',
        jsonb_build_object('custody_id',v_c.id,'tournament_id',p_tournament_id,'reason',p_reason,'destination','house'))
      RETURNING id INTO v_journal;
    END IF;
    -- The movement first, then the balance: P0814 (an entry holds exactly its
    -- movements) is checked at the end of this UPDATE, not at commit, because
    -- a row drained twice in one settlement (the fee, then a prize) would
    -- otherwise present its first version against the final movement sum.
    v_req := uuid_in(md5(p_reason||':'||v_c.id::text)::cstring);
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
      source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (v_req,v_c.id,v_c.user_id,'release',v_take,'arena_custody:'||v_c.id,p_destination_account,v_journal,
      jsonb_build_object('action','tournament_drain','bank',p_bank,'reason',p_reason,'custody_id',v_c.id,'amount',v_take),
      jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,'custody_balance',v_c.balance-v_take,'journal_id',v_journal));
    UPDATE public.poker_diamond_custody SET balance=balance-v_take WHERE id=v_c.id;
    v_drained := v_drained || jsonb_build_object('custody_id',v_c.id,'user_id',v_c.user_id,'amount',v_take,'journal_id',v_journal,'request_id',v_req);
    v_left := v_left - v_take;
  END LOOP;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  RETURN v_drained;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_drain', 'migration a_diamond_spin_draws_a_whole_prize');

-- ---------------------------------------------------------------------------
-- 7. THE DRAW: ONE AUTHORITY, ONE ROLL, ONE RECEIPT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_t public.tournaments%ROWTYPE;
  v_k public.poker_diamond_spin_contracts%ROWTYPE;
  v_source public.poker_diamond_spin_reserve_source%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_p record; v_e record; v_x record; v_d jsonb; v_tier jsonb;
  v_entrants jsonb; v_count bigint; v_distinct bigint; v_rows_held bigint;
  v_b bigint; v_collected bigint; v_worst bigint; v_cover bigint;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0; v_pick numeric; v_tiers integer;
  v_cents numeric; v_prize bigint; v_residue numeric; v_underwrite bigint := 0; v_surplus bigint := 0;
  v_held_before numeric; v_held_after numeric; v_supply numeric;
  v_share bigint; v_rest bigint; v_take bigint; v_i integer := 0; v_wallet bigint; v_journal uuid; v_req uuid;
  v_journals uuid[] := ARRAY[]::uuid[]; v_registered numeric; v_legs jsonb := '[]'::jsonb; v_drained jsonb;
  v_blinds jsonb; v_payouts jsonb; v_manifest jsonb; v_hash text; v_receipt jsonb; v_stamped integer;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  -- fn_spin_draw_and_settle_atomic proved the lease, the incomplete launch
  -- receipt of this launch and the maintenance freeze, and holds the receipt
  -- and the parent; this arm is reached from there and from nowhere else.
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN'
     OR v_t.max_players IS DISTINCT FROM 3 OR v_t.format_contract IS DISTINCT FROM 'spin-v1'
     OR COALESCE(v_t.buy_in_amount, 0) < 1 OR v_t.buy_in_amount <> trunc(v_t.buy_in_amount)
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 OR COALESCE(v_t.bounty_amount, 0) <> 0
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;
  v_b := v_t.buy_in_amount::bigint;
  v_collected := 3 * v_b;
  SELECT * INTO v_k FROM public.poker_diamond_spin_contracts k WHERE k.tournament_id = p_tournament_id;
  IF NOT FOUND OR v_k.buy_in IS DISTINCT FROM v_b OR v_k.starting_chips IS DISTINCT FROM v_t.starting_chips
     OR v_k.rule_sha256 IS DISTINCT FROM encode(extensions.digest(v_k.rule_manifest::text, 'sha256'), 'hex') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_contract_missing');
  END IF;

  -- The field: three distinct identities, read in the chip authority's order.
  SELECT count(*), count(DISTINCT p.user_id),
         jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_distinct, v_entrants
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id AND p.status IN ('registered', 'playing');
  IF v_count <> 3 OR v_distinct <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- A committed result is the answer: a new owner or a newer binary cannot
  -- reroll it or rewrite it, and nothing moves twice.
  SELECT * INTO v_saved FROM public.spin_draw_receipts r WHERE r.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  -- Each of the three holds exactly one whole entry of the buy-in, active, in
  -- its own custody, and the event has moved nothing but entries and refunds.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id = p_tournament_id AND l.kind NOT IN ('entry', 'refund')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
  END IF;
  FOR v_p IN SELECT p.id, p.user_id FROM public.tournament_players p
              WHERE p.tournament_id = p_tournament_id AND p.status IN ('registered', 'playing')
              ORDER BY p.user_id, p.id LOOP
    SELECT count(*) INTO v_rows_held FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released';
    IF v_rows_held <> 1 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
    SELECT c.* INTO v_c FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released'
     FOR UPDATE;
    IF v_c.state IS DISTINCT FROM 'active' OR v_c.balance IS DISTINCT FROM v_b
       OR v_c.entry_key IS DISTINCT FROM 'entry:' || v_p.id::text
       OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id = v_c.id) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                       WHERE l.custody_id = v_c.id AND l.kind = 'entry' AND l.user_id = v_p.user_id
                         AND l.registration_id = v_p.id AND l.amount = v_b AND l.prize_part = v_b
                         AND l.bounty_part = 0 AND l.fee_part = 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_collected::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_collected THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;

  -- The reserve: the authorized source, the cap it was authorized with, and a
  -- balance that covers the whole pinned table. All or nothing: a Diamond Spin
  -- never draws from a table with tiers locked out, so what was advertised is
  -- what is drawn from. Nothing has moved yet, so each refusal is an answer.
  SELECT * INTO v_source FROM public.poker_diamond_spin_reserve_source WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_source_not_authorized');
  END IF;
  v_worst := v_k.worst_excess;
  v_cover := v_k.required_cover;
  IF v_worst > v_source.max_underwrite_per_spin THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_over_its_authorized_cap',
      'worst_excess', v_worst, 'max_underwrite_per_spin', v_source.max_underwrite_per_spin);
  END IF;
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(h.balance, 0) INTO v_held_before FROM public.ca_diamond_house h WHERE h.id = 1 FOR UPDATE;
  IF COALESCE(v_held_before, 0) < v_cover THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_cannot_cover_the_table',
      'required_cover', v_cover, 'source_balance', COALESCE(v_held_before, 0));
  END IF;

  -- THE DRAW: one roll of the database's own cryptographic generator over the
  -- pinned table, the arithmetic fn_spin_draw_multiplier rolls with. The
  -- engine's compiled manifest is not an input.
  SELECT COALESCE(sum((t.value->>'freq')::numeric), 0), count(*)
    INTO v_total, v_tiers FROM jsonb_array_elements(v_k.rule_manifest->'tiers') t;
  v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;
  FOR v_x IN SELECT t.value, t.ordinality FROM jsonb_array_elements(v_k.rule_manifest->'tiers') WITH ORDINALITY t
              ORDER BY t.ordinality LOOP
    v_acc := v_acc + (v_x.value->>'freq')::numeric;
    IF v_roll < v_acc THEN v_pick := (v_x.value->>'multiplier')::numeric; v_tier := v_x.value; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_tier := v_k.rule_manifest->'tiers'->(jsonb_array_length(v_k.rule_manifest->'tiers') - 1);
    v_pick := (v_tier->>'multiplier')::numeric;
  END IF;

  -- THE POOL AT THE UNIT: the multiplier times the buy-in floored to a whole
  -- Diamond, and every leg below is computed from that floored pool, so a
  -- residue could only ever stay with the source. The contract admitted only
  -- tables with none; it is proved here before anything moves.
  v_cents := v_pick * v_b * 100;
  v_prize := public.fn_ca_unit_floor_cents(trunc(v_cents)::bigint, 100) / 100;
  v_residue := v_cents - v_prize * 100;
  IF v_residue <> 0 OR v_prize < 1 THEN
    RAISE EXCEPTION 'diamond_spin_prize_not_whole_at_the_unit: %x at % Diamonds leaves % cents', v_pick, v_b, v_residue
      USING ERRCODE='P0404';
  END IF;

  IF v_prize > v_collected THEN
    -- THE SOURCE UNDERWRITES the pool above the three entries, into the
    -- event's custody before it may launch: a house burn on the register, and
    -- a player-side register mint for each custody share it lands in, split
    -- as evenly as whole Diamonds allow (the remainder to the earliest entries).
    v_underwrite := v_prize - v_collected;
    UPDATE public.ca_diamond_house SET balance = balance - v_underwrite, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-underwrite:' || p_tournament_id::text, 'burn', 'diamonds', 'house', c_house, 'the house',
       v_underwrite, v_held_before, v_held_after, v_supply - v_underwrite,
       'Diamond Spin prize pool underwritten from the house into the event custody ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_underwrite)');
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    v_share := v_underwrite / 3;
    v_rest := v_underwrite % 3;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
                WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active'
                ORDER BY c.created_at, c.id FOR UPDATE LOOP
      v_i := v_i + 1;
      v_take := v_share + CASE WHEN v_i <= v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take = 0;
      SELECT COALESCE(pr.diamonds, 0) INTO v_wallet FROM public.profiles pr WHERE pr.id = v_c.user_id;
      -- The wallet does not move (balance_after is the wallet as it stands):
      -- the share lands in custody and is paid out only as a prize. Class
      -- 'arena': the register follows it, the earn ledger does not (a prize
      -- pool is not a reward any daily cap may shorten).
      INSERT INTO public.diamond_transactions(user_id, type, transaction_type, amount, balance_after, reference_id,
        description, source, issuance_class, counterparty, metadata)
      VALUES (v_c.user_id, 'arena_spin_underwrite', 'arena_spin_underwrite', v_take::integer, v_wallet,
        'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text,
        'Diamond Spin prize pool: ' || COALESCE(v_t.name, 'spin') || ' drew ' || v_pick
          || 'x; the house underwrote this share into the entry custody (paid out as prizes, never spendable)',
        'poker_arena', 'arena', 'house',
        jsonb_build_object('custody_id', v_c.id, 'tournament_id', p_tournament_id, 'source', 'house',
                           'destination', 'custody', 'multiplier', v_pick))
      RETURNING id INTO v_journal;
      v_journals := v_journals || v_journal;
      v_req := uuid_in(md5('poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text)::cstring);
      -- The movement first, then the balance (P0814 is checked at the update).
      INSERT INTO public.poker_diamond_movements(request_id, custody_id, user_id, action, amount,
        source_account, destination_account, wallet_journal_id, request, receipt)
      VALUES (v_req, v_c.id, v_c.user_id, 'reserve', v_take, 'house:' || c_house::text, 'arena_custody:' || v_c.id::text,
        v_journal,
        jsonb_build_object('action', 'spin_underwrite', 'bank', 'prize', 'tournament_id', p_tournament_id,
                           'custody_id', v_c.id, 'amount', v_take),
        jsonb_build_object('success', true, 'custody_id', v_c.id, 'amount', v_take,
                           'custody_balance', v_c.balance + v_take, 'journal_id', v_journal));
      UPDATE public.poker_diamond_custody SET balance = balance + v_take WHERE id = v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, v_c.user_id, v_c.id, 'spin_underwrite', v_take, v_take, 0, 0,
        'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text, v_journal,
        jsonb_build_object('kind', 'spin_underwrite', 'multiplier', v_pick, 'source', 'house', 'request_id', v_req));
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('custody_id', v_c.id, 'user_id', v_c.user_id,
                  'amount', v_take, 'journal_id', v_journal, 'leg', 'spin_underwrite'));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'mint' AND m.holder_type = 'player'
       AND m.diamond_tx_id = ANY (v_journals);
    IF v_registered IS DISTINCT FROM v_underwrite::numeric THEN
      RAISE EXCEPTION 'diamond_spin_underwrite_not_registered_to_players (% of %)', v_registered, v_underwrite
        USING ERRCODE='P0404';
    END IF;
  ELSIF v_prize < v_collected THEN
    -- THE SURPLUS RETURNS to the source: the entries above the pool leave the
    -- prize bank through the drain (each player's share journaled as that
    -- player's spend, which the register retires) and the house is minted
    -- exactly that, as the Phase 8 fee settlement banks a fee.
    v_surplus := v_collected - v_prize;
    v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'prize', v_surplus,
                   'poker-spin-surplus:' || p_tournament_id::text, 'house', NULL);
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'burn' AND m.holder_type = 'player'
       AND m.diamond_tx_id IN (SELECT (d->>'journal_id')::uuid FROM jsonb_array_elements(v_drained) d);
    IF v_registered IS DISTINCT FROM v_surplus::numeric THEN
      RAISE EXCEPTION 'diamond_spin_surplus_not_retired_from_players (% of %)', v_registered, v_surplus
        USING ERRCODE='P0404';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance + v_surplus, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-surplus:' || p_tournament_id::text, 'mint', 'diamonds', 'house', c_house, 'the house',
       v_surplus, v_held_before, v_held_after, v_supply + v_surplus,
       'Diamond Spin entries above the drawn prize pool returned from the event custody to the house ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_surplus)');
    FOR v_d IN SELECT d.value FROM jsonb_array_elements(v_drained) d LOOP
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, (v_d->>'user_id')::uuid, (v_d->>'custody_id')::uuid, 'spin_surplus',
        (v_d->>'amount')::bigint, (v_d->>'amount')::bigint, 0, 0,
        'poker-spin-surplus:' || p_tournament_id::text || ':' || (v_d->>'custody_id'), (v_d->>'journal_id')::uuid,
        jsonb_build_object('kind', 'spin_surplus', 'multiplier', v_pick, 'destination', 'house',
                           'request_id', v_d->>'request_id'));
      v_legs := v_legs || jsonb_build_array(v_d || jsonb_build_object('leg', 'spin_surplus'));
    END LOOP;
  ELSE
    v_held_after := v_held_before;
  END IF;

  -- The banks and the custody agree, at the drawn pool, whole.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_prize::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  -- An escrow shadow already open follows the legs, as a chip draw's does.
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond spin reserve',
      p_reserve_out => v_surplus, p_reserve_in => v_underwrite);
  END IF;

  -- THE RECEIPT, in the chip receipt's shape (the engine reads both with one
  -- reader, readFundedSpinDraw), frozen with the code that drew it.
  v_blinds := v_tier->'blind_structure';
  v_payouts := v_tier->'payout_structure';
  v_manifest := v_k.rule_manifest || jsonb_build_object(
    'contract_sha256', v_k.rule_sha256,
    'draw_function_md5', md5(pg_get_functiondef('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'::regprocedure)));
  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'ok', true, 'replay', false, 'asset', 'diamonds', 'unit_cents', 100,
    'money_path', 'fn_poker_diamond_spin_draw',
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_pick, 'prize_pool', v_prize, 'buy_in', v_b, 'starting_chips', v_t.starting_chips,
    'blind_structure', v_blinds, 'payout_structure', v_payouts, 'locked', '[]'::jsonb, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', 'at_draw',
    'collected', v_collected, 'house_rake', 0, 'underwrite', v_underwrite, 'surplus', v_surplus, 'residue', 0,
    'pool_covered', v_prize, 'operator_shortfall', 0, 'custody_legs', v_legs,
    'reserve_source', v_source.source_account,
    'source_balance_before', v_held_before, 'source_balance_after', v_held_after,
    'draw_inputs', jsonb_build_object('roll', v_roll, 'total_freq', v_total, 'eligible_count', v_tiers,
      'required_cover', v_cover, 'worst_excess', v_worst,
      'max_underwrite_per_spin', v_source.max_underwrite_per_spin, 'reserve_ruling', v_source.ruling));
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);

  -- The tournament row is the contract the engine, the ladder trigger and the
  -- launch proof read back, stamped in this transaction and read back exactly.
  UPDATE public.tournaments
     SET spin_multiplier   = v_pick,
         prize_pool        = v_prize,
         spin_locked_tiers = '[]'::jsonb,
         blind_structure   = v_blinds::text,
         payout_structure  = v_payouts::text
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  IF v_stamped <> 1 OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = p_tournament_id
          AND t.spin_multiplier IS NOT DISTINCT FROM v_pick
          AND t.prize_pool IS NOT DISTINCT FROM v_prize::numeric
          AND t.spin_locked_tiers IS NOT DISTINCT FROM '[]'::jsonb) THEN
    RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN v_receipt;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw_proof(p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_r public.spin_draw_receipts%ROWTYPE; v_t record; v_e record;
  v_m numeric; v_p numeric; v_b numeric; v_u numeric; v_s numeric; v_lu numeric; v_ls numeric;
  v_hu numeric; v_hs numeric;
BEGIN
  IF p_tournament_id IS NULL OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_asset_required');
  END IF;
  SELECT * INTO v_r FROM public.spin_draw_receipts r WHERE r.tournament_id = p_tournament_id;
  IF NOT FOUND OR (p_launch_id IS NOT NULL AND v_r.launch_id IS DISTINCT FROM p_launch_id)
     OR v_r.receipt->>'money_path' IS DISTINCT FROM 'fn_poker_diamond_spin_draw'
     OR v_r.receipt->>'asset' IS DISTINCT FROM 'diamonds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_draw_unproven');
  END IF;
  SELECT t.spin_multiplier, t.prize_pool, t.buy_in_amount INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  v_m := (v_r.receipt->>'multiplier')::numeric;
  v_p := (v_r.receipt->>'prize_pool')::numeric;
  v_b := (v_r.receipt->>'buy_in')::numeric;
  v_u := (v_r.receipt->>'underwrite')::numeric;
  v_s := (v_r.receipt->>'surplus')::numeric;
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'spin_underwrite'), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'spin_surplus'), 0)
    INTO v_lu, v_ls FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id = p_tournament_id;
  SELECT COALESCE(sum(m.amount), 0) INTO v_hu FROM public.ca_mint_ledger m
   WHERE m.op_id = 'poker-spin-underwrite:' || p_tournament_id::text AND m.action = 'burn' AND m.holder_type = 'house';
  SELECT COALESCE(sum(m.amount), 0) INTO v_hs FROM public.ca_mint_ledger m
   WHERE m.op_id = 'poker-spin-surplus:' || p_tournament_id::text AND m.action = 'mint' AND m.holder_type = 'house';
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_t.spin_multiplier IS DISTINCT FROM v_m OR v_t.prize_pool IS DISTINCT FROM v_p
     OR v_t.buy_in_amount IS DISTINCT FROM v_b
     OR v_p IS DISTINCT FROM v_b * v_m OR v_p <> trunc(v_p) OR v_p < 1
     OR v_p IS DISTINCT FROM 3 * v_b + v_u - v_s OR (v_u > 0 AND v_s > 0) OR v_u < 0 OR v_s < 0
     OR v_lu IS DISTINCT FROM v_u OR v_ls IS DISTINCT FROM v_s
     OR v_hu IS DISTINCT FROM v_u OR v_hs IS DISTINCT FROM v_s
     OR v_e.prize_balance + v_e.prize_out IS DISTINCT FROM v_p THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_draw_unproven',
      'multiplier', v_m, 'prize_pool', v_p, 'underwrite', v_u, 'surplus', v_s);
  END IF;
  RETURN jsonb_build_object('ok', true, 'multiplier', v_m, 'prize_pool', v_p, 'underwrite', v_u,
    'surplus', v_s, 'launch_id', v_r.launch_id, 'rule_sha256', v_r.rule_sha256);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw_proof(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_spin_draw_proof(uuid, uuid) TO service_role;

-- 7b. The one authority routes a Diamond Spin to its arm, after proving the
--     lease, the launch receipt and the freeze exactly as it does for chips.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '19e06d2d13a5f53cd7c59686802dae4a' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle_atomic is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF public.fn_entry_purchases_frozen() THEN\n    RETURN jsonb_build_object(''ok'', false, ''reason'', ''entry_purchases_frozen'');\n  END IF;\n';
  v_new1 := E'  IF public.fn_entry_purchases_frozen() THEN\n    RETURN jsonb_build_object(''ok'', false, ''reason'', ''entry_purchases_frozen'');\n  END IF;\n  -- DIAMOND PHASE 9: A DIAMOND SPIN IS DRAWN BY ITS OWN ARM OF THIS ONE\n  -- AUTHORITY. The lease, the launch receipt and the freeze above are this\n  -- authority''s and are proved for both assets. Past this line the chip\n  -- proofs read wallet rows, an owner''s reserve pool and the engine''s\n  -- manifest, none of which a Diamond Spin has: its arm proves three whole\n  -- entries in custody, draws from the table its creation pinned, moves the\n  -- reserve legs against the authorized source in whole Diamonds and writes\n  -- the same immutable receipt and stamp, in this transaction.\n  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n    RETURN public.fn_poker_diamond_spin_draw(p_tournament_id, p_launch_id, p_lease_generation);\n  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_draw_and_settle_atomic: the freeze answer (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> '19e06d2d13a5f53cd7c59686802dae4a' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle_atomic: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 8. NO CHIP RESERVE TOUCHES A DIAMOND SPIN
-- ---------------------------------------------------------------------------
-- The retired chip draw and the chip settle are still service-role callable.
-- Each refuses a Diamond Spin by name, so the one authority above is the only
-- way a Diamond Spin is drawn and no chip reserve pool, rake record or chip
-- journal is ever written for one. The chip entry booking needs no edit: it
-- proves three chip wallet debits, which a Diamond entry never writes.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '366a1981c2ea9f0f54b41fe50a5d19b4' THEN
    RAISE EXCEPTION 'fn_spin_settle_game is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'BEGIN\n  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN\n';
  v_new1 := E'BEGIN\n  -- DIAMOND PHASE 9: a Diamond Spin is settled by its own arm of\n  -- fn_spin_draw_and_settle_atomic against its authorized source; never\n  -- through a chip reserve pool.\n  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n    RAISE EXCEPTION ''diamond_spin_is_drawn_by_its_own_authority'' USING ERRCODE = ''55000'';\n  END IF;\n  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_settle_game: the input check (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> '366a1981c2ea9f0f54b41fe50a5d19b4' THEN
    RAISE EXCEPTION 'fn_spin_settle_game: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_spin_draw_and_settle(uuid,jsonb)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'f1f01a7719faac3b426e6358a37c5873' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF p_tournament_id IS NULL THEN\n    RAISE EXCEPTION ''Spin draw-and-settle requires a tournament''\n      USING ERRCODE = ''22023'';\n  END IF;\n';
  v_new1 := E'  IF p_tournament_id IS NULL THEN\n    RAISE EXCEPTION ''Spin draw-and-settle requires a tournament''\n      USING ERRCODE = ''22023'';\n  END IF;\n  -- DIAMOND PHASE 9: a Diamond Spin is drawn by its own arm of\n  -- fn_spin_draw_and_settle_atomic, the one Spin draw authority; never here.\n  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n    RAISE EXCEPTION ''diamond_spin_is_drawn_by_its_own_authority'' USING ERRCODE = ''55000'';\n  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_draw_and_settle: the tournament check (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> 'f1f01a7719faac3b426e6358a37c5873' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- The unbooked sweep (unscheduled since 20260922155223, still callable) would
-- otherwise take a launched Diamond Spin - a multiplier on its row and no chip
-- reserve row - for a chip Spin that never booked.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
  v_old2 text; v_new2 text;
BEGIN
  v_oid := 'public.fn_spin_sweep_unbooked(integer,integer)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '2b5c7761a1a1ed132f90c66b5a228b7f' THEN
    RAISE EXCEPTION 'fn_spin_sweep_unbooked is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'      AND t.club_id IS NOT NULL\n      -- Did anybody actually enter?';
  v_new1 := E'      AND t.club_id IS NOT NULL\n      -- DIAMOND PHASE 9: a Diamond Spin books at its own draw, against its source.\n      AND NOT public.fn_poker_diamond_tournament(t.id)\n      -- Did anybody actually enter?';
  v_old2 := E'    AND t.club_id IS NOT NULL\n    AND EXISTS (SELECT 1 FROM public.tournament_players tp\n                 WHERE tp.tournament_id = t.id)';
  v_new2 := E'    AND t.club_id IS NOT NULL\n    AND NOT public.fn_poker_diamond_tournament(t.id)\n    AND EXISTS (SELECT 1 FROM public.tournament_players tp\n                 WHERE tp.tournament_id = t.id)';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_sweep_unbooked: the chip-Spin candidate clause (1) occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_sweep_unbooked: the chip-Spin candidate clause (2) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new2, v_old2), v_new1, v_old1)) <> '2b5c7761a1a1ed132f90c66b5a228b7f' THEN
    RAISE EXCEPTION 'fn_spin_sweep_unbooked: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- The third paid seat books a chip Spin's entries into its owner's pool and
-- RAISES if it cannot; a Diamond Spin's entries are already whole in custody
-- and book at its draw, so without this its third seat could never be sold.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_sync_seat_first_player_count(uuid)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '0e4acaf0ff080d4dafd1aa85068cf0b2' THEN
    RAISE EXCEPTION 'fn_sync_seat_first_player_count is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN\n    v_book := public.fn_spin_book_entry(p_tournament_id);\n';
  v_new1 := E'  -- DIAMOND PHASE 9: a Diamond Spin''s three entries are already whole in\n  -- custody; its reserve legs are booked at its draw, against its source.\n  IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap\n     AND NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN\n    v_book := public.fn_spin_book_entry(p_tournament_id);\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_sync_seat_first_player_count: the third-seat booking (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> '0e4acaf0ff080d4dafd1aa85068cf0b2' THEN
    RAISE EXCEPTION 'fn_sync_seat_first_player_count: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 9. THE CONTRACT AND THE LAUNCH READ THE DIAMOND DRAW
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_spin_tournament_contract_is_draw()'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '747fc99476b082256141d42003a6c478' THEN
    RAISE EXCEPTION 'fn_spin_tournament_contract_is_draw is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF lower(COALESCE(NEW.variant,'''')) <> ''spin''\n     AND upper(COALESCE(NEW.tournament_type,'''')) <> ''SPIN'' THEN\n    RETURN NEW;\n  END IF;\n';
  v_new1 := E'  IF lower(COALESCE(NEW.variant,'''')) <> ''spin''\n     AND upper(COALESCE(NEW.tournament_type,'''')) <> ''SPIN'' THEN\n    RETURN NEW;\n  END IF;\n\n  -- DIAMOND PHASE 9: A DIAMOND SPIN''S CONTRACT IS ITS ONE DRAW RECEIPT. It\n  -- books no chip reserve row; its draw is the immutable receipt its own arm\n  -- of the authority wrote beside the reserve legs. Before that receipt exists\n  -- the contract is undrawn on both sides (the chip pre-launch door), or a\n  -- cancellation zeroes the pool (the chip cancellation door, which never\n  -- has a booking to unwind here). Once it exists the row equals the receipt\n  -- and, published, never moves again.\n  IF public.fn_poker_diamond_tournament(NEW.id) THEN\n    SELECT (r.receipt->>''multiplier'')::numeric, (r.receipt->>''prize_pool'')::numeric\n      INTO v_multiplier, v_prize\n      FROM public.spin_draw_receipts r WHERE r.tournament_id = NEW.id;\n    IF NOT FOUND THEN\n      IF COALESCE(OLD.spin_multiplier,0) = 0 AND COALESCE(NEW.spin_multiplier,0) = 0\n         AND OLD.spin_locked_tiers IS NULL AND NEW.spin_locked_tiers IS NULL\n         AND OLD.started_at IS NULL AND NEW.started_at IS NULL\n         AND upper(COALESCE(OLD.status::text,'''')) IN (''ANNOUNCED'',''REGISTERING'')\n         AND (upper(COALESCE(NEW.status::text,'''')) IN (''ANNOUNCED'',''REGISTERING'')\n              OR (upper(COALESCE(NEW.status::text,'''')) IN (''CANCELLED'',''CANCELED'')\n                  AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric)) THEN\n        RETURN NEW;\n      END IF;\n      RAISE EXCEPTION ''Diamond Spin % contract must equal its one immutable draw receipt'', NEW.id\n        USING ERRCODE=''P0404'';\n    END IF;\n    IF NEW.spin_multiplier IS DISTINCT FROM v_multiplier OR NEW.prize_pool IS DISTINCT FROM v_prize THEN\n      RAISE EXCEPTION ''Spin % tournament contract must equal its one immutable reserve draw'', NEW.id\n        USING ERRCODE=''P0404'';\n    END IF;\n    IF OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier AND OLD.prize_pool IS NOT DISTINCT FROM v_prize\n       AND OLD.spin_locked_tiers IS NOT NULL THEN\n      RAISE EXCEPTION ''Spin % published draw contract is immutable'', NEW.id USING ERRCODE=''55000'';\n    END IF;\n    RETURN NEW;\n  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_spin_tournament_contract_is_draw: the variant gate (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> '747fc99476b082256141d42003a6c478' THEN
    RAISE EXCEPTION 'fn_spin_tournament_contract_is_draw: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text;
BEGIN
  v_oid := 'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'd1a25ca8de559144fe83b7639634baff' THEN
    RAISE EXCEPTION 'fn_complete_tournament_launch_before_lease_generation is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF v_is_paid_spin THEN\n    SELECT count(*), min(l.multiplier)\n      INTO v_spin_ledger_count, v_spin_ledger_multiplier\n      FROM public.spin_reserve_ledger l\n     WHERE l.tournament_id = p_tournament_id\n       AND l.kind = ''jackpot_draw'';\n';
  v_new1 := E'  IF v_is_paid_spin THEN\n    -- DIAMOND PHASE 9: a Diamond Spin proves its draw by its own receipt, its\n    -- ledger legs and the source''s register rows, read into the same two\n    -- variables the chip proof fills from its one jackpot_draw row.\n    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n      SELECT CASE WHEN COALESCE((d.proof->>''ok'')::boolean, false) THEN 1 ELSE 0 END,\n             (d.proof->>''multiplier'')::numeric\n        INTO v_spin_ledger_count, v_spin_ledger_multiplier\n        FROM (SELECT public.fn_poker_diamond_spin_draw_proof(p_tournament_id, p_launch_id) AS proof) d;\n    ELSE\n    SELECT count(*), min(l.multiplier)\n      INTO v_spin_ledger_count, v_spin_ledger_multiplier\n      FROM public.spin_reserve_ledger l\n     WHERE l.tournament_id = p_tournament_id\n       AND l.kind = ''jackpot_draw'';\n    END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_complete_tournament_launch_before_lease_generation: the Spin settlement read (1) occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> 'd1a25ca8de559144fe83b7639634baff' THEN
    RAISE EXCEPTION 'fn_complete_tournament_launch_before_lease_generation: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 10. A DRAWN SPIN GOES NOWHERE BUT TO ITS WINNERS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_refund(uuid, uuid, text, text, uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '4dcc2e8556323bf831de3863e218f97a' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_refund is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_c public.poker_diamond_custody%ROWTYPE; v_parts record;
  v_receipt jsonb; v_key text; v_ledger bigint; v_ob uuid; v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('unregister','cancel')
     OR p_source IS NULL OR length(btrim(p_source))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_refund' USING ERRCODE='22023';
  END IF;
  SELECT t.id,t.status,t.started_at,t.name INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_key := 'poker-tournament-refund:'||p_tournament_id::text||':'||p_user_id::text||':'||p_kind||':'||p_request_id::text;
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'fully_settled',true,'remaining',0,
      'paid',v_existing.amount,'refund_prize',v_existing.prize_part,'refund_bounty',v_existing.bounty_part,
      'refund_fee',v_existing.fee_part,'custody_id',v_existing.custody_id,'ledger_id',v_existing.id);
  END IF;

  -- DIAMOND PHASE 9: A DRAWN SPIN IS NOT REFUNDED. Once a Diamond Spin's draw
  -- has written its receipt (and moved its reserve legs), its entries are its
  -- prize pool: every exit - a withdrawal, a seat exit, a cancellation - comes
  -- through this door and is refused here by name, as the chip unregistration
  -- refuses a booked Spin (spin_entry_already_booked). A 3x draw moves no leg,
  -- so the receipt, not the ledger, is what decides.
  IF EXISTS (SELECT 1 FROM public.spin_draw_receipts r WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('spin_underwrite','spin_surplus')) THEN
    RAISE EXCEPTION 'diamond_spin_entry_already_booked' USING ERRCODE='55000';
  END IF;

  -- The roster decides whether this Diamond can go home: before the event
  -- starts a registration may be withdrawn; once it has started only a
  -- cancellation returns entries, and a cancellation returns every entry.
  IF p_kind='unregister' THEN
    IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'diamond_tournament_entry_in_play' USING ERRCODE='55000';
    END IF;
  ELSE
    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','COMPLETING') THEN
      RAISE EXCEPTION 'diamond_tournament_already_settled' USING ERRCODE='55000';
    END IF;
  END IF;
  -- An event that has paid anybody is not refundable by this door.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee')) THEN
    RAISE EXCEPTION 'diamond_tournament_already_paid' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND purpose='tournament_entry' AND target_id=p_tournament_id AND state<>'released'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_tournament_entry_not_held' USING ERRCODE='55000';
  END IF;
  IF v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL THEN
    RAISE EXCEPTION 'diamond_custody_requires_settlement' USING ERRCODE='55000';
  END IF;
  -- What this custody row holds, by bank: everything that entered it, less
  -- nothing, because nothing has left it (asserted above).
  SELECT COALESCE(sum(prize_part),0) AS prize, COALESCE(sum(bounty_part),0) AS bounty,
         COALESCE(sum(fee_part),0) AS fee, COALESCE(sum(amount),0) AS gross
    INTO v_parts FROM public.poker_diamond_tournament_ledger
   WHERE custody_id=v_c.id AND kind IN ('entry','rebuy','reentry','addon');
  IF v_parts.gross IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_custody_disagrees_with_ledger' USING ERRCODE='P0404';
  END IF;

  -- Open the release for this one row, in this transaction only, then close it.
  PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
  v_receipt := public.fn_poker_diamond_release(v_c.id, p_request_id);
  PERFORM set_config('app.poker_diamond_tournament_release', '', true);
  IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'amount')::bigint IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_release_failed' USING ERRCODE='P0404';
  END IF;

  -- The refund is an obligation the way a chip refund is, so the reconciler
  -- and the receipt see one vocabulary. amount_paid closes at amount_owed.
  INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
  VALUES (p_tournament_id,'refund',NULL,p_user_id,v_c.balance,v_c.balance,p_source,now())
  ON CONFLICT (tournament_id,kind,user_id) WHERE place IS NULL DO UPDATE
    SET amount_owed = public.tournament_obligations.amount_owed + EXCLUDED.amount_owed,
        amount_paid = public.tournament_obligations.amount_paid + EXCLUDED.amount_paid,
        updated_at = now(), settled_at = now()
  RETURNING id INTO v_ob;

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,obligation_id,request)
  VALUES (p_tournament_id,v_c.arena_id,p_user_id,v_c.id,'refund',v_c.balance,v_parts.prize,v_parts.bounty,v_parts.fee,
    v_key,NULLIF(v_receipt->>'journal_id','')::uuid,v_ob,
    jsonb_build_object('kind',p_kind,'source',p_source,'request_id',p_request_id))
  RETURNING id INTO v_ledger;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'paid',v_c.balance,
    'refund_prize',v_parts.prize,'refund_bounty',v_parts.bounty,'refund_fee',v_parts.fee,
    'custody_id',v_c.id,'ledger_id',v_ledger,'obligation_id',v_ob,'journal_id',v_receipt->>'journal_id',
    'available_balance',v_receipt->>'available_balance');
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_refund(uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_refund', 'migration a_diamond_spin_draws_a_whole_prize');

-- ---------------------------------------------------------------------------
-- 11. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text; v_n numeric; v_f numeric;
BEGIN
  -- every Diamond door redefinition landed exactly as generated
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_poker_diamond_create_tournament(jsonb)', 'e6c37c7077addfeeef5cb41cdda6407a'),
      ('public.fn_poker_diamond_tournament_escrow(uuid)', 'd31432344bd1e28904416f5924b75670'),
      ('public.fn_poker_diamond_tournament_open_shadow(uuid)', 'a48dc93434b566767bf9baa0f63abee4'),
      ('public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid)', 'ceffb36777bfa7067c4fac90c51d5858'),
      ('public.fn_poker_diamond_tournament_refund(uuid, uuid, text, text, uuid)', 'a1b8b3b5bd4d7d50af063a3534f6372b')
    ) AS x(sig, want) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '% is not the text this migration wrote', r.sig;
    END IF;
  END LOOP;
  -- the one authority routes a Diamond Spin to its arm; the chip doors refuse one
  IF position('RETURN public.fn_poker_diamond_spin_draw(p_tournament_id, p_launch_id, p_lease_generation);'
       IN pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the Spin draw authority does not route a Diamond Spin to its arm';
  END IF;
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_spin_settle_game','fn_spin_draw_and_settle') LOOP
    IF position('diamond_spin_is_drawn_by_its_own_authority' IN r.def) = 0 THEN
      RAISE EXCEPTION '% does not refuse a Diamond Spin', r.proname;
    END IF;
  END LOOP;
  v_txt := pg_get_functiondef('public.fn_spin_sweep_unbooked(integer,integer)'::regprocedure);
  IF (length(v_txt) - length(replace(v_txt, 'NOT public.fn_poker_diamond_tournament(t.id)', '')))
     / length('NOT public.fn_poker_diamond_tournament(t.id)') <> 2 THEN
    RAISE EXCEPTION 'the unbooked sweep does not skip a Diamond Spin in both of its reads';
  END IF;
  IF position('AND NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN'
       IN pg_get_functiondef('public.fn_sync_seat_first_player_count(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the third seat would book a chip entry for a Diamond Spin';
  END IF;
  IF position('FROM public.spin_draw_receipts r WHERE r.tournament_id = NEW.id'
       IN pg_get_functiondef('public.fn_spin_tournament_contract_is_draw()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the Spin contract trigger does not read the Diamond draw';
  END IF;
  IF position('public.fn_poker_diamond_spin_draw_proof(p_tournament_id, p_launch_id)'
       IN pg_get_functiondef('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the launch completion does not prove a Diamond draw';
  END IF;
  IF position('e.prize_balance - r.spin_underwrite + r.spin_surplus'
       IN pg_get_functiondef('public.fn_ca_tournament_escrow(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the escrow router does not keep the chip shadow convention';
  END IF;
  IF position('''spin_underwrite''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass AND conname='poker_diamond_tournament_ledger_kind_check'))) = 0
     OR position('''spin_surplus''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass AND conname='poker_diamond_tournament_ledger_outflow'))) = 0 THEN
    RAISE EXCEPTION 'the ledger does not name the reserve legs';
  END IF;
  -- THE RULE, CERTIFIED ON THE PUBLISHED TABLE: it prices exactly the approved
  -- edge, and every tier and every place of its estate ladder is a whole
  -- Diamond at a buy-in of one Diamond - so at every whole buy-in.
  SELECT sum(s.freq::numeric * s.multiplier), sum(s.freq::numeric) INTO v_n, v_f FROM public.spin_tier_spec s;
  IF v_n IS DISTINCT FROM v_f * 3 * (1 - public.fn_spin_rake_rate(1)) THEN
    RAISE EXCEPTION 'the published Spin table no longer prices the approved edge; a Diamond Spin would refuse it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.spin_tier_spec s
               LEFT JOIN public.spin_payout_ladder l ON l.multiplier = s.multiplier
               LEFT JOIN LATERAL jsonb_array_elements(l.structure) e ON true
              WHERE l.multiplier IS NULL OR s.multiplier <> trunc(s.multiplier)
                 OR s.multiplier * (e.value->>'percentage')::numeric / 100
                    <> trunc(s.multiplier * (e.value->>'percentage')::numeric / 100)) THEN
    RAISE EXCEPTION 'the published Spin table is not whole at a buy-in of one Diamond';
  END IF;
  -- the new doors: none is reachable without an account or from a browser; the
  -- draw, the spin branch of the creation door and the rule are owner-only
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_spin_draw','fn_poker_diamond_spin_draw_proof','fn_poker_diamond_spin_contract',
                              'fn_poker_diamond_create_spin','fn_poker_diamond_create_tournament','fn_poker_diamond_tournament_drain',
                              'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_open_shadow',
                              'fn_poker_diamond_spin_contract_is_immutable') LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN RAISE EXCEPTION '% is reachable without an account', r.proname; END IF;
    IF r.proname <> 'fn_poker_diamond_create_tournament' AND has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is a browser door', r.proname;
    END IF;
    IF r.proname IN ('fn_poker_diamond_spin_draw','fn_poker_diamond_create_spin','fn_poker_diamond_spin_contract',
                     'fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_open_shadow',
                     'fn_poker_diamond_spin_contract_is_immutable')
       AND has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable by the engine; it is owner-only', r.proname;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.poker_diamond_spin_reserve_source', 'SELECT')
     OR has_table_privilege('anon', 'public.poker_diamond_spin_reserve_source', 'SELECT')
     OR has_table_privilege('authenticated', 'public.poker_diamond_spin_contracts', 'SELECT')
     OR has_table_privilege('anon', 'public.poker_diamond_spin_contracts', 'SELECT')
     OR has_table_privilege('service_role', 'public.poker_diamond_spin_reserve_source', 'INSERT')
     OR has_table_privilege('service_role', 'public.poker_diamond_spin_contracts', 'INSERT') THEN
    RAISE EXCEPTION 'a Diamond Spin table is writable by the engine or readable from a browser';
  END IF;
  -- nothing is authorized, nothing is opened, the identity is whole, every
  -- watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.poker_diamond_spin_reserve_source) THEN
    RAISE EXCEPTION 'this migration must not authorize a reserve source';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
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
  RAISE NOTICE 'a Diamond Spin draws a whole prize: the format admitted under the chip door''s rules, one authority, one roll, the reserve legs against an authorized source in whole Diamonds, nothing authorized and nothing opened';
END $m$;
