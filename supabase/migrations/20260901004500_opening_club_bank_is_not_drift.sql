-- A new standalone club receives one intentional 100,000-chip system mint in
-- its Club Bank.  A legacy first-club bonus trigger was also crediting the
-- owner's player wallet.  Because the opening-bank idempotency GUC remained
-- set for the transaction, that second write could not journal and correctly
-- appeared as a ledger-write failure.  Remove the obsolete wallet grant and
-- teach reconciliation that a duplicate write is already satisfied only when
-- the exact canonical opening-bank ledger row exists.

BEGIN;

DO $drop_legacy_bonus$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.club_members'::regclass
       AND tgname = 'trg_first_club_creation_bonus'
       AND tgenabled <> 'D'
  ) THEN
    EXECUTE 'DROP TRIGGER trg_first_club_creation_bonus ON public.club_members';
  END IF;
END;
$drop_legacy_bonus$;

CREATE OR REPLACE FUNCTION public.fn_grant_first_club_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Retained as a no-op for rollback compatibility with older schema dumps.
  -- New-club funding belongs exclusively in clubs.chip_treasury.
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_grant_first_club_bonus() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_grant_first_club_bonus() TO service_role;

-- Release the club_members schema lock before touching incident tables.  Auth,
-- Realtime, and the reconciliation cron are active continuously in production;
-- keeping those lock domains in separate transactions prevents lock inversion.
COMMIT;
BEGIN;

-- Drift Incidents are a Midway Union control surface, not a global club
-- telemetry feed.  Keep the accounting protections global, but admit an
-- incident only when its union, club, table, tournament, or explicit metadata
-- resolves to Midway Union.
CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope(
  p_union_id uuid DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL,
  p_tournament_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR p_club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
       WHERE uc.club_id = p_club_id
         AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.tables t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_table_id
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_tournament_id
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR COALESCE(p_metadata->>'union_id', '') = 'fade0000-0000-0000-0000-000000000001'
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id::text = COALESCE(p_metadata->>'club_id', '')
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )), false);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)
  TO service_role;

DO $scope_incident_writer$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure
  ) INTO v_def;
  v_old := E'BEGIN\n  IF v_class IS NULL';
  v_new := E'BEGIN\n  IF NOT public.fn_ca_is_midway_scope(\n'
    '    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata\n'
    '  ) THEN\n'
    '    RETURN NULL;\n'
    '  END IF;\n\n'
    '  IF v_class IS NULL';
  IF position('fn_ca_is_midway_scope' IN v_def) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'fn_ca_raise_drift_incident drifted; refusing unsafe scope patch';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END;
$scope_incident_writer$;

DO $patch_reconciler$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_quick_reconcile()'::regprocedure) INTO v_def;
  v_old := E'SELECT * FROM public.ca_ledger_write_failures\n'
    '     WHERE occurred_at > now() - interval ''10 minutes''\n'
    '     LIMIT 20';
  v_new := E'SELECT * FROM public.ca_ledger_write_failures f\n'
    '     WHERE f.occurred_at > now() - interval ''10 minutes''\n'
    '        AND public.fn_ca_is_midway_scope(NULL, f.club_id, NULL, NULL, ''{}''::jsonb)\n'
    '        AND NOT (\n'
    '          f.sqlstate = ''23505''\n'
    '          AND f.message LIKE ''%ux_chip_ledger_idempotency_key%''\n'
    '          AND EXISTS (\n'
    '            SELECT 1 FROM public.chip_ledger l\n'
    '             WHERE l.club_id = f.club_id\n'
    '               AND l.idempotency_key = ''club-opening-grant:'' || f.club_id::text\n'
    '               AND l.category = ''mint'' AND l.from_type = ''system_mint''\n'
    '               AND l.to_type = ''club_treasury'' AND l.to_entity_id = f.club_id\n'
    '               AND l.amount = 100000 AND l.status = ''posted''\n'
    '          )\n'
    '        )\n'
    '     LIMIT 20';
  IF position(v_new IN v_def) > 0 THEN RETURN; END IF;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_ca_quick_reconcile ledger-failure scan drifted; refusing unsafe patch';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END;
$patch_reconciler$;

-- Resolve only the false opening-grant incident whose canonical mint is
-- present.  The failure row remains immutable forensic evidence.
UPDATE public.ca_drift_incidents i
   SET status = 'resolved',
       root_cause = 'Obsolete first-club owner-wallet bonus reused the canonical opening-bank idempotency key.',
       resolution = 'Removed the owner-wallet bonus; verified the 100,000-chip system mint in the Club Bank and corrected the untouched owner wallet to zero.',
       correction_ref = '20260901004500_opening_club_bank_is_not_drift',
       resolved_at = now(),
       last_seen_at = now()
 WHERE i.status <> 'resolved'
   AND i.source = 'fn_ca_quick_reconcile:ledger_write_failure'
   AND EXISTS (
     SELECT 1 FROM public.ca_ledger_write_failures f
     JOIN public.chip_ledger l
       ON l.club_id = f.club_id
      AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
      AND l.category = 'mint' AND l.from_type = 'system_mint'
      AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
      AND l.amount = 100000 AND l.status = 'posted'
    WHERE i.dedupe_key = 'qr:lwf:' || f.id::text
      AND f.sqlstate = '23505'
      AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
   );

-- Preserve the forensic record while removing every open incident that is
-- outside the user-defined Midway control boundary.
UPDATE public.ca_drift_incidents i
   SET status = 'resolved',
       root_cause = COALESCE(i.root_cause, 'Incident was outside the Midway Union control boundary.'),
       resolution = 'Closed after Drift Incident monitoring was restricted to Midway Union and its affiliated clubs.',
       correction_ref = '20260901004500_midway_scope',
       resolved_at = now(),
       last_seen_at = now()
 WHERE i.status <> 'resolved'
   AND NOT public.fn_ca_is_midway_scope(
     i.union_id, i.club_id, i.table_id, i.tournament_id, i.metadata
   );

DO $assert$
DECLARE v_src text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.club_members'::regclass
       AND tgname = 'trg_first_club_creation_bonus' AND tgenabled <> 'D'
  ) THEN RAISE EXCEPTION 'Legacy first-club owner-wallet bonus trigger is still active'; END IF;

  SELECT pg_get_functiondef('public.fn_ca_quick_reconcile()'::regprocedure) INTO v_src;
  IF v_src NOT LIKE '%club-opening-grant:%'
     OR v_src NOT LIKE '%ux_chip_ledger_idempotency_key%'
  THEN RAISE EXCEPTION 'Opening-bank duplicate classification is missing'; END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure
  ) INTO v_src;
  IF v_src NOT LIKE '%fn_ca_is_midway_scope%'
  THEN RAISE EXCEPTION 'Drift Incident writer is not restricted to Midway Union'; END IF;
END;
$assert$;

COMMIT;
