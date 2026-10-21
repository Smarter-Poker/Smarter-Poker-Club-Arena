CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000099'::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE TABLE roster_fixture (
 user_id uuid, club_id uuid, alias text, username text, player_number text,
 home_club_name text, upline_name text, role text, role_rank int, joined_at timestamptz,
 last_login timestamptz, is_seated boolean, is_online boolean, in_viewer_downline boolean,
 can_view_financials boolean, can_view_notes boolean, player_wallet numeric,
 agent_wallet numeric, downline_total int, total_fees numeric
);
CREATE FUNCTION public.ca_club_roster_rows(uuid) RETURNS SETOF roster_fixture
 LANGUAGE sql AS $$ SELECT * FROM roster_fixture WHERE club_id = $1 $$;
CREATE FUNCTION public.fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
CREATE TABLE audit_trail (id uuid DEFAULT gen_random_uuid(), actor_id uuid, actor_role text,
 action text, target_type text, target_id uuid, club_id uuid, after_state jsonb, reason text);
INSERT INTO roster_fixture
SELECT ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001',
 'Player ' || (100-n), 'player' || n, n::text, 'Test Club', '',
 'player', n % 3,
 CASE WHEN n > 22 THEN NULL ELSE '2026-01-01'::timestamptz + (n/3)*interval '1 day' END,
 '2026-10-21'::timestamptz - n*interval '1 hour', n%2=0, n%3=0, true,
 true, false, n, 0, 0, n FROM generate_series(1,45) n;
-- Another club must not leak into the page.
INSERT INTO roster_fixture SELECT user_id, '00000000-0000-0000-0000-000000000002',
 alias, username, player_number, home_club_name, upline_name, role, role_rank,
 '2027-01-01', last_login, is_seated, is_online, in_viewer_downline,
 can_view_financials, can_view_notes, player_wallet, agent_wallet, downline_total, total_fees
 FROM roster_fixture WHERE user_id = '00000000-0000-0000-0000-000000000001';
