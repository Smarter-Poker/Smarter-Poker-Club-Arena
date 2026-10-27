SET request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
DO $$ DECLARE r jsonb; r2 jsonb; BEGIN
 r:=fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001');
 PERFORM floor_assert(r->>'pool_session_id' IS NOT NULL,'funded anchor reopens');
 r2:=fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001');
 PERFORM floor_assert(r=r2,'duplicate returns same room');
 PERFORM floor_assert((SELECT count(*)=1 FROM lightning_pool_session),'one pool session');
 PERFORM floor_assert((SELECT count(*)=1 FROM lightning_pool_slot),'one slot');
 PERFORM floor_assert((SELECT chip_balance=100 FROM club_members),'funded rejoin spends nothing');
 PERFORM floor_assert((SELECT count(*)=1 FROM realtime.signals),'one private room signal');
END $$;
-- Expired session plus a busted anchor: the canonical cashout persists a zero receipt.
UPDATE lightning_pool_session SET exited_at=now(),state='closed';
UPDATE table_seats SET stack=0 WHERE user_id=auth.uid();
SELECT set_config('test.hand','true',false);
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'live hand was released';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'LIGHTNING_REJOIN_PENDING' THEN RAISE; END IF; END;
 PERFORM floor_assert((SELECT left_at IS NULL FROM table_seats WHERE user_id=auth.uid()),'in-hand zero preserved');
END $$;
SELECT set_config('test.hand','false',false);
SELECT floor_assert(fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001') IS NULL,'empty anchor released');
SELECT floor_assert((SELECT left_at IS NOT NULL FROM table_seats WHERE user_id=auth.uid()),'seat vacated');
SELECT floor_assert((SELECT count(*)=1 AND min((receipt->>'stack')::numeric)=0 FROM seat_cashout_receipts),'zero receipt retained');
SELECT floor_assert((SELECT chip_balance=100 FROM club_members),'empty exit cannot mint chips');
SELECT floor_assert(fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001') IS NULL,'retry empty is no-op');
SET request.jwt.claims='{}';
DO $$ BEGIN BEGIN PERFORM fn_lightning_rejoin_seated('70000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'anonymous admitted'; EXCEPTION WHEN invalid_authorization_specification THEN NULL; END; END $$;
SELECT 'LIGHTNING_REJOIN_POSTGRES_PASS';
