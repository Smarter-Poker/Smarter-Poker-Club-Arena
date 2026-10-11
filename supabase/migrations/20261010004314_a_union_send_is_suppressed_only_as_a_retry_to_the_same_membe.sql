-- 20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch audit C6-02, 2026-10-09):
--
-- fn_union_send_to_member_zd3core (behind fn_union_send_to_member, the Union
-- Wallet's send to a member) suppresses "an identical union send (union,
-- recipient, kind, amount, actor) inside 20 seconds" as a retry and answers
-- success with duplicate_suppressed. Its query matched the union, the amount
-- and the actor only: union_wallet_transactions carries no recipient and both
-- kinds were accepted. So a union admin who sent 100 to one member and then
-- 100 to another inside 20 seconds was told success while the second member
-- received nothing, and a promo send after a chip send of the same amount was
-- dropped the same way. Production's live body (md5 fcb71e70f696bed13717951c73f0eb98, the 20261004144116
-- rewrite) was proved on PostgreSQL 17 with production's own wrapper text
-- (scripts/ci/test-union-send-db-postgres.py, tests/fixtures/union-send-db/scenario.sql:
-- it fails before and passes after).
--
-- The suppression now matches all five: the kind's own union-side row (actor,
-- amount, within 20 seconds) AND the recipient-side ledger leg the same send
-- journalled in the same transaction (union_wallet -> that member's wallet,
-- same instant, same amount, the kind's category). A true retry of the same
-- send is still suppressed and moves nothing twice; a different member or the
-- other kind is paid.
--
-- Not changed: authorization, the wallets, the legs, the receipts, the return
-- shapes, the op-id wrapper, grants ({postgres=X/postgres,service_role=X/postgres}),
-- SECURITY DEFINER and search_path.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) = 'b90deb8384011de172bcb80d375a475d')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) IS DISTINCT FROM 'fcb71e70f696bed13717951c73f0eb98' THEN
    RAISE EXCEPTION 'fn_union_send_to_member_zd3core is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_union_send_to_member_zd3core(p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric, p_source_wallet text, p_note text)
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
  -- 2026-09-07 (Diamond Accounting Standard DR2, ruling): a union send of diamonds credited a player with
  -- no debit anywhere - a mint of up to 100,000 per call outside the Mint. Diamonds are issued only by
  -- fn_ca_mint. The diamonds branch below is unreachable and kept only as history.
  if p_kind not in ('chips','promo') then
    return jsonb_build_object('success', false, 'error', 'kind must be chips or promo. Diamonds are issued only by the Mint (Diamond Accounting Standard DR2).');
  end if;

  /* ZERO-DRIFT round 2 (2026-08-31): duplicate-send suppression. An identical
     union send (union, recipient, kind, amount, actor) inside 20 seconds is a
     retry, not a second intent.
     2026-10-09 (cashier launch audit C6-02): it now matches all five. It
     matched the union, the amount and the actor only, so a send of the same
     amount to a DIFFERENT member, or of the other kind, inside 20 seconds was
     answered success with nothing moved. The union-side row names no
     recipient; the recipient-side ledger leg this send journals in the same
     transaction (union_wallet -> the member's wallet, same instant) does. */
  if p_kind in ('chips','promo') and exists (
      select 1 from union_wallet_transactions t
       where t.union_id = p_union_id
         and t.direction = 'debit'
         and t.amount = p_amount
         and t.tx_type = case when p_kind = 'promo' then 'promo_member_send' else 'member_send' end
         and t.created_by is not distinct from v_actor
         and t.created_at > now() - interval '20 seconds'
         and exists (
           select 1 from chip_ledger l
            where l.to_entity_id = p_target_user_id
              and l.created_at = t.created_at
              and l.from_type = 'union_wallet'
              and l.from_entity_id = p_union_id
              and l.category = case when p_kind = 'promo' then 'promo_send' else 'union_send' end
              and l.amount = p_amount)) then
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
    /* DR2, LOG-ONLY (2026-09-03). This credit has no debit: no union diamond wallet is
       decremented, nothing is drawn from the Mint, and no budget is consumed. It creates
       diamonds out of nothing, up to 100,000 per call. It is RECORDED and allowed to
       proceed; refusing a live grant is Dan's call (decision 6.6, fund it or remove it). */
    perform public.fn_ca_diamond_incident(
      'DR2:union_diamond_grant_unfunded', 'warning', p_target_user_id, p_amount,
      'fn_union_send_to_member_zd3core',
      jsonb_build_object('union_id', p_union_id,
                         'source_wallet', p_source_wallet,
                         'club_id', v_club,
                         'actor', v_actor,
                         'note', 'diamonds credited with no debit on any wallet and no mint row; unfunded issuance'));
    update profiles set diamonds = coalesce(diamonds, 0) + p_amount
     where id = p_target_user_id
    returning diamonds into v_dia_after;
    if v_dia_after is null then
      return jsonb_build_object('success', false, 'error', 'player profile not found');
    end if;
    insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata, counterparty, issuance_class)
    values (p_target_user_id, 'credit', p_amount, v_dia_after,
            coalesce(p_note, 'Union grant'), 'union_grant', 'union',
            jsonb_build_object('union_id', p_union_id, 'granted_by', v_actor),
            'union:' || p_union_id::text, 'promotional');
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
  perform set_config('app.ledger_counterparty_label',
                     case when p_kind = 'promo' then 'union_wallets.promo_wallet' else '' end, true);

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

  perform set_config('app.ledger_counterparty_label',
                     case v_source when 'chips' then 'union_wallets.chip_balance'
                                   when 'rake' then 'union_wallets.rake_wallet'
                                   else 'union_wallets.promo_wallet' end, true);
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

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) IS DISTINCT FROM 'b90deb8384011de172bcb80d375a475d' THEN
    RAISE EXCEPTION 'fn_union_send_to_member_zd3core is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'fn_union_send_to_member_zd3core lost its definer posture or its owner-and-service grants' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
