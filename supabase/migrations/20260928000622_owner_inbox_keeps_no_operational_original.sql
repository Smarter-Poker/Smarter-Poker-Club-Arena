-- 20260928000622_owner_inbox_keeps_no_operational_original.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE OWNER'S PERSONAL INBOX KEEPS NO OPERATIONAL ORIGINAL.
--
-- WHY. Store-only delivery (20260927235053) stops new operational
-- notifications from ever reaching the owner account's personal inbox. The
-- rows written before it are still there: 899 on 2026-09-27, 901 on
-- 2026-09-28 (the count grows until store-only delivery is installed), every
-- one already captured in operational_notification_destinations (its
-- complete original) and receipted in operational_alert_events for the
-- Production Alerts task. The owner's rule is that operational content does
-- not live in his personal inbox at all, so they are removed here - once,
-- each only after it is proven preserved. This is settling damage already
-- done, not a repair job: no function, trigger or schedule is created.
--
-- WHAT IT DOES.
--   1. Proves in UTC. to_jsonb renders a timestamptz in the session's time
--      zone, and every captured original was rendered in UTC, so
--      SET LOCAL TimeZone='UTC' keeps the proof independent of the
--      installer's session.
--   2. Takes ROW EXCLUSIVE on notifications first - the lock its DELETE
--      takes anyway. It does not wait for or block ordinary INSERT, UPDATE
--      or DELETE, but no trigger, rule or foreign key can be added to or
--      enabled on notifications until COMMIT (each needs a lock this one
--      conflicts with), so what 3 and 4 check is what the DELETE meets.
--   3. Refuses unless store-only delivery is installed COMPLETELY: every
--      @live-proof expression of 20260927235053 - the capture and its three
--      readers at their post-image md5, the capture trigger, and the
--      authority and detector triggers enabled with their functions - is
--      re-checked below, verbatim, and the refusal names each piece missing.
--      Half installed, a reader could still take the personal row as proof of
--      delivery, and removing the row would make an old alert raise again.
--   4. Refuses unless the DELETE can reach nothing but the rows it removes:
--      the foreign keys into notifications are exactly
--      push_outbox(accounting_notification_id) and
--      accounting_invoice_deliveries(notification_id), both NO ACTION (a
--      CASCADE or SET NULL key would delete or rewrite rows elsewhere, and
--      the reference check in 7 reads only these two); notifications has no
--      DELETE or TRUNCATE trigger of its own (only those two keys' internal
--      ones), no rule and no child table. The refusal names each one found.
--      A child attached after this check (attaching needs only a lock ROW
--      EXCLUSIVE does not block) is never reached: the candidates, the proof,
--      the keep and the DELETE all read notifications ONLY, so no row of a
--      child is locked, proven, kept or deleted, and no trigger of a child
--      runs inside this transaction - where the locks in 5 would not stop it.
--      Only the completeness check in 9 reads through children, so an
--      operational row a child holds makes the cleanup refuse.
--   5. Locks what it proves, until COMMIT: every owner-operational row FOR
--      UPDATE, taking its id (everything below works on exactly that id set);
--      then each one's destination, and every receipt those destinations
--      name, FOR SHARE and in key order - each in a statement of its own, as
--      a lock cannot sit on the nullable side of the proof's outer joins.
--      Removing or changing a held destination or receipt waits for this
--      transaction; one removed or changed before it was held is proven as it
--      now stands, and refused; and the proof counts only the rows held, so a
--      destination or receipt written after the locks is no proof. A writer
--      that locks one of these rows per transaction, or a destination before
--      its receipt, cannot deadlock with this order
--      (fn_try_record_owner_notification locks the destination before it
--      records the receipt; the capture writes new rows only). A transaction
--      that locks two or more held rows in another order - the Production
--      Alerts task updating two receipts in descending id order - can: then
--      PostgreSQL aborts one of the two, this migration with nothing changed
--      or that writer's transaction, which must be retried. Neither removes
--      an unpreserved row.
--   6. Proves each row preserved: a destination for the owner and the fleet
--      task; the destination's receipt is this row's own receipt
--      (owner-operational-notifications, event_key = its id, addressed to the
--      fleet task); and both the captured original and the receipt's copy
--      equal the row in everything but read state (read, is_read, read_at,
--      updated_at). Every comparison is NULL-safe (IS DISTINCT FROM), so a
--      missing copy or key counts as a difference instead of slipping
--      through as unknown. One unproven row aborts the whole migration, and
--      the refusal counts the rows per cause: no destination, pending
--      receipt, receipt not the row's own task receipt, content differs (a
--      destination not held in 5 counts as none, a receipt not held as not
--      the row's own).
--   7. Refuses if either foreign key into notifications - pinned in 4 -
--      references one of them (0 references measured), naming the reason
--      instead of failing on the DELETE.
--   8. Keeps each row exactly as it stands (read state included) in
--      owner_inbox_operational_removals, keyed by notification id: the only
--      state the capture did not hold.
--   9. Deletes exactly those rows, each only while it still equals the copy
--      just kept, and requires that every one was removed and that no
--      owner-operational row remains, read through any child table.
--
-- WHAT DOES NOT CHANGE. The owner's ordinary notices (welcome, settings,
-- invoices, financial digests - financial_digest is not operational and
-- stays; estate_digest is, and is removed), every other account's
-- notifications, the destinations, the receipts and their investigation
-- state. push_outbox history is a record of past device deliveries and is
-- left as it is (705 sent or skipped rows keep a soft related_entity_id to a
-- removed id).
--
-- ORDER AND WINDOW.
--   1. World Hub PR "notify() confirms a routed original by the id it chose"
--      deployed: its push-health cooldown reads destinations, so removing the
--      owner's personal "Notifications May Not Be Reaching This Device" row
--      does not restart that cooldown.
--   2. 20260927235053 (store-only delivery), which this refuses to run
--      without.
--   3. This migration, outside :50-:03 UTC (the database refuses DDL inside
--      that window) and off-peak: notifications has REPLICA IDENTITY FULL, so
--      Realtime carries one DELETE event per removed row (about 900). One
--      transaction, so one PostgREST schema reload (~28 s). Until it commits,
--      an update of a held receipt (the Production Alerts task recording its
--      investigation) waits for it, and one updating several in another order
--      may deadlock with it (5); a lock it cannot take within 3 s refuses the
--      install with nothing changed.
--
-- ROLLBACK. Nothing is lost: every removed row is in
-- owner_inbox_operational_removals.personal_row, its original in
-- operational_notification_destinations and its receipt in
-- operational_alert_events. Putting the rows back would re-create the
-- personal copies the owner's rule forbids, so there is no rollback migration.
--
-- LIVE PROOF. False while this is held (the removal record does not exist,
-- and the check behind it is only a string until then, so nothing names a
-- missing table); true only once this ran: the removal record exists and
-- every removed row still has its destination and its task receipt.
--
-- Regression proof: scripts/dev/probe-owner-inbox-cleanup.sh (throwaway
-- PostgreSQL), run by .github/workflows/owner-inbox-cleanup.yml.
--
-- @live-proof: (SELECT CASE WHEN to_regclass('public.owner_inbox_operational_removals') IS NULL THEN false ELSE query_to_xml('SELECT 1 FROM public.owner_inbox_operational_removals r WHERE NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations d JOIN public.operational_alert_events e ON e.id=d.inbox_event_id WHERE d.notification_id=r.notification_id AND e.source=''owner-operational-notifications'' AND e.event_key=r.notification_id::text AND e.payload->>''target_task_id''=''01a09b86-5ba8-7290-8657-1041f13dd3ca'') LIMIT 1', false, true, '')::text = '' END)

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL TimeZone='UTC';
LOCK TABLE public.notifications IN ROW EXCLUSIVE MODE;

DO $guard$
DECLARE v_missing text[] := '{}'; v_reach text[] := '{}'; v_keys text;
BEGIN
  -- Store-only delivery must be installed completely. Each condition is one
  -- of 20260927235053's @live-proof expressions, verbatim.
  IF (SELECT md5(pg_get_functiondef('public.fn_capture_owner_notification_destination()'::regprocedure))='32a9105ef11b28dceac0fce11d71148f') IS NOT TRUE THEN
    v_missing := v_missing || 'capture'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'::regprocedure))='1c240cddb84994e906a4eb09d7ca3323') IS NOT TRUE THEN
    v_missing := v_missing || 'break scorecard reader'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_notify_guarantee_bank_short(uuid)'::regprocedure))='71d3444dfb4ed7906cfefe5267de5b81') IS NOT TRUE THEN
    v_missing := v_missing || 'guarantee bank reader'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_ca_alarm_drill()'::regprocedure))='8bd6f37a4038209adaec7e2bbbdfd5e9') IS NOT TRUE THEN
    v_missing := v_missing || 'alarm drill reader'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_capture_owner_notification_destination' AND t.tgenabled='O' AND t.tgtype=7 AND t.tgqual IS NULL AND t.tgfoid='public.fn_capture_owner_notification_destination()'::regprocedure) IS NOT TRUE THEN
    v_missing := v_missing || 'capture trigger'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_authorize_owner_operational_original' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='7f4ecd63db81d72271f9e25c09a8e69d' AND md5(pg_get_functiondef(t.tgfoid))='7777ab6e22847595881843ebfacdcaad') IS NOT TRUE THEN
    v_missing := v_missing || 'authority trigger'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_owner_operational_original_reached_personal_inbox' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='2d1ee8300c484364c83db0496360b897' AND md5(pg_get_functiondef(t.tgfoid))='d648da8eb87a98e8074e91c8aca7c660') IS NOT TRUE THEN
    v_missing := v_missing || 'detector trigger'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'OWNER_INBOX_CLEANUP_NEEDS_STORE_ONLY_DELIVERY: % missing',
      array_to_string(v_missing, ', ') USING ERRCODE='55000';
  END IF;

  -- The DELETE must reach nothing but the rows it removes (header 4). Read
  -- from production 2026-09-28: these two keys, no DELETE or TRUNCATE
  -- trigger of its own, no rule, no child.
  SELECT string_agg(s, '; ' ORDER BY s COLLATE "C") INTO v_keys
    FROM (SELECT concat_ws(' ', format('%I.%I', rn.nspname, r.relname),
                   (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
                     WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)),
                   (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
                     WHERE a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey)),
                   c.confdeltype) AS s
            FROM pg_constraint c
            JOIN pg_class r ON r.oid=c.conrelid
            JOIN pg_namespace rn ON rn.oid=r.relnamespace
           WHERE c.contype='f' AND c.confrelid='public.notifications'::regclass) x;
  IF v_keys IS DISTINCT FROM 'public.accounting_invoice_deliveries notification_id id a; public.push_outbox accounting_notification_id id a' THEN
    v_reach := v_reach || format('foreign keys into notifications (%s)', coalesce(v_keys, 'none'));
  END IF;
  -- tgtype bit 8 is DELETE, bit 32 TRUNCATE; the internal ones belong to the
  -- two NO ACTION keys just pinned.
  v_reach := v_reach || ARRAY(SELECT format('trigger %s', t.tgname) FROM pg_trigger t
                               WHERE t.tgrelid='public.notifications'::regclass AND NOT t.tgisinternal
                                 AND (t.tgtype & 40)<>0 ORDER BY 1);
  v_reach := v_reach || ARRAY(SELECT format('rule %s', w.rulename) FROM pg_rewrite w
                               WHERE w.ev_class='public.notifications'::regclass ORDER BY 1);
  v_reach := v_reach || ARRAY(SELECT format('child table %s', i.inhrelid::regclass) FROM pg_inherits i
                               WHERE i.inhparent='public.notifications'::regclass ORDER BY 1);
  IF cardinality(v_reach) > 0 THEN
    RAISE EXCEPTION 'OWNER_INBOX_CLEANUP_DELETE_NOT_CONFINED: %', array_to_string(v_reach, ', ')
      USING ERRCODE='55000';
  END IF;
END;
$guard$;

-- No foreign key: removing or pruning anything elsewhere must never erase
-- this record, the same rule operational_notification_destinations follows.
CREATE TABLE public.owner_inbox_operational_removals (
  notification_id uuid PRIMARY KEY,
  removed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  personal_row jsonb NOT NULL CHECK (jsonb_typeof(personal_row)='object')
);
ALTER TABLE public.owner_inbox_operational_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_inbox_operational_removals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.owner_inbox_operational_removals TO service_role;
COMMENT ON TABLE public.owner_inbox_operational_removals IS
  'Each owner personal-inbox row removed by 20260928000622, exactly as it stood. Its original is operational_notification_destinations.original_notification; its receipt is operational_alert_events (source owner-operational-notifications).';

DO $cleanup$
DECLARE
  c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_task constant uuid := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  c_read_state constant text[] := ARRAY['read','is_read','read_at','updated_at'];
  v_ids uuid[]; v_total integer; v_kept integer; v_removed integer;
  v_held_destinations uuid[]; v_named_receipts bigint[]; v_held_receipts bigint[];
  v_no_destination integer; v_pending integer; v_foreign_receipt integer; v_differs integer;
BEGIN
  -- Lock every candidate and take its id: the rows proven, kept and removed
  -- below are exactly these, and a mark-read arriving meanwhile waits for
  -- this transaction instead of changing a row between its proof and its
  -- removal. ONLY here and in the proof, the keep and the DELETE: a child
  -- table attached meanwhile is never read or written, so none of its
  -- triggers runs inside this transaction (header 4).
  SELECT coalesce(array_agg(s.id ORDER BY s.id), '{}') INTO v_ids
    FROM (SELECT n.id FROM ONLY public.notifications n
           WHERE n.user_id=c_owner
             AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data)
             FOR UPDATE) s;
  v_total := cardinality(v_ids);

  -- Hold what the proof reads until COMMIT (header 5): their destinations,
  -- then the receipts those destinations name, FOR SHARE, in key order. Each
  -- statement returns the rows as it locked them, and the proof below counts
  -- only these, so what it proves is what stands at COMMIT: a second session
  -- removing or changing one of them waits for this transaction.
  SELECT coalesce(array_agg(h.notification_id), '{}'), coalesce(array_agg(h.inbox_event_id), '{}')
    INTO v_held_destinations, v_named_receipts
    FROM (SELECT d.notification_id, d.inbox_event_id
            FROM public.operational_notification_destinations d
           WHERE d.notification_id = ANY(v_ids)
           ORDER BY d.notification_id FOR SHARE) h;
  SELECT coalesce(array_agg(h.id), '{}') INTO v_held_receipts
    FROM (SELECT e.id FROM public.operational_alert_events e
           WHERE e.id = ANY(v_named_receipts)
           ORDER BY e.id FOR SHARE) h;

  -- Each row's first unmet proof. Every comparison is IS DISTINCT FROM: a
  -- NULL on either side (a receipt without its copy, a key it lacks) is a
  -- difference, never an unknown that falls through as proven.
  SELECT count(*) FILTER (WHERE x.cause='no destination'),
         count(*) FILTER (WHERE x.cause='pending receipt'),
         count(*) FILTER (WHERE x.cause='foreign receipt'),
         count(*) FILTER (WHERE x.cause='content differs')
    INTO v_no_destination, v_pending, v_foreign_receipt, v_differs
    FROM (SELECT CASE
            WHEN d.notification_id IS NULL THEN 'no destination'
            WHEN d.inbox_event_id IS NULL THEN 'pending receipt'
            WHEN e.source IS DISTINCT FROM 'owner-operational-notifications'
              OR e.event_key IS DISTINCT FROM n.id::text
              OR e.payload->>'target_task_id' IS DISTINCT FROM c_task::text THEN 'foreign receipt'
            WHEN (d.original_notification - c_read_state) IS DISTINCT FROM (to_jsonb(n) - c_read_state)
              OR ((e.payload->'original_notification') - c_read_state) IS DISTINCT FROM (to_jsonb(n) - c_read_state)
              THEN 'content differs'
          END AS cause
            FROM ONLY public.notifications n
            LEFT JOIN public.operational_notification_destinations d
              ON d.notification_id=n.id AND d.notification_id = ANY(v_held_destinations)
             AND d.recipient_user_id=n.user_id AND d.target_task_id=c_task
            LEFT JOIN public.operational_alert_events e
              ON e.id=d.inbox_event_id AND e.id = ANY(v_held_receipts)
           WHERE n.id = ANY(v_ids)) x;
  IF v_no_destination + v_pending + v_foreign_receipt + v_differs > 0 THEN
    RAISE EXCEPTION 'OWNER_INBOX_CLEANUP_UNPROVEN: % of % owner operational rows are not proven preserved (no destination %, pending receipt %, receipt not the row''s own task receipt %, content differs %)',
      v_no_destination + v_pending + v_foreign_receipt + v_differs, v_total,
      v_no_destination, v_pending, v_foreign_receipt, v_differs USING ERRCODE='55000';
  END IF;

  -- The only two foreign keys into notifications (pinned by the guard).
  IF EXISTS (SELECT 1 FROM public.push_outbox p WHERE p.accounting_notification_id = ANY(v_ids))
    OR EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries a WHERE a.notification_id = ANY(v_ids)) THEN
    RAISE EXCEPTION 'OWNER_INBOX_CLEANUP_REFERENCED' USING ERRCODE='55000';
  END IF;

  INSERT INTO public.owner_inbox_operational_removals(notification_id, personal_row)
  SELECT n.id, to_jsonb(n) FROM ONLY public.notifications n WHERE n.id = ANY(v_ids);
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  -- Plain = on purpose: a NULL on either side removes nothing, and the
  -- completeness check below then refuses.
  DELETE FROM ONLY public.notifications n
   USING public.owner_inbox_operational_removals r
   WHERE n.id = ANY(v_ids) AND r.notification_id=n.id AND r.personal_row=to_jsonb(n);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Not ONLY: an operational row a child table holds is in the owner's inbox
  -- as its readers see it, so it makes the cleanup refuse.
  IF v_kept IS DISTINCT FROM v_total OR v_removed IS DISTINCT FROM v_total
    OR EXISTS (SELECT 1 FROM public.notifications n
                WHERE n.user_id=c_owner
                  AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data)) THEN
    RAISE EXCEPTION 'OWNER_INBOX_CLEANUP_INCOMPLETE: total % kept % removed %', v_total, v_kept, v_removed
      USING ERRCODE='55000';
  END IF;
  RAISE NOTICE 'owner inbox: % operational originals removed, each kept in its destination, receipt and removal record', v_removed;
END;
$cleanup$;

COMMIT;
