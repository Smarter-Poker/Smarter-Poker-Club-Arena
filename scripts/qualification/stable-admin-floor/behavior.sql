SET request.jwt.claim.role='service_role';
SET request.jwt.claims='{"role":"service_role"}';
SELECT floor_assert((SELECT count(*)=1 FROM ca_declared_money_triggers WHERE table_name='table_seats' AND trigger_name='ca_operator_floor_entry_guard'),'floor admission trigger is declared in its installing transaction');
-- Named role enforcement, identity replay, parked admission, and hold ownership.
DO $$ BEGIN
 BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000009','floor','park','Read only cannot park'); RAISE EXCEPTION 'missing permission refusal'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','floor','park','Investigating an integrity incident');
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','floor','park','Investigating an integrity incident');
SELECT floor_assert((SELECT count(*)=1 FROM admin_audit_log WHERE target_id='70000000-0000-4000-8000-000000000001'),'replayed original command does not duplicate canonical audit');
CREATE FUNCTION fixture_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE SQLSTATE 'PA001' USING MESSAGE='synthetic audit refusal'; END $$;
CREATE TRIGGER fixture_refuse_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION fixture_refuse_audit();
DO $$ BEGIN
 BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000010','floor','pause','An audit refusal must roll this back'); RAISE EXCEPTION 'unaudited command accepted'; EXCEPTION WHEN SQLSTATE 'PA001' THEN NULL; END;
 PERFORM floor_assert(NOT EXISTS(SELECT 1 FROM ca_engine_operator_commands WHERE id='70000000-0000-4000-8000-000000000010') AND (SELECT mode='park' FROM ca_operator_floor_hold),'canonical audit refusal rolls back the command and hold together');
END $$;
DROP TRIGGER fixture_refuse_audit ON admin_audit_log;
DROP FUNCTION fixture_refuse_audit();
DO $$ BEGIN
 BEGIN INSERT INTO table_seats(id,user_id,table_id,stack,occupancy_id) VALUES(gen_random_uuid(),'10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,gen_random_uuid()); RAISE EXCEPTION 'park admits occupancy'; EXCEPTION WHEN object_in_use THEN NULL; END;
END $$;
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','floor','resume','Release the operator hold only');
SELECT floor_assert(NOT EXISTS(SELECT 1 FROM ca_operator_floor_hold),'operator hold released');
-- Cash close cannot touch live hand or occupied stack. It does no money write.
INSERT INTO hand_state_snapshots VALUES('30000000-0000-4000-8000-000000000001',false);
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000003','floor','close_cash','Close cash tables at settled boundaries');
SELECT floor_assert(NOT fn_ca_operator_finish_cash_close('30000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000003'),'live hand stays open');
SELECT floor_assert((SELECT chip_balance=100 FROM club_members),'no premature refund');
DO $$ BEGIN
 BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000004','floor','close_cash','Competing close must be refused'); RAISE EXCEPTION 'competing close accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'cash_floor_close_in_progress' THEN RAISE; END IF; END;
END $$;
UPDATE hand_state_snapshots SET is_complete=true;
SELECT fn_request_admin_seat_departure('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Global cash close at hand boundary');
SELECT fn_request_admin_seat_departure('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',1,'50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Global cash close at hand boundary');
SELECT floor_assert((SELECT count(*)=2 FROM seat_admin_departure_authorizations) AND (SELECT count(*)=2 FROM anti_cheat_events),'original administrative departure records authority before money');
-- A refused original destination credit rolls back idempotency and seat exit.
DO $$ BEGIN
 BEGIN
  DELETE FROM club_members;
  PERFORM fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001','forced');
  RAISE EXCEPTION 'missing destination was accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 PERFORM floor_assert((SELECT left_at IS NULL AND stack=25.50 FROM table_seats WHERE occupancy_id='50000000-0000-4000-8000-000000000001') AND NOT EXISTS(SELECT 1 FROM seat_cashout_receipts) AND NOT EXISTS(SELECT 1 FROM wallet_credit_idempotency),'refused original chip credit has no partial exit, receipt or money');
 BEGIN
  UPDATE profiles SET diamonds=2147483647 WHERE id='10000000-0000-4000-8000-000000000003';
  PERFORM fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',1,'50000000-0000-4000-8000-000000000002','forced');
  RAISE EXCEPTION 'refused diamond credit was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'diamond_release_credit_failed:diamond_balance_limit' THEN RAISE; END IF; END;
 PERFORM floor_assert((SELECT left_at IS NULL AND stack=30 FROM table_seats WHERE occupancy_id='50000000-0000-4000-8000-000000000002') AND (SELECT state='active' AND balance=30 FROM poker_diamond_custody) AND NOT EXISTS(SELECT 1 FROM poker_diamond_movements),'refused diamond credit has no partial seat exit or custody release');
END $$;
-- Original occupancy cashout and credit function bodies, no replacement money.
SELECT fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001','forced');
SELECT fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001','forced');
SELECT floor_assert((SELECT chip_balance=125.50 FROM club_members) AND (SELECT count(*)=1 AND sum(amount)=25.50 FROM wallet_transactions) AND (SELECT count(*)=1 AND sum(amount)=25.50 FROM chip_transactions),'chips return exactly once through current original owner');
SELECT floor_assert(fn_ca_operator_finish_cash_close('30000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000003'),'settled vacated cash table closes');
-- Diamond custody and credit owners are original bodies as well. A debt retires
-- diamonds through their original register function, not a test-only credit.
INSERT INTO diamond_debts(user_id,amount,reason) VALUES('10000000-0000-4000-8000-000000000003',5,'synthetic reversed purchase');
SELECT fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',1,'50000000-0000-4000-8000-000000000002','forced');
SELECT fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',1,'50000000-0000-4000-8000-000000000002','forced');
SELECT floor_assert((SELECT diamonds=125 AND diamond_balance=125 FROM profiles WHERE id='10000000-0000-4000-8000-000000000003') AND (SELECT state='released' AND balance=0 FROM poker_diamond_custody) AND (SELECT count(*)=1 FROM poker_diamond_movements) AND (SELECT count(*)=2 AND sum(amount)=25 FROM diamond_transactions) AND (SELECT count(*)=1 AND sum(amount)=5 FROM ca_mint_ledger WHERE action='burn'),'diamond custody return and debt retirement exactly once');
SELECT floor_assert(fn_ca_operator_finish_cash_close('30000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003'),'diamond table closes after owner return');
SELECT floor_assert((SELECT status='completed' FROM ca_engine_operator_commands WHERE id='70000000-0000-4000-8000-000000000003'),'durable close completion');
-- Deadline/cancellation source state and application survive a new connection.
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000005','maintenance','start','Request the existing hourly owner');
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000005','maintenance','cancel','Cancel before the original application');
SELECT floor_assert((SELECT status='cancelled' FROM ca_engine_operator_commands WHERE id='70000000-0000-4000-8000-000000000005'),'cancel before application');
SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000006','maintenance','start','Request the existing hourly owner');
SELECT fn_ca_engine_operator_claim_hourly((SELECT announced_at FROM ca_engine_operator_commands WHERE id='70000000-0000-4000-8000-000000000006'));
DO $$ BEGIN
 BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000006','maintenance','cancel','Cannot cancel after original application'); RAISE EXCEPTION 'unsafe cancel accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'maintenance_already_applied' THEN RAISE; END IF; END;
 BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000006','maintenance','end','Cannot thaw before original deadline'); RAISE EXCEPTION 'unsafe end accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'maintenance_deadline_not_reached' THEN RAISE; END IF; END;
END $$;
SELECT floor_assert((SELECT count(*)=6 AND count(DISTINCT request_id)=6 FROM admin_audit_log) AND (SELECT count(*)=1 FROM admin_audit_log WHERE action='engine_operator.maintenance.cancel'),'canonical audit records each new command and cancellation once');
SELECT 'STABLE_ADMIN_FLOOR_ORIGINAL_OWNER_PASS';
