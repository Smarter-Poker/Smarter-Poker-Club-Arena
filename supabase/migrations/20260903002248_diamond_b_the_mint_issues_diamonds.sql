-- LANE B - ISSUANCE THROUGH THE MINT (diamonds), part 1 of 2.
-- docs/DIAMOND-ACCOUNTING-STANDARD.md sections 2.3, 3.2 "Earn", 3.3 DR2/DR14, 5 "Lane B".
-- Part 2 (20260903002333_diamond_b_a_balance_born_outside_the_mint_is_recorded.sql)
-- carries the AFTER INSERT trigger on the hot table public.profiles, on its own,
-- with its own lock_timeout.
--
-- WHAT WAS MEASURED (production, 2026-09-02 22:50 to 2026-09-03 02:00 UTC)
--
--   profiles.diamonds        1,030,092 over 1,308 rows, 0 negative
--   ca_mint_ledger              0 rows, any asset, ever
--   fn_ca_mint_supply('diamonds')   0
--   ca_diamond_house.balance        0 (one row, id = 1)
--   diamond_transactions type 'signup_bonus'   212 rows / 63,600, all between
--                                              2026-01-13 and 2026-02-12; ZERO since
--   profiles created since 2026-09-01           419, of which 416 horses holding
--                                              exactly 500 each (208,000 diamonds)
--                                              with no journal row anywhere
--
-- WHY THE SIGNUP GRANT STOPPED JOURNALING. handle_new_user reads the balance before
-- its upsert and journals only when `COALESCE(v_prev_diamonds,0) = 0 AND
-- v_now_diamonds = 500`. The horse seeder inserts the profile ALREADY CARRYING 500
-- about 2 ms BEFORE the auth.users row exists (sampled: profile 01:46:08.600829,
-- auth 01:46:08.602734). handle_new_user therefore takes its ON CONFLICT path with
-- v_prev_diamonds = 500, the guard is false, and nothing is written. The audit
-- trigger zz_ca_audit_diamond_change is AFTER UPDATE OF diamonds only, so the
-- INSERT is invisible to ca_diamond_balance_audit as well. That is how 208,000
-- diamonds entered supply in two days with no row in any ledger.
--
-- WHAT THIS MIGRATION DOES
--
--  1. ca_mint_ledger.holder_type learns 'house' (it was club|union|player), and
--     holder_id gains a documented sentinel for a holder that is not a row in
--     profiles / clubs / unions.
--  2. fn_ca_mint and fn_ca_burn learn the destination / source 'house' for
--     diamonds (DR14: a fee, cut or forfeit that leaves a player and reaches no
--     player is banked, not burned by omission; and the Diamond Arena treasury of
--     section 3.2 has to be fundable). They also learn an optional trailing
--     p_class, validated against the foundation's issuance_class list, which is
--     stamped on the journal row along with the counterparty ('issuance' on a
--     mint, 'retired' on a burn) - DR3.
--     The argument list changes, so both are DROPped and re-created; every other
--     behaviour (service_role-or-admin gate, whole diamonds, two-decimal chips,
--     reason length, op_id claim in ca_op_claims with replay, the per-asset
--     advisory lock, the caps, supply_after, the chip club/union branches) is
--     carried across unchanged.
--  3. handle_new_user journals the 500 on BOTH paths - the INSERT path as today,
--     and the ON CONFLICT path when the profile already carried 500 and no
--     signup row exists yet - and writes the matching ca_mint_ledger row. Both
--     writes sit inside a nested BEGIN/EXCEPTION that files an incident and
--     swallows, so a ledger failure can never block a signup. Nothing else in
--     that function changes: not the VIP grant, not the multiplier, not the
--     username derivation, not the outer signup_errors handler.
--  4. One acknowledged-baseline row in ca_mint_ledger for the diamonds already in
--     circulation, modelled on the chip precedent
--     20260828082815_the_pre_funding_minting_becomes_an_acknowledged_baseline.sql,
--     so fn_ca_mint_supply('diamonds') reads the real supply from now on instead
--     of 0. NOTHING IS BACKFILLED AND NO BALANCE MOVES: the row records issuance
--     that already happened. Its holder is the sentinel and its balance_before /
--     balance_after (0 -> the total) describe the recorded position of all player
--     wallets taken together, NOT ca_diamond_house.balance, which this migration
--     leaves at 0 and asserts so below.
--  5. fn_ca_mint, fn_ca_burn and handle_new_user are registered in
--     ca_money_rpc_registry (fn_ca_burn and handle_new_user were absent).
--
-- WHAT THIS MIGRATION DOES NOT DO
--
--   It moves no diamonds. It refuses nothing that is allowed today: the only
--   behaviour REMOVED is the EXECUTE grant on fn_ca_mint / fn_ca_burn held by
--   `authenticated`, which the standard's Lane A also calls for; there are zero
--   callers of either function in either repo and zero rows in ca_mint_ledger, so
--   nothing live can notice. It does not stop the seeder inserting a balance
--   directly; part 2 records that, log-only.
--
-- VELOCITY WATCH. fn_ca_mint_velocity_watch (live body read 2026-09-03) reads
-- public.chip_ledger over a 10-minute window filtered on from_type IN
-- ('system_mint','issuance_reserve') / to_type IN ('system_burn','chip_retirement').
-- It never reads ca_mint_ledger and never looks at diamonds, so the baseline row
-- below cannot trip it and no op_id exclusion is needed. Left untouched.
--
-- ROLLBACK
--   DELETE FROM public.ca_mint_ledger WHERE op_id = 'baseline:diamonds:2026-09-03';
--   DELETE FROM public.ca_money_rpc_registry WHERE proname IN ('fn_ca_burn','handle_new_user');
--   Restore fn_ca_mint / fn_ca_burn / handle_new_user from
--   supabase/migrations/20260902172915_the_mint_issuance_and_retirement.sql and
--   from pg_proc as of 2026-09-03 02:00 UTC (both bodies are quoted in
--   docs/changelog/2026-09-03-diamond-b-mint.md).
--   ALTER TABLE public.ca_mint_ledger DROP CONSTRAINT ca_mint_ledger_holder_type_check;
--   ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT ca_mint_ledger_holder_type_check
--     CHECK (holder_type IN ('club','union','player'));

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. The register learns a holder that is not a person, a club or a union.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ca_mint_ledger DROP CONSTRAINT IF EXISTS ca_mint_ledger_holder_type_check;
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT ca_mint_ledger_holder_type_check
  CHECK (holder_type = ANY (ARRAY['club'::text, 'union'::text, 'player'::text, 'house'::text]));

COMMENT ON COLUMN public.ca_mint_ledger.holder_id IS
  'The account the issuance or retirement landed on: profiles.id for holder_type '
  '''player'', clubs.id for ''club'', unions.id for ''union''. holder_type ''house'' '
  'has no such row - ca_diamond_house is a single-row table keyed id = 1 - so it '
  'uses the fixed sentinel 00000000-0000-0000-0000-00000000d1a0. That sentinel is '
  'not a user and must never be joined to profiles.';

-- ---------------------------------------------------------------------------
-- 2. The Mint: destination / source 'house' for diamonds, and an issuance class.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_ca_mint(text, text, uuid, numeric, text, text);

CREATE FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid,
                                  p_amount numeric, p_reason text, p_op_id text,
                                  p_class text DEFAULT 'admin')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_dest  text := lower(btrim(COALESCE(p_destination, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_dest NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_issued_to_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_dest NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_issued_to_a_player_or_to_the_house_only');
  END IF;
  -- The foundation's issuance_class list (diamond_transactions_issuance_class_chk).
  -- Recorded on the diamond journal row; carried but unused for chips, which have
  -- their own ledger.
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_dest = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  IF (v_asset = 'chips' AND p_amount > 1000000000)
  OR (v_asset = 'diamonds' AND p_amount > 10000000) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_over_the_single_mint_cap');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'issuance_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_mint', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  IF v_asset = 'diamonds' THEN
    IF v_dest = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
      -- No diamond_transactions row: that journal is keyed by a user (two FKs to
      -- auth.users and profiles) and the house is not one. ca_mint_ledger is the
      -- record of a house-side issuance.
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve');
    IF v_dest = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_mint',
              'The Mint: ' || v_reason, v_after);
    ELSE
      SELECT name INTO v_label FROM public.unions WHERE id = p_target_id;
      IF v_label IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');
      END IF;
      INSERT INTO public.union_wallets (union_id, created_at, updated_at)
      VALUES (p_target_id, now(), now()) ON CONFLICT (union_id) DO NOTHING;
      SELECT COALESCE(chip_balance, 0) INTO v_before
        FROM public.union_wallets WHERE union_id = p_target_id FOR UPDATE;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger
     WHERE category = 'mint' AND from_type = 'issuance_reserve'
       AND to_entity_id = p_target_id AND amount = p_amount
     ORDER BY created_at DESC LIMIT 1;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'mint', v_asset, v_dest, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'mint',
    'asset', v_asset, 'destination', v_dest, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'minted_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, text) IS
  'The Mint. Chips are issued to a club treasury or a union bank; diamonds to a '
  'player wallet or to ca_diamond_house (DR14, and the Diamond Arena treasury of '
  'DIAMOND-ACCOUNTING-STANDARD 3.2). p_class is the issuance class stamped on the '
  'diamond journal row beside counterparty = ''issuance'' (DR3). service_role, or '
  'a profiles.role of admin / god, only.';

REVOKE ALL ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.fn_ca_burn(text, text, uuid, numeric, text, text);

CREATE FUNCTION public.fn_ca_burn(p_asset text, p_source text, p_target_id uuid,
                                  p_amount numeric, p_reason text, p_op_id text,
                                  p_class text DEFAULT 'admin')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_src   text := lower(btrim(COALESCE(p_source, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_src NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_retired_from_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_src NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_retired_from_a_player_or_from_the_house_only');
  END IF;
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_src = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'retirement_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_burn', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  IF v_asset = 'diamonds' THEN
    IF v_src = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_house_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) - p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_balance_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) - p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'spend', 'burn', -p_amount, v_after,
              'The Mint (retired): ' || v_reason, 'the_mint',
              jsonb_build_object('burned_by', v_actor, 'op_id', p_op_id),
              'retired', v_class)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement');
    IF v_src = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_treasury_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_burn',
              'The Mint (retired): ' || v_reason, v_after);
    ELSE
      SELECT COALESCE(w.chip_balance, 0), u.name INTO v_before, v_label
        FROM public.union_wallets w JOIN public.unions u ON u.id = w.union_id
       WHERE w.union_id = p_target_id FOR UPDATE OF w;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_union_bank_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) - p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger
     WHERE category = 'burn' AND to_type = 'chip_retirement'
       AND from_entity_id = p_target_id AND amount = p_amount
     ORDER BY created_at DESC LIMIT 1;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) - p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'burn', v_asset, v_src, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'burn',
    'asset', v_asset, 'source', v_src, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'burned_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text, text) IS
  'Retirement, the mirror of fn_ca_mint. Chips from a club treasury or union bank; '
  'diamonds from a player wallet or from ca_diamond_house. Refuses below zero on '
  'every account. p_class is stamped on the diamond journal row beside '
  'counterparty = ''retired''. service_role, or admin / god, only.';

REVOKE ALL ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The signup grant is journaled on BOTH paths.
--
-- Reconstructed from the live body (pg_proc, length(prosrc) = 5472) with exactly
-- two changes: the journal block below, and the v_grant_class declaration it
-- needs. The username derivation, the reserved-name fallback, the player-number
-- sequence, the INSERT column list and values, every ON CONFLICT assignment
-- (including the VIP grant and the multiplier) and the outer signup_errors
-- handler are byte-identical to what was running.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_player_num BIGINT;
    generated_username TEXT;
    resolved_full_name TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_prev_diamonds INTEGER;
    v_now_diamonds INTEGER;
    v_grant_class TEXT;
BEGIN
    resolved_full_name := COALESCE(
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'name', '')), ''),
        NULLIF(TRIM(
            COALESCE(NEW.raw_user_meta_data->>'given_name', '') || ' ' ||
            COALESCE(NEW.raw_user_meta_data->>'family_name', '')
        ), ''),
        ''
    );

    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', '');
    v_last_name  := COALESCE(NEW.raw_user_meta_data->>'last_name',  '');

    IF v_first_name = '' AND v_last_name = '' AND resolved_full_name <> '' THEN
        v_first_name := split_part(resolved_full_name, ' ', 1);
        v_last_name  := CASE
            WHEN position(' ' in resolved_full_name) > 0
            THEN substring(resolved_full_name from position(' ' in resolved_full_name) + 1)
            ELSE ''
        END;
    END IF;

    generated_username := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'poker_alias', ''),
        NULLIF(REGEXP_REPLACE(resolved_full_name, '[^a-zA-Z0-9]', '', 'g'), ''),
        SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
        'Player' || FLOOR(RANDOM() * 10000)::TEXT
    );
    generated_username := LEFT(generated_username, 15);

    -- If the derived username is reserved, fall back to Player<N> so the row
    -- never lands as @admin / @support / @smarterpoker / etc.
    IF public.is_reserved_username(generated_username) THEN
        generated_username := 'Player' || FLOOR(RANDOM() * 100000)::TEXT;
    END IF;

    SELECT nextval('public.profiles_player_number_seq') INTO next_player_num;

    -- ZERO-DRIFT: remember the pre-upsert balance so the signup grant can
    -- journal itself exactly when it changes supply, and never otherwise.
    SELECT diamonds INTO v_prev_diamonds FROM public.profiles WHERE id = NEW.id;

    INSERT INTO public.profiles (
        id, full_name, first_name, last_name, email, username, avatar_url,
        player_number, streak_count, diamonds, diamond_balance, diamond_multiplier, skill_tier,
        access_tier, is_vip, vip_tier, vip_expires_at,
        created_at, updated_at, last_login, last_active, is_online
    ) VALUES (
        NEW.id, resolved_full_name, v_first_name, v_last_name,
        COALESCE(NEW.email, ''), generated_username,
        COALESCE(NEW.raw_user_meta_data->>'avatar_url',
                 NEW.raw_user_meta_data->>'picture', ''),
        next_player_num, 0, 500, 500, 1.0, 'Newcomer',
        CASE
            WHEN NEW.raw_user_meta_data->>'state' IN ('WA','ID','MI','NV','CA') THEN 'Restricted_Tier'
            ELSE 'Full_Access'
        END,
        true, 'monthly', NOW() + INTERVAL '30 days',
        NOW(), NOW(), NOW(), NOW(), true
    )
    ON CONFLICT (id) DO UPDATE SET
        last_login    = NOW(),
        last_active   = NOW(),
        is_online     = true,
        full_name     = CASE WHEN COALESCE(profiles.full_name, '') = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
        first_name    = CASE WHEN COALESCE(profiles.first_name, '') = '' THEN EXCLUDED.first_name ELSE profiles.first_name END,
        last_name     = CASE WHEN COALESCE(profiles.last_name, '') = '' THEN EXCLUDED.last_name ELSE profiles.last_name END,
        avatar_url    = CASE WHEN COALESCE(profiles.avatar_url, '') = '' THEN EXCLUDED.avatar_url ELSE profiles.avatar_url END,
        player_number = COALESCE(profiles.player_number, EXCLUDED.player_number),
        diamonds      = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        diamond_balance = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        is_vip        = CASE WHEN profiles.is_vip IS NULL OR profiles.is_vip = false THEN true ELSE profiles.is_vip END,
        vip_tier      = CASE WHEN profiles.vip_tier IS NULL THEN 'monthly' ELSE profiles.vip_tier END,
        vip_expires_at= CASE WHEN profiles.vip_expires_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE profiles.vip_expires_at END;

    SELECT diamonds INTO v_now_diamonds FROM public.profiles WHERE id = NEW.id;

    -- THE SIGNUP GRANT IS JOURNALED ON BOTH PATHS (2026-09-03, Lane B).
    --
    -- The old guard was `COALESCE(v_prev_diamonds,0) = 0 AND v_now_diamonds = 500`,
    -- which is TRUE only when this function created the profile itself. The horse
    -- seeder inserts the profile ALREADY holding 500 about 2 ms before the
    -- auth.users row exists, so the ON CONFLICT path ran with v_prev_diamonds = 500
    -- and wrote nothing: 416 horses / 208,000 diamonds since 2026-09-01 with no row
    -- in any ledger. The human welcome INSERT in ensure-profile.js has the same
    -- shape.
    --
    --   prev 0 or NULL -> 500 : this function granted it. class 'promotional'.
    --   prev 500       -> 500 : it arrived with the profile.  class 'seeded'.
    --
    -- Deduped three ways so a re-auth can never double-journal: NOT EXISTS on the
    -- journal (by type OR by reference), NOT EXISTS on the register (by this
    -- user's signup: or seed: op_id - part 2's trigger may already have recorded
    -- the same 500 as it was born), and ca_mint_ledger.op_id UNIQUE underneath.
    -- The whole block is a nested BEGIN/EXCEPTION: a ledger failure files an
    -- incident and is swallowed, so it can NEVER block a signup.
    IF v_now_diamonds = 500 AND COALESCE(v_prev_diamonds, 0) IN (0, 500) THEN
        v_grant_class := CASE WHEN COALESCE(v_prev_diamonds, 0) = 500
                              THEN 'seeded' ELSE 'promotional' END;
        BEGIN
            INSERT INTO public.diamond_transactions
                (user_id, type, amount, balance_after, description, reference_id, source,
                 counterparty, issuance_class)
            SELECT NEW.id, 'signup_bonus', 500, 500,
                   'Signup Grant Journaled At Creation', 'signup:' || NEW.id::text,
                   'handle_new_user', 'issuance:signup', v_grant_class
            WHERE NOT EXISTS (
                SELECT 1 FROM public.diamond_transactions t
                 WHERE t.user_id = NEW.id
                   AND (t.type = 'signup_bonus'
                        OR t.reference_id = 'signup:' || NEW.id::text));

            INSERT INTO public.ca_mint_ledger
                (op_id, action, asset, holder_type, holder_id, holder_label, amount,
                 balance_before, balance_after, supply_after, reason,
                 performed_by, performed_by_label)
            SELECT 'signup:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
                   COALESCE(NULLIF(BTRIM(generated_username), ''), NEW.id::text), 500,
                   COALESCE(v_prev_diamonds, 0), 500,
                   -- profiles already holds the 500 at this point; the register
                   -- does not, so the supply this row establishes is the register
                   -- plus this grant.
                   public.fn_ca_mint_supply('diamonds') + 500,
                   'signup grant', NULL, 'handle_new_user'
            WHERE NOT EXISTS (
                SELECT 1 FROM public.ca_mint_ledger m
                 WHERE m.op_id IN ('signup:' || NEW.id::text, 'seed:' || NEW.id::text))
            ON CONFLICT (op_id) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
            PERFORM public.fn_ca_diamond_incident(
                'DR2:signup_grant_not_journaled', 'critical', NEW.id, 500, 'handle_new_user',
                jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                                   'prev_diamonds', v_prev_diamonds,
                                   'now_diamonds', v_now_diamonds,
                                   'grant_class', v_grant_class));
        END;
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Defensive: never block auth.users INSERT, but DO leave a forensic trail.
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg, raw_meta)
      VALUES (NEW.id, NEW.email, 'handle_new_user', SQLSTATE, SQLERRM, NEW.raw_user_meta_data);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Creates or refreshes the profile behind an auth.users INSERT and journals the '
  '500-diamond signup grant on BOTH the INSERT path (class promotional) and the '
  'ON CONFLICT path where the profile arrived already holding 500 (class seeded, '
  'the horse seeder and ensure-profile.js). The journal and register writes are '
  'nested in their own EXCEPTION block: a ledger failure files a diamond incident '
  'and never blocks a signup.';

-- ---------------------------------------------------------------------------
-- 4. The acknowledged baseline. Nothing moves; the circulation is recorded.
-- ---------------------------------------------------------------------------

DO $baseline$
DECLARE
  v_total  numeric;
  v_supply numeric;
  v_house  numeric;
BEGIN
  SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0) INTO v_total FROM public.profiles;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'baseline refused: profiles hold % diamonds', v_total;
  END IF;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label)
  VALUES
    ('baseline:diamonds:2026-09-03', 'mint', 'diamonds', 'house',
     '00000000-0000-0000-0000-00000000d1a0'::uuid,
     'all player wallets (pre-standard circulation, not ca_diamond_house)',
     v_total, 0, v_total,
     public.fn_ca_mint_supply('diamonds') + v_total,
     'pre-standard diamond circulation acknowledged as baseline 2026-09-03 '
     '(docs/DIAMOND-ACCOUNTING-STANDARD.md)',
     NULL, 'migration diamond_b_the_mint_issues_diamonds')
  ON CONFLICT (op_id) DO NOTHING;

  SELECT public.fn_ca_mint_supply('diamonds') INTO v_supply;
  IF v_supply <> v_total THEN
    RAISE EXCEPTION 'baseline did not square: register says %, profiles hold %',
                    v_supply, v_total;
  END IF;

  SELECT COALESCE(balance, 0) INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  IF COALESCE(v_house, 0) <> 0 THEN
    RAISE EXCEPTION 'the baseline must not touch the house balance, which reads %', v_house;
  END IF;

  RAISE NOTICE 'diamond baseline acknowledged: % diamonds, register now %', v_total, v_supply;
END
$baseline$;

-- ---------------------------------------------------------------------------
-- 5. Register the three functions that write a diamond balance.
--    Lane A registers the same two Mint doors; whichever lands first wins and the
--    other is a no-op.
-- ---------------------------------------------------------------------------

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved', v.notes
  FROM (VALUES
    ('fn_ca_mint',      'The Mint. Issues chips to a club/union and diamonds to a player or the house. service_role or admin/god only.'),
    ('fn_ca_burn',      'Retirement, the mirror of fn_ca_mint. Refuses below zero on every account. service_role or admin/god only.'),
    ('handle_new_user', 'auth.users AFTER INSERT trigger. Creates the profile with the 500-diamond signup grant and journals it on both paths.')
  ) AS v(proname, notes)
 WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = v.proname);

-- ---------------------------------------------------------------------------
-- 6. Post-apply assertions.
-- ---------------------------------------------------------------------------

DO $assert$
DECLARE
  v_supply numeric; v_total numeric; v_src text; v_ok boolean;
BEGIN
  SELECT public.fn_ca_mint_supply('diamonds') INTO v_supply;
  SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0) INTO v_total FROM public.profiles;
  IF abs(v_supply - v_total) > 0 THEN
    RAISE EXCEPTION 'supply identity broken: register % vs profiles %', v_supply, v_total;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_src FROM pg_constraint
   WHERE conrelid = 'public.ca_mint_ledger'::regclass
     AND conname = 'ca_mint_ledger_holder_type_check';
  IF v_src IS NULL OR position('house' in v_src) = 0 THEN
    RAISE EXCEPTION 'ca_mint_ledger holder CHECK does not accept house: %', v_src;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'handle_new_user';
  IF position('issuance:signup' in v_src) = 0
     OR position('seeded' in v_src) = 0
     OR position('ca_mint_ledger' in v_src) = 0 THEN
    RAISE EXCEPTION 'handle_new_user is missing the ON CONFLICT journal branch';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_mint' AND pronargs = 7;
  IF v_src IS NULL OR position('ca_diamond_house' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_mint does not know the house';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_burn' AND pronargs = 7;
  IF v_src IS NULL OR position('ca_diamond_house' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_burn does not know the house';
  END IF;

  SELECT count(*) = 3 INTO v_ok FROM public.ca_money_rpc_registry
   WHERE proname IN ('fn_ca_mint', 'fn_ca_burn', 'handle_new_user');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'the three diamond issuance writers are not all registered';
  END IF;

  RAISE NOTICE 'lane B part 1 assertions green: supply % = profiles %', v_supply, v_total;
END
$assert$;

COMMIT;
