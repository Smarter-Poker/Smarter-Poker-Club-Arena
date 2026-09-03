-- Transaction-isolated production probe for cashier Phase 3.
-- Every ticket, send, balance movement and ledger receipt is rolled back.
\set ON_ERROR_STOP on

begin;

create temp table cashier_phase3_context as
select
  c.id club_id,
  c.owner_id actor_id,
  a.agent_wallet_balance agent_before,
  actor_member.chip_balance actor_chips_before,
  p1.user_id target_1,
  p1.chip_balance target_1_before,
  p2.user_id target_2,
  p2.chip_balance target_2_before,
  gen_random_uuid() send_op_1,
  gen_random_uuid() send_op_2,
  gen_random_uuid() batch_send_id,
  gen_random_uuid() batch_ticket_id,
  'phase3-ticket-'||gen_random_uuid()::text ticket_key_1,
  'phase3-ticket-'||gen_random_uuid()::text ticket_key_2
from public.clubs c
join public.club_members actor_member
  on actor_member.club_id=c.id and actor_member.user_id=c.owner_id
join public.agents a on a.club_id=c.id and a.user_id=c.owner_id
join lateral (
  select cm.user_id,cm.chip_balance from public.club_members cm
   where cm.club_id=c.id and cm.user_id<>c.owner_id
     and cm.role in ('member','player')
     and coalesce(cm.status,'active') in ('active','approved')
   order by cm.user_id limit 1
) p1 on true
join lateral (
  select cm.user_id,cm.chip_balance from public.club_members cm
   where cm.club_id=c.id and cm.user_id not in (c.owner_id,p1.user_id)
     and cm.role in ('member','player')
     and coalesce(cm.status,'active') in ('active','approved')
   order by cm.user_id limit 1
) p2 on true
where a.agent_wallet_balance>=0.02 and actor_member.chip_balance>=0.02
  and coalesce(actor_member.status,'active') in ('active','approved')
limit 1;

do $fixture$
begin
  if not exists (select 1 from cashier_phase3_context) then
    raise exception 'No funded owner plus two active-player Phase 3 fixture is available';
  end if;
end
$fixture$;

create temp table cashier_phase3_results(
  check_name text primary key,
  passed boolean not null,
  detail text not null
);
create temp table cashier_phase3_receipts(kind text primary key,result jsonb not null);
create temp table cashier_phase3_page1 as
select * from public.fn_club_cashier_members_page_v3(null,null,null,1) with no data;
create temp table cashier_phase3_page2 (like cashier_phase3_page1);
grant select on cashier_phase3_context to authenticated;
grant select,insert on cashier_phase3_receipts,cashier_phase3_page1,cashier_phase3_page2
  to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',actor_id,'role','authenticated')::text,
  true
) from cashier_phase3_context;
set local role authenticated;

insert into cashier_phase3_page1
select page.*
from cashier_phase3_context c
cross join lateral public.fn_club_cashier_members_page_v3(c.club_id,null,null,2) page;

-- The cursor is the final row in role_rank DESC, user_id ASC order.
insert into cashier_phase3_page2
select page.*
from cashier_phase3_context c
cross join lateral public.fn_club_cashier_members_page_v3(
  c.club_id,
  (select role_rank from cashier_phase3_page1 order by role_rank asc,user_id desc limit 1),
  (select user_id from cashier_phase3_page1 order by role_rank asc,user_id desc limit 1),
  2
) page;

insert into cashier_phase3_receipts(kind,result)
select 'send',public.fn_cashier_batch_transfer(
  c.club_id,'send',
  jsonb_build_array(
    jsonb_build_object('user_id',c.target_1,'amount',0.01,'destination','player_wallet',
      'reason','Rolled Back Phase 3 Send','op_id',c.send_op_1),
    jsonb_build_object('user_id',c.target_2,'amount',0.01,'destination','player_wallet',
      'reason','Rolled Back Phase 3 Send','op_id',c.send_op_2)
  ),c.batch_send_id
) from cashier_phase3_context c;

insert into cashier_phase3_receipts(kind,result)
select 'send_replay',public.fn_cashier_batch_transfer(
  c.club_id,'send',
  jsonb_build_array(
    jsonb_build_object('user_id',c.target_1,'amount',0.01,'destination','player_wallet',
      'reason','Rolled Back Phase 3 Send','op_id',c.send_op_1),
    jsonb_build_object('user_id',c.target_2,'amount',0.01,'destination','player_wallet',
      'reason','Rolled Back Phase 3 Send','op_id',c.send_op_2)
  ),c.batch_send_id
) from cashier_phase3_context c;

insert into cashier_phase3_receipts(kind,result)
select 'ticket',public.fn_cashier_batch_transfer(
  c.club_id,'ticket',
  jsonb_build_array(
    jsonb_build_object('user_id',c.target_1,'amount',0.01,'note','Rolled Back Phase 3 Ticket',
      'idempotency_key',c.ticket_key_1),
    jsonb_build_object('user_id',c.target_2,'amount',0.01,'note','Rolled Back Phase 3 Ticket',
      'idempotency_key',c.ticket_key_2)
  ),c.batch_ticket_id
) from cashier_phase3_context c;

insert into cashier_phase3_receipts(kind,result)
select 'ticket_replay',public.fn_cashier_batch_transfer(
  c.club_id,'ticket',
  jsonb_build_array(
    jsonb_build_object('user_id',c.target_1,'amount',0.01,'note','Rolled Back Phase 3 Ticket',
      'idempotency_key',c.ticket_key_1),
    jsonb_build_object('user_id',c.target_2,'amount',0.01,'note','Rolled Back Phase 3 Ticket',
      'idempotency_key',c.ticket_key_2)
  ),c.batch_ticket_id
) from cashier_phase3_context c;

reset role;

insert into cashier_phase3_results
select 'roster_first_page_bounded',count(*)=2,'rows='||count(*) from cashier_phase3_page1;
insert into cashier_phase3_results
select 'roster_second_page_present',count(*)>0,'rows='||count(*) from cashier_phase3_page2;
insert into cashier_phase3_results
select 'roster_pages_do_not_overlap',count(*)=0,'overlap='||count(*)
from cashier_phase3_page1 p1 join cashier_phase3_page2 p2 using(user_id);

insert into cashier_phase3_results
select kind||'_all_items_succeeded',
  result->>'success'='true'
  and jsonb_array_length(result->'results')=2
  and not exists (
    select 1 from jsonb_array_elements(result->'results') item
    where item->>'success'<>'true'
  ),result::text
from cashier_phase3_receipts;

insert into cashier_phase3_results
select 'send_replay_moved_exactly_once',
  a.agent_wallet_balance=c.agent_before-0.02
  and p1.chip_balance=c.target_1_before+0.01
  and p2.chip_balance=c.target_2_before+0.01,
  format('agent=%s target1=%s target2=%s',a.agent_wallet_balance,p1.chip_balance,p2.chip_balance)
from cashier_phase3_context c
join public.agents a on a.club_id=c.club_id and a.user_id=c.actor_id
join public.club_members p1 on p1.club_id=c.club_id and p1.user_id=c.target_1
join public.club_members p2 on p2.club_id=c.club_id and p2.user_id=c.target_2;

insert into cashier_phase3_results
select 'ticket_replay_moved_exactly_once',
  actor.chip_balance=c.actor_chips_before-0.02 and count(t.id)=2,
  format('issuer=%s tickets=%s',actor.chip_balance,count(t.id))
from cashier_phase3_context c
join public.club_members actor on actor.club_id=c.club_id and actor.user_id=c.actor_id
left join public.tournament_tickets t on t.club_id=c.club_id
 and t.issued_by=c.actor_id and t.note='Rolled Back Phase 3 Ticket'
group by actor.chip_balance,c.actor_chips_before;

insert into cashier_phase3_results
select 'oversized_batch_refused_before_money',
  verdict->>'success'='false' and verdict->>'error' like 'A Batch Must Contain%',verdict::text
from (
  select public.fn_cashier_batch_transfer(
    club_id,'send',
    (select jsonb_agg(jsonb_build_object('user_id',gen_random_uuid(),'amount',0.01,
      'op_id',gen_random_uuid())) from generate_series(1,26)),gen_random_uuid()
  ) verdict from cashier_phase3_context
) q;

insert into cashier_phase3_results
select 'all_three_indexes_valid',count(*)=3,'valid_indexes='||count(*)
from pg_index i join pg_class c on c.oid=i.indexrelid
where c.relname in (
  'club_members_cashier_tree_idx',
  'chip_transactions_club_from_created_idx',
  'chip_transactions_club_to_created_idx'
) and i.indisvalid and i.indisready;

select check_name,case when passed then 'PASS' else 'FAIL — '||detail end result
from cashier_phase3_results order by check_name;

do $assert$
declare v_failures text;
begin
  select string_agg(check_name||': '||detail,E'\n') into v_failures
  from cashier_phase3_results where not passed;
  if v_failures is not null then
    raise exception E'Cashier Phase 3 verification failed:\n%',v_failures;
  end if;
end
$assert$;

rollback;
