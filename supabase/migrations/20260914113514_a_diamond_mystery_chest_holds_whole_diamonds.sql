-- ============================================================================
-- A DIAMOND MYSTERY CHEST HOLDS WHOLE DIAMONDS
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, second piece: mystery bounties in
-- Diamonds. The chip estate's mystery machinery - the engine builds a chest
-- inventory from the one tier ladder and seeds it (fn_mystery_bounty_seed),
-- a knockout in the mystery phase reserves the next chest for its claimants
-- (fn_mystery_bounty_reserve), the reveal and the payment follow, and the
-- terminal settles unclaimed chests to the champion (fn_mystery_bounty_settle)
-- - is reused whole. Four things stood between it and a Diamond event:
--
--   1. The seed computed the mystery half of the pool in cents and accepted
--      chests of any cent amount. A Diamond does not divide: the half is
--      floored to the unit (the engine already floors it, since 2026-09-12,
--      when told the unit), and every chest must be a whole number of units.
--   2. The reserve split a chest between several claimants by largest
--      remainder in cents. At a Diamond unit the split is floored to whole
--      Diamonds and the remainder goes to the first claimant by user id (the
--      order the complete marker already reads claimants in); at the chip
--      unit the arithmetic is byte for byte what it was.
--   2b. The complete marker - the evidence that a knockout obligation was
--      settled exactly as its claimants deserve - expected the chip split in
--      cents (equal shares, the odd cents to the first claimants; a PKO cash
--      half of floor(share/2)). It now expects the split at the event's unit,
--      which is the same arithmetic at a cent and the Diamond arithmetic at a
--      Diamond: a marker that could never be true would have left every
--      Diamond knockout obligation pending and the event unable to finish.
--   3. The terminal settlement read "bounty paid" from wallet_transactions,
--      which a Diamond payment never writes; it reads the Diamond ledger for
--      a Diamond event, as the six readers of the first piece do.
--   4. The creation door refused the format by name, and the chip
--      configuration door refuses the arena (fn_can_create_games answers
--      false for a Diamond club by design); the Diamond door stamps the same
--      columns under the same rules itself.
--
-- The payment itself (fn_mystery_bounty_pay -> obligation kind mystery_bounty
-- -> fn_credit_and_log category bounty) already reaches the Diamond payer
-- from the first piece. Every chip edit is an asserted substitution with the
-- live md5 pinned and the reverse substitution proved; the Diamond creation
-- door is pinned and redefined with the same signature. tournaments_enabled
-- stays false. No price is invented: the bounty, the profile, the split and
-- the activation are what staff enter, under the chip door's rules. Applied
-- once to kuklfnapbkmacvwxktbh.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_mystery_bounty_seed                ac208552ceccf0ee0da6ca5e9fdfa397
--   fn_mystery_bounty_reserve             abdabb33a650f7dd051bc2ac2cefbe2a
--   fn_mystery_bounty_settle              36c41dd47afa7f444cbb14b2385288b8
--   fn_bounty_obligation_has_complete_marker  9acb7d17d2e0545684310b52434f2d18
--   fn_poker_diamond_create_tournament    5006588b401a47650384b213ebf8f633
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE SEED FLOORS THE MYSTERY HALF TO THE UNIT AND HOLDS EVERY CHEST TO IT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_mystery_bounty_seed';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'ac208552ceccf0ee0da6ca5e9fdfa397' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  IF v_pool_cents <= 0 THEN\n'
         || E'    RETURN jsonb_build_object(''ok'', false, ''reason'', ''empty_pool'');\n'
         || E'  END IF;';
  v_new1 := E'  -- DIAMOND PHASE 9: the mystery half is floored to the event''s unit (a\n'
         || E'  -- cent for a chip event, so unchanged; a whole Diamond for a Diamond\n'
         || E'  -- event), exactly as the engine floors the inventory it builds.\n'
         || E'  v_pool_cents := public.fn_ca_unit_floor_cents(v_pool_cents, public.fn_ca_tournament_unit_cents(p_tournament_id));\n'
         || v_old1;
  v_old2 := E'  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)';
  v_new2 := E'  -- DIAMOND PHASE 9: every chest is a whole number of the event''s units.\n'
         || E'  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_chests) c\n'
         || E'              WHERE (c->>''amount_cents'')::bigint % public.fn_ca_tournament_unit_cents(p_tournament_id) <> 0) THEN\n'
         || E'    RETURN jsonb_build_object(''ok'', false, ''reason'', ''chest_not_on_unit'',\n'
         || E'      ''unit_cents'', public.fn_ca_tournament_unit_cents(p_tournament_id));\n'
         || E'  END IF;\n'
         || v_old2;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'seed: the empty-pool clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'seed: the chest insert occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2)) <> 'ac208552ceccf0ee0da6ca5e9fdfa397' THEN
    RAISE EXCEPTION 'seed: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE RESERVE SPLITS A CHEST IN WHOLE UNITS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_old3 text; v_new3 text; v_old4 text; v_new4 text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_mystery_bounty_reserve';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'abdabb33a650f7dd051bc2ac2cefbe2a' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_reserve is not the pinned text (md5 %)', md5(v_def);
  END IF;
  -- the unit, read once
  v_old1 := E'  v_n integer;\nBEGIN';
  v_new1 := E'  v_n integer;\n'
         || E'  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 9\n'
         || E'BEGIN';
  -- each share floored to the unit
  v_old2 := E'             floor(v_chest.amount_cents * n.weight / t.w)::bigint AS fl,\n';
  v_new2 := E'             public.fn_ca_unit_floor_cents(floor(v_chest.amount_cents * n.weight / t.w)::bigint, v_unit)::bigint AS fl,\n';
  -- the remainder: a cent each to the top-ranked at the chip unit (as it was);
  -- the whole remainder to the designated revealer at a Diamond unit
  v_old3 := E'           fl + CASE WHEN rn <= leftover THEN 1 ELSE 0 END,\n';
  v_new3 := E'           fl + CASE WHEN v_unit = 1 THEN (CASE WHEN rn <= leftover THEN 1 ELSE 0 END)\n'
         || E'                    WHEN rn = 1 THEN leftover ELSE 0 END,\n';
  -- at a Diamond unit the remainder goes to the first claimant by user id,
  -- the order the complete marker (fn_bounty_obligation_has_complete_marker)
  -- already reads claimants in; at the chip unit the order is what it was
  v_old4 := E'             row_number() OVER (\n'
         || E'               ORDER BY a.frac DESC, a.weight DESC, a.user_id) AS rn,\n';
  v_new4 := E'             row_number() OVER (\n'
         || E'               ORDER BY CASE WHEN v_unit = 1 THEN a.frac ELSE 0 END DESC,\n'
         || E'                        CASE WHEN v_unit = 1 THEN a.weight ELSE 0 END DESC, a.user_id) AS rn,\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'reserve: the declaration anchor occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'reserve: the share clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'reserve: the remainder clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4);
  IF v_n <> 1 THEN RAISE EXCEPTION 'reserve: the rank clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4);
  IF md5(replace(replace(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4)) <> 'abdabb33a650f7dd051bc2ac2cefbe2a' THEN
    RAISE EXCEPTION 'reserve: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2b. THE COMPLETE MARKER EXPECTS THE SPLIT AT THE EVENT'S UNIT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_bounty_obligation_has_complete_marker(uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '9acb7d17d2e0545684310b52434f2d18' THEN
    RAISE EXCEPTION 'fn_bounty_obligation_has_complete_marker is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DIAMOND PHASE 9: the expected split is taken at the event's unit
  -- (fn_ca_tournament_unit_cents: a cent for a chip event, so every
  -- expression below is what it was; a whole Diamond for a Diamond event).
  -- A mystery chest splits into unit-floored equal shares with the remainder
  -- to the first claimant by user id; a regular or PKO head splits into
  -- unit-floored equal shares with the remainder to the last claimant, and a
  -- PKO cash half is the unit-floored half of the share.
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        CASE WHEN u.unit = 1 THEN
                          floor(a.amount_cents / claimant_count)
                            + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                   THEN 1 ELSE 0 END
                        ELSE
                          public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit)
                            + CASE WHEN ordinal = 1
                                   THEN a.amount_cents
                                        - public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit) * claimant_count
                                   ELSE 0 END
                        END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
                   CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count, u.unit,
                   CASE WHEN ordinal < claimant_count
                        THEN public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit)
                        ELSE head_cents
                             - public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
              CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents
                              - public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;

REVOKE ALL ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE SETTLEMENT READS "BOUNTY PAID" FROM THE DIAMOND LEDGER
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_mystery_bounty_settle';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '36c41dd47afa7f444cbb14b2385288b8' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_settle is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'        INTO v_ledger\n'
        || E'        FROM wallet_transactions wt\n'
        || E'       WHERE wt.related_entity_id = p_tournament_id\n'
        || E'         AND wt.category = ''bounty'';';
  v_new := v_old
        || E'\n      -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.\n'
        || E'      IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n'
        || E'        SELECT e.bounty_out INTO v_ledger\n'
        || E'          FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
        || E'      END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'settle: the paid clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '36c41dd47afa7f444cbb14b2385288b8' THEN
    RAISE EXCEPTION 'settle: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. THE CREATION DOOR ADMITS A MYSTERY BOUNTY EVENT AND STAMPS ITS RULES
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '5006588b401a47650384b213ebf8f633' THEN
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
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty') THEN
    -- satellite, spin: later Phase 9 pieces.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0 OR COALESCE((p_config->>'satelliteTargetId')::text,'')<>''
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
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
  v_max := COALESCE((p_config->>'maxPlayers')::int,0);
  IF v_max<2 OR v_max>10000 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),2);
  IF v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN v_max<=2 THEN 0.05 ELSE 0.10 END;
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
  IF jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
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
                           WHEN 'mystery_bounty' THEN 'mystery_bounty' ELSE 'freezeout' END;

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
    payout_percent, free_buy, is_private, action_time_seconds)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant, CASE WHEN v_type='sng' THEN 'SNG' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, LEAST(9, GREATEST(2, v_max)), v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END), 8,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile END,
    CASE WHEN v_mystery THEN v_mb_top END, CASE WHEN v_mystery THEN v_mb_pool END,
    CASE WHEN v_mystery THEN v_mb_regular END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds');
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text;
BEGIN
  v_txt := pg_get_functiondef('public.fn_mystery_bounty_seed(uuid, integer, jsonb)'::regprocedure);
  IF position('v_pool_cents := public.fn_ca_unit_floor_cents(v_pool_cents, public.fn_ca_tournament_unit_cents(p_tournament_id));' IN v_txt) = 0
     OR position('''chest_not_on_unit''' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the seed does not hold the mystery half and its chests to the unit';
  END IF;
  v_txt := pg_get_functiondef('public.fn_mystery_bounty_reserve(uuid, uuid, jsonb, uuid, text, uuid, integer)'::regprocedure);
  IF position('public.fn_ca_unit_floor_cents(floor(v_chest.amount_cents * n.weight / t.w)::bigint, v_unit)::bigint AS fl' IN v_txt) = 0
     OR position('WHEN rn = 1 THEN leftover ELSE 0 END' IN v_txt) = 0
     OR position('ORDER BY CASE WHEN v_unit = 1 THEN a.frac ELSE 0 END DESC,' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the reserve does not split a chest in whole units';
  END IF;
  v_txt := pg_get_functiondef('public.fn_bounty_obligation_has_complete_marker(uuid)'::regprocedure);
  IF (length(v_txt) - length(replace(v_txt, 'public.fn_ca_tournament_unit_cents(o.tournament_id)', ''))) / length('public.fn_ca_tournament_unit_cents(o.tournament_id)') <> 2
     OR position('floor(expected.expected_cents/2.0)::bigint, expected.unit' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the complete marker does not expect the split at the unit';
  END IF;
  v_txt := pg_get_functiondef('public.fn_mystery_bounty_settle(uuid, uuid)'::regprocedure);
  IF position('SELECT e.bounty_out INTO v_ledger' IN v_txt) = 0 OR position('wallet_transactions' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the settlement does not read the Diamond ledger beside the chip one';
  END IF;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF position('IF v_type NOT IN (''mtt'',''sng'',''bounty'',''progressive_bounty'',''mystery_bounty'') THEN' IN v_txt) = 0
     OR position('diamond_tournament_format_not_open' IN v_txt) = 0
     OR position('diamond_mystery_bounty_bad_activation_mode' IN v_txt) = 0
     OR position('mystery_bounty_regular_pool_percent' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door does not admit a mystery bounty event as this migration states';
  END IF;
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_create_tournament','fn_mystery_bounty_seed','fn_mystery_bounty_reserve','fn_mystery_bounty_settle','fn_bounty_obligation_has_complete_marker')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN RAISE EXCEPTION '% is reachable without an account', r.proname; END IF;
  END LOOP;
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
  RAISE NOTICE 'a Diamond mystery chest holds whole Diamonds: the seed, the reserve and the marker are on the unit, the settlement reads the ledger, the door admits the format, nothing opened';
END $m$;
