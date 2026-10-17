-- Club Data fact fixture (20261017160125): the columns of the production
-- tables the migration reads and writes, nothing else. Roles come from the
-- harness (scripts/ci/test-club-data-fact-db-postgres.py), as on Supabase.
-- fn_ca_cash_reporting_club is production's text after 20261017105645; the three
-- other helpers are reduced to the answer production gives for these clubs.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;

CREATE TABLE clubs (id uuid PRIMARY KEY, name text, owner_id uuid);
CREATE TABLE profiles (id uuid PRIMARY KEY, username text, is_admin boolean DEFAULT false);
CREATE TABLE club_members (club_id uuid, user_id uuid, role text, status text DEFAULT 'active', agent_id uuid, joined_at timestamptz DEFAULT now());
CREATE TABLE union_clubs (union_id uuid, club_id uuid);
CREATE TABLE tables (id uuid PRIMARY KEY, club_id uuid, union_id uuid, tournament_id uuid, name text, game_variant text, game_mode text,
  big_blind numeric, small_blind numeric, created_at timestamptz DEFAULT now(), status text, created_by uuid);
CREATE TABLE table_seats (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid, user_id uuid, club_id uuid, stack numeric,
  left_at timestamptz, status text, joined_at timestamptz DEFAULT now());
CREATE TABLE tournaments (id uuid PRIMARY KEY, club_id uuid, union_id uuid, name text, tournament_type text, variant text, game_type text,
  start_time timestamptz, status text);
CREATE TABLE tournament_players (tournament_id uuid, user_id uuid, club_id uuid, UNIQUE (tournament_id, user_id));
CREATE TABLE rake_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid, tournament_id uuid, is_tournament boolean,
  rake_amount numeric, created_at timestamptz DEFAULT now(), player_contributions jsonb, metadata jsonb);
CREATE TABLE wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric, type text, category text,
  table_id uuid, related_entity_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE chip_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, from_type text, from_entity_id uuid, to_type text,
  to_entity_id uuid, amount numeric, table_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE cash_participant_funding_receipts (operation_kind text, table_id uuid, account_entity_id uuid, funding_club_id uuid, seat_joined_at timestamptz);
CREATE TABLE rake_attributions (rake_record_id uuid, player_id uuid, club_id uuid);

-- Production definition as 20261017105645 (PR #7262) left it: the club of the
-- player's most recently joined seat at ANY table, the union not consulted.
-- The migration under test must replace it.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_reporting_club(p_union uuid, p_table_club uuid, p_user uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT ts.club_id FROM public.table_seats ts
     WHERE ts.user_id = p_user AND ts.club_id IS NOT NULL
     ORDER BY ts.joined_at DESC NULLS LAST
     LIMIT 1
  ), (
    SELECT cm.club_id FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union
     WHERE p_union IS NOT NULL AND p_user IS NOT NULL AND cm.user_id = p_user
     ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
     LIMIT 1
  ), p_table_club);
$$;

-- The advanced report's per-table facts, written per hand by production's
-- rake insert trigger through fn_ca_club_table_daily_add_rake (redefined by
-- the migration; the fixture only needs it to exist and be called).
CREATE TABLE club_table_daily (club_id uuid, table_id uuid, stat_date date, union_id uuid, rake numeric, hands int, players int,
  buyins numeric, cashouts numeric, net numeric, source_rows int, updated_at timestamptz, UNIQUE (club_id, table_id, stat_date));
CREATE TABLE ca_club_table_player_daily (club_id uuid, table_id uuid, stat_date date, user_id uuid, PRIMARY KEY (club_id, table_id, stat_date, user_id));
CREATE FUNCTION public.fn_ca_club_table_daily_add_rake(p_table uuid, p_rake numeric, p_at timestamptz, p_contrib jsonb)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE FUNCTION public.fixture_rake_daily() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.table_id IS NOT NULL THEN
    PERFORM public.fn_ca_club_table_daily_add_rake(NEW.table_id, NEW.rake_amount, NEW.created_at, NEW.player_contributions);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fixture_rake_daily AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION public.fixture_rake_daily();
CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid, timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION fn_cashier_member_is_active(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION fn_club_role_rank(text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE $1 WHEN 'owner' THEN 6 WHEN 'co_owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'super_agent' THEN 3
                 WHEN 'agent' THEN 2 WHEN 'sub_agent' THEN 1 ELSE 0 END $$;
