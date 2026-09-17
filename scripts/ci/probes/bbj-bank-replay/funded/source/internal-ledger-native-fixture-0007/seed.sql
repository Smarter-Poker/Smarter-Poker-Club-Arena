-- FUTURE PRIVATE NATIVE FIXTURE ONLY. Never target a shared database.
-- Synthetic policy values are finite bounds for exactly one 100000-chip opening
-- grant and one 500-Diamond signup grant, not recovered production house rules.
BEGIN;
SET LOCAL application_name = 'g8-ledger-fixture-seed';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','7beef002-0002-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"7beef002-0002-4000-8000-000000000001"}',true);
INSERT INTO public.ca_mint_policy
 (id,per_operation_cap_chips,rolling_24h_cap_chips,
  per_operation_cap_diamonds,rolling_24h_cap_diamonds,note)
VALUES (1,100000,100000,500,500,'Synthetic bounded native fixture policy; no production policy claim');
-- Let the genuine GENERATED ALWAYS identity sequence allocate the epoch.
-- Readers resolve is_current; no financial contract requires the literal id 1.
INSERT INTO public.ca_financial_epochs(name,description,is_current)
VALUES ('g8-native-fixture-0002','Synthetic local epoch; no copied financial rows',true);
DO $epoch$
DECLARE v_epoch integer;
BEGIN
 SELECT id INTO STRICT v_epoch FROM public.ca_financial_epochs
  WHERE name='g8-native-fixture-0002' AND is_current;
 IF v_epoch IS NULL OR public.fn_ca_current_epoch() IS DISTINCT FROM v_epoch THEN
  RAISE EXCEPTION 'Generated fixture epoch is not the actual current epoch';
 END IF;
END $epoch$;

-- Real signup hooks create the profile, registered grant and side mirrors.
-- The reserved invalid address deliberately takes the real social-autoconnect
-- exclusion. It also classifies as certification equipment; no non-cert claim.
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
                       email_confirmed_at,created_at,updated_at,is_super_admin)
VALUES ('7beef002-0002-4000-8000-000000000001','authenticated','authenticated',
        'g8ledger0002@smarter-poker.invalid','{"provider":"email","providers":["email"]}',
        '{"full_name":"Native Ledger Fixture","poker_alias":"LedgerFx0002"}',
        now(),now(),now(),false);
SET CONSTRAINTS ALL IMMEDIATE;
DO $seed$
BEGIN
 IF NOT EXISTS (SELECT FROM public.profiles WHERE id='7beef002-0002-4000-8000-000000000001'
                AND diamonds=500 AND COALESCE(is_horse,false)=false) THEN
  RAISE EXCEPTION 'Real signup did not produce the required human profile and grant';
 END IF;
 IF EXISTS (SELECT FROM public.signup_errors) THEN
  RAISE EXCEPTION 'Real signup caught an error: inspect signup_errors';
 END IF;
 IF NOT EXISTS (SELECT FROM public.ca_mint_ledger
                WHERE op_id='signup:7beef002-0002-4000-8000-000000000001'
                  AND asset='diamonds' AND amount=500 AND diamond_tx_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Signup grant lacks its real mint/journal receipt';
 END IF;
END $seed$;

-- Real seeder and after-insert register provide the opening treasury.
-- The deferred owner-wallet trigger supplies active owner membership at zero.
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO public.clubs(id,name,owner_id,asset,is_union)
VALUES ('7beef002-0002-4000-8000-000000000002','Native Ledger Fixture',
        '7beef002-0002-4000-8000-000000000001','chips',false);
SET CONSTRAINTS ALL IMMEDIATE;
DO $seed$
BEGIN
 IF NOT EXISTS (SELECT FROM public.clubs WHERE id='7beef002-0002-4000-8000-000000000002'
                AND chip_treasury=100000 AND union_id IS NULL) THEN
  RAISE EXCEPTION 'Real opening-bank seed failed';
 END IF;
 IF NOT EXISTS (SELECT FROM public.club_members
                WHERE club_id='7beef002-0002-4000-8000-000000000002'
                  AND user_id='7beef002-0002-4000-8000-000000000001'
                  AND role='owner' AND status='active' AND chip_balance=0) THEN
  RAISE EXCEPTION 'Real deferred owner-wallet seed failed';
 END IF;
 IF (SELECT count(*) FROM public.chip_ledger
      WHERE idempotency_key='club-opening-grant:7beef002-0002-4000-8000-000000000002'
        AND amount=100000 AND from_type='issuance_reserve' AND to_type='club_treasury'
        AND to_entity_id='7beef002-0002-4000-8000-000000000002') <> 1 THEN
  RAISE EXCEPTION 'Opening grant is not exactly journaled';
 END IF;
 IF NOT EXISTS (SELECT FROM public.ca_mint_ledger m JOIN public.chip_ledger l ON l.id=m.chip_ledger_id
                WHERE m.op_id='club-opening-grant:7beef002-0002-4000-8000-000000000002'
                  AND m.amount=100000 AND m.asset='chips') THEN
  RAISE EXCEPTION 'Opening grant is not registered against the real journal leg';
 END IF;
 IF EXISTS (SELECT FROM public.ca_ledger_write_failures) THEN
  RAISE EXCEPTION 'Seed swallowed a journal/audit failure';
 END IF;
 IF EXISTS (SELECT FROM public.ca_account_snapshots) THEN
  RAISE EXCEPTION 'Seed must not transplant replay snapshots';
 END IF;
END $seed$;
COMMIT;
