-- 20261014231111_a_floor_park_is_a_lease_that_expires_and_pages_never_a_switc.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A FLOOR PARK IS A LEASE THAT EXPIRES AND PAGES, NEVER A SWITCH LEFT ON
-- ============================================================================
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh) on 2026-10-14:
--
--   2026-10-13 13:15:28Z  fn_ca_launch_operator_command(... 'park' ...) wrote the
--                         single row of ca_operator_floor_hold (operation
--                         a970faa8, "Owner Authorized Scoped Launch Accounting
--                         Reset", scoped to Club JAQK, Deep Stack Society,
--                         SHARK CLUB and Midway Union).
--   2026-10-13 13:16:12Z  'close_cash' under that park closed 74 cash tables.
--   2026-10-13 16:07Z     the engine finished closing them. The reset the park
--                         was taken for never ran (every ca_launch_reset_* table
--                         held zero rows 34 hours later) and nobody resumed.
--   2026-10-14 23:03:41Z  resumed by hand (operation 523a2e84).
--
-- For 34 hours fn_ca_operator_floor_entry_guard refused every seat on the whole
-- Midway Union floor (32,202 refused atomic_table_buyin calls in the three
-- hours before the resume alone, every one a 500 to the engine's horse fleet
-- and to any player who tried) and fn_ca_launch_tournament_admission_guard
-- refused every tournament created for the four scoped clubs (2,316 refused
-- inserts in the same three hours). Not one row of financial_alerts,
-- engine_alerts or operational_alert_events said so. The hold row had no
-- timestamp, no deadline, and no watch: a park was a switch, and a switch that
-- the program which flipped it abandoned stayed flipped.
--
-- WHAT CHANGES
--
-- 1. ca_operator_floor_hold carries held_since and expires_at. A trigger stamps
--    them whenever the hold is written or moves to another operation, so the
--    three existing writers (fn_ca_engine_operator_command's INSERT ... ON
--    CONFLICT for 'park' and 'pause', and anything replaying them) need no
--    change and keep their pinned definitions. The lease is
--    fn_ca_operator_floor_hold_ttl() = 60 minutes.
--
-- 2. fn_ca_operator_floor_hold_renew(actor, operation, reason) extends the
--    lease by one TTL for the operation that owns it, as service_role only,
--    and audits the renewal. A program that needs the floor longer than an
--    hour says so every hour; silence means it is gone.
--
-- 3. fn_ca_operator_floor_hold_watchdog(), on cron every minute:
--      - a hold older than 10 minutes raises ONE critical financial alert
--        (keyed on context.operation_id), with the scope and the number of
--        open cash tables and tournaments it is refusing;
--      - a hold past expires_at is released: for a scoped launch park the
--        release writes exactly what fn_ca_launch_operator_command('resume')
--        would have written (a scope row for the resume operation, the
--        resume command, one resume receipt per closed table of the park's
--        actor) so fn_ca_launch_cash_close_resumed proves every table
--        afterwards; for an unscoped park or pause it writes the resume
--        command and removes the hold. The release is recorded in
--        ca_operator_floor_hold_releases and audited as the hold's actor;
--      - a close that reaches 'closed' after its hold was released (the engine
--        was still closing it at expiry) gets its receipt on the next tick,
--        from the release row;
--      - the alert resolves when the hold is gone and nothing it closed is
--        still refusing seats.
--
-- The watchdog moves no money and touches no seat. It writes the same rows a
-- resume command writes, under the same advisory lock (530093) the commands
-- take, and it writes them as the actor who took the hold.
--
-- periodic-work: this schedule is the monitor itself. A park is taken by a
-- program outside this database, and nothing inside it can know that program
-- died except a clock; the only thing that catches the next abandoned park is
-- a watch that measures the outcome (a hold older than its lease) every
-- minute, exactly as ca-tournament-dark-while-running-5m measures a dark
-- event. It repairs nothing but the hold and raises the page a person reads.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-operator-floor-hold-watchdog-1m' AND active) AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ca_operator_floor_hold_lease' AND NOT tgisinternal))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The hold is a lease.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_ttl()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$ SELECT interval '60 minutes' $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_page_after()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$ SELECT interval '10 minutes' $function$;

ALTER TABLE public.ca_operator_floor_hold
  ADD COLUMN IF NOT EXISTS held_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '60 minutes';

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- A new hold, or a hold handed to another operation, starts a fresh lease.
  -- A renewal (same operation, later expires_at) passes through untouched.
  IF TG_OP = 'INSERT' OR NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
    NEW.held_since := clock_timestamp();
    NEW.expires_at := NEW.held_since + public.fn_ca_operator_floor_hold_ttl();
  ELSIF NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at + public.fn_ca_operator_floor_hold_ttl() THEN
    -- Nobody extends a lease by more than one TTL in one write.
    NEW.expires_at := OLD.expires_at + public.fn_ca_operator_floor_hold_ttl();
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS ca_operator_floor_hold_lease ON public.ca_operator_floor_hold;
CREATE TRIGGER ca_operator_floor_hold_lease
  BEFORE INSERT OR UPDATE ON public.ca_operator_floor_hold
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_operator_floor_hold_lease();

CREATE TABLE IF NOT EXISTS public.ca_operator_floor_hold_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  park_operation_id uuid NOT NULL,
  resume_operation_id uuid NOT NULL,
  actor_id uuid,
  mode text NOT NULL,
  scoped boolean NOT NULL,
  held_since timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL,
  receipts_written integer NOT NULL DEFAULT 0,
  closes_pending integer NOT NULL DEFAULT 0
);
ALTER TABLE public.ca_operator_floor_hold_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_operator_floor_hold_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_operator_floor_hold_releases TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The owner of the hold can renew it, once per TTL, as service_role.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_renew(p_actor uuid, p_operation uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE h public.ca_operator_floor_hold; cmd public.ca_engine_operator_commands; v_before jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
  IF p_actor IS NULL OR p_operation IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'invalid_operator_command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(530093);
  SELECT * INTO h FROM public.ca_operator_floor_hold WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_floor_hold'); END IF;
  IF h.operation_id IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'launch_operator_other_hold_active' USING ERRCODE='55006'; END IF;
  SELECT * INTO cmd FROM public.ca_engine_operator_commands WHERE id = p_operation;
  IF NOT FOUND OR cmd.actor_id IS DISTINCT FROM p_actor OR cmd.domain <> 'floor' OR cmd.action NOT IN ('park', 'pause') THEN
    RAISE EXCEPTION 'operation_identity_conflict' USING ERRCODE='42501'; END IF;
  v_before := to_jsonb(h);
  UPDATE public.ca_operator_floor_hold
     SET expires_at = GREATEST(expires_at, clock_timestamp()) + public.fn_ca_operator_floor_hold_ttl()
   WHERE id = true
   RETURNING * INTO h;
  PERFORM public.fn_log_admin_action(p_actor, 'engine_operator.floor.renew', 'engine_operator_command', p_operation::text,
    jsonb_build_object('reason', p_reason, 'operation_id', p_operation, 'expires_at', h.expires_at), v_before, to_jsonb(h), NULL, NULL,
    p_operation::text || ':renew:' || to_char(h.expires_at, 'YYYYMMDDHH24MISS'));
  RETURN jsonb_build_object('ok', true, 'operation_id', h.operation_id, 'held_since', h.held_since, 'expires_at', h.expires_at);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_hold_renew(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_hold_renew(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_hold_ttl() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_hold_page_after() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The watchdog.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_open_alert(p_operation_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT fa.id FROM public.financial_alerts fa
   WHERE fa.source = 'fn_ca_operator_floor_hold_watchdog'
     AND NOT fa.resolved
     AND fa.context->>'operation_id' = p_operation_id::text
   ORDER BY fa.created_at, fa.id LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_hold_watchdog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  h public.ca_operator_floor_hold;
  cmd public.ca_engine_operator_commands;
  scope public.ca_launch_operator_scopes;
  v_actor uuid;
  v_resume uuid;
  v_reason text;
  v_receipts integer := 0;
  v_pending integer := 0;
  v_late_receipts integer := 0;
  v_raised integer := 0;
  v_resolved integer := 0;
  v_released boolean := false;
  v_refusing_tables integer := 0;
  v_held_minutes numeric;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- The same lane every floor command takes, so a park, a resume and this
  -- watch never interleave.
  PERFORM pg_advisory_xact_lock(530093);

  SELECT * INTO h FROM public.ca_operator_floor_hold WHERE id = true FOR UPDATE;

  IF FOUND THEN
    SELECT * INTO cmd FROM public.ca_engine_operator_commands WHERE id = h.operation_id;
    SELECT * INTO scope FROM public.ca_launch_operator_scopes WHERE operation_id = h.operation_id;
    v_actor := COALESCE(cmd.actor_id, scope.actor_id);
    v_held_minutes := round(extract(epoch FROM (v_now - h.held_since)) / 60.0, 1);

    -- How much of the floor this hold is refusing right now.
    SELECT count(*) INTO v_refusing_tables
      FROM public.tables st
     WHERE st.tournament_id IS NULL
       AND lower(COALESCE(st.status::text, '')) IN ('running', 'waiting', 'active')
       AND NOT COALESCE(st.is_deleted, false)
       AND (scope.operation_id IS NULL OR st.club_id = ANY(scope.club_ids) OR st.union_id = ANY(scope.club_ids));

    -- (a) A hold older than the page threshold is an incident, once.
    IF h.held_since <= v_now - public.fn_ca_operator_floor_hold_page_after()
       AND public.fn_ca_operator_floor_hold_open_alert(h.operation_id) IS NULL THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_ca_operator_floor_hold_watchdog',
        format('The operator floor has been %s for %s minutes by operation %s ("%s"), %s. It is refusing every seat on %s open cash table(s)%s. '
               || 'The hold expires at %s and will be released by this watchdog then; the program that took it must call '
               || 'fn_ca_operator_floor_hold_renew to keep it, or fn_ca_launch_operator_command(''resume'') to end it.',
               h.mode, v_held_minutes, h.operation_id, left(COALESCE(h.reason, ''), 120),
               CASE WHEN scope.operation_id IS NULL THEN 'platform-wide' ELSE 'scoped to ' || cardinality(scope.club_ids) || ' club(s)/union(s)' END,
               v_refusing_tables,
               CASE WHEN scope.operation_id IS NULL THEN '' ELSE ' and every tournament created in its scope' END,
               h.expires_at),
        jsonb_build_object('checked_at', v_now, 'operation_id', h.operation_id, 'mode', h.mode, 'actor_id', v_actor,
          'held_since', h.held_since, 'expires_at', h.expires_at, 'held_minutes', v_held_minutes,
          'scoped', scope.operation_id IS NOT NULL, 'club_ids', to_jsonb(scope.club_ids), 'refusing_tables', v_refusing_tables));
      v_raised := 1;
    END IF;

    -- (b) An expired hold is released as its own actor would have released it.
    IF h.expires_at <= v_now THEN
      v_resume := gen_random_uuid();
      v_reason := format('Floor hold auto-released by fn_ca_operator_floor_hold_watchdog: %s operation %s held since %s expired at %s without renewal',
                         h.mode, h.operation_id, h.held_since, h.expires_at);
      -- A hold nobody owns (no command, no scope) is simply dropped; the
      -- release row and the alert still name it.

      IF scope.operation_id IS NOT NULL THEN
        -- The resume operation carries the park's scope, exactly as
        -- fn_ca_launch_operator_command writes it.
        INSERT INTO public.ca_launch_operator_scopes (operation_id, actor_id, club_ids)
        VALUES (v_resume, scope.actor_id, scope.club_ids)
        ON CONFLICT (operation_id) DO NOTHING;
      END IF;

      INSERT INTO public.ca_engine_operator_commands (id, actor_id, domain, action, reason, status, result)
      VALUES (v_resume, v_actor, 'floor', 'resume', left(v_reason, 500), 'accepted',
              jsonb_build_object('auto_released', true, 'park_operation_id', h.operation_id));

      IF scope.operation_id IS NOT NULL THEN
        INSERT INTO public.ca_launch_floor_resume_receipts (table_id, close_operation_id, park_operation_id, resume_operation_id, actor_id)
        SELECT c.table_id, c.operation_id, h.operation_id, v_resume, scope.actor_id
          FROM public.ca_operator_table_closes c
          JOIN public.ca_launch_operator_scopes m ON m.operation_id = c.operation_id AND m.actor_id = scope.actor_id
          JOIN public.ca_engine_operator_commands cc ON cc.id = c.operation_id AND cc.actor_id = scope.actor_id
               AND cc.domain = 'floor' AND cc.action = 'close_cash' AND cc.status = 'completed'
          JOIN public.tables t ON t.id = c.table_id AND t.tournament_id IS NULL
               AND (t.club_id = ANY(m.club_ids) OR t.union_id = ANY(m.club_ids))
         WHERE c.actor_id = scope.actor_id AND c.status = 'closed'
           AND (cmd.created_at IS NULL OR cc.created_at >= cmd.created_at)
        ON CONFLICT (table_id, close_operation_id) DO NOTHING;
        GET DIAGNOSTICS v_receipts = ROW_COUNT;
        SELECT count(*) INTO v_pending FROM public.ca_operator_table_closes c
         WHERE c.actor_id = scope.actor_id AND c.status = 'pending';
      END IF;

      DELETE FROM public.ca_operator_floor_hold WHERE id = true;

      INSERT INTO public.ca_operator_floor_hold_releases
        (park_operation_id, resume_operation_id, actor_id, mode, scoped, held_since, expires_at, reason, receipts_written, closes_pending)
      VALUES (h.operation_id, v_resume, v_actor, h.mode, scope.operation_id IS NOT NULL, h.held_since, h.expires_at, v_reason, v_receipts, v_pending);

      IF v_actor IS NOT NULL THEN
        PERFORM public.fn_log_admin_action(v_actor, 'engine_operator.floor.auto_release', 'engine_operator_command', v_resume::text,
          jsonb_build_object('reason', v_reason, 'operation_id', v_resume, 'park_operation_id', h.operation_id,
                             'receipts_written', v_receipts, 'closes_pending', v_pending),
          to_jsonb(h), NULL, NULL, NULL, v_resume::text || ':auto_release');
      END IF;
      v_released := true;
    END IF;
  END IF;

  -- (c) A close that finished after its hold was released gets its receipt now,
  -- from the release row, so the table is proven resumed.
  INSERT INTO public.ca_launch_floor_resume_receipts (table_id, close_operation_id, park_operation_id, resume_operation_id, actor_id)
  SELECT c.table_id, c.operation_id, r.park_operation_id, r.resume_operation_id, c.actor_id
    FROM public.ca_operator_table_closes c
    JOIN public.ca_launch_operator_scopes m ON m.operation_id = c.operation_id AND m.actor_id = c.actor_id
    JOIN public.ca_engine_operator_commands cc ON cc.id = c.operation_id AND cc.actor_id = c.actor_id
         AND cc.domain = 'floor' AND cc.action = 'close_cash' AND cc.status = 'completed'
    JOIN public.tables t ON t.id = c.table_id AND t.tournament_id IS NULL
         AND (t.club_id = ANY(m.club_ids) OR t.union_id = ANY(m.club_ids))
    JOIN LATERAL (
      SELECT r.* FROM public.ca_operator_floor_hold_releases r
       WHERE r.scoped AND r.actor_id = c.actor_id AND r.released_at >= cc.created_at
       ORDER BY r.released_at DESC LIMIT 1) r ON true
   WHERE c.status = 'closed'
     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_floor_hold)
     AND public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE
  ON CONFLICT (table_id, close_operation_id) DO NOTHING;
  GET DIAGNOSTICS v_late_receipts = ROW_COUNT;

  -- (d) An alert whose hold is gone, and whose closes no longer refuse, closes.
  WITH named AS (
    SELECT fa.id AS alert_id, fa.created_at AS raised_at, fa.context->>'operation_id' AS op
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_ca_operator_floor_hold_watchdog' AND NOT fa.resolved
  )
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = v_now,
         resolution = format('Re-measured by fn_ca_operator_floor_hold_watchdog at %s: operation %s no longer holds the floor%s, after the alert was raised at %s.',
                             v_now, n.op,
                             CASE WHEN EXISTS (SELECT 1 FROM public.ca_operator_floor_hold_releases r WHERE r.park_operation_id::text = n.op)
                                  THEN ' (released by this watchdog at its lease expiry)' ELSE '' END,
                             n.raised_at)
    FROM named n
   WHERE fa.id = n.alert_id
     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_floor_hold hh WHERE hh.operation_id::text = n.op)
     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                      WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE);
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true, 'checked_at', v_now,
    'hold', CASE WHEN h.operation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'operation_id', h.operation_id, 'mode', h.mode, 'held_since', h.held_since, 'expires_at', h.expires_at,
      'held_minutes', v_held_minutes, 'refusing_tables', v_refusing_tables) END,
    'raised', v_raised, 'released', v_released, 'resume_operation_id', v_resume,
    'receipts_written', v_receipts, 'late_receipts_written', v_late_receipts, 'closes_pending', v_pending,
    'resolved', v_resolved);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_hold_watchdog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_hold_open_alert(uuid) FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-operator-floor-hold-watchdog-1m') THEN
    PERFORM cron.unschedule('ca-operator-floor-hold-watchdog-1m');
  END IF;
  PERFORM cron.schedule(
    'ca-operator-floor-hold-watchdog-1m',
    '* * * * *',
    $$select public.fn_ca_operator_floor_hold_watchdog();$$);
END
$cron$;

COMMIT;
