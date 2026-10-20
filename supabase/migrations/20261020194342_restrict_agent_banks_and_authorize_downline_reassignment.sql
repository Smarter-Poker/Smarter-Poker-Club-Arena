-- Owner October 20: all agent ranks see only self and downline, never club banks.
-- Exact installed function preimages preserve the existing money transaction paths.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN IF md5(pg_get_functiondef('ca_can_view_club_finances(uuid)'::regprocedure)) <> '20d5095763dc302c5cad8fcf1f66a9e9' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_can_view_club_finances'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.club_id = p_club_id
             AND cm.user_id = auth.uid()
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
             AND cm.role IN ('owner', 'co_owner', 'admin')
             AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)
        )
        OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))
      )
    );
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_can_use_club_bank(uuid)'::regprocedure)) <> '0be67506c5fea9bc500d762fefcaa317' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_can_use_club_bank'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_can_use_club_bank(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select auth.uid() is not null
     and public.fn_club_bank_role(p_club_id)
           in ('owner', 'co_owner', 'admin');
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_cashier_statement_scope(uuid)'::regprocedure)) <> 'c8137ef74e0e7ccfb05b94697b3fb122' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_cashier_statement_scope'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_scope(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_scope text := 'none';
  v_ids uuid[];
  v_reason text;
BEGIN
  IF v_viewer IS NULL THEN
    v_reason := 'sign_in_required';
  ELSIF p_club_id IS NULL THEN
    v_reason := 'club_required';
  ELSE
    v_role := public.fn_club_bank_role(p_club_id, v_viewer);
    IF v_role IS NULL THEN
      v_reason := 'not_an_active_member';
    ELSIF v_role IN ('owner', 'co_owner', 'admin') THEN
      v_scope := 'all';
    ELSIF v_role IN ('super_agent', 'agent', 'sub_agent') THEN
      v_scope := 'downline';
      v_ids := public.fn_cashier_statement_downline(p_club_id, v_viewer);
    ELSE
      v_scope := 'self';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'authorized', v_scope <> 'none', 'reason', v_reason,
    'role', CASE WHEN v_scope <> 'none' THEN v_role END,
    'scope', v_scope, 'viewer', v_viewer,
    'fingerprint', md5(concat_ws('|', v_viewer::text, p_club_id::text,
      v_scope, array_to_string(v_ids, ',')))
  );
END
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) <> '51025f9917e8419e313957a8c84b5ed7' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_bank_claim_core_20261004'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_bank_claim_core_20261004(p_club_id uuid, p_from_user_id uuid, p_amount numeric, p_source text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Claim Chips Back Into The Club Bank');
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

  if p_from_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_from_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
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

  -- CHIP STANDARD 2.4 (2026-09-03): ONE row from the wallet claimed to the
  -- club bank, keyed and correlated on the op. The clubs trigger is skipped;
  -- the holder's wallet trigger writes the row with the bank as counterparty.
  perform public.fn_ca_declare_ledger('club_bank_claim', 'club_treasury', p_club_id, null,
    'club_bank_claim:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

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
  perform set_config('app.ledger_autoskip_clubs', '', true);

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
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_bank_reverse_core_20261004(uuid,text,uuid)'::regprocedure)) <> '8e515d379b11dc5a5efee2aa168135d9' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_bank_reverse_core_20261004'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_bank_reverse_core_20261004(p_transaction_id uuid, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_op_id      uuid := coalesce(p_op_id, gen_random_uuid());
  v_tx         record;
  v_dest       text;
  v_held       numeric;
  v_agent_id   uuid;
  v_bank_after numeric;
  v_to_after   numeric;
  v_new_id     uuid;
  v_prior      record;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, club_id, from_user_id, to_user_id, amount, transaction_type,
         coalesce(metadata, '{}'::jsonb) as metadata,
         coalesce(is_reversed, false) as is_reversed, reversible_until
    into v_tx
    from chip_transactions
   where id = p_transaction_id
   for update;
  if v_tx.id is null then
    return jsonb_build_object('success', false, 'error', 'That Ledger Entry Was Not Found');
  end if;

  v_actor_role := public.fn_club_bank_role(v_tx.club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Reverse A Club Bank Send');
  end if;

  select id into v_prior from chip_transactions
   where club_id = v_tx.club_id
     and transaction_type = 'club_bank_reversal'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true, 'transaction_id', v_prior.id);
  end if;

  if v_tx.transaction_type <> 'club_bank_send' then
    return jsonb_build_object('success', false,
      'error', 'Only A Club Bank Send Can Be Reversed Here');
  end if;
  if v_tx.is_reversed then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Reversed');
  end if;
  if v_tx.reversible_until is not null and now() > v_tx.reversible_until then
    return jsonb_build_object('success', false,
      'error', 'That Send Is Outside Its Seven Day Reversal Window');
  end if;

  v_dest := coalesce(v_tx.metadata ->> 'destination', 'agent_wallet');

  -- Take the chips back only if they are still there.
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     for update;
  else
    select a.id, coalesce(case when v_dest = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = v_tx.club_id and a.user_id = v_tx.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object('success', false, 'error', 'That Wallet No Longer Exists');
  end if;
  if v_held < v_tx.amount then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Have Already Been Spent, So The Send Cannot Be Reversed',
      'held', v_held, 'required', v_tx.amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `reversal` row from the wallet that
  -- received the send back to the club bank, keyed and correlated on the op.
  -- The clubs trigger is skipped; the recipient's wallet trigger writes it.
  perform public.fn_ca_declare_ledger('reversal', 'club_treasury', v_tx.club_id, null,
    'club_bank_reversal:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update club_members set chip_balance = chip_balance - v_tx.amount, updated_at = now()
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     returning chip_balance into v_to_after;
  elsif v_dest = 'promo_wallet' then
    update agents set promo_wallet_balance = promo_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning promo_wallet_balance into v_to_after;
  else
    update agents set agent_wallet_balance = agent_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning agent_wallet_balance into v_to_after;
  end if;

  update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_tx.amount, updated_at = now()
   where id = v_tx.club_id returning chip_treasury into v_bank_after;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  update chip_transactions
     set is_reversed = true, clawed_back = true
   where id = v_tx.id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (v_tx.club_id, v_tx.to_user_id, v_tx.from_user_id, v_tx.amount, 'club_bank_reversal',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send Reversed'),
     jsonb_build_object(
       'op_id', v_op_id,
       'reverses', v_tx.id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after)
  returning id into v_new_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_new_id, 'reversed', v_tx.id,
    'amount', v_tx.amount, 'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
end
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_bank_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) <> '04cd26f09afb9b0220f3ede4bb803c97' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_bank_send_core_20261004'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_bank_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Send From The Club Bank');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
     and from_user_id = v_actor
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
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
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
  -- Dan 2026-09-02: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER
  -- WALLET (ADMIN'S SHOULD NOT)". A player-wallet credit to an admin lands in
  -- a balance no surface shows them, so it is refused here rather than
  -- stranded.
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
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

  -- CHIP STANDARD 2.4 (2026-09-03): a club bank send is ONE journal row from
  -- the bank to the wallet that receives it. Undeclared, the two balance
  -- writes landed as `adjustment club_treasury -> settlement_suspense` plus
  -- `adjustment settlement_suspense -> agent_wallet` (or `table_stack ->
  -- player_wallet`), unkeyed and uncorrelated (3,750,000.00 on 2026-09-01
  -- 14:02:19 journaled exactly so). The clubs trigger is skipped for this
  -- write; the receiving wallet's trigger writes the row with the bank as its
  -- counterparty, keyed and correlated on the op. Never a refusal: a journal
  -- miss falls back inside the trigger, the money moves as before.
  perform public.fn_ca_declare_ledger('club_bank_send', 'club_treasury', p_club_id, null,
    'club_bank_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

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
    v_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
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
  perform set_config('app.ledger_autoskip_clubs', '', true);

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
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_money_panel(uuid)'::regprocedure)) <> 'f6b49d2e875e162c086f2186bfc60407' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_money_panel'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_union_id uuid; v_club record;
  v_is_member boolean := false; v_is_club_staff boolean := false; v_is_union_staff boolean := false;
  v_scope text; v_pool record; v_w record;
  v_week_start timestamptz := date_trunc('week', now());
  v_club_rake numeric := 0; v_rate numeric := 0.90;
  v_clubs_wallet numeric; v_union_week numeric; v_out jsonb;
  v_spin_idle numeric := 0; v_spin_deployed numeric := 0;
  v_bbj jsonb;
BEGIN
  IF v_uid IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_auth');
  END IF;

  SELECT id, name, union_id, COALESCE(chip_treasury,0) AS chip_treasury,
         COALESCE(chip_pool,0) AS chip_pool, COALESCE(promo_balance,0) AS promo_balance,
         owner_id
    INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'club_not_found');
  END IF;
  v_union_id := v_club.union_id;
  v_week_start:=public.fn_ca_launch_accounting_start('club',p_club_id,public.fn_ca_launch_accounting_start('union',v_union_id,v_week_start));

  -- The jackpot, resolved BEFORE the membership gate. Union-first, exactly as
  -- the engine banks it: a club inside a union contributes to the UNION pool.
  SELECT bp.id, COALESCE(bp.main_balance,0) main_balance,
         COALESCE(bp.backup_balance,0) backup_balance,
         COALESCE(bp.promo_balance,0) promo_balance,
         bp.union_id IS NOT NULL AS is_union_pool
    INTO v_pool FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL  AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  v_bbj := jsonb_build_object(
    'pool_id', v_pool.id, 'is_union_pool', COALESCE(v_pool.is_union_pool, false),
    'main', round(COALESCE(v_pool.main_balance,0), 2),
    'backup', round(COALESCE(v_pool.backup_balance,0), 2),
    'promo_in_pool', round(COALESCE(v_pool.promo_balance,0), 2));

  IF NOT public.fn_can_use_club_bank(p_club_id) THEN v_bbj := v_bbj - 'backup' - 'promo_in_pool'; END IF;
  SELECT EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid)
    INTO v_is_member;
  v_is_club_staff := (v_club.owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
                 AND public.fn_cashier_member_is_active(cm.club_id,cm.user_id) AND lower(COALESCE(cm.role,'')) IN ('owner','co_owner','admin'));

  IF v_union_id IS NOT NULL THEN
    v_is_union_staff := EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = v_uid)
      OR EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = v_uid);
  END IF;

  IF NOT (v_is_member OR v_is_club_staff OR v_is_union_staff) THEN
    -- Still a refusal in every respect the caller relies on: `scope` is absent,
    -- so club money renders "-" and never 0.00. Only the public jackpot rides
    -- along.
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_a_member',
                              'bbj', v_bbj);
  END IF;

  v_scope := CASE WHEN v_is_union_staff THEN 'union'
                  WHEN v_is_club_staff  THEN 'club' ELSE 'member' END;

  v_out := jsonb_build_object(
    'authorized', true, 'scope', v_scope, 'club_id', p_club_id, 'club_name', v_club.name,
    'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
    'club_treasury', round(v_club.chip_treasury, 2), 'club_pool', round(v_club.chip_pool, 2),
    /* THE CLUB'S PROMO WALLET (Dan, 2026-09-02): "NONE OF THE CHIPS FROM THE
       BBJ RAKE ARE GOING INTO THE PROMO WALLET." They were. Every hand's BBJ
       drop splits 50/25/25 main/backup/promo (bbj_record_contribution), and
       fn_sweep_bbj_promo moves the promo slice out of the pool into
       clubs.promo_balance for a standalone club - 1,220.19 of it in Deep
       Stack Society alone. This panel never returned that column, so no
       surface could show it and the club's Promo Wallet row fell back to the
       VIEWER'S OWN agents.promo_wallet_balance, which reads 0.00 for an owner
       who is not an agent. Club money, at exactly the sensitivity of
       club_treasury beside it, and club-scoped: a club inside a union banks
       its promo slice in the UNION wallet, so this is honestly 0 there and
       'union_promo' below carries the union's figure for union staff. */
    'club_promo_wallet', round(COALESCE(v_club.promo_balance, 0), 2),
    'bbj', v_bbj,
    'week_start', v_week_start, 'next_close_at', v_week_start + interval '7 days');

  IF v_union_id IS NULL THEN
    IF v_is_club_staff THEN
      -- The hand path keeps its share per table (club_table_rake_totals,
      -- 2026-10-02); the wallet column carries tournament rake and history.
      SELECT round(COALESCE(w.period_rake_collected, 0)
                 + COALESCE((SELECT sum(t.rake_collected)
                               FROM public.club_table_rake_totals t
                              WHERE t.club_id = p_club_id), 0), 2) INTO v_club_rake
        FROM club_wallets w WHERE w.club_id = p_club_id;
      IF FOUND THEN
        v_out := v_out || jsonb_build_object('club_rake_treasury', v_club_rake);
      END IF;
    END IF;
  IF NOT public.fn_can_use_club_bank(p_club_id) THEN
    v_out := jsonb_build_object('authorized', true, 'scope', 'member',
      'club_id', p_club_id, 'club_name', v_club.name,
      'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
      'bbj', jsonb_build_object('pool_id',v_pool.id,'main',round(COALESCE(v_pool.main_balance,0),2),
        'is_union_pool',COALESCE(v_pool.is_union_pool,false)));
  END IF;
    RETURN v_out;
  END IF;

  IF v_is_club_staff OR v_is_union_staff THEN
    SELECT COALESCE(
             (SELECT w.rake_total FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.club_id = p_club_id
                 AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.club_id = p_club_id
                 AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
                 AND t.created_at >= v_week_start),
             0) INTO v_club_rake;
    SELECT COALESCE(uc.club_commission_rate, 0.90) INTO v_rate
      FROM union_clubs uc WHERE uc.union_id = v_union_id AND uc.club_id = p_club_id;
    v_out := v_out || jsonb_build_object(
      'club_rake_this_week', round(v_club_rake, 2),
      'club_rakeback_rate', COALESCE(v_rate, 0.90),
      'club_projected_rakeback', trunc(v_club_rake * COALESCE(v_rate, 0.90) * 100) / 100);
  END IF;

  IF v_is_union_staff THEN
    SELECT round(COALESCE(chip_balance,0),2) chip_balance,
           round(COALESCE(rake_wallet,0),2) rake_wallet,
           round(COALESCE(promo_wallet,0),2) promo_wallet,
           round(COALESCE(spin_reserve_wallet,0),2) spin_reserve_wallet
      INTO v_w FROM union_wallets WHERE union_id = v_union_id;

    SELECT COALESCE(SUM(COALESCE(c.chip_treasury,0)), 0) INTO v_clubs_wallet
      FROM clubs c WHERE c.union_id = v_union_id AND c.id <> v_union_id;

    SELECT COALESCE(
             (SELECT SUM(w.rake_total) FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.wallet = 'rake_wallet'
                 AND t.direction = 'credit' AND t.tx_type = 'rake' AND t.created_at >= v_week_start),
             0) INTO v_union_week;

    v_spin_idle := COALESCE(v_w.spin_reserve_wallet, 0);
    SELECT COALESCE(SUM(COALESCE(sp.balance, 0)), 0) INTO v_spin_deployed
      FROM spin_bonus_pools sp
     WHERE sp.is_active
       AND (sp.club_id = v_union_id
            OR sp.club_id IN (SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = v_union_id));

    v_out := v_out || jsonb_build_object(
      'union_bank', COALESCE(v_w.chip_balance, 0),
      'rake_treasury', COALESCE(v_w.rake_wallet, 0),
      'union_promo', COALESCE(v_w.promo_wallet, 0),
      'union_spin_treasury', round(v_spin_idle + v_spin_deployed, 2),
      'union_spin_idle', round(v_spin_idle, 2),
      'union_spin_deployed', round(v_spin_deployed, 2),
      'clubs_wallet', round(v_clubs_wallet, 2),
      'union_rake_this_week', round(v_union_week, 2),
      'projected_clubs_share', trunc(v_union_week * 0.90 * 100) / 100,
      'projected_union_share', round(v_union_week - trunc(v_union_week * 0.90 * 100) / 100, 2));
  END IF;

  IF NOT public.fn_can_use_club_bank(p_club_id) THEN
    v_out := jsonb_build_object('authorized', true, 'scope', 'member',
      'club_id', p_club_id, 'club_name', v_club.name,
      'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
      'bbj', jsonb_build_object('pool_id',v_pool.id,'main',round(COALESCE(v_pool.main_balance,0),2),
        'is_union_pool',COALESCE(v_pool.is_union_pool,false)));
  END IF;
  RETURN v_out;
END
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) <> '5d037d10de17314377a263d96a18556f' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_promo_send_core_20261004'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_promo_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_pot_before   numeric;
  v_pot_after    numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Send From The Club Promo Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet', 'cashier_agent_wallet', 'cashier_promo_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  select coalesce(c.promo_balance, 0) into v_pot_before
    from clubs c where c.id = p_club_id for update;
  if v_pot_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_promo_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'pot_after', (v_prior.metadata ->> 'pot_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if v_pot_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Promo Wallet Balance',
      'balance', v_pot_before, 'requested', p_amount);
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
  if v_dest in ('agent_wallet', 'cashier_agent_wallet', 'cashier_promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false, 'error', 'An Admin Does Not Hold A Player Wallet');
  end if;
  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false, 'error', 'That Member Is Not In Your Downline');
  end if;

  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', p_club_id, null,
    'club_promo_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set promo_balance = coalesce(promo_balance, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning promo_balance into v_pot_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    if v_dest = 'cashier_agent_wallet' then
      update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_agent_id returning agent_wallet_balance into v_to_after;
    else
      update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_agent_id returning promo_wallet_balance into v_to_after;
    end if;
  end if;
  if v_to_after is null then
    raise exception 'club promo credit landed nowhere for % in %', p_to_user_id, p_club_id;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_promo_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'club_promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'pot_before', v_pot_before,
       'pot_after', v_pot_after,
       'recipient_balance_after', v_to_after),
     v_pot_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'pot_before', v_pot_before,
    'pot_after', v_pot_after,
    'recipient_balance_after', v_to_after);
end
$function$
;

-- One club-scoped authority for hierarchy management. Being an agent alone
-- never grants the right to take another branch's members.
CREATE OR REPLACE FUNCTION public.fn_can_manage_club_assignments(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (
   public.fn_club_bank_role(p_club_id) IN ('owner','co_owner','admin')
   OR (public.fn_is_any_union_overseer(auth.uid())
       AND public.fn_union_oversees_club(p_club_id,auth.uid())
       AND NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id
         AND m.user_id=auth.uid() AND m.role IN ('super_agent','agent','sub_agent'))));
$$;
REVOKE ALL ON FUNCTION public.fn_can_manage_club_assignments(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_club_assignments(uuid) TO authenticated,service_role;

CREATE TABLE public.club_assignment_operations (
 id uuid PRIMARY KEY, club_id uuid NOT NULL, actor_id uuid NOT NULL,
 destination_user_id uuid NOT NULL, source_user_id uuid,
 member_user_ids uuid[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.club_assignment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_assignment_operations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_assignment_operations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_reassign_club_members(
 p_club_id uuid,p_member_user_ids uuid[],p_agent_user_id uuid,p_op_id uuid,
 p_expected_agent_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids uuid[]; v_old record; v_parent uuid; v_rank integer; v_m record; v_count integer;
BEGIN
 IF NOT COALESCE(public.fn_can_manage_club_assignments(p_club_id),false) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 IF p_op_id IS NULL OR p_agent_user_id IS NULL OR p_club_id IS NULL THEN
  RAISE EXCEPTION 'assignment_identity_required' USING ERRCODE='22023'; END IF;
 v_ids:=ARRAY(SELECT DISTINCT x FROM unnest(p_member_user_ids) x WHERE x IS NOT NULL ORDER BY x);
 IF cardinality(v_ids)=0 OR cardinality(v_ids)>10000 THEN
  RAISE EXCEPTION 'select_between_1_and_10000_members' USING ERRCODE='22023'; END IF;
 -- Same agreement lock as role/rate changes, before any row locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 SELECT * INTO v_old FROM public.club_assignment_operations WHERE id=p_op_id;
 IF FOUND THEN
  IF v_old.club_id<>p_club_id OR v_old.actor_id<>auth.uid()
    OR v_old.destination_user_id<>p_agent_user_id OR v_old.member_user_ids<>v_ids
    OR v_old.source_user_id IS DISTINCT FROM p_expected_agent_user_id THEN
   RAISE EXCEPTION 'assignment_operation_conflict' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('success',true,'replayed',true,'operation_id',p_op_id,'moved',cardinality(v_ids));
 END IF;
 SELECT a.id,public.fn_club_role_rank(m.role) INTO v_parent,v_rank
 FROM public.agents a JOIN public.club_members m ON m.club_id=a.club_id AND m.user_id=a.user_id
 WHERE a.club_id=p_club_id AND a.user_id=p_agent_user_id AND a.status='active'
 AND m.role IN ('owner','co_owner','admin','super_agent','agent','sub_agent')
 AND public.fn_cashier_member_is_active(m.club_id,m.user_id) FOR UPDATE OF a,m;
 IF v_parent IS NULL THEN RAISE EXCEPTION 'agent_not_active_in_club' USING ERRCODE='22023'; END IF;
 IF p_agent_user_id=ANY(v_ids) THEN RAISE EXCEPTION 'agent_cannot_report_to_itself' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM public.club_members m WHERE m.club_id=p_club_id
  AND m.user_id=ANY(v_ids) AND public.fn_cashier_member_is_active(m.club_id,m.user_id);
 IF v_count<>cardinality(v_ids) THEN RAISE EXCEPTION 'member_not_active_in_club' USING ERRCODE='22023'; END IF;
 FOR v_m IN SELECT * FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(v_ids)
  ORDER BY m.user_id FOR UPDATE LOOP
  IF v_m.role NOT IN ('member','player','super_agent','agent','sub_agent') THEN
   RAISE EXCEPTION 'staff_cannot_be_assigned_as_downline' USING ERRCODE='22023'; END IF;
  IF p_expected_agent_user_id IS NOT NULL AND v_m.agent_id IS DISTINCT FROM p_expected_agent_user_id THEN
   RAISE EXCEPTION 'assignment_changed_reload_members' USING ERRCODE='P0001'; END IF;
  IF public.fn_club_is_in_downline(p_club_id,v_m.user_id,p_agent_user_id) THEN
   RAISE EXCEPTION 'would_create_cycle' USING ERRCODE='22023'; END IF;
  IF v_m.role IN ('super_agent','agent','sub_agent')
     AND public.fn_club_role_rank(v_m.role)>=v_rank THEN
   RAISE EXCEPTION 'upline_role_must_rank_above_downline' USING ERRCODE='22023'; END IF;
 END LOOP;
 UPDATE public.club_members SET agent_id=p_agent_user_id,updated_at=now()
 WHERE club_id=p_club_id AND user_id=ANY(v_ids);
 -- Both maintained hierarchy representations change in the same transaction.
 UPDATE public.agents SET parent_agent_id=v_parent,updated_at=now()
 WHERE club_id=p_club_id AND user_id=ANY(v_ids);
 UPDATE public.agents a SET total_players=(SELECT count(*) FROM public.club_members m
   WHERE m.club_id=p_club_id AND m.agent_id=a.user_id),updated_at=now() WHERE a.club_id=p_club_id;
 INSERT INTO public.club_assignment_operations(id,club_id,actor_id,destination_user_id,source_user_id,member_user_ids)
 VALUES(p_op_id,p_club_id,auth.uid(),p_agent_user_id,p_expected_agent_user_id,v_ids);
 INSERT INTO public.audit_trail(actor_id,actor_role,action,target_type,target_id,reason)
 VALUES(auth.uid(),COALESCE(public.fn_club_bank_role(p_club_id),'union_overseer'),
  'reassign_club_downline','club',p_club_id,jsonb_build_object('operation_id',p_op_id,
  'destination',p_agent_user_id,'source',p_expected_agent_user_id,'members',v_ids)::text);
 RETURN jsonb_build_object('success',true,'operation_id',p_op_id,'moved',cardinality(v_ids));
END $$;
REVOKE ALL ON FUNCTION public.fn_reassign_club_members(uuid,uuid[],uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_reassign_club_members(uuid,uuid[],uuid,uuid,uuid) TO authenticated,service_role;

-- Existing callers now use exactly the same validated transaction.
CREATE OR REPLACE FUNCTION public.fn_assign_player_to_agent(p_player_user_id uuid,p_agent_user_id uuid,p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 RETURN public.fn_reassign_club_members(p_club_id,ARRAY[p_player_user_id],p_agent_user_id,gen_random_uuid());
END $$;
CREATE OR REPLACE FUNCTION public.fn_assign_agent_to_super_agent(p_agent_user_id uuid,p_super_agent_user_id uuid,p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 RETURN public.fn_reassign_club_members(p_club_id,ARRAY[p_agent_user_id],p_super_agent_user_id,gen_random_uuid());
END $$;

-- This predicate is used by restrictive policies: an existing permissive
-- policy can never broaden an agent's private reporting scope.
CREATE OR REPLACE FUNCTION public.fn_can_read_club_member_data(p_club_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (p_user_id=auth.uid()
  OR public.fn_club_cashier_scope(p_club_id)='all'
  OR (public.fn_club_cashier_scope(p_club_id)='downline'
      AND public.fn_club_is_in_downline(p_club_id,auth.uid(),p_user_id)));
$$;
REVOKE ALL ON FUNCTION public.fn_can_read_club_member_data(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_can_read_club_member_data(uuid,uuid) TO authenticated,service_role;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['club_members','agents','player_stats','player_stats_snapshots',
  'club_member_daily_stats','club_member_daily_facts','club_member_play_totals',
  'club_rake_daily_user','ca_club_player_daily','ca_club_rake_daily_user',
  'ca_club_table_player_daily','ca_club_tournament_player_daily',
  'ca_club_member_tournament_fee_daily','ca_union_rake_attribution'] LOOP
  EXECUTE format('CREATE POLICY agent_member_boundary ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (public.fn_can_read_club_member_data(club_id,user_id))',t);
 END LOOP;
END $$;

-- Public club discovery must never be a back door to a treasury balance.
-- Explicit column grants keep lobby metadata usable; private figures are read
-- only through the authorized RPCs, including for owners and admins.
REVOKE SELECT ON public.clubs FROM PUBLIC,anon,authenticated;
DO $$ DECLARE cols text; BEGIN
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols FROM pg_attribute
 WHERE attrelid='public.clubs'::regclass AND attnum>0 AND NOT attisdropped
 AND attname NOT IN ('chip_treasury','chip_pool','total_rake','promo_balance','insurance_balance',
  'hands_played','spins_wallet_funding','spins_preseed_amount','guarantee_treasury_floor','club_commission_rate');
 EXECUTE 'GRANT SELECT ('||cols||') ON public.clubs TO anon,authenticated';
END $$;
REVOKE SELECT(chip_treasury,chip_pool,total_rake,promo_balance,insurance_balance,hands_played,
 spins_wallet_funding,spins_preseed_amount,guarantee_treasury_floor,club_commission_rate)
 ON public.clubs FROM PUBLIC,anon,authenticated;

DO $$ BEGIN IF md5(pg_get_functiondef('ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)'::regprocedure)) <> '16c6354d04bde2e30500153dbf5e9cf5' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_club_members'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_club_members(p_club_id uuid, p_search text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_sort text DEFAULT 'hands'::text, p_role text DEFAULT NULL::text)
 RETURNS TABLE(user_id uuid, display_name text, avatar_url text, is_horse boolean, is_online boolean, role text, status text, joined_at timestamp with time zone, last_active timestamp with time zone, chip_balance numeric, hands_played bigint, profit numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_search   text := nullif(btrim(coalesce(p_search, '')), '');
  v_role     text := nullif(btrim(coalesce(p_role, '')), '');
  v_sort     text := lower(coalesce(p_sort, 'hands'));
  v_may_see  boolean := public.fn_can_see_horse_flag(p_club_id);
  v_actor    uuid := auth.uid();
  v_service  boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_all      boolean := false;
  v_agent    boolean := false;
  v_cutoff   timestamptz := public.fn_ca_launch_accounting_cutoff('club', p_club_id);
  v_from_day date := CASE WHEN p_since IS NULL THEN NULL ELSE (p_since AT TIME ZONE 'UTC')::date END;
  v_from_ts  timestamptz;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  v_from_ts := CASE WHEN v_from_day IS NULL THEN NULL ELSE v_from_day::timestamp AT TIME ZONE 'UTC' END;

  -- MONEY IS A PER-ROW DECISION (2026-10-19). The same rule as
  -- ca_club_roster_access(p_club_id, target) IN ('staff','downline','service'),
  -- evaluated once per call instead of once per row: platform admin, union
  -- overseer and exact-club owner/co_owner/admin see every row; an exact-club
  -- agent sees themself and their active downline; everyone else sees identity
  -- and presence only. Balance, hands, Win/Loss and last active are NULL, and
  -- sorting by them cannot rank rows the viewer may not see.
  IF v_service THEN
    v_all := true;
  ELSIF v_actor IS NOT NULL THEN
    v_all := EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND coalesce(p.is_admin, false))
      OR coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false)
      OR EXISTS (SELECT 1 FROM public.club_members a
                  WHERE a.user_id = v_actor AND a.club_id = p_club_id
                    AND a.role IN ('owner', 'co_owner', 'admin')
                    AND coalesce(a.status, 'approved') IN ('active', 'approved'));
    IF NOT v_all THEN
      v_agent := EXISTS (SELECT 1 FROM public.club_members a
                          WHERE a.user_id = v_actor AND a.club_id = p_club_id
                            AND a.role IN ('super_agent', 'agent', 'sub_agent')
                            AND coalesce(a.status, 'approved') IN ('active', 'approved'));
    END IF;
  END IF;

  RETURN QUERY
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT cm.agent_id AS parent, cm.user_id AS child
      FROM public.club_members cm
     WHERE v_agent AND cm.club_id = p_club_id AND cm.agent_id IS NOT NULL
       AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = v_actor
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child WHERE t.depth < 20
  ), downline AS MATERIALIZED (
    SELECT DISTINCT t.child AS uid FROM tree t
    UNION SELECT v_actor WHERE v_agent
  ), seated AS MATERIALIZED (
    -- Union tables file their seats under the member's club (ts.club_id), not
    -- the table's own club; count both, as ca_club_roster_rows does.
    SELECT DISTINCT live.uid
      FROM (
        SELECT ts.user_id AS uid
          FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id
          FROM public.tables t JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id AND t.status IN ('waiting', 'running')
      ) live
  ), roster AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS uid,
           coalesce(cm.role, 'member') AS m_role,
           coalesce(cm.status, 'approved') AS m_status,
           coalesce(cm.joined_at, cm.created_at) AS m_joined,
           cm.chip_balance::numeric AS m_chip,
           cm.last_active_at AS m_last_active_at,
           coalesce(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), cm.display_name, 'Player') AS m_name,
           pr.avatar_url AS m_avatar,
           (v_may_see AND coalesce(pr.is_horse, false)) AS m_horse,
           (s.uid IS NOT NULL
            OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')) AS m_online,
           greatest(pr.last_login, pr.last_seen, cm.last_active_at) AS m_last_active,
           (v_all OR d.uid IS NOT NULL) AS sensitive
      FROM public.club_members cm
      LEFT JOIN public.profiles pr ON pr.id = cm.user_id
      LEFT JOIN seated s ON s.uid = cm.user_id
      LEFT JOIN downline d ON d.uid = cm.user_id
     WHERE cm.club_id = p_club_id
       AND (NOT v_agent OR d.uid IS NOT NULL)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
       AND pr.status IS DISTINCT FROM 'deleted'
       AND (v_search IS NULL
            OR coalesce(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), cm.display_name, '') ILIKE '%' || v_search || '%')
       AND (v_role IS NULL OR coalesce(cm.role, 'member') = v_role)
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), facts AS MATERIALIZED (
    -- Funded-club daily facts, as ca_club_roster_rows and the member record read them.
    SELECT f.user_id AS uid,
           sum(f.hands)::bigint AS hands,
           coalesce(sum(f.net) FILTER (WHERE NOT f.is_mtt), 0) AS cash_net
      FROM public.member_record_daily_facts f
      JOIN roster r ON r.uid = f.user_id AND r.sensitive
     WHERE f.club_id = p_club_id
       AND f.accounting_cutoff IS NOT DISTINCT FROM v_cutoff
       AND (v_from_day IS NULL OR f.played_on >= v_from_day)
     GROUP BY f.user_id
  ), mtt_all AS MATERIALIZED (
    -- Only a Win/Loss ranking needs every visible row's tournament money; it
    -- reads ca_club_member_tournament_money itself, so the figure is the one
    -- the member record shows. Any other sort prices only the page below.
    SELECT r.uid, public.ca_club_member_tournament_money(p_club_id, r.uid, v_from_ts, NULL) AS net
      FROM roster r
     WHERE v_sort = 'profit' AND r.sensitive
  ), shaped AS MATERIALIZED (
    SELECT r.*,
           CASE WHEN r.sensitive THEN coalesce(fa.hands, 0) END AS v_hands,
           CASE WHEN r.sensitive THEN coalesce(fa.cash_net, 0) END AS v_cash,
           CASE WHEN r.sensitive THEN round(coalesce(fa.cash_net, 0) + coalesce(m.net, 0), 2) END AS v_rank_profit
      FROM roster r
      LEFT JOIN facts fa ON fa.uid = r.uid
      LEFT JOIN mtt_all m ON m.uid = r.uid
  ), counted AS (SELECT count(*) AS n FROM shaped),
  ordered AS MATERIALIZED (
    SELECT x.*,
           row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'profit' THEN x.v_rank_profit END DESC NULLS LAST,
             CASE WHEN v_sort = 'hands'  THEN x.v_hands END DESC NULLS LAST,
             CASE WHEN v_sort = 'joined' THEN x.m_joined END DESC NULLS LAST,
             CASE WHEN v_sort = 'last_active' THEN CASE WHEN x.sensitive THEN x.m_last_active END END DESC NULLS LAST,
             CASE WHEN v_sort = 'name'   THEN lower(x.m_name) END ASC NULLS LAST,
             x.m_joined DESC NULLS LAST,
             x.uid) AS rn
      FROM shaped x
  ), page AS MATERIALIZED (
    SELECT o.* FROM ordered o
     WHERE o.rn >  greatest(coalesce(p_offset, 0), 0)
       AND o.rn <= greatest(coalesce(p_offset, 0), 0) + least(greatest(coalesce(p_limit, 50), 1), 200)
  )
  SELECT
    pg.uid, pg.m_name, pg.m_avatar, pg.m_horse, pg.m_online, pg.m_role, pg.m_status, pg.m_joined,
    CASE WHEN pg.sensitive THEN pg.m_last_active END,
    CASE WHEN pg.sensitive THEN coalesce(pg.m_chip, 0) END,
    pg.v_hands::bigint,
    CASE WHEN NOT pg.sensitive THEN NULL
         WHEN v_sort = 'profit' THEN pg.v_rank_profit
         ELSE round(pg.v_cash + public.ca_club_member_tournament_money(p_club_id, pg.uid, v_from_ts, NULL), 2)
    END,
    c.n
  FROM page pg
  CROSS JOIN counted c
  ORDER BY pg.rn;
END;
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('ca_club_members_summary(uuid)'::regprocedure)) <> '01de077ea6b12d6db6dde17c5b260123' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_club_members_summary'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_club_members_summary(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_viewer_role text := 'player';
  v_has_agent_scope boolean := false;
  v_has_staff_scope boolean := false;
  v_can_export boolean := false;
  v_out jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin FROM public.profiles p WHERE p.id = v_actor;
    v_platform_admin := coalesce(v_platform_admin, false);
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  IF NOT v_service AND NOT v_platform_admin AND NOT v_union_staff THEN
    SELECT cm.role
      INTO v_viewer_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC
     LIMIT 1;
    IF v_viewer_role IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF v_platform_admin OR v_union_staff OR v_service THEN
    v_viewer_role := 'owner';
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
              AND cm.role IN ('super_agent', 'agent', 'sub_agent')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ),
         EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
              AND cm.role IN ('owner', 'co_owner', 'admin')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         )
    INTO v_has_agent_scope, v_has_staff_scope;

  v_can_export := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  );

  WITH base AS MATERIALIZED (
    -- THIS club, as ca_club_roster_rows counts it since 2026-09-01. The
    -- scope above still decides who the VIEWER is; it no longer decides
    -- what is counted.
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.role, public.fn_club_role_rank(cm.role) AS role_rank,
           cm.updated_at
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
       AND (COALESCE(public.fn_club_cashier_scope(p_club_id),'none') <> 'downline'
            OR public.fn_can_read_club_member_data(p_club_id,cm.user_id))
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT live.user_id
      FROM (
        SELECT ts.user_id
          FROM public.table_seats ts
          JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id
          FROM public.tables t
          JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
      ) live
  )
  SELECT jsonb_build_object(
    'viewer_role', coalesce(v_viewer_role, 'player'),
    'capabilities', jsonb_build_object(
      'can_view_financials', v_service OR v_platform_admin OR v_union_staff
                              OR v_has_staff_scope OR v_has_agent_scope,
      'can_export', v_can_export,
      'can_manage_members', v_service OR v_platform_admin OR v_union_staff OR v_has_staff_scope,
      'can_view_notes', v_service OR v_platform_admin OR v_union_staff
                        OR v_has_staff_scope OR v_has_agent_scope
    ),
    'counts', jsonb_build_object(
      'total', count(*),
      'online', count(*) FILTER (
        WHERE s.user_id IS NOT NULL
           OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
      ),
      'seated', count(*) FILTER (WHERE s.user_id IS NOT NULL),
      'agents', count(*) FILTER (WHERE b.role IN ('super_agent', 'agent', 'sub_agent')),
      'admins', count(*) FILTER (WHERE b.role IN ('owner', 'co_owner', 'admin'))
    ),
    'data_version', max(b.updated_at),
    'page_size', 80
  ) INTO v_out
  FROM base b
  LEFT JOIN seated s ON s.user_id = b.user_id
  LEFT JOIN public.profiles pr ON pr.id = b.user_id
  WHERE pr.status IS DISTINCT FROM 'deleted';

  RETURN v_out;
END;
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('ca_club_operations_overview(uuid)'::regprocedure)) <> '01c73dca9390ffe5b6450c122e8f4e5a' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_club_operations_overview'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_club_operations_overview(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role              text;
  v_platform          boolean;
  v_internal          boolean;
  v_staff             boolean;
  v_finance           boolean;
  v_control           boolean;
  v_name              text;
  v_slug              text;
  v_treasury          numeric;
  v_locked            boolean;
  v_members           bigint;
  v_pending           bigint;
  v_new7              bigint;
  v_member_chips      numeric;
  v_online            bigint;
  v_seated            bigint;
  v_live_tables       bigint;
  v_running_tables    bigint;
  v_waiting_tables    bigint;
  v_reg_tourneys      bigint;
  v_run_tourneys      bigint;
  v_hands_today       bigint := 0;
  v_rake_today        numeric := 0;
  v_reports           bigint;
  v_disputes          bigint;
  v_disputes_aged     bigint;
  v_blacklist         bigint;
  v_blacklist_expired bigint;
  v_chip_requests     bigint;
  v_cashouts          bigint;
  v_credit            bigint;
  v_invoices          bigint;
  v_invoices_overdue  bigint;
  v_tickets           bigint;
  v_flags             bigint;
  v_alerts            jsonb := '[]'::jsonb;
  v_kpis              jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'a club id is required' USING ERRCODE = '22004';
  END IF;

  SELECT c.name, c.slug, coalesce(c.chip_treasury, 0), coalesce(c.settlement_locked, false)
    INTO v_name, v_slug, v_treasury, v_locked
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'club not found' USING ERRCODE = 'P0002';
  END IF;

  v_internal := session_user IN ('postgres', 'supabase_admin')
             OR coalesce(auth.role(), '') = 'service_role';
  v_platform := coalesce(fn_is_platform_admin(), false);
  v_role     := coalesce(fn_club_bank_role(p_club_id), '');

  v_staff := v_internal OR v_platform
             OR v_role IN ('owner', 'co_owner', 'admin');

  IF NOT v_staff THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  v_finance := v_internal OR v_platform
               OR v_role IN ('owner', 'co_owner', 'admin');
  v_control := v_internal OR v_platform
               OR v_role IN ('owner', 'co_owner', 'admin');

  SELECT count(DISTINCT cm.user_id) FILTER (
           WHERE coalesce(cm.status, 'approved') IN ('active', 'approved')
             AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')),
         count(*) FILTER (WHERE cm.status = 'pending'),
         count(DISTINCT cm.user_id) FILTER (
           WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'approved') IN ('active', 'approved')
             AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')),
         coalesce(sum(cm.chip_balance) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')), 0)
    INTO v_members, v_pending, v_new7, v_member_chips
    FROM club_members cm
   WHERE cm.club_id = p_club_id;

  SELECT count(*) FILTER (WHERE t.status IN ('running', 'waiting', 'active')),
         count(*) FILTER (WHERE t.status = 'running'),
         count(*) FILTER (WHERE t.status = 'waiting')
    INTO v_live_tables, v_running_tables, v_waiting_tables
    FROM tables t
   WHERE t.club_id = p_club_id;

  SELECT count(DISTINCT ts.user_id)
    INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND t.status IN ('running', 'waiting')
     AND EXISTS (SELECT 1 FROM club_members cm
                  WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                    AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
     AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted');

  SELECT count(*)
    INTO v_online
    FROM (
      SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
       WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
         AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND t.status IN ('running', 'waiting')
         AND EXISTS (SELECT 1 FROM club_members cm
                      WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                        AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
         AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted')
      UNION
      SELECT cm.user_id
        FROM club_members cm
       WHERE cm.club_id = p_club_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')
         AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
    ) x;

  SELECT count(*) FILTER (WHERE tr.status = 'REGISTERING'),
         count(*) FILTER (WHERE tr.status IN ('RUNNING', 'COMPLETING'))
    INTO v_reg_tourneys, v_run_tourneys
    FROM tournaments tr
   WHERE tr.club_id = p_club_id
     AND tr.status IN ('REGISTERING', 'RUNNING', 'COMPLETING');

  SELECT coalesce((
           SELECT d.hands FROM club_hand_daily d
            WHERE d.club_id = p_club_id
              AND d.stat_date = (now() AT TIME ZONE 'UTC')::date), 0),
         coalesce((
           SELECT d.rake FROM ca_club_rake_daily d
            WHERE d.club_id = p_club_id
              AND d.stat_date = (now() AT TIME ZONE 'UTC')::date), 0)
    INTO v_hands_today, v_rake_today;

  SELECT count(*)
    INTO v_reports
    FROM user_reports r
   WHERE coalesce(r.status, 'pending') = 'pending'
     AND EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = r.reported_user_id);

  SELECT count(*), count(*) FILTER (WHERE d.created_at < now() - interval '72 hours')
    INTO v_disputes, v_disputes_aged
    FROM disputes d
   WHERE d.club_id = p_club_id
     AND coalesce(d.status, 'open') IN ('open', 'under_review', 'escalated');

  SELECT count(*) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()),
         count(*) FILTER (WHERE b.expires_at IS NOT NULL AND b.expires_at <= now())
    INTO v_blacklist, v_blacklist_expired
    FROM blacklists b
   WHERE b.club_id = p_club_id;

  SELECT count(*)
    INTO v_chip_requests
    FROM chip_requests q
   WHERE q.club_id = p_club_id AND coalesce(q.status, 'pending') = 'pending';

  SELECT count(*)
    INTO v_cashouts
    FROM cashout_requests q
   WHERE q.club_id = p_club_id
     AND q.completed_at IS NULL
     AND q.cancelled_at IS NULL
     AND coalesce(q.status, 'pending') NOT IN ('completed', 'cancelled', 'rejected', 'failed');

  SELECT count(*)
    INTO v_credit
    FROM credit_requests q
   WHERE q.club_id = p_club_id AND coalesce(q.status, 'pending') = 'pending';

  SELECT count(*), count(*) FILTER (WHERE i.due_at IS NOT NULL AND i.due_at < now())
    INTO v_invoices, v_invoices_overdue
    FROM settlement_invoices i
   WHERE i.club_id = p_club_id
     AND coalesce(i.status, 'generated') NOT IN ('paid', 'settled', 'cancelled', 'void');

  SELECT count(*)
    INTO v_tickets
    FROM tournament_tickets tk
   WHERE tk.club_id = p_club_id
     AND tk.redeemed_at IS NULL
     AND tk.cancelled_at IS NULL
     AND coalesce(tk.status, 'issued') NOT IN ('redeemed', 'cancelled', 'expired');

  SELECT count(*)
    INTO v_flags
    FROM anti_cheat_flags f
   WHERE coalesce(f.status, 'open') = 'open'
     AND (f.club_id = p_club_id OR
          (f.club_id IS NULL AND EXISTS (
             SELECT 1 FROM club_members cm
              WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id)));

  IF v_finance AND v_invoices_overdue > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'invoices-overdue', 'severity', 'critical', 'tool', 'settlement',
      'title', 'Invoices Past Due', 'count', v_invoices_overdue));
  END IF;

  IF v_disputes_aged > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'disputes-aged', 'severity', 'critical', 'tool', 'disputes',
      'title', 'Disputes Past Seventy Two Hours', 'count', v_disputes_aged));
  ELSIF v_disputes > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'disputes-open', 'severity', 'warning', 'tool', 'disputes',
      'title', 'Disputes Open', 'count', v_disputes));
  END IF;

  IF v_chip_requests > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'chip-requests', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Chip Requests Waiting', 'count', v_chip_requests));
  END IF;

  IF v_cashouts > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'cashouts', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Cash Out Requests Waiting', 'count', v_cashouts));
  END IF;

  IF v_credit > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'credit-requests', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Credit Requests Waiting', 'count', v_credit));
  END IF;

  IF v_pending > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'join-requests', 'severity', 'warning', 'tool', 'players',
      'title', 'Membership Requests Waiting', 'count', v_pending));
  END IF;

  IF v_reports > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'reports-open', 'severity', 'warning', 'tool', 'reports',
      'title', 'Player Reports To Review', 'count', v_reports));
  END IF;

  IF v_flags > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'anti-cheat-flags', 'severity', 'warning', 'tool', 'anti-cheat',
      'title', 'Integrity Flags Open', 'count', v_flags));
  END IF;

  IF v_finance AND v_treasury <= 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'club-bank-empty', 'severity', 'warning', 'tool', 'cashier',
      'title', 'The Club Bank Is Empty', 'count', 0));
  END IF;

  IF v_locked THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'settlement-locked', 'severity', 'info', 'tool', 'settlement',
      'title', 'Settlement Is Locked', 'count', 0));
  END IF;

  IF v_blacklist_expired > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'blacklist-expired', 'severity', 'info', 'tool', 'blacklist',
      'title', 'Expired Exclusions To Clear', 'count', v_blacklist_expired));
  END IF;

  v_kpis := jsonb_build_object(
    'members', v_members,
    'members_pending', v_pending,
    'members_new_7d', v_new7,
    'online_now', v_online,
    'seated_now', v_seated,
    'live_tables', v_live_tables,
    'running_tables', v_running_tables,
    'waiting_tables', v_waiting_tables,
    'tournaments_registering', v_reg_tourneys,
    'tournaments_running', v_run_tourneys,
    'hands_today', v_hands_today);

  IF v_finance THEN
    v_kpis := v_kpis || jsonb_build_object(
      'rake_today', v_rake_today,
      'club_bank', v_treasury,
      'member_chips', v_member_chips);
  END IF;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'club', jsonb_build_object('id', p_club_id, 'name', v_name, 'slug', v_slug),
    'viewer', jsonb_build_object(
      'role', nullif(v_role, ''),
      'is_platform_staff', v_platform,
      'can_view_finance', v_finance,
      'can_control_club', v_control),
    'kpis', v_kpis,
    'counts', jsonb_build_object(
      'members', v_members,
      'members_pending', v_pending,
      'reports_open', v_reports,
      'disputes_open', v_disputes,
      'disputes_aged', v_disputes_aged,
      'blacklist_active', v_blacklist,
      'blacklist_expired', v_blacklist_expired,
      'chip_requests_pending', v_chip_requests,
      'cashouts_pending', v_cashouts,
      'credit_requests_pending', v_credit,
      'invoices_open', CASE WHEN v_finance THEN v_invoices ELSE NULL END,
      'invoices_overdue', CASE WHEN v_finance THEN v_invoices_overdue ELSE NULL END,
      'tickets_outstanding', v_tickets,
      'anti_cheat_flags_open', v_flags),
    'alerts', v_alerts,
    'settlement_locked', v_locked);
END;
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_actor_can_manage_club_treasury(uuid)'::regprocedure)) <> '025730437384031d5aa7e00ed44c7b99' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_actor_can_manage_club_treasury'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_actor_can_manage_club_treasury(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 SELECT public.fn_caller_is_engine() OR COALESCE(public.fn_can_use_club_bank(p_club_id),false);
$function$;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_ca_is_club_staff(uuid,uuid)'::regprocedure)) <> '221c1f757099ef53e55a485d9d8807e8' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_ca_is_club_staff'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_is_club_staff(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = p_club_id
        AND m.user_id = p_user_id
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin')
    )
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id)
  );
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) <> '1b1312459ecc90069375d8bcdb3127ca' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: fn_club_trade_ledger'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  -- Cashier exposes 250 rows and requests one sentinel row to decide whether
  -- another page exists. Preserve the established bounded RPC contract.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_role IN ('owner', 'co_owner', 'admin') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSIF v_role IN ('super_agent', 'agent', 'sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id IN (SELECT user_id FROM dl)
         OR ct.to_user_id IN (SELECT user_id FROM dl))
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  END IF;
END
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('ca_club_roster_access(uuid,uuid)'::regprocedure)) <> 'fa636bb783c7ebf3ab5e436d0fa948f4' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_club_roster_access'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_club_roster_access(p_club_id uuid, p_target_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), 'service_role') = 'service_role';
BEGIN
  IF p_club_id IS NULL OR p_target_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.club_members target
     WHERE target.user_id = p_target_user_id AND target.club_id = p_club_id
       AND COALESCE(target.status, 'approved') IN ('active', 'approved')
  ) THEN RETURN 'none'; END IF;
  IF v_service THEN RETURN 'service'; END IF;
  IF v_actor IS NULL THEN RETURN 'none'; END IF;
  IF public.fn_club_cashier_scope(p_club_id) = 'downline'
     AND NOT public.fn_can_read_club_member_data(p_club_id,p_target_user_id) THEN RETURN 'none'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND COALESCE(p.is_admin, false))
     OR COALESCE(public.fn_is_union_overseer(p_club_id, v_actor), false)
  THEN RETURN 'staff'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND actor.role IN ('owner','co_owner','admin')
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN RETURN 'staff'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND actor.role IN ('super_agent','agent','sub_agent')
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN
    IF p_target_user_id = v_actor THEN RETURN 'downline'; END IF;
    IF EXISTS (
      WITH RECURSIVE edges AS (
        SELECT cm.agent_id parent, cm.user_id child
          FROM public.club_members cm
         WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL
           AND cm.agent_id <> cm.user_id
           AND COALESCE(cm.status, 'approved') IN ('active','approved')
      ), tree AS (
        SELECT e.child, 1 depth FROM edges e WHERE e.parent = v_actor
        UNION ALL
        SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child
         WHERE t.depth < 20
      ) SELECT 1 FROM tree WHERE child = p_target_user_id
    ) THEN RETURN 'downline'; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN RETURN 'identity'; END IF;
  RETURN 'none';
END;
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('ca_club_roster_rows(uuid)'::regprocedure)) <> '98f7b6ddb7574717260158e7346a0716' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: ca_club_roster_rows'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.ca_club_roster_rows(p_club_id uuid)
 RETURNS TABLE(user_id uuid, management_club_id uuid, home_club_id uuid, home_club_name text, player_number text, alias text, username text, display_name text, avatar_url text, role text, role_rank integer, is_online boolean, is_seated boolean, chip_balance numeric, player_wallet numeric, agent_wallet numeric, promo_wallet numeric, total_fees numeric, downline_fees numeric, total_hands bigint, downline_direct integer, downline_total integer, upline_user_id uuid, upline_name text, joined_at timestamp with time zone, last_login timestamp with time zone, nickname text, remark text, can_view_financials boolean, can_view_notes boolean, in_viewer_downline boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_needs_hierarchy boolean := false;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin
      FROM public.profiles p
     WHERE p.id = v_actor;
    v_platform_admin := coalesce(v_platform_admin, false);
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  v_needs_hierarchy := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members viewer
     WHERE viewer.user_id = v_actor
       AND viewer.club_id = p_club_id
       AND viewer.role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent')
       AND coalesce(viewer.status, 'approved') IN ('active', 'approved')
  );

  IF NOT v_service
     AND NOT v_platform_admin
     AND NOT v_union_staff
     AND (
       v_actor IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.club_members actor
          WHERE actor.user_id = v_actor
            AND actor.club_id = p_club_id
            AND coalesce(actor.status, 'approved') IN ('active', 'approved')
       )
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE base AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS m_user_id,
           cm.club_id AS m_club_id,
           cm.role AS m_role,
           cm.agent_id AS m_agent_id,
           cm.chip_balance AS m_chip_balance,
           cm.promo_balance AS m_promo_balance,
           cm.joined_at AS m_joined_at,
           cm.last_active_at AS m_last_active_at,
           cm.nickname AS m_nickname,
           cm.notes AS m_notes,
           cm.display_name AS m_display_name,
           public.fn_club_role_rank(cm.role) AS m_rank
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
       AND (COALESCE(public.fn_club_cashier_scope(p_club_id),'none') <> 'downline'
            OR public.fn_can_read_club_member_data(p_club_id,cm.user_id))
     ORDER BY cm.user_id,
              public.fn_club_role_rank(cm.role) DESC,
              cm.joined_at ASC,
              cm.club_id
  ),
  edges AS MATERIALIZED (
    SELECT DISTINCT cm.agent_id AS parent, cm.user_id AS child
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.agent_id IS NOT NULL
       AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  closure AS MATERIALIZED (
    SELECT e.parent AS root, e.child AS descendant, 1 AS depth FROM edges e WHERE v_needs_hierarchy
    UNION ALL
    SELECT c.root, e.child, c.depth + 1
      FROM closure c
      JOIN edges e ON e.parent = c.descendant
     WHERE c.depth < 20
  ),
  viewer_tree AS MATERIALIZED (
    SELECT DISTINCT c.descendant AS uid
      FROM closure c
     WHERE c.root = v_actor
  ),
  downlines AS MATERIALIZED (
    SELECT c.root AS uid,
           count(DISTINCT c.descendant) FILTER (WHERE c.depth = 1)::int AS direct_count,
           count(DISTINCT c.descendant)::int AS total_count
      FROM closure c
      LEFT JOIN public.profiles downline_profile ON downline_profile.id = c.descendant
     WHERE downline_profile.status IS DISTINCT FROM 'deleted'
     GROUP BY c.root
  ),
  staff_clubs AS MATERIALIZED (
    SELECT DISTINCT cm.club_id
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  staff_targets AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS uid
      FROM public.club_members cm
     WHERE cm.club_id IN (SELECT sc.club_id FROM staff_clubs sc)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  viewer_agent AS MATERIALIZED (
    SELECT EXISTS (
      SELECT 1
        FROM public.club_members cm
       WHERE cm.user_id = v_actor
         AND cm.club_id = p_club_id
         AND cm.role IN ('super_agent', 'agent', 'sub_agent')
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
    ) AS yes
  ),
  access AS MATERIALIZED (
    SELECT b.m_user_id AS uid,
           (
             v_service OR v_platform_admin OR v_union_staff
             OR st.uid IS NOT NULL
             OR vt.uid IS NOT NULL
             OR (b.m_user_id = v_actor AND va.yes)
           ) AS sensitive,
           (vt.uid IS NOT NULL) AS is_downline
      FROM base b
      CROSS JOIN viewer_agent va
      LEFT JOIN staff_targets st ON st.uid = b.m_user_id
      LEFT JOIN viewer_tree vt ON vt.uid = b.m_user_id
  ),
  seated AS MATERIALIZED (
    SELECT DISTINCT live.uid
      FROM (
        SELECT ts.user_id AS uid
          FROM public.table_seats ts
          JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id AS uid
          FROM public.tables t
          JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
      ) live
  ),
  member_wallets AS MATERIALIZED (
    SELECT cm.user_id AS uid,
           sum(coalesce(cm.chip_balance, 0)) AS player_total,
           sum(coalesce(cm.promo_balance, 0)) AS member_promo_total
      FROM public.club_members cm
      JOIN base b ON b.m_user_id = cm.user_id
      JOIN access ac ON ac.uid = cm.user_id AND ac.sensitive
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     GROUP BY cm.user_id
  ),
  agent_wallets AS MATERIALIZED (
    SELECT a.user_id AS uid,
           sum(coalesce(a.agent_wallet_balance, 0)) AS agent_total,
           sum(coalesce(a.promo_wallet_balance, 0)) AS agent_promo_total
      FROM public.agents a
      JOIN base b ON b.m_user_id = a.user_id
      JOIN access ac ON ac.uid = a.user_id AND ac.sensitive
     WHERE a.club_id = p_club_id
       AND coalesce(a.status, 'active') = 'active'
     GROUP BY a.user_id
  ),
  fees AS MATERIALIZED (
    SELECT coalesce(lf.user_id, h.user_id) AS uid,
           coalesce(lf.total_fees, 0) AS fee_total,
           coalesce(h.hands, 0) AS hand_total
      FROM public.ca_club_member_fee_totals(p_club_id) lf
      FULL JOIN (
        SELECT r.user_id, sum(r.hands)::bigint AS hands
          FROM public.member_record_daily_facts r
         WHERE r.club_id = p_club_id
           AND r.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)
         GROUP BY r.user_id
      ) h ON h.user_id = lf.user_id
      JOIN access ac ON ac.uid = coalesce(lf.user_id, h.user_id) AND ac.sensitive
  ),
  downline_fee_totals AS MATERIALIZED (
    SELECT c.root AS uid, sum(f.fee_total) AS fee_total
      FROM closure c
      JOIN fees f ON f.uid = c.descendant
     GROUP BY c.root
  )
  SELECT
    b.m_user_id,
    b.m_club_id,
    b.m_club_id,
    cl.name::text,
    pr.player_number::text,
    coalesce(nullif(btrim(pr.alias), ''), nullif(btrim(b.m_display_name), ''),
             nullif(btrim(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name)), ''), pr.username)::text,
    coalesce(pr.username, '')::text,
    coalesce(nullif(btrim(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name)), ''), pr.username)::text,
    coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url)::text,
    b.m_role::text,
    b.m_rank,
    (s.uid IS NOT NULL)
      OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'),
    (s.uid IS NOT NULL),
    CASE WHEN ac.sensitive THEN coalesce(b.m_chip_balance, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(mw.player_total, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(aw.agent_total, 0) END,
    CASE WHEN ac.sensitive
         THEN coalesce(mw.member_promo_total, 0) + coalesce(aw.agent_promo_total, 0) END,
    CASE WHEN ac.sensitive THEN round(coalesce(f.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN round(coalesce(df.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN coalesce(f.hand_total, 0)::bigint END,
    CASE WHEN ac.sensitive THEN coalesce(d.direct_count, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(d.total_count, 0) END,
    CASE WHEN ac.sensitive THEN b.m_agent_id END,
    CASE WHEN ac.sensitive THEN up.upline_name END,
    b.m_joined_at,
    CASE WHEN ac.sensitive
         THEN greatest(pr.last_login, pr.last_seen, b.m_last_active_at) END,
    CASE WHEN ac.sensitive THEN b.m_nickname::text END,
    CASE WHEN ac.sensitive THEN b.m_notes::text END,
    ac.sensitive,
    ac.sensitive,
    ac.is_downline
  FROM base b
  JOIN access ac ON ac.uid = b.m_user_id
  LEFT JOIN public.profiles pr ON pr.id = b.m_user_id
  LEFT JOIN public.clubs cl ON cl.id = b.m_club_id
  LEFT JOIN seated s ON s.uid = b.m_user_id
  LEFT JOIN member_wallets mw ON mw.uid = b.m_user_id
  LEFT JOIN agent_wallets aw ON aw.uid = b.m_user_id
  LEFT JOIN fees f ON f.uid = b.m_user_id
  LEFT JOIN downlines d ON d.uid = b.m_user_id
  LEFT JOIN downline_fee_totals df ON df.uid = b.m_user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''), nullif(btrim(public.fn_arena_name(u.alias, u.username, u.display_name, u.first_name, u.last_name, u.full_name)), ''), u.username)::text AS upline_name
      FROM public.profiles u
     WHERE u.id = b.m_agent_id
       AND u.status IS DISTINCT FROM 'deleted'
  ) up ON true
  WHERE pr.status IS DISTINCT FROM 'deleted';
END;
$function$
;


DO $$ BEGIN IF md5(pg_get_functiondef('get_club_home(text)'::regprocedure)) <> 'a81d488c364fd20d7015a7bae2b774e4' THEN RAISE EXCEPTION 'AGENT_BOUNDARY_SOURCE_CHANGED: get_club_home'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club           record;
  v_uid            uuid := auth.uid();
  v_union_id       uuid;
  v_union_club_ids uuid[];
  v_member_count   integer;
  v_playing        integer;
  v_membership     jsonb;
  v_tables         jsonb;
  v_tournaments    jsonb;
  v_bbj            jsonb;
  v_club_names     jsonb;
BEGIN
  DECLARE v_access jsonb;
  BEGIN
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('found',false,'reason','authentication_required'); END IF;
    v_access := public.fn_poker_arena_context(p_club_key);
    IF v_access IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
    IF v_access->'arena'->>'asset'='diamonds' THEN
      RETURN jsonb_build_object('found',true,'access_only',true,'arena_context',v_access);
    END IF;
    IF NOT coalesce((v_access->>'member')::boolean,false) THEN
      RETURN jsonb_build_object('found',false,'reason','membership_required');
    END IF;
  END;
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT id, union_id, club_id, name, description, avatar_url, logo_url, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at INTO v_club FROM public.clubs WHERE id = p_club_key::uuid LIMIT 1;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT id, union_id, club_id, name, description, avatar_url, logo_url, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at INTO v_club FROM public.clubs WHERE club_id = p_club_key::integer LIMIT 1;
  ELSE
    SELECT id, union_id, club_id, name, description, avatar_url, logo_url, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at INTO v_club FROM public.clubs WHERE slug = p_club_key LIMIT 1;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;
  IF v_union_id IS NULL THEN
    v_union_id := v_club.union_id;
  END IF;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;
  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[]::uuid[]) || v_club.id;

  -- THIS CLUB'S MEMBERS. Not the union's. See the header.
  -- 2026-09-02: through the definer helper. Under club_members RLS this COUNT
  -- evaluated four policy functions per member row - 2,026 ms for Deep Stack
  -- Society - and, called ~70x/min by the lobby, was 26% of all database time.
  v_member_count := public.fn_club_member_count(v_club.id);

  -- Everyone in a seat at a live table, right now, anywhere on the platform.
  -- Counted from the seats, never from clubs.online_count.
  SELECT count(DISTINCT ts.user_id)::int INTO v_playing
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running')
    AND public.fn_club_home_in_scope(
          tb.club_id, tb.is_private, tb.union_id,
          v_union_id, v_club.id, v_union_club_ids);

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  -- id -> name for every club whose games can appear on this board.
  SELECT COALESCE(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb) INTO v_club_names
  FROM public.clubs c WHERE c.id = ANY (v_union_club_ids);

  -- A LIVE GAME MUST NEVER BE TRUNCATED AWAY (2026-09-02, same rule as
  -- TableService.getClubTables in #2696): occupancy first, so the 200-row cap
  -- can only ever trim EMPTY tables. Ordered by created_at alone, Deep Stack
  -- Society's 1,058 open tables put its 51 running games behind the 200
  -- newest empty ones and the lobby read "0/x OPEN" all the way down.
  SELECT COALESCE(jsonb_agg(t ORDER BY t.current_players DESC, t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, created_at, club_id,
           run_it_twice, run_it_twice_enabled, allow_run_it_twice, run_it_mode,
           insurance_enabled, straddle_enabled, straddle_type, auto_utg_straddle,
           bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_variant, bomb_pot_ante_multiplier, bomb_pot_ante_fixed,
           ante_enabled, ante, seven_deuce_enabled, seven_deuce_amount,
           time_bank_enabled, all_in_or_fold,
           cap_enabled, cap_bb, no_rathole, pineapple_holdem,
           is_anonymous, ban_chat, restrict_observers, auto_start_players,
           is_vip_only, label_as_new, is_featured, hide_club_name,
           nit_game, career_percent_min, maintain_percent_min, maintain_hands,
           -- R10 (Dan 2026-09-04): a must-move game shows how many players are
           -- INSIDE THE GAME, like a tournament counter, never a per-table x/6.
           -- The lobby collapses a cluster to its Main 1 row and paints these.
           cluster_id, role, main_index, lifecycle,
           (SELECT g.must_move FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_must_move,
           (SELECT g.template_name FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_template,
           (SELECT g.state FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_state,
           -- ONE DEFINITION (20260906163151). Both of these carry the SAME
           -- predicate as fn_cash_cluster_census, which is what the
           -- controller decides the game's shape from. They did not: the
           -- player count filtered neither is_deleted nor status, so a seat
           -- on a table this very function did not count as a table was
           -- still counted as a player.
           (SELECT count(*) FROM public.table_seats ts JOIN public.tables t2 ON t2.id = ts.table_id
             WHERE t2.cluster_id = tb.cluster_id AND ts.left_at IS NULL
               AND COALESCE(t2.is_deleted, false) = false
               AND t2.status IN ('waiting','running','active')
               AND t2.lifecycle <> 'closed')::int AS cluster_players,
           (SELECT count(*) FROM public.tables t2
             WHERE t2.cluster_id = tb.cluster_id
               AND COALESCE(t2.is_deleted, false) = false
               AND t2.status IN ('waiting','running','active')
               AND t2.lifecycle <> 'closed')::int AS cluster_tables
    FROM public.tables tb
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
      AND COALESCE(lifecycle, 'live') <> 'closed'
      AND tournament_id IS NULL
      AND COALESCE(is_template, false) = false
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY current_players DESC, created_at DESC LIMIT 200
  ) t;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, variant, table_size, buy_in_amount, buy_in_fee,
           guaranteed_prize, start_time, status, current_players, max_players, format_contract,
           starting_chips, club_id, union_id, is_xmtt, late_reg_mins,
           late_reg_levels, started_at, current_level,
           is_vip_only, label_as_new, hide_club_name, is_pinned
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON')
      -- THE PUBLISHED WINDOW (2026-08-26). Everything already under way or
      -- starting inside 48 hours, plus anything above a 200 total buy-in for
      -- 6 days. The client applies the identical rule row by row
      -- (src/utils/tournamentScheduleWindow.ts); this bound exists so the
      -- LIMIT below can never be what decides, since a running event's
      -- start_time is in the past and therefore sorts ahead of the whole
      -- future card.
      AND start_time <= now() + interval '72 hours'
             + CASE
                 WHEN COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) >= 200
                   THEN interval '3 days'
                 ELSE interval '0'
               END
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 500
  ) x;

  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance) INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id END
  ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'club', jsonb_build_object(
      'id', v_club.id,
      'club_id', v_club.club_id,
      'name', v_club.name,
      'description', v_club.description,
      'avatar_url', v_club.avatar_url,
      'logo_url', v_club.logo_url,
      'member_count', v_member_count,
      'online_count', v_playing,
      'owner_id', v_club.owner_id,
      'level', v_club.level,
      'hierarchy_units_rounded_up', v_club.hierarchy_units_rounded_up,
      'player_threshold_current', v_club.player_threshold_current,
      'player_threshold_next', v_club.player_threshold_next,
      'hierarchy_threshold_current', v_club.hierarchy_threshold_current,
      'hierarchy_threshold_next', v_club.hierarchy_threshold_next,
      'created_at', v_club.created_at
    ),
    'membership', v_membership,
    'union_id', v_union_id,
    'union_club_ids', to_jsonb(v_union_club_ids),
    'club_names', v_club_names,
    'member_count', v_member_count,
    'players_playing', v_playing,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'bbj', v_bbj
  );
END;
$function$
;


-- Replacements preserve existing authenticated/service grants and explicitly deny anonymous callers.
REVOKE ALL ON FUNCTION public.ca_can_view_club_finances(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_assign_player_to_agent(uuid,uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_can_use_club_bank(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_scope(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_bank_reverse_core_20261004(uuid,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_bank_send_core_20261004(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_money_panel(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_members_summary(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_operations_overview(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_actor_can_manage_club_treasury(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_is_club_staff(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_club_trade_ledger(uuid,integer,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_roster_access(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_roster_rows(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.get_club_home(text) FROM PUBLIC,anon;

DO $$ BEGIN
 IF has_column_privilege('authenticated','public.clubs','chip_treasury','SELECT')
 OR has_column_privilege('anon','public.clubs','promo_balance','SELECT') THEN
 RAISE EXCEPTION 'agent boundary private column grant remains'; END IF;
 IF has_function_privilege('anon','public.fn_reassign_club_members(uuid,uuid[],uuid,uuid,uuid)','EXECUTE') THEN
 RAISE EXCEPTION 'agent assignment anonymous grant remains'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='agent_member_boundary')<>14 THEN
 RAISE EXCEPTION 'agent member policies incomplete'; END IF;
END $$;

COMMIT;
