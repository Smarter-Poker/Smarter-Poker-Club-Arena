-- 20261002102542_welcome_certification_retires_stale_board_tournament_leases
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 10:25:42 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- 20261002102542_welcome_certification_retires_stale_board_tournament_leases
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 10:25:42 UTC.
--
-- A reserved Create Club certificate can be interrupted after its exact
-- welcome-board tournaments have been created.  Older engine generations can
-- leave a tournament fencing row behind even though the board has no player,
-- seat, hand, wallet, registration, payout, schedule execution, or game
-- activity.  The existing fail-closed retirement correctly refuses that row,
-- but then the next certificate cannot retire its own abandoned identity.
--
-- This migration adds a narrow preflight in the same retirement transaction.
-- It recognizes only the protected reserved-certificate identity and exact
-- welcome board allowlist, holds the board-creation advisory fence, refuses
-- table-scoped leases, locks tournament leases without waiting, retains fresh,
-- malformed, legacy, or F06-custody leases, and deletes only protocol-v2 rows
-- whose acquisition and heartbeat are both at least ten minutes old.  The
-- existing board helper then revalidates every lineage and activity guard.  If
-- that later proof refuses, the lease deletion rolls back with the transaction.
-- Ordinary clubs, games, players, balances, and active leases are untouched.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_leases(
  p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_board_tournaments uuid[] := '{}';
  v_board_tables uuid[] := '{}';
  v_expected_count integer := 0;
  v_lease_count integer := 0;
  v_deleted integer := 0;
  v_cutoff timestamptz := clock_timestamp() - interval '10 minutes';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture',
      'tournament_leases_removed',0);
  END IF;
  SELECT u.email INTO v_owner_email FROM auth.users u WHERE u.id=v_club.owner_id;
  IF p_club_id=ANY(ARRAY[
       'a0000000-0000-0000-0000-000000000001'::uuid,
       'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
       '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
       'fade0000-0000-0000-0000-000000000001'::uuid
     ])
     OR (v_club.name NOT LIKE 'Crest Cert %' AND v_club.name NOT LIKE 'Preset Crest Cert %')
     OR NOT (
       COALESCE(v_owner_email,'') LIKE 'club-create-cert-%@smarter-poker.invalid'
       OR COALESCE(v_owner_email,'') LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
     )
     OR COALESCE(v_club.is_union,false)
     OR v_club.union_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.union_clubs u WHERE u.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED' USING ERRCODE='42501';
  END IF;

  -- The atomic seat-first creator holds the shared counterpart.  This lock is
  -- transaction-scoped, so it remains held through the existing full cleanup.
  PERFORM pg_advisory_xact_lock(530090,1);

  WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  )
  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}'),count(DISTINCT t.name)
    INTO v_board_tournaments,v_expected_count
    FROM public.tournaments t JOIN expected e
      ON t.name=e.name AND upper(COALESCE(t.game_type,''))=e.game_type
     AND lower(COALESCE(t.variant,''))=e.variant
     AND upper(COALESCE(t.tournament_type,''))=e.tournament_type
     AND t.buy_in_amount=e.buy_in_amount AND t.buy_in_fee=e.buy_in_fee
     AND t.max_players=e.seats AND t.min_players=e.seats AND t.table_size=e.seats
     AND t.starting_chips=e.stack
   WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
     AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
     AND t.satellite_target IS NULL
     AND upper(COALESCE(t.status,''))='REGISTERING'
     AND t.current_players=0 AND t.started_at IS NULL AND t.ended_at IS NULL
     AND COALESCE(t.created_at,'infinity'::timestamptz)<=v_cutoff
     AND COALESCE(t.updated_at,'infinity'::timestamptz)<=v_cutoff;

  IF cardinality(v_board_tournaments)=0 THEN
    RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
      'tournament_leases_removed',0);
  END IF;
  IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
  PERFORM 1 FROM public.tables t
   WHERE t.tournament_id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}') INTO v_board_tables
    FROM public.tables t WHERE t.tournament_id=ANY(v_board_tournaments);
  IF cardinality(v_board_tables)<>cardinality(v_board_tournaments)
     OR EXISTS(SELECT 1 FROM public.tables t
                JOIN public.tournaments g ON g.id=t.tournament_id
               WHERE t.tournament_id=ANY(v_board_tournaments)
                 AND (t.club_id IS DISTINCT FROM p_club_id
                   OR t.union_id IS NOT NULL OR t.cluster_id IS NOT NULL
                   OR t.game_type IS DISTINCT FROM 'tournament'
                   OR t.name IS DISTINCT FROM g.name
                   OR lower(COALESCE(t.status,''))<>'waiting'
                   OR t.current_players IS DISTINCT FROM 0
                   OR t.is_deleted IS DISTINCT FROM false
                   OR t.max_players IS DISTINCT FROM g.max_players
                   OR COALESCE(t.created_at,'infinity'::timestamptz)>v_cutoff
                   OR COALESCE(t.updated_at,'infinity'::timestamptz)>v_cutoff)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_TABLE_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  -- Tournament-backed tables must never carry cash-table authority.
  IF EXISTS(SELECT 1 FROM public.engine_table_leases l
             WHERE l.table_id=ANY(v_board_tables)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_UNEXPECTED_TABLE_LEASE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  -- A claimant takes lease -> parent locks.  We already hold the parents, so
  -- NOWAIT avoids reversing that order and turns any overlap into a refusal.
  BEGIN
    PERFORM l.tournament_id FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
     ORDER BY l.tournament_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED'
      USING ERRCODE='55000';
  END;

  IF EXISTS(
    SELECT 1 FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
       AND (l.protocol_version IS DISTINCT FROM 2
         OR l.lease_generation IS NULL
         OR NULLIF(btrim(l.instance_id),'') IS NULL
         OR l.acquired_at IS NULL OR l.heartbeat_at IS NULL
         OR l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff)
  ) OR EXISTS(
    SELECT 1 FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
       AND smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL)
  ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_lease_count FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_board_tournaments);
  DELETE FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_board_tournaments)
     AND l.protocol_version=2 AND l.lease_generation IS NOT NULL
     AND NULLIF(btrim(l.instance_id),'') IS NOT NULL
     AND l.acquired_at<v_cutoff AND l.heartbeat_at<v_cutoff
     AND NOT smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL);
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  IF v_deleted<>v_lease_count
     OR EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                WHERE l.tournament_id=ANY(v_board_tournaments)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_RETIREMENT_INCOMPLETE'
      USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'tournament_leases_removed',v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_leases jsonb;
  v_board jsonb;
  v_schedule jsonb;
  v_prepared jsonb;
  v_retired jsonb;
  v_child numeric := 0;
BEGIN
  v_leases:=public.fn_ca_prepare_unused_welcome_certification_board_leases(p_club_id);
  v_board:=public.fn_ca_prepare_unused_welcome_certification_board_games(p_club_id);
  v_schedule:=public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(p_club_id);
  v_prepared:=public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id);
  v_child:=COALESCE((v_prepared->>'child_chips_retired')::numeric,0);
  v_retired:=public.fn_ca_retire_certification_club(p_club_id,p_reason);
  IF COALESCE((v_prepared->>'prepared')::boolean,false)
     AND NOT COALESCE((v_retired->>'success')::boolean,false) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_RETIREMENT_REFUSED: %',
      COALESCE(v_retired->>'error','unknown') USING ERRCODE='55000';
  END IF;
  IF COALESCE((v_retired->>'success')::boolean,false)
     AND NOT COALESCE((v_retired->>'already_gone')::boolean,false) THEN
    v_retired:=jsonb_set(v_retired,'{chips_retired}',
      to_jsonb(round(COALESCE((v_retired->>'chips_retired')::numeric,0)+v_child,2)),true);
    v_retired:=v_retired||jsonb_build_object('child_chips_retired',v_child,
      'board_tournament_leases_removed',COALESCE((v_leases->>'tournament_leases_removed')::integer,0),
      'board_tournaments_removed',COALESCE((v_board->>'tournaments_removed')::integer,0),
      'board_tables_removed',COALESCE((v_board->>'tables_removed')::integer,0),
      'schedule_tournaments_removed',COALESCE((v_schedule->>'tournaments_removed')::integer,0),
      'schedule_tables_removed',COALESCE((v_schedule->>'tables_removed')::integer,0));
  END IF;
  RETURN v_retired;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  TO service_role;

DO $assert$
DECLARE v_body text;
BEGIN
  SELECT p.prosrc INTO v_body FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure;
  IF v_body NOT LIKE '%pg_advisory_xact_lock(530090,1)%'
     OR v_body NOT LIKE '%FOR UPDATE NOWAIT%'
     OR v_body NOT LIKE '%f06_lease_has_pending_custody%'
     OR v_body NOT LIKE '%protocol_version IS DISTINCT FROM 2%'
     OR v_body NOT LIKE '%WELCOME_CERTIFICATION_BOARD_UNEXPECTED_TABLE_LEASE_REFUSED%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: reserved board lease retirement guards are not installed';
  END IF;
END
$assert$;

COMMIT;
