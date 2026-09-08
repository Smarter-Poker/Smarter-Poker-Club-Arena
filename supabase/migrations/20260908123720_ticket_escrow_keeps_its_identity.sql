-- New tickets have an identifiable escrow account from issue through release.
-- Historical unnamed escrows retain their original account identity.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_issue_tournament_ticket_phase2_core_20260831' AND md5(pg_get_functiondef(p.oid))='8d979d2e6f010ad118f476f0189ff2bb')
 THEN RAISE EXCEPTION 'Ticket function changed: fn_issue_tournament_ticket_phase2_core_20260831'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_issue_tournament_ticket_phase2_core_20260831(p_club_id uuid, p_holder_id uuid, p_value numeric, p_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_holder_role text;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_key text := nullif(btrim(coalesce(p_idempotency_key,'')),'');
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
  v_prior record;
  v_ticket_id uuid;
  v_first uuid;
  v_second uuid;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_holder_id is null or p_holder_id=v_me then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_value is null or p_value <= 0 or p_value > 1e9 or p_value <> round(p_value,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Ticket Value');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('ticket:'||v_key,0));
    select ct.* into v_prior from public.chip_transactions ct
     where ct.metadata->>'idempotency_key'=v_key limit 1;
    if found then
      if v_prior.transaction_type <> 'tournament_ticket_issue'
         and not (v_prior.transaction_type='peer_transfer'
                  and v_prior.notes ilike 'Tournament ticket issued%') then
        return jsonb_build_object('success',false,'error','That Retry Key Is Already In Use');
      end if;
      if v_prior.club_id is distinct from p_club_id
         or v_prior.from_user_id is distinct from v_me
         or v_prior.to_user_id is distinct from p_holder_id
         or v_prior.amount is distinct from p_value
         or (v_prior.metadata ? 'note'
             and coalesce(v_prior.metadata->>'note','') is distinct from coalesce(v_note,'')) then
        return jsonb_build_object('success',false,'error','That Retry Key Belongs To A Different Ticket');
      end if;
      return jsonb_build_object('success',true,'replayed',true,
        'ticket_id',v_prior.metadata->>'ticket_id',
        'your_balance',(v_prior.metadata->>'issuer_balance_after')::numeric);
    end if;
  end if;

  -- Lock both memberships in deterministic order, then re-check every role and
  -- downline rule while the rows cannot be deleted or reassigned underneath us.
  if v_me < p_holder_id then v_first:=v_me; v_second:=p_holder_id;
  else v_first:=p_holder_id; v_second:=v_me; end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_first for update;
  if not found then return jsonb_build_object('success',false,'error','A Required Membership No Longer Exists'); end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_second for update;
  if not found then return jsonb_build_object('success',false,'error','A Required Membership No Longer Exists'); end if;

  select role into v_role from public.club_members
   where club_id=p_club_id and user_id=v_me and coalesce(status,'active') in ('active','approved');
  select role into v_holder_role from public.club_members
   where club_id=p_club_id and user_id=p_holder_id and coalesce(status,'active') in ('active','approved');
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Your Role Cannot Issue Tickets');
  end if;
  if v_holder_role is null then return jsonb_build_object('success',false,'error','Recipient Is Not Active In This Club'); end if;
  if v_role in ('super_agent','agent','sub_agent')
     and not public.fn_club_cashier_can_transact(p_club_id,v_me,p_holder_id) then
    return jsonb_build_object('success',false,'error','Recipient Is Not In Your Downline');
  end if;

  v_ticket_id:=gen_random_uuid();
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_category','ticket_issue',true);
  perform set_config('app.ledger_counterparty','escrow',true);
  perform set_config('app.ledger_counterparty_entity',v_ticket_id::text,true);
  update public.club_members set chip_balance=coalesce(chip_balance,0)-p_value,updated_at=now()
   where club_id=p_club_id and user_id=v_me and coalesce(status,'active') in ('active','approved')
     and coalesce(chip_balance,0)>=p_value returning chip_balance into v_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;
  if v_after is null then return jsonb_build_object('success',false,'error','Insufficient Chips'); end if;

  insert into public.tournament_tickets(id,club_id,issued_by,holder_id,value,note)
  values(v_ticket_id,p_club_id,v_me,p_holder_id,p_value,v_note);
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values(p_club_id,v_me,p_holder_id,p_value,'tournament_ticket_issue',
    'Tournament Ticket Issued',v_after,
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key',v_key,'ticket_id',v_ticket_id,'escrow_entity_id',v_ticket_id,'issuer_id',v_me,
      'holder_id',p_holder_id,'value',p_value,'note',v_note,'issuer_balance_after',v_after)));
  return jsonb_build_object('success',true,'replayed',false,'ticket_id',v_ticket_id,'your_balance',v_after);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text) TO service_role;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_cancel_tournament_ticket' AND md5(pg_get_functiondef(p.oid))='3aa9f7fbc6355b0b8209af9336a67a27')
 THEN RAISE EXCEPTION 'Ticket function changed: fn_cancel_tournament_ticket'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cancel_tournament_ticket(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_t public.tournament_tickets%rowtype;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_receipt public.chip_transactions%rowtype;
  v_issue public.chip_transactions%rowtype;
  v_escrow_entity uuid;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_ticket_id is null then return jsonb_build_object('success',false,'error','Choose A Ticket'); end if;

  select * into v_t from public.tournament_tickets where id=p_ticket_id for update;
  if not found then return jsonb_build_object('success',false,'error','Ticket Not Found'); end if;
  if v_t.issued_by is distinct from v_me then
    return jsonb_build_object('success',false,'error','Only The Issuer May Cancel A Ticket');
  end if;
  if v_t.status='cancelled' then
    select * into v_receipt from public.chip_transactions
     where transaction_type='tournament_ticket_cancel'
       and metadata->>'ticket_id'=p_ticket_id::text limit 1;
    if found then
      return jsonb_build_object(
        'success',true,'replayed',true,'refunded',v_t.value,
        'your_balance',(v_receipt.metadata->>'issuer_balance_after')::numeric,
        'transaction_id',v_receipt.id
      );
    end if;
  end if;
  if v_t.status<>'issued' then
    return jsonb_build_object('success',false,'error','Ticket Already '||initcap(v_t.status));
  end if;

  select * into v_issue from public.chip_transactions
   where transaction_type='tournament_ticket_issue'
     and metadata->>'ticket_id'=p_ticket_id::text limit 1;
  if found and v_issue.metadata ? 'escrow_entity_id' then
    if v_issue.club_id is distinct from v_t.club_id
      or v_issue.from_user_id is distinct from v_t.issued_by
      or v_issue.to_user_id is distinct from v_t.holder_id
      or v_issue.amount is distinct from v_t.value
      or v_issue.metadata->>'escrow_entity_id' is distinct from p_ticket_id::text then
      raise exception 'Ticket escrow receipt does not match its entitlement' using errcode='22023';
    end if;
    v_escrow_entity:=p_ticket_id;
  end if;
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_category','escrow_release',true);
  perform set_config('app.ledger_counterparty','escrow',true);
  perform set_config('app.ledger_counterparty_entity',coalesce(v_escrow_entity::text,''),true);
  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()
   where club_id=v_t.club_id and user_id=v_me
     and coalesce(status,'active') in ('active','approved')
   returning chip_balance into v_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;
  if v_after is null then
    return jsonb_build_object(
      'success',false,
      'error','You Are No Longer A Member Of That Club, So The Escrow Has Nowhere To Land'
    );
  end if;

  update public.tournament_tickets
     set status='cancelled',cancelled_at=now()
   where id=p_ticket_id;
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values (
    v_t.club_id,null,v_me,v_t.value,'tournament_ticket_cancel',
    'Tournament Ticket Cancelled: Escrow Refunded',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,'holder_id',v_t.holder_id,
      'escrow_action','refund_to_issuer','issuer_balance_after',v_after
    )
  ) returning * into v_receipt;

  return jsonb_build_object(
    'success',true,'replayed',false,'refunded',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id
  );
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_cancel_tournament_ticket(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cancel_tournament_ticket(uuid) TO authenticated,service_role;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_redeem_tournament_ticket' AND md5(pg_get_functiondef(p.oid))='26e16b41b964863565183203398e811a')
 THEN RAISE EXCEPTION 'Ticket function changed: fn_redeem_tournament_ticket'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_redeem_tournament_ticket(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_t public.tournament_tickets%rowtype;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_receipt public.chip_transactions%rowtype;
  v_issue public.chip_transactions%rowtype;
  v_escrow_entity uuid;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_ticket_id is null then return jsonb_build_object('success',false,'error','Choose A Ticket'); end if;

  select * into v_t from public.tournament_tickets where id=p_ticket_id for update;
  if not found then return jsonb_build_object('success',false,'error','Ticket Not Found'); end if;
  if v_t.holder_id is distinct from v_me then
    return jsonb_build_object('success',false,'error','This Ticket Is Not Yours');
  end if;
  if v_t.status='redeemed' then
    select * into v_receipt from public.chip_transactions
     where transaction_type='tournament_ticket_redeem'
       and metadata->>'ticket_id'=p_ticket_id::text limit 1;
    if found then
      return jsonb_build_object(
        'success',true,'replayed',true,'value',v_t.value,
        'your_balance',(v_receipt.metadata->>'holder_balance_after')::numeric,
        'transaction_id',v_receipt.id
      );
    end if;
  end if;
  if v_t.status<>'issued' then
    return jsonb_build_object('success',false,'error','Ticket Already '||initcap(v_t.status));
  end if;

  select * into v_issue from public.chip_transactions
   where transaction_type='tournament_ticket_issue'
     and metadata->>'ticket_id'=p_ticket_id::text limit 1;
  if found and v_issue.metadata ? 'escrow_entity_id' then
    if v_issue.club_id is distinct from v_t.club_id
      or v_issue.from_user_id is distinct from v_t.issued_by
      or v_issue.to_user_id is distinct from v_t.holder_id
      or v_issue.amount is distinct from v_t.value
      or v_issue.metadata->>'escrow_entity_id' is distinct from p_ticket_id::text then
      raise exception 'Ticket escrow receipt does not match its entitlement' using errcode='22023';
    end if;
    v_escrow_entity:=p_ticket_id;
  end if;
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_category','ticket_redeem',true);
  perform set_config('app.ledger_counterparty','escrow',true);
  perform set_config('app.ledger_counterparty_entity',coalesce(v_escrow_entity::text,''),true);
  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()
   where club_id=v_t.club_id and user_id=v_me
     and coalesce(status,'active') in ('active','approved')
   returning chip_balance into v_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;
  if v_after is null then
    return jsonb_build_object('success',false,'error','You Are No Longer A Member Of That Club');
  end if;

  update public.tournament_tickets
     set status='redeemed',redeemed_at=now()
   where id=p_ticket_id;
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values (
    v_t.club_id,null,v_me,v_t.value,'tournament_ticket_redeem',
    'Tournament Ticket Redeemed: Escrow Released',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,'holder_id',v_t.holder_id,
      'escrow_action','release_to_holder','holder_balance_after',v_after
    )
  ) returning * into v_receipt;

  insert into public.wallet_transactions
    (user_id,wallet_type,type,amount,category,description,balance_after)
  values (
    v_me,'PLAYER','credit',v_t.value,'transfer',
    'Tournament Ticket Redeemed: Escrow Released',v_after
  );

  return jsonb_build_object(
    'success',true,'replayed',false,'value',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id
  );
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_redeem_tournament_ticket(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_redeem_tournament_ticket(uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
