DO $probe$
DECLARE src text; caught boolean;
event uuid:='00000000-0000-4000-8000-000000000001';
club uuid:='00000000-0000-4000-8000-000000000002';
owner uuid:='00000000-0000-4000-8000-000000000003';
BEGIN
CREATE TEMP TABLE tournaments(id uuid,club_id uuid,status text) ON COMMIT DROP;
CREATE TEMP TABLE spin_bonus_pools(club_id uuid PRIMARY KEY,balance numeric) ON COMMIT DROP;
CREATE TEMP TABLE spin_reserve_ledger(club_id uuid,tournament_id uuid,kind text,amount numeric,balance_after numeric,note text) ON COMMIT DROP;
CREATE TEMP TABLE wallet_transactions(related_entity_id uuid,type text,category text) ON COMMIT DROP;
SELECT pg_get_functiondef('public.fn_ca_spin_cancel_returns_draw()'::regprocedure) INTO src; EXECUTE replace(src,'public.','pg_temp.');
CREATE TRIGGER cancel_return AFTER UPDATE OF status ON pg_temp.tournaments FOR EACH ROW EXECUTE FUNCTION pg_temp.fn_ca_spin_cancel_returns_draw();
INSERT INTO pg_temp.tournaments VALUES(event,club,'REGISTERING');
INSERT INTO pg_temp.spin_bonus_pools VALUES(club,100),(owner,50);
INSERT INTO pg_temp.spin_reserve_ledger VALUES(owner,event,'jackpot_draw',-8,50,'original draw');
UPDATE pg_temp.tournaments SET status='CANCELLED';
IF (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=owner)<>58 OR (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=club)<>100 OR NOT EXISTS(SELECT 1 FROM pg_temp.spin_reserve_ledger WHERE kind='surplus_return' AND club_id=owner AND amount=8) THEN RAISE EXCEPTION 'FAIL draw returned to event club instead of original reserve'; END IF;
UPDATE pg_temp.tournaments SET status='CANCELLED';
IF (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=owner)<>58 OR (SELECT count(*) FROM pg_temp.spin_reserve_ledger WHERE kind='surplus_return')<>1 THEN RAISE EXCEPTION 'FAIL cancellation replay returned draw twice'; END IF;
-- Already-returned value is deducted for the same recorded reserve.
UPDATE pg_temp.tournaments SET status='REGISTERING';
UPDATE pg_temp.spin_reserve_ledger SET amount=3 WHERE kind='surplus_return';
UPDATE pg_temp.spin_bonus_pools SET balance=53 WHERE club_id=owner;
UPDATE pg_temp.tournaments SET status='CANCELLED';
IF (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=owner)<>58 OR (SELECT sum(amount) FROM pg_temp.spin_reserve_ledger WHERE kind='surplus_return')<>8 THEN RAISE EXCEPTION 'FAIL partial earlier return not deducted'; END IF;
-- A missing original reserve refuses the same transaction; it cannot mint a return row.
TRUNCATE pg_temp.spin_reserve_ledger;
DELETE FROM pg_temp.spin_bonus_pools WHERE club_id=owner;
INSERT INTO pg_temp.spin_reserve_ledger VALUES(owner,event,'jackpot_draw',-8,50,'original draw');
UPDATE pg_temp.tournaments SET status='REGISTERING';
caught:=false;
BEGIN
 UPDATE pg_temp.tournaments SET status='CANCELLED';
EXCEPTION WHEN raise_exception THEN caught:=true;
END;
IF NOT caught OR (SELECT status FROM pg_temp.tournaments)<>'REGISTERING' OR EXISTS(SELECT 1 FROM pg_temp.spin_reserve_ledger WHERE kind='surplus_return') THEN RAISE EXCEPTION 'FAIL missing original reserve committed cancellation or journal'; END IF;
-- A refused return journal rolls back the reserve credit and status.
INSERT INTO pg_temp.spin_bonus_pools VALUES(owner,50);
EXECUTE $fn$CREATE FUNCTION pg_temp.refuse_return() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN IF NEW.kind='surplus_return' THEN RAISE EXCEPTION 'injected journal refusal' USING ERRCODE='XX001'; END IF; RETURN NEW; END
$body$ $fn$;
CREATE TRIGGER refuse_return BEFORE INSERT ON pg_temp.spin_reserve_ledger FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_return();
caught:=false;
BEGIN UPDATE pg_temp.tournaments SET status='CANCELLED';
EXCEPTION WHEN SQLSTATE 'XX001' THEN caught:=true; END;
IF NOT caught OR (SELECT status FROM pg_temp.tournaments)<>'REGISTERING' OR (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=owner)<>50 THEN RAISE EXCEPTION 'FAIL return journal failure kept reserve credit'; END IF;
DROP TRIGGER refuse_return ON pg_temp.spin_reserve_ledger;
-- The existing prize-awarded guard leaves the draw untouched.
INSERT INTO pg_temp.wallet_transactions VALUES(event,'credit','prize');
UPDATE pg_temp.tournaments SET status='CANCELLED';
IF (SELECT balance FROM pg_temp.spin_bonus_pools WHERE club_id=owner)<>50 OR EXISTS(SELECT 1 FROM pg_temp.spin_reserve_ledger WHERE kind='surplus_return') THEN RAISE EXCEPTION 'FAIL awarded prize draw returned'; END IF;
RAISE EXCEPTION 'AUDIT_TEST_PASS: actual Spin cancellation returns to recorded reserve, respects prior returns, replays once, refuses missing bank and preserves paid-prize guard; all rolled back';
END $probe$;