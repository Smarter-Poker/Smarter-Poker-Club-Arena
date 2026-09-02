-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830155223; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan, 2026-08-30, from an iPhone: "I'M GETTING DOUBLE NOTIFICATIONS FOR THE
-- SAME OPEN SEAT, AND A PUSH ALERT ABOUT 3 ZOMBIE SUBSCRIPTIONS."
--
-- Both symptoms, one cause. His account had FIVE active subscriptions for TWO
-- physical devices:
--
--   iPhone  created 08-26  last_receipt_at NULL   <- never confirmed a delivery
--   iPhone  created 08-27  last_receipt_at NULL   <- never confirmed a delivery
--   iPhone  created 08-30  last_receipt_at SET    <- the live one
--   Mac     created 08-26  last_receipt_at NULL   <- never confirmed a delivery
--   Mac     created 08-30  (newest)
--
-- Every push fans out to every active row, so one `push_outbox` row arrived on
-- the phone more than once. Proven rather than inferred: in the six hours
-- before he reported it there was exactly ONE 'Push Health Alert' row in
-- push_outbox, and his screenshot shows it twice. (The two "Seat Open"
-- notifications in the same screenshot are NOT duplicates — they are different
-- tables, "Bomb Pot NLH 0.25/0.50" and "NLH 0.25/0.50". That is a copy problem,
-- not a delivery one, and is not addressed here.)
--
-- The same stale rows are what push-health counts as "zombies": active, still
-- being sent to, never returning a receipt from the service worker. So the
-- alert he received was his own watchdog correctly reporting this bug.
--
-- WHY THE EXISTING FIX DID NOT COVER THEM. pages/api/push/subscribe.js already
-- retires prior live rows for the same device, keyed on `device_id` — a random
-- id the client keeps in localStorage. That is the right key (the endpoint is
-- not stable, and user_agent is not unique: two identical iPhones on one
-- account produce byte-identical strings, so deduping on it would switch off a
-- real device). But it shipped TODAY, and all five of these rows predate it
-- with `device_id IS NULL`. Prevention works going forward; nothing reaps what
-- was already there.
--
-- WHAT THIS RETIRES, deliberately narrow. A row qualifies only if ALL hold:
--   * device_id IS NULL          — legacy only; anything the new code manages
--                                  is left alone entirely
--   * last_receipt_at IS NULL    — it has never once confirmed a delivery, so
--                                  it is not somebody's working second device
--   * a strictly NEWER active row exists for the same user + device_label
--
-- The newest row per device is never a candidate, so nobody can be left with
-- zero subscriptions by this. Dry-run before applying returned exactly three
-- rows, all on Dan's account.
WITH ranked AS (
  SELECT s.id,
         row_number() OVER (PARTITION BY s.user_id, s.device_label ORDER BY s.created_at DESC) AS rn,
         s.device_id, s.last_receipt_at
  FROM public.push_subscriptions s
  WHERE s.is_active
)
UPDATE public.push_subscriptions t
   SET is_active = false,
       last_failure_reason = 'superseded_legacy_no_receipt_20260830',
       updated_at = now()
  FROM ranked r
 WHERE r.id = t.id
   AND r.device_id IS NULL
   AND r.last_receipt_at IS NULL
   AND r.rn > 1;

DO $$
DECLARE v_dan_active int; v_zombies int;
BEGIN
  SELECT count(*) INTO v_dan_active FROM public.push_subscriptions
   WHERE user_id = '47965354-0e56-43ef-931c-ddaab82af765' AND is_active;

  -- Nobody may be left unreachable: every user who had an active subscription
  -- before must still have at least one.
  SELECT count(*) INTO v_zombies FROM (
    SELECT user_id FROM public.push_subscriptions
     GROUP BY user_id
    HAVING count(*) FILTER (WHERE is_active) = 0
       AND count(*) FILTER (WHERE last_failure_reason = 'superseded_legacy_no_receipt_20260830') > 0
  ) x;
  IF v_zombies > 0 THEN
    RAISE EXCEPTION 'this retirement left % user(s) with no active subscription', v_zombies;
  END IF;

  RAISE NOTICE 'Dan now has % active subscription(s)', v_dan_active;
END $$;
