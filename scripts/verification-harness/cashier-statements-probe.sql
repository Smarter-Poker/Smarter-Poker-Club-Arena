-- Transaction-isolated production probe for the Cashier statement (Phase 5,
-- migration 20260923131325_cashier_statements_read_every_wallet_in_one_keyset,
-- recorded in schema_migrations as 20260923150831).
--
-- Everything below is rolled back. It builds a SYNTHETIC club inside the
-- transaction (existing people as identities only, never their chips),
-- writes 0.01 operation receipts into public.chip_transactions for that club
-- alone, and never writes public.chip_ledger (hash-chained; a probe must not
-- take its chain lock). The statement doors are then called as the
-- `authenticated` role with request.jwt claims, exactly as PostgREST does.
-- CLAUDE.md 11.5: run with psql (BEGIN ... ROLLBACK in one session), never
-- as separate Supabase MCP calls. Temp objects only; helpers live in pg_temp.
--
--   psql "$DATABASE_URL" -f scripts/verification-harness/cashier-statements-probe.sql
--
-- A FAIL raises at the end, which also aborts the transaction.
\set ON_ERROR_STOP on

begin;

-- Five distinct existing people: owner, agent, player (under the agent),
-- outsider (a member outside the agent tree) and a stranger (no membership).
-- Automated profiles are skipped: production refuses them a seat in a
-- user-created club (fn_ca_reject_automated_user_club_row).
create temp table cashier_statements_probe_context as
with people as (
  select p.id, row_number() over (order by p.id) as n
    from (select profile.id
            from public.profiles profile
           where not coalesce(profile.is_horse, false)
           order by profile.id
           limit 5) p
)
select gen_random_uuid() as club_id,
       (select id from people where n = 1) as owner_id,
       (select id from people where n = 2) as agent_id,
       (select id from people where n = 3) as player_id,
       (select id from people where n = 4) as outsider_id,
       (select id from people where n = 5) as stranger_id,
       date_trunc('second', now()) - interval '1 hour' as t0;

do $fixture$
begin
  if (select count(distinct x) from cashier_statements_probe_context c,
        unnest(array[c.owner_id, c.agent_id, c.player_id, c.outsider_id, c.stranger_id]) x) <> 5 then
    raise exception 'The probe needs five existing profiles';
  end if;
end
$fixture$;

-- The synthetic club (the leaderboard-reward-program-versioning probe shape).
select set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', owner_id::text, true),
       set_config('request.jwt.claim.role', 'authenticated', true)
  from cashier_statements_probe_context;
insert into public.clubs (id, name, owner_id, club_id, is_union, union_id, promo_balance)
select c.club_id, 'Cashier Statements Probe ' || c.club_id::text, c.owner_id,
       coalesce((select max(k.club_id) from public.clubs k), 10000) + 1, false, null, 0
  from cashier_statements_probe_context c;

-- Memberships. A club trigger may already have seated the owner, so insert
-- what is missing and then set every role explicitly. Production guards
-- club_members with fn_require_explicit_club_membership_source, which admits
-- a row only when app.club_membership_source names a real door; this
-- transaction-scoped setting is rolled back with everything else.
select set_config('app.club_membership_source', 'join_club', true);
insert into public.club_members (club_id, user_id, role, status)
select c.club_id, c.owner_id, 'owner', 'active' from cashier_statements_probe_context c
 where not exists (select 1 from public.club_members m where m.club_id = c.club_id and m.user_id = c.owner_id);
insert into public.club_members (club_id, user_id, role, status)
select c.club_id, c.agent_id, 'agent', 'active' from cashier_statements_probe_context c
 where not exists (select 1 from public.club_members m where m.club_id = c.club_id and m.user_id = c.agent_id);
insert into public.club_members (club_id, user_id, role, agent_id, status)
select c.club_id, c.player_id, 'player', c.agent_id, 'active' from cashier_statements_probe_context c
 where not exists (select 1 from public.club_members m where m.club_id = c.club_id and m.user_id = c.player_id);
insert into public.club_members (club_id, user_id, role, status)
select c.club_id, c.outsider_id, 'player', 'active' from cashier_statements_probe_context c
 where not exists (select 1 from public.club_members m where m.club_id = c.club_id and m.user_id = c.outsider_id);
update public.club_members m set role = 'owner', agent_id = null, status = 'active'
  from cashier_statements_probe_context c where m.club_id = c.club_id and m.user_id = c.owner_id;
update public.club_members m set role = 'agent', agent_id = null, status = 'active'
  from cashier_statements_probe_context c where m.club_id = c.club_id and m.user_id = c.agent_id;
update public.club_members m set role = 'player', agent_id = c.agent_id, status = 'active'
  from cashier_statements_probe_context c where m.club_id = c.club_id and m.user_id = c.player_id;
update public.club_members m set role = 'player', agent_id = null, status = 'active'
  from cashier_statements_probe_context c where m.club_id = c.club_id and m.user_id = c.outsider_id;

-- Twelve agent -> player receipts over three instants (ties across page
-- boundaries at five per page) and one owner -> outsider receipt. Each
-- carries a WRITER balance_after (as production receipts do), which the
-- statement must never print.
insert into public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at, balance_after)
select c.club_id, c.agent_id, c.player_id, 0.01, 'agent_wallet_send', 'Rolled Back Statement Probe',
       jsonb_build_object('op_id', gen_random_uuid(), 'idempotency_key', 'cashier-statement-probe-' || gen_random_uuid()::text),
       c.t0 + (n % 3) * interval '1 minute', 123.45
  from cashier_statements_probe_context c cross join generate_series(1, 12) n;
insert into public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at, balance_after)
select c.club_id, c.owner_id, c.outsider_id, 0.01, 'club_bank_send', 'Rolled Back Statement Probe',
       jsonb_build_object('op_id', gen_random_uuid(), 'idempotency_key', 'cashier-statement-probe-' || gen_random_uuid()::text),
       c.t0 + interval '30 seconds', 123.45
  from cashier_statements_probe_context c;

create function pg_temp.probe_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
         set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- Walks every page of the probe club's statement for the current viewer.
create function pg_temp.probe_walk(p_limit integer)
returns table(page integer, ord integer, entry jsonb, totals jsonb, authorized boolean)
language plpgsql as $$
declare
  c record;
  v_cursor jsonb;
  v_page jsonb;
  v_page_no integer := 0;
  v_ord integer := 0;
  v_entry jsonb;
begin
  select * into c from cashier_statements_probe_context;
  loop
    v_page_no := v_page_no + 1;
    if v_page_no > 100 then raise exception 'statement walk did not terminate'; end if;
    v_page := public.fn_cashier_statement_page(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb, v_cursor, p_limit);
    if not coalesce((v_page ->> 'authorized')::boolean, false) then
      page := v_page_no; ord := 0; entry := v_page; totals := null; authorized := false;
      return next;
      return;
    end if;
    for v_entry in select value from jsonb_array_elements(v_page -> 'rows') loop
      v_ord := v_ord + 1;
      page := v_page_no; ord := v_ord; entry := v_entry; totals := v_page -> 'totals'; authorized := true;
      return next;
    end loop;
    v_cursor := v_page -> 'next_cursor';
    exit when v_cursor is null or jsonb_typeof(v_cursor) = 'null';
  end loop;
end
$$;

-- The SQLSTATE a statement raises ('ok' when it does not).
create function pg_temp.probe_sqlstate(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;

grant execute on function pg_temp.probe_as(uuid), pg_temp.probe_walk(integer), pg_temp.probe_sqlstate(text) to authenticated;

create temp table cashier_statements_probe_walk(viewer text, page integer, ord integer, entry jsonb, totals jsonb, authorized boolean);
create temp table cashier_statements_probe_facts(fact text primary key, value jsonb);
create temp table cashier_statements_probe_results(check_name text primary key, passed boolean not null, detail text not null);
grant select on cashier_statements_probe_context to authenticated;
grant select, insert on cashier_statements_probe_walk, cashier_statements_probe_facts to authenticated;

set local role authenticated;

select pg_temp.probe_as(owner_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_facts
select 'owner_scope', public.fn_cashier_statement_scope(club_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_walk select 'owner', w.* from pg_temp.probe_walk(5) w;
insert into cashier_statements_probe_facts
select 'owner_totals', public.fn_cashier_statement_totals(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb)
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'owner_foreign_cursor', to_jsonb(pg_temp.probe_sqlstate(format(
  'select public.fn_cashier_statement_page(%L, %L, %L, %L::jsonb, %L::jsonb, 5)',
  c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{"direction":"managed"}',
  (public.fn_cashier_statement_page(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb, null, 5) -> 'next_cursor')::text)))
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'owner_93_days', to_jsonb(pg_temp.probe_sqlstate(format(
  'select public.fn_cashier_statement_page(%L, %L, %L)', c.club_id, c.t0 - interval '93 days', c.t0)))
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'owner_export', public.fn_cashier_statement_export_start(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb, gen_random_uuid())
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'owner_export_cancel', to_jsonb(public.fn_cashier_statement_export_cancel((f.value ->> 'export_id')::uuid))
  from cashier_statements_probe_facts f where f.fact = 'owner_export';

select pg_temp.probe_as(agent_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_facts
select 'agent_scope', public.fn_cashier_statement_scope(club_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_walk select 'agent', w.* from pg_temp.probe_walk(5) w;
insert into cashier_statements_probe_facts
select 'agent_totals', public.fn_cashier_statement_totals(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb)
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'agent_export', public.fn_cashier_statement_export_start(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb, gen_random_uuid())
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'agent_export_page', public.fn_cashier_statement_export_page((f.value ->> 'export_id')::uuid, 0, 1000)
  from cashier_statements_probe_facts f where f.fact = 'agent_export';

select pg_temp.probe_as(player_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_walk select 'player', w.* from pg_temp.probe_walk(5) w;
insert into cashier_statements_probe_facts
select 'player_reads_agent_export', to_jsonb(pg_temp.probe_sqlstate(format(
  'select public.fn_cashier_statement_export_page(%L)', f.value ->> 'export_id')))
  from cashier_statements_probe_facts f where f.fact = 'agent_export';

select pg_temp.probe_as(outsider_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_walk select 'outsider', w.* from pg_temp.probe_walk(5) w;

select pg_temp.probe_as(stranger_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_walk select 'stranger', w.* from pg_temp.probe_walk(5) w;
insert into cashier_statements_probe_facts
select 'stranger_totals', public.fn_cashier_statement_totals(c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour', '{}'::jsonb)
  from cashier_statements_probe_context c;
insert into cashier_statements_probe_facts
select 'stranger_export', to_jsonb(pg_temp.probe_sqlstate(format(
  'select public.fn_cashier_statement_export_start(%L, %L, %L)', c.club_id, c.t0 - interval '1 hour', c.t0 + interval '1 hour')))
  from cashier_statements_probe_context c;

reset role;

-- The agent is downgraded between export pages: the whole file must refuse.
update public.club_members m set role = 'player'
  from cashier_statements_probe_context c where m.club_id = c.club_id and m.user_id = c.agent_id;
set local role authenticated;
select pg_temp.probe_as(agent_id) from cashier_statements_probe_context;
insert into cashier_statements_probe_facts
select 'agent_export_after_downgrade', to_jsonb(pg_temp.probe_sqlstate(format(
  'select public.fn_cashier_statement_export_page(%L)', f.value ->> 'export_id')))
  from cashier_statements_probe_facts f where f.fact = 'agent_export';
reset role;

insert into cashier_statements_probe_results
select 'owner_scope_is_all', value ->> 'scope' = 'all' and value ->> 'role' = 'owner', value::text
  from cashier_statements_probe_facts where fact = 'owner_scope';
insert into cashier_statements_probe_results
select 'agent_scope_is_downline', value ->> 'scope' = 'downline', value::text
  from cashier_statements_probe_facts where fact = 'agent_scope';
insert into cashier_statements_probe_results
select 'owner_pages_cover_the_club_exactly',
       count(*) = 13 and count(distinct entry ->> 'id') = 13 and max(page) >= 3,
       format('rows=%s distinct=%s pages=%s', count(*), count(distinct entry ->> 'id'), max(page))
  from cashier_statements_probe_walk where viewer = 'owner';
insert into cashier_statements_probe_results
select 'owner_pages_are_strictly_ordered',
       coalesce(bool_and(ok), false), 'violations=' || count(*) filter (where not ok)
  from (select coalesce(lag(entry ->> 'at') over w > entry ->> 'at'
                  or (lag(entry ->> 'at') over w = entry ->> 'at' and lag(entry ->> 'id') over w > entry ->> 'id'), true) as ok
          from cashier_statements_probe_walk where viewer = 'owner' window w as (order by ord)) s;
insert into cashier_statements_probe_results
select 'owner_page_boundary_inside_a_tie', count(*) > 0, 'tied_boundaries=' || count(*)
  from cashier_statements_probe_walk a
  join cashier_statements_probe_walk b on b.viewer = a.viewer and b.ord = a.ord + 1 and b.page = a.page + 1
 where a.viewer = 'owner' and a.entry ->> 'at' = b.entry ->> 'at';
insert into cashier_statements_probe_results
select 'owner_totals_door_is_2dp_strings',
       value -> 'totals' = '{"in": "0.00", "out": "0.01", "count": 13, "managed": "0.12"}'::jsonb and value ->> 'scope' = 'all',
       value::text
  from cashier_statements_probe_facts where fact = 'owner_totals';
insert into cashier_statements_probe_results
select 'agent_totals_door_equals_the_pages',
       (f.value -> 'totals' ->> 'count')::int = (select count(*) from cashier_statements_probe_walk where viewer = 'agent')
       and f.value -> 'totals' ->> 'out' = (select to_char(sum((entry ->> 'amount')::numeric), 'FM999999999999999990.00') from cashier_statements_probe_walk where viewer = 'agent' and entry ->> 'direction' = 'out'),
       f.value::text
  from cashier_statements_probe_facts f where f.fact = 'agent_totals';
insert into cashier_statements_probe_results
select 'stranger_totals_are_refused', value = '{"reason": "not_an_active_member", "authorized": false}'::jsonb, value::text
  from cashier_statements_probe_facts where fact = 'stranger_totals';
insert into cashier_statements_probe_results
select 'page_never_carries_totals',
       coalesce(bool_and(jsonb_typeof(totals) = 'null'), false) and max(page) > 1,
       'pages=' || max(page)
  from cashier_statements_probe_walk where viewer = 'owner';
insert into cashier_statements_probe_results
select 'receipts_print_no_balance_after',
       count(*) = 13 + 12 + 12 + 1 and coalesce(bool_and(entry -> 'balance_after' = 'null'::jsonb), false),
       'receipt rows=' || count(*)
  from cashier_statements_probe_walk where authorized and entry ->> 'source' = 'receipt';
insert into cashier_statements_probe_results
select 'agent_sees_only_the_downline',
       count(*) = 12 and bool_and(entry -> 'from' ->> 'id' = c.agent_id::text and entry ->> 'direction' = 'out'),
       'rows=' || count(*)
  from cashier_statements_probe_walk w, cashier_statements_probe_context c where w.viewer = 'agent'
 group by c.agent_id;
insert into cashier_statements_probe_results
select 'player_sees_self_only', count(*) = 12 and bool_and(entry ->> 'direction' = 'in'), 'rows=' || count(*)
  from cashier_statements_probe_walk where viewer = 'player';
insert into cashier_statements_probe_results
select 'outsider_sees_self_only', count(*) = 1 and bool_and(entry ->> 'kind' = 'club_bank_send' and entry ->> 'direction' = 'in'), 'rows=' || count(*)
  from cashier_statements_probe_walk where viewer = 'outsider';
insert into cashier_statements_probe_results
select 'stranger_is_refused_without_rows', count(*) = 1 and bool_and(not authorized and entry ->> 'authorized' = 'false'), string_agg(entry::text, ' ')
  from cashier_statements_probe_walk where viewer = 'stranger';
insert into cashier_statements_probe_results
select 'foreign_cursor_is_refused_55000', value #>> '{}' = '55000', value::text
  from cashier_statements_probe_facts where fact = 'owner_foreign_cursor';
insert into cashier_statements_probe_results
select 'range_over_92_days_is_refused_22023', value #>> '{}' = '22023', value::text
  from cashier_statements_probe_facts where fact = 'owner_93_days';
insert into cashier_statements_probe_results
select 'owner_export_prepares_and_cancels',
       (e.value ->> 'total_rows')::int = 13 and x.value = 'true'::jsonb, e.value::text || ' cancel=' || x.value::text
  from cashier_statements_probe_facts e, cashier_statements_probe_facts x
 where e.fact = 'owner_export' and x.fact = 'owner_export_cancel';
insert into cashier_statements_probe_results
select 'agent_export_equals_the_screen',
       (p.value ->> 'total_rows')::int = 12 and not (p.value ->> 'has_more')::boolean
       and p.value -> 'rows' = (select jsonb_agg(entry order by ord) from cashier_statements_probe_walk where viewer = 'agent')
       and p.value ->> 'metadata_fingerprint' = md5((p.value -> 'metadata')::text),
       'total_rows=' || (p.value ->> 'total_rows')
  from cashier_statements_probe_facts p where p.fact = 'agent_export_page';
insert into cashier_statements_probe_results
select 'another_user_cannot_read_the_export_55000', value #>> '{}' = '55000', value::text
  from cashier_statements_probe_facts where fact = 'player_reads_agent_export';
insert into cashier_statements_probe_results
select 'stranger_cannot_export_42501', value #>> '{}' = '42501', value::text
  from cashier_statements_probe_facts where fact = 'stranger_export';
insert into cashier_statements_probe_results
select 'downgrade_voids_the_export_42501', value #>> '{}' = '42501', value::text
  from cashier_statements_probe_facts where fact = 'agent_export_after_downgrade';
insert into cashier_statements_probe_results
select 'no_horse_marker_in_any_output',
       (select coalesce(string_agg(entry::text, ' '), '') from cashier_statements_probe_walk) !~* 'horse'
       and (select string_agg(value::text, ' ') from cashier_statements_probe_facts) !~* 'horse',
       'checked walk and facts';
insert into cashier_statements_probe_results
select 'doors_are_definer_pinned_and_browser_only',
       count(*) = 6
       and bool_and(p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']
                    and not has_function_privilege('anon', p.oid, 'EXECUTE')
                    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    and has_function_privilege('service_role', p.oid, 'EXECUTE')),
       'doors=' || count(*)
  from pg_proc p
 where p.oid in ('public.fn_cashier_statement_scope(uuid)'::regprocedure,
                 'public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)'::regprocedure,
                 'public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure,
                 'public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)'::regprocedure,
                 'public.fn_cashier_statement_export_page(uuid,integer,integer)'::regprocedure,
                 'public.fn_cashier_statement_export_cancel(uuid)'::regprocedure);
insert into cashier_statements_probe_results
select 'private_helpers_are_owner_only',
       count(*) = 4 and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')
                                 and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                 and not has_function_privilege('service_role', p.oid, 'EXECUTE')),
       'helpers=' || count(*)
  from pg_proc p
 where p.oid in ('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure,
                 'public.fn_cashier_statement_downline(uuid,uuid)'::regprocedure,
                 'public.fn_cashier_statement_filters(timestamptz,timestamptz,jsonb)'::regprocedure,
                 'public.fn_cashier_statement_prune_expired()'::regprocedure);
insert into cashier_statements_probe_results
select 'job_tables_are_rls_locked',
       count(*) = 2 and bool_and(c.relrowsecurity)
       and not exists (select 1 from pg_policy p where p.polrelid in ('public.ca_cashier_statement_exports'::regclass, 'public.ca_cashier_statement_export_rows'::regclass))
       and bool_and(not has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('anon', c.oid, 'SELECT')),
       'tables=' || count(*)
  from pg_class c
 where c.oid in ('public.ca_cashier_statement_exports'::regclass, 'public.ca_cashier_statement_export_rows'::regclass);

select check_name, case when passed then 'PASS' else 'FAIL - ' || detail end as result
  from cashier_statements_probe_results order by check_name;

do $assert$
declare
  v_failures text;
  v_count integer;
begin
  select count(*), string_agg(check_name || ': ' || detail, E'\n') filter (where not passed)
    into v_count, v_failures
    from cashier_statements_probe_results;
  if v_count <> 25 then
    raise exception 'Cashier statement probe expected 25 checks, ran %', v_count;
  end if;
  if v_failures is not null then
    raise exception E'Cashier statement probe failed:\n%', v_failures;
  end if;
end
$assert$;

rollback;
