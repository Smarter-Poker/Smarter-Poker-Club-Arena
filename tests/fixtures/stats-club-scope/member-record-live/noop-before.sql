-- Isolated native fixture, never a production probe. Match the exact captured
-- production owner/ACL without changing the function's original body bytes.
DO $$ BEGIN CREATE ROLE postgres; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER FUNCTION public.fn_publish_member_record_row() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_row() FROM PUBLIC,anon,authenticated,service_role,fixture_admin;
GRANT EXECUTE ON FUNCTION public.fn_publish_member_record_row() TO postgres;
-- The isolated fixture originally owns its dependencies as fixture_admin;
-- production owns these same private helpers/data as postgres. Give only the
-- captured trigger owner's required fixture reads/calls, never app roles.
GRANT SELECT ON public.club_members TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_publish_member_record_user(uuid),
 public.fn_publish_club_roster(uuid),public.fn_publish_member_record_topic(text,jsonb) TO postgres;
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure))<>'9c508011d3e04af5b43137d46cc58901' THEN
  RAISE EXCEPTION 'No-op fixture does not match the captured live source';
 END IF;
END $$;
CREATE TABLE fixture_noop_original_state AS SELECT to_jsonb(s) AS state FROM public.ca_private_record_transport_state s;
INSERT INTO clubs(id,name) VALUES('75000000-0000-0000-0000-000000000001','No-op native fixture');
INSERT INTO profiles(id,alias,status) VALUES
 ('75000000-0000-0000-0000-000000000002','Original upline','active'),
 ('75000000-0000-0000-0000-000000000003','Original child','active');
INSERT INTO club_members(user_id,club_id,agent_id,status,chip_balance,promo_balance) VALUES
 ('75000000-0000-0000-0000-000000000002','75000000-0000-0000-0000-000000000001',NULL,'active',0,0),
 ('75000000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000002','active',0,0);
INSERT INTO agents(user_id,club_id,status,agent_wallet_balance,promo_wallet_balance) VALUES
 ('75000000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000001','active',0,0);
INSERT INTO table_seats(user_id,table_id,club_id) VALUES
 ('75000000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000004','75000000-0000-0000-0000-000000000001');
INSERT INTO ca_club_rake_daily_user(user_id,club_id,rake_cents) VALUES
 ('75000000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000001',0);
INSERT INTO ca_club_member_tournament_fee_daily(user_id,club_id,fees) VALUES
 ('75000000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000001',0);
