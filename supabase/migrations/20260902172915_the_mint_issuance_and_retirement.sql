-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902172915; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE MINT -- authorized issuance and retirement of chips and diamonds (2026-09-02)
-- Full reasoning in supabase/migrations/20260902_the_mint_issuance_and_retirement.sql
-- chips -> clubs.chip_treasury or union_wallets.chip_balance ONLY (never a person)
-- diamonds -> profiles.diamonds of an individual player ONLY (never a club/union/agent)

CREATE OR REPLACE FUNCTION public.fn_diamond_balance_mirrors_canonical()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  NEW.diamond_balance := NEW.diamonds;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_balance_mirrors_canonical() IS
  'profiles.diamond_balance follows profiles.diamonds. Canonical column is diamonds (what the header renders).';

DROP TRIGGER IF EXISTS trg_aa_diamond_balance_mirrors_canonical ON public.profiles;
CREATE TRIGGER trg_aa_diamond_balance_mirrors_canonical
  BEFORE INSERT OR UPDATE OF diamonds, diamond_balance ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_balance_mirrors_canonical();

CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_delta bigint := COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0);
BEGIN
  IF v_delta = 0 THEN RETURN NEW; END IF;

  INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0),
        lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
        lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
        updated_at      = now();

  INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
        lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
        lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
        updated_at      = now();

  UPDATE public.diamond_wallets
     SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, updated_at = now()
   WHERE user_id = NEW.id;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_side_tables_follow_profiles() IS
  'user_diamonds / user_diamond_balance / diamond_wallets mirror profiles.diamonds. Added 2026-09-02 after four stores were found disagreeing by ~800k diamonds.';

DROP TRIGGER IF EXISTS trg_diamond_side_tables_follow_profiles ON public.profiles;
CREATE TRIGGER trg_diamond_side_tables_follow_profiles
  AFTER UPDATE OF diamonds ON public.profiles
  FOR EACH ROW WHEN (OLD.diamonds IS DISTINCT FROM NEW.diamonds)
  EXECUTE FUNCTION public.fn_diamond_side_tables_follow_profiles();

UPDATE public.profiles SET diamond_balance = COALESCE(diamonds, 0)
 WHERE COALESCE(diamond_balance, 0) IS DISTINCT FROM COALESCE(diamonds, 0);

INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
SELECT p.id, GREATEST(COALESCE(p.diamonds, 0), 0), GREATEST(COALESCE(p.diamonds, 0), 0), 0, now(), now()
  FROM public.profiles p
ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();

INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
SELECT p.id, GREATEST(COALESCE(p.diamonds, 0), 0)::int, GREATEST(COALESCE(p.diamonds, 0), 0)::int, 0, now(), now()
  FROM public.profiles p
ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();

UPDATE public.diamond_wallets w
   SET balance = GREATEST(COALESCE(p.diamonds, 0), 0)::int, updated_at = now()
  FROM public.profiles p
 WHERE p.id = w.user_id AND w.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds, 0), 0)::int;

CREATE TABLE IF NOT EXISTS public.ca_mint_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id              text          NOT NULL UNIQUE,
  action             text          NOT NULL CHECK (action IN ('mint', 'burn')),
  asset              text          NOT NULL CHECK (asset  IN ('chips', 'diamonds')),
  holder_type        text          NOT NULL CHECK (holder_type IN ('club', 'union', 'player')),
  holder_id          uuid          NOT NULL,
  holder_label       text,
  amount             numeric(20,2) NOT NULL CHECK (amount > 0),
  balance_before     numeric(20,2) NOT NULL,
  balance_after      numeric(20,2) NOT NULL,
  supply_after       numeric(20,2) NOT NULL,
  reason             text          NOT NULL CHECK (length(btrim(reason)) >= 10),
  performed_by       uuid,
  performed_by_label text,
  db_role            text          NOT NULL DEFAULT current_user,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  chip_ledger_id     uuid,
  diamond_tx_id      uuid
);

COMMENT ON TABLE public.ca_mint_ledger IS
  'THE MINT: append-only record of every authorized issuance and retirement of chips and diamonds. Written only by fn_ca_mint and fn_ca_burn.';

CREATE INDEX IF NOT EXISTS ca_mint_ledger_created_idx ON public.ca_mint_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS ca_mint_ledger_holder_idx  ON public.ca_mint_ledger (holder_type, holder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_mint_ledger_asset_idx   ON public.ca_mint_ledger (asset, action, created_at DESC);

ALTER TABLE public.ca_mint_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ca_mint_ledger_admin_read ON public.ca_mint_ledger;
CREATE POLICY ca_mint_ledger_admin_read ON public.ca_mint_ledger
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin', 'god', 'superadmin')));

REVOKE ALL ON public.ca_mint_ledger FROM anon, authenticated;
GRANT SELECT ON public.ca_mint_ledger TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_supply(p_asset text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    FROM public.ca_mint_ledger WHERE asset = p_asset;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mint_supply(text) IS
  'Net authorized supply of an asset: total minted less total burned, from the Mint journal.';

DROP FUNCTION IF EXISTS public.fn_ca_mint(text, text, uuid, numeric, text, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_ca_mint(
  p_asset text, p_destination text, p_target_id uuid,
  p_amount numeric, p_reason text, p_op_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_dest  text := lower(btrim(COALESCE(p_destination, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
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
  IF v_asset = 'diamonds' AND v_dest <> 'player' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_issued_to_an_individual_player_only');
  END IF;
  IF p_target_id IS NULL THEN
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
    SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
      INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
    END IF;
    UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + p_amount
     WHERE id = p_target_id RETURNING diamonds INTO v_after;
    INSERT INTO public.diamond_transactions
      (user_id, type, transaction_type, amount, balance_after, description, source, metadata)
    VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
            'The Mint: ' || v_reason, 'the_mint',
            jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id))
    RETURNING id INTO v_dia_id;
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
    (p_op_id, 'mint', v_asset, v_dest, p_target_id, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'mint',
    'asset', v_asset, 'destination', v_dest,
    'target_id', p_target_id, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'minted_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text) IS
  'THE MINT. Chips are issued to a club treasury or a union bank only; diamonds to an individual player only (Dan, 2026-09-02). Admin-gated, idempotent on p_op_id, journalled in ca_mint_ledger and in the platform books.';

REVOKE ALL ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_burn(
  p_asset text, p_source text, p_target_id uuid,
  p_amount numeric, p_reason text, p_op_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_src   text := lower(btrim(COALESCE(p_source, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
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
  IF v_asset = 'diamonds' AND v_src <> 'player' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_retired_from_an_individual_player_only');
  END IF;
  IF p_target_id IS NULL THEN
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
      (user_id, type, transaction_type, amount, balance_after, description, source, metadata)
    VALUES (p_target_id, 'spend', 'burn', -p_amount, v_after,
            'The Mint (retired): ' || v_reason, 'the_mint',
            jsonb_build_object('burned_by', v_actor, 'op_id', p_op_id))
    RETURNING id INTO v_dia_id;
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
    (p_op_id, 'burn', v_asset, v_src, p_target_id, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'burn',
    'asset', v_asset, 'source', v_src,
    'target_id', p_target_id, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'burned_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';

  RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text) IS
  'THE MINT, in reverse. Retires chips from a club treasury or union bank, or diamonds from a player. Never takes a balance below zero. Admin-gated, idempotent on p_op_id.';

REVOKE ALL ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.id = v_actor AND p.role IN ('admin', 'god')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'chips_issued',      public.fn_ca_mint_supply('chips'),
    'diamonds_issued',   public.fn_ca_mint_supply('diamonds'),
    'mint_operations',   (SELECT count(*) FROM public.ca_mint_ledger),
    'club_treasuries',   (SELECT COALESCE(SUM(COALESCE(chip_treasury, 0)), 0) FROM public.clubs),
    'union_banks',       (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.union_wallets),
    'member_wallets',    (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.club_members),
    'chips_on_the_felt', (SELECT COALESCE(SUM(COALESCE(stack, 0)), 0) FROM public.table_seats WHERE left_at IS NULL),
    'diamonds_held',     (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0) FROM public.profiles),
    'diamond_holders',   (SELECT count(*) FROM public.profiles WHERE COALESCE(diamonds, 0) > 0)
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mint_overview() IS
  'Supply and circulation figures for The Mint panel. Issued totals come from the Mint journal; circulating totals from the live balances, so a divergence is visible.';

REVOKE ALL ON FUNCTION public.fn_ca_mint_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_overview() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN RETURN NEW; END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public\.)?deduct_diamonds\('
     OR v_stack ~ 'function (public\.)?fn_union_send_to_member\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenge\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenges\('
     OR v_stack ~ 'function (public\.)?fn_ca_mint\('
     OR v_stack ~ 'function (public\.)?fn_ca_burn\('
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$fn$;
