BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;before jsonb;err text;statement text;BEGIN
 SELECT * INTO c FROM sep8_spin_fixture.cases ORDER BY tournament_id LIMIT 1;
 before:=sep8_spin_fixture.snapshot();
 BEGIN
  SET LOCAL session_replication_role=replica;
  UPDATE public.tournament_terminal_settlements SET cash_receipt=jsonb_set(cash_receipt,'{original_standings}',cash_receipt->'original_standings'||'{"unrecognized_extra_field":true}'::jsonb)
   WHERE tournament_id=c.tournament_id;
  SET LOCAL session_replication_role=origin;
  PERFORM public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='terminal cash original Spin standings disagree with immutable authority' AND before=sep8_spin_fixture.snapshot(),
  'Cash original standings requires whole immutable witness equality');
 err:=NULL;
 BEGIN
  SET LOCAL session_replication_role=replica;
  UPDATE public.tournament_terminal_settlements SET cash_receipt=cash_receipt-'original_standings'
   WHERE tournament_id=c.tournament_id;
  SET LOCAL session_replication_role=origin;
  PERFORM public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='terminal cash original Spin standings disagree with immutable authority' AND before=sep8_spin_fixture.snapshot(),
  'Cash original standings cannot fall back to generic or Breakfast evidence');
 FOREACH statement IN ARRAY ARRAY[
  'UPDATE smarter_private.spin_original_standings SET winner_id=gen_random_uuid()',
  'DELETE FROM smarter_private.spin_original_standings',
  'TRUNCATE smarter_private.spin_original_standings'] LOOP
  err:=NULL;
  BEGIN EXECUTE statement;EXCEPTION WHEN SQLSTATE '55000' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err='SPIN_ORIGINAL_STANDINGS_IMMUTABLE' AND before=sep8_spin_fixture.snapshot(),
   'Original admitted authority is immutable: '||split_part(statement,' ',1));
 END LOOP;
END $$;
ROLLBACK;
