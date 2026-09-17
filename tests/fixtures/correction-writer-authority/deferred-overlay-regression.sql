\set ON_ERROR_STOP on
-- UNRUN. SAME isolated connection; all successful probes roll back.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
SELECT pg_temp.cw_check(current_user='postgres' AND inet_server_addr() IS NULL
 AND current_setting('session_replication_role')='origin','isolated deferred/overlay setup');
CREATE FUNCTION pg_temp.cw_deferred_refusal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='fixture_late_correction_refusal';
END$$;
CREATE CONSTRAINT TRIGGER fixture_late_correction_refusal AFTER INSERT ON public.ca_correction_request_intents_v1
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.cw_deferred_refusal();
SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');
SET LOCAL ROLE service_role;
DO $deferred$ DECLARE q jsonb;r jsonb;before_book jsonb;returned_success boolean:=false;observed text;BEGIN
 SELECT request INTO STRICT q FROM correction_fixture_input;before_book:=pg_temp.cw_book();
 BEGIN
  r:=pg_temp.cw_call(q);
  PERFORM pg_temp.cw_check((r->'ok'='true'::jsonb AND r->'replayed'='false'::jsonb) IS TRUE,
   'writer returns provisional success before deferred constraint flush');
  returned_success:=true;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'deferred failure was not reached';
 EXCEPTION WHEN check_violation THEN observed:=SQLERRM;END;
 PERFORM pg_temp.cw_check(returned_success AND observed='fixture_late_correction_refusal'
  AND pg_temp.cw_book()=before_book,'late failure rolls back ledger, intent, incident, document and all nested deliveries');
END$deferred$;
RESET ROLE;
DROP TRIGGER fixture_late_correction_refusal ON public.ca_correction_request_intents_v1;

-- Only the initial tournament/escrow/union fixture state bypasses triggers.
-- Correction INSERT and its real overlay/issuance trigger paths remain origin.
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet)
 VALUES(pg_temp.cw_id(110),'Correction Overlay Fixture',pg_temp.cw_id(1),'correction-writer-overlay-fixture',1000,0,0,0);
INSERT INTO public.tournaments(id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,
 prize_pool,bounty_pool,bounty_pool_paid,total_rake,guaranteed_prize,current_players,payout_structure,prize_pool_finalized,
 started_at,current_level,late_reg_levels,rebuy_levels,late_reg_mins,is_rebuy,is_reentry,add_on_available)
 VALUES(pg_temp.cw_id(401),pg_temp.cw_id(101),'Correction Overlay Fixture',10,0,now(),9,'RUNNING',
 10,0,0,0,0,0,'[{"place":1,"percentage":100}]',false,now(),5,4,4,60,false,false,false);
INSERT INTO public.tournament_escrow(tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
 satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,reserve_out,reserve_in,
 prize_balance,bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
 VALUES(pg_temp.cw_id(401),10,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0,0,'correction-writer-fixture',now(),now(),true);
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE cw_overlay_baseline AS SELECT pg_temp.cw_book() AS book;
GRANT SELECT ON cw_overlay_baseline TO service_role;
SET LOCAL ROLE service_role;
DO $overlay$ DECLARE q jsonb;r jsonb;replay jsonb;initial_book jsonb;after_book jsonb;kind text;expected_overlay numeric:=0;BEGIN
 SELECT book INTO STRICT initial_book FROM cw_overlay_baseline;
 BEGIN
  FOREACH kind IN ARRAY ARRAY['club_treasury','union_bank'] LOOP
   SELECT request||jsonb_build_object('from_type',kind,
    'from_entity',CASE kind WHEN 'club_treasury' THEN pg_temp.cw_id(101) ELSE pg_temp.cw_id(110) END,
    'to_type','prize_liability','to_entity',pg_temp.cw_id(401),'amount','2.50',
    'incident_id',CASE kind WHEN 'club_treasury' THEN pg_temp.cw_id(311) ELSE pg_temp.cw_id(312) END,
    'union_id',CASE kind WHEN 'union_bank' THEN pg_temp.cw_id(110) ELSE NULL END,
    'reason','Recorded correction follows the retained real prize overlay trigger') INTO STRICT q FROM correction_fixture_input;
   r:=pg_temp.cw_call(q);SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;
   PERFORM pg_temp.cw_check((r->'ok'='true'::jsonb AND r->'replayed'='false'::jsonb) IS TRUE,'real '||kind||' overlay correction accepted');
   expected_overlay:=expected_overlay+2.50;after_book:=pg_temp.cw_book();
   PERFORM pg_temp.cw_check((SELECT count(*)=1 AND bool_and((row->>'overlay_in')::numeric=expected_overlay
    AND (row->>'prize_balance')::numeric=10+expected_overlay) FROM jsonb_array_elements(after_book->'public.tournament_escrow') row
    WHERE row->>'tournament_id'=pg_temp.cw_id(401)::text),'actual escrow trigger applies each overlay exactly once');
   PERFORM pg_temp.cw_check(after_book->'public.clubs'=initial_book->'public.clubs'
    AND after_book->'public.unions'=initial_book->'public.unions'
    AND after_book->'public.club_members'=initial_book->'public.club_members'
    AND after_book->'public.ca_mint_ledger'=initial_book->'public.ca_mint_ledger'
    AND after_book->'public.accounting_correction_documents'=initial_book->'public.accounting_correction_documents'
    AND after_book->'public.settlement_invoices'=initial_book->'public.settlement_invoices',
    'prize-liability route preserves wallets and remains outside supported correction-document routes');
   replay:=pg_temp.cw_call(q);
   PERFORM pg_temp.cw_check(replay=jsonb_build_object('ok',true,'replayed',true,'ledger_id',r->'ledger_id')
    AND pg_temp.cw_book()=after_book,'overlay exact replay does not apply the escrow amount twice');
  END LOOP;
  RAISE EXCEPTION USING ERRCODE='ZC036',MESSAGE='rollback_actual_overlay_cases';
 EXCEPTION WHEN SQLSTATE 'ZC036' THEN IF SQLERRM<>'rollback_actual_overlay_cases' THEN RAISE;END IF;END;
 PERFORM pg_temp.cw_check(pg_temp.cw_book()=initial_book,'overlay test rollback restores every captured row');
 -- The existing deferrable issuance register deliberately excludes correction
 -- category; exercise that real trigger, not a direct helper-only assertion.
 BEGIN
  SELECT request||jsonb_build_object('from_type','system_mint','from_entity',pg_temp.cw_id(901),
   'incident_id',pg_temp.cw_id(313),'reason','Correction category retains the existing issuance exclusion') INTO STRICT q FROM correction_fixture_input;
  r:=pg_temp.cw_call(q);SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.cw_check((r->'ok'='true'::jsonb AND r->'replayed'='false'::jsonb) IS TRUE,'outside-store correction reaches real deferred issuance trigger');
  after_book:=pg_temp.cw_book();
  PERFORM pg_temp.cw_check(after_book->'public.ca_mint_ledger'=initial_book->'public.ca_mint_ledger'
   AND after_book->'public.clubs'=initial_book->'public.clubs' AND after_book->'public.club_members'=initial_book->'public.club_members'
   AND after_book->'public.accounting_correction_documents'=initial_book->'public.accounting_correction_documents'
   AND after_book->'public.settlement_invoices'=initial_book->'public.settlement_invoices',
   'excluded correction creates no issuance, wallet movement or unsupported payment document');
  replay:=pg_temp.cw_call(q);
  PERFORM pg_temp.cw_check(replay=jsonb_build_object('ok',true,'replayed',true,'ledger_id',r->'ledger_id')
   AND pg_temp.cw_book()=after_book,'issuance-excluded replay is unchanged');
  RAISE EXCEPTION USING ERRCODE='ZC037',MESSAGE='rollback_actual_issuance_exclusion';
 EXCEPTION WHEN SQLSTATE 'ZC037' THEN IF SQLERRM<>'rollback_actual_issuance_exclusion' THEN RAISE;END IF;END;
 PERFORM pg_temp.cw_check(pg_temp.cw_book()=initial_book,'issuance-exclusion rollback restores every captured row');
END$overlay$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
