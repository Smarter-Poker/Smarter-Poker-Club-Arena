-- PRIVATE NATIVE FIXTURE ONLY: run after setup.sql + positive-opening.sql.
-- These are the three explicitly authorized PKOs, not a wider legacy cohort.
-- Fees, existing canonical sources/batches, admission debits, entitlement
-- identities and original scope documents are lossless PostgreSQL exports.
-- Standings, champion accounts and the unspent opening prize/bounty banks are
-- SYNTHETIC. No historical agreement, payout, recognition or bounty receipt is
-- invented. The actual terminal and bounty owners must produce every payment.
-- The runner supplies raw dollar-quoted JSON through these psql variables;
-- never parse/reserialize their original numeric values through a float codec.
BEGIN;
SELECT legacy_fee_fixture.assert(current_database()='postgres'
 AND current_user='postgres' AND inet_server_addr() IS NULL
 AND (SELECT count(*)=5 FROM legacy_fee_fixture.cases)
 AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id IN
 ('1ffbd637-9241-4957-902f-3a75e09892c0','8fc76450-534a-4877-97b5-8f784a3d5daa',
  '2421c66f-6f02-40a2-8414-23379802ce23')),
 'Three PKO openings run only in the existing private unclosed five-case scene');

CREATE TABLE legacy_fee_fixture.pko_original_fees(document jsonb NOT NULL);
CREATE TABLE legacy_fee_fixture.pko_original_canonical(document jsonb NOT NULL);
CREATE TABLE legacy_fee_fixture.pko_original_funding(document jsonb NOT NULL);
INSERT INTO legacy_fee_fixture.pko_original_fees VALUES(:'legacy_pko_original_fees'::jsonb);
INSERT INTO legacy_fee_fixture.pko_original_canonical VALUES(:'legacy_pko_original_canonical'::jsonb);
INSERT INTO legacy_fee_fixture.pko_original_funding VALUES(:'legacy_pko_original_funding'::jsonb);
-- The captured full schema omits this original authority's registry data.
-- Exact production row read in READ ONLY mode at 2026-09-18T09:41:56Z.
-- The real obligation payer must admit the real finalizer by its registered
-- name; neither a fabricated adjustment nor an engine.* alias is equivalent.
INSERT INTO public.ca_settle_sources(source,note,added_at) VALUES
 ('fn_finalize_bounty_pool',
  'Platform bounty residual authority, invoked inside fn_complete_tournament_terminal.',
  '2026-09-05T20:33:01.099866Z') ON CONFLICT(source) DO NOTHING;
SELECT legacy_fee_fixture.assert(EXISTS(SELECT 1 FROM public.ca_settle_sources
 WHERE source='fn_finalize_bounty_pool'
 AND note='Platform bounty residual authority, invoked inside fn_complete_tournament_terminal.'
 AND added_at='2026-09-05T20:33:01.099866Z'::timestamptz),
 'Original registered bounty finalizer is admitted by the unchanged obligation payer');
CREATE TABLE legacy_fee_fixture.pko_expected_sources(
 tournament_id uuid PRIMARY KEY,source_count integer NOT NULL,
 fee_amount numeric NOT NULL,source_fingerprint text NOT NULL);
INSERT INTO legacy_fee_fixture.pko_expected_sources VALUES
 ('1ffbd637-9241-4957-902f-3a75e09892c0',85,127.50,'53fd19518004de9991312c0aaa749705'),
 ('8fc76450-534a-4877-97b5-8f784a3d5daa',85,127.50,'87fd65baf92f74a1de5c85ed09844c62'),
 ('2421c66f-6f02-40a2-8414-23379802ce23',46,69.00,'0dd99b682fed61573e47a2e0f8e57ab8');
SELECT legacy_fee_fixture.assert(
 (SELECT array_agg(key::uuid ORDER BY key::uuid) FROM legacy_fee_fixture.pko_original_fees,
  jsonb_object_keys(document) key)=
 (SELECT array_agg(tournament_id ORDER BY tournament_id) FROM legacy_fee_fixture.pko_expected_sources)
 AND (SELECT jsonb_array_length(document->'batches')=109
  AND jsonb_array_length(document->'sources')=109 FROM legacy_fee_fixture.pko_original_canonical)
 AND (SELECT jsonb_array_length(document->'entitlements')=216
  AND jsonb_array_length(document->'registrations')=216
  AND jsonb_array_length(document->'ledgers')=216
  AND jsonb_array_length(document->'original_charge_links')=216
  FROM legacy_fee_fixture.pko_original_funding),
 'Exact three PKO input documents contain216 original admissions and109 existing captures');

ALTER TABLE legacy_fee_fixture.cases ADD COLUMN bounty_amount numeric NOT NULL DEFAULT 0;
INSERT INTO legacy_fee_fixture.cases
 (tournament_id,winner_id,fee_amount,prize_amount,table_id,club_id,bounty_amount)
 SELECT t.id,md5('legacy-custody-winner:'||t.id::text)::uuid,c.fee_amount,
 (SELECT sum(e.refund_prize) FROM legacy_fee_fixture.pko_original_funding d,
  jsonb_populate_recordset(NULL::public.tournament_refund_entitlements,d.document->'entitlements')e
  WHERE e.tournament_id=t.id),md5('legacy-custody-table:'||t.id::text)::uuid,t.club_id,
 (SELECT sum(e.refund_bounty) FROM legacy_fee_fixture.pko_original_funding d,
  jsonb_populate_recordset(NULL::public.tournament_refund_entitlements,d.document->'entitlements')e
  WHERE e.tournament_id=t.id)
 FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.tournaments,d.document->'tournaments')t
 JOIN legacy_fee_fixture.pko_expected_sources c ON c.tournament_id=t.id;

-- Opening import only. All actual close calls run with every trigger enabled.
SET LOCAL session_replication_role=replica;
CREATE TABLE legacy_fee_fixture.pko_synthetic_standings AS
 SELECT p.*,row_number() OVER(PARTITION BY p.tournament_id ORDER BY p.id)::integer AS fixture_ordinal,
 count(*) OVER(PARTITION BY p.tournament_id)::integer AS fixture_field_count
 FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.tournament_players,d.document->'registrations')p;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
 SELECT user_id,'pko-original-'||user_id||'@example.invalid',false,false,now(),now()
 FROM (SELECT user_id FROM legacy_fee_fixture.pko_synthetic_standings
  UNION SELECT c.winner_id FROM legacy_fee_fixture.cases c
   JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))u
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username)
 SELECT id,'pko_'||md5(id::text) FROM auth.users
 WHERE id IN(SELECT user_id FROM legacy_fee_fixture.pko_synthetic_standings
  UNION SELECT c.winner_id FROM legacy_fee_fixture.cases c
   JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username,display_name)
 SELECT id,username,'Synthetic PKO Fixture Player' FROM public.users
 WHERE id IN(SELECT user_id FROM legacy_fee_fixture.pko_synthetic_standings
  UNION SELECT c.winner_id FROM legacy_fee_fixture.cases c
   JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 ON CONFLICT(id) DO NOTHING;

INSERT INTO public.clubs
 SELECT (jsonb_populate_record(NULL::public.clubs,to_jsonb(template)||jsonb_build_object(
 'id',c.club_id,'club_id',999880+row_number() OVER(ORDER BY c.club_id),
 'name','Synthetic PKO Funding Club '||c.club_id,'chip_treasury',0))).*
 FROM (SELECT club_id FROM legacy_fee_fixture.pko_synthetic_standings
  UNION SELECT c.club_id FROM legacy_fee_fixture.cases c
   JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))c
 CROSS JOIN public.clubs template WHERE template.id='fade0000-0000-0000-0000-000000000001'
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.club_wallets(club_id)
 SELECT club_id FROM legacy_fee_fixture.pko_synthetic_standings
 UNION SELECT c.club_id FROM legacy_fee_fixture.cases c
  JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id)
 ON CONFLICT(club_id) DO NOTHING;
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at,created_at,is_prepaid)
 SELECT club_id,user_id,'player','active',0,'2026-09-01T00:00:00Z'::timestamptz,
 '2026-09-01T00:00:00Z'::timestamptz,true FROM
 (SELECT club_id,user_id FROM legacy_fee_fixture.pko_synthetic_standings
  UNION SELECT c.club_id,c.winner_id FROM legacy_fee_fixture.cases c
   JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))m
 ON CONFLICT(club_id,user_id) DO NOTHING;

-- Preserve original host/Union/private/game identity. Only this isolated
-- opening scene's game progress, payout structure and unspent banks change.
INSERT INTO public.tournaments
 SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'name','Synthetic PKO Custody '||t.id,'status','RUNNING','current_players',1,
 'ended_at',NULL,'current_level',1,'total_rake',c.fee_amount,
 'prize_pool',c.prize_amount,'guaranteed_prize',0,'prize_pool_finalized',false,
 'bounty_pool',c.bounty_amount,'bounty_pool_paid',0,
 'is_bounty',true,'is_pko',true,'is_mystery_bounty',false,
 'starting_chips',1000,'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
 'bubble_protection',false,'synchronized_breaks',false,'on_break',false,
 'break_started_at',NULL,'break_ends_at',NULL,'terminal_closed_at',NULL,
 'blind_structure','[{"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":10}]'))).*
 FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.tournaments,d.document->'tournaments')t
 JOIN legacy_fee_fixture.cases c ON c.tournament_id=t.id;
INSERT INTO public.tournament_players
 SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(p)||jsonb_build_object(
 'chips',0,'status','eliminated','position',p.fixture_ordinal+1,'prize',0,
 'table_id',NULL,'seat_number',NULL,'current_bounty',0,'bounty_winnings',0,
 'mystery_bounty_value',0,'eliminated_at',p.registered_at+interval '1 minute',
 'elimination_sequence',p.fixture_field_count-p.fixture_ordinal+1,'terminal_closed_at',NULL))).*
 FROM legacy_fee_fixture.pko_synthetic_standings p;
INSERT INTO public.tournament_players
 SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(template)||jsonb_build_object(
 'id',md5('legacy-pko-champion:'||c.tournament_id::text)::uuid,
 'tournament_id',c.tournament_id,'user_id',c.winner_id,'username','synthetic_pko_champion',
 'club_id',c.club_id,'registered_at','2026-09-01T00:00:00Z',
 'chips',(s.source_count+1)*1000,'status','playing','position',NULL,'prize',0,
 'table_id',c.table_id,'seat_number',1,'current_bounty',c.bounty_amount,
 'bounty_winnings',0,'mystery_bounty_value',0,'eliminated_at',NULL,
 'elimination_sequence',NULL,'terminal_closed_at',NULL))).*
 FROM public.tournament_players template CROSS JOIN legacy_fee_fixture.cases c
 JOIN legacy_fee_fixture.pko_expected_sources s ON s.tournament_id=c.tournament_id
 WHERE template.id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,
 club_id,seat_game_scope,seat_admission_key)
 SELECT c.table_id,'Synthetic PKO Custody Final Table',c.tournament_id,'running','live',1,
 'tournament',c.club_id,'table:'||c.table_id,'tournament:'||c.tournament_id
 FROM legacy_fee_fixture.cases c JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id);
INSERT INTO public.table_seats(active_game_scope,active_parent_key,id,table_id,seat_number,user_id,
 stack,status,left_at,leave_pending,is_sitting_out,club_id,occupancy_id)
 SELECT 'table:'||c.table_id,'tournament:'||c.tournament_id,
 md5('legacy-pko-seat:'||c.tournament_id::text)::uuid,c.table_id,1,c.winner_id,
 (s.source_count+1)*1000,'active',NULL,false,false,c.club_id,
 md5('legacy-pko-occupancy:'||c.tournament_id::text)::uuid
 FROM legacy_fee_fixture.cases c JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id);
INSERT INTO public.tournament_escrow(tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
 overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,
 reserve_out,reserve_in,prize_balance,bounty_balance,fee_balance,opened_from,enforced)
 SELECT c.tournament_id,c.prize_amount+c.bounty_amount+c.fee_amount,c.fee_amount,0,c.bounty_amount,
 0,0,0,0,0,0,0,0,0,0,c.prize_amount,c.bounty_amount,c.fee_amount,
 'synthetic-unspent-PKO-opening-from-original-entry-splits',true
 FROM legacy_fee_fixture.cases c JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id);

-- Import every original financial document without modifying its fields.
INSERT INTO public.rake_records
 SELECT r.* FROM legacy_fee_fixture.pko_original_fees d,jsonb_each(d.document)g,
 jsonb_populate_recordset(NULL::public.rake_records,g.value)r;
INSERT INTO public.chip_ledger
 SELECT l.* FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.chip_ledger,d.document->'ledgers')l;
INSERT INTO public.tournament_refund_entitlements
 SELECT e.* FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.tournament_refund_entitlements,d.document->'entitlements')e;
INSERT INTO public.managed_game_contract_versions
 SELECT v.* FROM legacy_fee_fixture.pko_original_funding d,
 jsonb_populate_recordset(NULL::public.managed_game_contract_versions,d.document->'managed_contracts')v;
INSERT INTO public.accounting_tournament_fee_batches
 SELECT b.* FROM legacy_fee_fixture.pko_original_canonical d,
 jsonb_populate_recordset(NULL::public.accounting_tournament_fee_batches,d.document->'batches')b;
INSERT INTO public.accounting_tournament_fee_sources
 SELECT s.* FROM legacy_fee_fixture.pko_original_canonical d,
 jsonb_populate_recordset(NULL::public.accounting_tournament_fee_sources,d.document->'sources')s;
SET LOCAL session_replication_role=origin;
COMMIT;

SELECT legacy_fee_fixture.assert((SELECT count(*)=8 FROM legacy_fee_fixture.cases)
 AND (SELECT sum(c.fee_amount)=324 AND sum(c.prize_amount)=1188 AND sum(c.bounty_amount)=1728
  FROM legacy_fee_fixture.cases c JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM legacy_fee_fixture.pko_expected_sources e WHERE
  (SELECT count(*) FROM public.rake_records r WHERE r.tournament_id=e.tournament_id AND r.is_tournament)<>e.source_count
  OR (SELECT sum(r.rake_amount) FROM public.rake_records r WHERE r.tournament_id=e.tournament_id AND r.is_tournament)<>e.fee_amount
  OR (SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),''))
   FROM public.rake_records r WHERE r.tournament_id=e.tournament_id AND r.is_tournament)<>e.source_fingerprint)
 AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts p JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements h JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 AND current_setting('session_replication_role')='origin',
 'Three exact PKO fees total324; real original owners must pay1188 prize and1728 bounty before custody');
SELECT legacy_fee_fixture.assert(
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.tournament_id,b.rake_record_id)
  FROM public.accounting_tournament_fee_batches b JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 IS NOT DISTINCT FROM (SELECT document->'batches' FROM legacy_fee_fixture.pko_original_canonical)
 AND (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.tournament_id,f.id)
  FROM public.accounting_tournament_fee_sources f JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 IS NOT DISTINCT FROM (SELECT document->'sources' FROM legacy_fee_fixture.pko_original_canonical),
 'All109 existing PKO canonical batches and sources retain their exact original documents');
