CREATE TEMP TABLE receipt_lane_sources(forward_sql text NOT NULL,rollback_sql text NOT NULL,compactor_sql text NOT NULL);
INSERT INTO receipt_lane_sources VALUES (
$lane_forward$-- SOURCE ONLY / UNRUN. Narrow prerequisite for FIFO5 mixed-basis admission.
-- No admission, rank, payout, receipt content, role grant or ordinary error
-- policy changes. Existing G/B/T namespace only. No business rows are touched.
-- Proven 2026-09-17 05:35:56 installed legacy RPC plus 05:34:28 lane/catalog.
-- Replay intentionally refuses. DDL lock wait is bounded; runtime takes only
-- existing advisory locks, never a relation lock.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$
DECLARE dep record;
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
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
$lane_forward$,
$lane_rollback$-- SOURCE ONLY / UNRUN. Run only after guarded terminal-consumer rollback.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $lane_rollback_postimage$
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
    RAISE EXCEPTION 'lane rollback exact postimage differs' USING ERRCODE='55000';
  END IF;
END;
$lane_rollback_postimage$;

DO $guard$
BEGIN
 IF current_user<>'postgres'
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)')) IS DISTINCT FROM '480be3139fe0878e637ce54f533a2170'
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_compact_hand_history(integer,integer,integer)')) IS DISTINCT FROM '36a41aa4447e199ec8a9f2a5aa1840ec'
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure)<>'c412c8b17186976df139f73a706175f2'
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid='public.settle_hand_atomically(uuid,uuid,jsonb)'::regprocedure)<>'64abd1e3234fdabc655647bfb1ad5018'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()')) IS DISTINCT FROM '534850c97847e72075044d8604b0a09d'
 OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
      AND ((tgrelid='public.settlement_idempotency_keys'::regclass AND tgname='aa_serialize_legacy_settlement_receipt_statement' AND tgtype=62)
        OR (tgrelid='public.hand_history'::regclass AND tgname='a00_spin_mixed_history_insert_lane' AND tgtype=6)
        OR (tgrelid='public.hand_history'::regclass AND tgname='a00_spin_mixed_history_identity_update_lane' AND tgtype=18)))<>3 THEN
  RAISE EXCEPTION 'legacy receipt lane rollback authority/source differs' USING ERRCODE='55000';
 END IF;
END;
$guard$;
DROP TRIGGER aa_serialize_legacy_settlement_receipt_statement ON public.settlement_idempotency_keys;
DROP TRIGGER a00_spin_mixed_history_insert_lane ON public.hand_history;
DROP TRIGGER a00_spin_mixed_history_identity_update_lane ON public.hand_history;
CREATE OR REPLACE FUNCTION public.sp_compact_hand_history(p_budget_seconds integer DEFAULT 15, p_batch integer DEFAULT 300, p_window_pages integer DEFAULT 4000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_enabled   boolean;
  v_headroom  numeric;
  v_resume    bigint;
  v_deadline  timestamptz;
  v_relpages  bigint;
  v_live      bigint;
  v_per_page  numeric;
  v_target    bigint;
  v_hi        bigint;
  v_lo        bigint;
  v_ctids     tid[];
  v_moved     bigint := 0;
  v_round     integer;
  v_stop      text := 'budget_spent';
BEGIN
  -- GUARD 1: the kill switch.
  SELECT enabled, COALESCE(headroom_factor, 1.25), resume_page
    INTO v_enabled, v_headroom, v_resume
    FROM public.hand_history_compaction_policy
   LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'disabled');
  END IF;

  -- GUARD 2: an UPDATE here is only invisible while every trigger on
  -- hand_history is INSERT-only. If one ever fires on UPDATE, moving a row
  -- would re-run the club stats trigger and double-count somebody's profit.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.hand_history'::regclass
       AND NOT t.tgisinternal
       AND (t.tgtype & 16) <> 0
  ) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'update_trigger_present');
  END IF;

  -- GUARD 3: an UPDATE on a replicated table is a broadcast.
  IF EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
     WHERE pr.prrelid = 'public.hand_history'::regclass AND p.pubupdate
  ) OR EXISTS (SELECT 1 FROM pg_publication WHERE puballtables AND pubupdate) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'table_is_published');
  END IF;

  v_deadline := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 1));

  SELECT relpages::bigint, GREATEST(reltuples, 0)::bigint
    INTO v_relpages, v_live
    FROM pg_class WHERE oid = 'public.hand_history'::regclass;

  SELECT COALESCE(NULLIF(avg(cnt), 0), 5)::numeric
    INTO v_per_page
    FROM (
      SELECT count(*) AS cnt
        FROM public.hand_history TABLESAMPLE SYSTEM (0.05)
       GROUP BY (ctid::text::point)[0]::bigint
    ) s;

  v_target := ceil((v_live / GREATEST(v_per_page, 1)) * GREATEST(v_headroom, 1.05))::bigint;

  -- GUARD 4: already packed -- never churn for no space.
  IF v_relpages <= v_target THEN
    UPDATE public.hand_history_compaction_policy
       SET resume_page = NULL, updated_at = now();
    RETURN jsonb_build_object('compacted', false, 'reason', 'already_compact',
                              'relpages', v_relpages, 'target_pages', v_target);
  END IF;

  -- Resume where the last run stopped. Never above the current relpages (the
  -- file may have been truncated since), never at or below the target (that
  -- means a full sweep finished and the next one starts from the tail).
  v_hi := LEAST(COALESCE(v_resume, v_relpages), v_relpages);
  IF v_hi <= v_target THEN
    v_hi := v_relpages;
  END IF;

  <<work>>
  LOOP
    v_ctids := NULL;

    WHILE v_hi > v_target AND v_ctids IS NULL LOOP
      v_lo := GREATEST(v_target, v_hi - GREATEST(p_window_pages, 1));

      SELECT array_agg(ctid)
        INTO v_ctids
        FROM (
          SELECT ctid
            FROM public.hand_history
           WHERE ctid >= ('(' || v_lo || ',0)')::tid
             AND ctid <  ('(' || v_hi || ',0)')::tid
           LIMIT GREATEST(p_batch, 1)
        ) s;

      IF v_ctids IS NULL THEN
        v_hi := v_lo;
      END IF;

      IF clock_timestamp() >= v_deadline THEN
        EXIT work;
      END IF;
    END LOOP;

    IF v_ctids IS NULL THEN
      v_stop := 'tail_reached_target';
      EXIT work;
    END IF;

    -- The no-op: every column keeps its value. The row is rewritten only so
    -- the free space map can place it in one of the empty low pages.
    UPDATE public.hand_history
       SET reported = reported
     WHERE ctid = ANY (v_ctids);

    GET DIAGNOSTICS v_round = ROW_COUNT;
    v_moved := v_moved + v_round;

    -- GUARD 5: a batch that moves nothing means we are spinning.
    IF v_round = 0 THEN
      v_stop := 'no_progress';
      EXIT work;
    END IF;

    EXIT work WHEN clock_timestamp() >= v_deadline;
  END LOOP work;

  UPDATE public.hand_history_compaction_policy
     SET resume_page = CASE WHEN v_hi <= v_target THEN NULL ELSE v_hi END,
         updated_at  = now();

  RETURN jsonb_build_object(
    'compacted',    true,
    'rows_moved',   v_moved,
    'relpages',     v_relpages,
    'target_pages', v_target,
    'resumed_from', LEAST(COALESCE(v_resume, v_relpages), v_relpages),
    'lowest_page_worked', v_hi,
    'stopped',      v_stop
  );
END;
$function$;
DROP FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();
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

DO $restored$
BEGIN
 IF md5(pg_get_functiondef('public.settle_hand_atomically(uuid,uuid,jsonb)'::regprocedure))<>'0e05527759067cb4ae45b852fe962a9d'
    OR md5(pg_get_functiondef('public.sp_compact_hand_history(integer,integer,integer)'::regprocedure))<>'0ba486c621ce407ad06941300fb9f387'
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('aa_serialize_legacy_settlement_receipt_statement','a00_spin_mixed_history_insert_lane','a00_spin_mixed_history_identity_update_lane')) THEN
   RAISE EXCEPTION 'lane rollback did not restore exact original consumers' USING ERRCODE='55000';
 END IF;
END;
$restored$;
$lane_rollback$,
$lane_compactor$-- SOURCE ONLY / UNRUN. Run before and after lane component in the same genuine
-- isolated provider state. The provider supplies an enabled compaction policy;
-- this file does not enable production maintenance or create a business row.
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
 IF current_user<>'postgres'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid')::uuid::text,'-','')
    OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
    OR (SELECT count(*) FROM public.hand_history_compaction_policy)<>1
    OR NOT EXISTS(SELECT 1 FROM public.hand_history_compaction_policy WHERE enabled IS TRUE) THEN
   RAISE EXCEPTION 'compactor control requires the separately admitted enabled fixture policy';
 END IF;
END $guard$;
DO $accepted$
DECLARE r jsonb;
BEGIN
 r:=public.sp_compact_hand_history(1,1,1);
 IF (jsonb_typeof(r)='object' AND
     (r->'compacted'='true'::jsonb OR (r->'compacted'='false'::jsonb
       AND r->>'reason' IN ('table_is_published','already_compact')))) IS NOT TRUE THEN
   RAISE EXCEPTION 'compactor no longer reaches its existing accepted path: %',r;
 END IF;
 RAISE NOTICE 'compactor accepted-path observation: %',r;
END $accepted$;
CREATE FUNCTION pg_temp.mixed_unrelated_update() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NEW; END $f$;
CREATE TRIGGER mixed_qualification_unrelated_update BEFORE UPDATE OF reported ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION pg_temp.mixed_unrelated_update();
DO $refusal$
DECLARE r jsonb;
BEGIN
 r:=public.sp_compact_hand_history(1,1,1);
 IF r IS DISTINCT FROM '{"compacted":false,"reason":"update_trigger_present"}'::jsonb THEN
   RAISE EXCEPTION 'unrelated applicable UPDATE trigger was not refused: %',r;
 END IF;
END $refusal$;
$lane_compactor$);
