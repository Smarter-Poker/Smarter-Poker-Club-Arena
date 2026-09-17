\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Ten exact captured baseline functions missing from the
-- retained fullfixture closure. Load before the entire candidate, never after
-- it and never as an application migration. No historical35 body is inferred.
-- The retained captures remain the authority. Missing deeper dependencies such
-- as fn_ca_post_leg must be supplied from actual metadata before draw testing.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
DO $isolated$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'isolated PG17 owner baseline required';END IF;
END$isolated$;
-- Capture inputs: [{"path":"supabase/accounting/credit-reduction-v1/captured-credit-catalog.json","sha256":"e993129dcb12261ea7d5bd350f0546415814c17346fd27f51b1ba9efb14854bc"},{"path":"supabase/accounting/credit-reduction-v1/captured-credit-delegates.json","sha256":"5493881808c429f5188b4f4b92273f244e2c843fe4cbe2d02620455cae15fdf2"}]
DO $absent$ DECLARE x jsonb;BEGIN FOR x IN SELECT value FROM jsonb_array_elements($captured$[{"signature":"fn_agent_approve_cashout(uuid,uuid,text)","definition_md5":"78e105b17122b2b7bdd9dfe3df0e8de6","body_md5":"07db082ff1c1501dba55029cf1871141","owner":"postgres","language":"plpgsql","security_definer":false,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, extensions"],"arguments":"p_cashout_id uuid, p_agent_user_id uuid, p_agent_note text DEFAULT NULL::text","result":"jsonb","acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"service_role":false,"authenticated":false}},{"signature":"fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)","definition_md5":"29e28090d6d7316ff108918f5ca839f1","body_md5":"c75e9cdb7e3b197fc83422f9f6e0d722","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}},{"signature":"fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","definition_md5":"c6bb171c71aa0d6022296b29269a016b","body_md5":"1ca40e16c6eccd331f6d65b4436edfc1","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}},{"signature":"fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)","definition_md5":"0214036f29a6d121842496c91c7912af","body_md5":"38d088732280d8b2cb605c87eda4af3f","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_apply_credit_payment(uuid,numeric,text)","definition_md5":"5d01c2dda901644a473057a81dade2a9","body_md5":"90bcf62a0428604e4e522d46b75f0897","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric, p_method text","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_assign_agent_to_super_agent(uuid,uuid,uuid)","definition_md5":"13f6d2408d152e7d15a8b3b0bf113a9f","body_md5":"3c110478d9556a0e5b13011d851979f5","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_pay_credit_invoice_from_wallet(uuid,numeric)","definition_md5":"7c5e2861fde25856b1cce59b5119770e","body_md5":"665683453a5114933d719676bcf7a7ed","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)","definition_md5":"3c31d57d2c4f6ecdf388c5157f311e5a","body_md5":"21a917e911fe657310fc38dfc318a50c","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)","definition_md5":"31d05a227849bda2a1195594c57b90eb","body_md5":"cf7af5fd327c68c935a58e864537cc7a","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)","definition_md5":"53ba478533aec762384aa9ac7d63a9b2","body_md5":"2ee5fa22748b07166f2dba6e16706c61","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}}]$captured$::jsonb) LOOP
 IF to_regprocedure('public.'||(x->>'signature')) IS NOT NULL THEN RAISE EXCEPTION 'captured credit dependency preexists' USING DETAIL=x->>'signature';END IF;
 END LOOP;END$absent$;

CREATE OR REPLACE FUNCTION public.fn_agent_approve_cashout(p_cashout_id uuid, p_agent_user_id uuid, p_agent_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_cashout RECORD; v_agent RECORD;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF v_cashout.status != 'pending' THEN RETURN jsonb_build_object('success', false, 'error', 'Already ' || v_cashout.status); END IF;
  SELECT * INTO v_agent FROM agents WHERE club_id = v_cashout.club_id AND user_id = COALESCE(v_cashout.agent_id, p_agent_user_id);
  UPDATE cashout_requests SET status = 'approved', agent_id = COALESCE(agent_id, p_agent_user_id), agent_note = p_agent_note, acknowledged_at = NOW(), updated_at = NOW() WHERE id = p_cashout_id;
  IF v_agent.id IS NOT NULL AND v_agent.is_prepaid = true THEN
    UPDATE agents SET player_balance = COALESCE(player_balance, 0) - v_cashout.amount, updated_at = NOW() WHERE id = v_agent.id;
  END IF;
  IF v_agent.id IS NOT NULL AND COALESCE(v_agent.is_prepaid, false) = false THEN
    UPDATE agents SET credit_used = COALESCE(credit_used, 0) + v_cashout.amount, updated_at = NOW() WHERE id = v_agent.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id, 'status', 'approved', 'amount', v_cashout.amount);
END;
$function$;
ALTER FUNCTION public.fn_agent_approve_cashout(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_approve_cashout(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_approve_cashout(uuid,uuid,text) TO postgres;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
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
    update public.agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_claim', 'agent_wallet', v_src.to_user_id, 'agent_wallet', v_actor,
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
$function$;
ALTER FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  if v_dest not in ('player_wallet', 'agent_wallet') then
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
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
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
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,
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
$function$;
ALTER FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  return public.fn_agent_wallet_send_phase2_core_20260831(
    p_club_id,p_to_user_id,p_amount,p_destination,p_reason,p_op_id
  );
end
$function$;
ALTER FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(p_invoice_id uuid, p_amount numeric, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,p_method,
   md5('legacy-credit-apply:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,'')||':'||COALESCE(p_method,''))::uuid,NULL);
END $function$;
ALTER FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_assign_agent_to_super_agent(p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_agent uuid; v_super uuid;
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT id INTO v_agent FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id;
  SELECT id INTO v_super FROM agents WHERE user_id = p_super_agent_user_id AND club_id = p_club_id;
  IF v_agent IS NULL OR v_super IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_or_super_agent_not_found');
  END IF;
  IF v_agent = v_super THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_cannot_report_to_itself');
  END IF;
  -- No cycles: the proposed parent must not already sit beneath this agent.
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_agent_id FROM agents WHERE id = v_super
      UNION ALL
      SELECT a.id, a.parent_agent_id FROM agents a JOIN up ON up.parent_agent_id = a.id
    ) SELECT 1 FROM up WHERE id = v_agent
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'would_create_cycle');
  END IF;

  UPDATE agents SET parent_agent_id = v_super, updated_at = now() WHERE id = v_agent;
  UPDATE agents SET role = 'super_agent', updated_at = now()
   WHERE id = v_super AND COALESCE(role,'agent') <> 'super_agent';

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent, 'super_agent_id', v_super);
END $function$;
ALTER FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_agent_to_super_agent(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(p_invoice_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,'wallet',
   md5('legacy-credit-wallet:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,''))::uuid,NULL);
END $function$;
ALTER FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_process_credit_invoice_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE inv public.credit_invoices%ROWTYPE; agent public.agents%ROWTYPE; pay public.credit_payments%ROWTYPE;
 actor uuid:=auth.uid(); engine boolean:=public.fn_caller_is_engine(); remaining numeric; old_club text; deducted boolean; new_status text;
BEGIN
 IF p_invoice_id IS NULL OR p_operation_id IS NULL OR p_amount IS NULL OR p_amount<=0
    OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
 THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invalid_payment'); END IF;
 IF p_method IS NULL OR p_method NOT IN('wallet','external') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason','unsupported_payment_method'); END IF;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invoice_not_found'); END IF;
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','agent_user_not_found'); END IF;
 IF p_method='wallet' THEN
   -- A service credential is not authority to spend an arbitrary user's wallet.
   IF actor IS NULL OR actor<>agent.user_id THEN
    RAISE EXCEPTION 'not_your_wallet' USING ERRCODE='42501'; END IF;
 ELSE
   IF NOT engine AND (actor IS NULL OR NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'only_receiving_club_can_record_external_payment' USING ERRCODE='42501'; END IF;
   IF NULLIF(btrim(p_reference),'') IS NULL OR length(p_reference)>256 THEN
    RETURN jsonb_build_object('ok',false,'success',false,'reason','payment_reference_required'); END IF;
 END IF;
 -- Use the same agent -> invoice lock order as invoice generation.
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id FOR UPDATE;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF inv.agent_id IS DISTINCT FROM agent.id OR agent.club_id IS NULL
   OR (p_method='wallet' AND actor IS DISTINCT FROM agent.user_id)
   OR (p_method='external' AND NOT engine AND NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin()))
 THEN RAISE EXCEPTION 'credit_account_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit_payment:'||p_operation_id::text,0));
 SELECT * INTO pay FROM public.credit_payments WHERE operation_id=p_operation_id;
 IF NOT FOUND AND p_method='external' THEN
   SELECT * INTO pay FROM public.credit_payments WHERE invoice_id=p_invoice_id AND payment_method='external' AND payment_reference=btrim(p_reference);
 END IF;
 IF pay.id IS NOT NULL THEN
   IF pay.invoice_id<>p_invoice_id OR pay.amount<>p_amount OR pay.payment_method<>p_method
      OR pay.payer_user_id IS DISTINCT FROM actor OR pay.payment_reference IS DISTINCT FROM NULLIF(btrim(p_reference),'')
   THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','operation_conflict'); END IF;
   RETURN jsonb_build_object('ok',true,'success',true,'duplicate',true,'amount',pay.amount,'applied',pay.amount,
     'invoice_id',inv.id,'status',inv.status,'amount_remaining',inv.amount_remaining,'payment',to_jsonb(pay));
 END IF;
 IF inv.status NOT IN('pending','partial','overdue') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason',CASE inv.status WHEN 'void' THEN 'invoice_voided' WHEN 'paid' THEN 'already_settled' ELSE 'invoice_not_payable' END);
 END IF;
 IF inv.debt_owed IS NULL OR inv.amount_paid IS NULL OR inv.amount_remaining IS NULL OR agent.credit_used IS NULL
   OR inv.debt_owed::text IN('NaN','Infinity','-Infinity') OR inv.amount_paid::text IN('NaN','Infinity','-Infinity')
   OR inv.amount_remaining::text IN('NaN','Infinity','-Infinity') OR agent.credit_used::text IN('NaN','Infinity','-Infinity')
   OR inv.debt_owed<>round(inv.debt_owed,2) OR inv.amount_paid<>round(inv.amount_paid,2)
   OR agent.credit_used<>round(agent.credit_used,2) OR inv.amount_paid<0 OR agent.credit_used<0
   OR inv.amount_remaining<>inv.debt_owed-inv.amount_paid
 THEN RAISE EXCEPTION 'credit_balance_evidence_invalid' USING ERRCODE='23514'; END IF;
 remaining:=inv.amount_remaining;
 IF p_amount>remaining THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','amount_exceeds_remaining','amount_remaining',remaining); END IF;
 IF p_amount>agent.credit_used THEN RAISE EXCEPTION 'credit_invoice_exceeds_drawn_debt' USING ERRCODE='23514'; END IF;
 IF p_method='wallet' THEN
   old_club:=current_setting('app.ledger_club_id',true);
   PERFORM set_config('app.ledger_club_id',agent.club_id::text,true);
   deducted:=public.atomic_deduct_wallet_and_log(agent.user_id,p_amount,'settlement','Credit Invoice Payment: '||p_invoice_id::text,NULL,NULL,p_invoice_id);
   PERFORM set_config('app.ledger_club_id',COALESCE(old_club,''),true);
   IF deducted IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_balance'); END IF;
 END IF;
 remaining:=remaining-p_amount;
 new_status:=CASE WHEN remaining=0 THEN 'paid' ELSE 'partial' END;
 UPDATE public.credit_invoices SET amount_paid=amount_paid+p_amount,amount_remaining=remaining,status=new_status,
  paid_at=CASE WHEN remaining=0 THEN now() ELSE paid_at END WHERE id=p_invoice_id;
 UPDATE public.agents SET credit_used=credit_used-p_amount,updated_at=now() WHERE id=agent.id;
 INSERT INTO public.credit_payments(invoice_id,amount,payment_method,transaction_id,operation_id,payer_user_id,payment_reference)
  VALUES(p_invoice_id,p_amount,p_method,p_operation_id::text,p_operation_id,actor,NULLIF(btrim(p_reference),'')) RETURNING * INTO pay;
 -- The existing payment trigger creates the invoice and both delivery receipts.
 UPDATE public.settlement_invoices SET status=CASE WHEN remaining=0 THEN 'paid' ELSE 'generated' END,updated_at=now()
  WHERE source_credit_invoice_id=p_invoice_id;
 RETURN jsonb_build_object('ok',true,'success',true,'duplicate',false,'amount',p_amount,'applied',p_amount,
  'invoice_id',p_invoice_id,'status',new_status,'amount_remaining',remaining,'credit_used_after',agent.credit_used-p_amount,'payment',to_jsonb(pay));
END $function$;
ALTER FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Claim Back');
  end if;
  return public.fn_agent_wallet_claim_back_phase2_core_20260831(
    p_club_id,p_transaction_id,p_amount,p_reason,p_op_id
  );
end
$function$;
ALTER FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  if v_actor is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_to_user_id is null or p_to_user_id=v_actor then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount<>round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;
  if v_destination not in ('player_wallet','agent_wallet') then
    return jsonb_build_object('success',false,'error','Unknown Destination Wallet');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||v_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_send'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=v_op_id::text limit 1;
  if found then
    v_replay_destination := case
      when coalesce(v_prior.metadata->>'recipient_role','') in
        ('owner','co_owner','admin','super_agent','agent','sub_agent')
      then 'agent_wallet' else v_destination end;
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

  -- Agent recipients always receive agent float; bind the replay fingerprint
  -- to the effective destination, not a caller-controlled label.
  if v_target_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_destination:='agent_wallet';
  end if;

  return public.fn_agent_wallet_send_core_20260830(
    p_club_id,p_to_user_id,p_amount,v_destination,p_reason,v_op_id);
end
$function$;
ALTER FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid) TO service_role;

DO $exact$ DECLARE x jsonb;p oid;who text;BEGIN
 FOR x IN SELECT value FROM jsonb_array_elements($captured$[{"signature":"fn_agent_approve_cashout(uuid,uuid,text)","definition_md5":"78e105b17122b2b7bdd9dfe3df0e8de6","body_md5":"07db082ff1c1501dba55029cf1871141","owner":"postgres","language":"plpgsql","security_definer":false,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, extensions"],"arguments":"p_cashout_id uuid, p_agent_user_id uuid, p_agent_note text DEFAULT NULL::text","result":"jsonb","acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"service_role":false,"authenticated":false}},{"signature":"fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)","definition_md5":"29e28090d6d7316ff108918f5ca839f1","body_md5":"c75e9cdb7e3b197fc83422f9f6e0d722","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}},{"signature":"fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","definition_md5":"c6bb171c71aa0d6022296b29269a016b","body_md5":"1ca40e16c6eccd331f6d65b4436edfc1","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}},{"signature":"fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)","definition_md5":"0214036f29a6d121842496c91c7912af","body_md5":"38d088732280d8b2cb605c87eda4af3f","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_apply_credit_payment(uuid,numeric,text)","definition_md5":"5d01c2dda901644a473057a81dade2a9","body_md5":"90bcf62a0428604e4e522d46b75f0897","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric, p_method text","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_assign_agent_to_super_agent(uuid,uuid,uuid)","definition_md5":"13f6d2408d152e7d15a8b3b0bf113a9f","body_md5":"3c110478d9556a0e5b13011d851979f5","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_pay_credit_invoice_from_wallet(uuid,numeric)","definition_md5":"7c5e2861fde25856b1cce59b5119770e","body_md5":"665683453a5114933d719676bcf7a7ed","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)","definition_md5":"3c31d57d2c4f6ecdf388c5157f311e5a","body_md5":"21a917e911fe657310fc38dfc318a50c","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)","definition_md5":"31d05a227849bda2a1195594c57b90eb","body_md5":"cf7af5fd327c68c935a58e864537cc7a","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true}},{"signature":"fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)","definition_md5":"53ba478533aec762384aa9ac7d63a9b2","body_md5":"2ee5fa22748b07166f2dba6e16706c61","owner":"postgres","language":"plpgsql","security_definer":true,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public, pg_temp"],"arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}}]$captured$::jsonb) LOOP
  p:=to_regprocedure('public.'||(x->>'signature'));
  IF p IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_language l ON l.oid=f.prolang WHERE f.oid=p
    AND pg_get_userbyid(f.proowner)=x->>'owner' AND f.prokind='f' AND l.lanname=x->>'language'
    AND f.prosecdef=(x->>'security_definer')::boolean AND f.provolatile::text=x->>'volatility'
    AND f.proisstrict=(x->>'strict')::boolean AND f.proleakproof=(x->>'leakproof')::boolean
    AND f.proparallel::text=x->>'parallel' AND to_jsonb(f.proconfig) IS NOT DISTINCT FROM NULLIF(x->'config','null'::jsonb)
    AND pg_get_function_arguments(f.oid)=x->>'arguments' AND pg_get_function_result(f.oid)=x->>'result'
    AND md5(f.prosrc)=x->>'body_md5' AND md5(pg_get_functiondef(f.oid))=x->>'definition_md5')
   OR (SELECT jsonb_agg(a::text ORDER BY a::text) FROM pg_proc f,LATERAL unnest(f.proacl)a WHERE f.oid=p)
    IS DISTINCT FROM (SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements_text(x->'acl'))
  THEN RAISE EXCEPTION 'captured credit dependency not reproduced exactly' USING DETAIL=x->>'signature';END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,p,'EXECUTE') IS DISTINCT FROM (x->'effective_execute'->>who)::boolean
   THEN RAISE EXCEPTION 'captured credit dependency effective access changed' USING DETAIL=who||':'||(x->>'signature');END IF;
  END LOOP;
 END LOOP;
END$exact$;
COMMIT;
