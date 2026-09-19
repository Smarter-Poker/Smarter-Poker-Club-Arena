-- Lossless original100 registrations, fee/funding/credit evidence and escrow.
-- Only account shells, zero opening wallets and table support are synthetic.
-- No payout, earning terms, recognition or completed receipt is seeded.
CREATE SCHEMA earlybird_fee_fixture;
CREATE TABLE earlybird_fee_fixture.assertions(label text PRIMARY KEY);
CREATE FUNCTION earlybird_fee_fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label;END IF;
 INSERT INTO earlybird_fee_fixture.assertions VALUES(label);RAISE NOTICE 'PASS %',label;
END $$;
CREATE TABLE earlybird_fee_fixture.original_fee_document(document jsonb);
INSERT INTO earlybird_fee_fixture.original_fee_document VALUES(:'earlybird_originals'::jsonb);
CREATE TABLE earlybird_fee_fixture.funding(document jsonb);
INSERT INTO earlybird_fee_fixture.funding VALUES(:'earlybird_funding'::jsonb);
CREATE TABLE earlybird_fee_fixture.paid(document jsonb);
INSERT INTO earlybird_fee_fixture.paid VALUES(:'earlybird_paid'::jsonb);
CREATE TABLE earlybird_fee_fixture.credits(document jsonb);
INSERT INTO earlybird_fee_fixture.credits VALUES(:'earlybird_credits'::jsonb);
CREATE VIEW earlybird_fee_fixture.cases AS SELECT
 (t->>'id')::uuid tournament_id,(t->>'club_id')::uuid club_id,
 (t->>'prize_pool')::numeric prize_amount,2.70::numeric fee_amount,
 (p->>'user_id')::uuid winner_id,(p->>'table_id')::uuid table_id
 FROM earlybird_fee_fixture.funding f,earlybird_fee_fixture.paid d,
 LATERAL(SELECT f.document->'tournament' t)q,jsonb_array_elements(d.document->'players')p WHERE p->>'status'='playing';
CREATE FUNCTION earlybird_fee_fixture.snapshot(p_tournament_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb:='{}';item jsonb;relation record;BEGIN
 IF NOT EXISTS(SELECT 1 FROM earlybird_fee_fixture.cases WHERE tournament_id=p_tournament_id) THEN RAISE EXCEPTION 'Unknown local event';END IF;
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','smarter_private') AND c.relkind='r' ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',relation.nspname,relation.relname) INTO item;
  result:=result||jsonb_build_object(relation.nspname||'.'||relation.relname,item);
 END LOOP;RETURN result;
END $$;
SELECT earlybird_fee_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres'
 AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'),'Private native original event absent');
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
 SELECT DISTINCT (p->>'user_id')::uuid,'earlybird-'||(p->>'user_id')||'@example.invalid',false,false,now(),now()
 FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username)
 SELECT DISTINCT (p->>'user_id')::uuid,'eb_'||(p->>'user_id') FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username,display_name)
 SELECT DISTINCT (p->>'user_id')::uuid,'eb_'||(p->>'user_id'),'Synthetic Original Early Bird Account'
 FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury)
 SELECT club_id,999910+row_number() OVER(ORDER BY club_id),'Synthetic Early Bird Support Club '||club_id,'10000000-0000-0000-0000-000000000001',0
 FROM(SELECT club_id FROM earlybird_fee_fixture.cases UNION SELECT DISTINCT (p->>'club_id')::uuid FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p)c ON CONFLICT(id) DO NOTHING;
INSERT INTO public.club_wallets(club_id) SELECT id FROM public.clubs ON CONFLICT(club_id) DO NOTHING;
INSERT INTO public.unions(id,name,owner_id,slug) VALUES('fade0000-0000-0000-0000-000000000001','Synthetic Early Bird Union','10000000-0000-0000-0000-000000000001','earlybird-native');
INSERT INTO public.union_wallets(union_id) VALUES('fade0000-0000-0000-0000-000000000001');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
 SELECT DISTINCT (p->>'club_id')::uuid,(p->>'user_id')::uuid,'player','active',0 FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p ON CONFLICT(club_id,user_id) DO NOTHING;
INSERT INTO public.tournaments SELECT r.* FROM earlybird_fee_fixture.funding f,jsonb_populate_record(NULL::public.tournaments,f.document->'tournament')r;
INSERT INTO public.tournament_players SELECT r.* FROM earlybird_fee_fixture.paid d,jsonb_populate_recordset(NULL::public.tournament_players,d.document->'players')r;
INSERT INTO public.tournament_escrow SELECT r.* FROM earlybird_fee_fixture.funding f,jsonb_populate_record(NULL::public.tournament_escrow,f.document->'escrow')r;
INSERT INTO public.rake_records SELECT r.* FROM earlybird_fee_fixture.original_fee_document d,jsonb_populate_recordset(NULL::public.rake_records,d.document->'original_fees')r;
INSERT INTO public.tournament_refund_entitlements SELECT r.* FROM earlybird_fee_fixture.original_fee_document d,jsonb_populate_recordset(NULL::public.tournament_refund_entitlements,d.document->'original_funding')r;
INSERT INTO public.chip_ledger SELECT r.* FROM earlybird_fee_fixture.funding d,jsonb_populate_recordset(NULL::public.chip_ledger,d.document->'funding_ledger')r;
INSERT INTO public.chip_ledger SELECT r.* FROM earlybird_fee_fixture.paid d,jsonb_populate_recordset(NULL::public.chip_ledger,d.document->'chip_ledger')r;
INSERT INTO public.wallet_transactions SELECT r.* FROM earlybird_fee_fixture.paid d,jsonb_populate_recordset(NULL::public.wallet_transactions,d.document->'wallet_transactions')r;
INSERT INTO public.wallet_credit_idempotency SELECT r.* FROM earlybird_fee_fixture.credits d,jsonb_populate_recordset(NULL::public.wallet_credit_idempotency,d.document->'credit_keys')r;
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
 SELECT table_id,'Synthetic Early Bird Table Support',tournament_id,'running','live',1,'tournament',club_id,'table:'||table_id,'tournament:'||tournament_id FROM earlybird_fee_fixture.cases;
INSERT INTO public.table_seats(active_game_scope,active_parent_key,id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,club_id,occupancy_id)
 SELECT 'table:'||c.table_id,'tournament:'||c.tournament_id,md5('earlybird-native-seat')::uuid,c.table_id,p.seat_number,p.user_id,p.chips,'active',NULL,false,false,p.club_id,md5('earlybird-native-occupancy')::uuid
 FROM earlybird_fee_fixture.cases c JOIN public.tournament_players p ON p.tournament_id=c.tournament_id AND p.user_id=c.winner_id;
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT earlybird_fee_fixture.assert((SELECT count(*)=27 AND sum(rake_amount)=2.70
 AND md5(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY id))='aab06c68bd63b23b2b7340bd55f43e44' FROM public.rake_records r WHERE tournament_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'), 'All27 lossless original fee rows match installed fingerprint');
SELECT earlybird_fee_fixture.assert((SELECT count(*)=100 AND sum(prize)=71.45 FROM public.tournament_players WHERE tournament_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd')
 AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd')
 AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE related_entity_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd' AND category='prize')
 AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key LIKE '%a5aa6984-6c1c-4b59-aeb7-9e7878853bdd%' AND amount>0), 'Original100 standings retain71.45 cache but no fabricated credit receipt');
