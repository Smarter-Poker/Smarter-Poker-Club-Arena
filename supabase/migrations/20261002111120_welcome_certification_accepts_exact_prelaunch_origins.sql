-- 20261002111120_welcome_certification_accepts_exact_prelaunch_origins
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 11:11:20 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- The real tournament-table classifier records one immutable `prelaunch`
-- provenance row whenever an exact welcome-board table is inserted while its
-- tournament is REGISTERING.  The certification cleanup's generic tournament
-- FK scan treated that required provenance as player/game activity, so a
-- crashed browser certificate could never retire its otherwise unused board.
-- The isolated welcome fixture omitted this production table and hid the gap.
--
-- This migration adds one service-only preflight before board removal.  It
-- accepts only reserved certification owners and the exact aged twelve-board
-- allowlist, locks the tournament/table parents and provenance rows, requires
-- exactly one matching prelaunch row per already-idle board table, and removes
-- those rows in the same retirement transaction.  Missing, extra, mismatched,
-- launch, capacity, or legacy provenance is refused.  The existing generic FK,
-- player, hand, wallet, registration, schedule, lease, and financial guards
-- then run unchanged; any later refusal rolls the provenance deletion back.
-- Ordinary clubs, tables, players, balances, and real tournament history are
-- never admitted by this door.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_origins(
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
  v_origin_count integer := 0;
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
      'origins_removed',0);
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
    RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,'origins_removed',0);
  END IF;
  IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
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
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables) ORDER BY o.table_id FOR UPDATE;
  SELECT count(*) INTO v_origin_count FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables);
  IF v_origin_count<>cardinality(v_board_tables)
     OR EXISTS(
       SELECT 1 FROM public.tables b
       LEFT JOIN public.tournament_table_origins o ON o.table_id=b.id
        WHERE b.id=ANY(v_board_tables)
          AND (o.table_id IS NULL
            OR o.tournament_id IS DISTINCT FROM b.tournament_id
            OR o.origin_kind IS DISTINCT FROM 'prelaunch'
            OR o.launch_id IS NOT NULL
            OR o.launch_lease_generation IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables)
     AND o.origin_kind='prelaunch'
     AND o.launch_id IS NULL AND o.launch_lease_generation IS NULL;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  IF v_deleted<>v_origin_count
     OR EXISTS(SELECT 1 FROM public.tournament_table_origins o
                WHERE o.table_id=ANY(v_board_tables)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_RETIREMENT_INCOMPLETE'
      USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'origins_removed',v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)
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
  v_origins jsonb;
  v_board jsonb;
  v_schedule jsonb;
  v_prepared jsonb;
  v_retired jsonb;
  v_child numeric := 0;
BEGIN
  v_leases:=public.fn_ca_prepare_unused_welcome_certification_board_leases(p_club_id);
  v_origins:=public.fn_ca_prepare_unused_welcome_certification_board_origins(p_club_id);
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
      'board_origins_removed',COALESCE((v_origins->>'origins_removed')::integer,0),
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
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure;
  IF v_body NOT LIKE '%pg_advisory_xact_lock(530090,1)%'
     OR v_body NOT LIKE '%origin_kind IS DISTINCT FROM ''prelaunch''%'
     OR v_body NOT LIKE '%launch_lease_generation IS NOT NULL%'
     OR v_body NOT LIKE '%DELETE FROM public.tournament_table_origins%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: reserved board origin retirement guards are not installed';
  END IF;
END
$assert$;

COMMIT;
