-- LOCAL SYNTHETIC EVIDENCE ONLY. Run after setup.sql and before any finish.
-- Raw fee rows remain exact captured inputs. Every funding/account/standing/
-- agreement below is synthetic test data, never historical production proof.
-- The actual capture authority must later create all batches and source rows.
BEGIN;
SELECT legacy_fee_fixture.assert(inet_server_addr() IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements h JOIN legacy_fee_fixture.cases c USING(tournament_id)),
 'Positive continuation fixture starts only on the private unclosed native scene');
SET LOCAL session_replication_role=replica;
CREATE TABLE legacy_fee_fixture.synthetic_original_charges AS
 SELECT r.id AS rake_record_id,r.tournament_id,r.club_id,
 (r.metadata->>'user_id')::uuid AS user_id,
 (r.metadata->>'registration_id')::uuid AS registration_id,
 r.created_at AS charged_at,r.rake_amount,
 md5('custody-local-original-debit:'||r.id::text)::uuid AS ledger_id,
 md5('custody-local-original-entitlement:'||r.id::text)::uuid AS entitlement_id,
 row_number() OVER(PARTITION BY r.tournament_id ORDER BY r.id)::integer AS ordinal,
 count(*) OVER(PARTITION BY r.tournament_id)::integer AS field_count,
 -- Independent whole-cent allocation of the synthetic opening prize bank.
 (floor(c.prize_amount*100/count(*) OVER(PARTITION BY r.tournament_id))
  + CASE WHEN row_number() OVER(PARTITION BY r.tournament_id ORDER BY r.id)
   <= mod((c.prize_amount*100)::integer,count(*) OVER(PARTITION BY r.tournament_id)::integer)
  THEN 1 ELSE 0 END)/100 AS synthetic_prize
 FROM public.rake_records r JOIN legacy_fee_fixture.cases c ON c.tournament_id=r.tournament_id;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
 SELECT DISTINCT user_id,'synthetic-original-'||user_id||'@example.invalid',false,false,
 '2026-09-01T00:00:00Z'::timestamptz,'2026-09-01T00:00:00Z'::timestamptz
 FROM legacy_fee_fixture.synthetic_original_charges ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username)
 SELECT DISTINCT user_id,'lf_'||md5(user_id::text)
 FROM legacy_fee_fixture.synthetic_original_charges ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username,display_name)
 SELECT DISTINCT user_id,'lf_'||md5(user_id::text),'Synthetic Original Fee Contributor'
 FROM legacy_fee_fixture.synthetic_original_charges ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs
 SELECT (jsonb_populate_record(NULL::public.clubs,to_jsonb(template)||jsonb_build_object(
  'id',c.club_id,'club_id',999850+row_number() OVER(ORDER BY c.club_id),
  'name','Synthetic Original Funding Club '||c.club_id,'chip_treasury',0))).*
 FROM (SELECT DISTINCT club_id FROM legacy_fee_fixture.synthetic_original_charges) c
 CROSS JOIN public.clubs template WHERE template.id='fade0000-0000-0000-0000-000000000001'
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.club_wallets(club_id) SELECT DISTINCT club_id FROM legacy_fee_fixture.synthetic_original_charges
 ON CONFLICT(club_id) DO NOTHING;
ALTER TABLE legacy_fee_fixture.cases ADD COLUMN club_id uuid;
UPDATE legacy_fee_fixture.cases c SET club_id=q.club_id FROM
 (SELECT DISTINCT tournament_id,club_id FROM legacy_fee_fixture.synthetic_original_charges)q WHERE c.tournament_id=q.tournament_id;
UPDATE public.tournaments t SET club_id=c.club_id FROM legacy_fee_fixture.cases c WHERE t.id=c.tournament_id;
UPDATE public.tournament_players t SET club_id=c.club_id FROM legacy_fee_fixture.cases c WHERE t.tournament_id=c.tournament_id;
UPDATE public.tables t SET club_id=c.club_id FROM legacy_fee_fixture.cases c WHERE t.tournament_id=c.tournament_id;
UPDATE public.table_seats s SET club_id=c.club_id FROM legacy_fee_fixture.cases c WHERE s.table_id=c.table_id;
UPDATE public.club_members m SET club_id=c.club_id FROM legacy_fee_fixture.cases c
 WHERE m.club_id='fade0000-0000-0000-0000-000000000001'
 AND m.user_id IN(c.winner_id,md5('legacy-custody-loser:'||c.tournament_id::text)::uuid);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at,created_at,is_prepaid)
 SELECT DISTINCT club_id,user_id,'player','active',0,'2026-09-01T00:00:00Z'::timestamptz,
 '2026-09-01T00:00:00Z'::timestamptz,true
 FROM legacy_fee_fixture.synthetic_original_charges ON CONFLICT(club_id,user_id) DO NOTHING;
UPDATE public.tournament_players tp SET elimination_sequence=q.n+1
 FROM (SELECT tournament_id,count(*) n FROM legacy_fee_fixture.synthetic_original_charges GROUP BY tournament_id)q
 WHERE tp.tournament_id=q.tournament_id AND tp.position=2;
INSERT INTO public.tournament_players
 SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object(
 'id',c.registration_id,'tournament_id',c.tournament_id,'user_id',c.user_id,
 'username','synthetic_original_'||c.ordinal,'club_id',c.club_id,
 'registered_at',c.charged_at,'table_id',NULL,'seat_number',NULL,
 'chips',0,'status','eliminated','position',c.ordinal+2,'prize',0,
 'eliminated_at',c.charged_at+interval '1 minute','elimination_sequence',c.field_count-c.ordinal+1,
 'current_bounty',0,'bounty_winnings',0,'mystery_bounty_value',0))).*
 FROM public.tournament_players tp CROSS JOIN legacy_fee_fixture.synthetic_original_charges c
 WHERE tp.id='31000000-0000-0000-0000-000000000001';
-- Retain a consistent synthetic final field and full chip stack. Existing
-- winner and second-place identities remain the setup.sql test contract.
UPDATE public.tournament_players tp SET chips=(q.n+2)*1000
 FROM (SELECT tournament_id,count(*) n FROM legacy_fee_fixture.synthetic_original_charges GROUP BY tournament_id)q,
 legacy_fee_fixture.cases c WHERE c.tournament_id=q.tournament_id AND tp.tournament_id=c.tournament_id AND tp.user_id=c.winner_id;
UPDATE public.table_seats s SET stack=(q.n+2)*1000
 FROM (SELECT tournament_id,count(*) n FROM legacy_fee_fixture.synthetic_original_charges GROUP BY tournament_id)q,
 legacy_fee_fixture.cases c WHERE c.tournament_id=q.tournament_id AND s.table_id=c.table_id AND s.user_id=c.winner_id;
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
 amount,category,description,club_id,tournament_id,created_at,status)
 SELECT ledger_id,user_id,'player_wallet',user_id,'prize_liability',tournament_id,
 rake_amount+synthetic_prize,'tournament_buyin','Synthetic original admission opening evidence',
 club_id,tournament_id,charged_at,'posted'
 FROM legacy_fee_fixture.synthetic_original_charges;
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,
 charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
 source_ledger_id,registration_id,escrow_bucket,evidence_kind,created_at)
 SELECT entitlement_id,tournament_id,user_id,'wallet_charge','tournament_buyin',club_id,
 rake_amount+synthetic_prize,synthetic_prize,0,rake_amount,ledger_id,NULL,
 'wallet_gross','atomic_wallet_charge',charged_at FROM legacy_fee_fixture.synthetic_original_charges;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id::text,m.club_id,m.user_id,'baseline',
 '2026-09-01T00:00:00Z'::timestamptz,to_jsonb(m)
 FROM public.club_members m WHERE EXISTS(SELECT 1 FROM legacy_fee_fixture.synthetic_original_charges c
  WHERE c.club_id=m.club_id AND c.user_id=m.user_id);
-- Model missing access to originals, not a new agreement. Save their exact
-- original local rows, hide them before terminal, restore identical bytes later.
CREATE TABLE legacy_fee_fixture.original_local_terms(id bigint PRIMARY KEY,document jsonb NOT NULL);
WITH saved AS(DELETE FROM public.accounting_agreement_history h
 WHERE h.entity_type='club_members' AND EXISTS(SELECT 1 FROM legacy_fee_fixture.synthetic_original_charges c
  WHERE c.club_id=h.club_id AND c.user_id=h.subject_user_id)
 RETURNING h.*)
INSERT INTO legacy_fee_fixture.original_local_terms SELECT id,to_jsonb(saved) FROM saved;
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT legacy_fee_fixture.assert((SELECT count(*)=302 FROM legacy_fee_fixture.synthetic_original_charges)
 AND NOT EXISTS(SELECT 1 FROM legacy_fee_fixture.cases c WHERE
  (SELECT sum(e.refund_fee) FROM public.tournament_refund_entitlements e WHERE e.tournament_id=c.tournament_id)<>c.fee_amount
  OR (SELECT sum(e.refund_prize) FROM public.tournament_refund_entitlements e WHERE e.tournament_id=c.tournament_id)<>c.prize_amount)
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b JOIN legacy_fee_fixture.cases c USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s JOIN legacy_fee_fixture.cases c USING(tournament_id))
 AND current_setting('session_replication_role')='origin',
 'Synthetic original302 funding witnesses conserve the opening banks without seeded capture or recognition');
