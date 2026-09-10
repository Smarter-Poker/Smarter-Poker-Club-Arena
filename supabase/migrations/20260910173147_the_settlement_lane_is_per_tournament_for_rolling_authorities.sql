-- 20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SETTLEMENT LANE IS PER TOURNAMENT FOR ROLLING AUTHORITIES.
--
-- WHAT WAS WRONG (measured on production 2026-09-10)
--
-- 20260910035245 (#4135) gave every rolling tournament money authority a
-- per-tournament key, T(id) = 'ca:tournament-terminal-settlement:v1:'||id,
-- but took it only AFTER the platform-wide key G =
-- 'ca:tournament-terminal-settlement:v1' in EXCLUSIVE mode, and an
-- xact advisory lock is held to commit. So every seat purchase, horse
-- registration, rebuy, unregistration, bounty collection, seat move and
-- per-tournament bounty sweep on the platform still ran one at a time.
-- 80 quarter-second samples of G at 08:09 UTC: held in 89% of them, a queue
-- in 78.8%, 2.55 waiters on average, 5 at peak, longest single wait 6.6 s;
-- dozens of "still waiting for ExclusiveLock on advisory lock
-- [5,4265093629,1253463894,1] after 10000 ms"; PostgREST calls cancelled by
-- lock_timeout on G. Since 02:34 UTC pg_stat_statements has
-- fn_seat_horse_in_seat_first_game at 47,473 calls, 571 ms mean, 20.2 s max,
-- almost all of it queueing. Because every entry door also holds the
-- maintenance boundary pg_advisory_xact_lock_shared(530090,1) for its whole
-- transaction, the same queue slowed the :53 break announcement, which takes
-- that boundary exclusively (docs/changelog/
-- 2026-09-10-the-maintenance-break-gate-opens-again.md, "The next thing").
--
-- G could not simply be dropped from the rolling path: three trigger guards
-- read "this backend holds G in ExclusiveLock mode" out of pg_locks as their
-- proof of authority, and would have refused every live seat, every ticket
-- admission and every payout marker a rolling authority writes.
--
-- WHAT THIS CHANGES
--
-- Keys, modes and order. Order is unchanged everywhere: G -> B -> T ->
-- atomic-table -> rows, every lane at the top of its function, no upgrades.
--
--                          G (platform)   B (hands)   T(id) (one event)
--   rolling authority      SHARED         -           EXCLUSIVE    <- was G EXCLUSIVE
--   terminal / rare        EXCLUSIVE      EXCLUSIVE   -            (unchanged)
--   hand settlement        -              SHARED      SHARED       (unchanged)
--   move receipt resolver  SHARED         -           SHARED       <- was G EXCLUSIVE
--
-- * Rolling authorities of DIFFERENT tournaments no longer wait for each
--   other. Two of the SAME tournament still serialise on T(id). A terminal
--   authority (G exclusive) still excludes every rolling authority, and any
--   rolling authority still excludes every terminal one. A hand still waits
--   only for its own tournament's rolling authority (T shared vs exclusive)
--   and for terminal authorities (B), exactly as before.
-- * When no tournament can be resolved, the rolling helper still takes the
--   whole lane (G exclusive, then B exclusive), as it always has.
--
-- 1. fn_ca_lock_settlement_lane_for_tournament: resolves the tournament first
--    (tables.tournament_id is fixed for the life of a table), then G SHARED,
--    then T(id) EXCLUSIVE.
--
-- 2. The three guards accept either exclusive hold as proof: T(the tournament
--    the row belongs to) - the rolling lane - or G - a terminal authority.
--    A SHARED hold of either key proves nothing (hand settlements hold T
--    shared, rolling authorities hold G shared). Everything else in each
--    guard is unchanged, byte for byte.
--      fn_tournament_live_seat_acquisition_requires_authority  row: the
--        seat's table's tournament.
--      fn_satellite_target_player_provenance_is_immutable      row: the
--        TARGET registration (NEW/OLD.tournament_id). Its canonical writers
--        are ticket admission and the pre-start ticket return (rolling
--        authorities of the target: T(target)) and satellite delivery and
--        the ticket-return authority (terminal: G). No canonical writer
--        holds T(source) in place of T(target), so T(source) is not proof.
--        Holding G shared, an admission still waits for the source
--        satellite's terminal settlement, so the committed-receipt read the
--        guard makes stays stable.
--      fn_tournament_payouts_are_append_only                   row: the
--        payout's tournament; the exact terminal marker transition is still
--        required on top of the proof.
--
-- 3. fn_ca_open_tournament_seat_exit_authority took G exclusive directly. Its
--    one caller, fn_move_tournament_player, now holds G only SHARED, so that
--    request became an upgrade: it waits for every rolling authority on the
--    platform while holding T(id), and two moves in two tournaments deadlock
--    on it. Everything it locks and writes belongs to one tournament, so it
--    takes that tournament's lane - free inside the move (already held), and
--    granted at once under a terminal caller (G and B exclusive exclude
--    every other holder of T).
--
-- 4. fn_resolve_committed_tournament_seat_move took G exclusive to wait for
--    the writer of one move. The writer holds T(id) exclusively through
--    commit, so G SHARED then T(id) SHARED waits for exactly that writer and
--    for terminal authorities, and no longer makes the tournament's hands
--    (T shared) or every other authority queue behind a read-only lookup.
--
-- 5. fn_mystery_bounty_pay took the GLOBAL lane only because it is keyed by
--    award id, not tournament id. Everything it locks is one tournament's
--    (tournament, obligations, chests, awards, recipients) plus the
--    recipients' wallets in user_id order - the shape of fn_collect_bounty,
--    already rolling. It was also called from inside the per-tournament
--    bounty sweep, where G shared -> G exclusive is an upgrade that deadlocks
--    against the same tournament's seat purchases queued on T(id) while
--    holding G shared (and, before this migration, the same sweep deadlocked
--    against that tournament's hands on B). It now resolves the award's
--    tournament and takes that tournament's lane; an award not found yet
--    takes the whole lane (the helper's NULL fallback), so a not-found answer
--    is still given only after any in-flight writer committed. 974 direct
--    engine calls since 02:34 UTC each blocked every hand on the platform.
--
-- 6. fn_lock_daily_mission_user locks the profile FOR NO KEY UPDATE instead of
--    FOR UPDATE. Every seat purchase takes it first ('daily-missions-user:'
--    advisory lock, then the profile row) and the player's wallet and table
--    cap after it. Every refund, bounty credit, add-on, seat move and cash
--    buy-in takes the wallet or table cap first and then inserts a row that
--    references the profile - and a foreign-key check takes FOR KEY SHARE,
--    which conflicts with FOR UPDATE and with nothing weaker. That is a cycle
--    through profiles. With the lane serialising rolling authorities it could
--    only close against paths outside the lane, and production logged it
--    ("while locking tuple ... in relation profiles ... FOR KEY SHARE",
--    cash buy-in against tournament registration of the same horse); with
--    rolling authorities of different tournaments now concurrent it would
--    close between them too. FOR NO KEY UPDATE still excludes every writer
--    and every other holder of this lock and still blocks a delete; it no
--    longer blocks foreign-key checks. None of its callers reads a table
--    that references profiles.
--
-- 7. fn_ca_release_unseatable_registrant_at_launch took the tournament and its
--    launch receipt FOR UPDATE before entering the lane (inside the
--    unregistration core). A seat purchase for the same event takes the lane
--    first and the receipt and tournament rows after it. It now takes the
--    lane first; the core re-enters it for free.
--
-- CROSS-TOURNAMENT PATHS. No transaction takes T for two tournaments except
-- under G exclusive (the tournament-less bounty sweep, which takes the whole
-- lane and then collects many events; with G and B exclusive held no other
-- transaction can hold any T). Satellite award, delivery and ticket return
-- are terminal (G exclusive). Ticket admission and unregistration are rolling
-- authorities of the target alone and touch the source satellite only through
-- the provenance guard's FOR SHARE read, taken target -> source.
--
-- The postcondition block below re-proves the call graph on the live catalog:
-- no function that takes the rolling lane reaches one that takes the global
-- lane, no attached trigger reaches any lane, and only the two lane helpers
-- take G exclusively. The precondition block refuses to run if any function
-- this migration replaces, or the two lane helpers it relies on, changed since
-- it was reviewed, or if a new function started taking the lane.
--
-- Proof: the precondition block refuses to run unless every replaced body is
-- byte-identical (md5) to the one reviewed, and the postcondition block
-- re-proves the lock graph on the live catalog inside this transaction.
-- Live verification after apply (pg_locks sampling of G, guard refusals,
-- deadlock counter, seat and registration throughput) is in the changelog.
-- Rollback (restores every definition this replaces, byte for byte):
--   docs/changelog/2026-09-10-the-settlement-lane-is-per-tournament-for-authorities.rollback.sql
-- Changelog:
--   docs/changelog/2026-09-10-the-settlement-lane-is-per-tournament-for-authorities.md
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS: the board is the board that was reviewed.
-- ---------------------------------------------------------------------------
DO $lane_pre$
DECLARE
  -- md5(prosrc) of every body this migration replaces, captured from
  -- production on 2026-09-10 17:00 UTC, plus the two lane helpers it reads.
  v_expected CONSTANT jsonb := jsonb_build_object(
    'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
      '2bc939035496d764ff9d6c14b52fa1e7',
    'public.fn_tournament_live_seat_acquisition_requires_authority()',
      '7a50958787ad79ffbb8b9f175f1d90a7',
    'public.fn_satellite_target_player_provenance_is_immutable()',
      'cbe5f2c1f5947a8b1d2f85de5c1abe0d',
    'public.fn_tournament_payouts_are_append_only()',
      'aa6bdc037c8d59e6648ef0c3ad9ad768',
    'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
      '25cf8792d0d7b4ebf1d383072ca2834c',
    'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
      '37bc550ccb878c042773d0789c8ef355',
    'public.fn_mystery_bounty_pay(uuid)',
      '335119d8c4c0b023955dbb003826e1da',
    'public.fn_lock_daily_mission_user(uuid)',
      '23b5a637e3c5bdbda3ac3c5441063910',
    'public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)',
      'b71c0b00371653983a48f3b412d44b24',
    'public.fn_ca_lock_settlement_lane_global()',
      '343015440ea5c84ee4ca7ae583c73d30',
    'public.fn_ca_share_settlement_lane_for_table(uuid)',
      '006d78a441e65d000d1d78929649bb44');
  v_sig text;
  v_md5 text;
  v_live text;
  v_set text;
BEGIN
  FOR v_sig, v_md5 IN SELECT key, value #>> '{}' FROM jsonb_each(v_expected) LOOP
    SELECT md5(p.prosrc) INTO v_live
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_live IS NULL THEN
      RAISE EXCEPTION 'settlement lane migration refused: % does not exist', v_sig;
    END IF;
    IF v_live <> v_md5 THEN
      RAISE EXCEPTION
        'settlement lane migration refused: % changed since review (md5 %, reviewed %)',
        v_sig, v_live, v_md5;
    END IF;
  END LOOP;

  -- Every function that names G. A new one is a new authority nobody has
  -- classified as rolling or terminal: refuse and make someone look.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%ca:tournament-terminal-settlement:v1%';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global,'
     'fn_ca_open_tournament_seat_exit_authority,fn_ca_share_settlement_lane_for_table,'
     'fn_resolve_committed_tournament_seat_move,'
     'fn_satellite_target_player_provenance_is_immutable,'
     'fn_tournament_live_seat_acquisition_requires_authority,'
     'fn_tournament_payouts_are_append_only' THEN
    RAISE EXCEPTION
      'settlement lane migration refused: the functions naming G changed: %', v_set;
  END IF;

  -- Every rolling authority. A new one must be read for writes that the
  -- guards used to wave through on G (rows of another tournament) before it
  -- is allowed to run beside the others.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname <> 'fn_ca_lock_settlement_lane_for_tournament'
     AND strpos(p.prosrc, 'fn_ca_lock_settlement_lane_for_tournament(') > 0;
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_tournament_seat_acquisition,'
     'fn_ca_register_for_tournament_with_ticket_for,'
     'fn_ca_unregister_tournament_player_exact,fn_collect_bounty,'
     'fn_move_tournament_player,fn_mystery_bounty_reserve,'
     'fn_register_horse_for_tournament_before_terminal_gate,'
     'fn_sweep_pending_tournament_bounties,process_tournament_rebuy' THEN
    RAISE EXCEPTION
      'settlement lane migration refused: the rolling authorities changed: %', v_set;
  END IF;

  -- The three guards are wired where this migration assumes.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g
       WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
         AND ((g.tgrelid = 'public.table_seats'::regclass
               AND g.tgname = 'a0_tournament_live_seat_root_guard'
               AND g.tgfoid = 'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure)
           OR (g.tgrelid = 'public.tournament_players'::regclass
               AND g.tgname = 'satellite_target_player_provenance_is_immutable'
               AND g.tgfoid = 'public.fn_satellite_target_player_provenance_is_immutable()'::regprocedure)
           OR (g.tgrelid = 'public.tournament_payouts'::regclass
               AND g.tgname = 'trg_tournament_payouts_append_only'
               AND g.tgfoid = 'public.fn_tournament_payouts_are_append_only()'::regprocedure))) <> 3 THEN
    RAISE EXCEPTION 'settlement lane migration refused: a guard trigger is missing or disabled';
  END IF;
END;
$lane_pre$;

-- ---------------------------------------------------------------------------
-- 1. The rolling lane: G SHARED, then T(id) EXCLUSIVE.
-- ---------------------------------------------------------------------------
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
$function$;

-- ---------------------------------------------------------------------------
-- 2. The guards: T(the row's tournament) or G, held EXCLUSIVELY, is proof.
-- ---------------------------------------------------------------------------
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
  v_tournament_key bigint;
  v_owns_authority boolean;
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

  -- Proof of authority (2026-09-10): this backend holds, exclusively, either
  -- T(the seat's tournament) - that tournament's rolling lane - or G - a
  -- terminal authority. A shared hold of either key proves nothing: hand
  -- settlements hold T shared and rolling authorities hold G shared.
  v_tournament_key:=hashtextextended(
    'ca:tournament-terminal-settlement:v1:'||v_tournament_id::text,0);
  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND ((l.classid=(((v_key>>32)&4294967295)::oid)
             AND l.objid=((v_key&4294967295)::oid))
         OR (l.classid=(((v_tournament_key>>32)&4294967295)::oid)
             AND l.objid=((v_tournament_key&4294967295)::oid)))
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_authority;
  IF NOT COALESCE(v_owns_authority,false) THEN
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
$function$;

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
  v_target_key bigint;
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
  -- source satellite has closed. Both are authorities of the TARGET event,
  -- the row's own tournament, and hold its lane: T(target) exclusively for
  -- the rolling admission and unregistration doors, G exclusively for the
  -- terminal satellite delivery and ticket-return authorities. Either
  -- exclusive hold is the proof (2026-09-10); a shared hold of either key is
  -- not, and no canonical writer holds T(source) in place of T(target).
  -- Holding G shared, an admission still waits for the source satellite's
  -- terminal settlement, so the committed-receipt read below stays stable.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    v_target_key:=hashtextextended(
      'ca:tournament-terminal-settlement:v1:'||(CASE WHEN TG_OP='INSERT'
        THEN NEW.tournament_id ELSE OLD.tournament_id END)::text,0);
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND ((l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
               AND l.objid=((v_acquisition_key&4294967295)::oid))
           OR (l.classid=(((v_target_key>>32)&4294967295)::oid)
               AND l.objid=((v_target_key&4294967295)::oid)))
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_key bigint := hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_tournament_key bigint;
  v_owns_terminal_root boolean := false;
BEGIN
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') =
         'i_am_correcting_the_record' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    -- Proof of authority (2026-09-10): G held exclusively - a terminal
    -- authority - or T(this payout's tournament) held exclusively - that
    -- tournament's rolling authority. A shared hold of either key proves
    -- nothing. The exact terminal marker transition is required either way.
    v_tournament_key := hashtextextended(
      'ca:tournament-terminal-settlement:v1:' || OLD.tournament_id::text,0);
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid = pg_backend_pid()
         AND l.locktype = 'advisory'
         AND l.database = (
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname = current_database())
         AND ((l.classid = (((v_terminal_key >> 32) & 4294967295)::oid)
               AND l.objid = ((v_terminal_key & 4294967295)::oid))
           OR (l.classid = (((v_tournament_key >> 32) & 4294967295)::oid)
               AND l.objid = ((v_tournament_key & 4294967295)::oid)))
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
$function$;

-- ---------------------------------------------------------------------------
-- 3. The seat-exit authority takes its tournament's lane, not G exclusive.
--    Its one caller (fn_move_tournament_player) already holds that lane, so
--    this is a free re-entry instead of a G shared -> exclusive upgrade.
-- ---------------------------------------------------------------------------
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

  -- This tournament's lane (2026-09-10): G shared, T(id) exclusive. Every
  -- row below belongs to this one tournament. Re-entered free by a rolling
  -- caller; granted at once under a terminal caller (G and B exclusive).
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
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
$function$;
-- Unchanged grants, stated so the migration says them: owner only.
REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The committed-move resolver waits for the move's writer on T(id).
-- ---------------------------------------------------------------------------
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

  -- The writer (fn_move_tournament_player) holds this tournament's lane -
  -- G shared, T(id) exclusive - from before its first receipt read through
  -- commit. G shared then T(id) SHARED waits for exactly that writer and for
  -- terminal authorities (2026-09-10; this was G exclusive, which made every
  -- authority and hand on the platform queue behind a read-only lookup).
  -- An absent receipt is deliberately not converted into proof that no write
  -- can still begin later.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1:'||p_tournament_id::text,0));

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
$function$;

-- ---------------------------------------------------------------------------
-- 5. The mystery bounty payer takes its award's tournament lane, not the
--    whole platform's. Everything it locks belongs to that one tournament.
-- ---------------------------------------------------------------------------
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
  -- This award's tournament lane (2026-09-10). It used to take the GLOBAL
  -- lane - G and B exclusive - only because it is keyed by award id, so every
  -- call held every hand settlement on the platform, and inside the
  -- per-tournament bounty sweep it was a G shared -> exclusive upgrade. An
  -- award's tournament never changes, so read it, take that lane, and read it
  -- again under the lane. An award not found yet takes the whole lane (the
  -- helper's NULL branch), so a not-found answer is still only given after
  -- any in-flight writer has committed - exactly as before.
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(v_tournament_id);
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
$function$;
-- Unchanged grants, stated so the migration says them: the engine's
-- service identity and the owner, never a browser.
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 6. The Daily Missions player lock no longer blocks foreign-key checks.
--    FOR UPDATE conflicts with the FOR KEY SHARE every insert referencing
--    profiles takes; FOR NO KEY UPDATE still excludes every writer, every
--    other holder of this lock and a delete, and nothing weaker.
-- ---------------------------------------------------------------------------
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
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$;
-- Unchanged grants, stated so the migration says them: the engine's
-- service identity and the owner, never a browser.
REVOKE ALL ON FUNCTION public.fn_lock_daily_mission_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lock_daily_mission_user(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 7. The launch release takes the lane before the tournament and receipt
--    rows, in the same order a seat purchase for the same event takes them.
-- ---------------------------------------------------------------------------
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

  -- Lane first (2026-09-10). A seat purchase for this event takes the lane,
  -- then the launch receipt and the tournament row; taking those rows first
  -- and the lane inside the unregistration core was the opposite order. The
  -- core re-enters the lane for free.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);

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
$function$;
-- Unchanged grants, stated so the migration says them: engine only.
REVOKE ALL ON FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text) TO service_role;


-- ---------------------------------------------------------------------------
-- 8. POSTCONDITIONS on the live catalog, inside this transaction.
-- ---------------------------------------------------------------------------
DO $lane_post$
DECLARE
  v_set text;
  v_path text;
BEGIN
  -- Only the two lane helpers take G exclusively (the rolling helper only in
  -- its no-tournament branch).
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'pg_advisory_xact_lock\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global' THEN
    RAISE EXCEPTION 'settlement lane migration: G is taken exclusively by %', v_set;
  END IF;

  -- The rolling lane holds G shared.
  IF strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
              WHERE p.oid = 'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure),
            'pg_advisory_xact_lock_shared(') = 0 THEN
    RAISE EXCEPTION 'settlement lane migration: the rolling lane does not hold G shared';
  END IF;

  -- No rolling authority reaches the global lane (that would be a G shared
  -- -> exclusive upgrade). Walk name references four calls deep from every
  -- function that takes the rolling lane.
  WITH RECURSIVE fns AS (
    SELECT DISTINCT ON (p.proname) p.proname::text AS proname, p.prosrc
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
     ORDER BY p.proname, p.oid),
  globals AS (
    SELECT proname FROM fns
     WHERE strpos(prosrc, 'fn_ca_lock_settlement_lane_global(') > 0
       AND proname <> 'fn_ca_lock_settlement_lane_global'),
  edges AS (
    SELECT a.proname AS caller, b.proname AS callee
      FROM fns a JOIN fns b ON b.proname <> a.proname
       AND length(b.proname) > 6
       AND strpos(a.prosrc, b.proname || '(') > 0),
  walk(node, path, depth) AS (
    SELECT f.proname, f.proname, 0 FROM fns f
     WHERE (strpos(f.prosrc, 'fn_ca_lock_settlement_lane_for_tournament(') > 0
            OR strpos(f.prosrc, 'fn_ca_lock_tournament_seat_acquisition(') > 0)
       AND f.proname NOT IN ('fn_ca_lock_settlement_lane_for_tournament',
                             'fn_ca_lock_tournament_seat_acquisition')
       AND f.proname NOT IN (SELECT proname FROM globals)
    UNION ALL
    SELECT e.callee, w.path || ' > ' || e.callee, w.depth + 1
      FROM walk w JOIN edges e ON e.caller = w.node
     WHERE w.depth < 4 AND strpos(w.path, e.callee) = 0)
  SELECT path INTO v_path FROM walk
   WHERE depth > 0
     AND (node IN (SELECT proname FROM globals) OR node = 'fn_ca_lock_settlement_lane_global')
   LIMIT 1;
  IF v_path IS NOT NULL THEN
    RAISE EXCEPTION 'settlement lane migration: a rolling authority reaches the global lane: %', v_path;
  END IF;
END;
$lane_post$;

COMMIT;
