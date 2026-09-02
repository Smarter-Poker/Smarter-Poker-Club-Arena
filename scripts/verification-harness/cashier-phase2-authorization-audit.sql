-- Transaction-isolated production probe for cashier Phase 2.
-- Every fixture, wallet movement and ledger receipt is rolled back.
\set ON_ERROR_STOP on

begin;

create temp table cashier_phase2_context as
select
  c.id as club_id,
  c.owner_id as issuer_id,
  h.user_id as holder_id,
  o.user_id as other_holder_id,
  issuer_member.chip_balance as issuer_before,
  h.chip_balance as holder_before,
  gen_random_uuid() as cancel_ticket_id,
  gen_random_uuid() as redeem_ticket_id,
  gen_random_uuid() as unrelated_ticket_id
from public.clubs c
join public.club_members issuer_member
  on issuer_member.club_id=c.id and issuer_member.user_id=c.owner_id
join lateral (
  select cm.user_id,cm.chip_balance
    from public.club_members cm
   where cm.club_id=c.id and cm.user_id<>c.owner_id
     and cm.role in ('member','player')
     and coalesce(cm.status,'active') in ('active','approved')
   order by cm.user_id limit 1
) h on true
join lateral (
  select cm.user_id
    from public.club_members cm
   where cm.club_id=c.id and cm.user_id not in (c.owner_id,h.user_id)
     and cm.role in ('member','player')
     and coalesce(cm.status,'active') in ('active','approved')
   order by cm.user_id limit 1
) o on true
where coalesce(issuer_member.status,'active') in ('active','approved')
limit 1;

do $fixture$
begin
  if not exists (select 1 from cashier_phase2_context) then
    raise exception 'No owner plus two active-player cashier fixture is available';
  end if;
end
$fixture$;

create temp table cashier_phase2_results (
  check_name text primary key,
  passed boolean not null,
  detail text not null
);
grant select on cashier_phase2_context to authenticated;
grant select,insert on cashier_phase2_results to authenticated;

insert into public.tournament_tickets(id,club_id,issued_by,holder_id,value,status,note)
select cancel_ticket_id,club_id,issuer_id,holder_id,0.01,'issued','Rolled Back Phase 2 Cancel Probe'
from cashier_phase2_context
union all
select redeem_ticket_id,club_id,issuer_id,holder_id,0.01,'issued','Rolled Back Phase 2 Redeem Probe'
from cashier_phase2_context
union all
select unrelated_ticket_id,club_id,issuer_id,other_holder_id,0.01,'issued','Rolled Back Phase 2 Privacy Probe'
from cashier_phase2_context;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',issuer_id,'role','authenticated')::text,
  true
) from cashier_phase2_context;
set local role authenticated;

with verdict as (
  select public.fn_agent_wallet_send(
    club_id,holder_id,0.01,'player_wallet','Rolled Back Missing-Key Probe',null
  ) result from cashier_phase2_context
)
insert into cashier_phase2_results
select 'send_requires_retry_key',
       result->>'error'='A Retry Key Is Required For Every Send',result::text
from verdict;

with verdict as (
  select public.fn_agent_wallet_claim_back(
    club_id,gen_random_uuid(),null,'Rolled Back Missing-Key Probe',null
  ) result from cashier_phase2_context
)
insert into cashier_phase2_results
select 'claim_requires_retry_key',
       result->>'error'='A Retry Key Is Required For Every Claim Back',result::text
from verdict;

with verdict as (
  select public.fn_issue_tournament_ticket(
    club_id,holder_id,0.01,'Rolled Back Missing-Key Probe',null
  ) result from cashier_phase2_context
)
insert into cashier_phase2_results
select 'ticket_requires_retry_key',
       result->>'error'='A Retry Key Is Required For Every Ticket',result::text
from verdict;

with verdict as (
  select public.fn_cancel_tournament_ticket(cancel_ticket_id) result
  from cashier_phase2_context
)
insert into cashier_phase2_results
select 'ticket_cancel_succeeds',
       result->>'success'='true' and result->>'replayed'='false',result::text
from verdict;

with verdict as (
  select public.fn_cancel_tournament_ticket(cancel_ticket_id) result
  from cashier_phase2_context
)
insert into cashier_phase2_results
select 'ticket_cancel_replays',
       result->>'success'='true' and result->>'replayed'='true',result::text
from verdict;

reset role;

insert into cashier_phase2_results
select 'ticket_cancel_receipt_is_linked',
       count(*)=1,
       format('found %s linked cancel receipt(s)',count(*))
from public.chip_transactions ct,cashier_phase2_context c
where ct.transaction_type='tournament_ticket_cancel'
  and ct.metadata->>'ticket_id'=c.cancel_ticket_id::text;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',holder_id,'role','authenticated')::text,
  true
) from cashier_phase2_context;
set local role authenticated;

with verdict as (
  select public.fn_redeem_tournament_ticket(redeem_ticket_id) result
  from cashier_phase2_context
)
insert into cashier_phase2_results
select 'ticket_redeem_succeeds',
       result->>'success'='true' and result->>'replayed'='false',result::text
from verdict;

with verdict as (
  select public.fn_redeem_tournament_ticket(redeem_ticket_id) result
  from cashier_phase2_context
)
insert into cashier_phase2_results
select 'ticket_redeem_replays',
       result->>'success'='true' and result->>'replayed'='true',result::text
from verdict;

insert into cashier_phase2_results
select 'player_cannot_read_unrelated_ticket',
       count(*)=0,
       format('visible unrelated tickets: %s',count(*))
from public.tournament_tickets t,cashier_phase2_context c
where t.id=c.unrelated_ticket_id;

insert into cashier_phase2_results
select 'player_cannot_read_other_roster_rows',
       count(*)=0,
       format('visible other roster rows: %s',count(*))
from public.club_members cm,cashier_phase2_context c
where cm.club_id=c.club_id and cm.user_id<>c.holder_id;

insert into cashier_phase2_results
select 'player_cannot_read_unrelated_agents',
       count(*)=0,
       format('visible unrelated agent rows: %s',count(*))
from public.agents a,cashier_phase2_context c
where a.club_id=c.club_id and a.user_id<>c.holder_id;

reset role;

insert into cashier_phase2_results
select 'ticket_redeem_receipt_is_linked',
       count(*)=1,
       format('found %s linked redeem receipt(s)',count(*))
from public.chip_transactions ct,cashier_phase2_context c
where ct.transaction_type='tournament_ticket_redeem'
  and ct.metadata->>'ticket_id'=c.redeem_ticket_id::text;

insert into cashier_phase2_results
select 'closing_moves_credit_exactly_one_cent',
       issuer_member.chip_balance=c.issuer_before+0.01
         and holder_member.chip_balance=c.holder_before+0.01,
       format(
         'issuer %s -> %s, holder %s -> %s',
         c.issuer_before,issuer_member.chip_balance,c.holder_before,holder_member.chip_balance
       )
from cashier_phase2_context c
join public.club_members issuer_member
  on issuer_member.club_id=c.club_id and issuer_member.user_id=c.issuer_id
join public.club_members holder_member
  on holder_member.club_id=c.club_id and holder_member.user_id=c.holder_id;

select
  'TEST_CASHIER_PHASE2_'||upper(check_name)||' | '
  ||case when passed then 'PASS' else 'FAIL - '||detail end result
from cashier_phase2_results order by check_name;

do $assert$
declare v_failure text;
begin
  select string_agg(check_name||': '||detail,'; ' order by check_name)
    into v_failure from cashier_phase2_results where not passed;
  if v_failure is not null then
    raise exception 'Cashier Phase 2 probe failed: %',v_failure;
  end if;
end
$assert$;

rollback;
