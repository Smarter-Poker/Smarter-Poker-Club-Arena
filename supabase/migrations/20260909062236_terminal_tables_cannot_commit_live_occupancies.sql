-- A committed active seat must retain its cash/tournament asset identity
-- and reference a nonterminal, nondeleted table. The native key covers both.
-- The engine owns cash departures; a table status update has no hand authority.
-- A native FK serializes close vs admission without a table->user cashout loop.
-- Existing cash stacks and wallets are not adjusted. Tournament cleanup remains
-- available through its existing helper, but that helper cannot clear cash seats.
-- Requires the native game ownership and read-only cash-close assertion migrations.
BEGIN;
SET LOCAL search_path TO public,pg_temp;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.tables,public.table_seats IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass
   AND conname='one_committed_seat_per_game_player' AND convalidated AND condeferrable AND condeferred) THEN
  RAISE EXCEPTION 'Native game ownership must be installed before close/admission ownership';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cashout_seats_for_closing_table(uuid,text)'::regprocedure)
   <> '2904d38e22d59c753795957b9f57ad0f' THEN
  RAISE EXCEPTION 'Cash table closure must assert completed engine departures before this migration';
 END IF;
 IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
   WHERE s.left_at IS NULL AND (lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
     OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false))) THEN
  RAISE EXCEPTION 'Active seat on a terminal table requires transaction-level investigation';
 END IF;
END
$guard$;
DO $patch$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('public.fn_managed_game_contract_document(text,jsonb)'::regprocedure) INTO definition;
 IF md5(definition)='6a8019cb24b5a8a42645b9de3aaf48ef' THEN RETURN; END IF;
 IF md5(definition)<>'154901c4d25f28060e81bc06619e788a' THEN RAISE EXCEPTION 'Unreviewed baseline for public.fn_managed_game_contract_document(text,jsonb)'; END IF;
 definition := $definition$CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      'lifecycle', 'role', 'main_index', 'opened_at', 'live_at',
      'break_started_at', 'break_eligible_since', 'promote_pending',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at', 'seat_game_scope', 'seat_admission_key'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'description', p_row -> 'description',
        'short_description', p_row -> 'short_description',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount',
        'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips',
        'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players',
        'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'payout_percent', p_row -> 'payout_percent',
        'guaranteed_prize', p_row -> 'guaranteed_prize'
      ) || jsonb_build_object(
        'late_reg_levels', p_row -> 'late_reg_levels',
        'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels',
        'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy',
        'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost',
        'rebuy_chips', p_row -> 'rebuy_chips',
        'max_rebuys', p_row -> 'max_rebuys',
        'max_reentries', p_row -> 'max_reentries',
        'free_buy', p_row -> 'free_buy',
        'add_on_available', p_row -> 'add_on_available',
        'addon_from_start', p_row -> 'addon_from_start',
        'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips',
        'addon_levels', p_row -> 'addon_levels',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'is_bounty', p_row -> 'is_bounty',
        'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko',
        'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'mystery_bounty_profile', p_row -> 'mystery_bounty_profile',
        'mystery_bounty_activation', p_row -> 'mystery_bounty_activation',
        'mystery_bounty_activation_value', p_row -> 'mystery_bounty_activation_value',
        'mystery_bounty_pool_percent', p_row -> 'mystery_bounty_pool_percent',
        'mystery_bounty_regular_pool_percent', p_row -> 'mystery_bounty_regular_pool_percent',
        'mystery_bounty_top_percent', p_row -> 'mystery_bounty_top_percent',
        'spin_type', p_row -> 'spin_type',
        'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_target', p_row -> 'satellite_target',
        'satellite_seats', p_row -> 'satellite_seats'
      ) || jsonb_build_object(
        'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private',
        'is_vip_only', p_row -> 'is_vip_only',
        'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold',
        'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds',
        'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks'
      ) || jsonb_build_object(
        'is_multi_day', p_row -> 'is_multi_day',
        'total_days', p_row -> 'total_days',
        'is_pinned', p_row -> 'is_pinned',
        'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$
$definition$;
 IF md5(definition)<>'6a8019cb24b5a8a42645b9de3aaf48ef' THEN RAISE EXCEPTION 'Unexpected patch for public.fn_managed_game_contract_document(text,jsonb)'; END IF;
 EXECUTE definition;
END $patch$;
DO $patch$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('public.fn_clear_table_seats(uuid,boolean)'::regprocedure) INTO definition;
 IF md5(definition)='66923ea85a2278f0992b5e802f3340a7' THEN RETURN; END IF;
 IF md5(definition)<>'1383315f595906d6f1b77190355c4c7b' THEN RAISE EXCEPTION 'Unreviewed baseline for public.fn_clear_table_seats(uuid,boolean)'; END IF;
 definition := $definition$CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(p_table_id uuid, p_reopen boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cleared integer := 0;
  v_tournament uuid;
BEGIN
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Table not found' USING ERRCODE='22023'; END IF;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'CASH_SEAT_CLEAR_REQUIRES_ENGINE_DEPARTURES' USING ERRCODE='55000';
  END IF;
  -- Only tournament cleanup reaches this point. Cash departures are engine-owned.
  PERFORM public.fn_cashout_seats_for_closing_table(p_table_id, 'seats cleared');

  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.tables
     SET current_players = 0,
         status = CASE WHEN p_reopen AND status <> 'closed' THEN 'waiting' ELSE status END
   WHERE id = p_table_id;

  RETURN v_cleared;
END;
$function$
$definition$;
 IF md5(definition)<>'66923ea85a2278f0992b5e802f3340a7' THEN RAISE EXCEPTION 'Unexpected patch for public.fn_clear_table_seats(uuid,boolean)'; END IF;
 EXECUTE definition;
END $patch$;
DO $managed_close$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_close_managed_game(text,uuid)'::regprocedure) INTO definition;
 IF md5(definition)='96be8943f1b86538d2b825c894d21f7a' THEN RETURN; END IF;
 IF md5(definition)<>'8c09b89cc6fc124e0ee03e53c8a47ba3' THEN
  RAISE EXCEPTION 'Unreviewed managed close baseline';
 END IF;
 definition := $definition$CREATE OR REPLACE FUNCTION public.fn_close_managed_game(p_kind text, p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
  v_initial_cluster uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    -- Match the cluster controller's game->table order. Authorize the
    -- initial scope before locking, then recheck the locked table below.
    SELECT club_id,cluster_id INTO v_club,v_initial_cluster
      FROM public.tables WHERE id=p_game_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    IF NOT public.fn_can_create_games(v_club,v_uid) THEN
      RETURN jsonb_build_object('ok',false,'reason','not_authorized');
    END IF;
    IF v_initial_cluster IS NOT NULL THEN
      PERFORM 1 FROM public.cash_games WHERE id=v_initial_cluster FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    END IF;
    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF v_cluster IS DISTINCT FROM v_initial_cluster THEN
      RAISE EXCEPTION 'STALE_GAME_CONTEXT: table changed games while closing' USING ERRCODE='55000';
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN ('closed', 'completed', 'cancelled', 'finished') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    -- The native admission FK serializes new seats against this parent lock.
    -- A refusal needs a snapshot, not a seat lock ahead of an engine cashout.
    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    UPDATE public.tournaments
       SET status = 'CANCELLED', ended_at = now(), updated_at = now()
     WHERE id = p_game_id;
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_game_id;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$function$
$definition$;
 IF md5(definition)<>'96be8943f1b86538d2b825c894d21f7a' THEN RAISE EXCEPTION 'Unexpected managed close patch'; END IF;
 EXECUTE definition;
END $managed_close$;
REVOKE ALL ON FUNCTION public.fn_clear_table_seats(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clear_table_seats(uuid,boolean) TO service_role;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seat_admission_key text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS active_parent_key text;
CREATE OR REPLACE FUNCTION public.fn_stamp_table_seat_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp
AS $function$
BEGIN
 NEW.seat_admission_key := CASE
   WHEN lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished')
     OR NEW.lifecycle='closed' OR coalesce(NEW.is_deleted,false) OR coalesce(NEW.is_template,false) THEN 'closed'
   WHEN NEW.tournament_id IS NOT NULL THEN 'tournament:'||NEW.tournament_id::text
   ELSE 'cash' END;
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_require_live_seat_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp
AS $function$
DECLARE parent_key text;
BEGIN
 IF NEW.left_at IS NOT NULL THEN
  NEW.active_parent_key := NULL;
  RETURN NEW;
 END IF;
 SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active seat requires an existing parent table' USING ERRCODE='23514'; END IF;
 IF parent_key IS NULL THEN
  -- Only a pre-migration empty parent needs this initialization. Ordinary
  -- admissions do not update/lock the parent ahead of the native FK check.
  UPDATE public.tables t SET seat_admission_key = CASE
    WHEN lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
      OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false) THEN 'closed'
    WHEN t.tournament_id IS NOT NULL THEN 'tournament:'||t.tournament_id::text
    ELSE 'cash' END
  WHERE t.id=NEW.table_id AND t.seat_admission_key IS NULL;
  SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 IF parent_key IS NULL OR parent_key='closed' THEN
  RAISE EXCEPTION 'CLOSED_TABLE_REJECTS_ACTIVE_SEAT' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' OR OLD.left_at IS NOT NULL
   OR OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  IF (current_setting('app.money_path',true) IN ('atomic_table_buyin','fn_horse_seat_from_treasury')
      OR current_setting('app.cash_seat_move',true)='on') AND parent_key<>'cash' THEN
   RAISE EXCEPTION 'CASH_PURCHASE_ONLY: cash admission cannot create tournament chips' USING ERRCODE='55000';
  END IF;
 END IF;
 NEW.active_parent_key := parent_key;
 RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_stamp_table_seat_admission() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_require_live_seat_parent() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zzzz_stamp_table_seat_admission ON public.tables;
CREATE TRIGGER zzzz_stamp_table_seat_admission BEFORE INSERT OR UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_table_seat_admission();
DROP TRIGGER IF EXISTS zzzzz_require_live_seat_parent ON public.table_seats;
CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_require_live_seat_parent();
CREATE TEMP TABLE ca_admission_parent_proof ON COMMIT DROP AS
SELECT t.id,to_jsonb(t)-'seat_admission_key'-'updated_at' AS original
FROM public.tables t WHERE EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL);
CREATE TEMP TABLE ca_admission_seat_proof ON COMMIT DROP AS
SELECT s.id,to_jsonb(s)-'active_parent_key' AS original FROM public.table_seats s WHERE s.left_at IS NULL;
UPDATE public.tables t SET seat_admission_key=(CASE WHEN lower(coalesce(status,'')) IN ('closed','completed','cancelled','finished')
 OR lifecycle='closed' OR coalesce(is_deleted,false) OR coalesce(is_template,false) THEN 'closed'
 WHEN tournament_id IS NOT NULL THEN 'tournament:'||tournament_id::text ELSE 'cash' END)
WHERE seat_admission_key IS NULL AND EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL);
UPDATE public.table_seats s SET active_parent_key=t.seat_admission_key FROM public.tables t
WHERE s.table_id=t.id AND s.left_at IS NULL AND s.active_parent_key IS DISTINCT FROM t.seat_admission_key;
DO $constraints$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tables'::regclass AND conname='table_seat_admission_is_derived') THEN
  ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_is_derived CHECK
   (seat_admission_key IS NULL OR seat_admission_key=(CASE WHEN lower(coalesce(status,'')) IN ('closed','completed','cancelled','finished')
 OR lifecycle='closed' OR coalesce(is_deleted,false) OR coalesce(is_template,false) THEN 'closed'
 WHEN tournament_id IS NOT NULL THEN 'tournament:'||tournament_id::text ELSE 'cash' END));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tables'::regclass AND conname='table_seat_admission_parent_key') THEN
  ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_parent_key UNIQUE(id,seat_admission_key);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass AND conname='active_seat_requires_open_parent') THEN
  ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_open_parent CHECK
   ((left_at IS NULL AND active_parent_key IS NOT NULL AND active_parent_key<>'closed') OR (left_at IS NOT NULL AND active_parent_key IS NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass AND conname='live_seat_parent_cannot_close') THEN
  ALTER TABLE public.table_seats ADD CONSTRAINT live_seat_parent_cannot_close
   FOREIGN KEY(table_id,active_parent_key) REFERENCES public.tables(id,seat_admission_key);
 END IF;
END
$constraints$;
DO $catalog$
DECLARE expected record; actual text;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
    ('tables','table_seat_admission_is_derived','CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''''::text)) = ANY (ARRAY[''closed''::text, ''completed''::text, ''cancelled''::text, ''finished''::text])) OR (lifecycle = ''closed''::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN ''closed''::text
    WHEN (tournament_id IS NOT NULL) THEN (''tournament:''::text || (tournament_id)::text)
    ELSE ''cash''::text
END)))'),
    ('tables','table_seat_admission_parent_key','UNIQUE (id, seat_admission_key)'),
    ('table_seats','active_seat_requires_open_parent','CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> ''closed''::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL))))'),
    ('table_seats','live_seat_parent_cannot_close','FOREIGN KEY (table_id, active_parent_key) REFERENCES tables(id, seat_admission_key)')
 ) AS specification(table_name,constraint_name,definition)
 LOOP
  SELECT pg_get_constraintdef(c.oid) INTO actual FROM pg_constraint c
  WHERE c.conrelid=('public.'||expected.table_name)::regclass
    AND c.conname=expected.constraint_name AND c.convalidated;
  IF regexp_replace(actual,'[[:space:]]+',' ','g') IS DISTINCT FROM
     regexp_replace(expected.definition,'[[:space:]]+',' ','g') THEN
   RAISE EXCEPTION 'Unreviewed admission constraint %',expected.constraint_name;
  END IF;
 END LOOP;
END
$catalog$;
DO $proof$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_temp.ca_admission_parent_proof p LEFT JOIN public.tables t ON t.id=p.id
   WHERE t.id IS NULL OR p.original IS DISTINCT FROM to_jsonb(t)-'seat_admission_key'-'updated_at')
 OR EXISTS(SELECT 1 FROM pg_temp.ca_admission_seat_proof p LEFT JOIN public.table_seats s ON s.id=p.id
   WHERE s.id IS NULL OR p.original IS DISTINCT FROM to_jsonb(s)-'active_parent_key') THEN
  RAISE EXCEPTION 'Admission backfill changed existing game or seat data; entire migration refused';
 END IF;
END
$proof$;
-- Retire the old closed-table repair only after native admission is installed.
DO $planner$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure) INTO definition;
 IF md5(definition)='ae91ea39aef3746371029528cb8e343d' THEN RETURN; END IF;
 IF md5(definition)<>'2303b31672ff35201d2a310d821c0cd4' THEN
  RAISE EXCEPTION 'Unreviewed cluster planner before closed-parent repair retirement';
 END IF;
 definition := replace(definition,$old$  -- A CLOSED TABLE WITH SOMEONE ON IT (2026-09-05). The census excludes
  -- closed tables, so a player who reached one (the seat guard below now
  -- refuses; this covers what got through before it, and any future hole)
  -- would never be planned out. It goes back to `breaking`, which the
  -- census sees and step 5 walks empty, then closes again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'closed'
              AND coalesce(tb.is_deleted, false) = false
              AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET lifecycle = 'breaking', status = 'running', break_started_at = v_now, updated_at = now()
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'closed_table_reopened_to_break');
    v_actions := v_actions || jsonb_build_object('reopened_to_break', t.id);
  END LOOP;

$old$,$new$  -- Active seats cannot commit against a closed parent; no reopen repair is needed.

$new$);
 definition := replace(definition,E'  v_res jsonb;\n','');
 IF md5(definition)<>'ae91ea39aef3746371029528cb8e343d' THEN RAISE EXCEPTION 'Unexpected closed-parent repair patch'; END IF;
 EXECUTE definition;
END
$planner$;
COMMIT;
