-- Disposable maintained native cluster only. The validator reads these
-- synthetic immutable payment witnesses; this fixture never calls a payer.
BEGIN;
SET LOCAL session_replication_role=replica;
CREATE TABLE held_fee_fixture.mystery_prefix_ids AS
 SELECT tp.user_id winner FROM public.tournament_players tp
 WHERE tp.tournament_id=held_fee_fixture.event() ORDER BY tp.position NULLS LAST LIMIT 1;
CREATE COLLATION held_fee_fixture.credit_key_icu (provider=icu,locale='en-US');
ALTER TABLE public.wallet_credit_idempotency
 ALTER COLUMN key TYPE text COLLATE held_fee_fixture.credit_key_icu;
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'id','88000000-0000-0000-0000-000000000001','name','Native Mystery Prefix Evidence',
 'is_bounty',true,'is_pko',false,'is_mystery_bounty',true,
 'mystery_bounty_stage','complete','mystery_bounty_pool_cents',1200,
 'bounty_pool',12,'bounty_pool_paid',12))).*
 FROM public.tournaments t WHERE t.id=held_fee_fixture.event();
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object(
 'id','88100000-0000-0000-0000-000000000001',
 'tournament_id','88000000-0000-0000-0000-000000000001'))).*
 FROM public.tournament_players tp WHERE tp.tournament_id=held_fee_fixture.event()
 AND tp.user_id=(SELECT winner FROM held_fee_fixture.mystery_prefix_ids) LIMIT 1;
INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents,status,award_id) VALUES
 ('88400000-0000-0000-0000-000000000001','88000000-0000-0000-0000-000000000001',1,'base',500,'paid','88500000-0000-0000-0000-000000000001'),
 ('88400000-0000-0000-0000-000000000002','88000000-0000-0000-0000-000000000001',2,'base',500,'paid','88500000-0000-0000-0000-000000000002'),
 ('88400000-0000-0000-0000-000000000003','88000000-0000-0000-0000-000000000001',3,'base',200,'void',NULL);
INSERT INTO public.tournament_bounty_awards(id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,status,op_id,reserved_at,revealed_at,paid_at) VALUES
 ('88500000-0000-0000-0000-000000000001','88000000-0000-0000-0000-000000000001','88400000-0000-0000-0000-000000000001','88510000-0000-0000-0000-000000000001',500,'base','completed','88520000-0000-0000-0000-000000000001',now(),now(),now()),
 ('88500000-0000-0000-0000-000000000002','88000000-0000-0000-0000-000000000001','88400000-0000-0000-0000-000000000002','88510000-0000-0000-0000-000000000002',500,'base','completed','88520000-0000-0000-0000-000000000002',now(),now(),now());
INSERT INTO public.tournament_bounty_award_recipients(id,award_id,user_id,amount_cents,is_designated_revealer,paid_at)
SELECT id::uuid,award::uuid,winner,500,true,now() FROM held_fee_fixture.mystery_prefix_ids CROSS JOIN (VALUES
 ('88600000-0000-0000-0000-000000000001','88500000-0000-0000-0000-000000000001'),
 ('88600000-0000-0000-0000-000000000002','88500000-0000-0000-0000-000000000002')) x(id,award);
INSERT INTO public.tournament_obligations(id,tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
SELECT '88800000-0000-0000-0000-000000000001','88000000-0000-0000-0000-000000000001','mystery_bounty',NULL,winner,5,5,'fn_mystery_bounty_pay',now() FROM held_fee_fixture.mystery_prefix_ids;
INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
SELECT 'mb:88500000-0000-0000-0000-000000000001:'||winner,winner,5 FROM held_fee_fixture.mystery_prefix_ids
UNION ALL SELECT 'mb-residual:88000000-0000-0000-0000-000000000001',winner,2 FROM held_fee_fixture.mystery_prefix_ids
UNION ALL SELECT 'tourney:88000000-0000-0000-0000-000000000001:obl:88800000-0000-0000-0000-000000000001:0',winner,5 FROM held_fee_fixture.mystery_prefix_ids;
INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
SELECT 'unrelated-prefix-fixture:'||n,winner,1 FROM held_fee_fixture.mystery_prefix_ids CROSS JOIN generate_series(1,50000) n;
ANALYZE public.wallet_credit_idempotency;
COMMIT;
