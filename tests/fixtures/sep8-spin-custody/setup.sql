-- Original records are lossless production exports. Only local account support
-- is synthetic. No finish, payout, canonical source or terminal is seeded.
CREATE SCHEMA sep8_spin_fixture;
CREATE TABLE sep8_spin_fixture.originals(document jsonb NOT NULL);
INSERT INTO sep8_spin_fixture.originals VALUES(:'sep8_originals'::jsonb);
CREATE TABLE sep8_spin_fixture.assertions(label text PRIMARY KEY);
CREATE FUNCTION sep8_spin_fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO sep8_spin_fixture.assertions VALUES(label);RAISE NOTICE 'PASS %',label;
END $$;
CREATE VIEW sep8_spin_fixture.cases AS SELECT
 (e->'tournament'->>'id')::uuid tournament_id,(e->'tournament'->>'club_id')::uuid club_id,
 (e->'tournament'->>'union_id')::uuid union_id,(e->'tournament'->>'prize_pool')::numeric prize,
 (e->'escrow'->>'fee_balance')::numeric fee,
 (SELECT (p->>'user_id')::uuid FROM jsonb_array_elements(e->'players') p WHERE p->>'status'='playing') winner_id,
 (SELECT (p->>'club_id')::uuid FROM jsonb_array_elements(e->'players') p WHERE p->>'status'='playing') winner_club_id,
 (SELECT (p->>'table_id')::uuid FROM jsonb_array_elements(e->'players') p WHERE p->>'status'='playing') table_id
 FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e;
CREATE FUNCTION sep8_spin_fixture.snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb:='{}';item jsonb;relation record;
BEGIN
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','smarter_private') AND c.relkind='r' ORDER BY n.nspname,c.relname LOOP
 EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',relation.nspname,relation.relname) INTO item;
 result:=result||jsonb_build_object(relation.nspname||'.'||relation.relname,item);
 END LOOP;RETURN result;
END $$;
SELECT sep8_spin_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres'
 AND NOT EXISTS(SELECT 1 FROM public.tournaments t JOIN sep8_spin_fixture.cases c ON c.tournament_id=t.id),
 'Exclusive local original scene');
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
 SELECT DISTINCT (p->>'user_id')::uuid,'sep8-'||(p->>'user_id')||'@example.invalid',false,false,now(),now()
 FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'players') p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username)
 SELECT DISTINCT (p->>'user_id')::uuid,'sep8_'||(p->>'user_id') FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'players') p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username,display_name)
 SELECT DISTINCT (p->>'user_id')::uuid,'sep8_'||(p->>'user_id'),'Local Original Spin Participant'
 FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'players') p ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury)
 SELECT club_id,999810+row_number() OVER(ORDER BY club_id),'Local Spin Support Club '||club_id,'10000000-0000-0000-0000-000000000001'::uuid,10000
 FROM (SELECT club_id FROM sep8_spin_fixture.cases UNION SELECT DISTINCT (p->>'club_id')::uuid
 FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'players') p) c ON CONFLICT(id) DO NOTHING;
INSERT INTO public.unions(id,name,owner_id,slug)
 SELECT DISTINCT union_id,'Local Original Spin Union '||union_id,'10000000-0000-0000-0000-000000000001'::uuid,'sep8-local-'||union_id FROM sep8_spin_fixture.cases WHERE union_id IS NOT NULL ON CONFLICT(id) DO NOTHING;
INSERT INTO public.union_wallets(union_id) SELECT DISTINCT union_id FROM sep8_spin_fixture.cases WHERE union_id IS NOT NULL ON CONFLICT(union_id) DO NOTHING;
INSERT INTO public.club_wallets(club_id) SELECT id FROM public.clubs ON CONFLICT(club_id) DO NOTHING;
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
 SELECT DISTINCT (p->>'club_id')::uuid,(p->>'user_id')::uuid,'player','active',0
 FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'players') p ON CONFLICT(club_id,user_id) DO NOTHING;
INSERT INTO public.tournaments SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_record(NULL::public.tournaments,e->'tournament') r;
INSERT INTO public.tournament_players SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.tournament_players,e->'players') r;
INSERT INTO public.rake_records SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.rake_records,e->'raw_fees') r;
INSERT INTO public.tournament_refund_entitlements SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.tournament_refund_entitlements,e->'entitlements') r;
INSERT INTO public.chip_ledger SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.chip_ledger,e->'ledger') r;
INSERT INTO public.spin_reserve_ledger SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.spin_reserve_ledger,e->'spin_reserve') r;
INSERT INTO public.managed_game_contract_versions SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_recordset(NULL::public.managed_game_contract_versions,e->'managed_contracts') r;
INSERT INTO public.tournament_escrow SELECT r.* FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_populate_record(NULL::public.tournament_escrow,e->'escrow') r;
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
 SELECT table_id,'Local Original Spin Table',tournament_id,'running','live',1,'tournament',club_id,'table:'||table_id,'tournament:'||tournament_id FROM sep8_spin_fixture.cases;
INSERT INTO public.table_seats(active_game_scope,active_parent_key,id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,club_id,occupancy_id)
 SELECT 'table:'||c.table_id,'tournament:'||c.tournament_id,md5('sep8-local-seat:'||c.tournament_id)::uuid,
 c.table_id,tp.seat_number,c.winner_id,tp.chips,'active',NULL,false,false,c.winner_club_id,md5('sep8-local-occupancy:'||c.tournament_id)::uuid
 FROM sep8_spin_fixture.cases c JOIN public.tournament_players tp ON tp.tournament_id=c.tournament_id AND tp.user_id=c.winner_id;
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT sep8_spin_fixture.assert(current_setting('session_replication_role')='origin'
 AND (SELECT count(*)=5 AND sum(fee_balance)=11.52 AND sum(prize_balance)=96 FROM public.tournament_escrow JOIN sep8_spin_fixture.cases USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements JOIN sep8_spin_fixture.cases USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources JOIN sep8_spin_fixture.cases USING(tournament_id)),
 'Five originals retain96 prizes and11.52 fees without seeded success');
