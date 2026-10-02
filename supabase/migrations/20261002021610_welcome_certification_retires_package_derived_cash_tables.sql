-- 20261002021610_welcome_certification_retires_package_derived_cash_tables
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 02:16:10 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- A cash cluster may materialize another empty table between the welcome
-- package assertion and certification cleanup.  That table is not unrelated
-- club data: its authoritative lineage is tables.cluster_id -> the exact
-- package cash_games row.  The old preparer recognized only the nine initial
-- table ids and therefore leaked an otherwise-unused production fixture after
-- a transient deadlock let the cluster controller finish its insert.
--
-- Keep the cleanup door as narrow as before.  It still accepts only the
-- reserved certification identity and exact welcome-v1 shape, refuses every
-- unrelated game, and refuses any activity.  It now locks the package games,
-- derives the complete table set from their cluster ids, proves the initial
-- tables are included, locks every derived table, and removes that whole empty
-- graph in the same transaction as the long-standing retirement door.
--
-- @live-proof: (SELECT p.prosrc LIKE '%t.cluster_id=ANY(v_cash)%' AND p.prosrc LIKE '%v_initial_tables <@ v_tables%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES(
  'fn_ca_prepare_unused_welcome_certification_fixture','approved',
  'Service-role-only exact certification-fixture cleanup. After proving the reserved identity, exact unused welcome-v1 graph and exact untouched BBJ/Spin seed balances, it journals those two seed balances to chip_retirement, removes idle package-derived cash tables, and hands the empty club to the existing certification retirement door in the same transaction.'
)
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_cash uuid[] := '{}';
  v_initial_tables uuid[] := '{}';
  v_tables uuid[] := '{}';
  v_schedules uuid[] := '{}';
  v_item_count integer := 0;
  v_bbj_seed numeric := 0;
  v_spin_seed numeric := 0;
  v_child_retired numeric := 0;
  v_bbj_count integer := 0;
  v_spin_count integer := 0;
  v_changed integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  -- Read identity first, but do not take the club lock before the cluster
  -- parents.  The cash controller locks a cash game and then needs the club FK
  -- key-share when it opens a table; reversing that order caused the production
  -- certificate deadlock this migration repairs.
  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture');
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

  PERFORM 1
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id
   ORDER BY slot_key
   FOR UPDATE;

  SELECT count(*),
         COALESCE(array_agg(entity_id ORDER BY entity_id) FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(initial_table_id ORDER BY initial_table_id) FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(entity_id ORDER BY entity_id) FILTER(WHERE entity_kind='tournament_schedule'),'{}')
    INTO v_item_count,v_cash,v_initial_tables,v_schedules
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND retired_at IS NULL;

  IF v_item_count<>10 OR cardinality(v_cash)<>9 OR cardinality(v_initial_tables)<>9
     OR cardinality(v_schedules)<>1
     OR NOT EXISTS(SELECT 1 FROM public.club_welcome_package_receipts r
                   WHERE r.club_id=p_club_id AND r.package_version='welcome-v1')
     OR (SELECT count(*) FROM public.club_welcome_package_funding f
         WHERE f.club_id=p_club_id AND f.destination IN('bbj_main','spin_reserve'))<>2
     OR EXISTS(SELECT 1 FROM public.club_welcome_reset_receipts r WHERE r.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.club_welcome_package_items i
               WHERE i.club_id=p_club_id AND i.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_PACKAGE_SHAPE_REFUSED' USING ERRCODE='55000';
  END IF;

  -- Match the reset/fence order: package item -> schedule -> cash game ->
  -- table -> club.  Quiescing under the parent locks prevents new derived rows
  -- from appearing after the complete graph is enumerated.
  PERFORM 1 FROM public.tournament_schedules
   WHERE id=ANY(v_schedules)
   ORDER BY id
   FOR UPDATE;
  PERFORM 1 FROM public.cash_games
   WHERE id=ANY(v_cash)
   ORDER BY id
   FOR UPDATE;
  IF (SELECT count(*) FROM public.cash_games WHERE id=ANY(v_cash))<>9
     OR (SELECT count(*) FROM public.tournament_schedules WHERE id=ANY(v_schedules))<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_PHYSICAL_GRAPH_REFUSED' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.game_management_retention','on',true);
  UPDATE public.tournament_schedules SET active=false,updated_at=now()
   WHERE id=ANY(v_schedules);
  UPDATE public.cash_games SET enabled=false,state='dormant',updated_at=now()
   WHERE id=ANY(v_cash);

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('prepared',false,'reason','already_gone');
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
  IF (SELECT count(*) FROM public.club_members m WHERE m.club_id=p_club_id) <> 1
     OR EXISTS (
       SELECT 1 FROM public.club_members m
       WHERE m.club_id=p_club_id
         AND (m.user_id IS DISTINCT FROM v_club.owner_id
           OR COALESCE(m.chip_balance,0)<>0 OR COALESCE(m.promo_balance,0)<>0)
     )
     OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_MEMBER_OR_AGENT_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}')
    INTO v_tables
    FROM public.tables t
   WHERE t.club_id=p_club_id AND t.cluster_id=ANY(v_cash);

  IF NOT (v_initial_tables <@ v_tables)
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id AND NOT(g.id=ANY(v_cash)))
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s
               WHERE s.club_id=p_club_id AND NOT(s.id=ANY(v_schedules)))
     OR EXISTS(SELECT 1 FROM public.tables t
               WHERE t.club_id=p_club_id
                 AND (t.cluster_id IS NULL OR NOT(t.cluster_id=ANY(v_cash))))
     OR EXISTS(SELECT 1 FROM public.tables t
               WHERE t.cluster_id=ANY(v_cash)
                 AND (t.club_id IS DISTINCT FROM p_club_id
                   OR t.union_id IS NOT NULL OR t.tournament_id IS NOT NULL
                   OR t.game_type IS DISTINCT FROM 'cash'
                   OR (NOT(t.id=ANY(v_initial_tables)) AND (
                     (t.created_by IS NOT NULL AND t.created_by IS DISTINCT FROM v_club.owner_id)
                     OR t.role IS NULL OR t.role NOT IN('main','feeder')
                     OR t.lifecycle IS NULL
                     OR t.lifecycle NOT IN('opening','live','breaking','closed')
                     OR (t.role='main' AND (t.main_index IS NULL OR t.main_index<1))
                     OR (t.role='feeder' AND t.main_index IS NOT NULL)
                   )))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tables
   WHERE id=ANY(v_tables)
   ORDER BY id
   FOR UPDATE;

  IF EXISTS(SELECT 1 FROM public.tables t WHERE t.id=ANY(v_tables)
            AND COALESCE(t.current_players,0)<>0)
     OR EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_sessions s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.engine_table_leases l WHERE l.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_waitlist w WHERE w.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_change_requests r WHERE r.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_game_roster r WHERE r.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.table_pending_addons a WHERE a.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.club_id=p_club_id OR t.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s WHERE s.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.managed_game_schedules s
               WHERE s.game_kind='table' AND s.game_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.cash_cluster_events e
               WHERE e.game_id=ANY(v_cash) AND e.table_id IS NOT NULL
                 AND NOT(e.table_id=ANY(v_tables))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(sum(f.amount) FILTER(WHERE f.destination='bbj_main'),0),
         COALESCE(sum(f.amount) FILTER(WHERE f.destination='spin_reserve'),0)
    INTO v_bbj_seed,v_spin_seed
    FROM public.club_welcome_package_funding f WHERE f.club_id=p_club_id;
  PERFORM 1 FROM public.bbj_pools b WHERE b.club_id=p_club_id ORDER BY b.id FOR UPDATE;
  PERFORM 1 FROM public.spin_bonus_pools s WHERE s.club_id=p_club_id ORDER BY s.club_id FOR UPDATE;
  SELECT count(*) INTO v_bbj_count FROM public.bbj_pools b
   WHERE b.club_id=p_club_id AND COALESCE(b.main_balance,0)=v_bbj_seed
     AND COALESCE(b.backup_balance,0)=0 AND COALESCE(b.promo_balance,0)=0
     AND COALESCE(b.pool_amount,0)=0
     AND COALESCE(b.hands_contributed,0)=0 AND COALESCE(b.total_contributed,0)=0
     AND COALESCE(b.total_paid_out,0)=0 AND COALESCE(b.hit_count,0)=0
     AND NOT EXISTS(SELECT 1 FROM public.bbj_contributions c WHERE c.pool_id=b.id)
     AND NOT EXISTS(SELECT 1 FROM public.bbj_payouts p WHERE p.pool_id=b.id);
  SELECT count(*) INTO v_spin_count FROM public.spin_bonus_pools s
   WHERE s.club_id=p_club_id AND COALESCE(s.balance,0)=v_spin_seed
     AND COALESCE(s.seeded_amount,0)=v_spin_seed
     AND s.seed_source_wallet='chip_treasury' AND s.owner_kind='club'
     AND COALESCE(s.offered_max_stake,0)=1 AND COALESCE(s.highest_stake,0)=1
     AND COALESCE(s.total_deposited,0)=0 AND COALESCE(s.total_drawn,0)=0
     AND COALESCE(s.spin_count,0)=0 AND COALESCE(s.bonus_count,0)=0
     AND COALESCE(s.surplus_returned,0)=0
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id)=2
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id AND l.kind='seed'
             AND l.amount=v_spin_seed AND l.balance_after=v_spin_seed)=1
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id AND l.kind='activation'
             AND l.amount=0 AND l.balance_after=v_spin_seed)=1;
  IF v_bbj_seed<=0 OR v_spin_seed<=0 OR v_bbj_count<>1 OR v_spin_count<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SEED_CUSTODY_REFUSED' USING ERRCODE='55000';
  END IF;

  -- Burn the two seeded child stores before their parent club can cascade them
  -- away.  Each balance delta is auto-journaled to chip_retirement; the old
  -- retirement door then burns the remaining club stores.
  PERFORM public.fn_ca_declare_ledger('burn','chip_retirement',NULL,NULL,
    'cert-retire-bbj:'||p_club_id::text,NULL);
  UPDATE public.bbj_pools SET main_balance=0,updated_at=now()
   WHERE club_id=p_club_id AND main_balance=v_bbj_seed;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BBJ_RETIREMENT_REFUSED' USING ERRCODE='55000';
  END IF;
  PERFORM public.fn_ca_declare_ledger('burn','chip_retirement',NULL,NULL,
    'cert-retire-spin:'||p_club_id::text,NULL);
  UPDATE public.spin_bonus_pools SET balance=0
   WHERE club_id=p_club_id AND balance=v_spin_seed;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SPIN_RETIREMENT_REFUSED' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.spin_reserve_ledger(club_id,kind,amount,balance_after,note)
  VALUES(p_club_id,'adjustment',-v_spin_seed,0,
    'Reserved Create Club certification seed retired to chip_retirement');
  v_child_retired:=round(v_bbj_seed+v_spin_seed,2);

  PERFORM set_config('app.managed_game_lifecycle','on',true);
  DELETE FROM public.cash_cluster_events WHERE game_id=ANY(v_cash);
  DELETE FROM public.tables WHERE id=ANY(v_tables);
  DELETE FROM public.cash_games WHERE id=ANY(v_cash);
  DELETE FROM public.tournament_schedules WHERE id=ANY(v_schedules);
  DELETE FROM public.club_welcome_package_funding WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_items WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_reset_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_entitlements WHERE club_id=p_club_id;
  DELETE FROM public.club_owner_creation_history
   WHERE owner_id=v_club.owner_id AND first_club_id=p_club_id
     AND welcome_eligible AND provenance='prospective';

  IF EXISTS(SELECT 1 FROM public.tables t WHERE t.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s WHERE s.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_PREPARATION_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'cash_games_removed',cardinality(v_cash),'tables_removed',cardinality(v_tables),
    'initial_tables_removed',cardinality(v_initial_tables),
    'schedules_removed',cardinality(v_schedules),
    'child_chips_retired',v_child_retired);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_prepared jsonb;
  v_retired jsonb;
  v_child numeric := 0;
BEGIN
  v_prepared:=public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id);
  v_child:=COALESCE((v_prepared->>'child_chips_retired')::numeric,0);
  v_retired:=public.fn_ca_retire_certification_club(p_club_id,p_reason);
  IF COALESCE((v_prepared->>'prepared')::boolean,false)
     AND NOT COALESCE((v_retired->>'success')::boolean,false) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_RETIREMENT_REFUSED: %',
      COALESCE(v_retired->>'error','unknown') USING ERRCODE='55000';
  END IF;
  IF COALESCE((v_retired->>'success')::boolean,false) AND NOT COALESCE((v_retired->>'already_gone')::boolean,false) THEN
    v_retired:=jsonb_set(v_retired,'{chips_retired}',
      to_jsonb(round(COALESCE((v_retired->>'chips_retired')::numeric,0)+v_child,2)),true);
    v_retired:=v_retired||jsonb_build_object('child_chips_retired',v_child);
  END IF;
  RETURN v_retired;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  TO service_role;

DO $assert$
DECLARE v_body text;
BEGIN
  SELECT p.prosrc INTO v_body
    FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure;
  IF v_body NOT LIKE '%t.cluster_id=ANY(v_cash)%'
     OR v_body NOT LIKE '%v_initial_tables <@ v_tables%'
     OR v_body NOT LIKE '%WHERE id=ANY(v_tables)%'
     OR v_body NOT LIKE '%cert-retire-bbj:%'
     OR v_body NOT LIKE '%cert-retire-spin:%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: certification cleanup does not own the full package-derived cash table graph';
  END IF;
END $assert$;

COMMIT;
