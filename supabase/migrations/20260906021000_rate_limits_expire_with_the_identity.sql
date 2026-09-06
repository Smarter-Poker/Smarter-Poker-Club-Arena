-- rate_limits is a rolling ten-minute throttle cache, not user history. Its
-- original foreign key omitted an ON DELETE action, so a row created by the
-- public club-join flow made an otherwise disposable certification identity
-- impossible to remove. Let account deletion retire this transient cache in
-- the database, including every non-test deletion path.

BEGIN;

ALTER TABLE public.rate_limits
  DROP CONSTRAINT rate_limits_user_id_fkey;

ALTER TABLE public.rate_limits
  ADD CONSTRAINT rate_limits_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

COMMIT;
