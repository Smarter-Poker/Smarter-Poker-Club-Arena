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
