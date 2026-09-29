-- THE INSTALLED PREDECESSOR, AND THE MINT IT PERFORMS (production 2026-09-25)
--
-- public.fn_union_send_chips_to_club exactly as production carries it, captured
-- with pg_get_functiondef on 2026-09-25. It is applied here, before the
-- candidate, and asked the questions the candidate answers - so the double
-- credit is demonstrated rather than asserted about. This is a preimage: it
-- COMMITS the defect on a private disposable cluster, which is why it never
-- runs anywhere else.
--
-- 20260903201301's revokes are restated verbatim so the predecessor is closed
-- here exactly as it is in production: nothing in this fixture reaches it
-- through a client role.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','The union send door preimage runs only in the private native cluster');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_balance NUMERIC;
  v_owner_user_id UUID;
BEGIN
  -- 1. Validate amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  -- 2. Lock + check union wallet balance
  SELECT chip_balance INTO v_union_balance
    FROM public.union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_union_balance IS NULL THEN
    RAISE EXCEPTION 'Union wallet not found for union %', p_union_id;
  END IF;
  IF v_union_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient union chip balance. Available: %, Requested: %',
      v_union_balance, p_amount;
  END IF;

  -- 3. Find club owner
  SELECT user_id INTO v_owner_user_id
    FROM public.club_members WHERE club_id = p_club_id AND role = 'owner' LIMIT 1;
  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Club owner not found for club %', p_club_id;
  END IF;

  -- 4. Atomic: debit union wallet
  UPDATE public.union_wallets
    SET chip_balance = chip_balance - p_amount, updated_at = NOW()
    WHERE union_id = p_union_id;

  -- 5. Atomic: credit club owner's chip balance
  UPDATE public.club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount
    WHERE club_id = p_club_id AND role = 'owner';

  -- 6. Atomic: log audit row in CORRECT table (BUG 011 FIX - was union_transactions)
  INSERT INTO public.union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes
  ) VALUES (
    p_union_id, 'main', 'debit', p_amount, v_union_balance - p_amount, 'send_to_club',
    p_club_id, COALESCE(p_notes, 'Union chip distribution')
  );

  RETURN TRUE;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_send_chips_to_club(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated, service_role;

-- The union house (203) owns club 104, whose clubs.owner_id is 901.
INSERT INTO club_members(user_id,club_id,chip_balance,role,status)
 VALUES(fixture.u(901),fixture.u(104),0,'owner','active')
 ON CONFLICT (club_id,user_id) DO UPDATE SET role='owner',status='active';
INSERT INTO club_members(user_id,club_id,chip_balance,role,status)
 VALUES(fixture.u(906),fixture.u(104),0,'owner','active')
 ON CONFLICT (club_id,user_id) DO UPDATE SET role='owner',status='active';
UPDATE union_wallets SET chip_balance=chip_balance+1000 WHERE union_id=fixture.u(203);

-- THE DEFECT, AS THE INSTALLED PREDECESSOR ANSWERS IT.
--
-- Three things this asks, and one it discovered. The predecessor lets a caller
-- who is neither the union owner nor the engine reach the money; it credits
-- every role='owner' row against a single debit; it writes no journal leg and
-- carries no key. And it cannot COMPLETE: step 6 inserts its audit row with
-- wallet='main', which union_wallet_transactions_wallet_check does not permit,
-- so the whole transfer aborts at that INSERT and rolls the debit and the
-- double credit back with it. That, not only the absence of callers, is why no
-- chip has ever gone through this door.
DO $mints$
DECLARE
 bank_before numeric; owners_before numeric; fired text; state text;
BEGIN
 SELECT chip_balance INTO bank_before FROM union_wallets WHERE union_id=fixture.u(203);
 SELECT COALESCE(sum(chip_balance),0) INTO owners_before FROM club_members
  WHERE club_id=fixture.u(104) AND role='owner';
 PERFORM fixture.assert((SELECT count(*) FROM club_members WHERE club_id=fixture.u(104) AND role='owner')=2,
  'the club carries two role=owner rows, which is the minting condition');

 -- An ordinary club member's browser JWT - not the union owner, not the engine.
 BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000907"}',true);
  PERFORM public.fn_union_send_chips_to_club(fixture.u(203),fixture.u(104),100.00,'preimage');
  fired:='<the predecessor completed>';
 EXCEPTION WHEN OTHERS THEN fired:=SQLERRM; state:=SQLSTATE; END;
 PERFORM set_config('request.jwt.claims','{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}',true);

 -- It did not stop on authorization, on an ambiguous owner, on a missing key or
 -- on anything it checked. It stopped on its own audit row.
 PERFORM fixture.assert(state='23514' AND fired LIKE '%union_wallet_transactions_wallet_check%',
  'the predecessor reaches its own audit row before anything refuses it, and dies there on wallet=main: '||COALESCE(state,'<null>')||' '||COALESCE(fired,'<null>'));
 PERFORM fixture.assert((SELECT chip_balance FROM union_wallets WHERE union_id=fixture.u(203))=bank_before
   AND (SELECT COALESCE(sum(chip_balance),0) FROM club_members WHERE club_id=fixture.u(104) AND role='owner')=owners_before,
  'the aborted transfer rolled its debit and its double credit back together');
 RAISE NOTICE 'PREIMAGE-JAMMED % %', state, fired;
END $mints$;

-- AND THE MINT IS IN THE BODY, NOT AN INFERENCE. One debit statement, and a
-- credit whose WHERE names a role rather than the user it just resolved.
DO $shape$
DECLARE src text;
BEGIN
 SELECT pg_get_functiondef(oid) INTO src FROM pg_proc
  WHERE oid='public.fn_union_send_chips_to_club(uuid,uuid,numeric,text)'::regprocedure;
 PERFORM fixture.assert(strpos(src,'WHERE club_id = p_club_id AND role = ''owner'' LIMIT 1')>0,
  'the predecessor resolves ONE owner with LIMIT 1 and no ORDER BY');
 PERFORM fixture.assert(strpos(src,'SET chip_balance = COALESCE(chip_balance, 0) + p_amount')>0
   AND strpos(src,'WHERE club_id = p_club_id AND role = ''owner'';')>0,
  'and then credits EVERY role=owner row, against a single union debit');
 PERFORM fixture.assert(strpos(src,'fn_caller_is_engine')=0 AND strpos(src,'owner_id')=0 AND strpos(src,'auth.uid')=0,
  'the predecessor has no authorization check of any kind');
 PERFORM fixture.assert(strpos(src,'idempotency')=0 AND strpos(src,'op_id')=0,
  'the predecessor carries no idempotency key');
 PERFORM fixture.assert(strpos(src,'chip_ledger')=0 AND strpos(src,'fn_ca_declare_ledger')=0,
  'the predecessor writes no chip_ledger leg and declares no route');
 PERFORM fixture.assert(strpos(src,'union_clubs')=0,
  'the predecessor never checks that the club is even in the union');
END $shape$;

-- Put the fixture estate back where the candidate's regression expects it: one
-- owner row, the minted chips removed, the audit row and any journal legs the
-- platform's own triggers wrote left exactly as they were written.
DELETE FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(906);
UPDATE club_members SET chip_balance=0 WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
SELECT fixture.assert((SELECT COALESCE(sum(chip_balance),0) FROM club_members WHERE club_id=fixture.u(104) AND role='owner')=0,
 'the preimage leaves exactly one owner row, holding nothing, for the candidate regression');
