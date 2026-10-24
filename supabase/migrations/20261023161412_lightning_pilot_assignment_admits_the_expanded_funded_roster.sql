-- 20261023161412_lightning_pilot_assignment_admits_the_expanded_funded_roster.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Owner, 2026-10-23 11:06 America/Chicago: "FINISH UP ANY AND ALL REMAINING
-- WORK, AND USE AS MANY FUNDED PILOT HORSES AS YOU NEED". Measured: the funded
-- 72 fill both six-seat pilots (18 seats each) from the 05:00 UTC day rollover
-- until about 13:00 UTC, then daily caps empty Madness by mid-afternoon. The
-- expansion operation (docs/lightning/PILOT-ROSTER-EXPANSION-2026-10-23.json)
-- adds 72 more existing horses through the normal join, approve and club bank
-- doors. This migration lets the standing assignment name exactly those 144.
--
-- * fn_lightning_pilot_assignment_players_20261023(): the exact sorted 144
--   (docs/lightning/PILOT-ASSIGNMENT-MANIFEST-2026-10-23.json, SHA256
--   3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820).
-- * The assignment row admits exactly one of the two reviewed manifests, each
--   with its own exact list. The 2026-10-17 manifest and its 72 stay valid.
-- * fn_lightning_pilot_assignment_set accepts either reviewed manifest and now
--   records the manifest and list it was given on the row, so an assign with
--   the 144 manifest makes the 144 the standing assignment. Everything else in
--   it (owner-only live session, request idempotency, active-member and pilot
--   scope checks, receipts) is unchanged.
-- * The zero-cost withdrawal door and its receipt read admit a participant of
--   either reviewed manifest, so a newly assigned horse has the same normal
--   pre-start withdrawal as the original 72.
-- * fn_lightning_rollout_readiness recognizes the reviewed control by the md5
--   of its definition; that pin moves to the new definition, computed here.
--
-- No membership, wallet, seat, booking or ledger row is written. The table is
-- a one-row control table, not a hot table; one short lock_timeout, no retry.
-- @live-proof: (SELECT pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure) LIKE '%3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820%' AND cardinality(public.fn_lightning_pilot_assignment_players_20261023())=144 AND to_regprocedure('public.fn_lightning_pilot_assignment_players_20261023()') IS NOT NULL)

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure)) <> '42ad4c77c5fbf91c56ba84401a8acb31'
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pilot_assignment
                     WHERE club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'
                       AND manifest_sha256='121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a'
                       AND player_ids=public.fn_lightning_pilot_assignment_players())
     OR cardinality(public.fn_lightning_pilot_assignment_players()) <> 72 THEN
    RAISE EXCEPTION 'Lightning pilot assignment expansion predecessor mismatch';
  END IF;
END $pre$;

CREATE FUNCTION public.fn_lightning_pilot_assignment_players_20261023() RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path TO public,pg_temp AS $players$ SELECT ARRAY['0097309f-2864-4d09-b02b-56bca012a9c3'::uuid,'00d92d99-be9f-4e63-8ab0-ec2d6d491bcc'::uuid,'01bd8786-371e-4ba2-85d6-baab469bba07'::uuid,'02c8d806-24c7-40bd-b5b5-30cf96811e3e'::uuid,'02f807c7-52a6-470b-a465-4a45b84a9143'::uuid,'032b7ef6-ef40-4eb7-9a44-21605be733c8'::uuid,'03951af5-7cf1-4164-aaf0-571b647d98d5'::uuid,'04910a99-8757-4581-8c84-12ba8a454a75'::uuid,'05835920-da9b-4739-8fa2-2901b844d11d'::uuid,'05a38e8e-ce5f-44fb-82de-782369bf9fab'::uuid,'060c946d-db8d-4d27-b1ec-a203435764f1'::uuid,'06f16138-70cd-49e5-89b3-aec698118b81'::uuid,'07534039-d056-45bb-adcd-1415ed6a8a08'::uuid,'07db1c71-d567-46dd-8f92-e922b6d470ae'::uuid,'085524dc-e663-4dad-abc5-8442450cc9f1'::uuid,'0860d731-0d86-409a-8384-41a17b99a1f4'::uuid,'096d7521-f924-461e-8c3d-5386a7770170'::uuid,'09dd202d-115b-49ae-afa8-cb528c7b8f72'::uuid,'09faf9f3-ed77-4582-9242-c464cb88fa93'::uuid,'0a1e9f3a-87c2-4a4b-b386-3b88de4ed054'::uuid,'0a558bc1-50c5-4201-b6ca-c7a1e7de1c22'::uuid,'0a714eff-ef23-4928-b2a7-addecc97b467'::uuid,'0a9625c9-f679-4d98-9ebe-d8bb005c45b6'::uuid,'0b1a64c2-8970-4f89-a396-9863e3aa2ccc'::uuid,'0bea449d-73af-4654-bf19-61db087d7d45'::uuid,'0c7ad36f-7ad2-4faa-963f-69ee2f9f5062'::uuid,'0f14f372-0c43-47ff-9257-1324a7e94488'::uuid,'0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid,'10d08b4f-f6da-41ea-a66c-e97a0d4930e0'::uuid,'1110a1ed-fcf2-423b-9d9a-bc615a16cbd5'::uuid,'1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid,'119d8e7f-1b09-4299-810e-89dc9a6a6277'::uuid,'127bff9a-8483-4018-80ac-21d7f76ce5c7'::uuid,'171038e5-f50e-4bdd-988f-621a7ce9479c'::uuid,'194e5206-bd4d-4ea5-ba2d-142c8bf8a258'::uuid,'19ab1b66-ddba-4b06-bea0-f55c9a3100c7'::uuid,'19de9af5-6576-4ebb-92c6-1fe53599f782'::uuid,'204a6a80-8b83-4cff-98ed-e89f4da7c4dc'::uuid,'2072ad2e-869c-4537-a3dd-0def0c889401'::uuid,'2143ec37-02ed-4712-9642-a56f1945c379'::uuid,'227ba92c-9b8c-4705-ba76-181f1f697638'::uuid,'22f02ebc-4757-4e06-99e6-f7e4a95720b4'::uuid,'24219aee-cce4-4660-9e80-fac05602aeae'::uuid,'24d7c0ff-1b60-453c-8095-836594f30125'::uuid,'2610f833-88cd-4a55-b255-75b75070b5da'::uuid,'26bb68d8-e995-433e-b364-f953aa198783'::uuid,'26fc77c4-60fc-406b-bf17-5f4b35777ec7'::uuid,'285055c6-96a7-4a60-9033-51f83f49dbcb'::uuid,'28d30605-63d5-4fc7-ba26-3ecb1a04ccd1'::uuid,'2936c42b-ebe2-4fd8-bc70-eee5e263d014'::uuid,'2958f800-0cca-43a8-8486-08e524434199'::uuid,'2de39d61-a269-451a-9e7c-37fc1aa25ad7'::uuid,'30064fc2-f1cd-45b3-90d0-c83416a420d3'::uuid,'3086452e-9b29-47eb-b6f8-5a9692889753'::uuid,'36786473-723c-4104-b39d-eec5bbdeb763'::uuid,'373a7bc7-1505-4c4c-b6b0-ba437b569a8a'::uuid,'3926befc-fcc1-4517-9225-a55519e522c3'::uuid,'39708430-d0ed-4eb7-9cfa-24abd3fe2df2'::uuid,'39ce9f37-11f8-4f84-a192-b4312a93ba31'::uuid,'3c1d70c8-c46a-4e2c-bcc8-dbe53798799a'::uuid,'3de60526-267e-40be-ab58-f354bf9febc2'::uuid,'3e4ff3e2-f212-4966-abe7-4988e5a62704'::uuid,'3faa1e32-afb8-4b21-9530-2a9fd81c5766'::uuid,'4533f594-2fbf-401a-915a-66b9dca698eb'::uuid,'47731cb8-58a5-4a83-822d-8e5f8cd8af73'::uuid,'47dd33b3-1bd6-41a7-951e-8582dae98c5a'::uuid,'48ada431-72b1-4cdb-8abe-541b9f6b179c'::uuid,'4a686160-2102-4cba-b3e5-cfa3b1856602'::uuid,'4b2d172a-b413-4ae5-9965-32aeefa0e849'::uuid,'4ce9fa05-703f-40e4-a14e-40cffc3ba305'::uuid,'4e6679f8-7ad4-4551-8ab6-8a1168ed95e3'::uuid,'4ed0fef4-d9fd-41d0-852d-4a52f4193dd2'::uuid,'4ffcc7ec-15a1-4c80-8309-e893ef9db022'::uuid,'54a0a8e8-a5e6-4b62-8855-9d68fe69ee6d'::uuid,'54f31d33-cc00-4e5a-b562-fb51aa43ff4a'::uuid,'57f5490a-a29d-42b5-a0e3-c115abf471e9'::uuid,'5bb61f42-52d5-4dad-b1e9-c839504dd928'::uuid,'5c3c64a2-4459-44a2-9381-e73a4cd5d0c5'::uuid,'5ee0f97f-537b-41b2-a6e3-c7dc3b01938e'::uuid,'6162b471-d011-41f7-ad89-9a8d856c9ffb'::uuid,'62f0d4da-b736-4629-ad14-894e432d0f04'::uuid,'649d02d1-ce26-4c24-adde-b3f428ec2353'::uuid,'64ad9eeb-d4cf-43a1-bcb3-bc580f902361'::uuid,'697d34f5-fe65-422a-b624-5a4957ef4196'::uuid,'6a48eec0-2efe-447a-b902-13a4de739e53'::uuid,'6d301010-3315-4694-b55d-812ae56110c5'::uuid,'6e53238e-0b78-4a67-b7a2-eed9e8e7d9b3'::uuid,'753e81a9-1513-4923-be2b-bd684ed7133c'::uuid,'778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid,'78d65d90-7234-4d43-816e-9c29e81dd33d'::uuid,'7d1b678f-cea8-41fc-873e-2ec47ea5c318'::uuid,'7d7a80a2-092c-4338-878a-0416611b249c'::uuid,'7effd428-e607-4430-b383-47c438b10143'::uuid,'82861181-5a96-4e7b-bfa4-b75ca2bd145f'::uuid,'8376185d-fab8-483c-a004-52c8a5cce763'::uuid,'84385ab0-d3ea-44c1-8e93-6fa6b1d25457'::uuid,'86468a23-14cb-4602-92f7-7e270197fc3c'::uuid,'878cdf61-681e-464a-8eb4-989951a978a6'::uuid,'897ad7c5-d734-4758-9ef9-29230c4b68ee'::uuid,'8cd4e346-50a2-4335-a998-c958cff2e260'::uuid,'8e5a0e02-7832-416d-970f-f6f74e181dcb'::uuid,'92cd4964-6206-4989-9730-b7959bae6dc5'::uuid,'97bdc83a-7e7c-45ed-acf5-a9b48309fdba'::uuid,'98327012-ff16-4a4c-a6b6-3f5e6e3cba2a'::uuid,'98b62cbe-0d51-474c-88e1-f89d022899fc'::uuid,'9955b043-1a7c-4eb0-8130-97eb9fdecce4'::uuid,'9a3debc9-04a0-4006-946b-801a481e07ea'::uuid,'9e5d90d4-efff-49e8-a93e-29d755eed6ca'::uuid,'9eb2a231-a42f-4162-8818-3f14ebc19385'::uuid,'a23ca5c9-b748-482f-9b59-9db35f7aa996'::uuid,'a53766a4-b9bc-4321-b37c-f220b2877910'::uuid,'a5e2f927-126c-454a-ae28-840b56bdb1dd'::uuid,'a7d90ad1-1f5f-49dc-958a-051ad859d20d'::uuid,'aab5a8fc-f3a8-4f7f-b5fc-5c2e61553caf'::uuid,'ac254a0e-a02b-49be-993d-e89a5803a653'::uuid,'ad0c8518-f9e3-4341-a1db-dccf83145838'::uuid,'b23d2455-d884-42e4-901a-369db50e5cd0'::uuid,'b2e5bf5b-f6f3-4156-8998-29831e390fa3'::uuid,'b6ef1688-0c5d-4f2e-a8a5-83363d415e78'::uuid,'b7804a7e-c068-4496-bee4-c3a582a33816'::uuid,'b83fa747-e51f-46c0-85d7-6a2f68417309'::uuid,'badcd43c-1a7c-4a71-82d2-a2315758d8ed'::uuid,'bd968722-f2c3-43f8-8bfd-77294aac9ca9'::uuid,'c080ed25-5d53-460c-bdcf-64e02a9d416a'::uuid,'c1b575fb-3efd-43b6-b314-353e1d300aaa'::uuid,'c398e806-141b-49f9-9ea5-26d688b4c269'::uuid,'cda69887-ebc4-47e5-a4ce-6e3c810b168c'::uuid,'cf17ebeb-7337-45c4-97fd-d1a7fd3286ad'::uuid,'d14e36cb-8912-4b12-add7-e26357bf832b'::uuid,'d27e6658-0fb0-4ccb-b6a7-4aa9dd64c37d'::uuid,'d2a962f7-cdcb-430a-8ea4-8a50323636cb'::uuid,'d49f4819-3a2e-4342-a15a-97edd5abfec5'::uuid,'d6cd970a-844a-4531-ae66-479583567335'::uuid,'e8bdc776-c4f5-49b6-977c-770ecce4a6f0'::uuid,'ea06617e-0710-4590-b4db-772cd0fa4326'::uuid,'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f'::uuid,'f1090e07-a6c9-4b37-acb5-b4dd4f191ce5'::uuid,'f538775f-6f49-4519-8277-adf9176e939c'::uuid,'f687be6b-fef1-4713-be59-9ed6e8b55eef'::uuid,'f77cb4c6-6fc4-45e9-bc6b-7791205391be'::uuid,'f829c7e3-85e1-4f7b-83d8-7f7b2e11d2ee'::uuid,'f83a8613-1969-402b-81a4-05ae7f164bb4'::uuid,'fb5fe9fe-2fe9-4970-b152-f08871ffec61'::uuid,'fb7c947d-79ce-4706-8c33-bb4f39359c59'::uuid] $players$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_assignment_players_20261023() FROM PUBLIC,anon,authenticated,service_role;

DO $shape$
DECLARE v uuid[] := public.fn_lightning_pilot_assignment_players_20261023();
BEGIN
  IF cardinality(v) <> 144
     OR (SELECT count(DISTINCT x) FROM unnest(v) x) <> 144
     OR v IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v) x)
     OR NOT (public.fn_lightning_pilot_assignment_players() <@ v) THEN
    RAISE EXCEPTION 'Lightning pilot expanded manifest shape mismatch';
  END IF;
END $shape$;

ALTER TABLE public.lightning_pilot_assignment
  DROP CONSTRAINT lightning_pilot_assignment_manifest_sha256_check,
  DROP CONSTRAINT lightning_pilot_assignment_player_ids_check,
  ADD CONSTRAINT lightning_pilot_assignment_reviewed_manifest_check CHECK (
    (manifest_sha256='121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a' AND player_ids=public.fn_lightning_pilot_assignment_players())
    OR (manifest_sha256='3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820' AND player_ids=public.fn_lightning_pilot_assignment_players_20261023()));

CREATE OR REPLACE FUNCTION public.fn_lightning_pilot_assignment_set(p_active boolean, p_request_id uuid, p_manifest_sha256 text, p_player_ids uuid[], p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '15s'
AS $function$
DECLARE prior public.lightning_pilot_assignment_receipts%ROWTYPE; v_players uuid[]; v_expected uuid[]; v_result jsonb;
BEGIN
 IF auth.uid() IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR public.fn_caller_session_is_live() IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'pilot assignment not authorized' USING ERRCODE='42501'; END IF;
 v_expected:=CASE p_manifest_sha256
   WHEN '121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a' THEN public.fn_lightning_pilot_assignment_players()
   WHEN '3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820' THEN public.fn_lightning_pilot_assignment_players_20261023() END;
 IF p_active IS NULL OR p_request_id IS NULL OR v_expected IS NULL OR length(btrim(coalesce(p_reason,'')))<12 THEN
 RAISE EXCEPTION 'pilot assignment input mismatch' USING ERRCODE='22023'; END IF;
 SELECT array_agg(x ORDER BY x) INTO v_players FROM unnest(p_player_ids) x;
 IF cardinality(v_players) IS DISTINCT FROM cardinality(v_expected) OR v_players IS DISTINCT FROM v_expected THEN
 RAISE EXCEPTION 'pilot assignment participant manifest mismatch' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(176217,72);
 SELECT * INTO prior FROM public.lightning_pilot_assignment_receipts WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM auth.uid() OR prior.active IS DISTINCT FROM p_active OR prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256 OR prior.player_ids IS DISTINCT FROM v_players OR prior.reason IS DISTINCT FROM btrim(p_reason) THEN
   RAISE EXCEPTION 'pilot assignment request intent mismatch' USING ERRCODE='22023'; END IF;
  RETURN prior.receipt;
 END IF;
 IF p_active THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND owner_id=auth.uid() AND is_public=false)
  OR EXISTS(SELECT 1 FROM unnest(v_players) x LEFT JOIN public.profiles p ON p.id=x LEFT JOIN public.club_members cm ON cm.user_id=x AND cm.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' WHERE p.is_horse IS DISTINCT FROM true OR p.status IS DISTINCT FROM 'active' OR cm.status IS NULL OR cm.status NOT IN('active','approved') OR cm.user_id IS NULL)
  OR (SELECT count(*) FROM public.cash_games WHERE (id='56d5d6f0-23e9-41b0-b407-852aa1026c2a' AND template_name='action' AND ruleset_snapshot->>'template'='action' OR id='0cdc133d-ad23-4ace-bb85-312d0f221edd' AND template_name='madness' AND ruleset_snapshot->>'template'='madness') AND club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d')<>2 THEN
   RAISE EXCEPTION 'pilot assignment current scope changed' USING ERRCODE='55000'; END IF;
 END IF;
 UPDATE public.lightning_pilot_assignment SET active=p_active,player_ids=v_players,manifest_sha256=p_manifest_sha256,last_request_id=p_request_id,updated_at=clock_timestamp()
 WHERE club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d';
 IF NOT FOUND THEN RAISE EXCEPTION 'pilot assignment state missing' USING ERRCODE='55000'; END IF;
 v_result:=public.fn_lightning_pilot_assignment_status()||jsonb_build_object('ok',true);
 INSERT INTO public.lightning_pilot_assignment_receipts(request_id,actor_id,active,manifest_sha256,player_ids,reason,receipt) VALUES(p_request_id,auth.uid(),p_active,p_manifest_sha256,v_players,btrim(p_reason),v_result);
 RETURN v_result;
END $function$;

DO $repoint$
DECLARE
  v_old_call text := 'public.fn_lightning_pilot_assignment_players()';
  v_new_call text := '(public.fn_lightning_pilot_assignment_players()||public.fn_lightning_pilot_assignment_players_20261023())';
  v_fn regprocedure;
  v_before text;
  v_cat record;
  v_set_md5 text := md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure));
  v_old_pin text := '42ad4c77c5fbf91c56ba84401a8acb31';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)'::regprocedure,
                              'public.fn_lightning_pilot_withdrawal_receipt(uuid,uuid,uuid,uuid)'::regprocedure] LOOP
    v_before := pg_get_functiondef(v_fn);
    SELECT proowner,proacl,proconfig,prosecdef,provolatile INTO v_cat FROM pg_proc WHERE oid=v_fn;
    IF (length(v_before)-length(replace(v_before,v_old_call,'')))/length(v_old_call) <> 1 THEN
      RAISE EXCEPTION 'Lightning pilot withdrawal participant read occurrence mismatch: %', v_fn;
    END IF;
    EXECUTE replace(v_before,v_old_call,v_new_call);
    IF replace(pg_get_functiondef(v_fn),v_new_call,v_old_call) <> v_before
       OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_fn AND
         (proowner IS DISTINCT FROM v_cat.proowner OR proacl IS DISTINCT FROM v_cat.proacl
          OR proconfig IS DISTINCT FROM v_cat.proconfig OR prosecdef IS DISTINCT FROM v_cat.prosecdef
          OR provolatile IS DISTINCT FROM v_cat.provolatile)) THEN
      RAISE EXCEPTION 'Lightning pilot withdrawal door changed unrelated source or authority: %', v_fn;
    END IF;
  END LOOP;

  v_fn := 'public.fn_lightning_rollout_readiness(uuid)'::regprocedure;
  v_before := pg_get_functiondef(v_fn);
  SELECT proowner,proacl,proconfig,prosecdef,provolatile INTO v_cat FROM pg_proc WHERE oid=v_fn;
  IF (length(v_before)-length(replace(v_before,v_old_pin,'')))/length(v_old_pin) <> 1 THEN
    RAISE EXCEPTION 'Lightning readiness control pin occurrence mismatch';
  END IF;
  EXECUTE replace(v_before,v_old_pin,v_set_md5);
  IF replace(pg_get_functiondef(v_fn),v_set_md5,v_old_pin) <> v_before
     OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_fn AND
       (proowner IS DISTINCT FROM v_cat.proowner OR proacl IS DISTINCT FROM v_cat.proacl
        OR proconfig IS DISTINCT FROM v_cat.proconfig OR prosecdef IS DISTINCT FROM v_cat.prosecdef
        OR provolatile IS DISTINCT FROM v_cat.provolatile)) THEN
    RAISE EXCEPTION 'Lightning readiness changed unrelated source or authority';
  END IF;
  IF md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure)) <> v_set_md5
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname LIKE 'fn\_lightning\_%'
                   AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Lightning pilot assignment expansion post-condition failed';
  END IF;
END $repoint$;

COMMIT;
