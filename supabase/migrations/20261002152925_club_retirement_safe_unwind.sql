-- 20261002152925_club_retirement_safe_unwind
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 15:29:25 UTC.
--
-- A retired club is a retained, immutable estate.  This closes the game and
-- scheduler relations added after the original retirement boundary and makes
-- the owner retirement door compose with the authoritative unused-welcome
-- unwind installed immediately before this migration.  The old door could
-- never retire a fresh club because its 100,000 opening issuance and welcome
-- BBJ/Spin seeds were correctly counted as unsettled value; it also omitted
-- later cash/schedule relations from both impact and the immutable-retired
-- trigger boundary.  The replacement burns only the single proven opening
-- grant after the package authority proves and reverses its exact unused
-- allocations, retains every real row/history receipt, extends lifecycle
-- guards and recipient invalidation, and refuses every played or drifted club.
-- Measured by scripts/ci/test-club-retirement-postgres.py on isolated PG17:
-- atomic pristine retirement, declared burn, retained records, retry, used
-- refusal/rollback, post-retirement freezes, schedule impact and writer race.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $precondition$
BEGIN
  IF to_regprocedure(
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_REQUIRES_20261002152207_WELCOME_UNWIND';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_WELCOME_UNWIND_MUST_REMAIN_PRIVATE';
  END IF;
END
$precondition$;

-- The original guard assumed every child had a direct club_id.  Schedules and
-- spawn/command rows do not.  Resolve their owning club and explicitly take a
-- parent key lock: several of these later tables intentionally have no club FK,
-- so an ordinary FK check cannot serialize them with retirement.
CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
      SELECT s.club_id INTO v_club_id FROM public.tournament_schedules s WHERE s.id = OLD.schedule_id;
    ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
      IF OLD.game_kind = 'table' THEN
        SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.game_id;
      ELSE
        SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = OLD.game_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
      IF OLD.host_kind = 'club' THEN v_club_id := OLD.host_id; END IF;
    ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.wheel_configs c
       WHERE c.host_id=OLD.host_id AND c.host_kind='club';
    ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.diamond_game_configs c
       WHERE c.host_id=OLD.host_id AND c.game=OLD.game AND c.host_kind='club';
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
      SELECT s.club_id INTO v_club_id FROM public.tournament_schedules s WHERE s.id = NEW.schedule_id;
    ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
      IF NEW.game_kind = 'table' THEN
        SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.game_id;
      ELSE
        SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = NEW.game_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
      IF NEW.host_kind = 'club' THEN v_club_id := NEW.host_id; END IF;
    ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.wheel_configs c
       WHERE c.host_id=NEW.host_id AND c.host_kind='club';
    ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.diamond_game_configs c
       WHERE c.host_id=NEW.host_id AND c.game=NEW.game AND c.host_kind='club';
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
        SELECT s.club_id INTO v_old_club_id FROM public.tournament_schedules s WHERE s.id = OLD.schedule_id;
      ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
        IF OLD.game_kind = 'table' THEN
          SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.game_id;
        ELSE
          SELECT t.club_id INTO v_old_club_id FROM public.tournaments t WHERE t.id = OLD.game_id;
        END IF;
      ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
        IF OLD.host_kind = 'club' THEN v_old_club_id := OLD.host_id; END IF;
      ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
        SELECT c.host_id INTO v_old_club_id FROM public.wheel_configs c
         WHERE c.host_id=OLD.host_id AND c.host_kind='club';
      ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
        SELECT c.host_id INTO v_old_club_id FROM public.diamond_game_configs c
         WHERE c.host_id=OLD.host_id AND c.game=OLD.game AND c.host_kind='club';
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || v_club_id::text, 0));
  END IF;

  -- Lock both scopes in UUID order.  A writer that began just before retirement
  -- waits here and then observes the committed retired lifecycle.
  PERFORM 1
    FROM public.clubs c
   WHERE c.id IN (v_club_id, v_old_club_id)
   ORDER BY c.id
   FOR KEY SHARE;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

DO $retired_write_triggers$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'cash_games', 'tournament_schedules', 'tournament_schedule_spawns',
    'managed_game_schedules', 'club_opening_checklists',
    'club_welcome_entitlements', 'club_welcome_package_items',
    'wheel_configs', 'wheel_pools', 'diamond_game_configs', 'diamond_game_pools'
  ]
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'CLUB_RETIREMENT_LIFECYCLE_RELATION_MISSING: %', v_table;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_retired_club_mutation ON public.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER trg_guard_retired_club_mutation '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation()',
      v_table
    );
  END LOOP;
END
$retired_write_triggers$;

-- Authorization helpers are used by direct RLS and SECURITY DEFINER game
-- writers.  Refusing retired clubs here prevents a stale owner/admin session
-- from reaching a later code path even before the row trigger is consulted.
CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_own uuid;
  v_member uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = p_club_id AND c.lifecycle_status = 'active'
  ) THEN RETURN false; END IF;

  SELECT own_union_id, member_union_id INTO v_own, v_member
    FROM public.fn_club_union_context(p_club_id);
  IF v_own IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_own AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = v_own AND a.user_id = p_user_id)
        OR public.fn_club_is_staff(p_club_id,p_user_id);
  END IF;
  IF v_member IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_member AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = v_member AND a.user_id = p_user_id);
  END IF;
  RETURN public.fn_club_is_staff(p_club_id,p_user_id);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_can_create_games(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_create_games(uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_can_manage_tournament_schedule(
  p_union_id uuid, p_club_id uuid, p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = p_club_id AND c.lifecycle_status = 'active'
  ) THEN RETURN false; END IF;
  IF p_union_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u WHERE u.id=p_union_id AND u.owner_id=p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins ua WHERE ua.union_id=p_union_id AND ua.user_id=p_user_id);
  END IF;
  RETURN public.is_club_admin(p_club_id,p_user_id);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_can_manage_tournament_schedule(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_tournament_schedule(uuid,uuid,uuid) TO authenticated, service_role;

-- Keep the original, already-audited account census intact and extend it with
-- the authoritative resources that were added later.
ALTER FUNCTION public.fn_club_retirement_impact(uuid)
  RENAME TO fn_club_retirement_impact_core_20260906;
REVOKE ALL ON FUNCTION public.fn_club_retirement_impact_core_20260906(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_retirement_impact_core_20260906(uuid) TO service_role;

CREATE FUNCTION public.fn_club_retirement_impact(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_cash_games bigint;
  v_schedules bigint;
  v_commands bigint;
  v_diamond_games bigint;
  v_reset jsonb;
  v_funding numeric;
  v_treasury numeric;
  v_opening_tx_count bigint;
  v_opening_mint_count bigint;
  v_pristine_welcome boolean := false;
BEGIN
  v_result := public.fn_club_retirement_impact_core_20260906(p_club_id);
  SELECT count(*) INTO v_cash_games FROM public.cash_games g
   WHERE g.club_id=p_club_id AND (g.enabled OR g.state <> 'dormant');
  SELECT count(*) INTO v_schedules FROM public.tournament_schedules s
   WHERE s.club_id=p_club_id AND s.active;
  SELECT count(*) INTO v_commands
    FROM public.managed_game_schedules ms
   WHERE ms.status IN ('scheduled','executing') AND (
     (ms.game_kind='table' AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id=ms.game_id AND t.club_id=p_club_id))
     OR (ms.game_kind='tournament' AND EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=ms.game_id AND t.club_id=p_club_id))
   );
  SELECT
      (SELECT count(*) FROM public.wheel_configs c
        WHERE c.host_kind='club' AND c.host_id=p_club_id AND c.enabled)
    + (SELECT count(*) FROM public.diamond_game_configs c
        WHERE c.host_kind='club' AND c.host_id=p_club_id AND c.enabled)
    INTO v_diamond_games;
  v_reset := public.fn_get_club_welcome_package_reset_impact(p_club_id);
  SELECT coalesce(c.chip_treasury,0) INTO v_treasury
    FROM public.clubs c WHERE c.id=p_club_id;
  SELECT coalesce(sum(f.amount),0) INTO v_funding
    FROM public.club_welcome_package_funding f
   WHERE f.club_id=p_club_id AND f.destination IN ('bbj_main','spin_reserve');
  SELECT count(*) INTO v_opening_tx_count
    FROM public.chip_transactions t
   WHERE t.club_id=p_club_id AND t.transaction_type='club_opening_grant'
     AND t.amount=100000 AND t.balance_after=100000
     AND t.metadata->>'mint_op_id'='club-opening-grant:'||p_club_id::text;
  SELECT count(*) INTO v_opening_mint_count
    FROM public.ca_mint_ledger m
   WHERE m.asset='chips' AND m.action='mint' AND m.holder_type='club'
     AND m.holder_id=p_club_id;
  v_pristine_welcome :=
    coalesce((v_reset->>'authorized')::boolean,false)
    AND coalesce((v_reset->>'can_reset')::boolean,false)
    AND coalesce((v_result->>'union_affiliated')::boolean,true) IS FALSE
    AND coalesce((v_result->>'wallet_chips')::numeric,-1)=100000
    AND coalesce((v_result->>'diamonds')::numeric,-1)=0
    AND coalesce((v_result->>'inventory_items')::bigint,-1)=0
    AND v_treasury=100000-v_funding
    AND v_funding=300
    AND v_opening_tx_count=1 AND v_opening_mint_count=1
    AND EXISTS (
      SELECT 1 FROM public.ca_mint_ledger m
       WHERE m.op_id='club-opening-grant:'||p_club_id::text
         AND m.asset='chips' AND m.action='mint' AND m.holder_type='club'
         AND m.holder_id=p_club_id AND m.amount=100000
         AND m.balance_before=0 AND m.balance_after=100000
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.cash_games g
       WHERE g.club_id=p_club_id AND (g.enabled OR g.state<>'dormant')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
           coalesce(v_reset->'cash_game_ids','[]'::jsonb)) x WHERE x.value=g.id::text)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tournament_schedules s
       WHERE s.club_id=p_club_id AND s.active
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
           coalesce(v_reset->'schedule_ids','[]'::jsonb)) x WHERE x.value=s.id::text)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.club_id=p_club_id
         AND lower(coalesce(t.status::text,'')) NOT IN ('completed','cancelled','canceled')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
           coalesce(v_reset->'tournament_ids','[]'::jsonb)) x WHERE x.value=t.id::text)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.managed_game_schedules ms
       WHERE ms.status IN ('scheduled','executing') AND (
         (ms.game_kind='table' AND EXISTS (
           SELECT 1 FROM public.tables t
            WHERE t.id=ms.game_id AND t.club_id=p_club_id
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                coalesce(v_reset->'cash_game_ids','[]'::jsonb)) x
                 WHERE x.value=t.cluster_id::text)))
         OR (ms.game_kind='tournament' AND EXISTS (
           SELECT 1 FROM public.tournaments t
            WHERE t.id=ms.game_id AND t.club_id=p_club_id
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                coalesce(v_reset->'tournament_ids','[]'::jsonb)) x
                 WHERE x.value=t.id::text)))
       )
    );
  RETURN v_result || jsonb_build_object(
    'active_cash_games',v_cash_games,
    'active_tournament_schedules',v_schedules,
    'pending_managed_commands',v_commands,
    'active_diamond_games',v_diamond_games,
    'pristine_welcome_retire_available',v_pristine_welcome,
    'open_obligations',coalesce((v_result->>'open_obligations')::bigint,0)
      + v_cash_games + v_schedules + v_commands + v_diamond_games
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_retirement_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_retirement_impact(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_deletion_impact(p_club_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_club_retirement_impact(p_club_id)
$function$;
REVOKE ALL ON FUNCTION public.fn_club_deletion_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_deletion_impact(uuid) TO authenticated, service_role;

-- The owner-facing door may now retire a truly unused opening grant.  It does
-- not zero an arbitrary balance: the welcome authority must first prove and
-- unwind its own pristine allocations, and the exact one-time Mint issuance
-- must still be the club's only remaining chip custody.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES (
  'fn_retire_settled_club','approved',
  'Owner-only retained-record retirement. For a pristine new club only, composes with the authoritative welcome unwind and journals the exact 100,000 opening grant to chip_retirement; otherwise requires the established zero-impact settlement boundary.'
) ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

ALTER FUNCTION public.fn_retire_settled_club(uuid,text,text)
  RENAME TO fn_retire_settled_club_core_20260906;
REVOKE ALL ON FUNCTION public.fn_retire_settled_club_core_20260906(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retire_settled_club_core_20260906(uuid,text,text)
  TO service_role;

CREATE FUNCTION public.fn_retire_settled_club(
  p_club_id uuid,
  p_confirm_name text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '15s'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_unwind jsonb;
  v_impact jsonb;
  v_result jsonb;
  v_operation_id uuid := gen_random_uuid();
  v_opening_tx_count bigint;
  v_opening_mint_count bigint;
  v_recipient uuid;
  v_opening_retired boolean := false;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Authentication Required');
  END IF;
  IF p_club_id IS NULL OR nullif(btrim(coalesce(p_confirm_name,'')),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Confirm The Club Name');
  END IF;
  IF length(coalesce(p_reason,'')) > 500 THEN
    RETURN jsonb_build_object('success',false,'error','Retirement Reason Is Too Long');
  END IF;

  -- Global settlement lane precedes every club/resource row lock.  The welcome
  -- unwind takes the same lane, so its nested call is re-entrant and cannot
  -- invert G -> club/resource ordering against another money authority.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
  SELECT * INTO v_club FROM public.clubs c WHERE c.id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Club Not Found'); END IF;
  IF v_club.owner_id IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success',false,'error','Only The Club Owner Can Retire This Club');
  END IF;
  IF btrim(p_confirm_name) IS DISTINCT FROM btrim(v_club.name) THEN
    RETURN jsonb_build_object('success',false,'error','The Club Name Confirmation Does Not Match');
  END IF;
  IF v_club.lifecycle_status='retired' THEN
    RETURN jsonb_build_object('success',true,'already_retired',true,'club_id',p_club_id,
      'retired_at',v_club.retired_at);
  END IF;

  PERFORM 1 FROM public.unions u WHERE u.id=p_club_id FOR UPDATE;
  PERFORM 1 FROM public.union_clubs uc
   WHERE uc.club_id=p_club_id OR uc.union_id=p_club_id ORDER BY uc.id FOR UPDATE;
  IF v_club.union_id IS NOT NULL
     OR coalesce((to_jsonb(v_club)->>'is_union')::boolean,false)
     OR EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.union_clubs uc
                WHERE uc.club_id=p_club_id OR uc.union_id=p_club_id) THEN
    RETURN jsonb_build_object('success',false,
      'error','Leave The Union Or Retire The Union Estate Through Union Administration First');
  END IF;

  -- This service-only helper performs its own exact no-play/economic proof and
  -- returns all opening BBJ/Spin principal to treasury.  Any refusal aborts the
  -- same transaction; no partial reset or retirement can commit.
  BEGIN
    v_unwind := public.fn_unwind_unused_first_club_welcome_package(p_club_id,v_operation_id);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RETURN jsonb_build_object('success',false,
      'error','This Club Has Welcome Games, Registrations Or Economics That Must Be Settled First',
      'welcome_unwind',jsonb_build_object('ok',false,'reason',SQLERRM));
  END;
  IF coalesce((v_unwind->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('success',false,'error','The Welcome Package Is Not Safe To Unwind',
      'welcome_unwind',v_unwind);
  END IF;
  SELECT * INTO v_club FROM public.clubs c WHERE c.id=p_club_id FOR UPDATE;

  PERFORM 1 FROM public.cash_games WHERE club_id=p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournament_schedules WHERE club_id=p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournament_schedule_spawns sp
    JOIN public.tournament_schedules s ON s.id=sp.schedule_id
   WHERE s.club_id=p_club_id ORDER BY sp.id FOR UPDATE OF sp;
  PERFORM 1 FROM public.managed_game_schedules ms
   WHERE (ms.game_kind='table' AND EXISTS (
           SELECT 1 FROM public.tables t WHERE t.id=ms.game_id AND t.club_id=p_club_id))
      OR (ms.game_kind='tournament' AND EXISTS (
           SELECT 1 FROM public.tournaments t WHERE t.id=ms.game_id AND t.club_id=p_club_id))
   ORDER BY ms.schedule_id FOR UPDATE OF ms;

  v_impact := public.fn_club_retirement_impact(p_club_id);
  IF coalesce((v_impact->>'active_cash_games')::bigint,0)<>0
     OR coalesce((v_impact->>'active_tournament_schedules')::bigint,0)<>0
     OR coalesce((v_impact->>'pending_managed_commands')::bigint,0)<>0
     OR coalesce((v_impact->>'active_diamond_games')::bigint,0)<>0 THEN
    RETURN jsonb_build_object('success',false,
      'error','Disable Every Cash Game, Tournament Schedule, Diamond Game And Pending Game Command First',
      'impact',v_impact);
  END IF;

  -- Only the exact untouched new-club issuance is automatically retired.
  -- Every other estate still follows the original explicit settlement flow.
  IF coalesce((v_impact->>'wallet_chips')::numeric,0)=100000
     AND coalesce((v_impact->>'running_tables')::bigint,0)=0
     AND coalesce((v_impact->>'active_tournaments')::bigint,0)=0
     AND coalesce((v_impact->>'diamonds')::numeric,0)=0
     AND coalesce((v_impact->>'inventory_items')::bigint,0)=0
     AND coalesce((v_impact->>'open_obligations')::bigint,0)=0
     AND v_club.chip_treasury=100000
     AND coalesce(v_club.chip_pool,0)=0
     AND coalesce(v_club.promo_balance,0)=0
     AND coalesce(v_club.insurance_balance,0)=0 THEN
    SELECT count(*) INTO v_opening_tx_count
      FROM public.chip_transactions t
     WHERE t.club_id=p_club_id AND t.transaction_type='club_opening_grant'
       AND t.amount=100000 AND t.balance_after=100000
       AND t.metadata->>'mint_op_id'='club-opening-grant:'||p_club_id::text;
    SELECT count(*) INTO v_opening_mint_count
      FROM public.ca_mint_ledger m
     WHERE m.asset='chips' AND m.action='mint' AND m.holder_type='club'
       AND m.holder_id=p_club_id;
    IF v_opening_tx_count<>1 OR v_opening_mint_count<>1 OR NOT EXISTS (
      SELECT 1 FROM public.ca_mint_ledger m
       WHERE m.op_id='club-opening-grant:'||p_club_id::text
         AND m.asset='chips' AND m.action='mint' AND m.holder_type='club'
         AND m.holder_id=p_club_id AND m.amount=100000
         AND m.balance_before=0 AND m.balance_after=100000
    ) THEN
      RETURN jsonb_build_object('success',false,
        'error','The Club Bank Is Not The Exact Untouched Opening Grant','impact',v_impact);
    END IF;

    PERFORM public.fn_ca_declare_ledger('burn','chip_retirement',NULL,NULL,
      'club-owner-retire-opening:'||p_club_id::text,NULL);
    UPDATE public.clubs SET chip_treasury=0,updated_at=clock_timestamp()
     WHERE id=p_club_id AND chip_treasury=100000;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CLUB_OPENING_GRANT_CHANGED_DURING_RETIREMENT' USING ERRCODE='40001';
    END IF;
    PERFORM set_config('app.ledger_category','',true);
    PERFORM set_config('app.ledger_counterparty','',true);
    v_club.chip_treasury := 0;
    v_opening_retired := true;
  END IF;

  -- The original retained-record authority rechecks every balance and
  -- obligation, writes the audit trail, and flips lifecycle atomically.
  v_result := public.fn_retire_settled_club_core_20260906(
    p_club_id,p_confirm_name,p_reason
  );

  -- The scope event written by the core becomes unreadable once creation
  -- authority closes.  Recipient events remain visible long enough for every
  -- signed-in member surface to invalidate immediately.
  IF coalesce((v_result->>'success')::boolean,false)
     AND coalesce((v_result->>'already_retired')::boolean,false) IS FALSE THEN
    FOR v_recipient IN
      SELECT v_club.owner_id
      UNION
      SELECT cm.user_id FROM public.club_members cm WHERE cm.club_id=p_club_id
    LOOP
      PERFORM public.fn_emit_game_management_event(
        'club_identity_changed',p_club_id,NULL,v_recipient,'club',p_club_id,NULL,
        jsonb_build_object('operation','retire','lifecycle_status','retired','records_retained',true)
      );
    END LOOP;
  END IF;
  RETURN v_result || jsonb_build_object(
    'welcome_unwind',v_unwind,
    'opening_grant_retired',v_opening_retired
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_retire_settled_club(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_retire_settled_club(uuid,text,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_retire_settled_club(uuid,text,text) IS
  'Owner-only retained-record retirement. Atomically unwinds an exact unused welcome package and exact untouched 100,000 opening grant, or requires the established fully settled estate. Never physically deletes a real club.';

-- Fail installation if a later authoritative club resource was left outside
-- the lifecycle boundary or if a browser role acquired a private subroutine.
DO $assert$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'cash_games','tournament_schedules','tournament_schedule_spawns',
    'managed_game_schedules','club_opening_checklists',
    'club_welcome_entitlements','club_welcome_package_items',
    'wheel_configs','wheel_pools','diamond_game_configs','diamond_game_pools'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid=to_regclass('public.'||v_table)
         AND t.tgname='trg_guard_retired_club_mutation' AND NOT t.tgisinternal
         AND t.tgenabled<>'D'
    ) THEN RAISE EXCEPTION 'CLUB_RETIREMENT_TRIGGER_MISSING: %',v_table; END IF;
  END LOOP;
  IF has_function_privilege('authenticated',
       'public.fn_retire_settled_club_core_20260906(uuid,text,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_club_retirement_impact_core_20260906(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_PRIVATE_CORE_EXPOSED';
  END IF;
END
$assert$;

COMMIT;
