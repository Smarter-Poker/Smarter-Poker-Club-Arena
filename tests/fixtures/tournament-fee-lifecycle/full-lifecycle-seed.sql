
-- Exact read-only current store-policy catalog, no live balances or user data.
INSERT INTO public.ca_chip_store_coverage SELECT * FROM jsonb_populate_recordset(NULL::public.ca_chip_store_coverage,'[{"store": "agent_wallet", "treatment": "counted", "counted_by": "agent_wallets", "notes": "agents agent_wallet_balance and promo_wallet_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "bbj_pool", "treatment": "counted", "counted_by": "bbj_pools", "notes": "main, backup and promo", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "bounty_liability", "treatment": "counted", "counted_by": "tournament_liability", "notes": "tournament_escrow bounty_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "chip_retirement", "treatment": "noncirculating", "counted_by": null, "notes": "retirement holding", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "club_treasury", "treatment": "counted", "counted_by": "treasuries", "notes": "clubs chip_treasury", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "club_wallet", "treatment": "counted", "counted_by": "club_wallets", "notes": "club_wallets chip_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "credit_facility", "treatment": "uncounted", "counted_by": null, "notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "credit_receivable", "treatment": "uncounted", "counted_by": null, "notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "escrow", "treatment": "counted", "counted_by": "ticket_escrow", "notes": "Outstanding tournament tickets. ADDED 2026-09-11: it was in no list at all, which is the whole of the five supply incidents of that morning", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "insurance_bank", "treatment": "counted", "counted_by": "club_insurance + union insurance_wallet", "notes": "clubs insurance_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "issuance_reserve", "treatment": "noncirculating", "counted_by": null, "notes": "issuance held before it enters circulation", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "leaderboard_round", "treatment": "counted", "counted_by": "leaderboard_liability", "notes": "the same seed, while a round is being settled", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "opening_setup", "treatment": "counted", "counted_by": "leaderboard_liability", "notes": "club_opening_setups leaderboard_seed_remaining", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "player_wallet", "treatment": "counted", "counted_by": "member_wallets + member_promo", "notes": "club_members chip_balance and promo_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "prize_liability", "treatment": "counted", "counted_by": "tournament_liability", "notes": "tournament_escrow prize_balance, or the counters where an event has no escrow row yet", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "promo_wallet", "treatment": "counted", "counted_by": "club_promo + agent_promo + union promo_wallet", "notes": "the promo floats, brought inside the total on 2026-09-03", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "rakeback_payable", "treatment": "uncounted", "counted_by": null, "notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "refund_payable", "treatment": "uncounted", "counted_by": null, "notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "settlement_suspense", "treatment": "uncounted", "counted_by": null, "notes": "NOT in the basis and NOT verified as a routing label. It holds a large historical net and has not moved in the sixty hours to 2026-09-11 15:00, so it is not implicated in the incidents this migration fixes. Declared uncounted deliberately rather than guessed into the total, where a wrong guess would double count. Any movement now raises a finding, which is the point", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "spin_reserve", "treatment": "counted", "counted_by": "spin_pools + union spin_reserve_wallet", "notes": "spin_bonus_pools balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "system_burn", "treatment": "noncirculating", "counted_by": null, "notes": "retirement. A move into it is a burn", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "system_mint", "treatment": "noncirculating", "counted_by": null, "notes": "issuance. A move out of it is a mint", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "table_stack", "treatment": "counted", "counted_by": "felt", "notes": "table_seats stack on cash tables. Tournament felt is deliberately excluded and carried by tournament_liability instead", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "union_bank", "treatment": "counted", "counted_by": "union_wallets", "notes": "union_wallets chip_balance", "added_at": "2026-09-11 16:10:27.128168+00"}, {"store": "union_wallet", "treatment": "counted", "counted_by": "union_wallets", "notes": "the union rake, bbj, promo, insurance and spin reserve wallets", "added_at": "2026-09-11 16:10:27.128168+00"}]'::jsonb);
-- Seed only the structural source rows shared by the atomic terminal SQL
-- probes. Run as postgres on a disposable schema-replay database after all
-- stage-one migrations. Individual probes clone these rows inside rollback
-- transactions and never mutate this template.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id) VALUES
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'),
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users(id,username) VALUES
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','club_arena_system'),
  ('10000000-0000-0000-0000-000000000001','probe_user_1'),
  ('10000000-0000-0000-0000-000000000002','probe_user_2')
ON CONFLICT (id) DO NOTHING;

-- The hand-boundary probe intentionally creates profile 2 itself and rolls it
-- back, so only the common clone source belongs in this persistent fixture.
INSERT INTO public.profiles(id,username,display_name) VALUES
  ('10000000-0000-0000-0000-000000000001',
   'probe_user_1','Probe User One')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES
  ('20000000-0000-0000-0000-000000000001','Atomic Probe Club',
   '10000000-0000-0000-0000-000000000001',1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','owner','active',0),
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002','player','active',0)
ON CONFLICT (club_id,user_id) DO NOTHING;

-- Terminal money probes begin after every promised purchase window closes.
-- The hand-boundary probe explicitly overrides levels and rebuy eligibility.
INSERT INTO public.tournaments(
  id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,
  prize_pool,bounty_pool,bounty_pool_paid,total_rake,guaranteed_prize,
  current_players,payout_structure,prize_pool_finalized,
  started_at,current_level,late_reg_levels,rebuy_levels,late_reg_mins,
  is_rebuy,is_reentry,add_on_available,addon_period_started_at,addon_period_ends_at)
VALUES(
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001','Atomic Probe Template',
  10,0,now(),9,'RUNNING',10,0,0,0,0,1,
  '[{"place":1,"percentage":100}]'::jsonb,false,
  now()-interval '2 hours',5,4,4,60,false,false,false,NULL,NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,prize,current_bounty,
  bounty_winnings,mystery_bounty_value)
VALUES(
  '31000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Probe User One',10,'playing',0,0,0,0)
ON CONFLICT (tournament_id,user_id) DO NOTHING;

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
  bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
VALUES(
  '30000000-0000-0000-0000-000000000001',
  10,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0,0,
  'atomic-probe-template',now(),now(),true)
ON CONFLICT (tournament_id) DO NOTHING;

COMMIT;
