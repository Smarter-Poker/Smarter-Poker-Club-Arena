-- 20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 7 REMEDIATION: THE REVERSION REVIEW FINDINGS ARE CLOSED.
--
-- Production applied 20261001222856 (the LIGHTNING -> MUST-MOVE reversion and
-- the tick-driven conversions). Review found five defects around it; each is
-- fixed here at its root, as an asserted substitution into the body
-- production carries.
--
-- 1. (P1) fn_cash_cluster_unfreeze left the Cluster's pending
--    cash_cluster_conversion open and its engine halt acknowledgements set.
--    The one-open-per-cluster unique index then refused every later
--    begin_pending_on - as an exception the drive recorded as
--    lightning_drive_error on every tick pass (~17k/day) - and
--    fn_cash_cluster_reap_stuck_conversions skipped the orphan for ever
--    (not_a_pending_on_lightning_conversion). Now: the unfreeze aborts any
--    pending conversion of the Cluster (status 'aborted', abort_reason
--    'cluster_unfrozen', closed_at) and clears dealing_halt_observed_at
--    exactly as the commit does; the reaper aborts any pending conversion
--    whose Cluster's mode is not that conversion's pending mode (abort_reason
--    'orphaned_by_<mode>') instead of skipping it; and begin_pending_on /
--    begin_pending_off answer a structured refusal (conversion_already_open)
--    rather than dying on the index when an open conversion already exists.
--
-- 2. (P2) fn_cash_cluster_commit_must_move's no-money-moved digest ran
--    unlocked at READ COMMITTED over every historical row, so ordinary
--    concurrent seat or session traffic between its two reads (an engine
--    is_sitting_out update, fn_request_seat_departure,
--    fn_cash_session_evaluate) could trip LIGHTNING_REVERSION_MOVED_MONEY as
--    a false alarm, and its cost grew with the Cluster's whole history. Now
--    the live rows are taken FOR SHARE first, in the estate's order (the
--    Cluster row is already held FOR UPDATE; then the seats in seat-id order,
--    as formation takes its anchors; then the open cash sessions; then the
--    blind ledger), and both digests cover exactly the live rows: seats whose
--    left_at IS NULL, sessions whose closed_at IS NULL, and the ledger.
--
-- 3. (P2) A voided formation kept its blind-ledger credit:
--    fn_lightning_form_hand counts bb, sb and the positions into
--    lightning_blind_ledger at formation, and no abandon path reversed them,
--    so begin_pending_off's drain credited players blinds they never posted
--    and fn_lightning_blind_order then skipped them. Now the one door every
--    abandon path crosses - the AFTER UPDATE trigger
--    fn_lightning_instance_releases_its_reservations - reverses exactly the
--    increments formation made, floored at zero, when an instance is
--    abandoned before begin_dealing ever ran (started_at IS NULL); formation
--    touches no debt field, so none needs restoring. AND the population
--    trigger of begin_pending_off now dwells: the OFF condition must be seen
--    on two consecutive sightings (the first is recorded durably in
--    cash_games.lightning_off_condition_since) or hold for the configured
--    pending_off_dwell_ms (fn_lightning_config key, default 10000; 0 disables
--    it), so a population hovering at the threshold does not flap and void
--    formations every pass. A disabled Cluster or game still drains at once.
--
-- 4. (P3) commit_must_move lifted the Lightning halts even when the game
--    itself is disabled (cash_games.enabled not true). Now a disabled game's
--    member tables stay halted for the game-close path that owns them, and
--    the result and event say so (halts_kept_game_disabled).
--
-- 5. (P3) commit_must_move and commit_lightning took the Cluster row
--    FOR UPDATE before running their cheap in-flight counts, so every drain
--    poll serialised against formation and the tick. The cheap count now runs
--    first, without the lock, and the lock is taken only when it is zero; the
--    authoritative in-lock count stays.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. One
-- nullable column is added (cash_games.lightning_off_condition_since, no
-- default, no rewrite); no other table is created or altered, and neither
-- tables nor table_seats is locked by DDL. Every change to an existing body
-- is an asserted substitution into the body production carries (read with
-- pg_get_functiondef): each anchor must appear exactly as often as stated or
-- the file refuses, and a body already carrying the change is left alone, so
-- the file is re-appliable. No grant changes: every touched door keeps its
-- SECURITY DEFINER, its pinned search_path and its service_role-only
-- execution.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A voided horse's blind
-- credit is reversed exactly as a human's, and a horse dwells, drains and is
-- reseated exactly as a human is.
--
-- @live-proof: (SELECT s ~ 'abort_reason = ''cluster_unfrozen''' AND s ~ 'dealing_halt_observed_at = NULL' AND s ~ '''conversions_aborted''' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''orphaned_by_'' \|\|' AND s ~ '''lightning_conversion_orphan_reaped''' AND s ~ '''not_a_pending_on_lightning_conversion''' AND s ~ '''lightning_pending_off_reaped''' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT bool_and(pg_get_functiondef(f::regprocedure) ~ '''conversion_already_open''') FROM unnest(ARRAY['public.fn_cash_cluster_begin_pending_on(uuid,uuid)', 'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)']) f)
-- @live-proof: (SELECT s ~ '''pending_off_dwell_ms''' AND s ~ 'lightning_off_condition_since' AND s ~ '''off_condition_dwell''' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure) AS s) q)
-- @live-proof: (SELECT position('''instances_in_flight''' in s) > 0 AND position('''instances_in_flight''' in s) < position('FOR UPDATE' in s) AND s ~ 'FOR SHARE' AND s ~ 'ts\.left_at IS NULL' AND s ~ 's\.closed_at IS NULL' AND s ~ '''halts_kept_game_disabled''' AND s ~ 'LIGHTNING_REVERSION_MOVED_MONEY' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT position('''hands_in_flight''' in s) > 0 AND position('''hands_in_flight''' in s) < position('FOR UPDATE' in s) FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'GREATEST\(bl\.bb_count  - d\.bb,  0\)' AND s ~ 'NEW\.started_at IS NULL' FROM (SELECT pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure) AS s) q)
-- @live-proof: (SELECT pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure) ~ '''pending_off_dwell_ms''')
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_games' AND column_name = 'lightning_off_condition_since'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_unfreeze', 'fn_cash_cluster_reap_stuck_conversions', 'fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_begin_pending_off', 'fn_cash_cluster_commit_must_move', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_lightning_drive', 'fn_lightning_instance_releases_its_reservations', 'fn_lightning_config') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
--
BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 0. THE DWELL'S DURABLE, CHEAP FIRST SIGHTING: one nullable column on the
--    row begin_pending_off already holds FOR UPDATE and the drive already
--    reads. No default and no rewrite, so the ALTER is metadata only.
-- ===========================================================================
ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS lightning_off_condition_since timestamptz;
COMMENT ON COLUMN public.cash_games.lightning_off_condition_since IS
  'Lightning Phase 7 remediation (20261007222717): when the OFF condition was first sighted on a Lightning Cluster. Set by fn_cash_cluster_begin_pending_off on the first sighting, cleared by the drive when a pass does not see the condition and when a PENDING_OFF opens. NULL means no standing sighting.';

-- ===========================================================================
-- 1. fn_cash_cluster_unfreeze: the conversion it orphans is closed, and the
--    engine acknowledgements go with the halts.
-- ===========================================================================
DO $sub_unfreeze$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_unfreeze(uuid,uuid,text)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_tables     integer := 0;
$a$,
$a$  -- A NEW EPOCH IN must_move, so nothing formed at the frozen epoch can ever be
  -- mistaken for the Cluster's present.
  PERFORM set_config('ca.epoch_reason', 'unfrozen', true);
$a$,
$a$     SET dealing_halted_at = NULL, dealing_halted_reason = NULL
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
$a$,
$a$    'instances_abandoned', v_instances, 'pool_sessions_exited', v_sessions, 'slots_closed', v_slots,
$a$,
$a$                            'slots_closed', v_slots, 'tables_released', v_tables, 'chip_total', v_before);
$a$];
  b text[] := ARRAY[
$b$  v_tables     integer := 0;
  v_convs      integer := 0;
$b$,
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): AN UNFREEZE CLOSES THE
  -- CONVERSION IT WOULD OTHERWISE ORPHAN. A Cluster frozen out of pending_off
  -- or pending_on still holds its open cash_cluster_conversion row; left
  -- pending, the one-open-per-cluster index refuses every later begin for
  -- ever (the drive recorded that as lightning_drive_error on every pass) and
  -- the reaper answers not_a_pending_on_lightning_conversion. It is closed
  -- here as an abort, so the record says what happened to it.
  UPDATE public.cash_cluster_conversion
     SET status = 'aborted', abort_reason = 'cluster_unfrozen', closed_at = clock_timestamp()
   WHERE cluster_id = g.id AND status = 'pending';
  GET DIAGNOSTICS v_convs = ROW_COUNT;

  -- A NEW EPOCH IN must_move, so nothing formed at the frozen epoch can ever be
  -- mistaken for the Cluster's present.
  PERFORM set_config('ca.epoch_reason', 'unfrozen', true);
$b$,
$b$     -- 20261007222717: the engine acknowledgement goes with the halt, exactly
     -- as fn_cash_cluster_commit_must_move lifts it, so the next PENDING_ON
     -- waits for a fresh observation of its own halt instead of reading a
     -- stale one.
     SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
$b$,
$b$    'instances_abandoned', v_instances, 'pool_sessions_exited', v_sessions, 'slots_closed', v_slots,
    'conversions_aborted', v_convs,
$b$,
$b$                            'slots_closed', v_slots, 'tables_released', v_tables,
                            'conversions_aborted', v_convs, 'chip_total', v_before);
$b$];
  c integer[] := ARRAY[1, 1, 1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('abort_reason = ''cluster_unfrozen''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('abort_reason = ''cluster_unfrozen''' in v_src) = 0
     OR position('dealing_halt_observed_at = NULL' in v_src) = 0
     OR position('''conversions_aborted''' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back closing the conversion it orphans', v_sig;
  END IF;
END
$sub_unfreeze$;

-- ===========================================================================
-- 2. fn_cash_cluster_reap_stuck_conversions: an orphaned pending conversion
--    is aborted, never skipped for ever.
-- ===========================================================================
DO $sub_reap_orphan$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$    IF c.to_mode IS DISTINCT FROM 'lightning' OR c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
      v_skipped := v_skipped + 1;
      v_rows := v_rows || jsonb_build_object(
        'conversion_id', c.id, 'cluster_id', c.cluster_id, 'reaped', false,
        'reason', 'not_a_pending_on_lightning_conversion',
        'to_mode', c.to_mode, 'cluster_mode', c.cluster_mode);
      CONTINUE;
    END IF;
$a$];
  b text[] := ARRAY[
$b$    -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): A PENDING CONVERSION
    -- WHOSE CLUSTER HAS MOVED ON IS AN ORPHAN, NOT A CURIOSITY. An operator
    -- path that changed the Cluster's mode around a pending conversion (the
    -- unfreeze, before this file closed them there) left a row the
    -- one-open-per-cluster index then enforced for ever: every later begin
    -- was refused, and this reaper skipped the row every pass. A pending
    -- conversion whose Cluster is not in that conversion's own pending mode
    -- is aborted here, with the mode that orphaned it as the reason.
    IF (c.to_mode = 'must_move' AND c.cluster_mode IS DISTINCT FROM 'pending_off')
       OR (c.to_mode = 'lightning' AND c.cluster_mode IS DISTINCT FROM 'pending_on') THEN
      UPDATE public.cash_cluster_conversion
         SET status = 'aborted',
             abort_reason = 'orphaned_by_' || coalesce(c.cluster_mode, 'unknown'),
             closed_at = clock_timestamp()
       WHERE id = c.id AND status = 'pending';
      IF FOUND THEN
        v_reaped := v_reaped + 1;
        INSERT INTO public.cash_cluster_events (game_id, kind, payload)
        VALUES (c.cluster_id, 'lightning_conversion_orphan_reaped', jsonb_build_object(
          'conversion_id', c.id, 'conversion_request_id', c.conversion_request_id,
          'opened_at', c.opened_at, 'to_mode', c.to_mode, 'cluster_mode', c.cluster_mode,
          'abort_reason', 'orphaned_by_' || coalesce(c.cluster_mode, 'unknown'),
          'stuck_for', justify_interval(p_now - c.opened_at)::text, 'at', clock_timestamp()));
        v_rows := v_rows || jsonb_build_object(
          'conversion_id', c.id, 'cluster_id', c.cluster_id, 'reaped', true,
          'reason', 'orphaned_by_' || coalesce(c.cluster_mode, 'unknown'),
          'to_mode', c.to_mode, 'cluster_mode', c.cluster_mode);
      ELSE
        v_skipped := v_skipped + 1;
        v_rows := v_rows || jsonb_build_object(
          'conversion_id', c.id, 'cluster_id', c.cluster_id, 'reaped', false,
          'reason', 'conversion_closed_while_reaping');
      END IF;
      CONTINUE;
    END IF;

    IF c.to_mode IS DISTINCT FROM 'lightning' OR c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
      v_skipped := v_skipped + 1;
      v_rows := v_rows || jsonb_build_object(
        'conversion_id', c.id, 'cluster_id', c.cluster_id, 'reaped', false,
        'reason', 'not_a_pending_on_lightning_conversion',
        'to_mode', c.to_mode, 'cluster_mode', c.cluster_mode);
      CONTINUE;
    END IF;
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''orphaned_by_''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''lightning_conversion_orphan_reaped''' in v_src) = 0
     OR position('''not_a_pending_on_lightning_conversion''' in v_src) = 0
     OR position('''lightning_pending_off_reaped''' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back reaping an orphaned conversion', v_sig;
  END IF;
END
$sub_reap_orphan$;

-- ===========================================================================
-- 3. fn_cash_cluster_begin_pending_on: an open conversion is a structured
--    answer, never a unique-index exception.
-- ===========================================================================
DO $sub_begin_on$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_begin_pending_on(uuid,uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  -- Steps 3 and 4. The verdict is the one reader the lobby already embeds, so
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): AN OPEN CONVERSION IS AN
  -- ANSWER, NOT AN EXCEPTION. A pending conversion this request id does not
  -- name - an orphan an operator path left behind, or a caller bug - used to
  -- reach the INSERT below and die on the one-open-per-cluster unique index,
  -- which the tick's drive then recorded as lightning_drive_error every pass.
  -- It is named structurally instead, so the caller can see what blocks it.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'pending', true,
      'reason', 'conversion_already_open',
      'conversion_id', v_prior.id, 'conversion_request_id', v_prior.conversion_request_id,
      'to_mode', v_prior.to_mode, 'cluster_mode', g.cluster_mode);
  END IF;

  -- Steps 3 and 4. The verdict is the one reader the lobby already embeds, so
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''conversion_already_open''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''conversion_already_open''' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back naming an open conversion', v_sig;
  END IF;
END
$sub_begin_on$;

-- ===========================================================================
-- 4. fn_cash_cluster_begin_pending_off: the same structured refusal, and the
--    population trigger dwells.
-- ===========================================================================
DO $sub_begin_off$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_inflight integer := 0;
$a$,
$a$  -- THE TRIGGER. The verdict is the one population reader the lobby and the
$a$,
$a$  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'threshold_not_reached',
      'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
  END IF;
$a$,
$a$  UPDATE public.cash_games SET cluster_mode = 'pending_off', updated_at = now()
   WHERE id = g.id;
$a$];
  b text[] := ARRAY[
$b$  v_inflight integer := 0;
  v_dwell    integer;
$b$,
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): AN OPEN CONVERSION IS AN
  -- ANSWER, NOT AN EXCEPTION - exactly as begin_pending_on now answers it.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'pending', true,
      'reason', 'conversion_already_open',
      'conversion_id', v_prior.id, 'conversion_request_id', v_prior.conversion_request_id,
      'to_mode', v_prior.to_mode, 'cluster_mode', g.cluster_mode);
  END IF;

  -- THE TRIGGER. The verdict is the one population reader the lobby and the
$b$,
$b$  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'threshold_not_reached',
      'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
  END IF;

  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE OFF CONDITION MUST
  -- DWELL. A population hovering at the OFF threshold used to open a
  -- conversion, void every reserved formation, and abort, on every
  -- oscillation. The population trigger now holds until the condition has
  -- been seen on two consecutive sightings - the first is recorded durably on
  -- the Cluster row this call already holds FOR UPDATE, and a drive pass that
  -- does not see the condition clears it - or has stood for the configured
  -- pending_off_dwell_ms (default 10000; 0 disables the dwell). A disabled
  -- Cluster or game always drains at once: the dwell gates only the
  -- population trigger.
  IF v_why = 'population_at_or_below_off_threshold' THEN
    v_dwell := (public.fn_lightning_config_number(
                  CASE WHEN jsonb_typeof(g.ruleset_snapshot -> 'lightning') = 'object'
                       THEN g.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END,
                  'pending_off_dwell_ms', 10000, 0, 3600000, true) ->> 'value')::integer;
    IF v_dwell > 0 AND g.lightning_off_condition_since IS NULL THEN
      UPDATE public.cash_games
         SET lightning_off_condition_since = clock_timestamp(), updated_at = now()
       WHERE id = g.id;
      RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'off_condition_dwell',
        'why', v_why, 'first_seen_at', clock_timestamp(), 'dwell_ms', v_dwell,
        'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
    END IF;
  END IF;
$b$,
$b$  UPDATE public.cash_games
     SET cluster_mode = 'pending_off', lightning_off_condition_since = NULL, updated_at = now()
   WHERE id = g.id;
$b$];
  c integer[] := ARRAY[1, 1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''off_condition_dwell''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''off_condition_dwell''' in v_src) = 0
     OR position('''conversion_already_open''' in v_src) = 0
     OR position('''pending_off_dwell_ms''' in v_src) = 0
     OR position('lightning_off_condition_since = NULL' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back the dwell and the structured refusal', v_sig;
  END IF;
END
$sub_begin_off$;

-- ===========================================================================
-- 5. fn_cash_cluster_commit_must_move: the drain is polled before the lock,
--    the money digest covers live rows under FOR SHARE, and a disabled game
--    keeps its halts.
-- ===========================================================================
DO $sub_commit_mm$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_commit_must_move(uuid,uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'reason', 'not_found');
  END IF;
$a$,
$a$  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s WHERE s.cluster_id = g.id
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
$a$,
$a$  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_after FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s WHERE s.cluster_id = g.id
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
$a$,
$a$  UPDATE public.tables tb
     SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
   WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
  GET DIAGNOSTICS v_tables = ROW_COUNT;
$a$,
$a$    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'chip_total', v_chips, 'money_md5', v_before), p_request_id);
$a$,
$a$    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'chip_total', v_chips, 'population_at_commit', v_live);
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE DRAIN IS POLLED
  -- BEFORE THE LOCK. The tick asks this every pass while the drain empties,
  -- and the cheap not-ready answer does not need, and no longer takes, the
  -- Cluster row every formation, tick and conversion serialises on. The
  -- authoritative count below still runs under the lock.
  SELECT count(*)::integer INTO v_inflight
    FROM public.lightning_instance li
   WHERE li.cluster_id = p_game_id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'ready', false,
      'reason', 'instances_in_flight', 'instances_in_flight', v_inflight,
      'cluster_mode', (SELECT cluster_mode FROM public.cash_games WHERE id = p_game_id));
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reverted', false, 'reason', 'not_found');
  END IF;
$b$,
$b$  -- THE MONEY, AS EVERY COLUMN OF EVERY LIVE ROW, UNDER ROW LOCKS
  -- (20261007222717). The two digests used to run unlocked at READ COMMITTED
  -- over every historical row, so ordinary concurrent seat or session traffic
  -- committing between them - an engine is_sitting_out update, a departure
  -- request, a session evaluation - could trip the assertion as a false
  -- alarm, and its cost grew with the Cluster's whole history. The live rows
  -- are taken FOR SHARE first, in the estate's order: the Cluster row is
  -- already held FOR UPDATE, then the seats in seat-id order (as formation
  -- takes its anchors), then the open cash sessions, then the blind ledger.
  -- Both digests cover exactly those live rows; a row already dead cannot
  -- change under this transaction's locks and proves nothing about what this
  -- transition wrote.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.left_at IS NULL
     AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
   ORDER BY ts.id
   FOR SHARE;
  PERFORM 1 FROM public.cash_player_session s
   WHERE s.cluster_id = g.id AND s.closed_at IS NULL
   ORDER BY s.id
   FOR SHARE;
  PERFORM 1 FROM public.lightning_blind_ledger bl
   WHERE bl.cluster_id = g.id
   ORDER BY bl.player_id
   FOR SHARE;
  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s
       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
$b$,
$b$  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_after FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
      UNION ALL
      SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s
       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
      UNION ALL
      SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = g.id
    ) x;
$b$,
$b$  IF g.enabled IS NOT DISTINCT FROM true THEN
    UPDATE public.tables tb
       SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL
     WHERE tb.cluster_id = g.id AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on');
    GET DIAGNOSTICS v_tables = ROW_COUNT;
  ELSE
    -- 20261007222717: THE GAME ITSELF IS DISABLED. A reversion is a seating
    -- transition, not a licence to deal: the member tables stay halted for
    -- the game-close path that owns a disabled game, and the result and the
    -- event both say so (halts_kept_game_disabled).
    v_tables := 0;
  END IF;
$b$,
$b$    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'halts_kept_game_disabled', g.enabled IS DISTINCT FROM true,
    'chip_total', v_chips, 'money_md5', v_before), p_request_id);
$b$,
$b$    'tables_released', v_tables, 'tables_still_halted', v_halted,
    'halts_kept_game_disabled', g.enabled IS DISTINCT FROM true,
    'chip_total', v_chips, 'population_at_commit', v_live);
$b$];
  c integer[] := ARRAY[1, 1, 1, 1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''halts_kept_game_disabled''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''halts_kept_game_disabled''' in v_src) = 0
     OR position('FOR SHARE' in v_src) = 0
     OR position('ts.left_at IS NULL' in v_src) = 0
     OR position('s.closed_at IS NULL' in v_src) = 0
     OR position('''instances_in_flight''' in v_src) = 0
     OR position('''instances_in_flight''' in v_src) > position('FOR UPDATE' in v_src)
     OR position('LIGHTNING_REVERSION_MOVED_MONEY' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back the locked live-row digest, the pre-lock poll and the kept halts', v_sig;
  END IF;
END
$sub_commit_mm$;

-- ===========================================================================
-- 6. fn_cash_cluster_commit_lightning: the hand boundary is polled before
--    the lock, exactly as the reversion's drain now is.
-- ===========================================================================
DO $sub_commit_l$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_commit_lightning(uuid,uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'not_found');
  END IF;
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE HAND BOUNDARY IS
  -- POLLED BEFORE THE LOCK. The tick asks this every pass while the member
  -- tables finish their hands, and the cheap not-ready answer does not need,
  -- and no longer takes, the Cluster row every formation, tick and conversion
  -- serialises on. The authoritative count below still runs under the lock.
  SELECT count(*)::integer INTO v_inflight
    FROM public.hand_state_snapshots h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.cluster_id = p_game_id
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND h.is_complete = false
     AND h.updated_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'not_found');
  END IF;
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('POLLED BEFORE THE LOCK' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('POLLED BEFORE THE LOCK' in v_src) = 0
     OR position('''hands_in_flight''' in v_src) = 0
     OR position('''hands_in_flight''' in v_src) > position('FOR UPDATE' in v_src) THEN
    RAISE EXCEPTION '% does not read back polling the hand boundary before the lock', v_sig;
  END IF;
END
$sub_commit_l$;

-- ===========================================================================
-- 7. fn_lightning_instance_releases_its_reservations: a hand that never
--    dealt gives back its blind credit, on the one door every abandon path
--    crosses.
-- ===========================================================================
DO $sub_release$
DECLARE
  v_sig constant text := 'public.fn_lightning_instance_releases_its_reservations()';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  RETURN NULL;
END
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): A HAND THAT NEVER DEALT
  -- GIVES BACK ITS BLIND CREDIT. fn_lightning_form_hand counts bb, sb and the
  -- positions into lightning_blind_ledger at formation; a formation voided
  -- before begin_dealing ever ran posted nothing, and a credit it kept made
  -- fn_lightning_blind_order skip its player for a blind they never paid -
  -- "never double-charge, never lose a blind", broken in the second half.
  -- Reversed here, on the one door every abandon path crosses (the drain's
  -- void, the reaper, begin_dealing's own refusal, the unfreeze), exactly
  -- once - this trigger fires only on the transition into a terminal state -
  -- and floored at zero. Formation touches no debt field, so none needs
  -- restoring. An instance that started dealing keeps its counts: its blinds
  -- were posted at the felt. No is_horse here: a horse's credit reverses
  -- exactly as a human's (Law 10.5).
  IF NEW.state = 'abandoned' AND NEW.started_at IS NULL AND NEW.hand_id IS NOT NULL THEN
    UPDATE public.lightning_blind_ledger bl
       SET bb_count   = GREATEST(bl.bb_count  - d.bb,  0),
           sb_count   = GREATEST(bl.sb_count  - d.sb,  0),
           btn_count  = GREATEST(bl.btn_count - d.btn, 0),
           utg_count  = GREATEST(bl.utg_count - d.utg, 0),
           hj_count   = GREATEST(bl.hj_count  - d.hj,  0),
           co_count   = GREATEST(bl.co_count  - d.co,  0),
           updated_at = clock_timestamp()
      FROM (SELECT hp.player_id,
                   (coalesce(hp.blind_role, 'none') = 'bb')::integer AS bb,
                   (coalesce(hp.blind_role, 'none') = 'sb')::integer AS sb,
                   (coalesce(hp."position", '') = 'btn')::integer AS btn,
                   (coalesce(hp."position", '') = 'utg')::integer AS utg,
                   (coalesce(hp."position", '') = 'hj')::integer  AS hj,
                   (coalesce(hp."position", '') = 'co')::integer  AS co
              FROM public.lightning_hand_player hp
             WHERE hp.hand_id = NEW.hand_id) d
     WHERE bl.cluster_id = NEW.cluster_id AND bl.player_id = d.player_id;
  END IF;
  RETURN NULL;
END
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('GREATEST(bl.bb_count' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('GREATEST(bl.bb_count' in v_src) = 0
     OR position('NEW.started_at IS NULL' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back reversing a never-dealt hand''s blind credit', v_sig;
  END IF;
END
$sub_release$;

-- ===========================================================================
-- 8. fn_lightning_config: pending_off_dwell_ms is a named, validated key.
-- ===========================================================================
DO $sub_config$
DECLARE
  v_sig constant text := 'public.fn_lightning_config(uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_prune    integer;
$a$,
$a$  r := public.fn_lightning_config_number(v_cfg, 'cluster_row_wait_ms', 200, 10, 2000, true);
  v_row_wait := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$a$,
$a$    'cluster_row_wait_ms', v_row_wait,
$a$];
  b text[] := ARRAY[
$b$  v_prune    integer;
  v_dwell    integer;
$b$,
$b$  r := public.fn_lightning_config_number(v_cfg, 'cluster_row_wait_ms', 200, 10, 2000, true);
  v_row_wait := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- 20261007222717: how long the OFF condition must stand before a
  -- population-triggered PENDING_OFF opens (0 disables the dwell; a disabled
  -- Cluster or game always drains at once).
  r := public.fn_lightning_config_number(v_cfg, 'pending_off_dwell_ms', 10000, 0, 3600000, true);
  v_dwell := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$b$,
$b$    'cluster_row_wait_ms', v_row_wait,
    'pending_off_dwell_ms', v_dwell,
$b$];
  c integer[] := ARRAY[1, 1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''pending_off_dwell_ms''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF (length(v_src) - length(replace(v_src, '''pending_off_dwell_ms''', ''))) / length('''pending_off_dwell_ms''') <> 2 THEN
    RAISE EXCEPTION '% does not read back the dwell key and its value', v_sig;
  END IF;
END
$sub_config$;

-- ===========================================================================
-- 9. fn_cash_cluster_lightning_drive: a pass that does not see the OFF
--    condition clears the dwell sighting.
-- ===========================================================================
DO $sub_drive$
DECLARE
  v_sig constant text := 'public.fn_cash_cluster_lightning_drive(uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok OR NOT v_live_ok THEN
      v_action := 'begin_pending_off';
      v_res := public.fn_cash_cluster_begin_pending_off(g.id,
        md5(format('lightning-drive:%s:%s:must_move:%s', g.id, g.cluster_epoch, v_n))::uuid,
        'fn_cash_cluster_lightning_drive');
    ELSE
      v_action := 'hold';
    END IF;
$a$];
  b text[] := ARRAY[
$b$  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok OR NOT v_live_ok THEN
      v_action := 'begin_pending_off';
      v_res := public.fn_cash_cluster_begin_pending_off(g.id,
        md5(format('lightning-drive:%s:%s:must_move:%s', g.id, g.cluster_epoch, v_n))::uuid,
        'fn_cash_cluster_lightning_drive');
    ELSE
      v_action := 'hold';
      -- 20261007222717: THE DWELL SIGHTING IS CONSECUTIVE-PASS STATE. A pass
      -- that does not see the OFF condition clears the first sighting, so an
      -- oscillating population never accumulates one.
      UPDATE public.cash_games cg SET lightning_off_condition_since = NULL
       WHERE cg.id = g.id AND cg.lightning_off_condition_since IS NOT NULL;
    END IF;
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('lightning_off_condition_since' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('lightning_off_condition_since = NULL' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back clearing the dwell sighting', v_sig;
  END IF;
END
$sub_drive$;

-- ===========================================================================
-- THE READBACK.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the unfreeze closes its conversions', (SELECT s ~ 'abort_reason = ''cluster_unfrozen''' AND s ~ 'dealing_halt_observed_at = NULL'
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) AS s) q)),
    ('the reaper aborts an orphan', (SELECT s ~ '''orphaned_by_'' \|\|' AND s ~ '''lightning_pending_off_reaped'''
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure) AS s) q)),
    ('both begins answer an open conversion', (SELECT bool_and(pg_get_functiondef(f::regprocedure) ~ '''conversion_already_open''')
       FROM unnest(ARRAY['public.fn_cash_cluster_begin_pending_on(uuid,uuid)',
                         'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)']) f)),
    ('the dwell', (SELECT s ~ '''off_condition_dwell''' AND s ~ '''pending_off_dwell_ms'''
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure) AS s) q)),
    ('the locked live-row digest and the kept halts', (SELECT s ~ 'FOR SHARE' AND s ~ '''halts_kept_game_disabled'''
       AND position('''instances_in_flight''' in s) < position('FOR UPDATE' in s)
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure) AS s) q)),
    ('the pre-lock hand poll', (SELECT position('''hands_in_flight''' in s) > 0 AND position('''hands_in_flight''' in s) < position('FOR UPDATE' in s)
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure) AS s) q)),
    ('the blind credit reversal', (SELECT s ~ 'GREATEST\(bl\.bb_count' AND s ~ 'NEW\.started_at IS NULL'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure) AS s) q)),
    ('the config key', (SELECT pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure) ~ '''pending_off_dwell_ms''')),
    ('the drive clears the sighting', (SELECT pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure) ~ 'lightning_off_condition_since = NULL')),
    ('the sighting column', (SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cash_games' AND column_name = 'lightning_off_condition_since'))),
    ('service_role doors kept', (SELECT bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p WHERE p.oid IN (
         'public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure,
         'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure,
         'public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure,
         'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure,
         'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure,
         'public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure,
         'public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_cash_cluster_unfreeze', 'fn_cash_cluster_reap_stuck_conversions',
                           'fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_begin_pending_off',
                           'fn_cash_cluster_commit_must_move', 'fn_cash_cluster_commit_lightning',
                           'fn_cash_cluster_lightning_drive', 'fn_lightning_instance_releases_its_reservations',
                           'fn_lightning_config')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_7_REMEDIATION_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
