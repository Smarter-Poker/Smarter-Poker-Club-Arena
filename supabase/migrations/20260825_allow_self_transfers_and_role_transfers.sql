-- Migration: Allow self transfers and role transfers in atomic_chip_transfer and fn_transfer_chips
-- Date: 2026-08-25

CREATE OR REPLACE FUNCTION public.atomic_chip_transfer(
    p_from_user_id uuid,
    p_to_user_id uuid,
    p_amount numeric,
    p_category text,
    p_description text,
    p_related_entity_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    -- ── AUTH: caller must be the sender themselves OR service_role ────────
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_from_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED' 
              USING HINT = 'Caller must be the sender or service_role';
    END IF;

    -- ── ARGUMENT VALIDATION ───────────────────────────────────────────────
    IF p_from_user_id IS NULL OR p_to_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_USER_ID' USING HINT = 'from/to are required';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT' 
              USING HINT = format('amount must be positive (got %s)', p_amount);
    END IF;
    IF p_amount > 1e12 THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_LIMIT' 
              USING HINT = 'max 1 trillion per single transfer';
    END IF;
    IF p_category IS NULL OR length(trim(p_category)) = 0 THEN
        RAISE EXCEPTION 'CATEGORY_REQUIRED' 
              USING HINT = 'audit trail requires a category';
    END IF;

    -- ── 1. Deduct from sender (row-lock on UPDATE guarantees atomicity) ───
    UPDATE wallets
       SET balance = balance - p_amount, updated_at = NOW()
     WHERE user_id = p_from_user_id 
       AND wallet_type = 'PLAYER' 
       AND balance >= p_amount;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- ── 2. Credit receiver (upsert) ───────────────────────────────────────
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type)
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();

    -- ── 3-4. Audit trail ──────────────────────────────────────────────────
    PERFORM log_wallet_transaction(
        p_from_user_id, 'PLAYER', -p_amount, 'debit', p_category,
        p_description, NULL, NULL, p_related_entity_id
    );
    PERFORM log_wallet_transaction(
        p_to_user_id, 'PLAYER', p_amount, 'credit', p_category,
        p_description, NULL, NULL, p_related_entity_id
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_transfer_chips(
    p_club_id uuid,
    p_from_user_id uuid,
    p_to_user_id uuid,
    p_amount numeric,
    p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_from_before numeric;
  v_to_before numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_from_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_from_user_id FOR UPDATE;

  IF v_from_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'sender is not a member of this club');
  END IF;

  IF v_from_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  END IF;

  UPDATE club_members
  SET chip_balance = chip_balance - p_amount::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_from_user_id;

  SELECT COALESCE(chip_balance, 0) INTO v_to_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  IF v_to_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_to_user_id, 'player', p_amount::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
  ELSE
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_to_user_id;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_from_user_id, p_to_user_id, p_amount,
    'peer_transfer', COALESCE(p_reason, 'Peer chip transfer'),
    COALESCE(v_to_before, 0) + p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_send(
    p_club_id uuid,
    p_to_user_id uuid,
    p_amount numeric,
    p_destination text DEFAULT 'agent_wallet'::text,
    p_reason text DEFAULT NULL::text,
    p_op_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_bank_before  numeric;
  v_bank_after   numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Bank');
  end if;

  -- REPLAY. The caller generated this op_id before the first attempt, so a
  -- retry after a timeout finds the original and reports it rather than
  -- sending a second time.
  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before
    from clubs c where c.id = p_club_id for update;
  if v_bank_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;
  if v_bank_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Bank Balance',
      'balance', v_bank_before, 'requested', p_amount);
  end if;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    select a.id into v_agent_id
      from agents a
     where a.club_id = p_club_id and a.user_id = p_to_user_id
     for update;

    if v_agent_id is null then
      insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
      values (p_to_user_id, p_club_id, v_to_role, 'active', 0, 0)
      returning id into v_agent_id;
    end if;

    if v_dest = 'agent_wallet' then
      update agents
         set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning agent_wallet_balance into v_to_after;
    else
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning promo_wallet_balance into v_to_after;
    end if;
  end if;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_bank_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after, now() + interval '7 days')
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'bank_before', v_bank_before,
    'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    -- Lost the race on the op_id index: the other caller did the work.
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_claim_back(
    p_club_id uuid,
    p_from_user_id uuid,
    p_amount numeric,
    p_source text DEFAULT 'agent_wallet'::text,
    p_reason text DEFAULT NULL::text,
    p_op_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_source       text := lower(coalesce(p_source, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_holder_role  text;
  v_held         numeric;
  v_agent_id     uuid;
  v_holder_after numeric;
  v_bank_after   numeric;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Claim Chips Back Into The Club Bank');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_claim'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Claim Limit');
  end if;
  if v_source not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Source Wallet');
  end if;
  if p_from_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose Whose Wallet To Claim From');
  end if;

  select cm.role into v_holder_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_from_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_holder_role is null then
    return jsonb_build_object('success', false, 'error', 'That Person Is Not An Active Member Of This Club');
  end if;

  if v_source = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = p_club_id and user_id = p_from_user_id
     for update;
  else
    if v_holder_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
      return jsonb_build_object('success', false,
        'error', 'Only Staff Or Agents Hold An Agent Wallet');
    end if;
    select a.id, coalesce(case when v_source = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = p_club_id and a.user_id = p_from_user_id
     for update;
    if v_agent_id is null then
      return jsonb_build_object('success', false,
        'error', 'That Member Has Never Been Funded, So There Is Nothing To Claim');
    end if;
  end if;

  if v_held < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held, 'requested', p_amount);
  end if;

  if v_source = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) - p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id
     returning chip_balance into v_holder_after;
  elsif v_source = 'promo_wallet' then
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning promo_wallet_balance into v_holder_after;
  else
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;
  if v_bank_after is null then
    raise exception 'club % not found while crediting the bank', p_club_id;
  end if;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, p_from_user_id, v_actor, p_amount, 'club_bank_claim',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Claim Back'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_source,
       'direction', 'into_bank',
       'actor_role', v_actor_role,
       'holder_role', v_holder_role,
       'bank_after', v_bank_after,
       'holder_balance_after', v_holder_after),
     v_bank_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'source', v_source,
    'bank_after', v_bank_after,
    'holder_balance_after', v_holder_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_claim'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
end
$function$;
