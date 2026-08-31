-- Transaction-isolated production probe for cashier Phase 1.
-- Every fixture, wallet movement and receipt is rolled back at the end.
\set ON_ERROR_STOP on

begin;

create temp table cashier_probe_context as
select
  a.club_id,
  a.user_id as actor_id,
  cm.user_id as recipient_id,
  gen_random_uuid() as source_one,
  gen_random_uuid() as source_two,
  gen_random_uuid() as op_id,
  a.agent_wallet_balance as actor_before,
  cm.chip_balance as recipient_before
from public.agents a
join public.club_members actor_member
  on actor_member.club_id = a.club_id and actor_member.user_id = a.user_id
join public.club_members cm
  on cm.club_id = a.club_id and cm.user_id <> a.user_id
where a.agent_wallet_balance >= 1
  and cm.chip_balance >= 2
  and coalesce(actor_member.status, 'active') in ('active', 'approved')
  and coalesce(cm.status, 'active') in ('active', 'approved')
limit 1;

do $fixture$
begin
  if not exists (select 1 from cashier_probe_context) then
    raise exception 'No funded cashier fixture is available';
  end if;
end
$fixture$;

create temp table cashier_probe_results (
  check_name text primary key,
  passed boolean not null,
  detail text not null
);
grant select on cashier_probe_context to authenticated;
grant select, insert on cashier_probe_results to authenticated;

insert into public.chip_transactions
  (id, club_id, from_user_id, to_user_id, amount, transaction_type, notes,
   metadata, balance_after, reversible_until)
select source_one, club_id, actor_id, recipient_id, 1.00, 'agent_wallet_send',
       'Rolled Back Phase 1 Cent Probe',
       jsonb_build_object('destination', 'player_wallet', 'claimed_back', 0),
       actor_before, now() + interval '10 minutes'
from cashier_probe_context;

insert into public.chip_transactions
  (id, club_id, from_user_id, to_user_id, amount, transaction_type, notes,
   metadata, balance_after, reversible_until)
select source_two, club_id, actor_id, recipient_id, 1.00, 'agent_wallet_send',
       'Rolled Back Phase 1 Replay Probe',
       jsonb_build_object('destination', 'player_wallet', 'claimed_back', 0),
       actor_before, now() + interval '10 minutes'
from cashier_probe_context;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', actor_id, 'role', 'authenticated')::text,
  true
)
from cashier_probe_context;
set local role authenticated;

with verdict as (
  select public.fn_agent_wallet_claim_back(
    club_id, source_one, 0.0049, 'Rolled Back Sub-Cent Probe', gen_random_uuid()
  ) as result
  from cashier_probe_context
)
insert into cashier_probe_results
select
  'sub_cent_refused',
  result ->> 'success' = 'false'
    and result ->> 'error' = 'Claim Back Amounts Must Be Positive Whole Cents',
  result::text
from verdict;

with verdict as (
  select public.fn_agent_wallet_claim_back(
    club_id, source_one, null, 'Rolled Back Whole-Cent Probe', op_id
  ) as result
  from cashier_probe_context
)
insert into cashier_probe_results
select
  'whole_cent_claim_succeeds',
  result ->> 'success' = 'true'
    and result ->> 'replayed' = 'false'
    and (result ->> 'amount')::numeric = 1.00,
  result::text
from verdict;

with verdict as (
  select public.fn_agent_wallet_claim_back(
    club_id, source_one, null, 'Rolled Back Replay Probe', op_id
  ) as result
  from cashier_probe_context
)
insert into cashier_probe_results
select
  'same_intent_replays',
  result ->> 'success' = 'true'
    and result ->> 'replayed' = 'true'
    and (result ->> 'amount')::numeric = 1.00,
  result::text
from verdict;

with verdict as (
  select public.fn_agent_wallet_claim_back(
    club_id, source_two, null, 'Rolled Back Mismatch Probe', op_id
  ) as result
  from cashier_probe_context
)
insert into cashier_probe_results
select
  'retry_key_is_source_bound',
  result ->> 'success' = 'false'
    and result ->> 'error' = 'That Retry Key Belongs To A Different Claim Back',
  result::text
from verdict;

reset role;

insert into cashier_probe_results
select
  'whole_cent_move_is_conserved',
  c.actor_before + 1.00 = a.agent_wallet_balance
    and c.recipient_before - 1.00 = m.chip_balance,
  format(
    'agent %s -> %s, recipient %s -> %s',
    c.actor_before, a.agent_wallet_balance, c.recipient_before, m.chip_balance
  )
from cashier_probe_context c
join public.agents a on a.club_id = c.club_id and a.user_id = c.actor_id
join public.club_members m on m.club_id = c.club_id and m.user_id = c.recipient_id;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', recipient_id, 'role', 'authenticated')::text,
  true
)
from cashier_probe_context;
set local role authenticated;

do $browser_guard$
declare
  v_count integer;
begin
  begin
    update public.club_members m
       set chip_balance = m.chip_balance + 1
      from cashier_probe_context c
     where m.club_id = c.club_id and m.user_id = auth.uid();
    get diagnostics v_count = row_count;
    insert into cashier_probe_results values (
      'browser_balance_write_refused',
      false,
      format('unguarded update affected %s row(s)', v_count)
    );
  exception when sqlstate '42501' then
    insert into cashier_probe_results values (
      'browser_balance_write_refused',
      sqlerrm like 'Direct balance mutation of club_members.chip_balance%',
      sqlerrm
    );
  end;
end
$browser_guard$;

reset role;

select
  'TEST_CASHIER_PHASE1_' || upper(check_name) || ' | '
  || case when passed then 'PASS' else 'FAIL - ' || detail end as result
from cashier_probe_results
order by check_name;

do $assert$
declare
  v_failure text;
begin
  select string_agg(check_name || ': ' || detail, '; ' order by check_name)
    into v_failure
    from cashier_probe_results
   where not passed;
  if v_failure is not null then
    raise exception 'Cashier Phase 1 probe failed: %', v_failure;
  end if;
end
$assert$;

rollback;
