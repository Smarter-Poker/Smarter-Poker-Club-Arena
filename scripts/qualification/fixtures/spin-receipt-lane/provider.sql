-- Exact 2026-09-17T18:21:53.810361Z captured authority, not replacement writers.
-- Run only after original provider emptiness proof. One captured nonfinancial
-- policy row is restored; no histories, receipts or financial rows are seeded.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='1s';
SET LOCAL search_path=public,pg_temp; SET LOCAL timezone='UTC';
\ir boundary.sql
DO $absent$
BEGIN
 IF to_regclass('public.hand_history_compaction_policy') IS NOT NULL
    OR to_regprocedure('public.fn_ca_share_settlement_lane_for_table(uuid)') IS NOT NULL
    OR to_regprocedure('public.record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric)') IS NOT NULL
    OR to_regprocedure('public.settle_hand_atomically(uuid,uuid,jsonb)') IS NOT NULL
    OR to_regprocedure('public.sp_compact_hand_history(integer,integer,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'receipt lane provider authority already present'; END IF;
END $absent$;
CREATE TABLE public.hand_history_compaction_policy (
 id boolean DEFAULT true NOT NULL,
 enabled boolean DEFAULT false NOT NULL,
 headroom_factor numeric DEFAULT 1.25 NOT NULL,
 note text,
 updated_at timestamp with time zone DEFAULT now() NOT NULL,
 resume_page bigint,
 CONSTRAINT hand_history_compaction_policy_headroom_factor_check CHECK (headroom_factor >= 1.05),
 CONSTRAINT hand_history_compaction_policy_id_check CHECK (id),
 CONSTRAINT hand_history_compaction_policy_pkey PRIMARY KEY (id)
);
ALTER TABLE public.hand_history_compaction_policy OWNER TO postgres;
ALTER TABLE public.hand_history_compaction_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hand_history_compaction_policy FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT ALL ON public.hand_history_compaction_policy TO postgres,service_role;
INSERT INTO public.hand_history_compaction_policy SELECT * FROM jsonb_populate_record(NULL::public.hand_history_compaction_policy,$captured_policy${"id":true,"note":"Enabled 2026-08-26. Set enabled=false to stop the compactor immediately; the next scheduled run becomes a no-op and nothing needs to be unwound.","enabled":true,"updated_at":"2026-09-17T18:20:00.429108+00:00","resume_page":null,"headroom_factor":1.25}$captured_policy$::jsonb);
CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- Acquire G before B and T; source custody guards also need G.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO postgres,service_role;
CREATE OR REPLACE FUNCTION public.record_rake(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_pot_size numeric DEFAULT 0, p_num_players integer DEFAULT 0, p_player_contributions jsonb DEFAULT NULL::jsonb, p_is_tournament boolean DEFAULT false, p_tournament_id uuid DEFAULT NULL::uuid, p_bbj_pct numeric DEFAULT 0.05)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bbj_amount numeric := 0;
  v_rake_id uuid; v_pool_id uuid; v_new_balance numeric;
  v_union uuid; v_private boolean := false;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_rake');
  END IF;

  -- UNION LAW guard: this legacy path keeps everything club-side. If it is
  -- ever used for a union-visible game the union treasury silently loses the
  -- rake - delegate to atomic_distribute_rake instead and alert.
  IF p_table_id IS NOT NULL THEN
    SELECT t.union_id, COALESCE(t.is_private, false) INTO v_union, v_private
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF v_union IS NULL AND NOT v_private AND p_club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;
  END IF;
  IF v_union IS NOT NULL AND NOT v_private THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'record_rake',
      'Legacy record_rake called for a UNION game - delegated to atomic_distribute_rake',
      jsonb_build_object('club_id', p_club_id, 'table_id', p_table_id,
                         'tournament_id', p_tournament_id, 'rake', p_rake_amount));
    PERFORM public.atomic_distribute_rake(
      p_table_id, p_club_id, p_hand_id, NULL, p_rake_amount,
      ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0), 4), p_pot_size,
      p_num_players, p_player_contributions, p_tournament_id);
    RETURN jsonb_build_object('success', true, 'delegated', 'atomic_distribute_rake');
  END IF;

  v_bbj_amount := ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0)::numeric, 4);

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution,
    pot_size, num_players, player_contributions,
    is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake_amount, v_bbj_amount,
    p_pot_size, p_num_players, p_player_contributions,
    p_is_tournament, p_tournament_id,
    CASE WHEN p_is_tournament THEN 'tournament' ELSE 'cash_game' END,
    jsonb_build_object('bbj_pct_applied', p_bbj_pct, 'is_private', v_private)
  )
  RETURNING id INTO v_rake_id;

  IF p_club_id IS NOT NULL AND v_bbj_amount > 0 THEN
    INSERT INTO public.bbj_pools (club_id, pool_amount, hands_contributed, total_contributed)
    VALUES (p_club_id, v_bbj_amount, 1, v_bbj_amount)
    ON CONFLICT (club_id) DO UPDATE
      SET pool_amount       = public.bbj_pools.pool_amount + v_bbj_amount,
          hands_contributed = public.bbj_pools.hands_contributed + 1,
          total_contributed = public.bbj_pools.total_contributed + v_bbj_amount,
          updated_at        = NOW()
    RETURNING id INTO v_pool_id;
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake_amount,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj_amount,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake_amount,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj_amount,
           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand
           updated_at                = NOW()
     WHERE club_id = p_club_id
    RETURNING chip_balance INTO v_new_balance;

    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.club_wallet_transactions (
        club_id, type, amount, balance_after, related_id, reason
      ) VALUES (
        p_club_id, 'rake_in', (p_rake_amount - v_bbj_amount), v_new_balance,
        v_rake_id, 'Rake collected (BBJ pct: ' || p_bbj_pct::text || ')'
      );
    END IF;

    UPDATE public.clubs
       SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,
           updated_at = NOW()
     WHERE id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'rake_record_id', v_rake_id, 'bbj_pool_id', v_pool_id,
    'rake', p_rake_amount, 'bbj_contribution', v_bbj_amount
  );
END;
$function$;
ALTER FUNCTION public.record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric) TO postgres,service_role;
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
ALTER FUNCTION public.settle_hand_atomically(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_hand_atomically(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.settle_hand_atomically(uuid,uuid,jsonb) TO postgres,service_role;
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
ALTER FUNCTION public.sp_compact_hand_history(integer,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) TO postgres,service_role;
DO $exact_provider$
DECLARE actual jsonb;
BEGIN
 SELECT observed.value-'observed_at'-'server_version_num' INTO actual
 FROM (SELECT jsonb_build_object(
'observed_at',clock_timestamp(),'server_version_num',current_setting('server_version_num'),
'functions',(SELECT jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'full_md5',md5(pg_get_functiondef(p.oid)),'prosrc_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,'volatility',p.provolatile) ORDER BY p.oid::regprocedure::text)
 FROM pg_proc p WHERE p.oid=ANY(ARRAY[to_regprocedure('public.fn_ca_share_settlement_lane_for_table(uuid)'),to_regprocedure('public.settle_hand_atomically(uuid,uuid,jsonb)'),to_regprocedure('public.sp_compact_hand_history(integer,integer,integer)'),to_regprocedure('public.record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric)')])),
'policy',(SELECT jsonb_build_object('name',c.oid::regclass::text,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'type',k.contype,'deferrable',k.condeferrable,'deferred',k.condeferred,'validated',k.convalidated) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT coalesce(jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),'policies',(SELECT coalesce(jsonb_agg(to_jsonb(pp) ORDER BY pp.policyname),'[]'::jsonb) FROM pg_policies pp WHERE pp.schemaname='public' AND pp.tablename='hand_history_compaction_policy'),'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true),'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'rows',(SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM (SELECT * FROM public.hand_history_compaction_policy LIMIT 11) r),'row_count',(SELECT count(*) FROM public.hand_history_compaction_policy)) FROM pg_class c WHERE c.oid=to_regclass('public.hand_history_compaction_policy'))
) AS value) observed;
 IF actual IS DISTINCT FROM $captured_authority${"policy":{"acl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"hand_history_compaction_policy","rows":[{"id":true,"note":"Enabled 2026-08-26. Set enabled=false to stop the compactor immediately; the next scheduled run becomes a no-op and nothing needs to be unwound.","enabled":true,"updated_at":"2026-09-17T18:20:00.429108+00:00","resume_page":null,"headroom_factor":1.25}],"owner":"postgres","columns":[{"acl":null,"name":"id","type":"boolean","default":"true","identity":"","not_null":true,"generated":""},{"acl":null,"name":"enabled","type":"boolean","default":"false","identity":"","not_null":true,"generated":""},{"acl":null,"name":"headroom_factor","type":"numeric","default":"1.25","identity":"","not_null":true,"generated":""},{"acl":null,"name":"note","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"resume_page","type":"bigint","default":null,"identity":"","not_null":false,"generated":""}],"indexes":["CREATE UNIQUE INDEX hand_history_compaction_policy_pkey ON public.hand_history_compaction_policy USING btree (id)"],"policies":[],"triggers":[],"force_rls":false,"row_count":1,"constraints":[{"name":"hand_history_compaction_policy_headroom_factor_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (headroom_factor >= 1.05)"},{"name":"hand_history_compaction_policy_id_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (id)"},{"name":"hand_history_compaction_policy_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"}]},"functions":[{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"full_md5":"409b14ee72ce888d3b26524c52d49a68","identity":"fn_ca_share_settlement_lane_for_table(uuid)","definition":"CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)\n RETURNS void\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_tournament_id uuid;\nBEGIN\n  -- Acquire G before B and T; source custody guards also need G.\n  PERFORM pg_advisory_xact_lock_shared(\n    hashtextextended('ca:tournament-terminal-settlement:v1',0));\n  -- B shared: yields to terminal authorities, concurrent with every other\n  -- hand and with rolling authorities of OTHER tournaments.\n  PERFORM pg_advisory_xact_lock_shared(\n    hashtextextended('ca:hand-settlement-barrier:v1', 0));\n\n  IF p_table_id IS NULL THEN\n    RETURN;\n  END IF;\n\n  SELECT tb.tournament_id INTO v_tournament_id\n  FROM public.tables tb\n  WHERE tb.id = p_table_id;\n\n  IF v_tournament_id IS NOT NULL THEN\n    -- T(id) shared: yields to this tournament's own rolling authorities.\n    PERFORM pg_advisory_xact_lock_shared(\n      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));\n  END IF;\nEND;\n$function$\n","prosrc_md5":"7a4d464261d6cc5cb185ad6c8b846440","volatility":"v","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"full_md5":"08b41453b5560ecf6c22c57bc5aa062d","identity":"record_rake(uuid,uuid,uuid,numeric,numeric,integer,jsonb,boolean,uuid,numeric)","definition":"CREATE OR REPLACE FUNCTION public.record_rake(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_pot_size numeric DEFAULT 0, p_num_players integer DEFAULT 0, p_player_contributions jsonb DEFAULT NULL::jsonb, p_is_tournament boolean DEFAULT false, p_tournament_id uuid DEFAULT NULL::uuid, p_bbj_pct numeric DEFAULT 0.05)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public'\nAS $function$\nDECLARE\n  v_bbj_amount numeric := 0;\n  v_rake_id uuid; v_pool_id uuid; v_new_balance numeric;\n  v_union uuid; v_private boolean := false;\nBEGIN\n  IF p_rake_amount IS NULL OR p_rake_amount <= 0 THEN\n    RETURN jsonb_build_object('success', true, 'skipped', 'zero_rake');\n  END IF;\n\n  -- UNION LAW guard: this legacy path keeps everything club-side. If it is\n  -- ever used for a union-visible game the union treasury silently loses the\n  -- rake - delegate to atomic_distribute_rake instead and alert.\n  IF p_table_id IS NOT NULL THEN\n    SELECT t.union_id, COALESCE(t.is_private, false) INTO v_union, v_private\n      FROM public.tables t WHERE t.id = p_table_id;\n  END IF;\n  IF v_union IS NULL AND NOT v_private AND p_club_id IS NOT NULL THEN\n    SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;\n  END IF;\n  IF v_union IS NOT NULL AND NOT v_private THEN\n    INSERT INTO public.financial_alerts (severity, source, message, context)\n    VALUES ('warning', 'record_rake',\n      'Legacy record_rake called for a UNION game - delegated to atomic_distribute_rake',\n      jsonb_build_object('club_id', p_club_id, 'table_id', p_table_id,\n                         'tournament_id', p_tournament_id, 'rake', p_rake_amount));\n    PERFORM public.atomic_distribute_rake(\n      p_table_id, p_club_id, p_hand_id, NULL, p_rake_amount,\n      ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0), 4), p_pot_size,\n      p_num_players, p_player_contributions, p_tournament_id);\n    RETURN jsonb_build_object('success', true, 'delegated', 'atomic_distribute_rake');\n  END IF;\n\n  v_bbj_amount := ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0)::numeric, 4);\n\n  INSERT INTO public.rake_records (\n    hand_id, table_id, club_id, rake_amount, bbj_contribution,\n    pot_size, num_players, player_contributions,\n    is_tournament, tournament_id, source, metadata\n  ) VALUES (\n    p_hand_id, p_table_id, p_club_id, p_rake_amount, v_bbj_amount,\n    p_pot_size, p_num_players, p_player_contributions,\n    p_is_tournament, p_tournament_id,\n    CASE WHEN p_is_tournament THEN 'tournament' ELSE 'cash_game' END,\n    jsonb_build_object('bbj_pct_applied', p_bbj_pct, 'is_private', v_private)\n  )\n  RETURNING id INTO v_rake_id;\n\n  IF p_club_id IS NOT NULL AND v_bbj_amount > 0 THEN\n    INSERT INTO public.bbj_pools (club_id, pool_amount, hands_contributed, total_contributed)\n    VALUES (p_club_id, v_bbj_amount, 1, v_bbj_amount)\n    ON CONFLICT (club_id) DO UPDATE\n      SET pool_amount       = public.bbj_pools.pool_amount + v_bbj_amount,\n          hands_contributed = public.bbj_pools.hands_contributed + 1,\n          total_contributed = public.bbj_pools.total_contributed + v_bbj_amount,\n          updated_at        = NOW()\n    RETURNING id INTO v_pool_id;\n  END IF;\n\n  IF p_club_id IS NOT NULL THEN\n    UPDATE public.club_wallets\n       SET period_rake_collected     = period_rake_collected     + p_rake_amount,\n           period_bbj_contribution   = period_bbj_contribution   + v_bbj_amount,\n           lifetime_rake_collected   = lifetime_rake_collected   + p_rake_amount,\n           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj_amount,\n           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand\n           updated_at                = NOW()\n     WHERE club_id = p_club_id\n    RETURNING chip_balance INTO v_new_balance;\n\n    IF v_new_balance IS NOT NULL THEN\n      INSERT INTO public.club_wallet_transactions (\n        club_id, type, amount, balance_after, related_id, reason\n      ) VALUES (\n        p_club_id, 'rake_in', (p_rake_amount - v_bbj_amount), v_new_balance,\n        v_rake_id, 'Rake collected (BBJ pct: ' || p_bbj_pct::text || ')'\n      );\n    END IF;\n\n    UPDATE public.clubs\n       SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,\n           updated_at = NOW()\n     WHERE id = p_club_id;\n  END IF;\n\n  RETURN jsonb_build_object(\n    'success', true, 'rake_record_id', v_rake_id, 'bbj_pool_id', v_pool_id,\n    'rake', p_rake_amount, 'bbj_contribution', v_bbj_amount\n  );\nEND;\n$function$\n","prosrc_md5":"390b7e26953682debd0152b3926b2c3a","volatility":"v","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"full_md5":"0e05527759067cb4ae45b852fe962a9d","identity":"settle_hand_atomically(uuid,uuid,jsonb)","definition":"CREATE OR REPLACE FUNCTION public.settle_hand_atomically(p_table_id uuid, p_hand_id uuid, p_payload jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public'\nAS $function$\nDECLARE\n  v_existing public.settlement_idempotency_keys%ROWTYPE;\n  v_rake_result jsonb;\n  v_commission_results jsonb := '[]'::jsonb;\n  v_player record;\n  v_individual_result jsonb;\n  v_final_result jsonb;\nBEGIN\n  SELECT * INTO v_existing\n    FROM public.settlement_idempotency_keys\n   WHERE table_id = p_table_id AND hand_id = p_hand_id;\n\n  IF FOUND THEN\n    IF v_existing.status = 'succeeded' THEN\n      RETURN v_existing.result;\n    ELSIF v_existing.status = 'in_flight' THEN\n      UPDATE public.settlement_idempotency_keys\n         SET attempt_count = attempt_count + 1,\n             last_attempt_at = NOW()\n       WHERE table_id = p_table_id AND hand_id = p_hand_id;\n      RAISE EXCEPTION 'settlement already in flight for table=% hand=%', p_table_id, p_hand_id;\n    END IF;\n  ELSE\n    INSERT INTO public.settlement_idempotency_keys\n      (table_id, hand_id, status)\n    VALUES (p_table_id, p_hand_id, 'in_flight');\n  END IF;\n\n  BEGIN\n    v_rake_result := public.record_rake(\n      p_hand_id        := p_hand_id,\n      p_club_id        := (p_payload->>'club_id')::uuid,\n      p_table_id       := p_table_id,\n      p_rake_amount    := COALESCE((p_payload->>'rake')::numeric, 0),\n      p_pot_size       := COALESCE((p_payload->>'pot')::numeric, 0),\n      p_num_players    := COALESCE((p_payload->>'num_players')::int, 0),\n      p_player_contributions := p_payload->'player_contributions',\n      p_is_tournament  := COALESCE((p_payload->>'is_tournament')::boolean, FALSE),\n      p_tournament_id  := NULLIF(p_payload->>'tournament_id','')::uuid,\n      p_bbj_pct        := COALESCE((p_payload->>'bbj_pct')::numeric, 0.05)\n    );\n\n    FOR v_player IN\n      SELECT key::uuid AS user_id, value::numeric AS rake_share\n        FROM jsonb_each_text(COALESCE(p_payload->'player_contributions', '{}'::jsonb))\n       WHERE value::numeric > 0\n    LOOP\n      v_individual_result := public.calculate_cascading_commission(\n        p_hand_id        := p_hand_id,\n        p_club_id        := (p_payload->>'club_id')::uuid,\n        p_player_user_id := v_player.user_id,\n        p_rake_amount    := v_player.rake_share,\n        p_rake_record_id := (v_rake_result->>'rake_record_id')::uuid\n      );\n      v_commission_results := v_commission_results || jsonb_build_array(v_individual_result);\n    END LOOP;\n\n    v_final_result := jsonb_build_object(\n      'success', true,\n      'table_id', p_table_id,\n      'hand_id', p_hand_id,\n      'rake', v_rake_result,\n      'commissions', v_commission_results\n    );\n\n    UPDATE public.settlement_idempotency_keys\n       SET status = 'succeeded',\n           result = v_final_result,\n           completed_at = NOW(),\n           last_attempt_at = NOW()\n     WHERE table_id = p_table_id AND hand_id = p_hand_id;\n\n    RETURN v_final_result;\n  EXCEPTION WHEN OTHERS THEN\n    UPDATE public.settlement_idempotency_keys\n       SET status = 'failed',\n           error  = SQLERRM,\n           last_attempt_at = NOW()\n     WHERE table_id = p_table_id AND hand_id = p_hand_id;\n    RAISE;\n  END;\nEND;\n$function$\n","prosrc_md5":"9552b7318550c9438a691ffc82304193","volatility":"v","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"full_md5":"0ba486c621ce407ad06941300fb9f387","identity":"sp_compact_hand_history(integer,integer,integer)","definition":"CREATE OR REPLACE FUNCTION public.sp_compact_hand_history(p_budget_seconds integer DEFAULT 15, p_batch integer DEFAULT 300, p_window_pages integer DEFAULT 4000)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_enabled   boolean;\n  v_headroom  numeric;\n  v_resume    bigint;\n  v_deadline  timestamptz;\n  v_relpages  bigint;\n  v_live      bigint;\n  v_per_page  numeric;\n  v_target    bigint;\n  v_hi        bigint;\n  v_lo        bigint;\n  v_ctids     tid[];\n  v_moved     bigint := 0;\n  v_round     integer;\n  v_stop      text := 'budget_spent';\nBEGIN\n  -- GUARD 1: the kill switch.\n  SELECT enabled, COALESCE(headroom_factor, 1.25), resume_page\n    INTO v_enabled, v_headroom, v_resume\n    FROM public.hand_history_compaction_policy\n   LIMIT 1;\n\n  IF NOT COALESCE(v_enabled, false) THEN\n    RETURN jsonb_build_object('compacted', false, 'reason', 'disabled');\n  END IF;\n\n  -- GUARD 2: an UPDATE here is only invisible while every trigger on\n  -- hand_history is INSERT-only. If one ever fires on UPDATE, moving a row\n  -- would re-run the club stats trigger and double-count somebody's profit.\n  IF EXISTS (\n    SELECT 1 FROM pg_trigger t\n     WHERE t.tgrelid = 'public.hand_history'::regclass\n       AND NOT t.tgisinternal\n       AND (t.tgtype & 16) <> 0\n  ) THEN\n    RETURN jsonb_build_object('compacted', false, 'reason', 'update_trigger_present');\n  END IF;\n\n  -- GUARD 3: an UPDATE on a replicated table is a broadcast.\n  IF EXISTS (\n    SELECT 1 FROM pg_publication_rel pr\n      JOIN pg_publication p ON p.oid = pr.prpubid\n     WHERE pr.prrelid = 'public.hand_history'::regclass AND p.pubupdate\n  ) OR EXISTS (SELECT 1 FROM pg_publication WHERE puballtables AND pubupdate) THEN\n    RETURN jsonb_build_object('compacted', false, 'reason', 'table_is_published');\n  END IF;\n\n  v_deadline := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 1));\n\n  SELECT relpages::bigint, GREATEST(reltuples, 0)::bigint\n    INTO v_relpages, v_live\n    FROM pg_class WHERE oid = 'public.hand_history'::regclass;\n\n  SELECT COALESCE(NULLIF(avg(cnt), 0), 5)::numeric\n    INTO v_per_page\n    FROM (\n      SELECT count(*) AS cnt\n        FROM public.hand_history TABLESAMPLE SYSTEM (0.05)\n       GROUP BY (ctid::text::point)[0]::bigint\n    ) s;\n\n  v_target := ceil((v_live / GREATEST(v_per_page, 1)) * GREATEST(v_headroom, 1.05))::bigint;\n\n  -- GUARD 4: already packed -- never churn for no space.\n  IF v_relpages <= v_target THEN\n    UPDATE public.hand_history_compaction_policy\n       SET resume_page = NULL, updated_at = now();\n    RETURN jsonb_build_object('compacted', false, 'reason', 'already_compact',\n                              'relpages', v_relpages, 'target_pages', v_target);\n  END IF;\n\n  -- Resume where the last run stopped. Never above the current relpages (the\n  -- file may have been truncated since), never at or below the target (that\n  -- means a full sweep finished and the next one starts from the tail).\n  v_hi := LEAST(COALESCE(v_resume, v_relpages), v_relpages);\n  IF v_hi <= v_target THEN\n    v_hi := v_relpages;\n  END IF;\n\n  <<work>>\n  LOOP\n    v_ctids := NULL;\n\n    WHILE v_hi > v_target AND v_ctids IS NULL LOOP\n      v_lo := GREATEST(v_target, v_hi - GREATEST(p_window_pages, 1));\n\n      SELECT array_agg(ctid)\n        INTO v_ctids\n        FROM (\n          SELECT ctid\n            FROM public.hand_history\n           WHERE ctid >= ('(' || v_lo || ',0)')::tid\n             AND ctid <  ('(' || v_hi || ',0)')::tid\n           LIMIT GREATEST(p_batch, 1)\n        ) s;\n\n      IF v_ctids IS NULL THEN\n        v_hi := v_lo;\n      END IF;\n\n      IF clock_timestamp() >= v_deadline THEN\n        EXIT work;\n      END IF;\n    END LOOP;\n\n    IF v_ctids IS NULL THEN\n      v_stop := 'tail_reached_target';\n      EXIT work;\n    END IF;\n\n    -- The no-op: every column keeps its value. The row is rewritten only so\n    -- the free space map can place it in one of the empty low pages.\n    UPDATE public.hand_history\n       SET reported = reported\n     WHERE ctid = ANY (v_ctids);\n\n    GET DIAGNOSTICS v_round = ROW_COUNT;\n    v_moved := v_moved + v_round;\n\n    -- GUARD 5: a batch that moves nothing means we are spinning.\n    IF v_round = 0 THEN\n      v_stop := 'no_progress';\n      EXIT work;\n    END IF;\n\n    EXIT work WHEN clock_timestamp() >= v_deadline;\n  END LOOP work;\n\n  UPDATE public.hand_history_compaction_policy\n     SET resume_page = CASE WHEN v_hi <= v_target THEN NULL ELSE v_hi END,\n         updated_at  = now();\n\n  RETURN jsonb_build_object(\n    'compacted',    true,\n    'rows_moved',   v_moved,\n    'relpages',     v_relpages,\n    'target_pages', v_target,\n    'resumed_from', LEAST(COALESCE(v_resume, v_relpages), v_relpages),\n    'lowest_page_worked', v_hi,\n    'stopped',      v_stop\n  );\nEND;\n$function$\n","prosrc_md5":"813919ccef5c8a4ea1520bccbeb2bd31","volatility":"v","security_definer":true}]}$captured_authority$::jsonb THEN
  RAISE EXCEPTION 'receipt lane provider differs from exact captured authority'; END IF;
END $exact_provider$;
COMMIT;
SELECT jsonb_build_object('qualification','receipt_lane_provider','exact_authority',true,'financial_rows_seeded',false,'full_qualification',false);
