INSERT INTO public.profiles (
  id, username, display_name, alias, player_number, first_name, last_name, full_name,
  is_online, last_seen
) VALUES
  ('20000000-0000-0000-0000-000000000001', 'viewer', 'Viewer Person', 'RailBird', '1001',
   'Viewer', 'Person', 'Viewer Person', true, now()),
  ('20000000-0000-0000-0000-000000000002', 'kingfish', 'Dan Bekavac', 'KingFish', '1002',
   'Dan', 'Bekavac', 'Dan Bekavac', false, now()),
  ('20000000-0000-0000-0000-000000000003', 'unrelated', 'Unrelated Person', 'Unrelated', '1003',
   'Unrelated', 'Person', 'Unrelated Person', false, now() - interval '1 day');

INSERT INTO public.player_search_preferences (
  user_id, discoverable, show_display_name, show_presence, show_current_table
) VALUES (
  '20000000-0000-0000-0000-000000000002', false, false, true, true
);

INSERT INTO public.clubs (
  id, club_id, slug, name, requires_approval, is_public, status
) VALUES
  ('a0000000-0000-0000-0000-000000000001', 70001, 'open-room', 'Open Room', false, true, 'active'),
  ('a0000000-0000-0000-0000-000000000002', 70002, 'deleted-room', 'Deleted Room', true, false, 'active'),
  ('a0000000-0000-0000-0000-000000000003', 70003, 'closed-room', 'Closed Room', true, false, 'active'),
  ('a0000000-0000-0000-0000-000000000004', 70004, 'mismatch-room', 'Mismatch Room', true, false, 'active');

INSERT INTO public.club_members (club_id, user_id, status, role) VALUES
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'active', 'super_agent'),
  ('a0000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'active', 'owner'),
  ('a0000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'active', 'owner'),
  ('a0000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'active', 'owner');

INSERT INTO public.tournaments (
  id, club_id, name, variant, game_type, buy_in_amount, status
) VALUES
  ('40000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   'Running Event', 'NLH', 'NLH', 25, 'running'),
  ('40000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000004',
   'Other Event', 'NLH', 'NLH', 25, 'running');

INSERT INTO public.tables (
  id, club_id, tournament_id, name, game_variant, game_type, small_blind, big_blind,
  status, is_deleted, is_anonymous, restrict_observers
) VALUES
  ('30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   '40000000-0000-0000-0000-000000000001', 'Deleted Table', 'NLH', 'NLH', 10, 20,
   'running', true, false, false),
  ('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003',
   '40000000-0000-0000-0000-000000000001', 'Closed Table', 'NLH', 'NLH', 10, 20,
   'closed', false, false, false),
  ('30000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004',
   '40000000-0000-0000-0000-000000000002', 'Mismatched Table', 'NLH', 'NLH', 10, 20,
   'running', false, false, false);

INSERT INTO public.tournament_players (user_id, tournament_id, table_id, status) VALUES
  ('20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'playing'),
  ('20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', 'playing'),
  ('20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000003', 'playing');
