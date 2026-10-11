-- The statement counts each move once and names its wallet (2026-10-09).
-- Regression for migration 20261011194856 (first written as 20261009223439,
-- rebased onto #6615's live body on 2026-10-11). Runs on the cashier statement
-- fixture (bootstrap.sql, baseline.sql, 20260923131325) after the effective
-- production row body is installed; scripts/ci/test-cashier-statement-db-postgres.py
-- runs it once on production's live body (where it must FAIL) and once after
-- the migration (where every assertion must PASS).
--
-- Every row below copies a live writer's shape, read from production on
-- 2026-10-09 (pg_get_functiondef, read-only):
--   fn_promo_wallet_send_core_20261004  receipt promo_wallet_send {op_id}
--     + leg promo_send promo_wallet(agent) -> player_wallet, correlation = op_id
--   fn_cashier_cashout_transition       hold player->assigned agent, approval
--     player->approver, cancellation actor->player (escrow legs are excluded)
--   fn_club_bank_send_core_20261004     receipt operator->member, club_bank_send
--   fn_admin_remove_chips_core_20261004 receipt member->operator, admin_removal
--   fn_horse_fund_from_treasury_...     receipt NULL->horse, horse_treasury_funding
--   fn_sweep_bbj_promo(_all)            receipt bbj_promo_sweep NULL/NULL
--     + leg promo bbj_pool -> promo_wallet(club), label bbj_pools.promo_balance
--   resolve_pending_addon/fn_credit_chips receipt addon_refund NULL->player
--     + leg player_funding table_stack -> player_wallet
--   fn_union_promo_send                 receipt union_promo_to_club actor->NULL {op_id,union_id}
--     + leg promo_send union_wallet -> promo_wallet(club), correlation = op_id
-- Club E is u(500). Viewers: owner u(1), admin u(3), agent u(10), players
-- u(20), u(21), u(22), horse u(25), u(31) whose display name is their real name.
RESET ROLE;
UPDATE public.profiles SET alias = NULL, username = NULL, display_name = 'Jane Realname',
       first_name = 'Jane', last_name = 'Realname', full_name = 'Jane Realname'
 WHERE id = public.u(31);
INSERT INTO public.clubs VALUES (public.u(500), 'Club E', public.u(1));
INSERT INTO public.club_members(club_id, user_id, role, agent_id, status) VALUES
  (public.u(500), public.u(1), 'owner', NULL, 'active'),
  (public.u(500), public.u(3), 'admin', NULL, 'active'),
  (public.u(500), public.u(10), 'agent', NULL, 'active'),
  (public.u(500), public.u(20), 'member', public.u(10), 'active'),
  (public.u(500), public.u(21), 'member', public.u(10), 'active'),
  (public.u(500), public.u(22), 'member', NULL, 'active'),
  (public.u(500), public.u(25), 'member', public.u(10), 'active'),
  (public.u(500), public.u(31), 'member', public.u(10), 'active');

-- 1. A promo send: one receipt and its journal leg, one transaction.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at)
VALUES (public.u(5001), public.u(500), public.u(10), public.u(20), 50, 'promo_wallet_send', 'Promo Wallet Send',
        '{"op_id":"aaaaaaaa-0000-4000-8000-000000000001","destination":"player_wallet","source":"promo_wallet"}', '2026-09-10T10:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at, idempotency_key, correlation_id, post_to_balance, status)
VALUES (public.u(6001), 'promo_wallet', public.u(10), 'player_wallet', public.u(20), 50, 'promo_send', public.u(500), '2026-09-10T10:00:00Z',
        'promo_send:aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 50, 'posted');

-- 2. A cash out of 30 approved by the agent, and one of 7 the player cancelled.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, related_cashout_id, metadata, created_at) VALUES
  (public.u(5002), public.u(500), public.u(20), public.u(10), 30, 'cashout_request_escrow', 'Cash Out Requested. Chips Held In Escrow', public.u(7001), '{"op_id":"op-c1-hold"}', '2026-09-11T10:00:00Z'),
  (public.u(5003), public.u(500), public.u(20), public.u(10), 30, 'cashout_approved', 'Cash Out Approved. Escrow Released Into The Agent Wallet', public.u(7001), '{"op_id":"op-c1-approve"}', '2026-09-11T11:00:00Z'),
  (public.u(5004), public.u(500), public.u(20), public.u(10), 7, 'cashout_request_escrow', 'Cash Out Requested. Chips Held In Escrow', public.u(7002), '{"op_id":"op-c2-hold"}', '2026-09-11T12:00:00Z'),
  (public.u(5005), public.u(500), public.u(20), public.u(20), 7, 'cashout_cancelled', 'Cash Out Cancelled. Escrow Returned To Player', public.u(7002), '{"op_id":"op-c2-cancel"}', '2026-09-11T13:00:00Z');

-- 3. The Club Bank pays u(21) 40 (owner pressed the button) and an admin pulls 15 back.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at, reversible_until) VALUES
  (public.u(5006), public.u(500), public.u(1), public.u(21), 40, 'club_bank_send', 'Club Bank Send',
   '{"op_id":"bbbbbbbb-0000-4000-8000-000000000006","destination":"player_wallet","actor_role":"owner"}', '2026-09-12T10:00:00Z', NULL),
  (public.u(5007), public.u(500), public.u(21), public.u(3), 15, 'admin_removal', 'Chips Pulled By Club Staff',
   '{"op_id":"bbbbbbbb-0000-4000-8000-000000000007","source":"player_wallet","direction":"into_bank"}', '2026-09-12T11:00:00Z', NULL);

-- 4. The treasury funds a horse's seat (production shape: no sender).
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, created_at)
VALUES (public.u(5008), public.u(500), NULL, public.u(25), 60, 'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury', '2026-09-12T12:00:00Z');

-- 5. A BBJ promo sweep: its receipt and its journal leg.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, created_at)
VALUES (public.u(5009), public.u(500), NULL, NULL, 4.32, 'bbj_promo_sweep', 'BBJ promo slice swept to club promo wallet (club has no union)', '2026-09-13T10:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, from_label, to_type, to_entity_id, amount, category, club_id, created_at, status)
VALUES (public.u(6009), 'bbj_pool', public.u(900), 'bbj_pools.promo_balance', 'promo_wallet', public.u(500), 4.32, 'promo', public.u(500), '2026-09-13T10:00:00Z', 'posted');

-- 6. An add-on refund: its receipt and its journal leg.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, created_at)
VALUES (public.u(5010), public.u(500), NULL, public.u(20), 140.45, 'addon_refund', 'Add-on refund (exceeds max buy-in or seat vacated)', '2026-09-13T11:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at, status)
VALUES (public.u(6010), 'table_stack', public.u(501), 'player_wallet', public.u(20), 140.45, 'player_funding', public.u(500), '2026-09-13T11:00:00Z', 'posted');

-- 7. The union sends the club promo pot 100 (the owner, its union lead, pressed it).
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at)
VALUES (public.u(5011), public.u(500), public.u(1), NULL, 100, 'union_promo_to_club', 'Union Promo To Club',
        '{"op_id":"cccccccc-0000-4000-8000-000000000011","union_id":"00000000-0000-0000-0000-000000000950","destination":"club_promo_wallet"}', '2026-09-14T10:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, from_label, to_type, to_entity_id, to_label, amount, category, club_id, created_at, idempotency_key, correlation_id, status)
VALUES (public.u(6011), 'union_wallet', public.u(950), 'union_wallets.promo_wallet', 'promo_wallet', public.u(500), 'clubs.promo_balance', 100, 'promo_send', public.u(500), '2026-09-14T10:00:00Z',
        'union_promo_to_club:cccccccc-0000-4000-8000-000000000011', 'cccccccc-0000-4000-8000-000000000011', 'posted');

-- 8. A spin prize: the pool's storage path is not a name.
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, from_label, to_type, to_entity_id, amount, category, club_id, created_at, status)
VALUES (public.u(6012), 'spin_reserve', public.u(700), 'spin_bonus_pools.balance', 'player_wallet', public.u(20), 8, 'spin_prize', public.u(500), '2026-09-15T10:00:00Z', 'posted');

-- 9. A member whose display name is their real name.
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, created_at)
VALUES (public.u(5013), public.u(500), public.u(10), public.u(31), 9, 'agent_wallet_send', '2026-09-15T11:00:00Z');

-- 9b. The union pays a member 30 promo (fn_union_send_to_member_zd3core:
--     receipt union_promo_send operator->member, leg promo_send
--     union_wallet->the member's promo wallet), and the owner mints 1000
--     (fn_mint_chips_from_diamonds: receipt mint operator->nobody).
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, created_at) VALUES
  (public.u(5018), public.u(500), public.u(1), public.u(22), 30, 'union_promo_send', 'Union promo to member',
   '{"union_id":"00000000-0000-0000-0000-000000000950","destination":"promo_wallet"}', '2026-09-15T12:00:00Z'),
  (public.u(5019), public.u(500), public.u(1), NULL, 1000, 'mint', 'Chip Mint: 1000 chips',
   '{"op_id":"dddddddd-0000-4000-8000-000000000019","scope":"club"}', '2026-09-15T13:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, from_label, to_type, to_entity_id, amount, category, club_id, created_at, status)
VALUES (public.u(6018), 'union_wallet', public.u(950), 'union_wallets.promo_wallet', 'promo_wallet', public.u(22), 30, 'promo_send', public.u(500), '2026-09-15T12:00:00Z', 'posted');

-- 10. Not mirrors, and they stay: a prize leg beside another player's ticket
--     receipt of the same amount; a promo leg beside a receipt naming a
--     different holder; a refund leg beside a receipt of another amount; and
--     a prize leg beside a ticket receipt to the SAME player and amount (a
--     prize is never read against a receipt).
INSERT INTO public.chip_transactions(id, club_id, from_user_id, to_user_id, amount, transaction_type, created_at) VALUES
  (public.u(5014), public.u(500), NULL, public.u(22), 100, 'tournament_ticket_issue', '2026-09-16T10:00:00Z'),
  (public.u(5015), public.u(500), public.u(10), public.u(21), 12, 'agent_wallet_send', '2026-09-16T11:00:00Z'),
  (public.u(5016), public.u(500), NULL, public.u(20), 5, 'tournament_refund', '2026-09-16T12:00:00Z'),
  (public.u(5017), public.u(500), NULL, public.u(20), 25, 'tournament_ticket_issue', '2026-09-16T13:00:00Z');
INSERT INTO public.chip_ledger(id, from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at, status) VALUES
  (public.u(6014), 'prize_liability', public.u(600), 'player_wallet', public.u(20), 100, 'tournament_prize', public.u(500), '2026-09-16T10:00:00Z', 'posted'),
  (public.u(6015), 'promo_wallet', public.u(10), 'player_wallet', public.u(20), 12, 'promo', public.u(500), '2026-09-16T11:00:00Z', 'posted'),
  (public.u(6016), 'prize_liability', public.u(600), 'player_wallet', public.u(20), 6, 'refund', public.u(500), '2026-09-16T12:00:00Z', 'posted'),
  (public.u(6017), 'prize_liability', public.u(600), 'player_wallet', public.u(20), 25, 'tournament_prize', public.u(500), '2026-09-16T13:00:00Z', 'posted');

-- Readers through the browser doors, as the viewer.
CREATE FUNCTION pg_temp.e_page(viewer int, filters jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  r := public.fn_cashier_statement_page(public.u(500), '2026-09-01Z', '2026-09-30Z', filters, NULL, 200);
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.e_totals(viewer int, filters jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  r := public.fn_cashier_statement_totals(public.u(500), '2026-09-01Z', '2026-09-30Z', filters)->'totals';
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.e_row(viewer int, id int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT e FROM jsonb_array_elements(pg_temp.e_page(viewer)->'rows') e WHERE e->>'id' = public.u(id)::text
$$;
CREATE FUNCTION pg_temp.e_ids(viewer int, filters jsonb DEFAULT '{}') RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(e->>'id' ORDER BY e->>'id'), '{}') FROM jsonb_array_elements(pg_temp.e_page(viewer, filters)->'rows') e
$$;
CREATE FUNCTION pg_temp.ids(VARIADIC n int[]) RETURNS text[] LANGUAGE sql AS $$
  SELECT array_agg(public.u(x)::text ORDER BY public.u(x)::text) FROM unnest(n) x
$$;
-- Every page sums to its own door's totals (the two read paths agree).
CREATE FUNCTION pg_temp.e_page_totals(viewer int, filters jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'in', to_char(coalesce(sum((e->>'amount')::numeric) FILTER (WHERE e->>'direction' = 'in'), 0), 'FM999999999999999990.00'),
    'out', to_char(coalesce(sum((e->>'amount')::numeric) FILTER (WHERE e->>'direction' = 'out'), 0), 'FM999999999999999990.00'),
    'managed', to_char(coalesce(sum((e->>'amount')::numeric) FILTER (WHERE e->>'direction' = 'managed'), 0), 'FM999999999999999990.00'),
    'count', count(*))
  FROM jsonb_array_elements(pg_temp.e_page(viewer, filters)->'rows') e
$$;

-- ONE MOVE, ONE ENTRY.
SELECT assert_true(NOT (pg_temp.e_ids(20) && pg_temp.ids(6001, 6009, 6010, 6011, 6018)), 'a leg its receipt already shows is never a second entry (promo send, sweep, add-on refund, union promo)');
SELECT assert_true(NOT (pg_temp.e_ids(1) && pg_temp.ids(6001, 6009, 6010, 6011, 6018)), 'the owner reads each of those moves once');
SELECT assert_true(pg_temp.e_ids(1) @> pg_temp.ids(5001, 5009, 5010, 5011, 5018), 'the receipts stay');
SELECT assert_true(pg_temp.e_ids(22) @> pg_temp.ids(5018) AND NOT (pg_temp.e_ids(22) && pg_temp.ids(6018)) AND (pg_temp.e_row(22, 5018)->>'direction') = 'in', 'the member reads the union''s promo once, as an in');
SELECT assert_true(pg_temp.e_ids(20) @> pg_temp.ids(6014, 6015, 6016, 6017) AND pg_temp.e_ids(1) @> pg_temp.ids(6014, 6015, 6016, 6017),
  'a leg no receipt mirrors stays: another holder, another amount, or a prize beside a ticket of the same value');
SELECT assert_true(pg_temp.e_ids(1, '{"counterparty":"Player Twenty"}') @> pg_temp.ids(6014, 6015, 6016, 6017), 'the kept legs still filter by name');

-- A CASH OUT IS COUNTED WHERE ITS CHIPS MOVE.
SELECT assert_true((pg_temp.e_row(20, 5002)->>'direction') = 'out' AND (pg_temp.e_row(20, 5004)->>'direction') = 'out', 'the hold is the player''s out');
SELECT assert_true((pg_temp.e_row(20, 5003)->>'direction') = 'managed', 'the approval moves no chip of the player''s');
SELECT assert_true((pg_temp.e_row(20, 5005)->>'direction') = 'in', 'a cancelled cash out returns the player''s chips');
SELECT assert_true((pg_temp.e_row(10, 5002)->>'direction') = 'managed' AND (pg_temp.e_row(10, 5004)->>'direction') = 'managed', 'the assigned agent receives nothing at the hold');
SELECT assert_true((pg_temp.e_row(10, 5003)->>'direction') = 'in', 'the approval pays the approver');

-- THE CLUB BANK IS NOT THE OPERATOR'S WALLET.
SELECT assert_true((pg_temp.e_row(1, 5006)->>'direction') = 'managed' AND (pg_temp.e_row(3, 5007)->>'direction') = 'managed', 'the operator pays and receives nothing');
SELECT assert_true((pg_temp.e_row(21, 5006)->>'direction') = 'in' AND (pg_temp.e_row(21, 5007)->>'direction') = 'out', 'the member keeps the in and the out');
SELECT assert_true(pg_temp.e_row(1, 5006)->'from' = jsonb_build_object('type', 'club_treasury', 'id', public.u(500), 'label', NULL)
               AND pg_temp.e_row(3, 5007)->'to' = jsonb_build_object('type', 'club_treasury', 'id', public.u(500), 'label', NULL), 'the bank side is the Club Treasury');
SELECT assert_true((pg_temp.e_row(1, 5018)->>'direction') = 'managed'
               AND pg_temp.e_row(1, 5018)->'from' = jsonb_build_object('type', 'union_wallet', 'id', public.u(950), 'label', NULL), 'the union wallet pays the member, not the operator');
SELECT assert_true((pg_temp.e_row(1, 5019)->>'direction') = 'managed', 'a mint into the treasury moves none of the operator''s chips');
SELECT assert_true((pg_temp.e_row(1, 5011)->>'direction') = 'managed'
               AND pg_temp.e_row(1, 5011)->'from' = jsonb_build_object('type', 'union_wallet', 'id', public.u(950), 'label', NULL)
               AND pg_temp.e_row(1, 5011)->'to' = jsonb_build_object('type', 'promo_wallet', 'id', public.u(500), 'label', NULL), 'a pot paying a pot moves no member''s wallet');

-- NOTHING NAMES A HORSE.
SELECT assert_true(pg_temp.e_row(1, 5008)->>'kind' = 'club_bank_send' AND pg_temp.e_row(1, 5008)->'from' = pg_temp.e_row(1, 5006)->'from'
               AND pg_temp.e_row(1, 5008)->'reference'->>'op_id' IS NULL AND pg_temp.e_row(1, 5006)->'reference'->>'op_id' IS NULL
               AND pg_temp.e_row(1, 5008)->>'notes' IS NULL AND pg_temp.e_row(1, 5006)->>'notes' IS NULL, 'a treasury-funded seat reads exactly as a Club Bank send');
SELECT assert_true(pg_temp.e_ids(1, '{"operation":"treasury_funding"}') = '{}' AND pg_temp.e_ids(1, '{"operation":"club_bank_send"}') = pg_temp.ids(5006, 5008), 'no filter isolates the horse rows');
SELECT assert_true(pg_temp.e_page(1)::text !~* 'horse', 'no owner page carries a horse marker');

-- THE ARENA NAME, NEVER A REAL NAME. NO STORAGE PATH AS A NAME.
SELECT assert_true(pg_temp.e_row(1, 5013)->'to'->>'label' = 'Player' AND pg_temp.e_page(1)::text !~ 'Realname', 'a real name is never printed');
SELECT assert_true(pg_temp.e_ids(1, '{"counterparty":"Realname"}') = '{}', 'a real name is never searchable');
SELECT assert_true(pg_temp.e_row(10, 5013)->'to'->>'label' = 'Player' AND (SELECT e->>'counterparty' FROM jsonb_array_elements(pg_temp.e_page(10)->'rows') e WHERE e->>'id' = public.u(5013)::text) = 'Player', 'the counterparty is the arena name');
SELECT assert_true(pg_temp.e_row(20, 6012)->'from' = jsonb_build_object('type', 'spin_reserve', 'id', public.u(700), 'label', NULL), 'a storage path is not printed as a name');
SELECT assert_true(pg_temp.e_ids(1, '{"counterparty":"spin_bonus"}') = '{}', 'a storage path is not searchable');
SELECT assert_true((SELECT e->>'wallet' FROM jsonb_array_elements(pg_temp.e_page(20)->'rows') e WHERE e->>'id' = public.u(5016)::text) = 'table', 'a tournament refund is a table entry');

-- THE TOTALS.
-- u(20) receives 50 (promo send) + 7 (cancelled cash out) + 140.45 (add-on
-- refund) + 8 (spin) + 100 + 12 + 6 + 25 (legs no receipt mirrors) + 5
-- (tournament refund) + 25 (ticket) = 378.45, pays 30 + 7 into escrow, and
-- the approval of the 30 moves none of u(20)'s chips. The live body read
-- in 561.90 / out 67.00 / managed 7.00 over 15 entries.
SELECT assert_true(pg_temp.e_totals(20) = '{"in":"378.45","out":"37.00","managed":"30.00","count":13}'::jsonb,
  'the player''s totals count each move once, where its chips moved');
SELECT assert_true(pg_temp.e_totals(20) = pg_temp.e_page_totals(20), 'the player''s totals are the page''s');
SELECT assert_true(pg_temp.e_totals(10) = pg_temp.e_page_totals(10) AND pg_temp.e_totals(1) = pg_temp.e_page_totals(1)
               AND pg_temp.e_totals(3) = pg_temp.e_page_totals(3) AND pg_temp.e_totals(21) = pg_temp.e_page_totals(21), 'every viewer''s totals are their page''s');
SELECT assert_true((pg_temp.e_totals(1)->>'out') = '0.00' AND (pg_temp.e_totals(1)->>'in') = '0.00', 'the owner paid and received nothing personally');
SELECT assert_true(pg_temp.e_totals(1, '{"direction":"managed"}') = pg_temp.e_page_totals(1, '{"direction":"managed"}')
               AND pg_temp.e_totals(1, '{"wallet":"promo"}') = pg_temp.e_page_totals(1, '{"wallet":"promo"}'), 'filtered owner totals are their pages');
RESET ROLE;
