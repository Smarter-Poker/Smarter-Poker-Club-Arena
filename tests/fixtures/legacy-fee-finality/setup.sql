-- Disposable native opening scene. Exact retained original raw fees are input
-- via psql variable legacy_original_fees from original-fees.json. Accounts,
-- standings and prize custody are SYNTHETIC and do not certify live outcomes.
-- No payout, claim, bank, fee source, recognition or terminal receipt is seeded.
CREATE SCHEMA legacy_fee_fixture;
CREATE FUNCTION legacy_fee_fixture.assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO legacy_fee_fixture.assertions VALUES(label);
 RAISE NOTICE 'PASS %',label;
END $$;
CREATE TABLE legacy_fee_fixture.assertions(label text PRIMARY KEY);
CREATE TABLE legacy_fee_fixture.cases(tournament_id uuid PRIMARY KEY,winner_id uuid NOT NULL,
 fee_amount numeric NOT NULL,prize_amount numeric NOT NULL,table_id uuid NOT NULL);
INSERT INTO legacy_fee_fixture.cases
 SELECT id,md5('legacy-custody-winner:'||id::text)::uuid,fee,10,
  md5('legacy-custody-table:'||id::text)::uuid
 FROM (VALUES
 ('2d2319d4-09e4-4921-85f3-09832ca7f9da'::uuid,54::numeric),
 ('7834a033-8bf0-4a6b-bccf-9f4f6e78a9b9'::uuid,120::numeric),
 ('80443725-b71c-4fc6-bc09-ceaf650809b3'::uuid,54::numeric),
 ('b1fdf860-2fdd-40da-8fff-ef37e650ddc8'::uuid,120::numeric),
 ('f370585d-40ea-4085-bb8f-c7e8c74f3fb4'::uuid,17::numeric)) c(id,fee);
CREATE TABLE legacy_fee_fixture.original_fee_document(document jsonb NOT NULL);
INSERT INTO legacy_fee_fixture.original_fee_document VALUES(:'legacy_original_fees'::jsonb);
CREATE FUNCTION legacy_fee_fixture.snapshot(p_tournament_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE result jsonb:='{}'::jsonb; item jsonb; table_name text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_fee_fixture.cases WHERE tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'Unknown synthetic custody case'; END IF;
 -- Whole-public snapshots also detect collateral effects on shared banks,
 -- recipients, supply, or unrelated events. Fixture observation rows are
 -- outside public and do not masquerade as product state.
 FOR table_name IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname
 LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',table_name) INTO item;
  result:=result||jsonb_build_object(table_name,item);
 END LOOP;
 RETURN result;
END $$;
SELECT legacy_fee_fixture.assert(current_database()='postgres' AND current_user='postgres'
 AND inet_server_addr() IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.tournaments t JOIN legacy_fee_fixture.cases c ON c.tournament_id=t.id),
 'Exclusive local baseline has none of the five named events');
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
 SELECT winner_id,'custody-'||tournament_id||'@example.invalid',false,false,now(),now()
 FROM legacy_fee_fixture.cases
 UNION ALL
 SELECT md5('legacy-custody-loser:'||tournament_id::text)::uuid,
 'custody-loser-'||tournament_id||'@example.invalid',false,false,now(),now() FROM legacy_fee_fixture.cases;
INSERT INTO public.users(id,username)
 SELECT winner_id,'custody_w_'||left(tournament_id::text,12) FROM legacy_fee_fixture.cases
 UNION ALL SELECT md5('legacy-custody-loser:'||tournament_id::text)::uuid,
 'custody_l_'||left(tournament_id::text,12) FROM legacy_fee_fixture.cases;
INSERT INTO public.profiles(id,username,display_name)
 SELECT winner_id,'custody_w_'||left(tournament_id::text,12),'Synthetic Custody Winner' FROM legacy_fee_fixture.cases
 UNION ALL SELECT md5('legacy-custody-loser:'||tournament_id::text)::uuid,
 'custody_l_'||left(tournament_id::text,12),'Synthetic Custody Loser' FROM legacy_fee_fixture.cases;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury)
 VALUES('fade0000-0000-0000-0000-000000000001',999783,'Synthetic Original Fee Custody Club',
 '10000000-0000-0000-0000-000000000001',1000) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.club_wallets(club_id) VALUES('fade0000-0000-0000-0000-000000000001') ON CONFLICT(club_id) DO NOTHING;
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
 SELECT 'fade0000-0000-0000-0000-000000000001'::uuid,winner_id,'player','active',0 FROM legacy_fee_fixture.cases
 UNION ALL SELECT 'fade0000-0000-0000-0000-000000000001'::uuid,
 md5('legacy-custody-loser:'||tournament_id::text)::uuid,'player','active',0 FROM legacy_fee_fixture.cases;
INSERT INTO public.tournaments
 SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'id',c.tournament_id,'name','Synthetic Legacy Fee Finality '||c.tournament_id,
 'club_id','fade0000-0000-0000-0000-000000000001','union_id',NULL,'is_private',false,
 'buy_in_amount',5,'buy_in_fee',0,'variant','nlh','tournament_type','MTT',
 'blind_structure','[{"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":10}]',
 'starting_chips',1000,'prize_pool',c.prize_amount,'guaranteed_prize',0,
 'prize_pool_finalized',false,'bubble_protection',false,
 'status','RUNNING','current_players',1,'ended_at',NULL,
 'synchronized_breaks',false,'on_break',false,
 'bounty_pool',0,'bounty_pool_paid',0,'total_rake',c.fee_amount,
 'is_bounty',false,'is_pko',false,'is_mystery_bounty',false,
 'payout_structure','[{"place":1,"percentage":100}]'::jsonb))).*
 FROM public.tournaments t CROSS JOIN legacy_fee_fixture.cases c
 WHERE t.id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players
 SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object(
 'id',md5('legacy-custody-player:'||c.tournament_id::text||':'||g.n)::uuid,
 'tournament_id',c.tournament_id,
 'user_id',CASE WHEN g.n=1 THEN c.winner_id ELSE md5('legacy-custody-loser:'||c.tournament_id::text)::uuid END,
 'username','synthetic_custody_'||g.n,'club_id','fade0000-0000-0000-0000-000000000001',
 'table_id',CASE WHEN g.n=1 THEN c.table_id ELSE NULL END,
 'seat_number',CASE WHEN g.n=1 THEN 1 ELSE NULL END,
 'chips',CASE WHEN g.n=1 THEN 2000 ELSE 0 END,
 'status',CASE WHEN g.n=1 THEN 'playing' ELSE 'eliminated' END,
 'position',CASE WHEN g.n=1 THEN NULL ELSE 2 END,'prize',0,
 'eliminated_at',CASE WHEN g.n=1 THEN NULL ELSE now()-interval '1 minute' END,
 'elimination_sequence',CASE WHEN g.n=1 THEN NULL ELSE 1 END,
 'current_bounty',0,'bounty_winnings',0,'mystery_bounty_value',0))).*
 FROM public.tournament_players tp CROSS JOIN legacy_fee_fixture.cases c CROSS JOIN generate_series(1,2) g(n)
 WHERE tp.id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_escrow
 SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(e)||jsonb_build_object(
 'tournament_id',c.tournament_id,'gross_in',c.prize_amount+c.fee_amount,
 'fee_entries_in',c.fee_amount,'satellite_fee_in',0,'bounty_in',0,
 'overlay_in',0,'satellite_in',0,'prize_out',0,'bounty_out',0,'fee_out',0,
 'refund_prize',0,'refund_bounty',0,'refund_fee',0,'reserve_out',0,'reserve_in',0,
 'prize_balance',c.prize_amount,'bounty_balance',0,'fee_balance',c.fee_amount,
 'closed_at',NULL,'close_note',NULL,'opened_from','synthetic-legacy-fee-custody'))).*
 FROM public.tournament_escrow e CROSS JOIN legacy_fee_fixture.cases c
 WHERE e.tournament_id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
 SELECT table_id,'Synthetic Custody Final Table',tournament_id,'running','live',1,'tournament',
 'fade0000-0000-0000-0000-000000000001','table:'||table_id,'tournament:'||tournament_id FROM legacy_fee_fixture.cases;
INSERT INTO public.table_seats(active_game_scope,active_parent_key,id,table_id,seat_number,user_id,stack,status,left_at,
 leave_pending,is_sitting_out,club_id,occupancy_id)
 SELECT 'table:'||table_id,'tournament:'||tournament_id,md5('legacy-custody-seat:'||tournament_id::text)::uuid,
 table_id,1,winner_id,2000,'active',NULL,false,false,'fade0000-0000-0000-0000-000000000001',
 md5('legacy-custody-occupancy:'||tournament_id::text)::uuid FROM legacy_fee_fixture.cases;
-- Retain captured raw fee rows byte-for-byte, including their original IDs,
-- timestamps and manifests. Replica mode is confined to this opening fixture.
INSERT INTO public.rake_records
 SELECT r.* FROM legacy_fee_fixture.original_fee_document d,
 jsonb_each(d.document) e,
 jsonb_populate_recordset(NULL::public.rake_records,e.value) r;
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT legacy_fee_fixture.assert(current_setting('session_replication_role')='origin'
 AND (SELECT count(*) FROM public.rake_records r JOIN legacy_fee_fixture.cases c ON c.tournament_id=r.tournament_id)=302
 AND (SELECT sum(r.rake_amount) FROM public.rake_records r JOIN legacy_fee_fixture.cases c ON c.tournament_id=r.tournament_id)=365
 AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts p JOIN legacy_fee_fixture.cases c USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements p JOIN legacy_fee_fixture.cases c USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements p JOIN legacy_fee_fixture.cases c USING(tournament_id)),
 'Exact original302 fees total365 with live guards and no seeded success or payer');
