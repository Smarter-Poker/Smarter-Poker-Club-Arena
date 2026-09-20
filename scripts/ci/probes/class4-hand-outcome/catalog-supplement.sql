-- ISOLATED FIXTURE ONLY. Exact captured functions, never a production migration.
-- Atomic functions are admitted as pinned source authority; the Class4 fixture does not invoke them.
BEGIN;
SET LOCAL search_path=public,extensions,pg_catalog;

-- Missing row type dependency captured from production catalog 2026-09-17T03:39:53Z.
-- No rows or money writer calls are added. The captured atomic function remains source-only.
DO $$ BEGIN
 IF current_user<>'fixture_bootstrap' OR inet_server_addr() IS NOT NULL
    OR current_database()<>'class4_native_'||replace(current_setting('app.class4_execution_uuid'),'-','')
    OR to_regclass('public.table_pending_addons') IS NOT NULL
 THEN RAISE EXCEPTION 'Class4 addon fixture requires exact fresh owned database'; END IF;
END $$;
CREATE TABLE public.table_pending_addons (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "table_id" uuid NOT NULL,
 "user_id" uuid NOT NULL,
 "amount" numeric NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "resolved_at" timestamp with time zone,
 "applied_to_stack" numeric,
 "refunded" numeric,
 "kind" text DEFAULT 'addon'::text NOT NULL
);
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_amount_check" CHECK (amount > 0::numeric);
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_amount_is_cents" CHECK (amount IS NULL OR (amount::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND amount = round(amount, 2)) NOT VALID;
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_applied_is_cents" CHECK (applied_to_stack IS NULL OR (applied_to_stack::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND applied_to_stack = round(applied_to_stack, 2)) NOT VALID;
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_kind_check" CHECK (kind = ANY (ARRAY['addon'::text, 'rebuy'::text]));
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_pkey" PRIMARY KEY (id);
ALTER TABLE public.table_pending_addons ADD CONSTRAINT "table_pending_addons_refunded_is_cents" CHECK (refunded IS NULL OR (refunded::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND refunded = round(refunded, 2)) NOT VALID;
CREATE INDEX idx_table_pending_addons_unresolved_all ON public.table_pending_addons USING btree (created_at) WHERE (resolved_at IS NULL);
ALTER TABLE public.table_pending_addons OWNER TO postgres;
ALTER TABLE public.table_pending_addons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.table_pending_addons FROM PUBLIC,fixture_bootstrap,anon,authenticated,service_role;
GRANT SELECT,REFERENCES,TRIGGER ON public.table_pending_addons TO anon,authenticated;
GRANT ALL ON public.table_pending_addons TO service_role;
-- Captured catalog has no policies and no non-internal triggers.

-- Restore every omitted non-unique index consumed by the unchanged Class4
-- schema guard. All nine definitions match the live catalog read on 2026-09-17.
CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> 'incident_id'::text))) WHERE (context ? 'incident_id'::text);
CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> 'incident_id'::text))::uuid)) WHERE ((context ->> 'incident_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text);
CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved);
CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> 'reported_by'::text)), created_at DESC);
CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false);
CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by);
CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity);
CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC);
CREATE INDEX idx_hand_atomic_commits_post_commit_pending ON public.hand_atomic_commits USING btree (table_id, hand_number) WHERE ((post_commit_payload IS NOT NULL) AND (post_commit_completed_at IS NULL));

-- Exact existing mirror lookup index captured 2026-09-17T04:20:04Z.
-- The original schema capture omitted this non-unique UUID-expression index.
CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> 'alert_id'::text))::uuid)) WHERE ((metadata ->> 'alert_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text);

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_locked_tournament_id uuid;
  v_holder text;
  v_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_lease_found boolean;
  v_scope text;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'invalid_hand_lease_authority'
    );
  END IF;

  /* This read is deliberately unlocked and is used only to choose one lease
     relation.  No mutation follows until the chosen lease is locked and the
     tables row is itself locked/re-read below. */
  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;

  IF v_tournament_id IS NULL THEN
    v_scope := 'table';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.table_id = p_table_id
     FOR KEY SHARE;
    v_lease_found := FOUND;
  ELSE
    v_scope := 'tournament';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT
     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and
     -- nothing else, so the heartbeat can still renew this row.
     FOR KEY SHARE;
    v_lease_found := FOUND;
  END IF;

  IF NOT v_lease_found
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_holder IS DISTINCT FROM p_instance_id
     OR v_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_lost',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  IF v_heartbeat_at < clock_timestamp() - make_interval(
       secs => public.fn_engine_lease_stale_seconds()
     ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_stale',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  /* Match the unchanged core and manager lock order before taking the mutable
     table row.  FOR SHARE excludes tournament lifecycle updates without
     serializing hands at distinct tables in the same event. */
  IF v_tournament_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');
    END IF;
  END IF;

  /* Cash uses lease -> table. Tournament settlement uses
     lease -> tournament parent -> table. Holding the exact lease now prevents
     takeover until the unchanged core has committed or rolled back. */
  SELECT t.tournament_id INTO v_locked_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;
  IF v_locked_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_scope_changed'
    );
  END IF;

  RETURN public.fn_ca_commit_hand_settlement_before_lease_generation(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units
  );
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) TO postgres;
CREATE OR REPLACE FUNCTION public.fn_raise_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id       uuid;
  v_sev      text;
  v_uid      uuid := auth.uid();
  v_recent   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to raise a financial alert'
      USING ERRCODE = '28000';
  END IF;

  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  -- Flood guard: at most 30 alerts per reporter per minute. Returning NULL
  -- rather than raising keeps the caller's error path clean; the caller still
  -- escalates to its own error reporter when it gets no id back.
  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND context ->> 'reported_by' = v_uid::text;
  IF v_recent >= 30 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    left(coalesce(nullif(p_source, ''), 'unknown'), 200),
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('reported_by', v_uid::text, 'channel', 'client_rpc'),
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_raise_financial_alert(text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_raise_financial_alert(text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_raise_financial_alert(text,text,text,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_raise_financial_alert(text,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_raise_financial_alert(text,text,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_commit public.hand_atomic_commits%ROWTYPE;
  v_payload jsonb;
  v_hash text;
  v_rake jsonb;
  v_bbj jsonb;
  v_pending jsonb;
  v_item jsonb;
  v_rake_result record;
  v_promo_result jsonb;
  v_pool_id uuid;
  v_union_id uuid;
  v_contribution_id uuid;
  v_insurance_id uuid;
  v_addon_result record;
  v_addon public.table_pending_addons%ROWTYPE;
  v_time_bank_count integer := 0;
  v_promo_count integer := 0;
  v_insurance_count integer := 0;
  v_addon_count integer := 0;
  v_result jsonb;
BEGIN
  /* Read only the scope, then take the per-table mutex before the row lock.
     This gives every hand at one table the same lock order. */
  SELECT c.table_id INTO v_table_id
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );

  SELECT c.* INTO v_commit
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;
  IF v_commit.post_commit_payload IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'legacy_no_obligations',
      'hand_id', p_hand_id
    );
  END IF;
  IF v_commit.post_commit_completed_at IS NOT NULL THEN
    RETURN COALESCE(v_commit.post_commit_result, '{}'::jsonb) || jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'hand_id', p_hand_id,
      'completed_at', v_commit.post_commit_completed_at
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.hand_atomic_commits earlier
     WHERE earlier.table_id = v_commit.table_id
       AND earlier.hand_number < v_commit.hand_number
       AND earlier.post_commit_payload IS NOT NULL
       AND earlier.post_commit_completed_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'predecessor_pending',
      'hand_id', p_hand_id
    );
  END IF;

  v_payload := v_commit.post_commit_payload;
  v_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  IF v_commit.post_commit_payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'post-commit obligation payload hash mismatch for hand %', p_hand_id;
  END IF;

  /* Time banks were stamped inside the accepted-hand transaction while the
     exact lease and seat locks were held. A delayed consumer must never apply
     those older values again after hand N+1, a table break, or a seat move. */
  IF jsonb_typeof(v_payload->'time_banks') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid time-bank audit payload for hand %', p_hand_id;
  END IF;
  v_time_bank_count := jsonb_array_length(v_payload->'time_banks');

  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=v_table_id AND c.asset='diamonds') AND (
    v_payload->'rake' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'bbj_contribution' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'pending_addons' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'promo_playthrough' IS DISTINCT FROM '[]'::jsonb
    OR v_payload->'insurance' IS DISTINCT FROM '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'diamond_hand_has_chip_obligations';
  END IF;
  v_rake := v_payload->'rake';
  IF v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null' THEN
    IF jsonb_typeof(v_rake) <> 'object'
       OR COALESCE((v_rake->>'amount')::numeric, 0) <= 0
       OR (v_rake->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid rake obligation for hand %', p_hand_id;
    END IF;
    IF v_commit.hand_number > 2147483647 THEN
      RAISE EXCEPTION 'rake hand number exceeds downstream integer contract: %',
        v_commit.hand_number;
    END IF;

    SELECT * INTO v_rake_result
      FROM public.atomic_distribute_rake(
        v_commit.table_id,
        (v_rake->>'club_id')::uuid,
        v_commit.hand_id,
        v_commit.hand_number::integer,
        (v_rake->>'amount')::numeric,
        COALESCE((v_rake->>'bbj')::numeric, 0),
        NULLIF(v_rake->>'pot', '')::numeric,
        NULLIF(v_rake->>'num_players', '')::integer,
        COALESCE(v_rake->'contributions', '{}'::jsonb),
        NULLIF(v_rake->>'tournament_id', '')::uuid,
        COALESCE(v_rake->'returned_uncalled', '{}'::jsonb),
        COALESCE(NULLIF(v_rake->>'method', ''), 'WEIGHTED_CONTRIBUTED')
      );
    IF NOT FOUND OR NOT (
      COALESCE(v_rake_result.applied, false)
      OR COALESCE(v_rake_result.already_processed, false)
      OR v_rake_result.rake_record_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'rake obligation did not produce a receipt for hand %', p_hand_id;
    END IF;
  END IF;

  v_bbj := v_payload->'bbj_contribution';
  IF v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null' THEN
    IF jsonb_typeof(v_bbj) <> 'object'
       OR COALESCE((v_bbj->>'amount')::numeric, 0) <= 0
       OR (v_bbj->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid BBJ contribution obligation for hand %', p_hand_id;
    END IF;

    SELECT c.union_id INTO v_union_id
      FROM public.clubs c
     WHERE c.id = (v_bbj->>'club_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BBJ obligation club not found for hand %', p_hand_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      'bbj-pool:' || COALESCE(v_union_id::text, 'club:' || (v_bbj->>'club_id')),
      0
    ));
    IF v_union_id IS NULL THEN
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.club_id = (v_bbj->>'club_id')::uuid
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    ELSE
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.union_id = v_union_id
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    END IF;

    IF v_pool_id IS NULL THEN
      IF v_union_id IS NULL THEN
        INSERT INTO public.bbj_pools(
          club_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          (v_bbj->>'club_id')::uuid, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      ELSE
        INSERT INTO public.bbj_pools(
          union_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          v_union_id, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      END IF;
    END IF;

    SELECT r.id INTO v_contribution_id
      FROM public.bbj_record_contribution(
        v_pool_id,
        v_commit.hand_id,
        v_commit.table_id,
        (v_bbj->>'amount')::numeric,
        0, 0, 0,
        COALESCE((v_bbj->>'big_blind')::numeric, 2),
        v_commit.hand_number::integer,
        (v_bbj->>'club_id')::uuid
      ) r;
    IF v_contribution_id IS NULL THEN
      RAISE EXCEPTION 'BBJ contribution produced no receipt for hand %', p_hand_id;
    END IF;
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'promo_playthrough')
     ORDER BY value->>'user_id'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'user_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE((v_item->>'wagered')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid promo obligation for hand %', p_hand_id;
    END IF;
    v_promo_result := public.promo_apply_playthrough(
      (v_item->>'club_id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'wagered')::numeric
    );
    IF v_promo_result->>'reason' IN ('engine_only', 'no_wager') THEN
      RAISE EXCEPTION 'promo obligation refused for hand %: %',
        p_hand_id, v_promo_result;
    END IF;
    v_promo_count := v_promo_count + 1;
  END LOOP;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'insurance')
     ORDER BY value->>'player_id', value->>'kind'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'player_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid insurance obligation for hand %', p_hand_id;
    END IF;
    SELECT r.id INTO v_insurance_id
      FROM public.record_insurance_transaction(
        v_commit.table_id,
        (v_item->>'club_id')::uuid,
        v_commit.hand_number::integer,
        (v_item->>'player_id')::uuid,
        COALESCE((v_item->>'equity_percent')::numeric, 0),
        COALESCE((v_item->>'premium')::numeric, 0),
        COALESCE((v_item->>'insured_amount')::numeric, 0),
        COALESCE((v_item->>'payout')::numeric, 0),
        COALESCE((v_item->>'player_won')::boolean, false),
        COALESCE(NULLIF(v_item->>'kind', ''), 'insurance')::varchar
      ) r;
    IF v_insurance_id IS NULL THEN
      RAISE EXCEPTION 'insurance obligation produced no receipt for hand %', p_hand_id;
    END IF;
    v_insurance_count := v_insurance_count + 1;
  END LOOP;

  v_pending := v_payload->'pending_addons';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) <> 'null' THEN
    IF jsonb_typeof(v_pending) <> 'object'
       OR COALESCE((v_pending->>'enabled')::boolean, false) IS NOT TRUE
       OR jsonb_typeof(v_pending->'ids') IS DISTINCT FROM 'array'
       OR NULLIF(v_pending->>'max_buy_in', '') IS NULL
       OR (v_pending->>'max_buy_in')::numeric <= 0 THEN
      RAISE EXCEPTION 'invalid pending-add-on obligation for hand %', p_hand_id;
    END IF;
    FOR v_item IN
      SELECT value
        FROM jsonb_array_elements(v_pending->'ids')
       ORDER BY value #>> '{}'
    LOOP
      IF (v_item #>> '{}') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        RAISE EXCEPTION 'pending add-on % is not frozen for table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      -- Recovery can encounter an ID also frozen by an earlier accepted
      -- hand. The resolver owns exactly-once delivery and returns its stored
      -- result on replay. A resolved row is evidence, not a failed payment.
      SELECT a.* INTO v_addon
        FROM public.table_pending_addons a
       WHERE a.id = (v_item #>> '{}')::uuid
         AND a.table_id = v_commit.table_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % does not belong to table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      SELECT * INTO v_addon_result
        FROM public.resolve_pending_addon(
          (v_item #>> '{}')::uuid,
          NULLIF(v_pending->>'max_buy_in', '')::numeric
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % produced no receipt for hand %',
          v_item, p_hand_id;
      END IF;
      IF v_addon.amount IS NULL OR v_addon.amount <= 0
         OR v_addon.amount::text IN ('NaN', 'Infinity', '-Infinity')
         OR (v_addon.resolved_at IS NOT NULL AND
             (v_addon.applied_to_stack IS NULL OR v_addon.refunded IS NULL))
         OR v_addon_result.applied IS NULL OR v_addon_result.applied < 0
         OR v_addon_result.applied::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.applied <> round(v_addon_result.applied, 2)
         OR v_addon_result.refunded IS NULL OR v_addon_result.refunded < 0
         OR v_addon_result.refunded::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.refunded <> round(v_addon_result.refunded, 2)
         OR v_addon_result.applied + v_addon_result.refunded
              IS DISTINCT FROM round(v_addon.amount, 2)
      THEN
        RAISE EXCEPTION 'pending add-on % has an incomplete resolution receipt for hand %',
          v_item, p_hand_id;
      END IF;
      v_addon_count := v_addon_count + 1;
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'already_completed', false,
    'hand_id', p_hand_id,
    'hand_number', v_commit.hand_number,
    'time_banks', v_time_bank_count,
    'rake', v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null',
    'bbj_contribution', v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null',
    'promo_playthrough', v_promo_count,
    'insurance', v_insurance_count,
    'pending_addons', v_addon_count
  );

  UPDATE public.hand_atomic_commits c
     SET post_commit_completed_at = clock_timestamp(),
         post_commit_result = v_result
   WHERE c.hand_id = p_hand_id
     AND c.post_commit_completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-commit completion receipt was lost for hand %', p_hand_id;
  END IF;

  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_stack_result jsonb;
  v_hand_id uuid;
  v_existing public.hand_history%ROWTYPE;
  v_prior public.hand_atomic_commits%ROWTYPE;
  v_commit_hash text;
  v_normalized_stacks jsonb;
  v_normalized_units jsonb;
  v_stack jsonb;
  v_uid uuid;
  v_written numeric;
  v_before numeric;
  v_seat record;
  v_zero_generation jsonb;
  v_zero_generation_count integer;
  v_prompt_until timestamptz;
  v_rebuy_window jsonb;
  v_rebuy_offer_available boolean;
  v_n integer;
  v_distinct integer;
  v_changed integer;
  v_candidate_id uuid;
BEGIN
  -- External authority is the EXECUTE ACL on the lease-fenced public wrapper.
  -- This nested SECURITY DEFINER core is owner-only and must remain callable
  -- when its preserved production owner is neither postgres nor service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_stacks)<>'array' OR jsonb_array_length(p_stacks)=0
     OR jsonb_typeof(p_hand_row)<>'object'
     OR jsonb_typeof(coalesce(p_units,'[]'::jsonb))<>'array'
     OR coalesce(p_hand_row->>'table_id','')<>p_table_id::text
     OR coalesce(p_hand_row->>'hand_number','')<>p_hand_number::text THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_atomic_hand_payload');
  END IF;

  SELECT count(*), count(DISTINCT x->>'user_id')
    INTO v_n, v_distinct
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND coalesce(x->>'user_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_n<>jsonb_array_length(p_stacks) OR v_distinct<>v_n THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_or_duplicate_stack_rows');
  END IF;

  SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO v_normalized_stacks
    FROM jsonb_array_elements(p_stacks) x;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_normalized_units
    FROM jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) x;
  v_commit_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'table_id',p_table_id,'hand_number',p_hand_number,
    'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
    'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
    'units',v_normalized_units)::text,'UTF8'),'sha256'),'hex');

  -- Lock order is global tournament lifecycle -> table -> exact table hand.
  -- Paid admissions take the global root exclusively before the same table
  -- lock; unrelated hands share the lifecycle root and remain concurrent.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-table:'||p_table_id::text,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-hand:'||p_hand_number::text,0));

  SELECT * INTO v_prior
    FROM public.hand_atomic_commits c
   WHERE c.table_id=p_table_id
     AND c.hand_number=p_hand_number
   FOR UPDATE;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_commit_hash THEN
      RETURN jsonb_build_object(
        'success',false,'reason','atomic_hand_payload_conflict',
        'hand_number',p_hand_number,'existing_table_id',v_prior.table_id);
    END IF;
    RETURN v_prior.stack_result || jsonb_build_object(
      'success',true,'atomic_hand_commit',true,'replay',true,
      'history_id',v_prior.hand_id,'commit_hash',v_prior.payload_hash);
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t WHERE t.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'reason','table_not_found');
  END IF;

  IF (p_hand_row->>'tournament_id') IS DISTINCT FROM v_tournament_id::text THEN
    RETURN jsonb_build_object(
      'success',false,'reason','hand_tournament_mismatch',
      'table_tournament_id',v_tournament_id,
      'row_tournament_id',p_hand_row->>'tournament_id');
  END IF;

  BEGIN
    IF v_tournament_id IS NOT NULL THEN
      PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR SHARE;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id=v_tournament_id
         AND tp.user_id IN (
           SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
       ORDER BY tp.user_id
       FOR UPDATE;
    END IF;

    v_stack_result := public.fn_ca_settle_hand_stacks_absolute(
      p_table_id,p_hand_number,v_normalized_stacks,p_rake,p_bbj,p_ref,p_inflow);
    IF coalesce((v_stack_result->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN v_stack_result || jsonb_build_object('atomic_hand_commit',false);
    END IF;
    IF coalesce((v_stack_result->>'replay')::boolean,false) IS TRUE THEN
      RAISE EXCEPTION 'legacy stack settlement exists for hand % without an atomic receipt',
        p_hand_number USING ERRCODE='integrity_constraint_violation';
    END IF;

    SELECT * INTO v_existing
      FROM public.hand_history h
     WHERE h.table_id=p_table_id AND h.hand_number=p_hand_number;
    IF FOUND THEN
      RAISE EXCEPTION 'hand % already exists without an atomic commit receipt',p_hand_number
        USING ERRCODE='integrity_constraint_violation';
    ELSE
      PERFORM set_config('app.atomic_hand_commit','on',true);
      v_hand_id := public.fn_ca_insert_hand_with_awards(p_hand_row,p_units);
    END IF;

    IF v_tournament_id IS NOT NULL THEN
      IF jsonb_typeof(
           v_stack_result->'tournament_zero_stack_seat_generations')
             IS DISTINCT FROM 'array'
         OR jsonb_array_length(
              v_stack_result->'tournament_zero_stack_seat_generations')
              IS DISTINCT FROM
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1)
         OR (
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1) > 0
              AND (v_stack_result->>'tournament_zero_stack_vacated_at') IS NULL
            ) THEN
        RAISE EXCEPTION
          'accepted tournament hand omitted exact zero-seat generation evidence';
      END IF;

      FOR v_stack IN SELECT value FROM jsonb_array_elements(p_stacks)
      LOOP
        v_uid := (v_stack->>'user_id')::uuid;
        v_before := round((v_stack->>'stack_before')::numeric,2);
        v_written := round((v_stack_result->'written'->>v_uid::text)::numeric,2);
        IF v_written IS NULL THEN
          RAISE EXCEPTION 'accepted tournament hand omitted written stack for %',v_uid;
        END IF;
        IF v_written<>trunc(v_written) THEN
          RAISE EXCEPTION 'accepted tournament hand produced fractional stack % for %',v_written,v_uid;
        END IF;

        IF v_written=0 THEN
          SELECT count(*) INTO v_zero_generation_count
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          IF v_zero_generation_count<>1 THEN
            RAISE EXCEPTION
              'accepted tournament hand has % zero-seat generations for %',
              v_zero_generation_count,v_uid USING ERRCODE='P0404';
          END IF;
          SELECT g.value INTO v_zero_generation
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.id=(v_zero_generation->>'seat_id')::uuid
             AND s.table_id=p_table_id
             AND s.user_id=v_uid
             AND s.seat_number=(v_zero_generation->>'seat_number')::integer
             AND s.joined_at=(v_zero_generation->>'joined_at')::timestamptz
             AND s.stack=0
             AND s.left_at=
                   (v_stack_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND lower(COALESCE(s.status,''))='left'
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost exact closed seat generation for %',v_uid
              USING ERRCODE='P0404';
          END IF;
        ELSE
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.table_id=p_table_id AND s.user_id=v_uid AND s.left_at IS NULL
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost active seat for % before generation capture',v_uid;
          END IF;
        END IF;

        UPDATE public.tournament_players tp
           SET chips=greatest(v_written,0)::integer,
               table_id=p_table_id,
               seat_number=v_seat.seat_number
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing';
        GET DIAGNOSTICS v_changed=ROW_COUNT;
        IF v_changed<>1 AND NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing'
             AND tp.chips=greatest(v_written,0)::integer
             AND tp.table_id=p_table_id
             AND tp.seat_number=v_seat.seat_number) THEN
          RAISE EXCEPTION
            'accepted tournament hand could not mirror playing roster row for %',v_uid;
        END IF;

        IF v_before>0 AND v_written=0 THEN
          SELECT
            (coalesce(t.is_rebuy,false)
               AND (t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<t.max_rebuys))
            OR
            (coalesce(t.is_reentry,false)
               AND (t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<t.max_reentries)),
            public.fn_ca_tournament_rebuy_window(v_tournament_id)
            INTO v_rebuy_offer_available,v_rebuy_window
            FROM public.tournaments t
            JOIN public.tournament_players tp
              ON tp.tournament_id=t.id AND tp.user_id=v_uid
           WHERE t.id=v_tournament_id;
          v_prompt_until:=CASE
            WHEN v_rebuy_offer_available
             AND coalesce((v_rebuy_window->>'open')::boolean,false)
            THEN (v_rebuy_window->>'prompt_until')::timestamptz
            ELSE NULL END;
          IF v_prompt_until IS NOT NULL
             AND v_prompt_until<=clock_timestamp() THEN
            RAISE EXCEPTION
              'authoritative rebuy window returned an expired prompt for tournament %',
              v_tournament_id USING ERRCODE='P0404';
          END IF;

          v_candidate_id := NULL;
          INSERT INTO public.tournament_knockout_candidates(
            tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
            hand_id,hand_number,stack_before,stack_after,rebuy_prompt_until)
          VALUES (
            v_tournament_id,v_uid,p_table_id,v_seat.id,v_seat.joined_at,
            v_hand_id,p_hand_number,v_before,0,v_prompt_until)
          -- One accepted hand is one immutable knockout generation. A rebuy can
          -- bust again in the same physical chair, so chair identity must never
          -- absorb that later hand.
          ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
          RETURNING id INTO v_candidate_id;
          IF v_candidate_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.tournament_knockout_candidates c
             WHERE c.tournament_id=v_tournament_id
               AND c.hand_number=p_hand_number
               AND c.eliminated_user_id=v_uid
               AND c.table_id=p_table_id
               AND c.seat_id=v_seat.id
               AND c.seat_joined_at=v_seat.joined_at
               AND c.hand_id=v_hand_id
               AND c.stack_before=v_before
               AND c.stack_after=0) THEN
            RAISE EXCEPTION
              'knockout candidate identity conflict for tournament %, hand %, user %',
              v_tournament_id,p_hand_number,v_uid;
          END IF;

          UPDATE public.tournament_players tp
             SET rebuy_prompt_until=v_prompt_until
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing';
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.hand_projection_outbox(hand_id,table_id,hand_number)
    VALUES (v_hand_id,p_table_id,p_hand_number);

    INSERT INTO public.hand_atomic_commits(
      table_id,hand_number,hand_id,payload_hash,stack_result)
    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);

    RETURN v_stack_result || jsonb_build_object(
      'success',true,
      'atomic_hand_commit',true,
      'history_id',v_hand_id,
      'tournament_id',v_tournament_id,
      'commit_hash',v_commit_hash);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',false,'atomic_hand_commit',false,'reason','atomic_hand_rolled_back',
      'error',SQLERRM,'sqlstate',SQLSTATE,'table_id',p_table_id,
      'hand_number',p_hand_number,'commit_hash',v_commit_hash);
  END;
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) TO postgres;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    OR p_hand_row->>'game_variant' IS DISTINCT FROM 'nlh'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_settled   integer := 0;
  v_released  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
BEGIN
  -- ── CLASS 1: the player was accused of being unpaid and has since been paid.
  -- Proven per alert against wallet_transactions, not assumed from elapsed
  -- time. `short` is what the check said they were owed; `got` is what the
  -- prize path actually credited them for that same event.
  SELECT array_agg(id) INTO v_paid_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_payout_guarantee_check'
       AND a.context->>'kind' = 'earner_not_paid'
       AND a.context->>'user_id' IS NOT NULL
       AND a.context->>'tournament_id' IS NOT NULL
       AND COALESCE((
             SELECT sum(w.amount) FROM public.wallet_transactions w
              WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                AND w.user_id           = (a.context->>'user_id')::uuid
                AND w.type = 'credit' AND w.category = 'prize'
           ), 0) >= COALESCE((a.context->>'short')::numeric, 0) - 0.01
     LIMIT p_limit
  ) s;
  v_paid := COALESCE(array_length(v_paid_ids, 1), 0);

  -- ── CLASS 2: every issue on the alert is an overpay, which 10.6 rule 3 says
  -- is absorbed and never clawed back. There is no action left to take, so
  -- "unresolved" is a false state. An alert carrying ANY other issue kind is
  -- deliberately left open.
  SELECT array_agg(id) INTO v_over_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_tournament_payout_reconcile'
       AND jsonb_typeof(a.context->'issues') = 'array'
       AND jsonb_array_length(a.context->'issues') > 0
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(a.context->'issues') i
              WHERE i->>'issue' IS DISTINCT FROM 'overpaid')
     LIMIT p_limit
  ) s;
  v_overpaid := COALESCE(array_length(v_over_ids, 1), 0);

  -- CLASS 3: the post-commit envelope this alert was raised about has since
  -- been applied. hand_atomic_commits.post_commit_completed_at is the durable
  -- proof; the alert is the memory of a moment when it was not yet set.
  SELECT COALESCE(array_agg(id), '{}') INTO v_settled_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c ON c.hand_id = (a.context->>'hand_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'ServerTableEngine.post_commit_obligations_pending'
       AND a.context->>'hand_id' IS NOT NULL
       AND c.post_commit_completed_at IS NOT NULL
     LIMIT p_limit
  ) s;
  v_settled := COALESCE(array_length(v_settled_ids, 1), 0);

  -- CLASS 4: a refused hand was released whole. Either the commit row for that
  -- exact hand now exists (the retry landed), or the table has since committed
  -- a LATER hand, which the per-table hand-order barrier only permits once the
  -- refused one is no longer in the way. Both are proof the money is settled;
  -- neither is elapsed time.
  SELECT COALESCE(array_agg(id), '{}') INTO v_rel_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('postHandTasks.hand_history_failed',
                        'ServerTableEngine.authoritative_hand_semantic_refusal')
       AND a.context->>'table_id' IS NOT NULL
       AND a.context->>'hand_number' IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.hand_atomic_commits c
          WHERE c.table_id = (a.context->>'table_id')::uuid
            AND c.hand_number >= (a.context->>'hand_number')::bigint)
     LIMIT p_limit
  ) s;
  v_released := COALESCE(array_length(v_rel_ids, 1), 0);

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the post-commit envelope for this hand has been applied; post_commit_completed_at is set',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_settled_ids);

    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the refused hand was released whole: this table has committed that hand or a later one, and an atomic refusal leaves nothing partial behind',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_rel_ids);
  END IF;

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'settled after the alert was raised; the prize path credited this player for this event',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'credited', COALESCE((
               SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                  AND w.user_id           = (a.context->>'user_id')::uuid
                  AND w.type = 'credit' AND w.category = 'prize'), 0))
     WHERE a.id = ANY(v_paid_ids);

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'overpay only; absorbed by the house per CLAUDE.md 10.6 rule 3, never clawed back',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_over_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'total', v_paid + v_overpaid + v_settled + v_released,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$function$;
ALTER FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) FROM PUBLIC,anon,authenticated,service_role,fixture_bootstrap;
GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) TO postgres,service_role;
COMMIT;
