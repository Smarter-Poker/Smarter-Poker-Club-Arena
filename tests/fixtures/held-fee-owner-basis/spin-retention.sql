-- The five Sept-8 Spin standings witnesses after the owner's horse hand-history
-- retention has removed the accepted hand. :'phase' is 'before' (installed
-- predecessor) or 'after' (candidate installed).
CREATE SCHEMA IF NOT EXISTS held_fee_spin;
CREATE TABLE IF NOT EXISTS held_fee_spin.assertions(label text PRIMARY KEY);
CREATE OR REPLACE FUNCTION held_fee_spin.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label;END IF;
 INSERT INTO held_fee_spin.assertions VALUES(label);RAISE NOTICE 'PASS %',label;
END $$;
SET held_fee.phase=:'phase';
BEGIN;
DO $$ DECLARE c record;hand uuid;receipt jsonb;retired jsonb;message text;phase text:=current_setting('held_fee.phase');BEGIN
 PERFORM held_fee_spin.assert((SELECT count(*)=5 FROM sep8_spin_fixture.cases)
  AND (SELECT horse_retention_days=8 FROM public.hand_history_retention_policy WHERE id),'Five retained Spin standings and the owner''s eight-day horse retention ('||phase||')');
 FOR c IN SELECT * FROM sep8_spin_fixture.cases ORDER BY tournament_id LOOP
  SELECT (s.expected->'snapshot'->'candidates'->0->>'hand_id')::uuid INTO hand FROM smarter_private.spin_original_standings s WHERE s.tournament_id=c.tournament_id;
  receipt:=public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
  PERFORM held_fee_spin.assert(receipt->>'player_result'='final' AND EXISTS(SELECT 1 FROM public.hand_history WHERE id=hand)
   AND EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_id=hand),'Receipt reads while the accepted horse hand is retained ('||phase||') '||c.tournament_id);
  -- A present row that differs is still a changed hand.
  BEGIN
   SET LOCAL session_replication_role=replica;
   UPDATE public.hand_history SET pot_size=COALESCE(pot_size,0)+1 WHERE id=hand;
   SET LOCAL session_replication_role=origin;
   message:=NULL;
   BEGIN PERFORM public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
   EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
   PERFORM held_fee_spin.assert(message='SPIN_ORIGINAL_STANDINGS_CHANGED','A changed retained hand still refuses ('||phase||') '||c.tournament_id);
   RAISE EXCEPTION 'held_fee_rollback' USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL; END;
  -- Only one of the two rows retired is not a retention: still refuses.
  BEGIN
   SET LOCAL session_replication_role=replica;
   DELETE FROM public.hand_history WHERE id=hand;
   SET LOCAL session_replication_role=origin;
   message:=NULL;
   BEGIN PERFORM public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
   EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
   PERFORM held_fee_spin.assert(message='SPIN_ORIGINAL_STANDINGS_CHANGED','A half-retired hand still refuses ('||phase||') '||c.tournament_id);
   RAISE EXCEPTION 'held_fee_rollback' USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL; END;
  -- Both rows retired but younger than the recorded retention: still refuses.
  BEGIN
   SET LOCAL session_replication_role=replica;
   DELETE FROM public.hand_history WHERE id=hand;
   DELETE FROM public.hand_atomic_commits WHERE hand_id=hand;
   UPDATE public.hand_history_retention_policy SET horse_retention_days=3650 WHERE id;
   SET LOCAL session_replication_role=origin;
   message:=NULL;
   BEGIN PERFORM public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
   EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
   PERFORM held_fee_spin.assert(message='SPIN_ORIGINAL_STANDINGS_CHANGED','A hand missing inside the retention window still refuses ('||phase||') '||c.tournament_id);
   RAISE EXCEPTION 'held_fee_rollback' USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL; END;
  -- Both rows retired by the eight-day horse retention.
  BEGIN
   SET LOCAL session_replication_role=replica;
   DELETE FROM public.hand_history WHERE id=hand;
   DELETE FROM public.hand_atomic_commits WHERE hand_id=hand;
   SET LOCAL session_replication_role=origin;
   message:=NULL;retired:=NULL;
   BEGIN retired:=public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
   EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
   IF phase='before' THEN
    PERFORM held_fee_spin.assert(message='SPIN_ORIGINAL_STANDINGS_CHANGED','DEFECT reproduced: predecessor refuses the terminal receipt once retention retires the horse hand '||c.tournament_id);
   ELSE
    PERFORM held_fee_spin.assert(message IS NULL AND retired=receipt,'A horse hand retired by retention leaves the identical terminal receipt '||c.tournament_id);
   END IF;
   RAISE EXCEPTION 'held_fee_rollback' USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL; END;
 END LOOP;
END $$;
COMMIT;
