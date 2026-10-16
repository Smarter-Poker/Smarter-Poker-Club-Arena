CREATE OR REPLACE FUNCTION public.fn_cashier_batch_transfer(p_club_id uuid, p_kind text, p_items jsonb, p_batch_id uuid)
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
        v_result := public.fn_agent_wallet_send(
          p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id
        );
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
