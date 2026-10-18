-- 20261018194141_retirement_locks_club_memberships_by_their_user_key.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The installed private retirement core locks club_members by an id column
-- which does not exist. Order those same locked membership rows by user_id.
-- This is the sole function-body change; every financial and history guard stays.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Preserve authority, zero custody and immutable history; only lock ordering changes.
-- @live-proof: (SELECT p.prosrc LIKE '%public.club_members WHERE club_id = p_club_id ORDER BY user_id FOR UPDATE%' FROM pg_proc p WHERE p.oid='public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='5s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure)) <> 'a283c2b2e30e3651886004dabf308098' THEN
  RAISE EXCEPTION 'CLUB_RETIREMENT_CORE_SOURCE_DRIFT';
 END IF;
END $pre$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES('fn_retire_settled_club_core_20260906','approved','Private retained-record retirement authority. Lock canonical club_members user_id key; retain owner, zero-custody and history guards.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE OR REPLACE FUNCTION public.fn_retire_settled_club_core_20260906(p_club_id uuid, p_confirm_name text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_impact jsonb;
  v_reason text;
  v_retired_at timestamptz;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_club_id IS NULL OR nullif(btrim(coalesce(p_confirm_name, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Confirm The Club Name');
  END IF;
  IF length(coalesce(p_reason, '')) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Retirement Reason Is Too Long');
  END IF;
  v_reason := coalesce(nullif(btrim(p_reason), ''), 'Owner Requested Retirement');

  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || p_club_id::text, 0));
  SELECT * INTO v_club FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;
  IF v_club.owner_id IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only The Club Owner Can Retire This Club');
  END IF;
  IF btrim(p_confirm_name) IS DISTINCT FROM btrim(v_club.name) THEN
    RETURN jsonb_build_object('success', false, 'error', 'The Club Name Confirmation Does Not Match');
  END IF;

  -- Lost-response retry: still owner/name authorised, but no second audit/event.
  IF v_club.lifecycle_status = 'retired' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_retired', true, 'club_id', p_club_id,
      'retired_at', v_club.retired_at
    );
  END IF;

  -- Canonical union resolution uses all three representations. Live estates
  -- have disagreed between the pointer and junction table before, so neither is
  -- accepted as a substitute for the others.
  PERFORM 1 FROM public.unions u WHERE u.id = p_club_id FOR UPDATE;
  PERFORM 1 FROM public.union_clubs uc
   WHERE uc.club_id = p_club_id OR uc.union_id = p_club_id
   ORDER BY uc.id FOR UPDATE;
  IF v_club.union_id IS NOT NULL
     OR coalesce((to_jsonb(v_club) ->> 'is_union')::boolean, false)
     OR EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_club_id)
     OR EXISTS (SELECT 1 FROM public.union_clubs uc
                 WHERE uc.club_id = p_club_id OR uc.union_id = p_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Leave The Union Or Retire The Union Estate Through Union Administration First'
    );
  END IF;

  -- Lock parents before their dependent rows, matching game registration/seat
  -- writer order. The club FOR UPDATE also makes a new FK child wait; after this
  -- transaction commits, the retired-row trigger refuses that waiting writer.
  PERFORM 1 FROM public.tables WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id ORDER BY ts.id FOR UPDATE OF ts;
  PERFORM 1 FROM public.tournaments WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_escrow te
    JOIN public.tournaments tr ON tr.id = te.tournament_id
   WHERE tr.club_id = p_club_id ORDER BY te.tournament_id FOR UPDATE OF te;
  PERFORM 1
    FROM public.tournament_players tp
    JOIN public.tournaments tr ON tr.id = tp.tournament_id
   WHERE tr.club_id = p_club_id ORDER BY tp.id FOR UPDATE OF tp;
  PERFORM 1 FROM public.club_members WHERE club_id = p_club_id ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.agents WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.club_diamond_wallets WHERE club_id = p_club_id FOR UPDATE;
  PERFORM 1 FROM public.bbj_pools WHERE club_id = p_club_id FOR UPDATE;
  PERFORM 1 FROM public.spin_bonus_pools WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.club_opening_setups WHERE club_id = p_club_id FOR UPDATE;
  PERFORM 1 FROM public.promo_vault_inventory
   WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cashout_requests WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.chip_requests WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.chip_escrow_holds WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournament_tickets WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.settlement_periods WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
  PERFORM 1
    FROM public.credit_invoices ci JOIN public.agents a ON a.id = ci.agent_id
   WHERE a.club_id = p_club_id ORDER BY ci.id FOR UPDATE OF ci;
  PERFORM 1
    FROM public.chip_escrow ce
    JOIN public.cashout_requests cr ON cr.id = ce.cashout_request_id
   WHERE cr.club_id = p_club_id ORDER BY ce.id FOR UPDATE OF ce;

  v_impact := public.fn_club_retirement_impact(p_club_id);
  IF coalesce((v_impact ->> 'running_tables')::bigint, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Close Every Running Table Before Retiring This Club', 'impact', v_impact);
  END IF;
  IF coalesce((v_impact ->> 'active_tournaments')::bigint, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Complete Or Cancel Every Tournament Before Retiring This Club', 'impact', v_impact);
  END IF;
  IF coalesce((v_impact ->> 'wallet_chips')::numeric, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Settle Every Club, Member, Agent, Pool, Seat, Escrow And Ticket Balance First', 'impact', v_impact);
  END IF;
  IF coalesce((v_impact ->> 'diamonds')::numeric, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Redeem Or Transfer Every Club And Member Diamond Balance First', 'impact', v_impact);
  END IF;
  IF coalesce((v_impact ->> 'inventory_items')::bigint, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Grant Or Resolve Every Promo Vault Inventory Item First', 'impact', v_impact);
  END IF;
  IF coalesce((v_impact ->> 'open_obligations')::bigint, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve Every Open Game, Cashier, Credit And Settlement Obligation First', 'impact', v_impact);
  END IF;

  v_retired_at := clock_timestamp();
  PERFORM set_config('app.club_retirement_write', 'on', true);
  UPDATE public.clubs
     SET lifecycle_status = 'retired',
         retired_at = v_retired_at,
         retired_by = v_me,
         retirement_reason = v_reason,
         is_public = false,
         requires_approval = true,
         updated_at = v_retired_at
   WHERE id = p_club_id AND lifecycle_status = 'active';
  PERFORM set_config('app.club_retirement_write', '', true);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'club lifecycle changed during retirement' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.audit_trail(
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason
  ) VALUES (
    v_me, 'owner', 'retire_club', 'club', p_club_id, p_club_id,
    jsonb_build_object(
      'lifecycle_status', v_club.lifecycle_status,
      'is_public', v_club.is_public,
      'requires_approval', v_club.requires_approval
    ),
    jsonb_build_object(
      'lifecycle_status', 'retired',
      'retired_at', v_retired_at,
      'records_retained', true,
      'is_public', false,
      'requires_approval', true
    ),
    v_reason
  );

  PERFORM public.fn_emit_game_management_event(
    'club_identity_changed', p_club_id, NULL, NULL, 'club', p_club_id, NULL,
    jsonb_build_object(
      'operation', 'retire', 'lifecycle_status', 'retired',
      'records_retained', true
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'already_retired', false, 'club_id', p_club_id,
    'retired_at', v_retired_at, 'records_retained', true
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_retire_settled_club_core_20260906(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retire_settled_club_core_20260906(uuid,text,text) TO service_role;
COMMIT;
