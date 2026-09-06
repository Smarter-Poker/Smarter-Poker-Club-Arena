-- Cover the telemetry user foreign key and the per-account certification
-- cleanup path. Without this index, account deletion scans the entire retained
-- Daily Challenge operations journal as that journal grows.

BEGIN;

CREATE INDEX IF NOT EXISTS daily_mission_operations_user_created_idx
  ON public.daily_mission_operations (user_id, created_at DESC);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a
      ON a.attrelid = i.indrelid
     AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'public.daily_mission_operations'::regclass
      AND i.indisvalid
      AND a.attname = 'user_id'
  ) THEN
    RAISE EXCEPTION 'Daily Mission operations user foreign key is not indexed';
  END IF;
END;
$verify$;

COMMIT;
