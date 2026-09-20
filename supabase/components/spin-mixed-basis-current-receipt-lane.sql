-- CURRENT-COHORT SOURCE ONLY / NATIVE UNRUN. FIFO5 mixed-basis prerequisite.
-- No admission, rank, payout, receipt content, role grant or ordinary error
-- policy changes. Existing G/B/T namespace only. No business rows are touched.
-- Current terminal/finish authority: 2026-09-17T23:52:59.30389Z capture in
-- fixtures/spin-mixed-current/authority.json. Legacy RPC/share/compactor authority:
-- 2026-09-17T18:21:53.810361Z capture in fixtures/spin-receipt-lane/authority.json.
-- Prior old-cohort lane qualification does not qualify this current-cohort composition.
-- Replay intentionally refuses. DDL lock wait is bounded; runtime takes only
-- existing advisory locks, never a relation lock.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Current-cohort variant. The original receipt-lane component remains unchanged.
-- Current authority: fixtures/spin-mixed-current/authority.json (193d8f25921068b2...).
-- Legacy authority: fixtures/spin-receipt-lane/authority.json; financial bodies
-- and ordinary error/permission behavior below are byte-identical to that lane.
DO $current_cohort$
DECLARE expected jsonb; actual jsonb;
BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'current receipt lane execution authority differs' USING ERRCODE='55000';
 END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($current_lane_authority$[{"signature":"fn_ca_lock_settlement_lane_for_finish(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"76e4c6b5291bab20f0cfc65dd060022b","volatility":"v","security_definer":false},{"signature":"fn_ca_lock_settlement_lane_global()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"7c759bb7a639c3124de2607bdbf12577","volatility":"v","security_definer":false},{"signature":"fn_ca_settlement_lane_doctrine()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d6885832ceaa6c071d40bdc26a0b16fa","volatility":"s","security_definer":true},{"signature":"fn_ca_tournament_terminal_receipt(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"787eb9a718a648ac29753dfc9234f4c3","volatility":"s","security_definer":true},{"signature":"fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=45s"],"full_md5":"6a45fe9bf30c94f9366ec88f0863087e","volatility":"v","security_definer":true},{"signature":"fn_complete_tournament_terminal(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=45s"],"full_md5":"c64e049911fd99c1d784cdb042ca714b","volatility":"v","security_definer":true},{"signature":"fn_settle_tournament_places(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"c412c8b17186976df139f73a706175f2","volatility":"v","security_definer":true},{"signature":"fn_ca_share_settlement_lane_for_table(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"409b14ee72ce888d3b26524c52d49a68","volatility":"v","security_definer":false},{"signature":"settle_hand_atomically(uuid,uuid,jsonb)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0e05527759067cb4ae45b852fe962a9d","volatility":"v","security_definer":false},{"signature":"sp_compact_hand_history(integer,integer,integer)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0ba486c621ce407ad06941300fb9f387","volatility":"v","security_definer":true}]$current_lane_authority$::jsonb) LOOP
  SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(p.proowner),
    'acl',p.proacl::text,'config',p.proconfig,'full_md5',md5(pg_get_functiondef(p.oid)),
    'volatility',p.provolatile,'security_definer',p.prosecdef) INTO actual
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'signature')) AND p.prokind='f';
  IF actual IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'current receipt lane authority differs: %',expected->>'signature' USING ERRCODE='55000';
  END IF;
 END LOOP;
END $current_cohort$;
DO $guard$
DECLARE dep record;
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)'))
          IS DISTINCT FROM 'c64e049911fd99c1d784cdb042ca714b'
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'))
          IS DISTINCT FROM 'c412c8b17186976df139f73a706175f2'
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_ca_share_settlement_lane_for_table(uuid)'))
          IS DISTINCT FROM '409b14ee72ce888d3b26524c52d49a68'
     OR NOT EXISTS(SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_ca_share_settlement_lane_for_table(uuid)')
          AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.provolatile='v'
          AND p.proconfig=ARRAY['search_path=public, pg_temp']
          AND p.proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.settle_hand_atomically(uuid,uuid,jsonb)'))
          IS DISTINCT FROM '0e05527759067cb4ae45b852fe962a9d'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.settle_hand_atomically(uuid,uuid,jsonb)')
          AND p.proowner='postgres'::regrole AND NOT p.prosecdef
          AND p.proconfig=ARRAY['search_path=public']
          AND p.proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])
     OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.settlement_idempotency_keys')
          AND c.relkind='r' AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity)
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.settlement_idempotency_keys') AND NOT t.tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.hand_history')
          AND t.tgname IN ('a00_spin_mixed_history_insert_lane','a00_spin_mixed_history_identity_update_lane'))
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_compact_hand_history(integer,integer,integer)')) IS DISTINCT FROM '0ba486c621ce407ad06941300fb9f387'
     OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_compact_hand_history(integer,integer,integer)')
       AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
       AND p.proconfig=ARRAY['search_path=public, pg_temp']
       AND p.proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])
     OR to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy receipt lane prerequisite preimage differs' USING ERRCODE='55000';
  END IF;
  FOR dep IN SELECT value AS pin FROM jsonb_array_elements($legacy_callees$[{"identity":"calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","full_md5":"55b5d60335a28bb1ceb3131485681c18"},{"identity":"record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","full_md5":"08b41453b5560ecf6c22c57bc5aa062d"}]$legacy_callees$::jsonb) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(dep.pin->>'identity'))
       AND pg_get_userbyid(p.proowner)=dep.pin->>'owner' AND p.proacl::text=dep.pin->>'acl'
       AND md5(pg_get_functiondef(p.oid))=dep.pin->>'full_md5') THEN
      RAISE EXCEPTION 'legacy ordinary callee source/authority differs: %',dep.pin->>'identity' USING ERRCODE='55000';
    END IF;
  END LOOP;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.settle_hand_atomically(p_table_id uuid, p_hand_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.settlement_idempotency_keys%ROWTYPE;
  v_rake_result jsonb;
  v_commission_results jsonb := '[]'::jsonb;
  v_player record;
  v_individual_result jsonb;
  v_final_result jsonb;
BEGIN
  -- Join the existing terminal barrier before any receipt read or write.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  SELECT * INTO v_existing
    FROM public.settlement_idempotency_keys
   WHERE table_id = p_table_id AND hand_id = p_hand_id;

  IF FOUND THEN
    IF v_existing.status = 'succeeded' THEN
      RETURN v_existing.result;
    ELSIF v_existing.status = 'in_flight' THEN
      UPDATE public.settlement_idempotency_keys
         SET attempt_count = attempt_count + 1,
             last_attempt_at = NOW()
       WHERE table_id = p_table_id AND hand_id = p_hand_id;
      RAISE EXCEPTION 'settlement already in flight for table=% hand=%', p_table_id, p_hand_id;
    END IF;
  ELSE
    INSERT INTO public.settlement_idempotency_keys
      (table_id, hand_id, status)
    VALUES (p_table_id, p_hand_id, 'in_flight');
  END IF;

  BEGIN
    v_rake_result := public.record_rake(
      p_hand_id        := p_hand_id,
      p_club_id        := (p_payload->>'club_id')::uuid,
      p_table_id       := p_table_id,
      p_rake_amount    := COALESCE((p_payload->>'rake')::numeric, 0),
      p_pot_size       := COALESCE((p_payload->>'pot')::numeric, 0),
      p_num_players    := COALESCE((p_payload->>'num_players')::int, 0),
      p_player_contributions := p_payload->'player_contributions',
      p_is_tournament  := COALESCE((p_payload->>'is_tournament')::boolean, FALSE),
      p_tournament_id  := NULLIF(p_payload->>'tournament_id','')::uuid,
      p_bbj_pct        := COALESCE((p_payload->>'bbj_pct')::numeric, 0.05)
    );

    FOR v_player IN
      SELECT key::uuid AS user_id, value::numeric AS rake_share
        FROM jsonb_each_text(COALESCE(p_payload->'player_contributions', '{}'::jsonb))
       WHERE value::numeric > 0
    LOOP
      v_individual_result := public.calculate_cascading_commission(
        p_hand_id        := p_hand_id,
        p_club_id        := (p_payload->>'club_id')::uuid,
        p_player_user_id := v_player.user_id,
        p_rake_amount    := v_player.rake_share,
        p_rake_record_id := (v_rake_result->>'rake_record_id')::uuid
      );
      v_commission_results := v_commission_results || jsonb_build_array(v_individual_result);
    END LOOP;

    v_final_result := jsonb_build_object(
      'success', true,
      'table_id', p_table_id,
      'hand_id', p_hand_id,
      'rake', v_rake_result,
      'commissions', v_commission_results
    );

    UPDATE public.settlement_idempotency_keys
       SET status = 'succeeded',
           result = v_final_result,
           completed_at = NOW(),
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;

    RETURN v_final_result;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.settlement_idempotency_keys
       SET status = 'failed',
           error  = SQLERRM,
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    RAISE;
  END;
END;
$function$;

CREATE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog,public,pg_temp
AS $receipt_lane$
BEGIN
  -- TRUNCATE already holds AccessExclusive before this trigger. Never wait
  -- for G/B in that order; authoritative receipt history is not truncatable.
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'retained settlement receipt history cannot be truncated'
      USING ERRCODE='55000';
  END IF;
  -- INSERT/UPDATE/DELETE take G/B before target-row locks. NULL intentionally
  -- takes only G/B; this does not claim acquisition before relation locks.
  PERFORM public.fn_ca_share_settlement_lane_for_table(NULL::uuid);
  RETURN NULL;
END;
$receipt_lane$;
ALTER FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aa_serialize_legacy_settlement_receipt_statement
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.settlement_idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();
-- The source snapshot uses only these history fields. Nonidentity metadata
-- updates and the existing pruner's has_human UPDATE/DELETE retain their row
-- locking behavior. Existing source rows are SHARE-locked by admission.
CREATE TRIGGER a00_spin_mixed_history_insert_lane
  BEFORE INSERT ON public.hand_history FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();
CREATE TRIGGER a00_spin_mixed_history_identity_update_lane
  BEFORE UPDATE OF id,table_id,tournament_id,hand_number,players ON public.hand_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();

-- Preserve only the compactor path that this exact non-firing hook would block.
DO $compact_patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.sp_compact_hand_history(integer,integer,integer)'::regprocedure) INTO source;
 IF md5(source)<>'0ba486c621ce407ad06941300fb9f387' THEN RAISE EXCEPTION 'compactor preimage differs' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old$       AND (t.tgtype & 16) <> 0$old$,$new$       AND (t.tgtype & 16) <> 0
       -- Only this exact statement binding excludes reported from UPDATE OF.
       -- Every other UPDATE trigger retains the original fail-closed refusal.
       AND (t.tgname='a00_spin_mixed_history_identity_update_lane'
         AND t.tgenabled='O' AND t.tgtype=18 AND t.tgqual IS NULL
         AND t.tgfoid=to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()')
         AND t.tgnargs=0 AND t.tgargs=''::bytea AND NOT t.tgdeferrable
         AND (SELECT array_agg(a.attname::text ORDER BY x.n)
              FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(attnum,n)
              JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.attnum)
             =ARRAY['id','table_id','tournament_id','hand_number','players']
         AND (SELECT p.proowner='postgres'::regrole AND NOT p.prosecdef
               AND md5(p.prosrc)='534850c97847e72075044d8604b0a09d'
               AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
              FROM pg_proc p WHERE p.oid=t.tgfoid)) IS NOT TRUE$new$);
 IF md5(source)<>'36a41aa4447e199ec8a9f2a5aa1840ec' THEN RAISE EXCEPTION 'compactor exception patch differs' USING ERRCODE='55000'; END IF;
 EXECUTE source;
END;
$compact_patch$;

DO $post$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
      WHERE p.oid='public.settle_hand_atomically(uuid,uuid,jsonb)'::regprocedure)
      IS DISTINCT FROM '64abd1e3234fdabc655647bfb1ad5018'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid='public.settlement_idempotency_keys'::regclass
         AND t.tgname='aa_serialize_legacy_settlement_receipt_statement'
         AND t.tgenabled='O' AND t.tgtype=62 AND NOT t.tgisinternal
         AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
         AND t.tgqual IS NULL AND t.tgattr::text='')
     OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure)<>3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.hand_history'::regclass
           AND t.tgname='a00_spin_mixed_history_insert_lane' AND t.tgenabled='O' AND t.tgtype=6
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
           AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgdeferrable AND t.tgattr::text='')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.hand_history'::regclass
           AND t.tgname='a00_spin_mixed_history_identity_update_lane' AND t.tgenabled='O' AND t.tgtype=18
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
           AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgdeferrable
           AND (SELECT array_agg(a.attname::text ORDER BY x.n)
                FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(attnum,n)
                JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.attnum)
               =ARRAY['id','table_id','tournament_id','hand_number','players'])
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid='public.sp_compact_hand_history(integer,integer,integer)'::regprocedure)
          IS DISTINCT FROM '36a41aa4447e199ec8a9f2a5aa1840ec' THEN
    RAISE EXCEPTION 'legacy receipt lane postimage differs' USING ERRCODE='55000';
  END IF;
END;
$post$;
COMMIT;
