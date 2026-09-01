-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:39:07 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 3A: durable op-id claims for the four biggest admin money
-- movers. Wrapper/core pattern: the core holds the EXACT original body; the
-- wrapper adds a trailing p_op_id (default NULL = byte-identical behaviour),
-- claims the op, replays the stored result on a duplicate, releases the claim
-- on any soft failure, and loses the claim automatically on any raise
-- (single-transaction rollback). fn_mint_club_chips returns NUMERIC, which is
-- why this is a wrapper pattern and not a body injection.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_op_claims (
  op_id        text NOT NULL,
  fn_name      text NOT NULL,
  result       jsonb,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  PRIMARY KEY (op_id, fn_name)
);
COMMENT ON TABLE public.ca_op_claims IS
  'Zero-drift phase 3: durable idempotency claims for admin money movers. A row with result IS NOT NULL is a finalized operation; replaying the same op_id returns the stored result instead of moving money twice. Failure paths delete their claim so a corrected retry re-executes.';
ALTER TABLE public.ca_op_claims ADD COLUMN IF NOT EXISTS claimed_by uuid;

ALTER TABLE public.ca_op_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_op_claims FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-op-claims-prune-daily', '45 5 * * *',
  $$DELETE FROM public.ca_op_claims WHERE claimed_at < now() - interval '14 days'$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT 'cron', 'ca-op-claims-prune-daily', NULL,
       'prunes op-id idempotency claims older than 14 days', true
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory WHERE object_a = 'ca-op-claims-prune-daily');

-- ── A1. fn_mint_club_chips → core + op-id wrapper (returns numeric) ─────────
DROP FUNCTION public.fn_mint_club_chips(uuid, numeric, text);

CREATE FUNCTION public.fn_mint_club_chips_zd3core(p_club_id uuid, p_amount numeric, p_reason text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_actor uuid := auth.uid();
    v_after numeric;
    v_union uuid;
    v_authorised boolean;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'mint amount must be positive, got %', p_amount;
    end if;

    select union_id into v_union from clubs where id = p_club_id;
    if not found then
        raise exception 'mint failed: club % not found', p_club_id;
    end if;

    -- Dan 2026-08-22: only unions mint. A club that has joined a union has no
    -- mint of its own - chips are minted in the union and SENT to the club.
    if v_union is not null then
        raise exception 'Chip Mint is revoked for clubs in a union - chips are minted in the union and sent to the club. Ask your union owner.';
    end if;

    if coalesce(auth.role(), '') <> 'service_role' then
        v_authorised := v_actor is not null and (
            exists (select 1 from clubs c where c.id = p_club_id and c.owner_id = v_actor)
            or exists (
                select 1 from club_members cm
                 where cm.club_id = p_club_id
                   and cm.user_id = v_actor
                   and cm.role in ('owner','co_owner','admin')
                   and cm.status in ('active','approved'))
        );
        if not v_authorised then
            raise exception 'not authorized to mint for this club';
        end if;
    end if;

    /* ZERO-DRIFT round 2 (2026-08-31): duplicate-mint suppression. An
       identical mint (club, amount, reason, actor) inside 20 seconds is a
       retry, not a second intent - return the current treasury unchanged.
       A deliberate second mint just needs a different reason or 20 seconds. */
    if exists (
        select 1 from chip_transactions ct
         where ct.club_id = p_club_id
           and ct.transaction_type = 'treasury_mint'
           and ct.amount = p_amount
           and ct.from_user_id is not distinct from v_actor
           and coalesce(ct.notes,'') = coalesce(p_reason,'')
           and ct.created_at > now() - interval '20 seconds') then
        select coalesce(chip_treasury, 0) into v_after from clubs where id = p_club_id;
        return v_after;
    end if;

    /* Authorized issuance journals against the issuance reserve. */
    perform set_config('app.ledger_category', 'mint', true);
    perform set_config('app.ledger_counterparty', 'issuance_reserve', true);
    perform set_config('app.ledger_counterparty_entity', '', true);

    update public.clubs
       set chip_treasury = coalesce(chip_treasury, 0) + p_amount
     where id = p_club_id
    returning chip_treasury into v_after;

    insert into public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    values (p_club_id, v_actor, null, p_amount, 'treasury_mint', p_reason, v_after);

    return v_after;
end $function$;

-- NOTE: this mirror carries the wrapper as AMENDED by
-- 20260901001025_ca_phase5_op_claims_record_their_actor (claimed_by =
-- auth.uid() on the claim row), so the file is self-contained for the
-- definer-authorization gate. The core above is byte-exact as applied.
CREATE OR REPLACE FUNCTION public.fn_mint_club_chips(p_club_id uuid, p_amount numeric, p_reason text DEFAULT 'beta top-up'::text, p_op_id text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior jsonb;
  v_res numeric;
begin
  /* ZERO-DRIFT phase 3/5: durable op-id claim with actor audit. Callers that
     pass a p_op_id get exactly-once semantics across retries; the claim row
     records who asked. Authorization itself lives in the core. */
  if p_op_id is null then
    return public.fn_mint_club_chips_zd3core(p_club_id, p_amount, p_reason);
  end if;

  select result into v_prior
    from public.ca_op_claims
   where op_id = p_op_id and fn_name = 'fn_mint_club_chips';
  if found and v_prior is not null then
    return (v_prior->>'value')::numeric;  -- replay: treasury after the original mint
  elsif found then
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_mint_club_chips';
  end if;

  insert into public.ca_op_claims (op_id, fn_name, claimed_by)
  values (p_op_id, 'fn_mint_club_chips', v_actor);

  v_res := public.fn_mint_club_chips_zd3core(p_club_id, p_amount, p_reason);

  update public.ca_op_claims
     set result = jsonb_build_object('value', v_res), finalized_at = now()
   where op_id = p_op_id and fn_name = 'fn_mint_club_chips';

  return v_res;
end $function$;

REVOKE ALL ON FUNCTION public.fn_mint_club_chips_zd3core(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text, text) TO authenticated, service_role;

-- ── A2. fn_union_credit_wallet → core + wrapper (invoker, jsonb) ────────────
DROP FUNCTION public.fn_union_credit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid);

CREATE FUNCTION public.fn_union_credit_wallet_zd3core(
  p_union_id uuid, p_wallet text, p_amount numeric, p_tx_type text,
  p_club_id uuid, p_period_id uuid, p_notes text, p_created_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  -- Ensure wallet row exists
  INSERT INTO union_wallets (union_id, created_at, updated_at)
  VALUES (p_union_id, NOW(), NOW())
  ON CONFLICT (union_id) DO NOTHING;

  -- Read + lock before
  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  -- Update
  v_sql := format('UPDATE union_wallets SET %I = COALESCE(%I,0) + $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  -- Audit
  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'credit', p_amount, v_after,
    COALESCE(p_tx_type, 'credit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;

CREATE FUNCTION public.fn_union_credit_wallet(
  p_union_id uuid, p_wallet text, p_amount numeric,
  p_tx_type text DEFAULT NULL::text,
  p_club_id uuid DEFAULT NULL::uuid,
  p_period_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid,
  p_op_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prior jsonb;
  v_res jsonb;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN public.fn_union_credit_wallet_zd3core(
      p_union_id, p_wallet, p_amount, p_tx_type, p_club_id, p_period_id, p_notes, p_created_by);
  END IF;

  SELECT result INTO v_prior
    FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_union_credit_wallet';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_union_credit_wallet';
  END IF;

  INSERT INTO public.ca_op_claims (op_id, fn_name)
  VALUES (p_op_id, 'fn_union_credit_wallet');

  v_res := public.fn_union_credit_wallet_zd3core(
    p_union_id, p_wallet, p_amount, p_tx_type, p_club_id, p_period_id, p_notes, p_created_by);

  IF COALESCE(v_res->>'success', '') = 'true' THEN
    UPDATE public.ca_op_claims
       SET result = v_res, finalized_at = now()
     WHERE op_id = p_op_id AND fn_name = 'fn_union_credit_wallet';
  ELSE
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_union_credit_wallet';
  END IF;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_credit_wallet_zd3core(uuid, text, numeric, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_credit_wallet_zd3core(uuid, text, numeric, text, uuid, uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_credit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_credit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid, text) TO service_role;

-- ── A3. fn_union_debit_wallet → core + wrapper (invoker, jsonb) ─────────────
DROP FUNCTION public.fn_union_debit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid);

CREATE FUNCTION public.fn_union_debit_wallet_zd3core(
  p_union_id uuid, p_wallet text, p_amount numeric, p_tx_type text,
  p_club_id uuid, p_period_id uuid, p_notes text, p_created_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient balance',
      'wallet', v_wallet_column, 'balance', v_before, 'requested', p_amount
    );
  END IF;

  v_sql := format('UPDATE union_wallets SET %I = %I - $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'debit', p_amount, v_after,
    COALESCE(p_tx_type, 'debit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;

CREATE FUNCTION public.fn_union_debit_wallet(
  p_union_id uuid, p_wallet text, p_amount numeric,
  p_tx_type text DEFAULT NULL::text,
  p_club_id uuid DEFAULT NULL::uuid,
  p_period_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid,
  p_op_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prior jsonb;
  v_res jsonb;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN public.fn_union_debit_wallet_zd3core(
      p_union_id, p_wallet, p_amount, p_tx_type, p_club_id, p_period_id, p_notes, p_created_by);
  END IF;

  SELECT result INTO v_prior
    FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_union_debit_wallet';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_union_debit_wallet';
  END IF;

  INSERT INTO public.ca_op_claims (op_id, fn_name)
  VALUES (p_op_id, 'fn_union_debit_wallet');

  v_res := public.fn_union_debit_wallet_zd3core(
    p_union_id, p_wallet, p_amount, p_tx_type, p_club_id, p_period_id, p_notes, p_created_by);

  IF COALESCE(v_res->>'success', '') = 'true' THEN
    UPDATE public.ca_op_claims
       SET result = v_res, finalized_at = now()
     WHERE op_id = p_op_id AND fn_name = 'fn_union_debit_wallet';
  ELSE
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_union_debit_wallet';
  END IF;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_debit_wallet_zd3core(uuid, text, numeric, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_debit_wallet_zd3core(uuid, text, numeric, text, uuid, uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_debit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_debit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid, text) TO service_role;;
