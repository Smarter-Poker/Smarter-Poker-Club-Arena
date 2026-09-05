-- 20260905034640_the_union_ledger_totals_do_not_rescan_a_million_rake_rows.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Found in the verification pass on fn_promo_wallet_ledger (20260905030103).
-- The union scope opened with count(*) + two filtered sums over
-- union_wallet_transactions for the wallet on screen. The Midway Union rake
-- wallet holds 1,205,483 rows. Measured on production: 3,535 ms with the old
-- partial index, 1,252 ms after `idx_uwt_union_wallet_created`
-- ((union_id, wallet, created_at DESC) INCLUDE (amount, direction), created
-- CONCURRENTLY outside this transaction on 2026-09-05 03:44 UTC - it also
-- takes the 40-row page for the promo wallet from a 234 ms parallel seq scan
-- to an index walk). A second and a quarter on a single-core database every
-- time an operator opens the rake wallet's Ledger tab, and again on every
-- Load More, is a cost the engine pays.
--
--   1. The rake wallet's running totals come from union_rake_ledger_checkpoint
--      (credits, debits, rows_seen as of `as_of`, maintained by the rake
--      reconciliation) plus only the rows since `as_of`. Falls back to the
--      full sum when the checkpoint is absent.
--   2. Totals are computed only for the first page (p_offset = 0). Load More
--      pages return `totals: null` and `total: null`; the client keeps the
--      figures it has.
--   3. plan_cache_mode = force_custom_plan on the function. Under the generic
--      plan plpgsql adopts after a few calls, the parameterised page query
--      stopped using the (union_id, wallet) index: 580 ms for the promo
--      wallet inside the function against 21 ms for the same query typed by
--      hand. Custom plans: 49 ms.
--   4. Two partial indexes on chip_ledger for the club and agent scopes,
--      created CONCURRENTLY outside this transaction the same minute: a club
--      entity carries 64,000 treasury rows, and the OR over two whole-entity
--      indexes was 280 ms to find one promo row. 30 ms after.
--
-- Function body and indexes only. No data changes.
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
               'actor_name', coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                       pa.first_name, pa.last_name, pa.full_name), pa.username)
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
             'actor_name', coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                     pa.first_name, pa.last_name, pa.full_name), pa.username)
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

-- The supporting index was created CONCURRENTLY (which cannot run inside a
-- transaction) on 2026-09-05 03:44 UTC, before this file was applied. This
-- statement is the record of it and a no-op where it already exists; on a
-- fresh database it builds the index inside the transaction, which is fine
-- for an empty table.
CREATE INDEX IF NOT EXISTS idx_uwt_union_wallet_created
  ON public.union_wallet_transactions USING btree (union_id, wallet, created_at DESC)
  INCLUDE (amount, direction);

ALTER FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text)
  SET plan_cache_mode = 'force_custom_plan';

-- Likewise created CONCURRENTLY on production first; no-ops here.
CREATE INDEX IF NOT EXISTS idx_chip_ledger_promo_to
  ON public.chip_ledger USING btree (to_entity_id, created_at DESC)
  WHERE (to_type = 'promo_wallet');
CREATE INDEX IF NOT EXISTS idx_chip_ledger_promo_from
  ON public.chip_ledger USING btree (from_entity_id, created_at DESC)
  WHERE (from_type = 'promo_wallet');

COMMIT;
