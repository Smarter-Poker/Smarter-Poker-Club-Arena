-- Owner 2026-10-15: Send Out chooses one source and one actual recipient wallet.
-- Add explicit promo aliases without changing old clients. Preserve the original
-- exact-intent, downline, credit, transaction, ledger and reversal owners.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO d;
IF md5(d) <> '5a56023dc4b123775fa4fe7f7cb50cb8' THEN RAISE EXCEPTION 'Unexpected preimage: fn_agent_wallet_send_core_20260830'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_shortfall    numeric := 0;
  v_headroom     numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
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
  if v_dest not in ('player_wallet', 'agent_wallet', 'promo_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- THE CREDIT LINE. Dan, 2026-08-31: "IF THEY GO BELOW THE CREDIT LIMIT, THEY
  -- MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK." So the
  -- limit caps the debt outstanding, not the amount ever borrowed: an agent
  -- draws credit_limit - credit_used, and paying an invoice frees it again
  -- (fn_apply_credit_payment pays credit_used down, phase 1).
  if v_float_before < p_amount then
    v_shortfall := round(p_amount - v_float_before, 2);

    -- A prepaid agent, and an agent with no line at all, get the plain answer
    -- about their wallet. Talking about a credit line to somebody who has none
    -- is the sort of message that sends a person looking for a setting.
    if v_is_prepaid or v_credit_limit <= 0 then
      return jsonb_build_object('success', false,
        'error', 'Your Agent Wallet Only Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
        'balance', v_float_before, 'requested', p_amount,
        'prepaid', v_is_prepaid);
    end if;

    v_headroom := v_credit_limit - v_credit_used;
    if v_shortfall > v_headroom then
      return jsonb_build_object('success', false,
        'error', 'Your Wallet Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00'))
                 || ' Chips And Your Credit Line Has '
                 || trim(to_char(greatest(v_headroom, 0), 'FM999,999,999,990.00'))
                 || ' Left. Square Up Your Invoice Or Add Chips To Send This Much.',
        'balance', v_float_before, 'requested', p_amount,
        'credit_limit', v_credit_limit, 'credit_used', v_credit_used,
        'credit_available', greatest(v_headroom, 0),
        'shortfall', v_shortfall);
    end if;
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): an agent wallet send is ONE `agent_send`
  -- row from the sender's float to the wallet that receives it, keyed and
  -- correlated on the op. Verified on 2026-09-01 14:23:18 (10,000.00 to a
  -- player) the undeclared journal was `adjustment agent_wallet ->
  -- settlement_suspense` plus `adjustment table_stack -> player_wallet`. The
  -- agents trigger is skipped for both float writes: a player recipient's
  -- club_members trigger writes the row with the sender's float as its
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. When the credit line covers a shortfall the
  -- float only pays p_amount - v_shortfall, so the draw is its own
  -- `credit_draw credit_facility -> agent_wallet` row for the difference and
  -- the send row still carries the whole amount. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  if v_shortfall > 0 then
    perform public.fn_ca_post_leg('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,
      v_shortfall, p_club_id, 'agent_send:credit:' || v_op_id::text,
      'Agent credit line covers the shortfall of an agent wallet send (fn_agent_wallet_send_core_20260830)');
  end if;

  -- The wallet pays what it can and the line covers the rest, so the balance
  -- lands on exactly zero rather than going negative.
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - (p_amount - v_shortfall),
         credit_used          = coalesce(credit_used, 0) + v_shortfall,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    if v_dest = 'promo_wallet' then
      update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning promo_wallet_balance into v_to_after;
    else
      update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning agent_wallet_balance into v_to_after;
    end if;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, v_dest, p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', v_shortfall,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'credit_drawn', v_shortfall,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
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
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO d;
IF md5(d) <> '3eeac7ee4ed90db3b5bd59052a21620e' THEN RAISE EXCEPTION 'Unexpected preimage: fn_agent_wallet_send_phase2_core_20260831'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id,gen_random_uuid());
  v_destination text := lower(coalesce(p_destination,'player_wallet'));
  v_prior record;
  v_replay_destination text;
  v_actor_role text;
  v_target_role text;
  v_first uuid;
  v_second uuid;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if v_actor is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_to_user_id is null or p_to_user_id=v_actor then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount<>round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;
  if v_destination not in ('player_wallet','agent_wallet','promo_wallet') then
    return jsonb_build_object('success',false,'error','Unknown Destination Wallet');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||v_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_send'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=v_op_id::text limit 1;
  if found then
    v_replay_destination := v_destination;
    if v_prior.to_user_id is distinct from p_to_user_id
       or v_prior.amount is distinct from p_amount
       or coalesce(v_prior.metadata->>'destination','') is distinct from v_replay_destination then
      return jsonb_build_object('success',false,
        'error','That Retry Key Belongs To A Different Agent Wallet Send');
    end if;
    return jsonb_build_object(
      'success',true,'replayed',true,'transaction_id',v_prior.id,'amount',v_prior.amount,
      'destination',v_prior.metadata->>'destination',
      'agent_wallet_after',(v_prior.metadata->>'agent_wallet_after')::numeric,
      'recipient_balance_after',(v_prior.metadata->>'recipient_balance_after')::numeric,
      'credit_drawn',coalesce((v_prior.metadata->>'credit_drawn')::numeric,0),
      'credit_used_after',(v_prior.metadata->>'credit_used_after')::numeric,
      'credit_limit',(v_prior.metadata->>'credit_limit')::numeric);
  end if;

  -- Ownership and both membership rows stay locked through the core operation.
  -- A concurrent role revocation, downline reassignment, or member deletion
  -- must complete before or after this send, never between its checks and debit.
  perform 1 from public.clubs where id=p_club_id for update;
  if not found then return jsonb_build_object('success',false,'error','That Club Could Not Be Found'); end if;
  if v_actor<p_to_user_id then v_first:=v_actor; v_second:=p_to_user_id;
  else v_first:=p_to_user_id; v_second:=v_actor; end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_first for update;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_second for update;

  v_actor_role:=public.fn_club_bank_role(p_club_id,v_actor);
  select role into v_target_role from public.club_members
   where club_id=p_club_id and user_id=p_to_user_id
     and coalesce(status,'active') in ('active','approved');
  if v_actor_role is null
     or v_actor_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Your Cashier Authority Is No Longer Active');
  end if;
  if v_target_role is null then
    return jsonb_build_object('success',false,'error','Recipient Is Not An Active Member Of This Club');
  end if;
  if not public.fn_club_cashier_can_transact(p_club_id,v_actor,p_to_user_id) then
    return jsonb_build_object('success',false,'error','That Member Is Not In Your Downline');
  end if;

  -- The requested destination is validated by the retained core.

  return public.fn_agent_wallet_send_core_20260830(
    p_club_id,p_to_user_id,p_amount,v_destination,p_reason,v_op_id);
end
$function$
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'::regprocedure) INTO d;
IF md5(d) <> '29e28090d6d7316ff108918f5ca839f1' THEN RAISE EXCEPTION 'Unexpected preimage: fn_agent_wallet_claim_back_phase2_core_20260831'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor            uuid := auth.uid();
  v_op_id            uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior            record;
  v_src              record;
  v_claimed          numeric;
  v_claimed_after    numeric;
  v_remaining_exact  numeric;
  v_remaining        numeric;
  v_take             numeric;
  v_complete         boolean;
  v_dest             text;
  v_held             numeric;
  v_agent_id         uuid;
  v_float_after      numeric;
  v_holder_after     numeric;
  v_tx_id            uuid;
  v_drawn            numeric;
  v_repaid           numeric;
  v_repay            numeric := 0;
  v_my_agent_id      uuid;
  v_my_used          numeric;
  v_credit_after     numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_club_id is null or p_transaction_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recent Agent Wallet Send');
  end if;
  if p_amount is not null and
     (p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount, 2)) then
    return jsonb_build_object(
      'success', false,
      'error', 'Claim Back Amounts Must Be Positive Whole Cents');
  end if;

  -- One caller/op pair is serialized, so two simultaneous retries cannot both
  -- pass the replay read and enter the money section.
  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-claim:' || p_club_id::text || ':' || v_actor::text || ':' || v_op_id::text,
    0
  ));

  select id, amount, metadata into v_prior
    from public.chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
  end if;

  select * into v_src
    from public.chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object(
      'success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object(
      'success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object(
      'success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining_exact := greatest(v_src.amount - v_claimed, 0);

  -- Round DOWN, never to nearest. A historical 9.9951 remainder can safely
  -- return 9.99; rounding it to 10.00 would create another 0.0049 chips.
  v_remaining := trunc(v_remaining_exact, 2);
  if v_remaining < 0.01 then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- Null means all safely claimable whole cents. This is what the cashier uses
  -- so contaminated historical rows can be closed without echoing sub-cents.
  v_take := coalesce(p_amount, v_remaining);
  if v_take > v_remaining then
    return jsonb_build_object(
      'success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining,
      'requested', v_take);
  end if;

  v_claimed_after := v_claimed + v_take;
  v_complete := (v_src.amount - v_claimed_after) < 0.01;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from public.club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, case when v_dest = 'promo_wallet' then coalesce(a.promo_wallet_balance, 0) else coalesce(a.agent_wallet_balance, 0) end into v_agent_id, v_held
      from public.agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object(
      'success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object(
      'success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held,
      'requested', v_take);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a claim back is ONE `agent_claim` row from
  -- the wallet that held the send back to the agent's float, keyed and
  -- correlated on the op. The agents trigger is skipped for both float
  -- writes: a player holder's club_members trigger writes the row with the
  -- agent's float as counterparty; an agent holder (both sides in `agents`)
  -- gets the row posted explicitly below. The share that repays the credit
  -- line never reaches the float, so it is its own `credit_repayment
  -- agent_wallet -> credit_facility` row. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_claim', 'agent_wallet', v_actor, null,
    'agent_claim:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    if v_dest = 'promo_wallet' then
      update public.agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - v_take, updated_at = now()
       where id = v_agent_id returning promo_wallet_balance into v_holder_after;
    else
      update public.agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take, updated_at = now()
       where id = v_agent_id returning agent_wallet_balance into v_holder_after;
    end if;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_claim', v_dest, v_src.to_user_id, 'agent_wallet', v_actor,
      v_take, p_club_id, 'agent_claim:' || v_op_id::text,
      'Agent wallet claim back from a downline agent wallet (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- HOW MUCH OF THIS CLAIM IS A REPAYMENT.
  --
  -- credit_drawn is what this send borrowed; credit_repaid is how much of that
  -- borrowing earlier partial claims have already handed back. The share of a
  -- partial claim is proportional, truncated down so repeated partials can
  -- never repay more than was drawn. The final claim settles the exact
  -- remainder, so truncation cannot strand a cent of debt on a send that has
  -- been returned in full.
  v_drawn  := coalesce((v_src.metadata ->> 'credit_drawn')::numeric, 0);
  v_repaid := coalesce((v_src.metadata ->> 'credit_repaid')::numeric, 0);

  select a.id, coalesce(a.credit_used, 0) into v_my_agent_id, v_my_used
    from public.agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_my_agent_id is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  if v_drawn > 0 then
    if v_complete then
      v_repay := greatest(v_drawn - v_repaid, 0);
    else
      v_repay := least(trunc(v_drawn * v_take / v_src.amount, 2),
                       greatest(v_drawn - v_repaid, 0));
    end if;
    -- The debt may already have been settled another way: an invoice paid
    -- inside the ten minute window pays credit_used down (phase 1), and paying
    -- twice for the same borrowing would hand the agent free chips.
    v_repay := greatest(least(v_repay, v_my_used), 0);
  end if;

  if v_repay > 0 then
    perform public.fn_ca_post_leg('credit_repayment', 'agent_wallet', v_actor, 'credit_facility', v_actor,
      v_repay, p_club_id, 'agent_claim:credit:' || v_op_id::text,
      'Claimed back chips repay the credit line drawn for the send (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- Every chip returns: what is not repaying a debt becomes float.
  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),
         credit_used          = greatest(coalesce(credit_used, 0) - v_repay, 0),
         updated_at = now()
   where id = v_my_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  update public.chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed_after,
                                          'credit_repaid', v_repaid + v_repay),
         is_reversed = v_complete,
         clawed_back = v_complete
   where id = v_src.id;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after,
       'credit_repaid', v_repay,
       'credit_used_after', v_credit_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after,
    'credit_repaid', v_repay,
    'credit_used_after', v_credit_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from public.chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
end
$function$
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_promo_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO d;
IF md5(d) <> '2d5a19b24e2c9967895d1b0329a86467' THEN RAISE EXCEPTION 'Unexpected preimage: fn_promo_wallet_send_core_20261004'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_promo_wallet_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_dest           text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id          uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior          record;
  v_sender_id      uuid;
  v_sender_promo   numeric;
  v_sender_after   numeric;
  v_to_role        text;
  v_to_agent_id    uuid;
  v_to_after       numeric;
  v_tx_id          uuid;
begin
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent Or Club Staff May Send From A Promo Wallet');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'promo_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
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
  if v_dest not in ('player_wallet', 'agent_wallet', 'cashier_agent_wallet', 'cashier_promo_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'A Promo Wallet Cannot Send To Itself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select a.id, coalesce(a.promo_wallet_balance, 0)
    into v_sender_id, v_sender_promo
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_sender_id is null then
    return jsonb_build_object('success', false,
      'error', 'You Do Not Hold A Promo Wallet In This Club');
  end if;
  if v_sender_promo < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Promo Wallet Balance',
      'balance', v_sender_promo, 'requested', p_amount);
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
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;

  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false, 'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `promo_send` row from the sender's
  -- promo float to the wallet that receives it, keyed and correlated on the
  -- op. The agents trigger is skipped for both promo writes: a player
  -- recipient's club_members trigger writes the row with the promo float as
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. Never a refusal.
  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', v_actor, null,
    'promo_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update agents
     set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_sender_id
   returning promo_wallet_balance into v_sender_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    if v_dest = 'cashier_agent_wallet' then
      update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning agent_wallet_balance into v_to_after;
    else
      update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning promo_wallet_balance into v_to_after;
    end if;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('promo_send', 'promo_wallet', v_actor, case when v_dest = 'cashier_agent_wallet' then 'agent_wallet' else 'promo_wallet' end, p_to_user_id,
      p_amount, p_club_id, 'promo_send:' || v_op_id::text,
      'Promo wallet send to a downline agent promo wallet (fn_promo_wallet_send)');
  end if;

  perform set_config('app.ledger_autoskip_agents', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'promo_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'sender_promo_after', v_sender_after,
       'recipient_balance_after', v_to_after),
     null)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'sender_promo_after', v_sender_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'promo_wallet_send'
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
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO d;
IF md5(d) <> 'c15aacd20a4791690a35feb6468fe821' THEN RAISE EXCEPTION 'Unexpected preimage: fn_club_promo_send_core_20261004'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_club_promo_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Promo Wallet');
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
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_cashier_batch_transfer(uuid,text,jsonb,uuid)'::regprocedure) INTO d;
IF md5(d) <> '522bb44fb336bfbf0d13277729a58de3' THEN RAISE EXCEPTION 'Unexpected preimage: fn_cashier_batch_transfer'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_cashier_batch_transfer(p_club_id uuid, p_kind text, p_items jsonb, p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user_id uuid;
  v_amount numeric;
  v_destination text;
  v_reason text;
  v_op_id uuid;
  v_ticket_key text;
  v_tournament_id uuid;
  v_seen uuid[] := '{}'::uuid[];
begin
  if v_me is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_club_id is null or p_batch_id is null then
    return jsonb_build_object('success',false,'error','Club And Batch Retry Key Are Required');
  end if;
  if p_kind not in ('send','ticket') then
    return jsonb_build_object('success',false,'error','Choose Send Or Ticket');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 25 then
    return jsonb_build_object('success',false,'error','A Batch Must Contain Between 1 And 25 Recipients');
  end if;

  -- The selected source is validated before any item can move money.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) item WHERE item ? 'source' AND coalesce(item->>'source','') NOT IN ('agent_wallet','club_bank','promo_wallet','club_promo_wallet','player_wallet')) THEN
    RETURN jsonb_build_object('success',false,'error','Unknown Source Wallet');
  END IF;
  -- Validate the complete envelope before the first item can move money.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
    end if;
    -- 20261015132042: a tournament ticket is priced by its tournament, so its
    -- amount is optional; when sent it is the price the cashier saw.
    if p_kind='ticket' and v_item ? 'tournament_id'
       and jsonb_typeof(v_item->'tournament_id') <> 'null' then
      if coalesce(v_item->>'tournament_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return jsonb_build_object('success',false,'error','Every Tournament Ticket Needs A Valid Tournament');
      end if;
      if v_item ? 'amount' and jsonb_typeof(v_item->'amount') <> 'null'
         and coalesce(v_item->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' then
        return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
      end if;
    elsif coalesce(v_item->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' then
      return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
    end if;
    v_user_id := (v_item->>'user_id')::uuid;
    v_amount := nullif(v_item->>'amount','')::numeric;
    if v_user_id = any(v_seen) then
      return jsonb_build_object('success',false,'error','A Recipient May Appear Only Once Per Batch');
    end if;
    v_seen := array_append(v_seen, v_user_id);
    if v_amount is not null
       and (v_amount <= 0 or v_amount > 1e9 or v_amount <> round(v_amount,2)) then
      return jsonb_build_object('success',false,'error','Every Amount Must Be Positive And Use Hundredths At Most');
    end if;
    if p_kind='send' and coalesce(v_item->>'op_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('success',false,'error','Every Send Needs Its Own Retry Key');
    end if;
    if p_kind='ticket' and nullif(btrim(coalesce(v_item->>'idempotency_key','')),'') is null then
      return jsonb_build_object('success',false,'error','Every Ticket Needs Its Own Retry Key');
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_user_id := (v_item->>'user_id')::uuid;
    v_amount := nullif(v_item->>'amount','')::numeric;
    v_tournament_id := case when p_kind='ticket' and jsonb_typeof(v_item->'tournament_id')='string'
                            then (v_item->>'tournament_id')::uuid end;
    begin
      if p_kind='send' then
        v_destination := coalesce(nullif(v_item->>'destination',''),'player_wallet');
        v_reason := nullif(v_item->>'reason','');
        v_op_id := (v_item->>'op_id')::uuid;
        CASE coalesce(v_item->>'source','agent_wallet')
          WHEN 'player_wallet' THEN v_result := public.fn_cashier_player_wallet_send(p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id);
          WHEN 'club_bank' THEN v_result := public.fn_club_bank_send(p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id);
          WHEN 'promo_wallet' THEN v_result := public.fn_promo_wallet_send(p_club_id,v_user_id,v_amount,case when v_destination='agent_wallet' then 'cashier_agent_wallet' when v_destination='promo_wallet' then 'cashier_promo_wallet' else v_destination end,v_reason,v_op_id);
          WHEN 'club_promo_wallet' THEN v_result := public.fn_club_promo_wallet_send(p_club_id,v_user_id,v_amount,case when v_destination='agent_wallet' then 'cashier_agent_wallet' when v_destination='promo_wallet' then 'cashier_promo_wallet' else v_destination end,v_reason,v_op_id);
          ELSE v_result := public.fn_agent_wallet_send(p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id);
        END CASE;
      elsif v_tournament_id is not null then
        v_ticket_key := v_item->>'idempotency_key';
        v_result := public.fn_issue_tournament_entry_ticket(
          p_club_id,v_user_id,v_tournament_id,nullif(v_item->>'note',''),
          v_ticket_key,v_amount
        );
      else
        v_ticket_key := v_item->>'idempotency_key';
        v_result := public.fn_issue_tournament_ticket(
          p_club_id,v_user_id,v_amount,nullif(v_item->>'note',''),v_ticket_key
        );
      end if;
    exception when others then
      v_result := jsonb_build_object(
        'success',false,'error','Transfer Failed','error_code',sqlstate
      );
    end;
    v_results := v_results || jsonb_build_array(
      jsonb_build_object('user_id',v_user_id) || coalesce(v_result,'{}'::jsonb)
    );
  end loop;

  return jsonb_build_object(
    'success',true,
    'batch_id',p_batch_id,
    'results',v_results,
    'processed',jsonb_array_length(v_results)
  );
end
$function$
$definition$;
END $patch$;
DO $patch$ DECLARE d text; BEGIN
SELECT pg_get_functiondef('fn_cashier_operation_intent_guard()'::regprocedure) INTO d;
IF md5(d) <> 'd89888ea95f0fba54a976fe966804649' THEN RAISE EXCEPTION 'Unexpected preimage: fn_cashier_operation_intent_guard'; END IF;
EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_cashier_operation_intent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation uuid;
  v_owner uuid;
  v_action text;
  v_expected_type text;
BEGIN
  IF NEW.metadata ->> 'op_id' IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_operation := (NEW.metadata ->> 'op_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'cashier-exact-intent:' || v_operation, 0));
  SELECT actor_user_id, action INTO v_owner, v_action
    FROM public.cashier_rpc_operation_intents
   WHERE operation_id = v_operation;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_expected_type := CASE v_action
    WHEN 'club_bank_send' THEN 'club_bank_send'
    WHEN 'club_bank_claim' THEN 'club_bank_claim'
    WHEN 'club_bank_reversal' THEN 'club_bank_reversal'
    WHEN 'admin_removal' THEN 'admin_removal'
    WHEN 'promo_wallet_send' THEN 'promo_wallet_send'
    WHEN 'club_promo_send' THEN 'club_promo_send'
    WHEN 'agent_wallet_send' THEN 'agent_wallet_send'
    WHEN 'cashier_player_send' THEN 'peer_transfer'
    WHEN 'agent_wallet_claim_back' THEN 'agent_wallet_claim_back'
  END;
  IF v_owner IS DISTINCT FROM auth.uid()
     OR v_expected_type IS NULL
     OR NEW.transaction_type IS DISTINCT FROM v_expected_type THEN
    RAISE EXCEPTION 'cashier_retry_key_reused_across_actions' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$
$definition$;
END $patch$;
CREATE OR REPLACE FUNCTION public.fn_cashier_recipient_wallet_balances(p_club_id uuid,p_user_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE actor uuid:=auth.uid(); actor_role text;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Not Authenticated' USING ERRCODE='42501'; END IF;
 actor_role:=public.fn_club_bank_role(p_club_id);
 IF actor_role IS NULL OR actor_role NOT IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN RAISE EXCEPTION 'Cashier Access Is Required' USING ERRCODE='42501'; END IF;
 IF p_user_ids IS NULL OR cardinality(p_user_ids)>25 OR EXISTS(SELECT 1 FROM unnest(p_user_ids) u WHERE u IS NULL) THEN RAISE EXCEPTION 'Choose At Most 25 Recipients' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_user_ids) u WHERE u<>actor AND NOT public.fn_club_cashier_can_transact(p_club_id,actor,u)) THEN RAISE EXCEPTION 'That Member Is Not In Your Downline' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',cm.user_id,
  'player_wallet',CASE WHEN cm.role<>'admin' THEN coalesce(cm.chip_balance,0) END,
  'agent_wallet',CASE WHEN cm.role IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN coalesce(a.agent_wallet_balance,0) END,
  'promo_wallet',CASE WHEN cm.role IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN coalesce(a.promo_wallet_balance,0) END)), '[]'::jsonb)
  FROM public.club_members cm LEFT JOIN public.agents a ON a.club_id=cm.club_id AND a.user_id=cm.user_id
  WHERE cm.club_id=p_club_id AND cm.user_id=ANY(p_user_ids) AND coalesce(cm.status,'active') IN ('active','approved'));
END
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_recipient_wallet_balances(uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_recipient_wallet_balances(uuid,uuid[]) TO authenticated,service_role;

-- The sender's own player balance is a distinct source. Reuse the established
-- exact-intent and declared-journal owners; never debit an arbitrary user.
-- Register the new writer before CREATE so the production DDL guard admits it.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES ('fn_cashier_player_wallet_send','approved','Authenticated cashier sends only their own Player Wallet chips to an eligible downline or their own other wallet. Exact-intent replay and role, hierarchy and maintenance guards; fn_ca_declare_ledger and one peer_transfer journal, atomic with the transaction receipt.')
ON CONFLICT (proname) DO NOTHING;
DO $registry$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_cashier_player_wallet_send' AND status='approved') THEN
  RAISE EXCEPTION 'Player wallet send registry is not approved';
 END IF;
END $registry$;
CREATE OR REPLACE FUNCTION public.fn_cashier_player_wallet_send(p_club_id uuid,p_to_user_id uuid,p_amount numeric,p_destination text,p_reason text,p_op_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE actor uuid:=auth.uid(); actor_role text; target_role text; gate jsonb; result jsonb; before_balance numeric; after_balance numeric; target_after numeric; agent_id uuid; tx uuid; context jsonb; setting text;
BEGIN
 gate:=public.fn_cashier_exact_intent_begin('cashier_player_send',p_club_id,p_op_id,jsonb_build_object('actor',actor,'club',p_club_id,'action','cashier_player_send','target',p_to_user_id,'amount',p_amount,'destination',p_destination,'reason',p_reason));
 IF gate->>'state'='return' THEN RETURN gate->'response'; END IF;
 IF p_club_id IS NULL OR p_to_user_id IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount>1e9 OR p_amount<>round(p_amount,2) THEN RETURN jsonb_build_object('success',false,'error','Enter A Valid Send Amount And Recipient'); END IF;
 IF p_destination IS NULL OR p_destination NOT IN ('player_wallet','agent_wallet','promo_wallet') THEN RETURN jsonb_build_object('success',false,'error','Unknown Destination Wallet'); END IF;
 IF actor=p_to_user_id AND p_destination='player_wallet' THEN RETURN jsonb_build_object('success',false,'error','Choose A Different Wallet'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
 PERFORM 1 FROM public.clubs WHERE id=p_club_id FOR UPDATE;
 PERFORM 1 FROM public.club_members WHERE club_id=p_club_id AND user_id IN (actor,p_to_user_id) ORDER BY user_id FOR UPDATE;
 actor_role:=public.fn_club_bank_role(p_club_id);
 IF actor_role IS NULL OR actor_role NOT IN ('owner','co_owner','super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','Your Cashier Authority Is No Longer Active'); END IF;
 IF actor<>p_to_user_id AND NOT public.fn_club_cashier_can_transact(p_club_id,actor,p_to_user_id) THEN RETURN jsonb_build_object('success',false,'error','That Member Is Not In Your Downline'); END IF;
 SELECT role INTO target_role FROM public.club_members WHERE club_id=p_club_id AND user_id=p_to_user_id AND coalesce(status,'active') IN ('active','approved');
 IF target_role IS NULL THEN RETURN jsonb_build_object('success',false,'error','Recipient Is Not An Active Member Of This Club'); END IF;
 IF (p_destination='player_wallet' AND target_role='admin') OR (p_destination<>'player_wallet' AND target_role NOT IN ('owner','co_owner','admin','super_agent','agent','sub_agent')) THEN RETURN jsonb_build_object('success',false,'error','Recipient Does Not Hold That Wallet'); END IF;
 SELECT coalesce(chip_balance,0) INTO before_balance FROM public.club_members WHERE club_id=p_club_id AND user_id=actor;
 IF before_balance IS NULL OR before_balance<p_amount THEN RETURN jsonb_build_object('success',false,'error','Insufficient Player Wallet Balance'); END IF;
 SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO context FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_correlation','app.ledger_idempotency_key','app.ledger_autoskip_agents','app.ledger_autoskip_club_members','app.ledger_tournament','app.ledger_settlement']) settings(k);
 PERFORM set_config('app.ledger_tournament','',true);
 PERFORM set_config('app.ledger_settlement','',true);
 PERFORM public.fn_ca_declare_ledger('transfer','player_wallet',actor,NULL,'cashier_player_send:'||p_op_id::text,ARRAY['club_members','agents']);
 PERFORM set_config('app.ledger_correlation',p_op_id::text,true);
 UPDATE public.club_members SET chip_balance=coalesce(chip_balance,0)-p_amount,updated_at=now() WHERE club_id=p_club_id AND user_id=actor RETURNING chip_balance INTO after_balance;
 IF p_destination='player_wallet' THEN
  UPDATE public.club_members SET chip_balance=coalesce(chip_balance,0)+p_amount,updated_at=now() WHERE club_id=p_club_id AND user_id=p_to_user_id RETURNING chip_balance INTO target_after;
 ELSE
  agent_id:=public.fn_ensure_agent_row(p_club_id,p_to_user_id,target_role);
  IF p_destination='agent_wallet' THEN UPDATE public.agents SET agent_wallet_balance=coalesce(agent_wallet_balance,0)+p_amount,updated_at=now() WHERE id=agent_id RETURNING agent_wallet_balance INTO target_after;
  ELSE UPDATE public.agents SET promo_wallet_balance=coalesce(promo_wallet_balance,0)+p_amount,updated_at=now() WHERE id=agent_id RETURNING promo_wallet_balance INTO target_after; END IF;
 END IF;
 IF target_after IS NULL THEN RAISE EXCEPTION 'Recipient Credit Landed Nowhere'; END IF;
 PERFORM set_config('app.ledger_idempotency_key','',true);
 IF NOT public.fn_ca_post_leg('transfer','player_wallet',actor,p_destination,p_to_user_id,p_amount,p_club_id,'cashier_player_send:'||p_op_id::text,'Cashier Send From Player Wallet') THEN RAISE EXCEPTION 'The Transfer Journal Was Not Written'; END IF;
 FOR setting IN SELECT jsonb_object_keys(context) LOOP PERFORM set_config(setting,context->>setting,true); END LOOP;
 INSERT INTO public.chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after) VALUES(p_club_id,actor,p_to_user_id,p_amount,'peer_transfer',coalesce(p_reason,'Cashier Send Out'),jsonb_build_object('op_id',p_op_id,'source','player_wallet','destination',p_destination,'player_wallet_after',after_balance,'recipient_balance_after',target_after),after_balance) RETURNING id INTO tx;
 result:=jsonb_build_object('success',true,'replayed',false,'transaction_id',tx,'amount',p_amount,'source','player_wallet','destination',p_destination,'player_wallet_after',after_balance,'recipient_balance_after',target_after);
 RETURN public.fn_cashier_exact_intent_finish(p_op_id,result);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_player_wallet_send(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_player_wallet_send(uuid,uuid,numeric,text,text,uuid) TO authenticated,service_role;

-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '2d807b4c20c90e6fd5bc65c7257ee25f')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '745d085a40e2134c08b0cf4bd7ab7baa')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'::regprocedure)) = '5de5e8e5528036ef643e43150e5f37cf')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_promo_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '9902bccc4d422766b3611e050eeec770')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '5d037d10de17314377a263d96a18556f')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)'::regprocedure)) = '859bb844228d65085bf134c4dbd8b32b')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_operation_intent_guard()'::regprocedure)) = '60350724279387da3b548bd370d082db')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_recipient_wallet_balances(uuid,uuid[])'::regprocedure)) = '54b0da3ecb0744f88ada5cdf391e531c')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_player_wallet_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '2697ce061ec1b7436fc8ae825129d649')
-- @live-proof: (SELECT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_cashier_player_wallet_send' AND status='approved'))
COMMIT;
