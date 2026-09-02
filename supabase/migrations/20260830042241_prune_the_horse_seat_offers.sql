-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830042241; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
DECLARE
  v_fix_date CONSTANT timestamptz := '2026-08-28 00:00:00+00';
  v_outbox   bigint;
  v_notifs   bigint;
  v_after    bigint;
BEGIN
  SELECT count(*) INTO v_after
    FROM public.notifications n
    JOIN public.profiles p ON p.id = n.user_id
   WHERE n.type = 'waitlist_seat_open'
     AND COALESCE(p.is_horse, false)
     AND n.created_at >= v_fix_date;

  IF v_after > 0 THEN
    RAISE EXCEPTION
      'refusing to prune: % seat offer(s) were sent to horses AFTER the fix date - the human-only filter has regressed, fix that first',
      v_after;
  END IF;

  SELECT count(*) INTO v_outbox
    FROM public.push_outbox o
    JOIN public.profiles p ON p.id = o.recipient_user_id
   WHERE o.event = 'waitlist_seat_open'
     AND COALESCE(p.is_horse, false)
     AND o.created_at < v_fix_date;

  SELECT count(*) INTO v_notifs
    FROM public.notifications n
    JOIN public.profiles p ON p.id = n.user_id
   WHERE n.type = 'waitlist_seat_open'
     AND COALESCE(p.is_horse, false)
     AND n.created_at < v_fix_date;

  RAISE NOTICE 'pruning horse seat offers: % push_outbox row(s), % notification(s)', v_outbox, v_notifs;

  DELETE FROM public.push_outbox o
   USING public.profiles p
   WHERE p.id = o.recipient_user_id
     AND o.event = 'waitlist_seat_open'
     AND COALESCE(p.is_horse, false)
     AND o.created_at < v_fix_date;

  DELETE FROM public.notifications n
   USING public.profiles p
   WHERE p.id = n.user_id
     AND n.type = 'waitlist_seat_open'
     AND COALESCE(p.is_horse, false)
     AND n.created_at < v_fix_date;
END $$;

DO $$
DECLARE
  v_left_notifs bigint;
  v_left_outbox bigint;
  v_humans      bigint;
BEGIN
  SELECT count(*) INTO v_left_notifs
    FROM public.notifications n
    JOIN public.profiles p ON p.id = n.user_id
   WHERE n.type = 'waitlist_seat_open' AND COALESCE(p.is_horse, false);

  SELECT count(*) INTO v_left_outbox
    FROM public.push_outbox o
    JOIN public.profiles p ON p.id = o.recipient_user_id
   WHERE o.event = 'waitlist_seat_open' AND COALESCE(p.is_horse, false);

  IF v_left_notifs > 0 OR v_left_outbox > 0 THEN
    RAISE EXCEPTION 'post-apply failed: % notification(s) and % outbox row(s) for horses survived', v_left_notifs, v_left_outbox;
  END IF;

  SELECT count(*) INTO v_humans
    FROM public.notifications n
    LEFT JOIN public.profiles p ON p.id = n.user_id
   WHERE n.type = 'waitlist_seat_open' AND NOT COALESCE(p.is_horse, false);

  IF v_humans = 0 THEN
    RAISE EXCEPTION 'post-apply failed: every human seat offer is gone too - this deleted more than it was asked to';
  END IF;

  RAISE NOTICE 'human seat offers still present: %', v_humans;
END $$;
