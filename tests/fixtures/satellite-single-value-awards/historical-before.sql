-- Isolated PostgreSQL only: create an actual legacy cash receipt before replacement.
CREATE TABLE public.single_value_historical_fixture(source_id uuid,winner uuid,receipt jsonb,wallet numeric);
DO $history$
DECLARE c jsonb;s uuid;w uuid;r jsonb;
BEGIN
 c:=pg_temp.single_value_case('single_historical_cash',1,false);
 s:=(c->>'tournament_id')::uuid;w:=md5('l04:single_historical_cash:user:1')::uuid;
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournaments SET status='COMPLETED',prize_pool_finalized=true WHERE id=(c->>'target_id')::uuid;
 PERFORM set_config('session_replication_role','origin',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 EXECUTE 'SET LOCAL ROLE service_role';r:=public.fn_settle_satellite_tournament(s,w);EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert((r->>'cash_ticket_count')::int=2,'historical actual legacy paid cash');
 INSERT INTO public.single_value_historical_fixture SELECT s,w,r,sum(chip_balance) FROM public.club_members WHERE club_id=(SELECT club_id FROM public.tournaments WHERE id=s);
END $history$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
