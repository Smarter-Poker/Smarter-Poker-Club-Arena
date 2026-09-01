-- ═══════════════════════════════════════════════════════════════════════════
-- ONE PAGE PER FINDING, NOT ONE PER ROW
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan, 2026-09-01: "im getting double push notifications for every chip drift
-- again, thats has to stop, one notification one time is all that i need."
--
-- The word that matters is AGAIN. This has been "fixed" twice, both times with
-- a clock, and a clock cannot fix it. Here is the evidence and the mechanism.
--
-- WHAT DAN ACTUALLY RECEIVED (production, notifications + push_outbox)
--
--   2026-09-01 17:28:48.927063  "Chip drift: unauthorized_adjustment (0.00)"
--   2026-09-01 17:28:48.927145  "Chip drift: unauthorized_adjustment (0.00)"
--       -> 82 MICROSECONDS apart. Two ca_drift_incidents rows,
--          bb02c201-... and 4a15aff5-..., identical in every field a reader
--          can see, differing only in the md5 salt inside dedupe_key.
--
--   2026-09-01 13:42:17.910620  "Resolved: treasury_error drift"  x3
--   2026-08-31 20:10:20.800684  "Resolved: unauthorized_adjustment drift" x20+
--       -> all at ONE timestamp, from one bulk resolve.
--
-- THE TWO CODE PATHS THAT PRODUCED THEM
--
--   1. fn_ca_journal_append_only is a per-ROW trigger. Its dedupe_key carried
--      a per-row salt, so a single multi-row DELETE minted one incident per
--      row, and fn_ca_raise_drift_incident pushed once per incident. Today's
--      20260901174548 migration removed the salt but kept a per-DAY bucket in
--      the key, so the same standing condition still re-pages every midnight.
--
--   2. fn_ca_incident_action('resolve') and fn_ca_auto_reconcile_tick both
--      call fn_ca_incident_notify once per incident inside a loop. Twenty-five
--      incidents that are one finding become twenty-five pushes in one tick.
--
--   And a third that re-pages rather than double-pages, same root cause:
--      fn_ca_suspense_regression_check keys on
--      'suspense-regression:YYYY-MM-DD-HH24'. The HOUR is in the key, so an
--      unchanged condition mints a brand-new incident and a brand-new page
--      every single hour. 17:30 and 18:00 today.
--
-- WHY THE PREVIOUS TWO FIXES DID NOT HOLD - BOTH WERE CLOCKS
--
--   a. fn_ca_raise_drift_incident suppresses when >= 10 incidents were created
--      in the last 2 minutes. A pair never reaches ten. It has never once
--      fired for the case Dan is complaining about.
--
--   b. fn_ca_incident_notify's "DIGEST MODE (2026-08-31)" collapses when a
--      recipient already has >= 3 financial pushes in the last 5 minutes. The
--      count is taken BEFORE sending, so notification one and notification two
--      ALWAYS go out and only the third onward collapses. A double is
--      structurally immune to a three-in-five-minutes digest. That is not a
--      coincidence in Dan's report - the threshold is why he gets exactly two.
--
--   c. The same 2026-08-31 pass made resolution pushes criticals-only. That is
--      a severity filter, not a dedupe: a bulk resolve of three CRITICAL
--      treasury_error incidents still sent three pushes, which is exactly what
--      13:42:17.910620 is.
--
-- THE FIX: KEY THE SEND ON THE FINDING, AND ON ITS STATE
--
--   ca_incident_notify_ledger records, per recipient, the last state that was
--   actually delivered for a FINDING. A finding is the dedupe_key with the two
--   things that were never part of the finding stripped off - the per-row salt
--   and the time bucket - plus the scope it belongs to. The state is the kind
--   of notice (raised / escalated / resolved), the severity, the
--   classification, the layer and the scope. It is NOT the amount: a standing
--   drift whose number jitters from 5929.18 to 5960.92 every hour is the same
--   finding and must not page twice.
--
--   A send happens only when the (recipient, finding) row does not exist or
--   its state has actually changed. That is an upsert with a WHERE clause, so
--   two callers racing inside one statement cannot both win.
--
--   This is not a window. Nothing expires. Consequences, all intended:
--     * N incident rows for one finding  -> ONE page.
--     * a bulk resolve of N of them      -> ONE page.
--     * severity warning -> critical     -> pages immediately (state changed).
--     * a new classification / club      -> pages immediately (new finding).
--     * each escalation level            -> pages once (level is in the state).
--     * resolved, then it recurs         -> pages again (raised != resolved).
--     * the same finding, still standing -> silent, exactly as Dan asked.
--
--   The digest block is DELETED, not tuned. It was the failed clock, and it
--   also collapsed genuinely different findings into "see dashboard", which
--   loses signal. The structural gate makes it unnecessary.
--
--   The 10-in-2-minutes backstop in fn_ca_raise_drift_incident is deliberately
--   LEFT ALONE. It is a last-resort circuit breaker against a storm of
--   genuinely distinct findings, not the primary dedupe, and removing it is a
--   separate decision with its own risk.
--
--   Producers 1 and 3 are also fixed at source, so one finding is one incident
--   row for its whole life and the ledger has less to do.

BEGIN;

-- the delivery record: one row per (recipient, finding)
CREATE TABLE IF NOT EXISTS public.ca_incident_notify_ledger (
  recipient_id     uuid        NOT NULL,
  finding_key      text        NOT NULL,
  state_hash       text        NOT NULL,
  last_kind        text,
  last_incident_id uuid,
  last_sent_at     timestamptz NOT NULL DEFAULT now(),
  send_count       integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (recipient_id, finding_key)
);

ALTER TABLE public.ca_incident_notify_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_incident_notify_ledger FROM PUBLIC;
REVOKE ALL ON public.ca_incident_notify_ledger FROM anon, authenticated;

COMMENT ON TABLE public.ca_incident_notify_ledger IS
  'What was actually delivered, keyed on the FINDING rather than on the incident row. fn_ca_incident_notify sends only when this table has no row for the (recipient, finding) or its state_hash has changed. Replaces the 5-minute digest window, which let every double through because it only collapsed from the third push onward.';

COMMENT ON COLUMN public.ca_incident_notify_ledger.finding_key IS
  'fn_ca_finding_key(dedupe_key, ...): the dedupe key with per-row salts and time buckets removed, plus scope. Two incident rows that are the same finding share it.';

COMMENT ON COLUMN public.ca_incident_notify_ledger.state_hash IS
  'kind + severity + classification + layer + scope (+ escalation level). Deliberately excludes the amount: a standing drift whose number jitters is the same finding and must not re-page.';

-- what counts as "the same finding"
CREATE OR REPLACE FUNCTION public.fn_ca_finding_key(
  p_dedupe_key     text,
  p_classification text,
  p_layer          text,
  p_club_id        uuid,
  p_union_id       uuid)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  k text := COALESCE(p_dedupe_key, '');
  before text;
BEGIN
  -- Strip, repeatedly, the two things that were never part of the finding:
  -- a per-row salt (uuid or md5) and a time bucket (YYYY-MM-DD[-HH]). Looping
  -- handles a key that carries both, in either order.
  FOR i IN 1..4 LOOP
    before := k;
    k := regexp_replace(k, ':[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', '');
    k := regexp_replace(k, ':[0-9a-fA-F]{32}$', '');
    k := regexp_replace(k, ':[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?$', '');
    EXIT WHEN k = before;
  END LOOP;

  IF k = '' THEN
    k := COALESCE(p_classification, 'unknown');
  END IF;

  RETURN k
      || '|' || COALESCE(p_layer, 'unknown')
      || '|' || COALESCE(p_club_id::text, '-')
      || '|' || COALESCE(p_union_id::text, '-');
END $function$;

COMMENT ON FUNCTION public.fn_ca_finding_key(text, text, text, uuid, uuid) IS
  'The identity of a drift FINDING, independent of how many incident rows happen to describe it and of what time it is. Never put a clock or a row id in a notification key again - that is what caused the 2026-08-31 storm and the 2026-09-01 doubles.';

-- the only sender, now gated on the finding
CREATE OR REPLACE FUNCTION public.fn_ca_incident_notify(
  p_incident_id uuid,
  p_kind text,
  p_headline text,
  p_senior_only boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inc  public.ca_drift_incidents;
  rec  uuid;
  n    int := 0;
  club_name  text;
  union_name text;
  body text;
  age_min int;
  v_finding text;
  v_state   text;
  v_kind    text;
  v_fresh   boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  body := format(
    '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
    upper(inc.severity),
    inc.classification,
    to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
    inc.layer,
    COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
    COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
    COALESCE('Club ' || club_name || '. ', ''),
    COALESCE('Union ' || union_name || '. ', ''),
    age_min,
    to_char(inc.deadline_at, 'HH24:MI UTC'),
    inc.auto_repair_status
  );

  -- WHAT is being reported, and in WHAT STATE. The amount is not in the state
  -- on purpose: a standing drift whose number moves is the same finding.
  v_finding := public.fn_ca_finding_key(
                 inc.dedupe_key, inc.classification, inc.layer,
                 inc.club_id, inc.union_id);
  v_kind := CASE
              WHEN p_kind = 'escalated'    THEN 'escalated'
              WHEN inc.status = 'resolved' THEN 'resolved'
              ELSE 'raised'
            END;
  v_state := md5(
      v_kind
      || '|' || COALESCE(inc.severity,'?')
      || '|' || COALESCE(inc.classification,'?')
      || '|' || COALESCE(inc.layer,'?')
      || '|' || COALESCE(inc.club_id::text,'-')
      || '|' || COALESCE(inc.union_id::text,'-')
      -- each escalation LEVEL is its own state, so a critical still gets its
      -- drumbeat while a repeat of the same level stays quiet
      || '|' || CASE WHEN v_kind = 'escalated'
                     THEN COALESCE(inc.escalation_level, 0)::text ELSE '' END);

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      -- ONE PAGE PER FINDING (2026-09-01). The upsert IS the dedupe: it
      -- succeeds only when this recipient has never been told about this
      -- finding, or when the finding's state has genuinely changed. Two
      -- callers racing inside one statement cannot both win it, which is
      -- precisely what the 82-microsecond double at 17:28:48 was.
      v_fresh := NULL;
      INSERT INTO public.ca_incident_notify_ledger AS l
        (recipient_id, finding_key, state_hash, last_kind, last_incident_id)
      VALUES (rec, v_finding, v_state, v_kind, inc.id)
      ON CONFLICT (recipient_id, finding_key) DO UPDATE
        SET state_hash       = EXCLUDED.state_hash,
            last_kind        = EXCLUDED.last_kind,
            last_incident_id = EXCLUDED.last_incident_id,
            last_sent_at     = now(),
            send_count       = l.send_count + 1
        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
      RETURNING true INTO v_fresh;

      IF NOT COALESCE(v_fresh, false) THEN
        INSERT INTO public.ca_incident_events (incident_id, kind, detail)
        VALUES (inc.id, 'notified',
                jsonb_build_object('already_reported', true,
                                   'finding_key', v_finding,
                                   'state', v_kind,
                                   'recipient', rec));
        CONTINUE;
      END IF;

      PERFORM public.fn_raise_notification(
        rec,
        'financial_incident',
        left(p_headline, 110),
        left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object(
          'incident_id', inc.id,
          'finding_key', v_finding,
          'classification', inc.classification,
          'severity', inc.severity,
          'discrepancy', inc.discrepancy_amount,
          'club_id', inc.club_id,
          'union_id', inc.union_id,
          'deadline_at', inc.deadline_at
        )
      );
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'notify_failed',
              jsonb_build_object('recipient', rec, 'error', SQLERRM));
    END;
  END LOOP;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (inc.id, p_kind,
          jsonb_build_object('headline', p_headline, 'recipients', n,
                             'senior_only', p_senior_only, 'age_min', age_min,
                             'finding_key', v_finding, 'state', v_kind));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $function$;

COMMENT ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) IS
  'The only path from a drift incident to a human. Sends once per (recipient, finding, state) via ca_incident_notify_ledger. Do not add a time window here - two have been tried (10-in-2-minutes, 3-in-5-minutes) and both let every double through by construction.';

-- producer 1: the journal trigger keys on the maintenance, not on the day
CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    /* ONE INCIDENT PER KIND OF MAINTENANCE, FOR AS LONG AS IT IS OPEN.
       20260901174548 grouped by reason prefix and added the DAY, which stops
       the per-run flood but re-pages every midnight for a condition nobody has
       resolved. The day is gone: occurrences count the rows, the mutation log
       holds them whole, and resolving the incident is what re-arms the alarm. */
    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

-- producer 2: the suspense watch keys on the regression, not on the hour
CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows integer; v_chips numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_rows, v_chips
  FROM public.chip_ledger
  WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
    AND created_at > now() - interval '60 minutes'
    -- the suspense drain went live 2026-08-31 19:01 UTC; never alarm on older flow
    AND created_at > '2026-09-01 00:17:00+00';

  IF v_rows > 10 OR v_chips > 50 THEN
    -- NO HOUR IN THE KEY (2026-09-01). It used to be
    -- 'suspense-regression:YYYY-MM-DD-HH24', so an unchanged condition minted
    -- a fresh incident and paged Dan on the hour, every hour, all day. The
    -- regression is the finding; occurrences and the amounts on the row carry
    -- how big it is now, and resolving it is what re-arms the alarm.
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_suspense_regression_check', 'unauthorized_adjustment', 'warning',
      'suspense-regression',
      round(v_chips, 2), NULL, NULL, 'ledger', 'settlement_suspense',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'unclassified (suspense) flow returned after the phase-2 drain: '
        || v_rows || ' rows / ' || round(v_chips, 2) || ' chips in the last hour'
        || ' - a money path lost (or never had) its category declaration',
      false, jsonb_build_object('rows_last_hour', v_rows, 'chips_last_hour', round(v_chips, 2)));
    RETURN 1;
  END IF;
  RETURN 0;
END $function$;

-- Operator and engine telemetry only. Production already had these locked;
-- named here so the definer-authorization gate can see it in the same file
-- that declares them, and so a fresh clone reproduces the live grants.
-- PUBLIC is named as well as anon: anon inherits whatever PUBLIC holds, so
-- revoking anon alone reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_ca_suspense_regression_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_suspense_regression_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_finding_key(text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_finding_key(text, text, text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) TO service_role;

COMMIT;
