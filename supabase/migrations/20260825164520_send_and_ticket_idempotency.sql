-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825164520; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SEND OUT AND SEND TICKET: REPLAY PROTECTION (2026-08-25)
-- Completes 20260824020000, which added a key to Claim Back and left these two
-- money paths without one. Full reasoning in the repo copy at
-- supabase/migrations/20260825300000_send_and_ticket_idempotency.sql

CREATE UNIQUE INDEX IF NOT EXISTS ux_chip_transactions_idempotency_key
  ON public.chip_transactions ((metadata->>'idempotency_key'))
  WHERE metadata ? 'idempotency_key';

DROP FUNCTION IF EXISTS public.fn_cashier_send_chips(uuid, uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.fn_cashier_send_chips(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sender uuid := auth.uid();
  v_sender_role text;
  v_recipient_agent uuid;
  v_from_before numeric;
  v_from_after numeric;
  v_to_after numeric;
  v_first uuid;
  v_second uuid;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
begin
  if v_sender is null then
    return jsonb_build_object('success', false, 'error', 'not authenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;
  if p_to_user_id is null or p_to_user_id = v_sender then
    return jsonb_build_object('success', false, 'error', 'invalid recipient');
  end if;

  if v_key is not null then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is not null then
      return jsonb_build_object(
        'success', true,
        'from_balance', (v_prior->>'from_balance_after')::numeric,
        'to_balance',   (v_prior->>'to_balance_after')::numeric,
        'replayed', true);
    end if;
  end if;

  if v_sender < p_to_user_id then
    v_first := v_sender; v_second := p_to_user_id;
  else
    v_first := p_to_user_id; v_second := v_sender;
  end if;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_second for update;

  select role, coalesce(chip_balance, 0)
    into v_sender_role, v_from_before
    from club_members
   where club_id = p_club_id and user_id = v_sender and status in ('active', 'approved');
  if v_sender_role is null then
    return jsonb_build_object('success', false, 'error', 'sender is not an active member of this club');
  end if;
  if v_sender_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot send chips');
  end if;

  select agent_id into v_recipient_agent
    from club_members
   where club_id = p_club_id and user_id = p_to_user_id and status in ('active', 'approved');
  if not found then
    return jsonb_build_object('success', false, 'error', 'recipient is not an active member of this club');
  end if;
  if v_sender_role in ('super_agent', 'agent', 'sub_agent')
     and v_recipient_agent is distinct from v_sender then
    return jsonb_build_object('success', false, 'error', 'recipient is not in your downline');
  end if;

  if v_from_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  end if;

  begin
    update club_members
       set chip_balance = chip_balance - p_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_sender
     returning chip_balance into v_from_after;

    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;

    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    values
      (p_club_id, v_sender, p_to_user_id, p_amount, 'peer_transfer',
       coalesce(p_reason, 'Cashier send out'), v_to_after,
       case when v_key is null then '{}'::jsonb
            else jsonb_build_object(
                   'idempotency_key', v_key,
                   'from_balance_after', v_from_after,
                   'to_balance_after', v_to_after) end);

    insert into wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    values
      (v_sender, 'PLAYER', 'debit', p_amount, 'transfer',
       coalesce(p_reason, 'Cashier send out'), v_from_after),
      (p_to_user_id, 'PLAYER', 'credit', p_amount, 'transfer',
       coalesce(p_reason, 'Cashier send out'), v_to_after);
  exception when unique_violation then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is null then raise; end if;
    return jsonb_build_object(
      'success', true,
      'from_balance', (v_prior->>'from_balance_after')::numeric,
      'to_balance',   (v_prior->>'to_balance_after')::numeric,
      'replayed', true);
  end;

  return jsonb_build_object(
    'success', true,
    'from_balance', v_from_after,
    'to_balance', v_to_after
  );
end
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.fn_issue_tournament_ticket(uuid, uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.fn_issue_tournament_ticket(
  p_club_id uuid,
  p_holder_id uuid,
  p_value numeric,
  p_note text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_holder_agent uuid;
  v_bal numeric;
  v_after numeric;
  v_first uuid; v_second uuid;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_value is null or p_value <= 0 then
    return jsonb_build_object('success', false, 'error', 'ticket value must be > 0');
  end if;
  if p_value > 1e9 then
    return jsonb_build_object('success', false, 'error', 'value exceeds limit');
  end if;
  if p_holder_id = v_me then
    return jsonb_build_object('success', false, 'error', 'cannot issue a ticket to yourself');
  end if;

  if v_key is not null then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is not null then
      return jsonb_build_object(
        'success', true,
        'your_balance', (v_prior->>'issuer_balance_after')::numeric,
        'replayed', true);
    end if;
  end if;

  select role into v_role from club_members
   where club_id = p_club_id and user_id = v_me and status in ('active', 'approved');
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot issue tickets');
  end if;

  select agent_id into v_holder_agent from club_members
   where club_id = p_club_id and user_id = p_holder_id and status in ('active', 'approved');
  if not found then
    return jsonb_build_object('success', false, 'error', 'recipient is not an active member of this club');
  end if;
  if v_role in ('super_agent','agent','sub_agent') and v_holder_agent is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'recipient is not in your downline');
  end if;

  if v_me < p_holder_id then v_first := v_me; v_second := p_holder_id;
  else v_first := p_holder_id; v_second := v_me; end if;
  perform 1 from club_members where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = p_club_id and user_id = v_second for update;

  select coalesce(chip_balance,0) into v_bal from club_members
   where club_id = p_club_id and user_id = v_me;
  if v_bal < p_value then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_bal);
  end if;

  begin
    update club_members set chip_balance = chip_balance - p_value, updated_at = now()
     where club_id = p_club_id and user_id = v_me returning chip_balance into v_after;

    insert into tournament_tickets (club_id, issued_by, holder_id, value, note)
    values (p_club_id, v_me, p_holder_id, p_value, nullif(trim(coalesce(p_note,'')), ''));

    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    values
      (p_club_id, v_me, p_holder_id, p_value, 'peer_transfer',
       'Tournament ticket issued (escrowed until redeemed)', v_after,
       case when v_key is null then '{}'::jsonb
            else jsonb_build_object(
                   'idempotency_key', v_key,
                   'issuer_balance_after', v_after) end);
  exception when unique_violation then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is null then raise; end if;
    return jsonb_build_object(
      'success', true,
      'your_balance', (v_prior->>'issuer_balance_after')::numeric,
      'replayed', true);
  end;

  return jsonb_build_object('success', true, 'your_balance', v_after);
end
$function$;

REVOKE ALL ON FUNCTION public.fn_issue_tournament_ticket(uuid, uuid, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_issue_tournament_ticket(uuid, uuid, numeric, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_ticket(uuid, uuid, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_ticket(uuid, uuid, numeric, text, text) TO service_role;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cashier_send_chips';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_cashier_send_chips has % overloads, expected exactly 1', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_issue_tournament_ticket';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_issue_tournament_ticket has % overloads, expected exactly 1', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_cashier_send_chips', 'fn_issue_tournament_ticket')
     AND pg_get_function_identity_arguments(p.oid) LIKE '%p_idempotency_key text%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 keyed functions, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'ux_chip_transactions_idempotency_key';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ux_chip_transactions_idempotency_key is missing';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_cashier_send_chips', 'fn_issue_tournament_ticket')
     AND r.rolname IN ('anon', 'public');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anon/public retains EXECUTE on % money function grant(s)', v_n;
  END IF;
END $$;
