-- Club u(100) for scripts/ci/test-horse-reads-db-postgres.py (see scenario.sql
-- for who is who). Receipts are written in production's own shapes: a Club
-- Bank send as fn_club_bank_send_core_20261004 writes it, a funded seat as
-- fn_horse_fund_from_treasury_before_maintenance_gate writes it (no sender, no
-- metadata, no reversal window), and its journal leg likewise.
INSERT INTO public.clubs VALUES (public.u(100), public.u(1), 'Deep Stack');
INSERT INTO public.profiles(id, alias, username, display_name, first_name, last_name, full_name, is_horse) VALUES
  (public.u(1),  'TheHouse',    'owner1',  'Olivia Owner', 'Olivia', 'Owner', 'Olivia Owner', false),
  (public.u(2),  'BigBoss',     'boss2',   'Sam Super',    'Sam',    'Super', 'Sam Super',    false),
  (public.u(10), 'SharkTank',   'agent10', 'Arthur Agent', 'Arthur', 'Agent', 'Arthur Agent', false),
  (public.u(21), 'Kingfish',    'kingfish','Dan Bekavac',  'Dan',    'Bekavac','Dan Bekavac', false),
  (public.u(25), 'Quiet Rider', 'qrider',  'Quiet Rider',  NULL,     NULL,    NULL,          true);
INSERT INTO public.club_members(club_id, user_id, role, status, agent_id) VALUES
  (public.u(100), public.u(1),  'owner',       'active',   NULL),
  (public.u(100), public.u(2),  'super_agent', 'approved', NULL),
  (public.u(100), public.u(10), 'agent',       'active',   NULL),
  (public.u(100), public.u(21), 'player',      'approved', public.u(10)),
  (public.u(100), public.u(25), 'player',      'approved', public.u(10));
INSERT INTO public.agents(club_id, user_id, status) VALUES
  (public.u(100), public.u(2), 'active'), (public.u(100), public.u(10), 'active');

INSERT INTO public.chip_transactions(id, created_at, club_id, transaction_type, amount, from_user_id, to_user_id,
                                     notes, metadata, balance_after, is_reversed, reversible_until) VALUES
  (public.u(9101), '2026-09-01T10:00:00Z', public.u(100), 'club_bank_send', 40, public.u(1), public.u(21), 'Club Bank Send',
   '{"op_id":"aaaaaaaa-0000-4000-8000-000000009101","destination":"player_wallet","actor_role":"owner","recipient_role":"player","bank_before":1000,"bank_after":960,"recipient_balance_after":140}',
   960, false, '2026-09-08T10:00:00Z'),
  (public.u(9102), '2026-09-02T10:00:00Z', public.u(100), 'horse_treasury_funding', 60, NULL, public.u(25),
   'Horse buy-in/rebuy funded from club treasury', '{}', 900, false, NULL),
  (public.u(9103), '2026-09-03T10:00:00Z', public.u(100), 'horse_treasury_funding', 25, NULL, public.u(25),
   'Horse rebuy shortfall funded from club treasury (wallet paid 5)', '{}', 875, false, NULL),
  (public.u(9104), '2026-09-04T10:00:00Z', public.u(100), 'club_bank_send', 100, public.u(2), public.u(10), 'float for the weekend',
   '{"op_id":"aaaaaaaa-0000-4000-8000-000000009104","destination":"agent_wallet","actor_role":"super_agent","recipient_role":"agent","bank_before":875,"bank_after":775,"recipient_balance_after":100}',
   775, false, '2026-09-11T10:00:00Z'),
  (public.u(9105), '2026-09-05T10:00:00Z', public.u(100), 'peer_transfer', 5, public.u(21), public.u(10), 'thanks', '{}', NULL, false, NULL),
  (public.u(9106), '2026-09-06T10:00:00Z', public.u(100), 'treasury_mint', 500, NULL, NULL,
   'Beta bankroll top-up — fund every horse to the 10k floor', '{}', 1275, false, NULL),
  (public.u(9107), '2026-09-07T10:00:00Z', public.u(100), 'club_bank_claim', 30, public.u(10), public.u(2), 'Club Bank Claim',
   '{"op_id":"aaaaaaaa-0000-4000-8000-000000009107","source":"agent_wallet"}', 1305, false, NULL);

INSERT INTO public.chip_ledger(id, created_at, amount, category, description, club_id, table_id, from_type, from_label,
                               from_entity_id, to_type, to_label, to_entity_id, metadata, idempotency_key) VALUES
  (public.u(8101), '2026-09-02T10:00:00Z', 60, 'horse_funding',
   'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury) for 00000000-0000-0000-0000-000000000025',
   public.u(100), public.u(700), 'club_treasury', NULL, public.u(100), 'table_stack', NULL, public.u(700),
   '{"user_id":"00000000-0000-0000-0000-000000000025","door":"fn_horse_fund_from_treasury"}', 'horse_fund:op-8101'),
  (public.u(8102), '2026-09-03T10:00:00Z', 25, 'horse_funding',
   'Seated + funded from club treasury (fn_horse_seat_from_treasury) for 00000000-0000-0000-0000-000000000025',
   public.u(100), public.u(700), 'club_treasury', NULL, public.u(100), 'table_stack', NULL, public.u(700),
   '{"user_id":"00000000-0000-0000-0000-000000000025","door":"fn_horse_seat_from_treasury"}', 'horse_fund:op-8102'),
  (public.u(8103), '2026-09-04T12:00:00Z', 15, 'commission', 'Weekly commission through recorded earning hierarchy',
   public.u(100), NULL, 'club_treasury', 'clubs.chip_treasury', public.u(100), 'player_wallet', NULL, public.u(10), '{}', NULL),
  (public.u(8104), '2026-09-06T10:00:00Z', 500, 'mint', 'auto-ledgered clubs.chip_treasury delta 500',
   public.u(100), NULL, 'issuance_reserve', NULL, NULL, 'club_treasury', 'clubs.chip_treasury', public.u(100), '{}', NULL);
