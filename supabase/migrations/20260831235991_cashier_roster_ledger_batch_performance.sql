-- CASHIER PHASE 3 - ROSTER, LEDGER, AND BATCH PERFORMANCE (2026-08-31)
--
-- 1. The browser can paint the first authoritative roster page immediately and
--    continue with an ordered keyset cursor. OFFSET made every later page walk
--    the rows it had already returned and the SPA withheld all pages until the
--    final request completed.
-- 2. The two club-ledger party lookups now have club-scoped covering indexes.
-- 3. A cashier batch uses one RPC per bounded chunk. Each item keeps its own
--    mandatory retry key and its own subtransaction, so a partial failure is
--    explicit and a response-loss retry cannot move successful items twice.
--
-- The concurrent indexes intentionally sit outside a transaction: this ledger
-- is hot and a release must not stop chip writes while PostgreSQL builds them.

create index concurrently if not exists club_members_cashier_tree_idx
  on public.club_members (club_id, agent_id, user_id)
  include (role, status, chip_balance)
  where coalesce(status, 'active') in ('active', 'approved');

create index concurrently if not exists chip_transactions_club_from_created_idx
  on public.chip_transactions (club_id, from_user_id, created_at desc)
  include (amount, transaction_type, to_user_id, notes);

create index concurrently if not exists chip_transactions_club_to_created_idx
  on public.chip_transactions (club_id, to_user_id, created_at desc)
  include (amount, transaction_type, from_user_id, notes);

begin;

create or replace function public.fn_club_cashier_members_page_v3(
  p_club_id uuid,
  p_after_role_rank integer default null,
  p_after_user_id uuid default null,
  p_limit integer default 500
)
returns table (
  user_id uuid, role text, role_rank int, depth int, chip_balance numeric,
  name text, username text, player_number text, avatar_url text, is_horse boolean
)
language sql stable security definer set search_path to 'public','pg_temp'
as $function$
  select m.user_id, m.role, m.role_rank, m.depth, m.chip_balance,
         m.name, m.username, m.player_number, m.avatar_url, m.is_horse
    from public.fn_club_cashier_members_v2(p_club_id) m
   where p_after_role_rank is null
      or m.role_rank < p_after_role_rank
      or (m.role_rank = p_after_role_rank and m.user_id > p_after_user_id)
   order by m.role_rank desc, m.user_id
   limit greatest(1, least(coalesce(p_limit, 500), 500))
$function$;

comment on function public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer) is
  'Stable keyset page of the caller-authorized cashier roster. Cursor is the previous page final role_rank/user_id.';

revoke all on function public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)
  from public, anon;
grant execute on function public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)
  to authenticated, service_role;

create or replace function public.fn_cashier_batch_transfer(
  p_club_id uuid,
  p_kind text,
  p_items jsonb,
  p_batch_id uuid
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
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

  -- Validate the complete envelope before the first item can move money.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_item->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' then
      return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
    end if;
    v_user_id := (v_item->>'user_id')::uuid;
    v_amount := (v_item->>'amount')::numeric;
    if v_user_id = any(v_seen) then
      return jsonb_build_object('success',false,'error','A Recipient May Appear Only Once Per Batch');
    end if;
    v_seen := array_append(v_seen, v_user_id);
    if v_amount <= 0 or v_amount > 1e9 or v_amount <> round(v_amount,2) then
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
    v_amount := (v_item->>'amount')::numeric;
    begin
      if p_kind='send' then
        v_destination := coalesce(nullif(v_item->>'destination',''),'player_wallet');
        v_reason := nullif(v_item->>'reason','');
        v_op_id := (v_item->>'op_id')::uuid;
        v_result := public.fn_agent_wallet_send(
          p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id
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
$function$;

comment on function public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid) is
  'Processes at most 25 idempotent cashier sends or tickets in one round trip and returns one explicit result per recipient.';

revoke all on function public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)
  from public, anon;
grant execute on function public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)
  to authenticated, service_role;

do $assert$
begin
  if has_function_privilege('anon','public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)','EXECUTE') then
    raise exception 'anonymous batch cashier execution survived';
  end if;
  if not has_function_privilege('authenticated','public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)','EXECUTE') then
    raise exception 'authenticated cashier batch execution is missing';
  end if;
  if to_regprocedure('public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)') is null then
    raise exception 'cashier roster keyset function is missing';
  end if;
end
$assert$;

commit;
