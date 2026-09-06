-- 20260906091646_cashier_requests_and_membership_deletes_are_server_owned.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A read-only production impersonation proved that the legacy permissive
-- `chip_requests_read` policy survived beside `cashier_chip_requests_read`.
-- PostgreSQL ORs permissive policies, so an agent could read a request from a
-- member outside that agent's downline even though the newer policy was right.
-- The observed row was visible to 46 unrelated agents, 18 unrelated sub-agents
-- and 3 unrelated super-agents. Both names are replaced with one canonical
-- policy: requester, named approver, or full-club cashier scope only.
--
-- Production also still granted authenticated clients DELETE on club_members
-- through `club_members_delete`. Deleting a balance-bearing member invokes the
-- deleted-row journal and burns the remaining wallet. Browser deletion is
-- therefore removed at BOTH gates. The staff workflow now marks a settled real
-- membership departed and preserves it; service_role DELETE remains available
-- only for sanctioned fixture/maintenance contracts.
--
-- This is deliberately one transaction. Every DDL statement fires Supabase's
-- schema-cache reload, and transaction coalescing prevents a reload per line.
--
-- ROLLBACK (emergency only): restore the prior policies and browser grants from
-- the migrations that introduced them. That rollback reopens both audited
-- findings and must not be used as an operational membership-removal path.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Chip-request visibility: one permissive SELECT policy, no legacy OR arm.
-- ---------------------------------------------------------------------------
ALTER TABLE public.chip_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chip_requests_read ON public.chip_requests;
DROP POLICY IF EXISTS cashier_chip_requests_read ON public.chip_requests;

CREATE POLICY cashier_chip_requests_read
  ON public.chip_requests
  FOR SELECT
  TO authenticated
  USING (
    requester_id = (SELECT auth.uid())
    OR approver_id = (SELECT auth.uid())
    OR public.fn_club_cashier_scope(club_id, (SELECT auth.uid())) = 'all'
  );

-- Supabase default privileges may leave direct grants on both the named roles
-- and PUBLIC. Remove every browser grant, then add back authenticated SELECT
-- only. Server functions are SECURITY DEFINER and do not depend on these grants.
REVOKE ALL PRIVILEGES ON TABLE public.chip_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.chip_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chip_requests TO service_role;

-- ---------------------------------------------------------------------------
-- Membership departure: server owned. A browser cannot conserve all wallet and
-- escrow accounts merely by deleting or directly rewriting the membership row.
-- ---------------------------------------------------------------------------
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_members_delete ON public.club_members;
REVOKE DELETE ON TABLE public.club_members FROM PUBLIC, anon, authenticated;
GRANT DELETE ON TABLE public.club_members TO service_role;

-- A real membership is never hard-deleted: its role/departure history is part
-- of the club's operating record. A separate lifecycle field is intentional:
-- clean replay begins with an enum status that cannot accept `left`, while live
-- deployments use a wider text vocabulary. `suspended` is the legacy access-
-- denying status; `membership_lifecycle_status` carries the durable meaning.
ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS membership_lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS departed_at timestamptz,
  ADD COLUMN IF NOT EXISTS departed_by uuid,
  ADD COLUMN IF NOT EXISTS departure_reason text;

DO $membership_lifecycle_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_members'::regclass
       AND conname = 'club_members_membership_lifecycle_check'
  ) THEN
    ALTER TABLE public.club_members
      ADD CONSTRAINT club_members_membership_lifecycle_check
      CHECK (membership_lifecycle_status IN ('active', 'departed')) NOT VALID;
  END IF;
END
$membership_lifecycle_constraint$;
ALTER TABLE public.club_members
  VALIDATE CONSTRAINT club_members_membership_lifecycle_check;

-- Preserve legacy soft-departures that predate the explicit lifecycle column.
UPDATE public.club_members
   SET membership_lifecycle_status = 'departed',
       is_active = false,
       departed_at = coalesce(departed_at, updated_at, now()),
       departure_reason = coalesce(departure_reason, 'Legacy Membership Departure')
 WHERE status::text = 'left'
   AND membership_lifecycle_status <> 'departed';

CREATE INDEX IF NOT EXISTS idx_club_members_active_lifecycle
  ON public.club_members(club_id, user_id)
  WHERE membership_lifecycle_status = 'active';

CREATE OR REPLACE FUNCTION public.fn_guard_membership_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allowed boolean := coalesce(
    current_setting('app.club_membership_lifecycle_write', true), ''
  ) IN ('depart', 'rejoin');
BEGIN
  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_DEPARTED: use the Join Club workflow to return'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.membership_lifecycle_status, NEW.departed_at, NEW.departed_by, NEW.departure_reason)
       IS DISTINCT FROM
     (OLD.membership_lifecycle_status, OLD.departed_at, OLD.departed_by, OLD.departure_reason)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_LIFECYCLE_REQUIRES_RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_club_members_guard_lifecycle_write ON public.club_members;
CREATE TRIGGER trg_club_members_guard_lifecycle_write
BEFORE UPDATE ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_membership_lifecycle_write();

-- Departure is allowed only after every balance and in-flight dependency has
-- been settled. The row lock is important: every cashier writer locks the same
-- club_members row, so a balance cannot arrive between this check and the state
-- transition. Agent rows are deliberately not cascaded here; the operator must
-- demote/settle that wallet through the existing hierarchy workflow first.
CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(
  p_club_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_owner uuid;
  v_caller_role text;
  v_target public.club_members%ROWTYPE;
  v_changed integer := 0;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose A Club Member');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || p_club_id::text, 0));

  SELECT c.owner_id INTO v_owner
    FROM public.clubs c
   WHERE c.id = p_club_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;

  -- Lock caller and target in deterministic order before reading authority.
  -- A concurrent demotion/suspension must finish before this decision, not
  -- revoke the caller one instruction after an unlocked authorization read.
  PERFORM 1 FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id IN (v_me, p_user_id)
   ORDER BY cm.user_id
   FOR UPDATE;

  SELECT cm.role INTO v_caller_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_me
     AND coalesce(cm.status::text, 'active') IN ('active', 'approved');

  IF v_me IS DISTINCT FROM v_owner
     AND coalesce(v_caller_role, '') NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only Club Staff Can Remove A Member');
  END IF;

  SELECT * INTO v_target
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id;

  -- A legacy deployment may already have physically removed the row. Staff
  -- authorization was checked before returning the idempotent result.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_departed', true, 'legacy_absent', true
    );
  END IF;

  IF v_target.membership_lifecycle_status = 'departed' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_departed', true, 'legacy_absent', false,
      'user_id', p_user_id, 'departed_at', v_target.departed_at
    );
  END IF;

  IF p_user_id = v_owner OR v_target.role IN ('owner', 'club_owner') THEN
    RETURN jsonb_build_object('success', false, 'error', 'The Club Owner Cannot Be Removed');
  END IF;
  IF v_target.role IN ('co_owner', 'admin', 'club_admin') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Demote Club Staff To Player Before Marking The Membership Departed'
    );
  END IF;

  IF abs(coalesce(v_target.chip_balance, 0))
       + abs(coalesce(v_target.held_chips, 0))
       + abs(coalesce(v_target.locked_chips, 0))
       + abs(coalesce(v_target.promo_balance, 0))
       + abs(coalesce(v_target.credit_used, 0))
       + abs(coalesce(v_target.diamonds, 0)) <> 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Settle Every Member Balance, Credit Line And Diamond Balance Before Removing Them'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Demote And Settle This Agent Wallet Before Removing The Membership'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id <> p_user_id
       AND cm.membership_lifecycle_status = 'active'
       AND (
         cm.agent_id IN (p_user_id, v_target.id)
         OR cm.parent_agent_id IN (p_user_id, v_target.id)
       )
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reassign This Member''s Downline Before Removing Them'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NULL
     FOR UPDATE OF ts
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Remove This Member From Live Tables First');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments tr ON tr.id = tp.tournament_id
     WHERE tr.club_id = p_club_id
       AND tp.user_id = p_user_id
       AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing')
     FOR UPDATE OF tp
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Settle This Member''s Tournament Entry First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashout_requests cr
     WHERE cr.club_id = p_club_id
       AND (cr.player_id = p_user_id OR cr.agent_id = p_user_id)
       AND cr.status IN ('pending', 'approved')
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Cashout Requests First');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.chip_escrow ce
      JOIN public.cashout_requests cr ON cr.id = ce.cashout_request_id
     WHERE cr.club_id = p_club_id
       AND ce.player_id = p_user_id
       AND ce.released_at IS NULL
     FOR UPDATE OF ce
  ) OR EXISTS (
    SELECT 1 FROM public.chip_escrow_holds h
     WHERE h.club_id = p_club_id
       AND h.user_id = p_user_id
       AND h.status = 'held'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Release This Member''s Escrow First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_tickets tt
     WHERE tt.club_id = p_club_id
       AND tt.holder_id = p_user_id
       AND tt.status = 'issued'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Open Tickets First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.chip_requests r
     WHERE r.club_id = p_club_id
       AND (r.requester_id = p_user_id OR r.approver_id = p_user_id)
       AND r.status = 'pending'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Chip Requests First');
  END IF;

  INSERT INTO public.audit_trail(
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason
  ) VALUES (
    v_me,
    CASE WHEN v_me = v_owner THEN 'owner'
         WHEN v_caller_role = 'co_owner' THEN 'co_owner'
         ELSE 'host' END,
    'depart_club_member', 'membership', v_target.id, p_club_id,
    jsonb_build_object(
      'user_id', v_target.user_id, 'role', v_target.role,
      'status', v_target.status::text,
      'membership_lifecycle_status', v_target.membership_lifecycle_status
    ),
    jsonb_build_object(
      'departed', true, 'status', 'suspended', 'is_active', false,
      'membership_lifecycle_status', 'departed',
      'user_id', v_target.user_id
    ),
    'Settled Membership Departure'
  );

  PERFORM set_config('app.club_membership_lifecycle_write', 'depart', true);
  UPDATE public.club_members cm
     SET status = 'suspended',
         is_active = false,
         membership_lifecycle_status = 'departed',
         departed_at = clock_timestamp(),
         departed_by = v_me,
         departure_reason = 'Removed By Club Staff',
         updated_at = clock_timestamp()
   WHERE cm.id = v_target.id
     AND cm.club_id = p_club_id
     AND cm.membership_lifecycle_status = 'active';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM set_config('app.club_membership_lifecycle_write', '', true);

  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'membership changed during departure' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_departed', false, 'user_id', p_user_id,
    'records_retained', true
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_remove_settled_club_member(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_remove_settled_club_member(uuid, uuid)
  TO authenticated, service_role;

-- The unique (club_id,user_id) history row means a departed player rejoins by
-- reactivating that row, never by creating a replacement identity. The wrapper
-- preserves the existing approved join implementation for new memberships and
-- adds only the explicit, locked rejoin transition.
CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_row public.club_members%ROWTYPE;
  v_owner uuid;
  v_requires_approval boolean;
  v_lifecycle text;
  v_active_count integer;
  v_previous_source text := coalesce(current_setting('app.club_membership_source', true), '');
  v_previous_lifecycle text := coalesce(current_setting('app.club_membership_lifecycle_write', true), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.club_membership_source', 'join_club', true);
  BEGIN
    v_result := public.fn_join_club_membership_impl(p_club_id);

    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('cashier-hierarchy:' || p_club_id::text, 0)
      );
      SELECT c.owner_id, coalesce(c.requires_approval, false),
             coalesce(to_jsonb(c) ->> 'lifecycle_status', 'active')
        INTO v_owner, v_requires_approval, v_lifecycle
        FROM public.clubs c
       WHERE c.id = p_club_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;
      IF v_lifecycle = 'retired' THEN
        RAISE EXCEPTION 'This Club Is Retired And Cannot Accept Members' USING ERRCODE = '55000';
      END IF;

      SELECT count(*) INTO v_active_count
        FROM public.club_members cm
       WHERE cm.user_id = v_uid
         AND cm.club_id <> p_club_id
         AND cm.membership_lifecycle_status = 'active'
         AND cm.status::text IN ('active', 'approved');
      IF v_uid <> v_owner AND v_active_count >= 4 THEN
        RAISE EXCEPTION 'You can only be a member of up to 4 clubs. Leave a club to join a new one.';
      END IF;

      PERFORM set_config('app.club_membership_lifecycle_write', 'rejoin', true);
      UPDATE public.club_members cm
         SET membership_lifecycle_status = 'active',
             status = CASE
               WHEN v_uid = v_owner OR NOT v_requires_approval THEN 'active'
               ELSE 'pending'
             END,
             is_active = true,
             departed_at = NULL,
             departed_by = NULL,
             departure_reason = NULL,
             updated_at = clock_timestamp()
       WHERE cm.club_id = p_club_id
         AND cm.user_id = v_uid
         AND cm.membership_lifecycle_status = 'departed'
       RETURNING * INTO v_row;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'membership lifecycle changed during rejoin' USING ERRCODE = '40001';
      END IF;
      v_result := to_jsonb(v_row);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous_source, true);
    PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
    RAISE;
  END;

  PERFORM set_config('app.club_membership_source', v_previous_source, true);
  PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_join_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_join_club(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Real clubs retire in place. Their memberships, games, financial journals and
-- audit evidence are records, not disposable implementation details. Physical
-- deletion remains exclusive to fn_ca_retire_certification_club, whose service-
-- role contract proves the target is a never-played certification fixture.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid,
  ADD COLUMN IF NOT EXISTS retirement_reason text;

DO $lifecycle_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.clubs'::regclass
       AND conname = 'clubs_lifecycle_status_check'
  ) THEN
    ALTER TABLE public.clubs
      ADD CONSTRAINT clubs_lifecycle_status_check
      CHECK (lifecycle_status IN ('active', 'retired')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.clubs'::regclass
       AND conname = 'clubs_retired_by_fkey'
  ) THEN
    ALTER TABLE public.clubs
      ADD CONSTRAINT clubs_retired_by_fkey
      FOREIGN KEY (retired_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$lifecycle_constraints$;

ALTER TABLE public.clubs VALIDATE CONSTRAINT clubs_lifecycle_status_check;
CREATE INDEX IF NOT EXISTS idx_clubs_active_lifecycle
  ON public.clubs(id) WHERE lifecycle_status = 'active';

-- Existing club UPDATE policies intentionally continue to govern ordinary
-- settings. Lifecycle fields are different: only the owner-authorised RPC may
-- cross this boundary, and an already-retired club is immutable unless a future
-- documented maintenance workflow explicitly opens the local maintenance door.
CREATE OR REPLACE FUNCTION public.fn_guard_club_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_retirement_write boolean :=
    coalesce(current_setting('app.club_retirement_write', true), '') = 'on';
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT v_maintenance AND NOT (
      auth.uid() IS NULL
      AND (OLD.name LIKE 'Crest Cert %' OR OLD.name LIKE 'Preset Crest Cert %')
      AND coalesce(current_setting('app.ledger_maintenance', true), '') <> ''
      AND coalesce(current_setting('app.game_management_retention', true), '') = 'on'
    ) THEN
      RAISE EXCEPTION 'CLUB_RECORD_RETAINED: real club records cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.lifecycle_status = 'retired' AND NOT v_maintenance THEN
    RAISE EXCEPTION 'CLUB_RETIRED: this club is read-only'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.lifecycle_status, NEW.retired_at, NEW.retired_by, NEW.retirement_reason)
       IS DISTINCT FROM
     (OLD.lifecycle_status, OLD.retired_at, OLD.retired_by, OLD.retirement_reason)
     AND NOT v_retirement_write
     AND NOT v_maintenance THEN
    RAISE EXCEPTION 'CLUB_LIFECYCLE_REQUIRES_RPC: use fn_retire_settled_club'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_clubs_guard_lifecycle_write ON public.clubs;
CREATE TRIGGER trg_clubs_guard_lifecycle_write
BEFORE UPDATE OR DELETE ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_club_lifecycle_write();

-- A retired club cannot be reactivated through an older gameplay/cashier RPC.
-- The guard sits on the balance-bearing source rows, so SECURITY DEFINER callers
-- are covered too. It deliberately does not touch append-only history tables.
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
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    -- On UPDATE, check the source scope too. Moving a retained row to an active
    -- club must not become an escape hatch from a retired club's write freeze.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t
         WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr
         WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  -- A union row can use a club UUID without an FK back to clubs. Serialize
  -- that conversion with the retirement RPC so it cannot create a union
  -- identity from a club that became retired in the same instant.
  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('cashier-hierarchy:' || v_club_id::text, 0)
    );
  END IF;

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
    'club_members', 'agents', 'club_wallets', 'club_diamond_wallets',
    'bbj_pools', 'spin_bonus_pools', 'tables', 'tournaments',
    'table_seats', 'tournament_players', 'tournament_escrow',
    'cashout_requests', 'chip_requests', 'chip_escrow', 'chip_escrow_holds',
    'tournament_tickets', 'credit_invoices', 'settlement_periods',
    'promo_vault_inventory', 'club_opening_setups', 'union_clubs', 'unions'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_guard_retired_club_mutation ON public.%I',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER trg_guard_retired_club_mutation '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation()',
      v_table
    );
  END LOOP;
END
$retired_write_triggers$;

-- The preview is guidance, not authority. It uses the same canonical account
-- classes as the supply meter and separates non-chip obligations (diamonds and
-- Promo Vault inventory) so neither can be hidden by signed-value cancellation.
CREATE OR REPLACE FUNCTION public.fn_club_retirement_impact(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_members bigint := 0;
  v_running bigint := 0;
  v_tournaments bigint := 0;
  v_wallet numeric := 0;
  v_diamonds numeric := 0;
  v_inventory bigint := 0;
  v_open bigint := 0;
  v_union boolean := false;
  v_retired boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT c.owner_id, c.lifecycle_status = 'retired'
    INTO v_owner, v_retired
    FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the club owner can inspect retirement impact';
  END IF;

  SELECT count(*) INTO v_members FROM public.club_members WHERE club_id = p_club_id;
  SELECT count(*) INTO v_running
    FROM public.tables t
   WHERE t.club_id = p_club_id
     AND coalesce(t.is_deleted, false) = false
     AND lower(coalesce(t.status::text, '')) NOT IN ('closed', 'deleted');

  SELECT count(*) INTO v_tournaments
    FROM public.tournaments t
   WHERE t.club_id = p_club_id
     AND lower(coalesce(t.status::text, '')) NOT IN ('completed', 'cancelled', 'canceled');

  SELECT
    EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_club_id)
    OR EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = p_club_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_club_id
                  AND (c.union_id IS NOT NULL
                    OR coalesce((to_jsonb(c) ->> 'is_union')::boolean, false)))
    INTO v_union;

  SELECT coalesce(abs(c.chip_treasury), 0) + coalesce(abs(c.chip_pool), 0)
       + coalesce(abs(c.promo_balance), 0) + coalesce(abs(c.insurance_balance), 0)
    INTO v_wallet FROM public.clubs c WHERE c.id = p_club_id;

  SELECT v_wallet + coalesce(sum(
           abs(coalesce(cm.chip_balance, 0)) + abs(coalesce(cm.held_chips, 0))
         + abs(coalesce(cm.locked_chips, 0)) + abs(coalesce(cm.promo_balance, 0))
         + abs(coalesce(cm.credit_used, 0))), 0)
    INTO v_wallet FROM public.club_members cm WHERE cm.club_id = p_club_id;

  SELECT v_wallet + coalesce(sum(
           abs(coalesce(a.agent_wallet_balance, 0))
         + abs(coalesce(a.promo_wallet_balance, 0))
         + abs(coalesce(a.credit_used, 0))), 0)
    INTO v_wallet FROM public.agents a WHERE a.club_id = p_club_id;

  SELECT v_wallet + coalesce(sum(
           abs(coalesce(w.chip_balance, 0))), 0)
    INTO v_wallet FROM public.club_wallets w WHERE w.club_id = p_club_id;
  SELECT v_wallet + coalesce(sum(
           abs(coalesce(b.main_balance, 0)) + abs(coalesce(b.backup_balance, 0))
         + abs(coalesce(b.promo_balance, 0))), 0)
    INTO v_wallet FROM public.bbj_pools b WHERE b.club_id = p_club_id;
  SELECT v_wallet + coalesce(sum(abs(coalesce(s.balance, 0))), 0)
    INTO v_wallet FROM public.spin_bonus_pools s WHERE s.club_id = p_club_id;
  SELECT v_wallet + coalesce(sum(abs(coalesce(ts.stack, 0))), 0)
    INTO v_wallet
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id
     AND t.tournament_id IS NULL
     AND ts.left_at IS NULL;
  SELECT v_wallet + coalesce(sum(abs(coalesce(h.amount, 0))), 0)
    INTO v_wallet FROM public.chip_escrow_holds h
   WHERE h.club_id = p_club_id AND h.status = 'held';
  SELECT v_wallet + coalesce(sum(abs(coalesce(ce.amount, 0))), 0)
    INTO v_wallet
    FROM public.chip_escrow ce
    JOIN public.cashout_requests cr ON cr.id = ce.cashout_request_id
   WHERE cr.club_id = p_club_id AND ce.released_at IS NULL;
  SELECT v_wallet + coalesce(sum(abs(coalesce(tt.value, 0))), 0)
    INTO v_wallet FROM public.tournament_tickets tt
   WHERE tt.club_id = p_club_id AND tt.status = 'issued';

  -- Tournament chip stacks are game units, not a second cash balance. The
  -- canonical liability is the enforced escrow balance, falling back to the
  -- legacy counters only where no escrow row exists yet.
  SELECT v_wallet + coalesce(sum(abs(coalesce(
           te.prize_balance + te.bounty_balance + te.fee_balance,
           coalesce(tr.prize_pool, 0) + coalesce(tr.bounty_pool, 0)
             - coalesce(tr.bounty_pool_paid, 0) + coalesce(tr.total_rake, 0)
         ))), 0)
    INTO v_wallet
    FROM public.tournaments tr
    LEFT JOIN public.tournament_escrow te ON te.tournament_id = tr.id
   WHERE tr.club_id = p_club_id
     AND lower(coalesce(tr.status::text, '')) NOT IN ('completed', 'cancelled', 'canceled');

  SELECT v_wallet + coalesce(sum(abs(coalesce(s.leaderboard_seed_remaining, 0))), 0)
    INTO v_wallet FROM public.club_opening_setups s WHERE s.club_id = p_club_id;

  SELECT coalesce(sum(abs(coalesce(w.balance, 0))), 0)
    INTO v_diamonds FROM public.club_diamond_wallets w WHERE w.club_id = p_club_id;
  SELECT v_diamonds + coalesce(sum(abs(coalesce(cm.diamonds, 0))), 0)
    INTO v_diamonds FROM public.club_members cm WHERE cm.club_id = p_club_id;
  SELECT coalesce(sum(coalesce(i.quantity, 0)), 0)
    INTO v_inventory FROM public.promo_vault_inventory i WHERE i.club_id = p_club_id;

  SELECT
      (SELECT count(*) FROM public.cashout_requests cr
        WHERE cr.club_id = p_club_id AND cr.status IN ('pending', 'approved'))
    + (SELECT count(*) FROM public.chip_requests r
        WHERE r.club_id = p_club_id AND r.status = 'pending')
    + (SELECT count(*) FROM public.chip_escrow_holds h
        WHERE h.club_id = p_club_id AND h.status = 'held')
    + (SELECT count(*)
         FROM public.chip_escrow ce
         JOIN public.cashout_requests cr ON cr.id = ce.cashout_request_id
        WHERE cr.club_id = p_club_id AND ce.released_at IS NULL)
    + (SELECT count(*) FROM public.tournament_tickets tt
        WHERE tt.club_id = p_club_id AND tt.status = 'issued')
    + (SELECT count(*) FROM public.settlement_periods sp
        WHERE sp.club_id = p_club_id
          AND lower(coalesce(sp.status::text, '')) IN ('open', 'processing', 'disputed'))
    + (SELECT count(*)
         FROM public.credit_invoices ci JOIN public.agents a ON a.id = ci.agent_id
        WHERE a.club_id = p_club_id
          AND lower(coalesce(ci.status::text, '')) IN ('pending', 'partial', 'overdue', 'disputed'))
    + (SELECT count(*)
         FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL)
    + (SELECT count(*)
         FROM public.tournament_players tp
         JOIN public.tournaments tr ON tr.id = tp.tournament_id
        WHERE tr.club_id = p_club_id
          AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing'))
    + v_tournaments
    INTO v_open;

  RETURN jsonb_build_object(
    'members', v_members,
    'running_tables', v_running,
    'active_tournaments', v_tournaments,
    'wallet_chips', coalesce(v_wallet, 0),
    'diamonds', coalesce(v_diamonds, 0),
    'inventory_items', coalesce(v_inventory, 0),
    'open_obligations', v_open,
    'union_affiliated', v_union,
    'already_retired', v_retired
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_retirement_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_retirement_impact(uuid) TO authenticated, service_role;

-- Compatibility for already-loaded settings clients. This read-only alias is
-- harmless; the obsolete hard-delete write function below is removed entirely.
CREATE OR REPLACE FUNCTION public.fn_club_deletion_impact(p_club_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_club_retirement_impact(p_club_id)
$function$;

REVOKE ALL ON FUNCTION public.fn_club_deletion_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_deletion_impact(uuid) TO authenticated, service_role;

-- Direct browser DELETE remains revoked. Real records cannot be erased even if
-- a stale client tries the table endpoint rather than the retirement RPC.
DO $drop_club_delete_policies$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'clubs' AND cmd IN ('DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.clubs', p.policyname);
  END LOOP;
END
$drop_club_delete_policies$;
REVOKE DELETE ON TABLE public.clubs FROM PUBLIC, anon, authenticated;
GRANT DELETE ON TABLE public.clubs TO service_role;

DROP FUNCTION IF EXISTS public.fn_delete_settled_club(uuid, text);

CREATE OR REPLACE FUNCTION public.fn_retire_settled_club(
  p_club_id uuid,
  p_confirm_name text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
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
  PERFORM 1 FROM public.club_members WHERE club_id = p_club_id ORDER BY id FOR UPDATE;
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
    RAISE EXCEPTION 'club lifecycle changed during retirement' USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.fn_retire_settled_club(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_retire_settled_club(uuid, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_retire_settled_club(uuid, text, text) IS
  'Owner-only, lock-bounded soft retirement for a fully settled standalone club. Preserves every club, membership, game, journal and audit row. Physical deletion remains exclusive to the service-role certification-fixture contract.';

-- ---------------------------------------------------------------------------
-- Fail the migration rather than publish a partially closed boundary.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_policy_count integer;
  v_missing_trigger_count integer;
  v_cmd text;
  v_permissive text;
  v_roles name[];
  v_qual text;
BEGIN
  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.chip_requests'::regclass
  ) THEN
    RAISE EXCEPTION 'chip_requests RLS is disabled';
  END IF;

  SELECT count(*)
    INTO v_policy_count
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = 'chip_requests'
     AND p.cmd IN ('SELECT', 'ALL')
     AND p.roles && ARRAY['public', 'anon', 'authenticated']::name[];

  IF v_policy_count <> 1 THEN
    RAISE EXCEPTION
      'chip_requests has % browser-applicable SELECT/ALL policies; expected exactly 1',
      v_policy_count;
  END IF;

  SELECT p.cmd, p.permissive, p.roles, p.qual
    INTO v_cmd, v_permissive, v_roles, v_qual
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = 'chip_requests'
     AND p.policyname = 'cashier_chip_requests_read';

  IF v_cmd IS DISTINCT FROM 'SELECT'
     OR v_permissive IS DISTINCT FROM 'PERMISSIVE'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::name[] THEN
    RAISE EXCEPTION
      'canonical chip_requests policy shape changed: cmd=%, permissive=%, roles=%',
      v_cmd, v_permissive, v_roles;
  END IF;

  IF v_qual IS NULL
     OR v_qual NOT LIKE '%requester_id%'
     OR v_qual NOT LIKE '%approver_id%'
     OR v_qual NOT LIKE '%fn_club_cashier_scope%'
     OR v_qual NOT LIKE '%''all''%'
     OR v_qual LIKE '%club_members%' THEN
    RAISE EXCEPTION 'canonical chip_requests policy lost or broadened an authorization arm: %',
      v_qual;
  END IF;

  IF has_table_privilege('anon', 'public.chip_requests', 'SELECT') THEN
    RAISE EXCEPTION 'anon can still read chip_requests';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.chip_requests', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost the RLS-filtered chip_requests read grant';
  END IF;

  IF has_table_privilege('authenticated', 'public.chip_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'public.chip_requests', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.chip_requests', 'DELETE')
     OR has_table_privilege('authenticated', 'public.chip_requests', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.chip_requests', 'INSERT')
     OR has_table_privilege('anon', 'public.chip_requests', 'UPDATE')
     OR has_table_privilege('anon', 'public.chip_requests', 'DELETE')
     OR has_table_privilege('anon', 'public.chip_requests', 'TRUNCATE') THEN
    RAISE EXCEPTION 'a browser role can still mutate chip_requests directly';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.chip_requests', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.chip_requests', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.chip_requests', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.chip_requests', 'DELETE') THEN
    RAISE EXCEPTION 'service_role lost required chip_requests privileges';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.club_members'::regclass
  ) THEN
    RAISE EXCEPTION 'club_members RLS is disabled';
  END IF;

  IF has_table_privilege('authenticated', 'public.club_members', 'DELETE')
     OR has_table_privilege('anon', 'public.club_members', 'DELETE') THEN
    RAISE EXCEPTION 'a browser role can still delete club_members directly';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'club_members'
       AND p.cmd IN ('DELETE', 'ALL')
       AND p.roles && ARRAY['public', 'anon', 'authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'a browser-applicable club_members DELETE/ALL policy survived';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.club_members', 'DELETE') THEN
    RAISE EXCEPTION 'service_role lost the server-owned club_members delete grant';
  END IF;

  IF has_table_privilege('authenticated', 'public.clubs', 'DELETE')
     OR has_table_privilege('anon', 'public.clubs', 'DELETE') THEN
    RAISE EXCEPTION 'a browser role can still delete clubs directly';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'clubs'
       AND p.cmd IN ('DELETE', 'ALL')
       AND p.roles && ARRAY['public', 'anon', 'authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'a browser-applicable clubs DELETE/ALL policy survived';
  END IF;

  IF has_function_privilege('anon', 'public.fn_remove_settled_club_member(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_retire_settled_club(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a server-owned removal/retirement workflow';
  END IF;

  IF to_regprocedure('public.fn_delete_settled_club(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete owner-facing hard-delete function survived';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clubs'
       AND column_name = 'lifecycle_status'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.clubs'::regclass
       AND tgname = 'trg_clubs_guard_lifecycle_write'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'club retirement lifecycle boundary is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.club_members'::regclass
       AND tgname = 'trg_club_members_guard_lifecycle_write'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'membership lifecycle trigger is missing';
  END IF;

  SELECT count(*)
    INTO v_missing_trigger_count
    FROM unnest(ARRAY[
      'club_members', 'agents', 'club_wallets', 'club_diamond_wallets',
      'bbj_pools', 'spin_bonus_pools', 'tables', 'tournaments',
      'table_seats', 'tournament_players', 'tournament_escrow',
      'cashout_requests', 'chip_requests', 'chip_escrow', 'chip_escrow_holds',
      'tournament_tickets', 'credit_invoices', 'settlement_periods',
      'promo_vault_inventory', 'club_opening_setups', 'union_clubs', 'unions'
    ]::text[]) AS expected(table_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger t
      WHERE t.tgrelid = to_regclass('public.' || expected.table_name)
        AND t.tgname = 'trg_guard_retired_club_mutation'
        AND NOT t.tgisinternal
   );
  IF v_missing_trigger_count <> 0 THEN
    RAISE EXCEPTION '% retired-club mutation triggers are missing', v_missing_trigger_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'public.fn_guard_membership_lifecycle_write()',
        'public.fn_remove_settled_club_member(uuid,uuid)',
        'public.fn_guard_club_lifecycle_write()',
        'public.fn_guard_retired_club_mutation()',
        'public.fn_club_retirement_impact(uuid)',
        'public.fn_club_deletion_impact(uuid)',
        'public.fn_retire_settled_club(uuid,text,text)'
      ]::text[]) AS expected(signature)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(expected.signature)
     WHERE p.oid IS NULL
        OR NOT p.prosecdef
        OR array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',')
             NOT LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'a lifecycle function lost SECURITY DEFINER or its fixed search_path';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'public.fn_remove_settled_club_member(uuid,uuid)',
        'public.fn_retire_settled_club(uuid,text,text)'
      ]::text[]) AS expected(signature)
      JOIN pg_proc p ON p.oid = to_regprocedure(expected.signature)
     WHERE array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',')
             NOT LIKE '%lock_timeout=5s%'
  ) THEN
    RAISE EXCEPTION 'a lifecycle mutation function lost its runtime lock timeout';
  END IF;

  IF NOT has_function_privilege(
       'authenticated', 'public.fn_remove_settled_club_member(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.fn_remove_settled_club_member(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.fn_retire_settled_club(uuid,text,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.fn_retire_settled_club(uuid,text,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'a lifecycle workflow lost an authenticated or service execution grant';
  END IF;

  IF pg_get_functiondef('public.fn_guard_club_lifecycle_write()'::regprocedure)
       NOT LIKE '%Crest Cert %%'
     OR pg_get_functiondef('public.fn_guard_club_lifecycle_write()'::regprocedure)
       NOT LIKE '%app.ledger_maintenance%'
     OR pg_get_functiondef('public.fn_guard_club_lifecycle_write()'::regprocedure)
       NOT LIKE '%app.game_management_retention%' THEN
    RAISE EXCEPTION 'physical club deletion guard lost its certification-fixture boundary';
  END IF;
END
$assert$;

COMMIT;
