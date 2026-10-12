-- Stand-ins for the production objects 20261012132509_only_staff_can_remove_a_member
-- meets, for scripts/ci/test-only-staff-remove-member-db-postgres.py. Nothing here
-- reaches production.
--
-- Loaded AFTER tests/fixtures/union-owner-membership-db/fixture.sql, which
-- already holds clubs, club_members, its lifecycle/status/role guards,
-- audit_trail, agents and production's live (drifted) body of
-- fn_remove_settled_club_member. This file adds what the reviewed body reads
-- before it lets a member go: the diamonds balance, live seats, tournament
-- entries, cashout requests, escrow, tickets and chip requests - each with the
-- columns production has (information_schema, read-only, 2026-10-12).

ALTER TABLE public.club_members ADD COLUMN diamonds numeric DEFAULT 0;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE
);
CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id uuid,
  left_at timestamptz
);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE
);
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id uuid,
  status text
);
CREATE TABLE public.cashout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  player_id uuid,
  agent_id uuid,
  status text
);
CREATE TABLE public.chip_escrow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cashout_request_id uuid REFERENCES public.cashout_requests(id),
  player_id uuid,
  released_at timestamptz
);
CREATE TABLE public.chip_escrow_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  user_id uuid,
  status text
);
CREATE TABLE public.tournament_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  holder_id uuid,
  status text
);
CREATE TABLE public.chip_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  requester_id uuid,
  approver_id uuid,
  status text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
