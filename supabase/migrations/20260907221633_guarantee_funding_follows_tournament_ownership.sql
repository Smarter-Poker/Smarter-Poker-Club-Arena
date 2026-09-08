-- Match final guarantee funding to the same event-owned scope used at start.
-- Current club membership must not redirect a recorded tournament liability.
-- Private and standalone events use club treasury. Existing absent-bank
-- fallback, guarantees, prices and funding arithmetic remain unchanged.
-- Actual-function isolated probes reproduced wrong-union debit and passed
-- event ownership, private/standalone, replay and absent-bank cases.
BEGIN;
DO $guard$ BEGIN
IF md5(pg_get_functiondef('public.fn_apply_prize_guarantee(uuid,text)'::regprocedure)) <> '1541b5c4f858836f9f326f3a996c3829' THEN
RAISE EXCEPTION 'Guarantee function changed; rebase correction'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_union uuid; v_bank_type text; v_bank_entity uuid;
  v_balance_after numeric; v_bank_name text; v_updated integer;
  v_note text := 'Guarantees are funded daily; union rake returns at the '
              || 'weekly rakeback close, so a mid-week dip is usually timing. '
              || 'Escalate if it survives a close.';
begin
  select t.id, t.club_id, t.name, t.union_id, coalesce(t.is_private, false) as is_private,
         coalesce(t.prize_pool, 0) as pool,
         coalesce(t.guaranteed_prize, 0) as gtd, coalesce(t.prize_pool_finalized, false) as finalized
    into v_t from public.tournaments t where t.id = p_tournament_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_t.finalized then
    return jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  end if;

  v_final := greatest(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  if v_overlay > 0 then
    -- ZERO-DRIFT phase 2: overlay funding = 'overlay' vs the tournament.
    perform set_config('app.ledger_category', 'overlay', true);
    perform set_config('app.ledger_counterparty', 'prize_liability', true);
    perform set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    -- The event owns its funding scope, as in fn_ca_fund_overlay_on_lock.
    -- A club joining another union must not redirect this event's guarantee.
    v_union := CASE WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
    if v_union is not null then
      v_bank_type := 'union'; v_bank_entity := v_union;
    else
      v_bank_type := 'club'; v_bank_entity := v_t.club_id;
    end if;

    insert into public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source,
       bank_type, bank_entity_id, union_id)
    values (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final,
            coalesce(p_source, 'engine'), v_bank_type, v_bank_entity, v_union)
    on conflict (tournament_id) do nothing;
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      update public.tournaments set prize_pool_finalized = true where id = p_tournament_id;
      return jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    end if;

    if v_bank_type = 'union' then
      update public.union_wallets
         set chip_balance = coalesce(chip_balance, 0) - v_overlay,
             updated_at = now()
       where union_id = v_union
       returning chip_balance into v_balance_after;

      if v_balance_after is null then
        update public.tournament_guarantee_overlays
           set bank_type = 'club', bank_entity_id = v_t.club_id
         where tournament_id = p_tournament_id;
        update public.clubs
           set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
         where id = v_t.club_id
         returning chip_treasury into v_balance_after;
        v_bank_type := 'club'; v_bank_entity := v_t.club_id;
      else
        insert into public.union_wallet_transactions
          (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
        values
          (v_union, 'chip_balance', 'debit', v_overlay, v_balance_after,
           'guarantee_overlay', v_t.club_id,
           'Overlay for tournament ' || coalesce(v_t.name, p_tournament_id::text)
             || ' (' || p_tournament_id || '), pool ' || v_t.pool || ' -> ' || v_final);
      end if;
    else
      update public.clubs
         set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
       where id = v_t.club_id
       returning chip_treasury into v_balance_after;
    end if;

    update public.tournament_guarantee_overlays
       set treasury_after = v_balance_after
     where tournament_id = p_tournament_id;

    select case when v_bank_type = 'union'
                then (select u.name from public.unions u where u.id = v_union)
                else (select c.name from public.clubs c where c.id = v_t.club_id) end
      into v_bank_name;

    if v_balance_after is not null and v_balance_after < 0 then
      update public.financial_alerts
         set severity = 'critical',
             message = 'Bank is negative from funding advertised guarantees: '
                       || coalesce(v_bank_name, v_bank_entity::text),
             context = jsonb_build_object(
                         'bank_type', v_bank_type,
                         'bank_entity_id', v_bank_entity,
                         'club_id', v_t.club_id,
                         'balance_after', v_balance_after,
                         'shortfall', round(-v_balance_after, 2),
                         'latest_tournament_id', p_tournament_id,
                         'latest_overlay', v_overlay,
                         'note', v_note),
             created_at = now()
       where source = 'fn_apply_prize_guarantee'
         and resolved is not true
         and context->>'bank_entity_id' = v_bank_entity::text;
      get diagnostics v_updated = row_count;

      if v_updated = 0 then
        insert into public.financial_alerts (severity, source, message, context)
        values ('critical', 'fn_apply_prize_guarantee',
                'Bank is negative from funding advertised guarantees: '
                  || coalesce(v_bank_name, v_bank_entity::text),
                jsonb_build_object(
                  'bank_type', v_bank_type,
                  'bank_entity_id', v_bank_entity,
                  'club_id', v_t.club_id,
                  'balance_after', v_balance_after,
                  'shortfall', round(-v_balance_after, 2),
                  'latest_tournament_id', p_tournament_id,
                  'latest_overlay', v_overlay,
                  'note', v_note));
      end if;
    end if;
  end if;

  update public.tournaments
     set prize_pool = v_final, prize_pool_finalized = true
   where id = p_tournament_id;

  return jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', coalesce(v_overlay, 0),
    'bank_type', v_bank_type, 'bank_entity_id', v_bank_entity,
    'treasury_after', v_balance_after);
end;
$function$;
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid,text) TO service_role;
COMMIT;
