-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830042121; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS device_id text;

COMMENT ON COLUMN public.push_subscriptions.device_id IS
  'Random per-browser-profile id minted by push-client.js and kept in localStorage. Stable across re-subscribes on one device, different between devices, so it is the only safe key for retiring a superseded endpoint (the endpoint itself is not stable and user_agent is not unique). Nullable: pre-2026-08-30 rows keep working and simply do not dedupe. Added 2026-08-30.';

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_one_active_per_device_uidx
  ON public.push_subscriptions (user_id, device_id)
  WHERE is_active AND device_id IS NOT NULL;

COMMENT ON INDEX public.push_subscriptions_one_active_per_device_uidx IS
  'A device holds at most one live push endpoint. subscribe.js retires the previous one in the same request; this makes it structural rather than remembered. Added 2026-08-30.';

WITH ranked AS (
  SELECT id, user_id, user_agent, last_used_at,
         row_number() OVER (
           PARTITION BY user_id, user_agent
           ORDER BY created_at DESC
         ) AS rn,
         max(last_used_at) OVER (PARTITION BY user_id, user_agent) AS group_last_used
    FROM public.push_subscriptions
   WHERE is_active
     AND device_id IS NULL
),
dupes AS (
  SELECT id FROM ranked
   WHERE rn > 1
     AND (last_used_at IS NULL OR group_last_used IS NULL OR last_used_at < group_last_used)
)
UPDATE public.push_subscriptions s
   SET is_active = false,
       last_failure_reason = 'superseded_same_device_backfill_20260830',
       updated_at = now()
  FROM dupes d
 WHERE s.id = d.id;

DO $$
DECLARE
  v_remaining bigint;
  v_users     bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'push_subscriptions'
       AND column_name = 'device_id'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: push_subscriptions.device_id is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'push_subscriptions_one_active_per_device_uidx'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: the per-device unique index did not take';
  END IF;

  SELECT count(*) INTO v_users
    FROM (
      SELECT s.user_id
        FROM public.push_subscriptions s
       GROUP BY s.user_id
      HAVING count(*) FILTER (WHERE s.is_active) = 0
         AND count(*) FILTER (WHERE s.last_failure_reason = 'superseded_same_device_backfill_20260830') > 0
    ) x;
  IF v_users > 0 THEN
    RAISE EXCEPTION 'post-apply failed: % user(s) were left with no active endpoint by the backfill', v_users;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM (
      SELECT 1 FROM public.push_subscriptions
       WHERE is_active AND device_id IS NULL
       GROUP BY user_id, user_agent
      HAVING count(*) > 1
    ) y;
  RAISE NOTICE 'push subscription dedupe: % same-device group(s) still hold more than one active row', v_remaining;
END $$;
