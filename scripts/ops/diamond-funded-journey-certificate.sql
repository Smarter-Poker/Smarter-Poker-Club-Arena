-- DA06 funded player journey certificate (READ-ONLY).
-- Run after a real player completes, through the normal published product:
--   1. buy in to a Diamond Arena cash table,
--   2. play at least one hand to settlement,
--   3. leave the table,
--   4. send a Diamond wallet transfer.
-- Set the two parameters below, then run the whole file as one statement
-- (psql, or execute_sql over the Supabase MCP; it holds no DDL and no write).
-- It writes nothing. Every check returns pass=true or names what is missing.

with p as (
  select
    '00000000-0000-0000-0000-000000000000'::uuid as player,   -- the player's profile id
    timestamptz '2026-10-17 00:00:00+00'          as since     -- shortly before the buy-in
),
custody as (
  select c.* from poker_diamond_custody c, p
  where c.user_id = p.player and c.created_at >= p.since and c.purpose ilike '%cash%'
),
mv as (
  select m.* from poker_diamond_movements m join custody c on c.id = m.custody_id
),
buyin as (
  select * from mv where action = 'reserve' and source_account = 'player:' || (select player from p)
),
leave as (
  select * from mv where action = 'release' and destination_account = 'player:' || (select player from p)
),
hands as (
  select r.table_id, r.hand_number, r.created_at
  from poker_diamond_hand_receipts r, p
  where r.created_at >= p.since
    and r.receipt::text like '%' || (select player::text from p) || '%'
),
xfer as (
  select t.* from diamond_wallet_transfers t, p
  where t.sender_id = p.player and t.created_at >= p.since
),
journals as (
  select j.id, j.user_id, j.amount from diamond_transactions j
  where j.id in (select wallet_journal_id from buyin union all select wallet_journal_id from leave
                 union all select sender_journal_id from xfer union all select recipient_journal_id from xfer)
)
select 'buy-in reserved from the player wallet, with its wallet journal' as check_name,
       (select count(*) from buyin) > 0
       and not exists (select 1 from buyin where wallet_journal_id is null) as pass,
       (select json_agg(json_build_object('at', created_at, 'amount', amount, 'journal', wallet_journal_id)) from buyin) as detail
union all
select 'at least one hand settled with the player in its receipt',
       (select count(*) from hands) > 0,
       (select json_agg(json_build_object('table', table_id, 'hand', hand_number, 'at', created_at)) from (select * from hands order by created_at limit 10) h)
union all
select 'leave released custody to the player; a positive release carries its wallet journal',
       (select count(*) from leave) > 0
       and not exists (select 1 from leave where amount > 0 and wallet_journal_id is null),
       (select json_agg(json_build_object('at', created_at, 'amount', amount, 'journal', wallet_journal_id)) from leave)
union all
select 'no residual custody: every cash custody row of this journey is released at zero',
       (select count(*) from custody) > 0
       and not exists (select 1 from custody where released_at is null or balance <> 0),
       (select json_agg(json_build_object('custody', id, 'state', state, 'balance', balance, 'released_at', released_at)) from custody)
union all
select 'wallet journals exist for every wallet leg (buy-in, leave, transfer both sides)',
       not exists (
         select x.jid from (
           select wallet_journal_id jid from buyin
           union all select wallet_journal_id from leave where amount > 0
           union all select sender_journal_id from xfer
           union all select recipient_journal_id from xfer) x
         where x.jid is null or x.jid not in (select id from journals)),
       (select json_agg(json_build_object('journal', id, 'user', user_id, 'amount', amount)) from journals)
union all
select 'transfer: both ledger legs present and equal and opposite',
       (select count(*) from xfer) > 0
       and not exists (
         select 1 from xfer t
         left join diamond_transactions s on s.id = t.sender_journal_id
         left join diamond_transactions r on r.id = t.recipient_journal_id
         where s.id is null or r.id is null or s.amount <> -t.amount or r.amount <> t.amount),
       (select json_agg(json_build_object('transfer', id, 'amount', amount, 'to', recipient_id, 'at', created_at)) from xfer)
union all
select 'no unaccounted seat exit anywhere on the platform',
       (select count(*) from fn_unaccounted_seat_exits()) = 0,
       json_build_object('unaccounted', (select count(*) from fn_unaccounted_seat_exits()));
