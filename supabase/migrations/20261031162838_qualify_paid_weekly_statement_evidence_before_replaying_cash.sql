-- Version reserved by scripts/new-migration.mjs against protected main and remote branches.
-- A paid weekly book exhausted its tick before the original statement proof.
-- Give that original proof a nonpaying visit before replaying conservation and
-- cascade checks; a later memo-seeded visit retains every original money and
-- document gate. The original R2/R3 replay and memo eligibility are mandatory.
-- Keep null/error/refused quality closed, require durable ready-report keep,
-- and reset phase state for every book. No rate, ledger, payout, schedule,
-- original inventory owner or generation changes. Advance the original weekly
-- discovery owner's exact scope pin atomically with the scope body.
-- @live-proof: md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='e4f6b4adc2f43ccd2b7ecd90f2434538' AND md5(pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure))='c2268481918932ae2d8be5a5acf72e9a' AND smarter_private.original_inventory_proof_sources_match()
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $postpaid_scope$
DECLARE d text;e text;r jsonb;p pg_proc%ROWTYPE;expected_hash text;
 expected jsonb:=$postpaid_expected_owners$[{"signature":"public.fn_accounting_close_report_is_ready(jsonb)","md5":"36a169022dd8355bcc4ec7db5a8e605f","metadata":{"oid":"182636202","proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"14","proname":"fn_accounting_close_report_is_ready","prorows":0,"pronargs":1,"proowner":"16384","proconfig":null,"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_report"],"proargtypes":["3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_accounting_close_report_keep(uuid,timestamptz,timestamptz)","md5":"84b2e7643d1892b224e344aa43da38a5","metadata":{"oid":"182636205","proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_accounting_close_report_keep","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_start","p_end"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)","md5":"28364d8f001236b1d0aefdf4aa2246fa","metadata":{"oid":"182636196","proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_accounting_close_report_memo_key","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","o","o"],"proargnames":["p_union_id","p_start","p_end","generation","memo_key"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":["2950","1184","1184","25","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)","md5":"58a9a79da50f36fa5fbc4242e8cec8f7","metadata":{"oid":"182636204","proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_accounting_close_report_seed","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_start","p_end"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_accounting_close_warm_stop()","md5":"e00f2396197ac40bd8d3d6af48872540","metadata":{"oid":"92046064","proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"14","proname":"fn_accounting_close_warm_stop","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)","md5":"39a7e057da9a65dab5d0b2f761428f13","metadata":{"oid":"34785319","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_prepare_accounting_week","prorows":0,"pronargs":4,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_club_id","p_from","p_to"],"proargtypes":["2950","2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_process_weekly_accounting_scope(uuid,uuid)","md5":"a68500342f07e0608c6eb69f4cb0739e","metadata":{"oid":"34785733","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_process_weekly_accounting_scope","prorows":0,"pronargs":2,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_club_id"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_union_pnl_close_quality(uuid,timestamptz,timestamptz)","md5":"8b5551d177b27bcbd211b8ecd9ee3a11","metadata":{"oid":"34785836","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_union_pnl_close_quality","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_start","p_end"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)","md5":"ca8931142b7e8ad6bbac07bd0913d268","metadata":{"oid":"34785826","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_union_pnl_evidence_report","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_start","p_end"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)","md5":"9dadc71929579ecb5d525f975cce9b49","metadata":{"oid":"14508400","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_union_settlement_cascade","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_period_start","p_period_end"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":"({CONST :consttype 2950 :consttypmod -1 :constcollid 0 :constlen 16 :constbyval false :constisnull false :location -1 :constvalue 16 [ 250 222 0 0 0 0 0 0 0 0 0 0 0 0 0 1 ]} {CONST :consttype 1184 :consttypmod -1 :constcollid 0 :constlen 8 :constbyval true :constisnull true :location -1 :constvalue <>} {CONST :consttype 1184 :consttypmod -1 :constcollid 0 :constlen 8 :constbyval true :constisnull true :location -1 :constvalue <>})","pronargdefaults":3}},{"signature":"public.fn_weekly_accounting_attempt_begin(boolean)","md5":"e3ed8ea6d1ba204440e2201f6f9cbc46","metadata":{"oid":"67760257","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_weekly_accounting_attempt_begin","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_memo"],"proargtypes":["16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_weekly_accounting_attempt_end()","md5":"670b36dde972d573c4838ed3e967d7bd","metadata":{"oid":"67760272","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_weekly_accounting_attempt_end","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"smarter_private.weekly_payout_eligible_scopes(timestamp with time zone,timestamp with time zone)","md5":"fd2603a21dc9c93a234afbda57d6abba","metadata":{"oid":"277353611","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"weekly_payout_eligible_scopes","prorows":1000,"pronargs":2,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t","t","t"],"proargnames":["p_end","p_now","kind","id","first_week"],"proargtypes":["1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"24465641","proallargtypes":["1184","1184","25","2950","1184"],"proargdefaults":null,"pronargdefaults":0}}]$postpaid_expected_owners$::jsonb;
 old1 text:=$postpaid_old_1$  v_report_seeded boolean := false;$postpaid_old_1$;
 new1 text:=$postpaid_new_1$  v_report_seeded boolean := false;
  v_postpaid_quality jsonb;
  v_postpaid_qualifying boolean:=false;
  v_postpaid_report_kept boolean:=false;$postpaid_new_1$;
 old2 text:=$postpaid_old_2$      BEGIN
        -- CHUNKED CLOSE: a preparation that stopped while its book's P&L$postpaid_old_2$;
 new2 text:=$postpaid_new_2$      BEGIN
        -- Qualify an already-paid book in its own nonpaying attempt before
        -- repeating the cascade. Its original conservation and document gates
        -- remain mandatory on the later, memo-seeded visit.
        v_postpaid_quality:=NULL;
        v_postpaid_qualifying:=false;
        v_postpaid_report_kept:=false;
        IF v_chunked AND NOT v_report_seeded AND NOT v_preparing_before_due
          AND v_preparation->>'success'='true'
          AND v_preparation->>'paid_scope_replay'='true'
          AND EXISTS(SELECT 1 FROM public.fn_accounting_close_report_memo_key(v_union.id,v_from,v_end) k
            WHERE k.memo_key IS NOT NULL) THEN
          v_postpaid_qualifying:=true;
          v_postpaid_quality:=public.fn_union_pnl_close_quality(v_union.id,v_from,v_end);
          v_postpaid_report_kept:=public.fn_accounting_close_report_keep(v_union.id,v_from,v_end);
        END IF;
        -- CHUNKED CLOSE: a preparation that stopped while its book's P&L$postpaid_new_2$;
 old3 text:=$postpaid_old_3$        ELSE
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN$postpaid_old_3$;
 new3 text:=$postpaid_new_3$        ELSIF v_postpaid_qualifying THEN
          IF v_postpaid_quality->>'status'='ready' AND v_postpaid_report_kept IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'weekly_postpaid_ready_report_not_kept' USING ERRCODE='55000';
          END IF;
          IF v_postpaid_quality->>'status'='ready'
            OR v_postpaid_quality->'issues'='["union_pnl_certification_in_progress"]'::jsonb THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,
              'stage','certifying','purpose','club_settlements','union_id',v_union.id,
              'period_start',v_from,'period_end',v_end,'pnl_evidence',v_postpaid_quality);
          ELSE
            RAISE EXCEPTION 'union_pnl_basis_uncertified' USING ERRCODE='55000',DETAIL=COALESCE(v_postpaid_quality::text,'null');
          END IF;
        ELSE
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN$postpaid_new_3$;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' THEN RAISE EXCEPTION 'postpaid_scope_operator_required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261031162838')THEN RAISE EXCEPTION 'postpaid_scope_version_already_installed';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'postpaid_scope_maintenance_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM 'original-inventory-245-v1:05f51b14eb6ebcb361fd88f7ba7a7343' THEN RAISE EXCEPTION 'postpaid_scope_original_inventory_changed';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(expected)LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(r->>'signature');
  IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM r->>'md5' OR(to_jsonb(p)-'prosrc')IS DISTINCT FROM r->'metadata'THEN RAISE EXCEPTION 'postpaid_scope_exact_preimage_changed:%',r->>'signature';END IF;
 END LOOP;
 d:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
 IF (length(d)-length(replace(d,old1,'')))/length(old1)<>1 THEN RAISE EXCEPTION 'postpaid_scope_anchor_1_changed';END IF;
 d:=replace(d,old1,new1);
 IF (length(d)-length(replace(d,old2,'')))/length(old2)<>1 THEN RAISE EXCEPTION 'postpaid_scope_anchor_2_changed';END IF;
 d:=replace(d,old2,new2);
 IF (length(d)-length(replace(d,old3,'')))/length(old3)<>1 THEN RAISE EXCEPTION 'postpaid_scope_anchor_3_changed';END IF;
 d:=replace(d,old3,new3);
 IF md5(d)IS DISTINCT FROM 'e4f6b4adc2f43ccd2b7ecd90f2434538' THEN RAISE EXCEPTION 'postpaid_scope_generated_body_changed';END IF;
 e:=pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure);
 IF(length(e)-length(replace(e,'a68500342f07e0608c6eb69f4cb0739e','')))/32<>1 THEN RAISE EXCEPTION 'postpaid_discovery_anchor_changed';END IF;
 e:=replace(e,'a68500342f07e0608c6eb69f4cb0739e','e4f6b4adc2f43ccd2b7ecd90f2434538');
 IF md5(e)IS DISTINCT FROM 'c2268481918932ae2d8be5a5acf72e9a' THEN RAISE EXCEPTION 'postpaid_discovery_generated_body_changed';END IF;
 EXECUTE d;
 EXECUTE e;
 REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
 REVOKE ALL ON FUNCTION smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
 FOR r IN SELECT value FROM jsonb_array_elements(expected)LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(r->>'signature');
  expected_hash:=CASE p.oid WHEN 'public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure THEN 'e4f6b4adc2f43ccd2b7ecd90f2434538' WHEN 'smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure THEN 'c2268481918932ae2d8be5a5acf72e9a' ELSE r->>'md5' END;
  IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM expected_hash OR(to_jsonb(p)-'prosrc')IS DISTINCT FROM r->'metadata'THEN RAISE EXCEPTION 'postpaid_scope_exact_postimage_changed:%',r->>'signature';END IF;
 END LOOP;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM 'original-inventory-245-v1:05f51b14eb6ebcb361fd88f7ba7a7343' THEN RAISE EXCEPTION 'postpaid_scope_original_inventory_changed';END IF;
END $postpaid_scope$;
COMMIT;
