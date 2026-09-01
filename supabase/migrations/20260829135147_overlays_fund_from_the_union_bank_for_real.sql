-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829135147; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Overlays fund from the UNION BANK, and the guarantee guard reads the bank
-- that actually pays (Dan 2026-08-29, binding). Full notes in repo migration
-- 20260829160000_overlays_fund_from_the_union_bank_for_real.sql.
-- Verified live before this: fn_apply_prize_guarantee debited clubs.chip_treasury
-- UNCONDITIONALLY (20260827f's claim it was already fixed was false), and the
-- guard read only the club treasury - so Midway Union (-7,161, structurally
-- negative because union rake returns weekly) was refused ~570 spawns/hour
-- while its union bank held 136,473.58 against 31,350 promised.

create or replace function public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text default 'engine'
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_tmp'
as $$ begin return null; end; $$;

-- (placeholder replaced below; kept single migration atomic)

create or replace function public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text default 'engine'
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_union uuid; v_bank_type text; v_bank_entity uuid;
  v_balance_after numeric; v_bank_name text; v_updated integer;
  v_note text := 'Guarantees are funded daily; union rake returns at the '
              || 'weekly rakeback close, so a mid-week dip is usually timing. '
              || 'Escalate if it survives a close.';
begin
  select t.id, t.club_id, t.name, coalesce(t.prize_pool, 0) as pool,
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
    select c.union_id into v_union from public.clubs c where c.id = v_t.club_id;
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
        -- Union without a wallet row: configuration wound. Do not strand the
        -- claimed overlay - fall back to the club treasury and record it.
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
$$;

comment on function public.fn_apply_prize_guarantee(uuid, text) is
  'Fund a tournament overlay from the bank that owns the club: the UNION bank (union_wallets.chip_balance) for a union-affiliated club, the club''s own chip_treasury for a standalone club. Idempotent via the PK claim on tournament_guarantee_overlays; every union debit writes union_wallet_transactions; a negative bank raises one deduped critical alert per bank.';

create or replace function public.trg_tournaments_guarantee_affordable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_union uuid; v_enforce boolean; v_club_name text;
  v_bank numeric; v_floor numeric; v_bank_label text;
  v_exposure numeric; v_this numeric; v_headroom numeric;
begin
  if coalesce(new.guaranteed_prize, 0) <= 0 or new.club_id is null then
    return new;
  end if;

  select c.union_id, coalesce(c.guarantee_enforcement_enabled, true), c.name,
         coalesce(c.guarantee_treasury_floor, 0)
    into v_union, v_enforce, v_club_name, v_floor
    from public.clubs c where c.id = new.club_id;
  if not found then return new; end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0) into v_bank
      from public.union_wallets uw where uw.union_id = v_union;
    v_bank := coalesce(v_bank, 0);
    v_bank_label := 'union bank';
    v_floor := 0;

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
      join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = new.club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = new.club_id
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  end if;

  v_this     := greatest(coalesce(new.guaranteed_prize,0) - coalesce(new.prize_pool,0), 0);
  v_headroom := v_bank - v_floor - v_exposure - v_this;

  if v_headroom < 0 then
    if v_enforce then
      raise exception
        'Club % cannot guarantee % chips: % holds %, floor %, already promised % on live events — short by %. Add chips to the bank to cover the guarantee.',
        coalesce(v_club_name, new.club_id::text), new.guaranteed_prize,
        v_bank_label, round(v_bank,2), round(v_floor,2), round(v_exposure,2), round(-v_headroom,2)
        using errcode = '55000';
    else
      insert into public.financial_alerts (severity, source, message, context)
      values ('critical', 'trg_tournaments_guarantee_affordable',
              'Guaranteed tournament announced that the ' || v_bank_label || ' cannot cover: '
                || coalesce(v_club_name, new.club_id::text),
              jsonb_build_object('club_id', new.club_id, 'union_id', v_union,
                                 'tournament_id', new.id,
                                 'guaranteed_prize', new.guaranteed_prize,
                                 'bank', v_bank, 'bank_label', v_bank_label,
                                 'floor', v_floor,
                                 'live_exposure', v_exposure, 'short_by', -v_headroom,
                                 'note', 'enforcement disabled for this club; no money was blocked'));
    end if;
  end if;

  return new;
end;
$$;

comment on function public.trg_tournaments_guarantee_affordable() is
  'Refuse a guaranteed tournament only when the bank that actually FUNDS overlays cannot cover it: the union bank for a union-affiliated club (exposure summed across every club sharing it), the club treasury for a standalone club.';

create or replace function public.fn_notify_guarantee_bank_short(
  p_club_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_union uuid; v_club_name text; v_union_name text;
  v_bank numeric; v_bank_label text; v_exposure numeric;
  v_recipients uuid[]; v_uid uuid; v_inserted integer := 0;
  v_title text; v_message text;
begin
  select c.union_id, c.name into v_union, v_club_name
    from public.clubs c where c.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'club_not_found');
  end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0), u.name
      into v_bank, v_union_name
      from public.unions u
      left join public.union_wallets uw on uw.union_id = u.id
     where u.id = v_union;
    v_bank_label := 'union bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(distinct uid) into v_recipients from (
      select u.owner_id as uid from public.unions u where u.id = v_union and u.owner_id is not null
      union
      select c.owner_id from public.clubs c where c.id = p_club_id and c.owner_id is not null
    ) o;
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = p_club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = p_club_id
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(c.owner_id) into v_recipients
      from public.clubs c where c.id = p_club_id and c.owner_id is not null;
  end if;

  v_title := 'More Chips Needed To Cover Guarantees';
  v_message := 'The ' || v_bank_label || ' for '
            || coalesce(case when v_union is not null then v_union_name end, v_club_name, 'your club')
            || ' holds ' || round(v_bank, 2)
            || ' chips against ' || round(v_exposure, 2)
            || ' promised in live guarantees. New guaranteed tournaments cannot start until more chips are added to the bank.';

  foreach v_uid in array coalesce(v_recipients, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_uid
         and n.type = 'guarantee_bank_short'
         and coalesce(n.is_read, false) = false
         and n.data->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
    ) then
      insert into public.notifications (user_id, type, title, message, data, is_read)
      values (v_uid, 'guarantee_bank_short', v_title, v_message,
              jsonb_build_object(
                'bank_type', case when v_union is not null then 'union' else 'club' end,
                'bank_entity_id', coalesce(v_union, p_club_id),
                'club_id', p_club_id, 'union_id', v_union,
                'bank_balance', v_bank, 'live_exposure', v_exposure,
                'short_by', round(greatest(v_exposure - v_bank, 0), 2)),
              false);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_inserted,
    'bank', v_bank, 'exposure', v_exposure,
    'recipients', coalesce(array_length(v_recipients, 1), 0));
end;
$$;

comment on function public.fn_notify_guarantee_bank_short(uuid) is
  'Write the durable owner-facing "More Chips Needed To Cover Guarantees" notification for a club whose funding bank cannot cover its promises. Called by the app AFTER catching the guard''s 55000 refusal (a raising trigger rolls back its own writes). Notifies club owner + union owner; deduped on unread per recipient per bank.';

revoke all on function public.fn_notify_guarantee_bank_short(uuid) from public, anon, authenticated;
grant execute on function public.fn_notify_guarantee_bank_short(uuid) to service_role;

do $$
declare v_def text;
begin
  select prosrc into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_apply_prize_guarantee';
  if v_def not like '%union_wallets%' or v_def not like '%guarantee_overlay%' then
    raise exception 'fn_apply_prize_guarantee does not fund from the union bank';
  end if;

  select prosrc into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='trg_tournaments_guarantee_affordable';
  if v_def not like '%union_wallets%' then
    raise exception 'the guarantee guard still reads only the club treasury';
  end if;
end;
$$;
