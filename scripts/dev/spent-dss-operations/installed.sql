-- Deep Stack Society joins Midway Union, live 12:00 PM Central 2026-10-12 (17:00 UTC).
-- Dan's decision 2026-10-11; registry sign-off given by Dan at the keyboard.

insert into public.ca_money_rpc_registry (proname, status, notes)
select v.p, v.s, v.n from (values
  ('ops_dss_midway_sweep', 'approved',
   'One-off, signed off by Dan 2026-10-11. Moves Deep Stack Society''s blocking chips into Midway Union''s bank before the join: BBJ pool + club promo into the club bank via fn_close_club_wallets_on_union_join; horse-agent agent/promo wallets and human member wallets into the club bank via fn_club_bank_claim_back (owner identity); then the club bank into union_wallets.chip_balance in the exact ledger shape of fn_union_clawback_from_club (union_settlement, club_treasury -> union_bank, one leg journalled by the clubs trigger, union_wallets journal stood down, uwt clawback row). Revoked from anon/authenticated.'),
  ('ops_dss_midway_go_live', 'approved',
   'One-off, signed off by Dan 2026-10-11, fired by pg_cron at 2026-10-12 17:00 UTC. Runs ops_dss_midway_sweep, fn_union_close_club_tables_for_join, inserts union_clubs (join trigger enforces empty club), union_club_terms, releases the DSS horse seating hold via fn_ca_fleet_set_policy, unschedules itself. Moves money only through ops_dss_midway_sweep.')
) v(p, s, n)
where not exists (select 1 from public.ca_money_rpc_registry r where r.proname = v.p);

create or replace function public.ops_ledger_reset_declarations()
returns void language plpgsql set search_path = public, pg_temp as $$
declare t text;
begin
  perform set_config('app.ledger_category', '', true);
  perform set_config('app.ledger_counterparty', '', true);
  perform set_config('app.ledger_counterparty_entity', '', true);
  perform set_config('app.ledger_counterparty_label', '', true);
  perform set_config('app.ledger_idempotency_key', '', true);
  perform set_config('app.ledger_correlation', '', true);
  perform set_config('app.ledger_autoledger_club_id', '', true);
  foreach t in array array['clubs','agents','club_members','union_wallets','unions',
                           'bbj_pools','club_wallets','spin_bonus_pools'] loop
    perform set_config('app.ledger_autoskip_' || t, '', true);
  end loop;
end $$;

create or replace function public.ops_dss_midway_sweep(p_stage text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_club  constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';  -- Deep Stack Society
  c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';  -- Midway Union
  c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';  -- Dan, owner of both
  c_note  constant text := 'Deep Stack Society to Midway Union bank ahead of joining the union (Dan, 2026-10-11)';
  r record; v_res jsonb; v_close jsonb; v_moves jsonb := '[]'::jsonb;
  v_treasury numeric; v_union_after numeric; v_op uuid; v_moved numeric := 0;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  if exists (select 1 from table_seats ts join tables t on t.id = ts.table_id
              where t.club_id = c_club and ts.left_at is null) then
    raise exception 'DSS_SWEEP: someone is seated at a Deep Stack Society table';
  end if;

  perform public.ops_ledger_reset_declarations();
  v_close := public.fn_close_club_wallets_on_union_join(c_club, c_union);

  for r in select a.user_id, coalesce(a.agent_wallet_balance,0) aw, coalesce(a.promo_wallet_balance,0) pw,
                  coalesce(a.player_wallet_balance,0) plw
             from agents a where a.club_id = c_club
              and (coalesce(a.agent_wallet_balance,0) <> 0 or coalesce(a.promo_wallet_balance,0) <> 0
                   or coalesce(a.player_wallet_balance,0) <> 0)
  loop
    if r.aw < 0 or r.pw < 0 or r.plw <> 0 then
      raise exception 'DSS_SWEEP: agent % holds an unexpected balance (agent %, promo %, player %)', r.user_id, r.aw, r.pw, r.plw;
    end if;
    if r.aw > 0 then
      perform public.ops_ledger_reset_declarations();
      v_res := public.fn_club_bank_claim_back(c_club, r.user_id, r.aw, 'agent_wallet', c_note, gen_random_uuid());
      if coalesce(v_res->>'success','') <> 'true' then
        raise exception 'DSS_SWEEP: agent wallet claim failed for %: %', r.user_id, v_res;
      end if;
      v_moves := v_moves || jsonb_build_object('agent', r.user_id, 'wallet', 'agent', 'amount', r.aw);
    end if;
    if r.pw > 0 then
      perform public.ops_ledger_reset_declarations();
      v_res := public.fn_club_bank_claim_back(c_club, r.user_id, r.pw, 'promo_wallet', c_note, gen_random_uuid());
      if coalesce(v_res->>'success','') <> 'true' then
        raise exception 'DSS_SWEEP: agent promo claim failed for %: %', r.user_id, v_res;
      end if;
      v_moves := v_moves || jsonb_build_object('agent', r.user_id, 'wallet', 'promo', 'amount', r.pw);
    end if;
  end loop;

  for r in select cm.user_id, coalesce(cm.chip_balance,0) cb,
                  coalesce(cm.promo_balance,0) + coalesce(cm.held_chips,0) + coalesce(cm.locked_chips,0) other
             from club_members cm left join profiles p on p.id = cm.user_id
            where cm.club_id = c_club and not coalesce(cm.is_bot,false) and not coalesce(p.is_horse,false)
              and coalesce(cm.chip_balance,0) + coalesce(cm.promo_balance,0)
                + coalesce(cm.held_chips,0) + coalesce(cm.locked_chips,0) <> 0
  loop
    if r.other <> 0 or r.cb < 0 then
      raise exception 'DSS_SWEEP: member % holds promo/held/locked or negative chips (%, %)', r.user_id, r.cb, r.other;
    end if;
    perform public.ops_ledger_reset_declarations();
    v_res := public.fn_club_bank_claim_back(c_club, r.user_id, r.cb, 'player_wallet', c_note, gen_random_uuid());
    if coalesce(v_res->>'success','') <> 'true' then
      raise exception 'DSS_SWEEP: member wallet claim failed for %: %', r.user_id, v_res;
    end if;
    v_moves := v_moves || jsonb_build_object('member', r.user_id, 'amount', r.cb);
  end loop;

  perform public.ops_ledger_reset_declarations();
  select coalesce(chip_treasury,0) into v_treasury from clubs where id = c_club for update;
  if v_treasury < 0 then
    raise exception 'DSS_SWEEP: club bank is negative (%)', v_treasury;
  end if;
  if v_treasury > 0 then
    v_op := gen_random_uuid();
    perform public.fn_ca_declare_ledger('union_settlement', 'union_bank', c_union, null,
      'union_clawback:' || v_op::text, array['union_wallets']);
    perform set_config('app.ledger_correlation', v_op::text, true);

    update clubs set chip_treasury = 0 where id = c_club;

    insert into union_wallets (union_id, chip_balance) values (c_union, v_treasury)
    on conflict (union_id) do update
      set chip_balance = coalesce(union_wallets.chip_balance,0) + v_treasury, updated_at = now()
    returning chip_balance into v_union_after;
    perform set_config('app.ledger_autoskip_union_wallets', '', true);

    insert into union_wallet_transactions
      (union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by)
    values (c_union, 'chip_balance', 'credit', v_treasury, v_union_after, 'clawback',
            c_club, v_op, c_note || ' [' || p_stage || ']', c_owner);

    insert into chip_transactions (club_id, amount, transaction_type, notes, balance_after, metadata)
    values (c_club, v_treasury, 'union_clawback', c_note || ' [' || p_stage || ']', 0,
            jsonb_build_object('reason','union_join_prep','union_id',c_union,'op_id',v_op,'stage',p_stage));
    v_moved := v_treasury;
  end if;
  perform public.ops_ledger_reset_declarations();

  return jsonb_build_object('stage', p_stage, 'closed', v_close, 'claims', v_moves,
    'to_union_bank', v_moved, 'union_bank_after', v_union_after,
    'blockers', public.fn_club_union_join_blockers(c_club));
end $$;

create or replace function public.ops_dss_midway_go_live()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_club  constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  v_sweep jsonb; v_tables jsonb; v_pol jsonb;
begin
  if exists (select 1 from union_clubs where club_id = c_club) then
    return jsonb_build_object('ok', true, 'already_joined', true);
  end if;

  v_sweep := public.ops_dss_midway_sweep('noon');
  if not coalesce((v_sweep->'blockers'->>'is_empty')::boolean, false) then
    raise exception 'DSS_GO_LIVE: club still holds chips after the sweep: %', v_sweep->'blockers';
  end if;

  v_tables := public.fn_union_close_club_tables_for_join(c_club);
  if coalesce(v_tables->>'success','') <> 'true' then
    raise exception 'DSS_GO_LIVE: table close refused: %', v_tables;
  end if;

  perform public.ops_ledger_reset_declarations();
  insert into union_clubs (union_id, club_id) values (c_union, c_club);
  perform public.ops_ledger_reset_declarations();

  insert into union_club_terms (union_id, club_id, security_deposit, status, notes)
  values (c_union, c_club, 0, 'active',
    'No security deposit, stop-loss or stakes cap is required of this club today - the same terms as Club JAQK and SHARK CLUB. Recorded 2026-10-12 when Deep Stack Society joined Midway Union.')
  on conflict do nothing;

  v_pol := public.fn_ca_fleet_set_policy('club', c_club,
    jsonb_build_object('pause_new_seatings', null,
      'notes', 'Deep Stack Society went live in Midway Union at 12 PM Central 2026-10-12; the 2026-10-04 seating hold was released at that time (Dan).'),
    c_owner, 'Deep Stack Society goes live in Midway Union at 12 PM Central 2026-10-12');
  if coalesce(v_pol->>'ok','') <> 'true' then
    raise exception 'DSS_GO_LIVE: horse release refused: %', v_pol;
  end if;

  begin
    perform cron.unschedule('dss-midway-go-live');
  exception when others then null;
  end;

  return jsonb_build_object('ok', true, 'sweep', v_sweep, 'tables', v_tables, 'horse_policy', v_pol,
    'effective', public.fn_ca_fleet_policy_effective(c_club));
end $$;

revoke all on function public.ops_ledger_reset_declarations() from public, anon, authenticated;
revoke all on function public.ops_dss_midway_sweep(text) from public, anon, authenticated;
revoke all on function public.ops_dss_midway_go_live() from public, anon, authenticated;