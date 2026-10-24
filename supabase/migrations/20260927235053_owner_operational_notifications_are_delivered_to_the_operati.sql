-- 20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER-OPERATIONAL NOTIFICATIONS ARE DELIVERED TO THE OPERATIONAL TASK ONLY.
--
-- WHY. 20260916111614 made every operational notification addressed to the
-- owner account (fn_is_owner_operational_notification) CAPTURE its complete
-- original into operational_notification_destinations and record a receipt in
-- operational_alert_events for the Production Alerts task. It then let the
-- INSERT continue (RETURN NEW), so every operational sender still wrote a row
-- into the owner's personal inbox and relied on masking to hide it: a
-- RESTRICTIVE RLS policy, the personal_notifications view and the push-mirror
-- WHEN predicate. Measured 2026-09-27T23:35Z: 899 such rows in the owner's
-- public.notifications, 5 written in the previous 24h (financial_incident,
-- financial_attestation, estate_digest, system "Push Health Alert"). Masking a
-- row is a promise every present and future reader has to keep. Two did not:
-- the World Hub Realtime feed painted them until World Hub #1996 (merged
-- 2026-09-27), and the SECURITY DEFINER readers get_unified_user_profile and
-- get_user_cross_product_summary still count them, and list the newest five,
-- for the owner. The owner's rule (Production Alerts handoff, 2026-09-26) is
-- that operational content is never written to his personal inbox at all.
--
-- WHAT CHANGES.
--   1. STORE-ONLY. fn_capture_owner_notification_destination returns NULL
--      after it has captured and recorded the original, so the personal row
--      is never written. The destination row keeps the complete pre-routing
--      original, the receipt is verified as before, and a failed receipt
--      stays pending on the destination row (fn_retry_owner_notification_destination
--      and fn_capture_owner_notification_history retry it from there when they
--      are called; nothing schedules them). An ordinary notification, any
--      other recipient, and the owner's ordinary notices (welcome, settings,
--      invoices, financial digests) are untouched.
--   2. AUTHORITY. A BEFORE trigger that returns NULL ends the INSERT for that
--      row: PostgreSQL then applies neither row-level security's WITH CHECK
--      nor any NOT NULL, foreign-key or primary-key check to it. Row-level
--      security was the only thing refusing the public anon key here: anon
--      and authenticated hold INSERT on public.notifications and no INSERT
--      policy admits them (the only one, "Service role inserts", is TO
--      service_role). Returning NULL alone would let anyone holding that key
--      write chosen content into the Production Alerts queue, and plant
--      destination rows the readers in 4 take as proof an alert was already
--      delivered. So zz_authorize_owner_operational_original, a SECURITY
--      INVOKER trigger that runs as the writer - after the two normalizing
--      BEFORE INSERT triggers, before the capture, and only for an
--      owner-operational row - raises row-level security's own refusal for
--      every writer row-level security applies to:
--        42501 new row violates row-level security policy for table "notifications"
--      anon and authenticated, which no INSERT policy admits, get exactly the
--      error they got before. Of the other roles holding INSERT on
--      notifications, pg_write_all_data (no members) is refused before and
--      after, now by the EXECUTE check on the classifier in this trigger's
--      WHEN; supabase_backup_admin, which "Service role inserts" admits
--      through its membership in service_role, is now refused: stricter,
--      never looser. service_role and every postgres-owned SECURITY DEFINER
--      producer (they run as postgres) bypass row-level security and pass, as
--      before. No role holds EXECUTE on its function; PostgreSQL does not
--      check EXECUTE when it fires a trigger. The install refuses unless
--      notifications has the row-level security and the INSERT policy this
--      was written for, and unless no other BEFORE INSERT trigger fires
--      between it and the capture.
--   3. VALIDITY. The capture routes only a row PostgreSQL would have
--      accepted: id, type and title present, the recipient and the actor
--      (when set) naming a profile, no notification already holding the id.
--      Anything else falls through to RETURN NEW, so PostgreSQL refuses it
--      with its own NOT NULL (23502), foreign-key (23503) or primary-key
--      (23505) error and nothing is captured. The install refuses if
--      notifications has a NOT NULL column, constraint or unique index this
--      list does not account for (its four partial unique indexes cover types
--      no owner-operational row can have).
--   4. READERS. The three database readers that used the personal row as
--      proof of delivery now also accept the routed original, or they would
--      repeat or misreport once it stops existing:
--        fn_ca_break_scorecard_push     de-duplicates a break alert by its key;
--        fn_notify_guarantee_bank_short treats a routed copy the task has not
--                                       picked up - its receipt still 'new',
--                                       or still pending - as it treated an
--                                       unread personal copy: outstanding, so
--                                       the shortfall is not recorded again.
--                                       Once the task has picked the receipt
--                                       up (any other status) the next
--                                       shortfall is recorded;
--        fn_ca_alarm_drill              arm 4 counts a routed original as the
--                                       notification the raise must produce.
--      Each is replaced from its own live definition by anchored
--      substitution; pre-image and post-image md5, owner, ACL and settings are
--      asserted.
--   5. DETECTION. zz_owner_operational_original_reached_personal_inbox (AFTER
--      INSERT, only for an owner-operational row) can fire only if such a row
--      reached public.notifications anyway - the capture disabled, bypassed
--      or changed - and records OwnerOperationalOriginalReachedPersonalInbox
--      in operational_alert_events with payload.target_task_id. It records;
--      it never repairs, deletes or retries. It watches INSERT only. It does
--      not catch a recorder failure (the owner's rule: no swallowed
--      exception), so in a double fault - the capture bypassed AND the
--      recorder failing - the INSERT is refused rather than landing in the
--      personal inbox unrecorded.
--   6. The install proves itself in rolled-back subtransactions: as the
--      installer, a synthetic owner financial_incident writes no personal row
--      and one receipted destination; as anon and as authenticated the same
--      INSERT is refused with row-level security's error, by
--      zz_authorize_owner_operational_original, and captures nothing.
--
-- WHAT DOES NOT CHANGE. No table, column, policy, view, schedule, financial
-- record or grant on an existing object. The 899 existing personal rows are
-- removed by the held cleanup 20260928000622, only after each is proven
-- preserved in its destination and receipt.
--
-- ORDER. Nothing in the database can see the gateway, so this order is the
-- installer's to keep:
--   1. World Hub PR "notify() confirms a routed original by the id it chose",
--      deployed and live. After this migration an INSERT ... RETURNING of a
--      routed original returns no row: the old notify() reports that as a
--      failed delivery (the capture itself stands), and the old push-health
--      cooldown, which looks for the owner's personal row, would send its
--      alert again on every run. That PR confirms by destination and reads
--      the cooldown from destinations.
--   2. This migration, outside :50-:03 UTC (the database refuses DDL inside
--      that window). One transaction, so one PostgREST schema reload (~28 s).
--   3. The held cleanup 20260928000622.
--
-- ROLLBACK. A new migration restores the four pre-images (md5 pinned below and
-- in scripts/dev/probe-owner-inbox-store-only.sh) and drops
-- zz_authorize_owner_operational_original,
-- zz_owner_operational_original_reached_personal_inbox and their functions.
--
-- Regression proof: scripts/dev/probe-owner-inbox-store-only.sh (red before,
-- green after, throwaway PostgreSQL built from pinned production state), run
-- by .github/workflows/owner-inbox-store-only.yml.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_capture_owner_notification_destination()'::regprocedure))='32a9105ef11b28dceac0fce11d71148f')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'::regprocedure))='1c240cddb84994e906a4eb09d7ca3323')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_notify_guarantee_bank_short(uuid)'::regprocedure))='71d3444dfb4ed7906cfefe5267de5b81')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_alarm_drill()'::regprocedure))='8bd6f37a4038209adaec7e2bbbdfd5e9')
-- @live-proof: (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_capture_owner_notification_destination' AND t.tgenabled='O' AND t.tgtype=7 AND t.tgqual IS NULL AND t.tgfoid='public.fn_capture_owner_notification_destination()'::regprocedure)
-- @live-proof: (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_authorize_owner_operational_original' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='7f4ecd63db81d72271f9e25c09a8e69d' AND md5(pg_get_functiondef(t.tgfoid))='7777ab6e22847595881843ebfacdcaad')
-- @live-proof: (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_owner_operational_original_reached_personal_inbox' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='2d1ee8300c484364c83db0496360b897' AND md5(pg_get_functiondef(t.tgfoid))='d648da8eb87a98e8074e91c8aca7c660')

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

DO $migration$
DECLARE
  v_oid oid; v_src text; v_next text; v_acl aclitem[]; v_owner oid; v_config text[];
BEGIN
  -- The redirect is the capture trigger returning NULL, so it must be the one
  -- installed by 20260916111614 and the last BEFORE INSERT row trigger: every
  -- normalizing trigger has run before the original is captured.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass
      AND tgname='zz_capture_owner_notification_destination' AND tgenabled='O' AND tgtype=7
      AND NOT tgisinternal AND tgqual IS NULL
      AND tgfoid='public.fn_capture_owner_notification_destination()'::regprocedure) THEN
    RAISE EXCEPTION 'OWNER_CAPTURE_TRIGGER_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass
      AND NOT tgisinternal AND (tgtype & 7)=7
      AND tgname > 'zz_capture_owner_notification_destination') THEN
    RAISE EXCEPTION 'OWNER_CAPTURE_NOT_LAST_BEFORE_INSERT' USING ERRCODE='55000';
  END IF;
  -- AUTHORITY (header 2) stands in for row-level security, which a routed
  -- original never reaches, so it is written for the row-level security
  -- notifications has today: enabled, not forced, and one INSERT policy,
  -- "Service role inserts", TO service_role WITH CHECK (true). Another INSERT
  -- or ALL policy would change whom row-level security admits.
  IF (SELECT NOT relrowsecurity OR relforcerowsecurity FROM pg_class
       WHERE oid='public.notifications'::regclass)
    OR (SELECT string_agg(s, '; ' ORDER BY s COLLATE "C") FROM (
          SELECT concat_ws(' ', p.polname, p.polcmd, p.polpermissive::text,
                   (SELECT string_agg(r::regrole::text, ',' ORDER BY r::regrole::text COLLATE "C")
                      FROM unnest(p.polroles) r),
                   pg_get_expr(p.polwithcheck, p.polrelid)) AS s
            FROM pg_policy p
           WHERE p.polrelid='public.notifications'::regclass AND p.polcmd IN ('a','*')) x)
       IS DISTINCT FROM 'Service role inserts a true service_role true' THEN
    RAISE EXCEPTION 'NOTIFICATIONS_INSERT_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  -- The authority check classifies the row the capture will classify, so no
  -- other BEFORE INSERT trigger may fire between the two.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass
      AND NOT tgisinternal AND (tgtype & 7)=7
      AND tgname > 'zz_authorize_owner_operational_original'
      AND tgname < 'zz_capture_owner_notification_destination') THEN
    RAISE EXCEPTION 'OWNER_AUTHORITY_NOT_NEXT_TO_CAPTURE' USING ERRCODE='55000';
  END IF;
  -- VALIDITY (header 3) re-states the constraints notifications has today:
  -- NOT NULL id, user_id, type and title; the primary key on id; user_id
  -- (ON DELETE CASCADE) and actor_id referencing profiles(id); and four
  -- partial unique indexes whose predicates name types no owner-operational
  -- row can have. Anything else would be a check the capture does not know.
  IF (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
       WHERE a.attrelid='public.notifications'::regclass AND a.attnum>0 AND NOT a.attisdropped
         AND a.attnotnull) IS DISTINCT FROM 'id,title,type,user_id'
    OR (SELECT string_agg(s, '; ' ORDER BY s COLLATE "C") FROM (
          SELECT concat_ws(' ', c.contype,
                   (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
                     WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)),
                   CASE WHEN c.contype='f' THEN (c.confrelid='public.profiles'::regclass)::text END,
                   CASE WHEN c.contype='f' THEN (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                     FROM pg_attribute a WHERE a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey)) END,
                   CASE WHEN c.contype='f' THEN c.confdeltype::text END) AS s
            FROM pg_constraint c
           WHERE c.conrelid='public.notifications'::regclass AND c.contype<>'t') x)
       IS DISTINCT FROM 'f actor_id true id a; f user_id true id c; p id'
    OR (SELECT md5(string_agg(s, E'\n' ORDER BY s COLLATE "C")) FROM (
          SELECT pg_get_indexdef(i.indexrelid) AS s FROM pg_index i
           WHERE i.indrelid='public.notifications'::regclass AND i.indisunique AND NOT i.indisprimary) x)
       IS DISTINCT FROM '43e3e177384d2fbf24b6bc30b928b867' THEN
    RAISE EXCEPTION 'NOTIFICATIONS_CONSTRAINTS_CHANGED' USING ERRCODE='55000';
  END IF;

  -- STORE-ONLY and VALIDITY (header 1 and 3). The owner's operational original is
  -- captured and recorded - only a row PostgreSQL would have accepted - and its
  -- personal row is never written.
  v_oid := 'public.fn_capture_owner_notification_destination()'::regprocedure;
  SELECT pg_get_functiondef(oid), proacl, proowner, proconfig INTO v_src, v_acl, v_owner, v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '765a320465a49f71c26c4b747d61f1fd'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[] THEN
    RAISE EXCEPTION 'OWNER_CAPTURE_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  v_next := replace(replace(v_src,$old$BEGIN
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)$old$,$new$BEGIN
  -- STORE-ONLY DELIVERY (2026-09-27). Returning NULL below ends the INSERT
  -- for this row, so PostgreSQL never applies to it the row-level security
  -- WITH CHECK or any NOT NULL, foreign-key or primary-key check. The
  -- writer's authority is checked first, as the writer, by
  -- zz_authorize_owner_operational_original. And only a row PostgreSQL would
  -- have accepted is routed: id, type and title present, the recipient and
  -- the actor (when set) naming a profile, no notification already holding
  -- the id. Anything else falls through to RETURN NEW, so PostgreSQL refuses
  -- it with its own error and nothing is captured.
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data)
     AND NEW.id IS NOT NULL
     AND NEW.type IS NOT NULL
     AND NEW.title IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id)
     AND (NEW.actor_id IS NULL OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.actor_id))
     AND NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.id = NEW.id) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)$new$),$old$    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- Preserve the original row byte-for-byte, including _push. The DB mirror
    -- predicate below and gateway destination branch suppress personal sends.
    -- This also lets the existing administrative reader recover the same exact
    -- original if the first recorder attempt failed.
  END IF;
  RETURN NEW;$old$,$new$    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- STORE-ONLY DELIVERY (2026-09-27). The owner's operational original is
    -- delivered to the operational task and to nothing else. Its complete
    -- original is the destination row above and the operational_alert_events
    -- receipt it names; a pending receipt is retried from that destination
    -- row, never from a personal inbox row. Returning NULL means no personal
    -- inbox row is written, so no feed, Realtime channel, unread count, push
    -- mirror or SECURITY DEFINER reader can surface it, whatever it filters on.
    RETURN NULL;
  END IF;
  RETURN NEW;$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '32a9105ef11b28dceac0fce11d71148f' THEN
    RAISE EXCEPTION 'OWNER_CAPTURE_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND md5(pg_get_functiondef(oid))='32a9105ef11b28dceac0fce11d71148f') THEN
    RAISE EXCEPTION 'OWNER_CAPTURE_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;

  -- READERS (header 4). A break alert already routed to the task is not
  -- recorded again.
  v_oid := 'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'::regprocedure;
  SELECT pg_get_functiondef(oid), proacl, proowner, proconfig INTO v_src, v_acl, v_owner, v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '0de54de4eee0f2cfee9a5fd9e1e368ff'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_PUSH_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  v_next := replace(v_src,$old$  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN RETURN; END IF;
$old$,$new$  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN RETURN; END IF;
  -- A copy delivered to the operational task has no personal row; its routed
  -- original counts as sent (store-only delivery, 2026-09-27), or every
  -- rescore of this break would record it again.
  IF EXISTS (SELECT 1 FROM public.operational_notification_destinations d
              WHERE d.original_notification->>'type' = 'engine_break_failed'
                AND d.original_notification->'data'->>'key' = v_key) THEN RETURN; END IF;
$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '1c240cddb84994e906a4eb09d7ca3323' THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_PUSH_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND md5(pg_get_functiondef(oid))='1c240cddb84994e906a4eb09d7ca3323') THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_PUSH_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;

  -- READERS (header 4). A guarantee shortfall routed to the task stays
  -- outstanding until the task picks its receipt up.
  v_oid := 'public.fn_notify_guarantee_bank_short(uuid)'::regprocedure;
  SELECT pg_get_functiondef(oid), proacl, proowner, proconfig INTO v_src, v_acl, v_owner, v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '0882ecfbd9a19479f7d6666daab3ea6b'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'GUARANTEE_BANK_SHORT_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  v_next := replace(v_src,$old$    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_uid
         and n.type = 'guarantee_bank_short'
         and coalesce(n.is_read, false) = false
         and n.data->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
    ) then$old$,$new$    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_uid
         and n.type = 'guarantee_bank_short'
         and coalesce(n.is_read, false) = false
         and n.data->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
    ) and not exists (
      -- A copy delivered to the operational task has no personal row to be
      -- read (store-only delivery, 2026-09-27); the task picking up its
      -- receipt is what reading it was. While that receipt is still 'new' -
      -- or still pending, with no receipt yet - the shortfall is outstanding
      -- and is not recorded again. Once the task has picked it up (any other
      -- investigation status), the next shortfall is recorded.
      select 1 from public.operational_notification_destinations d
        left join public.operational_alert_events e on e.id = d.inbox_event_id
       where d.recipient_user_id = v_uid
         and d.original_notification->>'type' = 'guarantee_bank_short'
         and d.original_notification->'data'->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
         and coalesce(e.investigation_status, 'new') = 'new'
    ) then$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '71d3444dfb4ed7906cfefe5267de5b81' THEN
    RAISE EXCEPTION 'GUARANTEE_BANK_SHORT_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND md5(pg_get_functiondef(oid))='71d3444dfb4ed7906cfefe5267de5b81') THEN
    RAISE EXCEPTION 'GUARANTEE_BANK_SHORT_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;

  -- READERS (header 4). The alarm drill counts a routed original as the
  -- notification.
  v_oid := 'public.fn_ca_alarm_drill()'::regprocedure;
  SELECT pg_get_functiondef(oid), proacl, proowner, proconfig INTO v_src, v_acl, v_owner, v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '8b413171b63deabceaf13d15a2ff6ebf'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    RAISE EXCEPTION 'ALARM_DRILL_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  v_next := replace(v_src,$old$      SELECT count(*) INTO v_n FROM notifications
       WHERE type='financial_incident' AND created_at > now() - interval '5 seconds';$old$,$new$      -- A routed original notifies too: the owner's copy is delivered to the
      -- operational task only (store-only delivery, 2026-09-27).
      SELECT (SELECT count(*) FROM notifications
               WHERE type='financial_incident' AND created_at > now() - interval '5 seconds')
           + (SELECT count(*) FROM operational_notification_destinations
               WHERE original_notification->>'type' = 'financial_incident'
                 AND captured_at > now() - interval '5 seconds')
        INTO v_n;$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '8bd6f37a4038209adaec7e2bbbdfd5e9' THEN
    RAISE EXCEPTION 'ALARM_DRILL_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND md5(pg_get_functiondef(oid))='8bd6f37a4038209adaec7e2bbbdfd5e9') THEN
    RAISE EXCEPTION 'ALARM_DRILL_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
END;
$migration$;

-- AUTHORITY (header 2). The capture returns NULL for an owner-operational
-- original, and PostgreSQL applies row-level security's WITH CHECK only to a
-- row a BEFORE trigger lets through, so the writer's authority is checked
-- here instead, as the writer. SECURITY INVOKER, so row_security_active()
-- answers for the role that wrote the row; named to fire after
-- trg_notification_fill_action_url and trg_sync_notification_read_state
-- (it classifies the normalized row the capture will see) and before
-- zz_capture_owner_notification_destination. No role holds EXECUTE on it:
-- PostgreSQL does not check EXECUTE when it fires a trigger.
CREATE FUNCTION public.fn_authorize_owner_operational_original()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public AS $body$
BEGIN
  -- Row-level security applies to every writer that neither bypasses it nor
  -- owns the table, and on public.notifications no INSERT policy admits those
  -- writers (the only one, "Service role inserts", is TO service_role), so
  -- for them this raises exactly what row-level security raises: anon and
  -- authenticated are refused. The one writer it treats more strictly is
  -- supabase_backup_admin, which that policy admits through its service_role
  -- membership. service_role, and every postgres-owned SECURITY DEFINER
  -- producer (they run as postgres), bypass row-level security and pass. An
  -- INSERT policy added for anon or authenticated must change this trigger in
  -- the same migration.
  IF row_security_active('public.notifications'::regclass) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "notifications"'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_authorize_owner_operational_original()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_authorize_owner_operational_original
  BEFORE INSERT ON public.notifications FOR EACH ROW
  WHEN (public.fn_is_owner_operational_notification(NEW.user_id, NEW.type, NEW.title, NEW.data))
  EXECUTE FUNCTION public.fn_authorize_owner_operational_original();

-- DETECTION (header 5). Reached only when an owner-operational original was
-- written to the personal inbox anyway.
CREATE FUNCTION public.fn_owner_operational_original_reached_personal_inbox()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
BEGIN
  -- zz_capture_owner_notification_destination returns NULL for every
  -- owner-operational original, so a row here means that capture was
  -- disabled, bypassed or changed. Record it for the operational task (never
  -- a phone or an inbox) and leave the row as the evidence; this never repairs.
  PERFORM public.fn_record_operational_alert(
    'owner-inbox-routing-guard', NEW.id::text,
    'OwnerOperationalOriginalReachedPersonalInbox', 'firing', 'critical',
    jsonb_build_object('notification_id', NEW.id, 'user_id', NEW.user_id,
      'type', NEW.type, 'title', left(NEW.title, 240), 'created_at', NEW.created_at,
      'target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca'));
  RETURN NULL;
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_owner_operational_original_reached_personal_inbox()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_owner_operational_original_reached_personal_inbox
  AFTER INSERT ON public.notifications FOR EACH ROW
  WHEN (public.fn_is_owner_operational_notification(NEW.user_id, NEW.type, NEW.title, NEW.data))
  EXECUTE FUNCTION public.fn_owner_operational_original_reached_personal_inbox();

DO $verify$
DECLARE
  v_id uuid := gen_random_uuid(); v_rows integer; v_dest integer;
  v_role text; v_msg text; v_ctx text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid='public.fn_owner_operational_original_reached_personal_inbox()'::regprocedure
        AND proowner='postgres'::regrole::oid AND prosecdef
        AND proacl::text='{postgres=X/postgres}'
        AND md5(pg_get_functiondef(oid))='d648da8eb87a98e8074e91c8aca7c660') THEN
    RAISE EXCEPTION 'OWNER_INBOX_DETECTOR_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid='public.fn_authorize_owner_operational_original()'::regprocedure
        AND proowner='postgres'::regrole::oid AND NOT prosecdef
        AND proacl::text='{postgres=X/postgres}'
        AND proconfig=ARRAY['search_path=pg_catalog, public']::text[]
        AND md5(pg_get_functiondef(oid))='7777ab6e22847595881843ebfacdcaad') THEN
    RAISE EXCEPTION 'OWNER_OPERATIONAL_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid='public.notifications'::regclass AND t.tgenabled='O'
         AND ((t.tgname='zz_authorize_owner_operational_original'
               AND md5(pg_get_triggerdef(t.oid))='7f4ecd63db81d72271f9e25c09a8e69d')
           OR (t.tgname='zz_owner_operational_original_reached_personal_inbox'
               AND md5(pg_get_triggerdef(t.oid))='2d1ee8300c484364c83db0496360b897'))) <> 2 THEN
    RAISE EXCEPTION 'OWNER_INBOX_TRIGGERS_CHANGED' USING ERRCODE='55000';
  END IF;
  -- The install proves itself (header 6) on this database, then rolls the
  -- proof back: as the installer, the original is routed ...
  BEGIN
    INSERT INTO public.notifications(id, user_id, type, title, message, data)
    VALUES (v_id, '47965354-0e56-43ef-931c-ddaab82af765', 'financial_incident',
            'Store-only delivery install check', 'rolled back by its migration', '{}'::jsonb);
    SELECT count(*) INTO v_rows FROM public.notifications WHERE id=v_id;
    SELECT count(*) INTO v_dest FROM public.operational_notification_destinations d
      JOIN public.operational_alert_events e ON e.id=d.inbox_event_id
     WHERE d.notification_id=v_id AND e.source='owner-operational-notifications'
       AND e.event_key=v_id::text
       AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca';
    RAISE EXCEPTION 'OWNER_STORE_ONLY_INSTALL_CHECK:%:%', v_rows, v_dest;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'OWNER_STORE_ONLY_INSTALL_CHECK:0:1' THEN
      RAISE EXCEPTION 'OWNER_STORE_ONLY_INSTALL_CHECK_FAILED: %', SQLERRM USING ERRCODE='55000';
    END IF;
  END;
  -- ... and as the public key's roles, it is refused with row-level
  -- security's own error, by the new trigger, before anything is captured.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      PERFORM set_config('role', v_role, true);
      INSERT INTO public.notifications(user_id, type, title, message, data)
      VALUES ('47965354-0e56-43ef-931c-ddaab82af765', 'financial_incident',
              'Store-only authority install check', 'refused by its migration', '{}'::jsonb);
      RAISE EXCEPTION 'OWNER_STORE_ONLY_AUTHORITY_CHECK_FAILED: % was not refused', v_role
        USING ERRCODE='55000';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_ctx = PG_EXCEPTION_CONTEXT;
      IF v_msg IS DISTINCT FROM 'new row violates row-level security policy for table "notifications"'
        OR strpos(v_ctx, 'fn_authorize_owner_operational_original') = 0 THEN
        RAISE EXCEPTION 'OWNER_STORE_ONLY_AUTHORITY_CHECK_FAILED: % was refused by "%" (%)',
          v_role, v_msg, v_ctx USING ERRCODE='55000';
      END IF;
    END;
  END LOOP;
END;
$verify$;

COMMIT;
