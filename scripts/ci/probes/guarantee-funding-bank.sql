DO $probe$
DECLARE src text; r jsonb; private_case boolean; did_refuse boolean; event uuid:='00000000-0000-4000-8000-000000000001';
club uuid:='00000000-0000-4000-8000-000000000002';
event_union uuid:='00000000-0000-4000-8000-000000000003';
new_union uuid:='00000000-0000-4000-8000-000000000004';
BEGIN
CREATE TEMP TABLE tournaments(id uuid,club_id uuid,name text,union_id uuid,is_private boolean,prize_pool numeric,guaranteed_prize numeric,prize_pool_finalized boolean) ON COMMIT DROP;
CREATE TEMP TABLE clubs(id uuid,name text,union_id uuid,chip_treasury numeric,updated_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE unions(id uuid,name text) ON COMMIT DROP;
CREATE TEMP TABLE union_wallets(union_id uuid,chip_balance numeric,updated_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE union_wallet_transactions(union_id uuid,wallet text,direction text,amount numeric,balance_after numeric,tx_type text,club_id uuid,notes text) ON COMMIT DROP;
CREATE TEMP TABLE tournament_guarantee_overlays(tournament_id uuid UNIQUE,club_id uuid,amount numeric,pool_before numeric,pool_after numeric,source text,bank_type text,bank_entity_id uuid,union_id uuid,treasury_after numeric) ON COMMIT DROP;
SELECT pg_get_functiondef('public.fn_apply_prize_guarantee(uuid,text)'::regprocedure) INTO src; EXECUTE replace(src,'public.','pg_temp.');
INSERT INTO pg_temp.clubs VALUES(club,'test club',new_union,100,now());
INSERT INTO pg_temp.unions VALUES(event_union,'event union'),(new_union,'new union');
INSERT INTO pg_temp.union_wallets VALUES(event_union,100,now()),(new_union,100,now());
INSERT INTO pg_temp.tournaments VALUES(event,club,'test event',event_union,false,60,100,false);
r:=pg_temp.fn_apply_prize_guarantee(event);
IF (SELECT chip_balance FROM pg_temp.union_wallets WHERE union_id=event_union)<>60 OR (SELECT chip_balance FROM pg_temp.union_wallets WHERE union_id=new_union)<>100 OR (SELECT chip_treasury FROM pg_temp.clubs)<>100 OR (SELECT bank_entity_id FROM pg_temp.tournament_guarantee_overlays)<>event_union THEN RAISE EXCEPTION 'FAIL guarantee follows current club union instead of event union'; END IF;
r:=pg_temp.fn_apply_prize_guarantee(event);
IF (SELECT chip_balance FROM pg_temp.union_wallets WHERE union_id=event_union)<>60 OR (SELECT count(*) FROM pg_temp.tournament_guarantee_overlays)<>1 THEN RAISE EXCEPTION 'FAIL replay duplicate funding'; END IF;
-- A private event and an event with no union both fund from their club.
FOREACH private_case IN ARRAY ARRAY[true,false] LOOP
TRUNCATE pg_temp.tournament_guarantee_overlays;
UPDATE pg_temp.clubs SET chip_treasury=100;
UPDATE pg_temp.union_wallets SET chip_balance=100;
UPDATE pg_temp.tournaments SET is_private=private_case,union_id=CASE WHEN private_case THEN event_union ELSE NULL END,prize_pool=60,prize_pool_finalized=false;
r:=pg_temp.fn_apply_prize_guarantee(event);
IF (SELECT chip_treasury FROM pg_temp.clubs)<>60 OR EXISTS(SELECT 1 FROM pg_temp.union_wallets WHERE chip_balance<>100) OR (SELECT bank_type FROM pg_temp.tournament_guarantee_overlays)<>'club' OR (SELECT prize_pool FROM pg_temp.tournaments)<>100 THEN RAISE EXCEPTION 'FAIL private or standalone event debited union'; END IF;
END LOOP;
-- Existing absent-union-bank fallback remains available.
TRUNCATE pg_temp.tournament_guarantee_overlays;
DELETE FROM pg_temp.union_wallets WHERE union_id=event_union;
UPDATE pg_temp.clubs SET chip_treasury=100;
UPDATE pg_temp.tournaments SET is_private=false,union_id=event_union,prize_pool=60,prize_pool_finalized=false;
r:=pg_temp.fn_apply_prize_guarantee(event);
IF (SELECT chip_treasury FROM pg_temp.clubs)<>60 OR (SELECT bank_type FROM pg_temp.tournament_guarantee_overlays)<>'club' OR (SELECT bank_entity_id FROM pg_temp.tournament_guarantee_overlays)<>club THEN RAISE EXCEPTION 'FAIL absent union bank fallback'; END IF;
-- Missing both banks must roll back the overlay claim and pool change.
FOREACH private_case IN ARRAY ARRAY[true,false] LOOP
TRUNCATE pg_temp.tournament_guarantee_overlays;
DELETE FROM pg_temp.clubs;
DELETE FROM pg_temp.union_wallets WHERE union_id=event_union;
UPDATE pg_temp.tournaments SET is_private=private_case,union_id=event_union,prize_pool=60,prize_pool_finalized=false;
did_refuse:=false;
BEGIN
  r:=pg_temp.fn_apply_prize_guarantee(event);
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'guarantee_funding_bank_missing:%' THEN RAISE; END IF;
  did_refuse:=true;
END;
IF NOT did_refuse THEN RAISE EXCEPTION 'FAIL missing funding bank accepted and pool finalized'; END IF;
IF EXISTS(SELECT 1 FROM pg_temp.tournament_guarantee_overlays) OR (SELECT prize_pool FROM pg_temp.tournaments) IS DISTINCT FROM 60 OR (SELECT prize_pool_finalized FROM pg_temp.tournaments) IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL missing bank left an overlay claim or funded pool'; END IF;
END LOOP;
-- No overlay requires no bank debit.
UPDATE pg_temp.tournaments SET prize_pool=100,prize_pool_finalized=false;
r:=pg_temp.fn_apply_prize_guarantee(event);
IF r->>'ok' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM pg_temp.tournament_guarantee_overlays) THEN RAISE EXCEPTION 'FAIL fully player-funded pool required a bank'; END IF;
RAISE EXCEPTION 'AUDIT_TEST_PASS: actual guarantee function refuses absent direct/fallback banks with rollback, preserves funded pools, ownership, private/standalone funding, replay and union fallback; all rolled back';
END $probe$;
