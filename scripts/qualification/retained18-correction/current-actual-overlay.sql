SET check_function_bodies=off;
CREATE TABLE IF NOT EXISTS smarter_private.f06_hand_dispatch (fixture_placeholder boolean);
ALTER TABLE smarter_private.f06_hand_dispatch ADD COLUMN IF NOT EXISTS permit_id uuid;
ALTER TABLE smarter_private.f06_hand_dispatch ADD COLUMN IF NOT EXISTS xid bigint;
CREATE TABLE IF NOT EXISTS smarter_private.f06_hand_permits (fixture_placeholder boolean);
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS permit_id uuid;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS lifecycle bigint;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS custody_id uuid;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS generation uuid;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE smarter_private.f06_hand_permits ADD COLUMN IF NOT EXISTS evidence_id uuid;
CREATE TABLE IF NOT EXISTS smarter_private.f06_operations (fixture_placeholder boolean);
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS break_id uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS ordinal bigint;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS source_table_id uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS lifecycle bigint;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS boundary_id uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS origin_generation uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS manifest jsonb;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS revision bigint;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS custody_id uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS custody_generation uuid;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS cleanup_kind text;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS close_receipt jsonb;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
ALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS abort_receipt_id uuid;
CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_disposals (fixture_placeholder boolean);
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS submission_id uuid;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS receipt_id uuid;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS witness_hand_number bigint;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS expected jsonb;
ALTER TABLE smarter_private.hand_submission_disposals ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_failures (fixture_placeholder boolean);
ALTER TABLE smarter_private.hand_submission_failures ADD COLUMN IF NOT EXISTS submission_id uuid;
ALTER TABLE smarter_private.hand_submission_failures ADD COLUMN IF NOT EXISTS transaction_id bigint;
ALTER TABLE smarter_private.hand_submission_failures ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE smarter_private.hand_submission_failures ADD COLUMN IF NOT EXISTS result jsonb;
CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_resume_marks (fixture_placeholder boolean);
ALTER TABLE smarter_private.hand_submission_resume_marks ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.hand_submission_resume_marks ADD COLUMN IF NOT EXISTS settled_through bigint;
ALTER TABLE smarter_private.hand_submission_resume_marks ADD COLUMN IF NOT EXISTS marked_at timestamp with time zone;
CREATE TABLE IF NOT EXISTS smarter_private.horse_settlement_key_certificates (fixture_placeholder boolean);
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS stack_hand_id uuid;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS history_hand_id uuid;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS manifest_id uuid;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS original_result_sha256 text;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS original_request_sha256 text;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS compact_result jsonb;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS accounting_evidence_sha256 text;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS settled_at timestamp with time zone;
ALTER TABLE smarter_private.horse_settlement_key_certificates ADD COLUMN IF NOT EXISTS compacted_at timestamp with time zone;
CREATE TABLE IF NOT EXISTS smarter_private.retired_cash_hand_custody (fixture_placeholder boolean);
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS submission_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS seat_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS occupancy_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS seat_joined_at timestamp with time zone;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS stack_before numeric;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS stack_after numeric;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS funding_club_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS original_left_at timestamp with time zone;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS original_inventory_event bigint;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS transaction_id bigint;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS restore_key text;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS issuance_ledger uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS original_time_bank jsonb;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS settlement_id uuid;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS accepted_time_bank jsonb;
ALTER TABLE smarter_private.retired_cash_hand_custody ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
CREATE TABLE IF NOT EXISTS smarter_private.retirement_original_hand_qualification (fixture_placeholder boolean);
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS submission_id uuid;
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE smarter_private.retirement_original_hand_qualification ADD COLUMN IF NOT EXISTS expected jsonb;

CREATE OR REPLACE FUNCTION smarter_private.f06_hand_dispatch_guard(tid uuid, hn bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
 IF h.state IN ('never_started','aborted_unsettled') THEN RAISE EXCEPTION 'F06_HAND_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 IF h.state='reserved' THEN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
 INSERT INTO smarter_private.f06_hand_dispatch VALUES(h.permit_id,txid_current()) ON CONFLICT(permit_id) DO UPDATE SET xid=EXCLUDED.xid;
 END IF;
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=tid AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_UNPERMITTED_HAND' USING ERRCODE='55000';
 END IF;
END $function$
;

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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks(p_table_id uuid, p_hand_id uuid, p_hand_number bigint DEFAULT NULL::bigint, p_deltas jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT 0, p_bbj numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claimed integer; v_prior record; v_sum numeric := 0; v_n integer := 0;
  e jsonb; v_uid uuid; v_delta numeric; v_updated integer;
  v_ca_id uuid; v_err text; v_result jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks is engine/service only';
  END IF;
  IF p_table_id IS NULL OR p_hand_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_deltas) IS DISTINCT FROM 'array' OR jsonb_array_length(p_deltas) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_deltas');
  END IF;

  -- claim (idempotent replay)
  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, p_hand_id, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = p_hand_id FOR UPDATE;
    IF v_prior.status = 'succeeded' THEN
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = p_hand_id;
    END IF;
  END IF;

  -- state machine
  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id,
                                     idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || p_hand_id::text, 'open', p_table_id, p_hand_id,
          'hand:' || p_table_id::text || ':' || p_hand_id::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- validation: exact scale + conservation
    FOR e IN SELECT * FROM jsonb_array_elements(p_deltas) LOOP
      v_delta := round((e->>'delta')::numeric, 2);
      IF v_delta IS DISTINCT FROM (e->>'delta')::numeric THEN
        RAISE EXCEPTION 'delta for % is not exact 2dp: %', e->>'user_id', e->>'delta';
      END IF;
      v_sum := v_sum + v_delta;
      v_n := v_n + 1;
    END LOOP;
    IF round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2) <> 0 THEN
      RAISE EXCEPTION 'conservation violation: deltas %.2f + rake %.2f + bbj %.2f != 0',
        v_sum, COALESCE(p_rake,0), COALESCE(p_bbj,0);
    END IF;
    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', v_sum,
                                  'rake', COALESCE(p_rake,0), 'bbj', COALESCE(p_bbj,0))
      WHERE id = v_ca_id AND state='locked_for_calculation';
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    -- apply: all seats or none, no stack below zero, seats never deleted
    FOR e IN SELECT * FROM jsonb_array_elements(p_deltas) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_delta := round((e->>'delta')::numeric, 2);
      CONTINUE WHEN v_delta = 0;
      UPDATE public.table_seats ts
         SET stack = round(ts.stack + v_delta, 2)
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         AND round(ts.stack + v_delta, 2) >= 0;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        RAISE EXCEPTION 'seat write failed for % (delta %): seat missing, left, or stack would go negative',
          v_uid, v_delta;
      END IF;
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', p_hand_id, 'hand_number', p_hand_number,
      'rake', COALESCE(p_rake,0), 'bbj', COALESCE(p_bbj,0));

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';

    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;  -- every stack write above is rolled back here
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000)
     WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2), 0,
        round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2),
        'settlement', 'table_seats', p_hand_id, NULL, NULL, p_table_id, NULL, p_hand_id,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_id', p_hand_id, 'hand_number', p_hand_number));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_id', p_hand_id);
  END;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric, p_ref text DEFAULT NULL::text, p_inflow numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_request jsonb;
  v_canonical jsonb;
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_before numeric; v_target numeric;
  v_delta_sum numeric := 0; v_expected numeric;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  v_delta_mode boolean;
  -- Exact seat identity is the row id plus the join instant. A vacated row can
  -- be reused in place, so neither user_id, chair number, nor row id is enough.
  v_exact_seat_generation boolean;
  v_exact_seat_id uuid;
  v_exact_seat_joined_at timestamptz;
  v_exact_seat_left_at timestamptz;
  v_exact_seat_club uuid;
  v_exact_seat_found boolean;
  v_retired_cash_original jsonb;
  v_targets jsonb := '{}'::jsonb;      -- user_id -> stack to write
  v_rebased jsonb := '{}'::jsonb;      -- user_id -> db_before - engine_before (delta mode only)
  v_rebase_rows jsonb := '[]'::jsonb;  -- rows for ca_seat_stack_rebases
  v_rebase_count integer := 0;
  -- 2026-09-04 (verification sweep): a seat that LEFT during the hand
  v_departed jsonb := '[]'::jsonb;   -- [{user_id, delta, club_id}]
  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;
  -- chip-std Lane F (2026-09-02): tournament conservation (absolute mode)
  v_tournament_id uuid;
  -- The hand result is also the durable final-stack boundary for a tournament.
  v_tournament_status text;
  v_payload_stack_count integer := 0;
  v_target_user_count integer := 0;
  v_tournament_player_count integer := 0;
  v_tournament_player_user_ids uuid[] := ARRAY[]::uuid[];
  v_tournament_player_chips jsonb := '[]'::jsonb;
  v_zero_stack_seat_count integer := 0;
  v_zero_stack_seat_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_user_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_seat_generations jsonb := '[]'::jsonb;
  v_zero_stack_vacated_at timestamptz;
  v_table_live_seat_count integer := 0;
  -- ONE SEAT WRITE PER HAND (2026-09-10): the accepted time-bank state the
  -- 12-argument door publishes for this exact table+hand, carried on the
  -- stack write so each seat row is written once per hand instead of twice.
  v_tb_env_text text;
  v_tb_env jsonb;
  v_tb_map jsonb;   -- lower(user_id) -> time-bank item, or NULL (stack-only write)
  v_tb jsonb;
  -- LIGHTNING PHASE 6 (20261001154813): {player: anchor table} for the
  -- anchors a Lightning settlement in THIS transaction names, '{}' otherwise.
  v_lightning_seats jsonb := '{}'::jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
             WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) THEN
    -- DIAMOND PHASE 8: a Diamond TOURNAMENT hand moves play units on the
    -- roster and the seat, exactly as a chip tournament hand does below.
    RETURN public.fn_poker_diamond_settle_cash_hand(
      p_table_id,p_hand_number,p_stacks,p_rake,p_bbj,p_ref,p_inflow);
  END IF;
  -- This implementation primitive is owner-only by ACL below. Do not inspect
  -- current_user inside a SECURITY DEFINER core: CREATE OR REPLACE preserves
  -- the production owner, so a valid call through the sole service wrapper
  -- may execute here as that owner rather than as postgres/service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stacks) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_stacks');
  END IF;


  -- One participant, one delta. Duplicates previously passed the sum check
  -- twice but wrote a single target, allowing a non-conserving final balance.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
                 OR (x ? 'stack_before' AND jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number')) THEN
    RAISE EXCEPTION 'Invalid hand settlement participant' USING ERRCODE = '22023';
  END IF;

  -- Rolling expansion accepts either a wholly legacy roster or a wholly exact
  -- roster. One-sided and mixed generations can otherwise create a request
  -- whose hash says one thing while individual rows are selected another way.
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
    RAISE EXCEPTION 'Invalid hand settlement seat generation'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
    RAISE EXCEPTION 'Mixed legacy and exact hand settlement seat generations'
      USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
    INTO v_exact_seat_generation
    FROM jsonb_array_elements(p_stacks) x;

  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'Duplicate hand settlement participant' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'stack_before')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'stack_before')) THEN
    RAISE EXCEPTION 'Mixed absolute and delta hand settlement' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', (x->>'seat_id')::uuid,
              'seat_joined_at', x->>'seat_joined_at')
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;
  v_request := jsonb_build_object('stacks', v_canonical, 'rake', p_rake,
    'bbj', p_bbj, 'inflow', p_inflow);

  /* DELTA MODE (chip standard 2026-09-04): the engine says what each stack
     WAS when it dealt and what it IS now; the database applies the difference
     to whatever the row holds. Every element must carry stack_before, or the
     whole call is absolute - a mixed payload would silently erase on the
     seats that lacked it. */
  SELECT bool_and(x ? 'stack_before' AND jsonb_typeof(x -> 'stack_before') = 'number')
    INTO v_delta_mode
    FROM jsonb_array_elements(p_stacks) x;
  v_delta_mode := COALESCE(v_delta_mode, false);
  -- LIGHTNING PHASE 6 (20261001154813): THE ONE ADAPTER. A Lightning hand is
  -- recorded at its Cluster's front table while each anchor seat sits at its
  -- own table of the Cluster. fn_lightning_settle_hand names every anchor in
  -- lightning_settlement_marker for this transaction, and only the four
  -- exact-generation seat predicates below read the answer; for every
  -- physical hand it is '{}' and each still compares to p_table_id.
  v_lightning_seats := public.fn_lightning_settlement_seats(p_table_id, p_hand_number);
  IF v_lightning_seats <> '{}'::jsonb
     AND (NOT v_exact_seat_generation OR NOT v_delta_mode
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_canonical) x
                      WHERE NOT (v_lightning_seats ? (x->>'user_id')))) THEN
    RAISE EXCEPTION 'Lightning hand settlement must name every anchor by its exact seat generation in delta mode'
      USING ERRCODE = '22023';
  END IF;

  -- stable hand id from (table, hand number[, ref])
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text
                || CASE WHEN p_ref IS NULL OR p_ref = '' THEN '' ELSE ':' || p_ref END)::uuid;

  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, v_hand, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = v_hand FOR UPDATE;
    IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates c WHERE c.table_id=p_table_id AND c.stack_hand_id=v_hand) AND v_prior.status IS DISTINCT FROM 'succeeded' THEN
      RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACT_STATUS_CONFLICT' USING ERRCODE='55000';
    END IF;
    IF v_prior.status = 'succeeded' THEN
      v_prior.result:=smarter_private.horse_settlement_original_result(p_table_id,v_hand,v_prior.result);
      -- Old receipts predate payload storage. New receipts bind the full request.
      IF v_prior.result ? 'request' AND v_prior.result->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'Hand settlement identity belongs to a different payload' USING ERRCODE = '22023';
      END IF;
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = v_hand;
    END IF;
  END IF;

  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id, idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || v_hand::text, 'open', p_table_id, v_hand,
          'hand:' || p_table_id::text || ':' || v_hand::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- ONE LOCK ORDER WITH TERMINAL CLOSE (20260908): tournament,
    -- target tournament players by user_id/id, then target seats by id. The
    -- terminal authority takes the same order. A hand that waited behind a
    -- terminal commit sees COMPLETED and is refused before touching a seat.
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
        FROM public.tournaments t
       WHERE t.id = v_tournament_id
       FOR SHARE;
      IF NOT FOUND OR v_tournament_status <> 'RUNNING' THEN
        RAISE EXCEPTION
          'tournament % is not RUNNING at the durable hand boundary',
          v_tournament_id USING ERRCODE = '55000';
      END IF;
      SELECT count(*),count(DISTINCT (x.value->>'user_id')::uuid)
        INTO v_payload_stack_count,v_target_user_count
        FROM jsonb_array_elements(v_canonical) AS x(value);
      IF v_target_user_count <> v_payload_stack_count THEN
        RAISE EXCEPTION 'tournament hand % contains duplicate player stacks',
          p_hand_number USING ERRCODE = '22023';
      END IF;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value))
       ORDER BY tp.user_id,tp.id
       FOR UPDATE;
      SELECT count(*) INTO v_tournament_player_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value));
      IF v_tournament_player_count <> v_target_user_count THEN
        RAISE EXCEPTION
          'tournament % hand % does not map every stack to one playing player',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
      -- A zero-seat vacate fires the seat-first table count trigger. Own the
      -- table before the seats, matching terminal close, so that trigger only
      -- reacquires a row this transaction already holds.
      PERFORM 1 FROM public.tables tb
       WHERE tb.id = p_table_id AND tb.tournament_id = v_tournament_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament table % changed while hand % was locking',
          p_table_id,p_hand_number USING ERRCODE = '40001';
      END IF;
    END IF;

    -- Acquire every live target seat once in durable row-id order before the
    -- original loop. The loop's individual SELECT FOR UPDATE calls then
    -- reacquire locks that this transaction already owns. v_canonical is also
    -- the immutable replay identity, so lock, write and receipt use one roster.
    PERFORM 1
      FROM public.table_seats ts
      JOIN (
        SELECT DISTINCT (x.value->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(v_canonical) AS x(value)
      ) target ON target.user_id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
     ORDER BY ts.id
     FOR UPDATE OF ts;

    -- lock seats, compute deltas / targets
    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      IF v_new IS NULL OR v_new < 0 THEN
        RAISE EXCEPTION 'invalid stack for %: %', e->>'user_id', e->>'stack';
      END IF;
      v_exact_seat_id := NULL;
      v_exact_seat_joined_at := NULL;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      IF v_exact_seat_generation THEN
        v_exact_seat_id := (e->>'seat_id')::uuid;
        v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
        SELECT ts.stack, ts.left_at, ts.club_id
          INTO v_old, v_exact_seat_left_at, v_exact_seat_club
          FROM public.table_seats ts
         WHERE ts.id = v_exact_seat_id
           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
           AND ts.user_id = v_uid
         FOR UPDATE;
      ELSE
        SELECT ts.stack INTO v_old FROM public.table_seats ts
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         FOR UPDATE;
      END IF;
      v_exact_seat_found := FOUND;
      IF v_exact_seat_generation AND (NOT v_exact_seat_found OR v_exact_seat_left_at IS NOT NULL) THEN
        v_retired_cash_original:=smarter_private.retired_cash_original_stack(p_table_id,p_hand_number,v_uid,
          v_exact_seat_id,v_exact_seat_joined_at,(e->>'stack_before')::numeric,v_new);
        IF v_retired_cash_original IS NOT NULL THEN
          -- A transaction-owned original obligation, not a replacement chair.
          v_exact_seat_found:=true;
          v_exact_seat_left_at:=(v_retired_cash_original->>'left_at')::timestamptz;
          v_exact_seat_club:=(v_retired_cash_original->>'funding_club_id')::uuid;
        END IF;
      END IF;
      IF NOT v_exact_seat_found
         OR (v_exact_seat_generation AND v_exact_seat_left_at IS NOT NULL) THEN
        -- If the exact row id was reused in place, joined_at no longer matches.
        -- There is no historical row left to settle, so fail the hand whole.
        IF v_exact_seat_generation AND NOT v_exact_seat_found THEN
          RAISE EXCEPTION
            'exact seat generation missing or replaced for % - hand write rejected whole',
            v_uid;
        END IF;
        /* A SEAT THAT LEFT DURING THE HAND (2026-09-04, verification sweep).
           In delta mode the player's own delta is settled against the club
           wallet the seat cashed out to, keyed on hand + user, and the players
           still seated get their deltas as usual. Refusing the whole hand here
           left the winner unpaid in the database and the leaver refunded the
           bet they had put in the pot (the exit cashes out the seat's stack
           as it stood BEFORE the hand). Measured before this: 3 cash hands in
           the first 40 minutes of delta mode, each a mid-hand leave_pending
           cash-out raced by a stale settlement step. Absolute mode still
           refuses: with no stack_before there is no delta to settle. */
        /* CASH TABLES ONLY. Tournament chips are play chips: a seat that a
           table balance moved or an elimination removed mid-hand has no
           wallet to settle against, and settling it debited 230 real chips
           from a player on 2026-09-04 13:04 (reversed in 20260904131500).
           The tournament conservation gate in the engine and the tournament
           branch below own that case; here it is refused whole, as before. */
        IF v_delta_mode AND NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = p_table_id AND tb.tournament_id IS NOT NULL) THEN
          v_before := round((e->>'stack_before')::numeric, 2);
          IF v_before IS NULL OR v_before < 0 THEN
            RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
          END IF;
          IF v_exact_seat_generation THEN
            -- Use the club captured on the exact departed generation. Looking
            -- up the latest departed row can cross a later rejoin or club move.
            v_dep_club := v_exact_seat_club;
          ELSE
            SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC LIMIT 1;
          END IF;
          IF v_dep_club IS NULL AND NOT v_exact_seat_generation THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
          /* SETTLING NOTHING NEEDS NO WALLET (2026-09-08). A seat that left
             having moved no chips has nothing to settle against a wallet, and
             the departed loop below already skips a zero delta. Demanding the
             wallet first refused whole hands over seats that owed nothing -
             hand 7903456, which nets to zero between two seated players, was
             refused because a third seat with a delta of 0.00 had gone. */
          IF round(v_new - v_before, 2) = 0 THEN
            v_n := v_n + 1;
            CONTINUE;
          END IF;
          IF v_dep_club IS NULL OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = v_uid AND m.club_id = v_dep_club) THEN
            RAISE EXCEPTION 'seat missing or left for % and no club wallet resolves for it - hand write rejected whole', v_uid;
          END IF;
          v_delta_sum := v_delta_sum + (v_new - v_before);
          v_departed := v_departed || jsonb_build_array(
            jsonb_build_object(
              'user_id', v_uid,
              'delta', round(v_new - v_before, 2),
              'club_id', v_dep_club
            ) || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ) ELSE '{}'::jsonb END
          );
          v_n := v_n + 1;
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_old := COALESCE(v_old, 0);

      IF v_delta_mode THEN
        v_before := round((e->>'stack_before')::numeric, 2);
        IF v_before IS NULL OR v_before < 0 THEN
          RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
        END IF;
        v_target := round(v_old + (v_new - v_before), 2);
        IF v_target < 0 THEN
          RAISE EXCEPTION 'negative stack for % after applying delta % to the seat''s % (engine dealt from %) - hand write rejected whole',
            v_uid, round(v_new - v_before, 2), v_old, v_before;
        END IF;
        v_delta_sum := v_delta_sum + (v_new - v_before);
        IF round(v_old - v_before, 2) <> 0 THEN
          v_rebased := v_rebased || jsonb_build_object(v_uid::text, round(v_old - v_before, 2));
          v_rebase_rows := v_rebase_rows || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'engine_before', v_before, 'db_before', v_old,
            'engine_after', v_new, 'written', v_target));
          v_rebase_count := v_rebase_count + 1;
        END IF;
      ELSE
        v_target := v_new;
        v_delta_sum := v_delta_sum + (v_new - v_old);
      END IF;
      v_targets := v_targets || jsonb_build_object(v_uid::text, v_target);
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
                                  'rebased', v_rebased, 'ref', p_ref, 'departed', v_departed)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;

    IF v_delta_mode THEN
      /* THE IDENTITY, ON THE ENGINE'S OWN ARITHMETIC: what the seats gained
         is what arrived from a declared pool, less what left as rake and
         jackpot drop. Checked on every table, cash or tournament, on every
         write. A credit that landed on the row is outside the identity by
         construction - it is in v_old, not in the delta - so it is preserved
         rather than "explained". */
      v_expected := COALESCE(p_inflow, 0) - COALESCE(p_rake, 0) - COALESCE(p_bbj, 0);
      IF round(v_delta_sum - v_expected, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas % != inflow % - rake % - bbj % (table % hand %) - write refused whole',
          round(v_delta_sum, 2), COALESCE(p_inflow, 0), COALESCE(p_rake, 0), COALESCE(p_bbj, 0),
          p_table_id, p_hand_number::text || COALESCE(':' || p_ref, '');
      END IF;
    ELSE
      -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
      -- Absolute mode only. A tournament table has no rake and no BBJ drop,
      -- so the named seats must sum, after this write, to exactly what they
      -- summed to before it. A paid rebuy/re-entry/add-on commits its seat and
      -- roster under the accepted-hand table lock. The dealing loop reloads
      -- those authoritative rows before admitting the next hand. Therefore a
      -- non-zero delta is stale hand input, never permission to scan payment
      -- history and reconstruct chips. Refuse the whole hand at the boundary.
      IF v_tournament_id IS NOT NULL AND round(v_delta_sum, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation (tournament %): stale accepted-hand stacks changed the table total by % across % seat(s) of table % hand % - paid seat/roster generations must be reloaded before dealing; write refused whole',
          v_tournament_id,round(v_delta_sum,2),v_n,p_table_id,p_hand_number;
      END IF;

      -- strict conservation only when rake is declared
      IF p_rake IS NOT NULL
         AND round(v_delta_sum + p_rake + COALESCE(p_bbj, 0), 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas %.2f + rake %.2f + bbj %.2f != 0',
          v_delta_sum, p_rake, COALESCE(p_bbj, 0);
      END IF;
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    /* ONE SEAT WRITE PER HAND (2026-09-10). fn_ca_commit_hand_settlement (the
       12-argument door) validates the hand's time-bank obligations, publishes
       them in the transaction-local setting app.ca_hand_time_banks, and only
       then calls down to this core. When that envelope names this exact table
       and hand, the stack write below also sets the two time-bank columns,
       under the same seat guards, so the seat row is written once per hand
       instead of stack-then-time-bank (two full trigger passes plus the FK
       re-checks a second write of the same row costs). The door proves the
       resulting state before it counts it and still writes any seat this core
       did not carry. Any other caller leaves the setting unset and gets the
       unchanged stack-only write. Nothing here reaches the request hash,
       the receipt or the returned result. */
    v_tb_map := NULL;
    v_tb_env_text := current_setting('app.ca_hand_time_banks', true);
    IF v_tb_env_text IS NOT NULL AND v_tb_env_text <> ''
       AND pg_input_is_valid(v_tb_env_text, 'jsonb') THEN
      v_tb_env := v_tb_env_text::jsonb;
      IF jsonb_typeof(v_tb_env) = 'object'
         AND v_tb_env->>'table_id' = p_table_id::text
         AND v_tb_env->>'hand_number' = p_hand_number::text
         AND (v_tb_env->>'exact')::boolean IS NOT DISTINCT FROM v_exact_seat_generation
         AND jsonb_typeof(v_tb_env->'items') = 'array' THEN
        -- Every item well formed and one item per player, or no fold at all.
        SELECT CASE WHEN count(*) > 0
                     AND count(*) = count(*) FILTER (WHERE x.ok)
                     AND count(*) = count(DISTINCT x.uid)
                    THEN jsonb_object_agg(x.uid, x.item) END
          INTO v_tb_map
          FROM (
            SELECT i.value AS item,
                   COALESCE(lower(i.value->>'user_id'), '') AS uid,
                   jsonb_typeof(i.value) = 'object'
                   AND (i.value->>'user_id') ~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   AND CASE WHEN (i.value->>'uses_remaining') ~ '^[0-9]+$'
                            THEN (i.value->>'uses_remaining')::numeric <= 2147483647
                            ELSE false END
                   AND CASE WHEN (i.value->>'seconds_remaining') ~ '^[0-9]+$'
                            THEN (i.value->>'seconds_remaining')::numeric <= 2147483647
                            ELSE false END
                   AND (NOT v_exact_seat_generation OR (
                     (i.value->>'seat_id') ~*
                       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     AND pg_input_is_valid(i.value->>'seat_joined_at',
                                           'timestamp with time zone'))) AS ok
              FROM jsonb_array_elements(v_tb_env->'items') i
          ) x;
      END IF;
    END IF;

    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      IF NOT (v_targets ? v_uid::text) THEN
        CONTINUE;  -- a departed seat: settled against the wallet below
      END IF;
      v_target := (v_targets->>(v_uid::text))::numeric;
      -- The time-bank item for this seat, only when it names this exact
      -- seat generation. Otherwise the write is stack-only, as before.
      v_tb := CASE WHEN v_tb_map IS NOT NULL THEN v_tb_map->(v_uid::text) END;
      IF v_tb IS NOT NULL AND v_exact_seat_generation
         AND ((v_tb->>'seat_id')::uuid IS DISTINCT FROM (e->>'seat_id')::uuid
              OR (v_tb->>'seat_joined_at')::timestamptz
                   IS DISTINCT FROM (e->>'seat_joined_at')::timestamptz) THEN
        v_tb := NULL;
      END IF;
      IF v_exact_seat_generation THEN
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        END IF;
      ELSE
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        END IF;
      END IF;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        /* aaa_skip_noop_update returns NULL for a row that would not change,
           and ROW_COUNT then reads 0. The seat was locked and found above, so
           a zero-row update whose seat already holds the target is the trigger
           doing its job, not a failed write. Before 2026-09-04 this rejected
           8,645 hands an hour - every hand in which one player's stack did not
           move - and each of those was persisted by the engine's unchecked
           per-seat fallback instead. */
        IF NOT EXISTS (
          SELECT 1
            FROM public.table_seats ts
           WHERE ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
             AND ts.user_id = v_uid
             AND ts.stack = v_target
             AND (
               (v_exact_seat_generation
                 AND ts.id = (e->>'seat_id')::uuid
                 AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
                 AND ts.left_at IS NULL)
               OR (NOT v_exact_seat_generation AND ts.left_at IS NULL)
             )
        ) THEN
          RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
        END IF;
      END IF;
    END LOOP;

    -- A successful tournament hand has one durable stack source. Mirror the
    -- exact resulting/rebased live seat targets into the matching playing
    -- tournament_players rows while both sets are still locked. Any missing,
    -- duplicate or divergent row rejects the whole hand subtransaction.
    IF v_tournament_id IS NOT NULL THEN
      UPDATE public.tournament_players tp
         SET chips = target.stack
        FROM (
          SELECT x.key::uuid AS user_id,x.value::numeric AS stack
            FROM jsonb_each_text(v_targets) AS x(key,value)
        ) target
       WHERE tp.tournament_id = v_tournament_id
         AND tp.user_id = target.user_id
         AND tp.status::text = 'playing';

      SELECT count(*),
             COALESCE(array_agg(tp.user_id ORDER BY tp.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'user_id',tp.user_id,'chips',tp.chips)
               ORDER BY tp.user_id),'[]'::jsonb)
        INTO v_tournament_player_count,v_tournament_player_user_ids,
             v_tournament_player_chips
        FROM public.tournament_players tp
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = tp.user_id
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing';
      IF v_tournament_player_count <>
           (SELECT count(*) FROM jsonb_each(v_targets))
         OR EXISTS (
           SELECT 1
             FROM jsonb_each_text(v_targets) target
            WHERE NOT EXISTS (
              SELECT 1
                FROM public.tournament_players tp
                JOIN public.table_seats ts
                  ON ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
               WHERE tp.tournament_id = v_tournament_id
                 AND tp.status::text = 'playing'
                 AND tp.user_id = target.key::uuid
                 AND tp.chips IS NOT DISTINCT FROM target.value::numeric
                 AND ts.stack IS NOT DISTINCT FROM target.value::numeric)) THEN
        RAISE EXCEPTION
          'tournament % hand % did not durably sync every final seat stack',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      -- A named zero-stack tournament seat is finished on the felt at this
      -- same durable hand boundary. Keep tournament_players playing with
      -- chips=0 so the rebuy/elimination state machine can decide its life,
      -- but release the physical seat now. This replaces the former
      -- PostgREST vacate followed by a compensating chips-zero write.
      SELECT count(*),
             COALESCE(array_agg(ts.id ORDER BY ts.id),ARRAY[]::uuid[]),
             COALESCE(array_agg(ts.user_id ORDER BY ts.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'seat_id',ts.id,
               'user_id',ts.user_id,
               'seat_number',ts.seat_number,
               'joined_at',ts.joined_at)
               ORDER BY ts.id),'[]'::jsonb)
        INTO v_zero_stack_seat_count,v_zero_stack_seat_ids,
             v_zero_stack_user_ids,v_zero_stack_seat_generations
        FROM public.table_seats ts
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = ts.user_id
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
         AND ts.stack = 0
         AND ts.user_id IS NOT NULL
         AND ts.joined_at IS NOT NULL
         AND target.value::numeric = 0;
      IF v_zero_stack_seat_count <>
           (SELECT count(*) FROM jsonb_each_text(v_targets) target
             WHERE target.value::numeric = 0) THEN
        RAISE EXCEPTION
          'tournament % hand % cannot identify every named zero-stack seat',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      IF v_zero_stack_seat_count > 0 THEN
        v_zero_stack_vacated_at := clock_timestamp();
        UPDATE public.table_seats ts
           SET left_at = v_zero_stack_vacated_at,
               status = 'left',
               leave_pending = false,
               is_sitting_out = false,
               is_away = false,
               sit_out_at = NULL,
               scheduled_leave_hands = NULL
         WHERE ts.id = ANY(v_zero_stack_seat_ids)
           AND ts.table_id = p_table_id
           AND ts.left_at IS NULL
           AND ts.stack = 0;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_zero_stack_seat_count
           OR EXISTS (
             SELECT 1
               FROM unnest(v_zero_stack_seat_ids) expected(id)
              WHERE NOT EXISTS (
                SELECT 1 FROM public.table_seats ts
                 WHERE ts.id = expected.id
                   AND ts.table_id = p_table_id
                   AND ts.stack = 0
                   AND ts.left_at = v_zero_stack_vacated_at
                   AND ts.status = 'left'
                   AND COALESCE(ts.leave_pending,false) IS FALSE
                   AND COALESCE(ts.is_sitting_out,false) IS FALSE
                   AND COALESCE(ts.is_away,false) IS FALSE
                   AND ts.sit_out_at IS NULL
                   AND ts.scheduled_leave_hands IS NULL))
           OR EXISTS (
             SELECT 1
               FROM public.table_seats ts
               JOIN jsonb_each_text(v_targets) target
                 ON target.key::uuid = ts.user_id
              WHERE ts.table_id = p_table_id
                AND ts.left_at IS NULL
                AND target.value::numeric = 0) THEN
          RAISE EXCEPTION
            'tournament % hand % did not atomically vacate every zero-stack seat',
            v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
        END IF;
      END IF;

      SELECT count(*) INTO v_table_live_seat_count
        FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.left_at IS NULL;
      UPDATE public.tables tb
         SET current_players = v_table_live_seat_count,
             updated_at = now()
       WHERE tb.id = p_table_id
         AND tb.current_players IS DISTINCT FROM v_table_live_seat_count;
      IF NOT EXISTS (
        SELECT 1 FROM public.tables tb
         WHERE tb.id = p_table_id
           AND tb.tournament_id = v_tournament_id
           AND tb.current_players = v_table_live_seat_count) THEN
        RAISE EXCEPTION
          'tournament % hand % did not persist its exact live-seat count',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
    END IF;

    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.
       The exit credited the seat's pre-hand stack to the club wallet, so a
       negative delta is chips the wallet holds that the pot (and now the
       winner's seat) also holds: debit the wallet, counterparty the felt.
       A positive delta is a pot they won after leaving: credit it. Keyed on
       hand + user in wallet_credit_idempotency, so a retry of this hand
       settles nothing twice. A wallet that cannot cover the debit refuses
       the whole hand, with the numbers, rather than going negative. */
    FOR v_dep IN SELECT (d->>'user_id')::uuid AS user_id, (d->>'delta')::numeric AS delta, (d->>'club_id')::uuid AS club_id
                   FROM jsonb_array_elements(v_departed) d LOOP
      IF v_dep.delta = 0 THEN CONTINUE; END IF;
      v_dep_key := 'late_seat_settle:' || v_hand::text || ':' || v_dep.user_id::text;
      INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
      VALUES (v_dep_key, v_dep.user_id, v_dep.delta)
      ON CONFLICT (key) DO NOTHING;
      GET DIAGNOSTICS v_dep_claimed = ROW_COUNT;
      IF v_dep_claimed = 0 THEN CONTINUE; END IF;  -- already settled by an earlier attempt
      PERFORM public.fn_ca_declare_ledger('settlement', 'table_stack', p_table_id, v_ca_id, v_dep_key, NULL);
      UPDATE public.club_members m
         SET chip_balance = COALESCE(m.chip_balance, 0) + v_dep.delta, updated_at = now()
       WHERE m.user_id = v_dep.user_id AND m.club_id = v_dep.club_id
         AND COALESCE(m.chip_balance, 0) + v_dep.delta >= 0
       RETURNING m.chip_balance INTO v_dep_after;
      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      IF v_dep_after IS NULL THEN
        RAISE EXCEPTION 'seat missing or left for % and its club wallet cannot cover its delta of % - hand write rejected whole', v_dep.user_id, v_dep.delta;
      END IF;
      INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
      VALUES (v_dep.club_id, v_dep.user_id, abs(v_dep.delta),
              CASE WHEN v_dep.delta < 0 THEN 'late_seat_debit' ELSE 'late_seat_credit' END,
              CASE WHEN v_dep.delta < 0
                   THEN format('Hand #%s settled after you left the table: %s chips you had bet are taken from the club wallet the seat cashed out to', p_hand_number, abs(v_dep.delta))
                   ELSE format('Hand #%s settled after you left the table: %s chips you won are credited to your club wallet', p_hand_number, v_dep.delta) END,
              p_table_id, v_dep_after, jsonb_build_object('hand_id', v_hand, 'key', v_dep_key, 'delta', v_dep.delta));
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';

    IF v_rebase_count > 0 THEN
      INSERT INTO public.ca_seat_stack_rebases
        (settlement_id, table_id, hand_id, hand_number, user_id, engine_before, db_before, engine_after, written)
      SELECT v_ca_id, p_table_id, v_hand, p_hand_number,
             (r->>'user_id')::uuid, (r->>'engine_before')::numeric, (r->>'db_before')::numeric,
             (r->>'engine_after')::numeric, (r->>'written')::numeric
        FROM jsonb_array_elements(v_rebase_rows) r;
    END IF;
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
      'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
      'rebased', v_rebased, 'written', v_targets, 'departed', v_departed,
      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL,
      'tournament_id', v_tournament_id,
      'tournament_players_synced', v_tournament_id IS NOT NULL,
      'tournament_player_count', v_tournament_player_count,
      'tournament_player_user_ids', to_jsonb(v_tournament_player_user_ids),
      'tournament_player_chips', v_tournament_player_chips,
      'tournament_zero_stack_seats_vacated', v_tournament_id IS NOT NULL,
      'tournament_zero_stack_seat_count', v_zero_stack_seat_count,
      'tournament_zero_stack_seat_ids', to_jsonb(v_zero_stack_seat_ids),
      'tournament_zero_stack_user_ids', to_jsonb(v_zero_stack_user_ids),
      'tournament_zero_stack_seat_generations', v_zero_stack_seat_generations,
      'tournament_zero_stack_vacated_at', v_zero_stack_vacated_at,
      'tournament_table_live_seat_count', v_table_live_seat_count,
      'request', v_request);

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    UPDATE smarter_private.retired_cash_hand_custody SET state='consumed',settlement_id=v_ca_id
     WHERE table_id=p_table_id AND hand_number=p_hand_number AND state='held' AND transaction_id=txid_current();
    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000) WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' OR v_err LIKE 'negative stack%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number, 'ref', p_ref,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);
  END;
END $function$
;


CREATE OR REPLACE FUNCTION smarter_private.accepted_hand_roster_first(p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_stacks jsonb, p_exact boolean, p_lightning_seats jsonb, p_payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_captured timestamptz := transaction_timestamp();
  v_built jsonb;
  v_status text;
  v_reasons text[];
  v_roster jsonb;
  v_state text;
BEGIN
  v_built := smarter_private.accepted_hand_roster_build(p_table_id, p_hand_number, p_hand_id,
    p_stacks, p_exact, p_lightning_seats, v_captured);
  v_status := v_built->>'status';
  v_roster := NULLIF(v_built->'roster', 'null'::jsonb);
  SELECT COALESCE(array_agg(r ORDER BY o), '{}') INTO v_reasons
    FROM jsonb_array_elements_text(v_built->'reasons') WITH ORDINALITY AS t(r, o);
  BEGIN
    INSERT INTO smarter_private.accepted_hand_rosters
      (table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons,
       roster, producer_version, captured_txid, captured_at)
    VALUES
      (p_table_id, p_hand_number, p_hand_id, p_payload_hash, v_status, v_reasons,
       v_roster, 'accepted_hand_roster_v1', txid_current(), v_captured);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_status := 'unavailable';
    v_reasons := ARRAY['roster_record_error:' || v_state];
    v_roster := NULL;
    BEGIN
      INSERT INTO smarter_private.accepted_hand_rosters
        (table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons,
         roster, producer_version, captured_txid, captured_at)
      VALUES
        (p_table_id, p_hand_number, p_hand_id, p_payload_hash, v_status, v_reasons,
         NULL, 'accepted_hand_roster_v1', txid_current(), v_captured);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN jsonb_build_object(
    'version', 1,
    'status', v_status,
    'reasons', to_jsonb(v_reasons),
    'payloadDigest', p_payload_hash,
    'producerVersion', 'accepted_hand_roster_v1',
    'roster', v_roster);
END
$function$
;

CREATE OR REPLACE FUNCTION smarter_private.accepted_hand_roster_replay(p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r smarter_private.accepted_hand_rosters;
BEGIN
  SELECT * INTO r FROM smarter_private.accepted_hand_rosters
   WHERE table_id = p_table_id AND hand_number = p_hand_number;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version', 1, 'status', 'legacy_missing',
      'reasons', jsonb_build_array('accepted_roster_not_recorded'),
      'payloadDigest', p_payload_hash,
      'producerVersion', 'accepted_hand_roster_v1', 'roster', NULL);
  END IF;
  IF r.hand_id IS DISTINCT FROM p_hand_id
     OR r.post_commit_payload_hash IS DISTINCT FROM p_payload_hash THEN
    RETURN jsonb_build_object('version', 1, 'status', 'unavailable',
      'reasons', jsonb_build_array('roster_discriminator_mismatch'),
      'payloadDigest', p_payload_hash,
      'producerVersion', 'accepted_hand_roster_v1', 'roster', NULL);
  END IF;
  RETURN jsonb_build_object('version', 1, 'status', r.status,
    'reasons', to_jsonb(r.reasons), 'payloadDigest', r.post_commit_payload_hash,
    'producerVersion', r.producer_version, 'roster', r.roster);
END
$function$
;

CREATE OR REPLACE FUNCTION smarter_private.acknowledge_hand_submission(p_submission_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s smarter_private.hand_submissions; completed integer;
BEGIN
 SELECT * INTO STRICT s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF p_result->>'success' IS DISTINCT FROM 'true' OR p_result->>'atomic_hand_commit' IS DISTINCT FROM 'true'
 OR p_result->>'history_id' IS DISTINCT FROM s.submission_id::text
 OR p_result->>'post_commit_obligations' IS DISTINCT FROM 'true'
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number
   AND a.hand_id=s.submission_id AND a.payload_hash=p_result->>'commit_hash'
   AND a.post_commit_request_hash=encode(extensions.digest(convert_to((s.request->'p_post_commit_obligations')::text,'UTF8'),'sha256'),'hex')
   AND a.post_commit_payload IS NOT NULL AND a.post_commit_payload_hash=p_result->>'post_commit_payload_hash') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
 -- 20261006081157: serialised per table with save_hand_state_snapshot.
 PERFORM pg_advisory_xact_lock(hashtextextended('hand-snapshot:' || s.table_id::text, 0));
 UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND NOT is_complete;
 GET DIAGNOSTICS completed=ROW_COUNT;
 RETURN p_result||jsonb_build_object('submission_id',s.submission_id,'submission_hash',s.request_hash,
 'snapshot_completed',true,'snapshots_completed',completed);
END $function$
;

CREATE OR REPLACE FUNCTION smarter_private.adopt_retired_cash_original_hand(p_submission uuid, p_instance text, p_generation uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE c smarter_private.retired_cash_hand_qualification;s smarter_private.hand_submissions;
 lease public.engine_table_leases;item jsonb;stack_item jsonb;fr jsonb;move jsonb;m public.cash_hand_participant_manifests;
 funding public.cash_participant_funding_receipts;seat public.table_seats;inventory public.union_pnl_inventory_events;
 restore_key_text text;result jsonb;uid uuid;club uuid;before_amount numeric;ledger uuid;
BEGIN
 SELECT * INTO c FROM smarter_private.retired_cash_hand_qualification WHERE submission_id=p_submission;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission FOR UPDATE;
 SELECT * INTO lease FROM public.engine_table_leases WHERE table_id=c.table_id FOR KEY SHARE;
 IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM c.request_hash
 OR (s.table_id,s.hand_number) IS DISTINCT FROM(c.table_id,c.hand_number)
 OR s.lease_generation=p_generation OR lease.instance_id IS DISTINCT FROM p_instance
 OR lease.lease_generation IS DISTINCT FROM p_generation OR lease.protocol_version IS DISTINCT FROM 2
 OR lease.heartbeat_at IS NULL OR lease.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
 OR public.fn_platform_frozen() OR auth.role() IS DISTINCT FROM 'service_role'
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=c.table_id AND t.tournament_id IS NULL
   AND NOT coalesce(t.is_deleted,false) AND lower(t.status) IN('waiting','running') AND t.lifecycle IN('live','breaking'))
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=p_submission)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals h WHERE h.table_id=c.table_id AND h.hand_number=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=c.table_id AND a.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=c.table_id AND h.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody r WHERE r.submission_id=p_submission) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_AUTHORITY_OR_CONSUMPTION_CHANGED' USING ERRCODE='55000'; END IF;
 -- All unaffected players still own the immutable before-stack. Lock in the
 -- native order before the first restitution; a replacement row is read only.
 FOR stack_item IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') ORDER BY value->>'seat_id' LOOP
  SELECT * INTO seat FROM public.table_seats WHERE id=(stack_item->>'seat_id')::uuid FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.expected->'participants')p WHERE p->'stack'=stack_item)
   AND (seat.id IS NULL OR seat.table_id IS DISTINCT FROM c.table_id OR seat.user_id IS DISTINCT FROM(stack_item->>'user_id')::uuid
    OR seat.joined_at IS DISTINCT FROM(stack_item->>'seat_joined_at')::timestamptz OR seat.left_at IS NOT NULL
    OR seat.stack IS DISTINCT FROM(stack_item->>'stack_before')::numeric) THEN
   RAISE EXCEPTION 'RETIRED_CASH_UNQUALIFIED_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'participants') ORDER BY value#>>'{stack,user_id}' LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;club:=(item->>'funding_club_id')::uuid;
  before_amount:=(item#>>'{stack,stack_before}')::numeric;
  restore_key_text:='retired_cash_base:'||p_submission::text||':'||(item#>>'{stack,occupancy_id}');
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=(item#>>'{stack,funding_manifest_id}')::uuid;
  SELECT * INTO inventory FROM public.union_pnl_inventory_events WHERE event_id=(item->>'inventory_event_id')::bigint;
  SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{stack,seat_id}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request#>'{p_post_commit_obligations,time_banks}')x WHERE x=item->'time_bank')
  OR m.id IS NULL OR (m.table_id,m.hand_number) IS DISTINCT FROM(c.table_id,c.hand_number)
  OR NOT m.funding_provenance_complete OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants)x WHERE x=item->'manifest_participant')
  OR inventory.event_id IS NULL OR inventory.source_name IS DISTINCT FROM 'table_seats'
  OR inventory.row_id::text IS DISTINCT FROM item#>>'{stack,seat_id}'
  OR inventory.operation NOT IN('DELETE','UPDATE')
  OR NOT (inventory.before_row @> (item->'inventory_before'))
  OR (inventory.before_row->>'left_at')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
  OR (inventory.before_row->>'stack')::numeric IS DISTINCT FROM before_amount
  OR (seat.id IS NOT NULL AND seat.occupancy_id=(item#>>'{stack,occupancy_id}')::uuid)
  OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r WHERE r.old_id=uid AND r.retired_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.seat_cashout_receipts r WHERE r.occupancy_id=(item#>>'{stack,occupancy_id}')::uuid)
  OR EXISTS(SELECT 1 FROM public.table_cashout_history r WHERE r.user_id=uid AND r.table_id=c.table_id
    AND r.cashed_out_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.to_type='player_wallet' AND l.to_entity_id=uid
    AND (l.from_entity_id=c.table_id OR l.table_id=c.table_id) AND l.created_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.user_id=uid AND w.table_id=c.table_id
    AND w.type='credit' AND w.created_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=restore_key_text)
  OR EXISTS(SELECT 1 FROM public.ca_mint_ledger w WHERE w.op_id=restore_key_text)
  OR NOT EXISTS(SELECT 1 FROM public.club_members w WHERE w.user_id=uid AND w.club_id=club
    AND w.is_active AND w.status='approved' AND w.departed_at IS NULL) THEN
   RAISE EXCEPTION 'RETIRED_CASH_IMMUTABLE_CUSTODY_OR_RETURN_CHANGED' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM public.club_members WHERE user_id=uid AND club_id=club FOR UPDATE;
  IF jsonb_array_length(item#>'{manifest_participant,funding_receipts}')=0 THEN
   RAISE EXCEPTION 'RETIRED_CASH_FUNDING_EMPTY' USING ERRCODE='55000'; END IF;
  FOR fr IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_receipts}') LOOP
   SELECT * INTO funding FROM public.cash_participant_funding_receipts WHERE id=(fr->>'id')::uuid;
   IF funding.id IS NULL OR funding.user_id IS DISTINCT FROM uid OR funding.account_type IS DISTINCT FROM 'player_wallet'
   OR funding.account_entity_id IS DISTINCT FROM uid OR funding.funding_club_id IS DISTINCT FROM club
   OR funding.amount<=0 OR funding.asset IS DISTINCT FROM 'chips'
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=funding.source_ledger_id
    AND l.from_type='player_wallet' AND l.from_entity_id=uid AND l.club_id=club AND l.amount=funding.amount)
   OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=funding.wallet_transaction_id
    AND w.user_id=uid AND w.amount=funding.amount AND w.type='debit') THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_FUNDING_CHANGED' USING ERRCODE='55000'; END IF;
  END LOOP;
  FOR move IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_lineage,moves}') LOOP
   IF NOT EXISTS(SELECT 1 FROM public.cash_seat_move_receipts r WHERE r.move_id=(move->>'move_id')::uuid
    AND to_jsonb(r) @> move AND r.player_id=uid AND r.club_id=club) THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_MOVE_LINEAGE_CHANGED' USING ERRCODE='55000'; END IF;
  END LOOP;
 END LOOP;
 -- No arbitrary amount, member club, or wallet can enter this path.
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'participants') ORDER BY value#>>'{stack,user_id}' LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;club:=(item->>'funding_club_id')::uuid;
  before_amount:=(item#>>'{stack,stack_before}')::numeric;
  restore_key_text:='retired_cash_base:'||p_submission::text||':'||(item#>>'{stack,occupancy_id}');
  result:=public.fn_ca_restore_erased_seat_credit(restore_key_text,uid,club,before_amount,c.table_id,
   'Current restitution of immutable cash custody erased during patterned-account retirement; original hand '||p_submission::text);
  ledger:=(result->>'chip_ledger_id')::uuid;
  IF result->>'restored' IS DISTINCT FROM 'true' OR result->>'key' IS DISTINCT FROM restore_key_text
   OR (result->>'user_id')::uuid IS DISTINCT FROM uid OR (result->>'club_id')::uuid IS DISTINCT FROM club
   OR (result->>'amount')::numeric IS DISTINCT FROM before_amount
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=ledger AND l.idempotency_key=restore_key_text
    AND l.category='refund' AND l.from_type='issuance_reserve' AND l.to_type='player_wallet'
    AND l.to_entity_id=uid AND l.club_id=club AND l.amount=before_amount)
   OR NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger l WHERE l.op_id=restore_key_text AND l.action='mint'
    AND l.asset='chips' AND l.holder_type='player' AND l.holder_id=uid AND l.amount=before_amount AND l.chip_ledger_id=ledger) THEN
   RAISE EXCEPTION 'RETIRED_CASH_RESTITUTION_INCOHERENT' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.retired_cash_hand_custody
   (submission_id,user_id,table_id,hand_number,seat_id,occupancy_id,seat_joined_at,stack_before,stack_after,
    funding_club_id,original_left_at,original_inventory_event,request_hash,transaction_id,restore_key,issuance_ledger,original_time_bank,state)
  VALUES(p_submission,uid,c.table_id,c.hand_number,(item#>>'{stack,seat_id}')::uuid,(item#>>'{stack,occupancy_id}')::uuid,
   (item#>>'{stack,seat_joined_at}')::timestamptz,before_amount,(item#>>'{stack,stack}')::numeric,club,
   (item#>>'{inventory_before,left_at}')::timestamptz,(item->>'inventory_event_id')::bigint,c.request_hash,txid_current(),restore_key_text,ledger,item->'time_bank','held');
 END LOOP;
 -- The original native settlement supplies its own ledger declaration.
 PERFORM set_config('app.ledger_category','',true);
 PERFORM set_config('app.ledger_counterparty','',true);
 PERFORM set_config('app.ledger_counterparty_entity','',true);
 PERFORM set_config('app.ledger_counterparty_label','',true);
 PERFORM set_config('app.ledger_settlement','',true);
 PERFORM set_config('app.ledger_idempotency_key','',true);
 RETURN true;
END $function$
;

CREATE OR REPLACE FUNCTION smarter_private.f06_prefix(t uuid, g uuid, users uuid[], ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE u uuid;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM smarter_private.f06_authority(t,g,false);
 FOR u IN SELECT DISTINCT x FROM unnest(users) x ORDER BY x LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)); END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t AND user_id=ANY(users) ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
 WHERE tb.tournament_id=t AND (s.user_id=ANY(users) OR s.table_id=ANY(ids)) ORDER BY s.id FOR UPDATE OF s;
END $function$
;

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

    PERFORM public.fn_cash_accept_hand_provenance(p_table_id,p_hand_number,v_hand_id,
      v_normalized_stacks,p_rake,p_bbj,p_inflow,v_commit_hash,
      jsonb_build_object(
        'table_id',p_table_id,'hand_number',p_hand_number,
        'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
        'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
        'units',v_normalized_units));

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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 30;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_f06_finish_hand(p_tournament_id uuid, p_lease_generation uuid, p_permit_id uuid, p_outcome text, p_evidence_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_UNKNOWN_PERMIT' USING ERRCODE='22023'; END IF;
 /* A TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03). An
    accepted finish only records the committed hand of this table: the
    shared table lane. Every other outcome asserts that nothing started,
    which only the exclusive lane can prove, so it keeps f06_prefix. */
 IF p_outcome='accepted' THEN
 PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,h.table_id);
 ELSE
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[h.table_id]);
 END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF h.state<>'reserved' THEN
 IF h.state IS DISTINCT FROM p_outcome OR h.evidence_id IS DISTINCT FROM p_evidence_id THEN RAISE EXCEPTION 'F06_CHANGED_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 ELSE
 IF p_outcome='accepted' THEN
 IF NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number AND c.hand_id=p_evidence_id AND c.post_commit_completed_at IS NOT NULL) THEN
 RAISE EXCEPTION 'F06_HAND_EVIDENCE_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSIF p_outcome='never_started' THEN
 -- Lease must have drained the exact original custody under its held both-map
 -- reservation before claiming this park's new custody receipt. A successor
 -- generation is not evidence that the original dealer never started.
 IF h.generation IS DISTINCT FROM p_lease_generation OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
 WHERE o.source_table_id=h.table_id AND o.lifecycle=h.lifecycle AND o.state='park_requested' AND o.custody_id=p_evidence_id
 AND o.custody_generation=p_lease_generation AND o.revision>0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id) THEN
 RAISE EXCEPTION 'F06_EXACT_QUIESCENT_CUSTODY_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSE RAISE EXCEPTION 'F06_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.f06_hand_permits SET state=p_outcome,evidence_id=p_evidence_id WHERE permit_id=p_permit_id RETURNING * INTO h;
 END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$
;

CREATE OR REPLACE FUNCTION smarter_private.horse_settlement_original_result(p_table uuid, p_stack_hand uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE cert smarter_private.horse_settlement_key_certificates; original jsonb;
BEGIN
 SELECT * INTO cert FROM smarter_private.horse_settlement_key_certificates
 WHERE table_id=p_table AND stack_hand_id=p_stack_hand;
 IF NOT FOUND THEN RETURN p_result; END IF;
 SELECT p.atomic_receipt->'stack_result' INTO original FROM public.cash_hand_provenance_receipts p
 WHERE p.table_id=cert.table_id AND p.hand_number=cert.hand_number AND p.hand_id=cert.history_hand_id
 AND p.manifest_id=cert.manifest_id;
 IF p_result IS DISTINCT FROM cert.compact_result OR original IS NULL
 OR encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_result_sha256
 OR encode(extensions.digest(convert_to((original->'request')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_request_sha256
 OR original-'request' IS DISTINCT FROM cert.compact_result THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACT_ORIGINAL_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN original;
END $function$
;

CREATE OR REPLACE FUNCTION smarter_private.restore_retired_original_tournament_hand(p_submission_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE c smarter_private.retirement_original_hand_qualification;
 s smarter_private.hand_submissions; permit smarter_private.f06_hand_permits;
 item jsonb; stack_item jsonb; roster public.tournament_players; seat public.table_seats;
 projected jsonb; lease public.engine_tournament_leases; n integer:=0;
BEGIN
 SELECT * INTO c FROM smarter_private.retirement_original_hand_qualification
 WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_ENGINE_SUCCESSOR_REQUIRED' USING ERRCODE='42501';
 END IF;
 -- The caller acquires the existing rolling authority before its F06 prefix.
 -- Re-entry here cannot grant an unproven original generation a financial door.
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(c.tournament_id,c.table_id);
 SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=c.tournament_id FOR KEY SHARE;
 IF lease.instance_id IS DISTINCT FROM p_instance_id OR lease.lease_generation IS DISTINCT FROM p_lease_generation
 OR lease.protocol_version IS DISTINCT FROM 2 OR lease.heartbeat_at IS NULL
 OR lease.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
 OR public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_LEASE_UNPROVEN' USING ERRCODE='55000';
 END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE submission_id=c.submission_id FOR UPDATE;
 IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM c.request_hash
 OR (s.table_id,s.hand_number) IS DISTINCT FROM (c.table_id,c.hand_number)
 OR s.lease_generation=p_lease_generation THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_REQUEST_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT * INTO permit FROM smarter_private.f06_hand_permits
 WHERE table_id=c.table_id AND hand_number=c.hand_number FOR UPDATE;
 IF permit.permit_id IS NULL OR permit.state IS DISTINCT FROM 'reserved'
 OR permit.tournament_id IS DISTINCT FROM c.tournament_id OR permit.generation IS DISTINCT FROM s.lease_generation
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=c.table_id AND t.tournament_id=c.tournament_id
   AND NOT coalesce(t.is_deleted,false) AND lower(t.status) IN('waiting','running') AND t.lifecycle IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=c.tournament_id AND t.status='RUNNING')
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=c.table_id AND a.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=c.table_id AND h.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=c.table_id AND p.hand_number>c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=c.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations r WHERE r.submission_id=c.submission_id) THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_ALREADY_CONSUMED_OR_SCOPE_CHANGED' USING ERRCODE='55000';
 END IF;
 -- Every dealt player's before-stack and exact seat must still be held.
 -- The 101 unaffected players require ordinary live/playing ownership.
 FOR stack_item IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') LOOP
  SELECT * INTO roster FROM public.tournament_players
   WHERE tournament_id=c.tournament_id AND user_id=(stack_item->>'user_id')::uuid FOR UPDATE;
  SELECT * INTO seat FROM public.table_seats WHERE id=(stack_item->>'seat_id')::uuid FOR UPDATE;
  IF roster.id IS NULL OR roster.chips::numeric IS DISTINCT FROM (stack_item->>'stack_before')::numeric
  OR seat.id IS NULL OR seat.table_id IS DISTINCT FROM c.table_id
  OR seat.user_id IS DISTINCT FROM (stack_item->>'user_id')::uuid
  OR seat.joined_at IS DISTINCT FROM (stack_item->>'seat_joined_at')::timestamptz
  OR seat.stack IS DISTINCT FROM (stack_item->>'stack_before')::numeric THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_DEALT_CUSTODY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.expected->'rows')x WHERE x->>'user_id'=stack_item->>'user_id')
   AND (roster.status IS DISTINCT FROM 'playing' OR seat.left_at IS NOT NULL) THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_UNQUALIFIED_PLAYER_CHANGED' USING ERRCODE='55000';
  END IF;
 END LOOP;
 -- Validate ALL qualified post-images before changing the first row.
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'rows') ORDER BY value->>'user_id' LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_PAYLOAD_PLAYER_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT * INTO roster FROM public.tournament_players WHERE id=(item#>>'{roster,id}')::uuid FOR UPDATE;
  SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{seat,id}')::uuid FOR UPDATE;
  SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(roster))
   WHERE key=ANY(ARRAY['id','user_id','tournament_id','status','chips','position','prize','table_id','seat_number','rebuys','add_on','eliminated_at','current_bounty','bounty_winnings','bounties_collected','rebuy_prompt_until','elimination_sequence']);
  IF projected IS DISTINCT FROM item->'roster' THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_ROSTER_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(seat))
   WHERE key=ANY(ARRAY['id','table_id','user_id','club_id','seat_number','joined_at','occupancy_id','stack','left_at','status','is_sitting_out','is_away','leave_pending','active_game_scope','active_parent_key']);
  IF projected IS DISTINCT FROM item->'seat'
  OR roster.status IS DISTINCT FROM 'eliminated' OR roster.chips<=0
  OR roster.position IS NOT NULL OR coalesce(roster.prize,0)<>0
  OR roster.eliminated_at NOT BETWEEN '2026-10-06 15:33:04Z'::timestamptz AND '2026-10-06 15:33:08Z'::timestamptz
  OR seat.left_at NOT BETWEEN '2026-10-06 15:33:04Z'::timestamptz AND '2026-10-06 15:33:08Z'::timestamptz
  OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r JOIN public.profiles p ON p.id=r.old_id
    WHERE r.old_id=roster.user_id AND r.cohort='horse' AND r.retired_at IS NOT NULL
      AND r.replacement_horse_id IS NULL AND p.status='deleted' AND p.horse_status='disabled')
  OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f
    WHERE f.tournament_id=c.tournament_id AND f.user_id=roster.user_id
      AND f.observed_at>=(s.request#>>'{p_hand_row,started_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=c.tournament_id AND p.user_id=roster.user_id)
  OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m
    WHERE m.tournament_id=c.tournament_id AND m.user_id=roster.user_id AND m.moved_at>=roster.eliminated_at) THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_POSTIMAGE_OR_OWNERSHIP_CHANGED' USING ERRCODE='55000';
  END IF;
 END LOOP;
 INSERT INTO smarter_private.retirement_original_hand_restorations
 (submission_id,original_generation,successor_generation,instance_id,request_hash,qualification_hash,transaction_id,restored_players)
 VALUES(c.submission_id,s.lease_generation,p_lease_generation,p_instance_id,c.request_hash,md5(c.expected::text),txid_current(),jsonb_array_length(c.expected->'rows'));
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'rows') ORDER BY value->>'user_id' LOOP
  UPDATE public.tournament_players SET status='playing',eliminated_at=NULL
   WHERE id=(item#>>'{roster,id}')::uuid;
  UPDATE public.table_seats SET left_at=NULL,status='active'
   WHERE id=(item#>>'{seat,id}')::uuid;
  n:=n+1;
 END LOOP;

 RETURN true;
END $function$
;

CREATE OR REPLACE FUNCTION smarter_private.retired_cash_original_stack(p_table uuid, p_hand bigint, p_user uuid, p_seat uuid, p_join timestamp with time zone, p_before numeric, p_after numeric)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT jsonb_build_object('funding_club_id',r.funding_club_id,'left_at',r.original_left_at)
 FROM smarter_private.retired_cash_hand_custody r JOIN smarter_private.hand_submissions s USING(submission_id)
 WHERE r.table_id=p_table AND r.hand_number=p_hand AND r.user_id=p_user AND r.seat_id=p_seat
 AND r.seat_joined_at=p_join AND r.stack_before=p_before AND r.stack_after=p_after
 AND r.state='held' AND r.transaction_id=txid_current() AND r.request_hash=s.request_hash
 -- The native retained-request door consumes its dispatch envelope before
 -- reaching this core. The immutable financial handoff is the durable owner.
 AND EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs d WHERE d.transaction_id=txid_current()
  AND d.submission_id=r.submission_id AND d.request_hash=r.request_hash)
$function$
;

CREATE OR REPLACE FUNCTION smarter_private.retired_cash_original_time_bank(p_table uuid, p_hand bigint, p_item jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n integer;
BEGIN
 UPDATE smarter_private.retired_cash_hand_custody r SET accepted_time_bank=p_item
 WHERE r.table_id=p_table AND r.hand_number=p_hand AND r.state='consumed' AND r.transaction_id=txid_current()
 AND r.original_time_bank=p_item AND r.settlement_id IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $function$
;


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
  -- LIGHTNING PHASE 6 (20261001154813): see fn_ca_settle_hand_stacks_absolute.
  v_lightning_seats jsonb := '{}'::jsonb;
  -- P14.2 (20261007024757): the accepted actor roster this result reports.
  v_accepted_roster jsonb;
  v_roster_state text;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.assert_retained_hand_submission(jsonb_build_object('p_table_id',p_table_id,'p_hand_number',p_hand_number,'p_stacks',p_stacks,'p_rake',p_rake,'p_bbj',p_bbj,'p_ref',p_ref,'p_inflow',p_inflow,'p_hand_row',p_hand_row,'p_units',p_units,'p_instance_id',p_instance_id,'p_lease_generation',p_lease_generation,'p_post_commit_obligations',p_post_commit_obligations));
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
     /* P14.2: the accepted roster is produced by this transaction alone. */
     OR p_post_commit_obligations ? 'accepted_actor_roster'
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
    -- DIAMOND PHASE 9, STEP 0: every game the arena deals, as the settler reads it.
    OR NOT public.fn_poker_diamond_cash_variant(p_hand_row->>'game_variant')
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
  -- LIGHTNING PHASE 6 (20261001154813): the anchors a Lightning settlement in
  -- this transaction names, so the three time-bank statements below find each
  -- at its own table; '{}' for every physical hand.
  v_lightning_seats := public.fn_lightning_settlement_seats(p_table_id, p_hand_number);

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
  IF (NOT v_diamond AND (
       (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
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
     )))
     /* A RAKED DIAMOND CASH HAND IS NOT A CHIP RAKE OBLIGATION (2026-10-06).
        The seven clauses above bind a CHIP rake to the chip post-commit leg
        that pays it out, and they bind it unchanged. A Diamond cash hand has
        no such leg: fn_poker_diamond_settle_cash_hand recomputes its rake
        from the owner's settings and accrues it per payer inside this same
        transaction, and the Diamond refusal above requires its chip rake
        object to be null. Bound to a chip object as well, every raked
        Diamond hand refused here as post_commit_fee_mismatch. Its own rule,
        the null object, is stated again here so this check stays total. */
     OR (v_diamond
         AND jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null')
     OR (NOT v_diamond AND (
       (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
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
     )))
     OR (v_diamond AND jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null') THEN
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
      IF smarter_private.retired_cash_original_time_bank(p_table_id,p_hand_number,v_item) THEN
        v_updated:=v_updated+1;
        CONTINUE;
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
       WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
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
       WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
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
         WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
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

    /* THE ACCEPTED ROSTER (P14.2, 20261007024757). First acceptance only,
       under the locks already held, from the exact seat generations the stack
       core proved and profiles read now. It never changes the envelope, its
       hashes, money or stacks, and it can never fail the hand: any error here
       is reported as 'unavailable' and the hand settles as before. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_first(
        p_table_id, p_hand_number, v_hand_id, p_stacks,
        v_exact_seat_generation, v_lightning_seats, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_producer_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
    /* P14.2: a replay returns the stored roster exactly; today's profiles
       are never consulted again. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_replay(
        p_table_id, p_hand_number, v_hand_id, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_replay_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash,
    'accepted_roster', v_accepted_roster,
    'diamond_jackpot_receipt', CASE WHEN v_diamond THEN (
      SELECT j.receipt FROM public.poker_diamond_jackpot_hits j
      WHERE j.table_id=p_table_id AND j.hand_number=p_hand_number
    ) ELSE NULL END
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false; evidence text;
 mark bigint; lo bigint; hi bigint; window_rows integer; windows integer:=0;
 retirement_restored boolean:=false;
 retired_cash_restored boolean:=false;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 -- THE READ STARTS AT THE TABLE'S SETTLED MARK, A BOUNDED WINDOW AT A TIME
 -- (2026-10-02). This read walked EVERY submission the table ever retained
 -- (23,405 rows on one cash table, a heap fetch each in a 33 GB relation) to
 -- answer "nothing unfinished": 1.8 s warm, past the 8 s statement timeout
 -- cold, 15,085 timeouts in 12 hours, and each one refused the table's start.
 -- A finished submission stays finished (disposals and submissions are
 -- immutable; a completed post-commit is never reopened; a permit is
 -- reserved only for a new, higher hand), and only the current lease
 -- generation can retain, after this start, a higher hand number. So every
 -- hand at or below the mark is settled for ever, and the walk resumes above
 -- it. Windows of 200 hands are read until two seconds of this statement
 -- have passed (a cold hand costs ~2 random reads: 2,500 timed out at 5 s on
 -- 2026-10-02 09:25 and a 500 window started late still passed 8 s at 10:20);
 -- a table with more unread history keeps its progress and answers pending,
 -- which every caller already retries.
 SELECT m.settled_through INTO mark FROM smarter_private.hand_submission_resume_marks m
  WHERE m.table_id=p_table_id;
 lo:=COALESCE(mark,-1);
 LOOP
  SELECT max(w.hand_number),count(*) INTO hi,window_rows FROM (SELECT j.hand_number
    FROM smarter_private.hand_submissions j WHERE j.table_id=p_table_id AND j.hand_number>lo
    ORDER BY j.hand_number LIMIT 200) w;
  s:=NULL;
  EXIT WHEN window_rows=0;
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  EXIT WHEN FOUND;
  lo:=hi; windows:=windows+1;
  EXIT WHEN window_rows<200;
  IF clock_timestamp()-statement_timestamp()>interval '2 seconds' THEN
   INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
    VALUES(p_table_id,lo,clock_timestamp())
   ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text);
  END IF;
 END LOOP;
 IF lo>COALESCE(mark,-1) THEN
  INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
   VALUES(p_table_id,lo,clock_timestamp())
  ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
 END IF;
 IF s.submission_id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_qualification c WHERE c.submission_id=s.submission_id) THEN
   PERFORM public.fn_ca_lock_settlement_lane_for_tournament(tour,p_table_id);
  END IF;
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- A HAND THIS CASH TABLE HAS ALREADY DEALT PAST IS DISPOSED AT ITS DOOR
 -- (2026-09-29). A later committed hand consumed the before-stacks this
 -- request names, so nobody can ever apply it; the receipted, zero-credit
 -- disposal is written here, under this caller's proven lease and the
 -- table's locks, and the next unfinished request is read. A tournament
 -- table's dead hands stay with the F06 abort doors.
 -- A REFUSED HAND WHOSE CHAIRS HAVE ALL CLOSED IS DISPOSED HERE TOO
 -- (2026-10-09): rolled back, never durable, and no chair left to apply it to.
 IF tour IS NULL AND ((EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0)
  OR smarter_private.hand_submission_dispose_refused_vacated(p_table_id,s.submission_id)>0) THEN
  -- The next unfinished request, read above the hands just disposed and
  -- inside the window already proven: everything at or below lo is settled.
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  IF NOT FOUND AND window_rows>=200 THEN
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR h.generation IS DISTINCT FROM s.lease_generation
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent'); END IF;
  -- The original generation owns its own door; it is never its own successor.
  IF s.lease_generation=p_lease_generation THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- A canonical failure row is one proof that the original cannot settle this
  -- hand. The other is read here: the scope lease holds this caller's
  -- generation, not the original's, and this transaction has held that row
  -- FOR KEY SHARE since it was verified, so no takeover or release can move
  -- it until this transaction ends. Every settlement of this hand holds this
  -- hand's submission lock (taken above) from before its own lease check to
  -- its end, and the atomic receipt read under that lock found nothing. So the
  -- original never settled this hand, cannot settle it while its generation is
  -- not the lease, and if it ever holds the lease again it can only replay the
  -- payload-identical receipt this one handoff writes.
  IF generation IS DISTINCT FROM p_lease_generation OR generation IS NOT DISTINCT FROM s.lease_generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  evidence:=CASE WHEN EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash)
   THEN 'canonical_failure' ELSE 'superseded_generation' END;
  -- The original exact generations and before-stacks must still occupy the
  -- table. No later hand/permit may have consumed this starting state.
  -- A chair taken AFTER this hand was dealt is not part of it: it was not
  -- dealt in, the hand cannot move its chips, and the committed stacks name
  -- only the hand's own seats. Such a chair must not hold the finished hand
  -- hostage (2026-09-26, 8ec7e81d: a late registrant seated 30 s after the
  -- hand ended froze its table for eight days). A chair that was present at
  -- the deal and is missing from the submission is admitted only when the
  -- hand declares no inflow, the hand's own record never names its player,
  -- and every player the record names is in the submission (2026-09-29,
  -- 6c9ee4b6: two horses seated 43 s and 18 s before the deal, not dealt in,
  -- froze the table for six days). The settlement still refuses any
  -- non-conserving stack set, so a dealt player left out of the stacks can
  -- never settle. A hand player seated twice still refuses; an undated deal
  -- refuses.
  q:=s.request;
  retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);
  retired_cash_restored:=smarter_private.adopt_retired_cash_original_hand(s.submission_id,p_instance_id,p_lease_generation);
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live', or 'breaking' while the table is being closed
      -- (2026-09-29, 499aa67a): the original commit never refused a breaking
      -- cash table, so its successor must not either. A tournament table keeps
      -- NULL until it closes; 'closed' still refuses everywhere.
      AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (q->'p_hand_row'->>'started_at') IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND ((late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
         AND (strpos((q->'p_hand_row')::text,late.user_id::text)>0
           OR COALESCE((q->>'p_inflow')::numeric,0)<>0
           OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_hand_row'->'players') hp
             WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE x->>'user_id'=hp->>'userId'))))
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM smarter_private.retired_cash_hand_custody r
      WHERE r.submission_id=s.submission_id AND r.request_hash=s.request_hash AND r.state='held'
       AND r.transaction_id=txid_current() AND r.user_id=(x->>'user_id')::uuid
       AND r.seat_id=(x->>'seat_id')::uuid AND r.occupancy_id=(x->>'occupancy_id')::uuid
       AND r.seat_joined_at=(x->>'seat_joined_at')::timestamptz
       AND r.stack_before=(x->>'stack_before')::numeric AND r.stack_after=(x->>'stack')::numeric)
    AND NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric
       -- AN ADD-ON CREDITED WHILE THE HAND WAITED (2026-10-02). A tournament
       -- chair may hold exactly the event's addon_chips more than the hand
       -- dealt from, only when its registration bought the add-on. The
       -- settlement runs in delta mode (every element carries stack_before),
       -- so that credit is preserved, not overwritten.
       OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp
         JOIN public.tournaments ev ON ev.id=tp.tournament_id
         WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE
           AND COALESCE(ev.addon_chips,0)>0
           AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- Metadata restoration is valid only if the SAME original hand commits.
  -- A returned or thrown financial refusal rolls back the entire call,
  -- including every restored row, receipt and handoff claim.
  IF (retirement_restored OR retired_cash_restored) AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_NOT_COMMITTED: %',r USING ERRCODE='P0404';
  END IF;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='55P03';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r||jsonb_build_object('handoff_evidence',evidence));
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   IF retired_cash_restored THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED' USING ERRCODE='P0404';
   END IF;
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  IF retired_cash_restored THEN
   RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: % %',code,message USING ERRCODE='P0404';
  END IF;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 IF retired_cash_restored AND EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c
  WHERE c.submission_id=s.submission_id AND (c.state IS DISTINCT FROM 'consumed'
   OR c.accepted_time_bank IS DISTINCT FROM c.original_time_bank OR c.settlement_id IS NULL)) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED' USING ERRCODE='P0404';
 END IF;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$;


CREATE OR REPLACE FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
 OR NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid IS DISTINCT FROM t
 OR NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid IS DISTINCT FROM g OR t IS NULL OR g IS NULL THEN
 RAISE EXCEPTION 'F06_PROTOCOL2_REQUIRED' USING ERRCODE='42501'; END IF;
 IF take_lock THEN
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 ELSE
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$
;


CREATE OR REPLACE FUNCTION smarter_private.hand_submission_dispose_dealt_past(p_table_id uuid, p_before bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_witness bigint;
  v_witness_at timestamptz;
  v_receipt uuid := gen_random_uuid();
  v_disposed integer := 0;
BEGIN
  -- Called only from fn_ca_resume_hand_submission, after it proved the
  -- caller's cash lease and locked the table, its seats and the lowest
  -- unfinished hand. It decides nothing on a tournament table, under the
  -- freeze, or while another disposal holds this table.
  IF p_table_id IS NULL OR p_before IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.tables WHERE id = p_table_id AND tournament_id IS NULL)
     OR public.fn_platform_frozen()
     OR NOT pg_try_advisory_xact_lock(hashtextextended('hand:disposal:' || p_table_id::text, 0)) THEN
    RETURN 0;
  END IF;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);

  -- THE WITNESS: the newest hand this table committed. It consumed the very
  -- stacks every earlier unfinished request names.
  SELECT a.hand_number, a.committed_at INTO v_witness, v_witness_at
    FROM public.hand_atomic_commits a
   WHERE a.table_id = p_table_id
   ORDER BY a.hand_number DESC LIMIT 1;
  IF v_witness IS NULL OR v_witness <= p_before THEN
    RETURN 0;
  END IF;

  -- Exactly the proofs of fn_ca_dispose_superseded_hand_submissions
  -- (20260928001934, 150,022 rows disposed through them on 2026-09-28): no
  -- commit and no history for the hand, no successor claim or open dispatch,
  -- no reserved or accepted F06 permit, its dealer generation holds no lease,
  -- and it was retained more than thirty minutes ago. Anything else is left
  -- for the handoff to refuse, by name.
  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id, v_receipt, v_witness,
         'resume door: this cash table committed a later hand, which consumed the stacks this retained request names; nothing of this hand is durable and nobody can ever apply it',
         jsonb_build_object(
           'kind', 'superseded_retained_submission',
           'door', 'fn_ca_resume_hand_submission',
           'table_id', s.table_id, 'tournament_id', NULL,
           'hand_number', s.hand_number, 'submission_id', s.submission_id,
           'retained_at', s.retained_at, 'dealer_generation', s.lease_generation,
           'request_hash', s.request_hash,
           'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
           'disposed_at', clock_timestamp())
    FROM smarter_private.hand_submissions s
   WHERE s.table_id = p_table_id
     AND s.hand_number < v_witness
     AND s.retained_at < clock_timestamp() - interval '30 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                      WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                      WHERE hh.table_id = s.table_id AND hh.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_handoffs h
                      WHERE h.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispatch d
                      WHERE d.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                      WHERE p.table_id = s.table_id AND p.hand_number = s.hand_number
                        AND p.state IN ('reserved', 'accepted'))
     AND NOT EXISTS (SELECT 1 FROM public.engine_table_leases l
                      WHERE l.table_id = s.table_id AND l.lease_generation = s.lease_generation)
   ORDER BY s.hand_number
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;
  RETURN v_disposed;
END
$function$
;

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_dispose_refused_vacated(p_table_id uuid, p_submission_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_receipt uuid := gen_random_uuid();
  v_disposed integer := 0;
BEGIN
  -- Called only from fn_ca_resume_hand_submission, after it proved the
  -- caller's cash lease and locked the table, its seats and the lowest
  -- unfinished hand. It decides nothing on a tournament table, under the
  -- freeze, or while another disposal holds this table.
  IF p_table_id IS NULL OR p_submission_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.tables WHERE id = p_table_id AND tournament_id IS NULL)
     OR public.fn_platform_frozen()
     OR NOT pg_try_advisory_xact_lock(hashtextextended('hand:disposal:' || p_table_id::text, 0)) THEN
    RETURN 0;
  END IF;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id, v_receipt, s.hand_number,
         'resume door: the settlement contract refused this cash hand and rolled it back, and every chair it names has since closed, so nothing of it is durable and nobody can ever apply it',
         jsonb_build_object(
           'kind', 'refused_retained_submission_seats_closed',
           'door', 'fn_ca_resume_hand_submission',
           'table_id', s.table_id, 'tournament_id', NULL,
           'hand_number', s.hand_number, 'submission_id', s.submission_id,
           'retained_at', s.retained_at, 'dealer_generation', s.lease_generation,
           'request_hash', s.request_hash,
           'refusal', (SELECT f.result FROM smarter_private.hand_submission_failures f
                        WHERE f.submission_id = s.submission_id AND f.request_hash = s.request_hash
                        LIMIT 1),
           'chairs', jsonb_array_length(s.request->'p_stacks'),
           'disposed_at', clock_timestamp(), 'credit', 0)
    FROM smarter_private.hand_submissions s
   WHERE s.table_id = p_table_id
     AND s.submission_id = p_submission_id
     AND s.retained_at < clock_timestamp() - interval '30 minutes'
     AND EXISTS (SELECT 1 FROM smarter_private.hand_submission_failures f
                  WHERE f.submission_id = s.submission_id AND f.request_hash = s.request_hash)
     AND jsonb_typeof(s.request->'p_stacks') = 'array'
     AND jsonb_array_length(s.request->'p_stacks') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x
                      JOIN public.table_seats seat ON seat.id = (x->>'seat_id')::uuid
                     WHERE seat.left_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                      WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                      WHERE hh.table_id = s.table_id AND hh.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_handoffs h
                      WHERE h.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispatch d
                      WHERE d.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                      WHERE p.table_id = s.table_id AND p.hand_number = s.hand_number
                        AND p.state IN ('reserved', 'accepted'))
     AND NOT EXISTS (SELECT 1 FROM public.engine_table_leases l
                      WHERE l.table_id = s.table_id AND l.lease_generation = s.lease_generation)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;
  RETURN v_disposed;
END
$function$
;


SET check_function_bodies=on;
