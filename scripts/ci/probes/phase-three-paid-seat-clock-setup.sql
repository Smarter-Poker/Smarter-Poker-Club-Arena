
-- Actual paid SNG entry on a pre-existing synthetic funded club.
-- Only identity and clock fixture fields are seeded; every guard stays enabled.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
VALUES ('ca090200-0000-0000-0000-000000000001','1678abc5-4bd8-8461-706f-9f8c9b63e4ae',now(),now());
CREATE TEMP TABLE ca09_paid_seat(table_id uuid, receipt jsonb) ON COMMIT DROP;
GRANT ALL ON ca09_paid_seat TO service_role,authenticated;
SELECT set_config('request.jwt.claim.role','service_role',true),
 set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $create_paid$
DECLARE r jsonb;
BEGIN
 r:=public.fn_create_seat_first_game_atomic('ca090300-0000-0000-0000-000000000001',
 jsonb_build_object('club_id','94000000-0000-0000-0000-000000000001','union_id',NULL,
 'name','CA09 Actual Paid SNG Clock','game_type','NLH','variant','sng','tournament_type','SNG',
 'buy_in_amount',1,'buy_in_fee',0,'guaranteed_prize',0,'starting_chips',1000,
 'max_players',2,'min_players',2,'table_size',2,'current_players',0,'status','REGISTERING',
 'blind_structure','[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]'::jsonb,
 'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
 'start_time',clock_timestamp()+interval '1 day','late_reg_levels',0,'late_reg_mins',0));
 IF r->>'ok' IS DISTINCT FROM 'true' OR nullif(r->>'table_id','') IS NULL THEN
 RAISE EXCEPTION 'CA09 actual creator refused: %',r; END IF;
 INSERT INTO ca09_paid_seat VALUES((r->>'table_id')::uuid,r);
END $create_paid$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
-- Restore only the original initially-deferred transaction contract before
-- the next actual entry request; all constraints are checked at its boundary.
DO $restore_initial_modes$
DECLARE c record;
BEGIN
 FOR c IN SELECT DISTINCT co.conname FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace
 WHERE n.nspname='public' AND co.condeferrable AND co.condeferred ORDER BY co.conname LOOP
 IF EXISTS(SELECT 1 FROM pg_constraint other JOIN pg_namespace n ON n.oid=other.connamespace
 WHERE n.nspname='public' AND other.conname=c.conname AND (NOT other.condeferrable OR NOT other.condeferred))
 THEN RAISE EXCEPTION 'CA09 ambiguous initial constraint mode: %',c.conname; END IF;
 EXECUTE format('SET CONSTRAINTS public.%I DEFERRED',c.conname);
 END LOOP;
END $restore_initial_modes$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true),
 set_config('request.jwt.claim.sub','1678abc5-4bd8-8461-706f-9f8c9b63e4ae',true),
 set_config('request.jwt.claims','{"role":"authenticated","sub":"1678abc5-4bd8-8461-706f-9f8c9b63e4ae","session_id":"ca090200-0000-0000-0000-000000000001"}',true);
DO $paid_entry$
DECLARE r jsonb;
BEGIN
 r:=public.fn_take_seat_and_buy_in((SELECT table_id FROM ca09_paid_seat),1);
 IF r->>'ok' IS DISTINCT FROM 'true' OR (r->>'cost')::numeric IS DISTINCT FROM 1 THEN
 RAISE EXCEPTION 'CA09 actual paid entry refused: %',r; END IF;
 UPDATE ca09_paid_seat SET receipt=r;
END $paid_entry$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
DO $paid_guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id='94000000-0000-0000-0000-000000000001'
 AND user_id='1678abc5-4bd8-8461-706f-9f8c9b63e4ae' AND chip_balance=99)
 OR NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=(SELECT table_id FROM ca09_paid_seat)
 AND user_id='1678abc5-4bd8-8461-706f-9f8c9b63e4ae' AND left_at IS NULL AND stack=1000)
 THEN RAISE EXCEPTION 'CA09 actual charged seat missing'; END IF;
END $paid_guard$;
UPDATE public.table_seats SET is_sitting_out=true,sit_out_at=(SELECT freeze_start-interval '20 seconds' FROM ca09_parameters)
WHERE table_id=(SELECT table_id FROM ca09_paid_seat) AND left_at IS NULL;
CREATE TEMP TABLE ca09_paid_seat_before ON COMMIT DROP AS
SELECT id,to_jsonb(s)-'sit_out_at' AS unchanged_fields,sit_out_at FROM public.table_seats s
WHERE table_id=(SELECT table_id FROM ca09_paid_seat) AND left_at IS NULL;
