-- 20260905040020_a_sweep_has_no_actor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Seen on production the minute the union Promo Wallet ledger went live: every
-- BBJ promo sweep row read "By Player". A sweep is written by pg_cron with
-- created_by NULL, and fn_arena_name() answers 'Player' for a profile that is
-- all NULLs - the ledger was naming a person who does not exist. A row with no
-- actor now carries actor_name NULL and the screen prints nothing for it.
-- Same rule for chip_ledger.performed_by on the club and agent scopes.
--
-- fn_promo_wallet_ledger body only. Everything else in it is the
-- 20260905034640 definition, unchanged (the plan_cache_mode setting survives
-- CREATE OR REPLACE; it is re-stated here so the file says what production
-- has).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_promo_wallet_ledger(
  p_scope text,
  p_scope_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_wallet text DEFAULT 'promo_wallet'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor  uuid := auth.uid();
  v_limit  int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_entity uuid;
  v_total  bigint;
  v_rows   jsonb;
  v_in     numeric;
  v_out    numeric;
  v_totals jsonb;
  v_cp     record;
begin
  if p_scope = 'union' then
    if coalesce(auth.role(), '') <> 'service_role'
       and not public.fn_union_can_manage_wallets(p_scope_id, v_actor)
       and not exists (select 1 from union_admins ua
                        where ua.union_id = p_scope_id and ua.user_id = v_actor) then
      return jsonb_build_object('authorized', false,
        'error', 'The Union Wallet Ledger Is Restricted To Union Staff');
    end if;
    if p_wallet not in ('chip_balance', 'rake_wallet', 'bbj_wallet', 'promo_wallet',
                        'insurance_wallet', 'spin_reserve_wallet') then
      return jsonb_build_object('authorized', false, 'error', 'Unknown Union Wallet');
    end if;

    -- The rake wallet is over a million rows: its running totals are the
    -- reconciliation checkpoint plus what has arrived since it. Every other
    -- wallet is small enough to sum on the index.
    if v_offset = 0 then
      select * into v_cp from union_rake_ledger_checkpoint c where c.union_id = p_scope_id;
      if p_wallet = 'rake_wallet' and found then
        select v_cp.rows_seen + count(*),
               v_cp.credits + coalesce(sum(t.amount) filter (where t.direction = 'credit'), 0),
               v_cp.debits  + coalesce(sum(t.amount) filter (where t.direction = 'debit'), 0)
          into v_total, v_in, v_out
          from union_wallet_transactions t
         where t.union_id = p_scope_id and t.wallet = p_wallet and t.created_at > v_cp.as_of;
      else
        select count(*),
               coalesce(sum(t.amount) filter (where t.direction = 'credit'), 0),
               coalesce(sum(t.amount) filter (where t.direction = 'debit'), 0)
          into v_total, v_in, v_out
          from union_wallet_transactions t
         where t.union_id = p_scope_id and t.wallet = p_wallet;
      end if;
      v_totals := jsonb_build_object('in', round(v_in, 2), 'out', round(v_out, 2),
                                     'net', round(v_in - v_out, 2));
    else
      v_total := null;
      v_totals := null;
    end if;

    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', t.id,
               'created_at', t.created_at,
               'amount', round(coalesce(t.amount, 0), 2),
               'direction', case when t.direction = 'credit' then 'in' else 'out' end,
               'category', t.tx_type,
               'notes', t.notes,
               'balance_after', t.balance_after,
               'counterparty_type', case when t.club_id is not null then 'club' else null end,
               'counterparty_name', c.name,
               'actor_name', case when t.created_by is null then null else
                               coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                        pa.first_name, pa.last_name, pa.full_name), pa.username) end
             ) as r
        from union_wallet_transactions t
        left join clubs c on c.id = t.club_id
        left join profiles pa on pa.id = t.created_by
       where t.union_id = p_scope_id and t.wallet = p_wallet
       order by t.created_at desc
       limit v_limit offset v_offset
    ) s;

    return jsonb_build_object('authorized', true, 'scope', 'union', 'wallet', p_wallet,
      'total', v_total, 'limit', v_limit, 'offset', v_offset,
      'totals', v_totals,
      'rows', v_rows);
  end if;

  -- The two club-surface promo wallets live in chip_ledger under the account
  -- type 'promo_wallet': entity = the club for clubs.promo_balance, entity =
  -- the person for agents.promo_wallet_balance (scoped to one club by club_id).
  if p_scope = 'club' then
    if not public.fn_can_use_club_bank(p_scope_id) then
      return jsonb_build_object('authorized', false,
        'error', 'The Club Promo Wallet Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
    end if;
    v_entity := p_scope_id;
  elsif p_scope = 'agent' then
    if v_actor is null or not exists (
         select 1 from club_members cm
          where cm.club_id = p_scope_id and cm.user_id = v_actor
            and coalesce(cm.status, 'active') in ('active', 'approved')) then
      return jsonb_build_object('authorized', false,
        'error', 'You Do Not Hold A Promo Wallet In This Club');
    end if;
    v_entity := v_actor;
  else
    return jsonb_build_object('authorized', false, 'error', 'Unknown Ledger Scope');
  end if;

  if v_offset = 0 then
    select count(*),
           coalesce(sum(l.amount) filter (where l.to_type = 'promo_wallet' and l.to_entity_id = v_entity), 0),
           coalesce(sum(l.amount) filter (where l.from_type = 'promo_wallet' and l.from_entity_id = v_entity), 0)
      into v_total, v_in, v_out
      from chip_ledger l
     where ((l.to_type = 'promo_wallet' and l.to_entity_id = v_entity)
         or (l.from_type = 'promo_wallet' and l.from_entity_id = v_entity))
       and (p_scope = 'club' or l.club_id = p_scope_id);
    v_totals := jsonb_build_object('in', round(v_in, 2), 'out', round(v_out, 2),
                                   'net', round(v_in - v_out, 2));
  else
    v_total := null;
    v_totals := null;
  end if;

  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', l.id,
             'created_at', l.created_at,
             'amount', round(coalesce(l.amount, 0), 2),
             'direction', x.dir,
             'category', l.category,
             'notes', coalesce(l.notes, l.description),
             'balance_after', case when x.dir = 'in' then l.post_to_balance else l.post_from_balance end,
             'counterparty_type', x.cp_type,
             'counterparty_name',
               case
                 when pp.id is not null then coalesce(public.fn_arena_name(pp.alias, pp.username,
                        pp.display_name, pp.first_name, pp.last_name, pp.full_name), pp.username)
                 when cc.id is not null then cc.name
                 when uu.id is not null then uu.name
                 else null
               end,
             'actor_name', case when l.performed_by is null then null else
                             coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                      pa.first_name, pa.last_name, pa.full_name), pa.username) end
           ) as r
      from chip_ledger l
      cross join lateral (
        select case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then 'in' else 'out' end as dir,
               case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then l.from_type else l.to_type end as cp_type,
               case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then l.from_entity_id else l.to_entity_id end as cp_id
      ) x
      left join profiles pp on pp.id = x.cp_id
        and x.cp_type in ('player_wallet', 'agent_wallet', 'promo_wallet')
      left join clubs cc on cc.id = x.cp_id and pp.id is null
      left join unions uu on uu.id = x.cp_id and pp.id is null and cc.id is null
      left join profiles pa on pa.id = l.performed_by
     where ((l.to_type = 'promo_wallet' and l.to_entity_id = v_entity)
         or (l.from_type = 'promo_wallet' and l.from_entity_id = v_entity))
       and (p_scope = 'club' or l.club_id = p_scope_id)
     order by l.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object('authorized', true, 'scope', p_scope, 'wallet', 'promo_wallet',
    'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'totals', v_totals,
    'rows', v_rows);
end
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text) TO authenticated, service_role;
ALTER FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text)
  SET plan_cache_mode = 'force_custom_plan';

COMMIT;
