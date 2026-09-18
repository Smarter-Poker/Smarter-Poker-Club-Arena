-- Suffix inserted before the genuine v2 settlement in the existing funded probe.
-- Each isolated storage fault rolls back its complete attempted settlement.
CREATE FUNCTION pg_temp.entry_club_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
DECLARE mode text:=current_setting('native.entry_club_fault',true);
BEGIN
 IF coalesce(mode,'')='' THEN RETURN NEW; END IF;
 PERFORM set_config('session_replication_role','replica',true);
 IF TG_WHEN='BEFORE' THEN
  IF mode='user' THEN
   UPDATE public.tournament_players SET user_id='2d1cd6c3-5700-4af9-a271-d4863fdab20d' WHERE id=NEW.registration_id;
  ELSIF mode='target' THEN
   UPDATE public.tournament_players SET tournament_id='30000000-0000-0000-0000-000000000001' WHERE id=NEW.registration_id;
  ELSIF mode='source' THEN
   UPDATE public.tournament_players SET source_satellite_id=NULL WHERE id=NEW.registration_id;
  ELSIF mode='qualifier' THEN
   UPDATE public.tournament_players SET is_satellite_qualifier=false WHERE id=NEW.registration_id;
  ELSIF mode='club' THEN
   UPDATE public.tournament_players SET club_id=NULL WHERE id=NEW.registration_id;
  ELSIF mode='host' THEN
   UPDATE public.chip_ledger SET club_id='d2000000-0000-4000-8000-000000000002'
    WHERE idempotency_key=NEW.idempotency_key||':pool_transfer';
  END IF;
 ELSIF mode='entitlement_club' THEN
  UPDATE public.tournament_refund_entitlements
   SET refund_wallet_club_id='d2000000-0000-4000-8000-000000000002'
   WHERE registration_id=NEW.registration_id AND entitlement_kind='satellite_seat';
 END IF;
 PERFORM set_config('session_replication_role','origin',true);
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_entry_club_fault BEFORE INSERT ON public.tournament_satellite_awards
 FOR EACH ROW EXECUTE FUNCTION pg_temp.entry_club_fault();
CREATE TRIGGER zzzz_native_entry_club_fault AFTER INSERT ON public.tournament_satellite_awards
 FOR EACH ROW EXECUTE FUNCTION pg_temp.entry_club_fault();
DO $refusals$
DECLARE mode text; original_state jsonb; refused boolean;
BEGIN
 FOREACH mode IN ARRAY ARRAY['user','target','source','qualifier','club','host','entitlement_club'] LOOP
  PERFORM set_config('native.entry_club_fault',mode,true);
  original_state:=pg_temp.satellite_full_financial_state(); refused:=false;
  BEGIN
   PERFORM public.fn_settle_satellite_tournament('d3000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000002');
   SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
   refused:=mode IN ('user','source','qualifier') AND SQLERRM='satellite d3000000-0000-4000-8000-000000000001 has malformed or extra actual-seat evidence';
   IF NOT refused THEN RAISE; END IF;
  WHEN serialization_failure THEN
   refused:=mode='target' AND SQLERRM='satellite d3000000-0000-4000-8000-000000000001 target roster changed outside its locked delivery plan';
   IF NOT refused THEN RAISE; END IF;
  WHEN check_violation THEN
   refused:=mode IN ('club','host','entitlement_club') AND SQLERRM='tournament_fee_charge_evidence_mismatch';
   IF NOT refused THEN RAISE; END IF;
  END;
  IF NOT refused OR original_state IS DISTINCT FROM pg_temp.satellite_full_financial_state()
     OR current_setting('session_replication_role')<>'origin' THEN
   RAISE EXCEPTION 'entry club refusal or rollback missing: %',mode;
  END IF;
  RAISE NOTICE 'ENTRY_CLUB_REFUSAL_PASS: %',mode;
 END LOOP;
 PERFORM set_config('native.entry_club_fault','',true);
END $refusals$;
DROP TRIGGER native_entry_club_fault ON public.tournament_satellite_awards;
DROP TRIGGER zzzz_native_entry_club_fault ON public.tournament_satellite_awards;
