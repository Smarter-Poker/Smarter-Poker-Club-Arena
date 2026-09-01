-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:40:01 UTC on kuklfnapbkmacvwxktbh.

-- ZERO-DRIFT PHASE 3A (part 2): fn_union_send_to_member -> core + op-id
-- wrapper. Core is the exact live body; wrapper adds trailing p_op_id.
DROP FUNCTION public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text);

CREATE FUNCTION public.fn_union_send_to_member_zd3core(
  p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric,
  p_source_wallet text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_source     text;
  v_after      numeric;
  v_dia_after  numeric;
  v_club       uuid;
  v_role       text;
  v_is_club    boolean;
  v_agent_row  uuid;
  v_to_after   numeric;
  v_dest       text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if not public.fn_union_can_manage_wallets(p_union_id, v_actor) then
      return jsonb_build_object('success', false, 'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_kind not in ('chips','diamonds','promo') then
    return jsonb_build_object('success', false, 'error', 'kind must be chips, diamonds or promo');
  end if;

  /* ZERO-DRIFT round 2 (2026-08-31): duplicate-send suppression. An identical
     union send (union, recipient, kind, amount, actor) inside 20 seconds is a
     retry, not a second intent. */
  if p_kind in ('chips','promo') and exists (
      select 1 from union_wallet_transactions t
       where t.union_id = p_union_id
         and t.direction = 'debit'
         and t.amount = p_amount
         and t.tx_type in ('member_send','promo_member_send')
         and t.created_by is not distinct from v_actor
         and t.created_at > now() - interval '20 seconds') then
    return jsonb_build_object('success', true, 'duplicate_suppressed', true,
      'note', 'an identical send was recorded seconds ago; nothing moved twice');
  end if;

  select cm.club_id into v_club
    from club_members cm
   where cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
     and cm.club_id = public.fn_player_home_club(p_target_user_id, null)
     and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
   limit 1;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
     order by coalesce(cm.chip_balance, 0) desc, cm.club_id
     limit 1;
  end if;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id = p_union_id
     limit 1;
  end if;
  if v_club is null then
    return jsonb_build_object('success', false, 'error', 'That player is not a member of this union.');
  end if;
  v_is_club := exists (select 1 from clubs c where c.id = v_club);
  select cm.role into v_role from club_members cm
   where cm.club_id = v_club and cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
   limit 1;

  if p_kind = 'diamonds' then
    if p_amount <> floor(p_amount) then
      return jsonb_build_object('success', false, 'error', 'diamonds must be a whole number');
    end if;
    if p_amount > 100000 then
      return jsonb_build_object('success', false, 'error', 'maximum 100,000 diamonds per send');
    end if;
    update profiles set diamonds = coalesce(diamonds, 0) + p_amount
     where id = p_target_user_id
    returning diamonds into v_dia_after;
    if v_dia_after is null then
      return jsonb_build_object('success', false, 'error', 'player profile not found');
    end if;
    insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata)
    values (p_target_user_id, 'credit', p_amount, v_dia_after,
            coalesce(p_note, 'Union grant'), 'union_grant', 'union',
            jsonb_build_object('union_id', p_union_id, 'granted_by', v_actor));
    return jsonb_build_object('success', true, 'kind', 'diamonds', 'balance_after', v_dia_after);
  end if;

  /* ZERO-DRIFT round 2: the recipient-side credit journals ONE clean ledger
     row (union_wallet -> player/agent wallet); the union-side debit is
     autoskipped because union_wallet_transactions already records it and a
     second ledger row would double-post the flow. */
  perform set_config('app.ledger_category',
                     case when p_kind = 'promo' then 'promo_send' else 'union_send' end, true);
  perform set_config('app.ledger_counterparty', 'union_wallet', true);
  perform set_config('app.ledger_counterparty_entity', p_union_id::text, true);
  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
    update union_wallets
       set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
    if v_after is null then
      return jsonb_build_object('success', false, 'error', 'Insufficient promo wallet balance.');
    end if;

    if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
      v_dest := 'promo_float';
      v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
      if v_agent_row is null then
        raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
      end if;
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_row
       returning promo_wallet_balance into v_to_after;
    else
      v_dest := 'player_wallet';
      update club_members
         set chip_balance = coalesce(chip_balance, 0) + p_amount,
             updated_at = now()
       where club_id = v_club and user_id = p_target_user_id
       returning chip_balance into v_to_after;
    end if;
    if v_to_after is null then
      raise exception 'union promo credit landed nowhere for % in %', p_target_user_id, v_club;
    end if;

    insert into union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    values
      (p_union_id, case when v_is_club then v_club else null end,
       'promo_wallet', 'debit', p_amount, v_after, 'promo_member_send',
       coalesce(p_note, 'Union promo to member'), v_actor);
    if v_is_club then
      insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                     metadata)
      values (v_club, v_actor, p_target_user_id, p_amount, 'union_promo_send',
              coalesce(p_note, 'Union promo to member'), v_to_after,
              jsonb_build_object('union_id', p_union_id, 'destination', v_dest));
    end if;
    return jsonb_build_object('success', true, 'kind', 'promo', 'wallet_after', v_after,
                              'destination', v_dest, 'recipient_balance_after', v_to_after);
  end if;

  v_source := coalesce(p_source_wallet, 'chips');
  if v_source not in ('chips','rake','promo') then
    return jsonb_build_object('success', false, 'error', 'source wallet must be chips, rake or promo');
  end if;

  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
  elsif v_source = 'rake' then
    update union_wallets set rake_wallet = rake_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(rake_wallet, 0) >= p_amount
    returning rake_wallet into v_after;
  else
    update union_wallets set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
  end if;

  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'Insufficient balance in the selected union wallet.');
  end if;

  if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_dest := 'agent_wallet';
    v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
    if v_agent_row is null then
      raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_row
     returning agent_wallet_balance into v_to_after;
  else
    v_dest := 'player_wallet';
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = v_club and user_id = p_target_user_id
     returning chip_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'union chip credit landed nowhere for % in %', p_target_user_id, v_club;
  end if;

  insert into union_wallet_transactions
    (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
  values
    (p_union_id, case when v_is_club then v_club else null end,
     case v_source when 'chips' then 'chip_balance' when 'rake' then 'rake_wallet' else 'promo_wallet' end,
     'debit', p_amount, v_after, 'member_send',
     coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_actor);
  if v_is_club then
    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                   metadata)
    values (v_club, v_actor, p_target_user_id, p_amount, 'union_member_send',
            coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_to_after,
            jsonb_build_object('union_id', p_union_id, 'source_wallet', v_source, 'destination', v_dest));
  end if;

  return jsonb_build_object('success', true, 'kind', 'chips', 'source', v_source,
                            'wallet_after', v_after,
                            'destination', v_dest, 'recipient_balance_after', v_to_after);
end $function$;

-- NOTE: this mirror carries the wrapper as AMENDED by
-- 20260901001025_ca_phase5_op_claims_record_their_actor (claimed_by =
-- auth.uid() on the claim row), so the file is self-contained for the
-- definer-authorization gate. The core above is byte-exact as applied.
CREATE OR REPLACE FUNCTION public.fn_union_send_to_member(p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric, p_source_wallet text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_op_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior jsonb;
  v_res jsonb;
begin
  /* ZERO-DRIFT phase 3/5: durable op-id claim with actor audit (see
     ca_op_claims). Authorization itself lives in the core. */
  if p_op_id is null then
    return public.fn_union_send_to_member_zd3core(
      p_union_id, p_target_user_id, p_kind, p_amount, p_source_wallet, p_note);
  end if;

  select result into v_prior
    from public.ca_op_claims
   where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  if found and v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  elsif found then
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  end if;

  insert into public.ca_op_claims (op_id, fn_name, claimed_by)
  values (p_op_id, 'fn_union_send_to_member', v_actor);

  v_res := public.fn_union_send_to_member_zd3core(
    p_union_id, p_target_user_id, p_kind, p_amount, p_source_wallet, p_note);

  if coalesce(v_res->>'success', '') = 'true' then
    update public.ca_op_claims
       set result = v_res, finalized_at = now()
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  else
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  end if;

  return v_res;
end $function$;

REVOKE ALL ON FUNCTION public.fn_union_send_to_member_zd3core(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';;
