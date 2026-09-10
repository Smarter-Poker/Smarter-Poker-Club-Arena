-- ROLLBACK for supabase/migrations/*_the_settlement_lane_is_per_tournament_for_rolling_authoritie.sql
-- Every definition that migration replaces, dumped byte for byte from production
-- with pg_get_functiondef on 2026-09-10T17:30:21Z, before it was applied.
-- Apply as ONE migration (one transaction, one schema-cache reload) outside :50-:03 UTC.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- G first: still one authority at a time, still what the trigger guards
  -- look for.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to. Keep yesterday's exclusion rather than none.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- T(id): only this tournament's hands wait, and only for this tournament's
  -- rolling authorities.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_global boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND l.classid=(((v_key>>32)&4294967295)::oid)
       AND l.objid=((v_key&4294967295)::oid)
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_global;
  IF NOT COALESCE(v_owns_global,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  -- Ticket admission and an exact pre-start ticket return are the only
  -- lifecycle edges that may respectively add or remove provenance after the
  -- source satellite has closed. Both enclosing authorities acquire the same
  -- terminal-global transaction lock before touching the target registration.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
         AND l.objid=((v_acquisition_key&4294967295)::oid)
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
       OR (TG_OP='DELETE'
           AND COALESCE(v_owns_acquisition_root,false)
           AND COALESCE(current_setting(
                 'app.tournament_seat_exit_operation',true),'')='unregister')
     )
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_key bigint := hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_terminal_root boolean := false;
BEGIN
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') =
         'i_am_correcting_the_record' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid = pg_backend_pid()
         AND l.locktype = 'advisory'
         AND l.database = (
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname = current_database())
         AND l.classid = (((v_terminal_key >> 32) & 4294967295)::oid)
         AND l.objid = ((v_terminal_key & 4294967295)::oid)
         AND l.objsubid = 1
         AND l.mode = 'ExclusiveLock'
         AND l.granted)
      INTO v_owns_terminal_root;

    IF v_owns_terminal_root
       AND public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation',
          HINT = 'A DBA correcting a bad row must SET LOCAL app.payout_record_correction = ''i_am_correcting_the_record'' in the same transaction, from a migration that says why.';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(p_tournament_id uuid, p_operation text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_tournament_id IS NULL
     OR p_operation NOT IN (
       'unregister','cancel','satellite_finish','terminal_finish','move',
       'elimination') THEN
    RAISE EXCEPTION 'invalid tournament seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;

  -- Deterministic seat order matches hand settlement and terminal close.
  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id
   FOR UPDATE OF s;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,p_operation
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation',p_operation,true);
  RETURN v_token;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(p_request_id uuid, p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_destination_table_id uuid, p_destination_seat_number integer, p_source_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'committed tournament move receipt requires ordinary service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10
     OR p_source_mode NOT IN ('live_source','closed_orphan') THEN
    RAISE EXCEPTION 'invalid committed tournament move receipt identity'
      USING ERRCODE='22023';
  END IF;

  -- The writer takes this lock before its first receipt read and holds it
  -- through commit. Waiting here makes a receipt read observe any writer that
  -- already owns the settlement boundary. An absent receipt is deliberately
  -- not converted into proof that no write can still begin later.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
     OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
     OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
     OR (v_result->>'destination_table_id')::uuid
          IS DISTINCT FROM p_destination_table_id
     OR (v_result->>'destination_seat_number')::integer
          IS DISTINCT FROM p_destination_seat_number
     OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode THEN
    RAISE EXCEPTION 'tournament move request id belongs to another operation'
      USING ERRCODE='23505';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_a record;
  v_r record;
  v_paid bigint := 0;
  v_credited boolean;
  v_refused integer := 0;
  v_chest_status text;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','award_not_found');
  END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  -- The unguarded payer owns the exact award before it writes obligation and
  -- wallet evidence. Own every terminal-visible set in the same canonical
  -- tournament -> obligations -> chests -> awards -> recipients order first;
  -- its later row locks are then transaction-local reacquisitions.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = v_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = v_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_award_recipients r
   JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = v_tournament_id
   ORDER BY r.user_id,r.id FOR UPDATE OF r;
  -- The payer itself is static in this root. Stage two can remove the
  -- temporary unguarded copy without leaving an undefined runtime call.
  SELECT * INTO v_a
    FROM public.tournament_bounty_awards
   WHERE id = p_award_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;

  IF v_a.status = 'completed' THEN
    IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
         AND public.fn_bounty_obligation_has_complete_marker(o.id)
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','completed_award_marker_incomplete',
        'award_id',p_award_id);
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'award_id', p_award_id,
      'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'award_voided_by_settlement',
      'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests
   WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'chest_settled_to_champion',
      'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id
       AND paid_at IS NULL
       AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    v_prior := COALESCE((
      SELECT o.amount_paid FROM public.tournament_obligations o
       WHERE o.tournament_id = v_a.tournament_id
         AND o.kind = 'mystery_bounty'
         AND o.place IS NULL
         AND o.user_id = v_r.user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      v_a.tournament_id, 'mystery_bounty', NULL, v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay',
      'Mystery bounty revealed from eliminated player');
    v_credited := COALESCE((v_settle->>'ok')::boolean, false);

    IF COALESCE(v_credited, false)
       AND round(COALESCE((v_settle->>'paid')::numeric,0),2)
             = round((v_r.amount_cents / 100.0)::numeric,2) THEN
      UPDATE public.tournament_bounty_award_recipients
         SET paid_at = now()
       WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(
               COALESCE(bounty_winnings, 0)
                 + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id
         AND user_id = v_r.user_id;

      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id,
         bounty_amount, is_mystery_revealed, bounty_obligation_id)
      VALUES
        (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
         (v_r.amount_cents / 100.0)::numeric, true,
         v_a.bounty_obligation_id)
      ON CONFLICT DO NOTHING;
    ELSE
      RAISE EXCEPTION
        'fn_mystery_bounty_pay: recipient % refused for award % (%)',
        v_r.user_id, p_award_id,
        COALESCE(v_settle->>'refused_reason','unknown')
        USING ERRCODE='check_violation';
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    UPDATE public.tournaments
       SET bounty_pool_paid = round(
             COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  UPDATE public.tournament_bounty_award_recipients
     SET paid_at=COALESCE(paid_at,now())
   WHERE award_id=p_award_id AND amount_cents=0;

  IF v_refused = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id=p_award_id AND paid_at IS NULL
  ) THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now()
     WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests
       SET status = 'paid'
     WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES (
      'critical', 'fn_mystery_bounty_pay',
      'Mystery bounty award left incomplete: a recipient credit was refused',
      jsonb_build_object(
        'award_id', p_award_id,
        'tournament_id', v_a.tournament_id,
        'refused_recipients', v_refused,
        'paid_cents', v_paid,
        'award_cents', v_a.amount_cents,
        'refused_reason', v_settle->>'refused_reason',
        'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
       AND public.fn_bounty_obligation_has_complete_marker(o.id)
  ) THEN
    RAISE EXCEPTION
      'mystery award % completed without its exact settled marker',p_award_id
      USING ERRCODE='check_violation';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients
       WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions player is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(p_tournament_id uuid, p_user_id uuid, p_launch_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_status text;
  v_receipt public.tournament_launch_receipts%ROWTYPE;
  v_request_id uuid;
  v_result jsonb;
  v_reason text := left(COALESCE(NULLIF(btrim(p_reason),''),'seat refused'),200);
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_ca_release_unseatable_registrant_at_launch requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_launch_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and launch ids are required'
      USING ERRCODE='22023';
  END IF;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status<>'REGISTERING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_launching','status',v_status);
  END IF;

  SELECT * INTO v_receipt FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_receipt.launch_id<>p_launch_id OR v_receipt.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_receipt_mismatch');
  END IF;

  -- A seated player is never released here. If he holds a live seat in this
  -- event the launch's inventory was stale; the next pass reads him seated.
  IF EXISTS (
    SELECT 1 FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_seated');
  END IF;

  -- One request id per (launch, player): a lost response replays the same
  -- unregistration receipt instead of refunding twice.
  v_request_id := md5(p_launch_id::text||':'||p_user_id::text)::uuid;

  PERFORM set_config('app.ca_launch_release_launch_id', p_launch_id::text, true);
  v_result := public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id, p_user_id, NULL,
    'Released at launch (could not be seated: '||v_reason||')',
    v_request_id);
  PERFORM set_config('app.ca_launch_release_launch_id', '', true);

  RETURN COALESCE(v_result,'{}'::jsonb)
         || jsonb_build_object('released', COALESCE((v_result->>'ok')::boolean,false),
                               'request_id', v_request_id,
                               'launch_id', p_launch_id,
                               'release_reason', v_reason);
END;
$function$
;

COMMIT;
