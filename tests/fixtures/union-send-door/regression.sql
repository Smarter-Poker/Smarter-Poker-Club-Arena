-- A CLOSED MONEY DOOR IS STILL A CORRECT ONE (20260925145748)
--
-- public.fn_union_send_chips_to_club resolved ONE club owner with LIMIT 1 and no
-- ORDER BY, then credited EVERY role='owner' row while debiting the union wallet
-- once. A club with two owner rows received 2 x p_amount for a 1 x p_amount
-- debit and the difference was minted, with no authorization check of any kind,
-- no idempotency key and no chip_ledger leg of its own.
--
-- It has no caller. 20260903201301 closed it - revoked from PUBLIC, anon,
-- authenticated and service_role, registered `closed` in ca_money_rpc_registry -
-- after finding zero callers and zero rows in 30 days, and
-- tests/a-money-door-nothing-calls-is-closed.law.test.ts keeps it that way.
-- Being unreachable is not being correct: a revoke is one statement from being
-- undone, and the body is what would then run. So the body refuses.
--
-- These probes move fixture chips on a private disposable cluster. Nothing here
-- grants the door to any role, and the last assertion proves it.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','The union send door fixture runs only in the private native cluster');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- The union house (203) owns club 104 whose clubs.owner_id is 901. Give that
-- owner the member row the platform's own constraint trigger would have made,
-- and fund the union bank enough to send from.
INSERT INTO club_members(user_id,club_id,chip_balance,role,status)
 VALUES(fixture.u(901),fixture.u(104),0,'owner','active')
 ON CONFLICT (club_id,user_id) DO UPDATE SET role='owner',status='active';
UPDATE union_wallets SET chip_balance=chip_balance+1000 WHERE union_id=fixture.u(203);

CREATE TEMP TABLE send_door_before AS
SELECT (SELECT chip_balance FROM union_wallets WHERE union_id=fixture.u(203)) AS union_bank,
       (SELECT COALESCE(chip_balance,0) FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(901)) AS owner_wallet,
       (SELECT count(*) FROM chip_ledger WHERE category='union_send') AS union_send_legs,
       (SELECT count(*) FROM union_wallet_transactions
         WHERE union_id=fixture.u(203) AND tx_type='send_to_club' AND club_id=fixture.u(104)) AS audit_rows;

-- (1) NO OPERATION ID, NO TRANSFER. The four-argument signature is pinned by the
-- closed-door law test and cannot grow a fifth parameter without creating an
-- overload PUBLIC could execute, so the key is declared on a transaction-scoped
-- setting - and a caller that declares none is refused rather than handed a
-- gen_random_uuid() that would make every retry a second payment.
DO $no_key$
DECLARE fired text;
BEGIN
 PERFORM set_config('app.union_send_chips_op_id','',true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),25.00,'no key');
  fired:='<the transfer moved chips with no idempotency key>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; END;
 PERFORM fixture.assert(fired='union_send_requires_operation_id','a union send with no declared operation id is refused: '||COALESCE(fired,'<null>'));
END $no_key$;

-- (2) AN UNAUTHORIZED ACTOR IS REFUSED. The house pattern: fn_caller_is_engine()
-- or the union's own owner (fn_execute_union_rakeback, fn_union_fund_promo_from
-- _bank). This door had no check of any kind.
DO $not_authorized$
DECLARE fired text;
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000907"}',true);
 PERFORM set_config('app.union_send_chips_op_id',fixture.u(7001)::text,true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),25.00,'not mine');
  fired:='<a member moved the union bank>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; END;
 PERFORM fixture.assert(fired='union_send_not_authorized','a club member cannot send the union bank to a club: '||COALESCE(fired,'<null>'));

 -- The union owner is authorized. Same call, same amount, owner's JWT.
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000900"}',true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),0,'zero');
  fired:='<a zero transfer was accepted>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; END;
 PERFORM fixture.assert(fired='union_send_amount_must_be_positive',
  'the union owner passes the authorization gate and is stopped only by the amount: '||COALESCE(fired,'<null>'));
 PERFORM set_config('request.jwt.claims','{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}',true);
END $not_authorized$;

-- (3) A CLUB THAT IS NOT IN THIS UNION IS REFUSED. fn_union_send_to_club_atomic
-- has always checked this; this door never did.
DO $foreign_club$
DECLARE fired text;
BEGIN
 PERFORM set_config('app.union_send_chips_op_id',fixture.u(7002)::text,true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(101),25.00,'other union');
  fired:='<the union paid a club outside it>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; END;
 PERFORM fixture.assert(fired='union_send_club_not_in_union','a union cannot send chips to a club outside it: '||COALESCE(fired,'<null>'));
END $foreign_club$;

-- (4) THE MINTING CONDITION ITSELF. Two role='owner' rows is what turned a
-- 1 x p_amount debit into a 2 x p_amount credit. A money mover that cannot name
-- its payee stops; it does not pick one with LIMIT 1 and pay them all.
DO $ambiguous$
DECLARE fired text; bank_before numeric; bank_after numeric;
BEGIN
 INSERT INTO club_members(user_id,club_id,chip_balance,role,status)
  VALUES(fixture.u(906),fixture.u(104),0,'owner','active')
  ON CONFLICT (club_id,user_id) DO UPDATE SET role='owner',status='active';
 SELECT chip_balance INTO bank_before FROM union_wallets WHERE union_id=fixture.u(203);
 PERFORM set_config('app.union_send_chips_op_id',fixture.u(7003)::text,true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),25.00,'two owners');
  fired:='<a club with two owner rows was paid>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; END;
 PERFORM fixture.assert(fired='union_send_club_owner_is_ambiguous',
  'a club carrying two role=owner rows is refused, never paid twice: '||COALESCE(fired,'<null>'));
 SELECT chip_balance INTO bank_after FROM union_wallets WHERE union_id=fixture.u(203);
 PERFORM fixture.assert(bank_after=bank_before,'the refused ambiguous send debited nothing');
 PERFORM fixture.assert((SELECT COALESCE(sum(chip_balance),0) FROM club_members
    WHERE club_id=fixture.u(104) AND role='owner')=0,'the refused ambiguous send credited no owner');
 DELETE FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(906);
END $ambiguous$;

-- (5) ONE OWNER, ONE CREDIT, ONE DEBIT, ONE KEYED LEG THAT NAMES THE CLUB.
DO $accepted$
DECLARE leg public.chip_ledger%ROWTYPE; bank numeric; owner_chips numeric;
BEGIN
 PERFORM set_config('app.union_send_chips_op_id',fixture.u(7004)::text,true);
 PERFORM fixture.assert(public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),25.00,'one owner'),
  'a club with exactly one owner is paid');
 SELECT chip_balance INTO bank FROM union_wallets WHERE union_id=fixture.u(203);
 SELECT COALESCE(chip_balance,0) INTO owner_chips FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
 PERFORM fixture.assert(bank=(SELECT union_bank FROM send_door_before)-25.00,
  format('the union bank is debited exactly once (%s)',bank));
 PERFORM fixture.assert(owner_chips=(SELECT owner_wallet FROM send_door_before)+25.00,
  format('the one resolved owner is credited exactly once (%s)',owner_chips));

 SELECT * INTO leg FROM public.chip_ledger
  WHERE idempotency_key='union_send_chips_to_club:'||fixture.u(7004)::text;
 PERFORM fixture.assert(FOUND,'the transfer writes its own chip_ledger leg carrying the operation key');
 PERFORM fixture.assert(leg.category='union_send' AND leg.from_type='union_bank' AND leg.from_entity_id=fixture.u(203)
   AND leg.to_type='player_wallet' AND leg.to_entity_id=fixture.u(901) AND leg.amount=25.00,
  'the leg records union_bank -> the one owner''s player wallet for the exact amount');
 PERFORM fixture.assert(leg.club_id=fixture.u(104) AND leg.union_id=fixture.u(203),
  'the leg declares the club it was paid into, the way atomic_distribute_rake and fn_settle_tournament_rake declare theirs');
 PERFORM fixture.assert(leg.pre_from_balance=(SELECT union_bank FROM send_door_before) AND leg.post_from_balance=bank
   AND leg.pre_to_balance=(SELECT owner_wallet FROM send_door_before) AND leg.post_to_balance=owner_chips,
  'the leg carries both sides'' balances before and after');
 PERFORM fixture.assert((SELECT count(*) FROM public.chip_ledger
    WHERE category='union_send' AND from_entity_id=fixture.u(203) AND to_entity_id=fixture.u(901))
   =(SELECT union_send_legs FROM send_door_before)+1,
  'one movement, one leg - the two anonymous auto-journals stood down');
 PERFORM fixture.assert((SELECT count(*) FROM public.union_wallet_transactions
    WHERE union_id=fixture.u(203) AND tx_type='send_to_club' AND club_id=fixture.u(104))
   =(SELECT audit_rows FROM send_door_before)+1,
  'the existing union audit row is still written exactly once');
 PERFORM fixture.assert((SELECT wallet FROM public.union_wallet_transactions
    WHERE union_id=fixture.u(203) AND tx_type='send_to_club' AND club_id=fixture.u(104)
    ORDER BY created_at DESC LIMIT 1)='chip_balance',
  'the audit row names the wallet that moved, so union_wallet_transactions_wallet_check accepts it - wallet=''main'' aborted every call the predecessor ever received');
END $accepted$;

-- (6) THE SAME OPERATION ID IS NOT A SECOND PAYMENT.
DO $replay$
DECLARE fired text; bank numeric; owner_chips numeric;
BEGIN
 SELECT chip_balance INTO bank FROM union_wallets WHERE union_id=fixture.u(203);
 SELECT COALESCE(chip_balance,0) INTO owner_chips FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
 PERFORM set_config('app.union_send_chips_op_id',fixture.u(7004)::text,true);
 BEGIN
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),25.00,'replay');
  fired:='<the same operation paid twice>';
 EXCEPTION WHEN unique_violation THEN fired:='unique_violation';
           WHEN OTHERS THEN fired:=SQLSTATE||' '||SQLERRM; END;
 PERFORM fixture.assert(fired='unique_violation',
  'a repeat of the same operation is refused by ux_chip_ledger_idempotency_key: '||COALESCE(fired,'<null>'));
 PERFORM fixture.assert((SELECT chip_balance FROM union_wallets WHERE union_id=fixture.u(203))=bank
   AND (SELECT COALESCE(chip_balance,0) FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(901))=owner_chips,
  'the refused replay moved nothing');
END $replay$;

-- (7) AND THE DOOR IS STILL CLOSED. Nothing above grants it back; this is the
-- invariant fn_ca_money_rpc_drift raises an incident on.
DO $still_closed$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   PERFORM fixture.assert(NOT has_function_privilege(r,
     'public.fn_union_send_chips_to_club(uuid,uuid,numeric,text)'::regprocedure,'EXECUTE'),
    r||' has no key to the closed union send door');
  END IF;
 END LOOP;
END $still_closed$;
DROP TABLE send_door_before;
