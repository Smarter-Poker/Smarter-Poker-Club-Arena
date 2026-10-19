-- CLUB JOINING IS BROKEN IN PRODUCTION AND THIS IS WHY.
--
-- fn_join_club_atomic - the only join path the app has, called from
-- ClubJoinService.joinClub - reads and writes public.rate_limits to enforce
-- "eight code/invite attempts per rolling ten minutes". That table does not
-- exist in this database, so every single call raises
--   relation "public.rate_limits" does not exist
-- and NO USER CAN JOIN ANY CLUB. Found by signing in as a real account and
-- making the call the Join Club screen makes.
--
-- The table is not new and is not invented here. supabase/migrations/
-- 20260311_rate_limit_rpc.sql creates it, and that migration was never applied
-- to production: it is absent from supabase_migrations.schema_migrations. The
-- repo and the database disagreed, exactly the divergence #2200 was about, in
-- the opposite direction - the repo held a migration production never got.
--
-- Applied verbatim from that file: same columns, same index, same RLS, same
-- check_rate_limit companion. Nothing about the join function is altered; it
-- simply gets back the table it was always written against. The newer
-- rate_limit_buckets durable limiter is left alone - swapping this function
-- onto it is a security-sensitive change that belongs in its own reviewed PR,
-- not in an outage fix.

CREATE TABLE IF NOT EXISTS public.rate_limits (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES auth.users(id),
    action      text NOT NULL,
    created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_user_action
    ON public.rate_limits(user_id, action, created_at DESC);

CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
    DELETE FROM public.rate_limits WHERE created_at < now() - INTERVAL '10 minutes';
END;
$$;

CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_user_id uuid, p_action text, p_max_per_minute integer DEFAULT 5)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM public.rate_limits
     WHERE user_id = p_user_id AND action = p_action
       AND created_at > now() - INTERVAL '1 minute';
    IF v_count >= p_max_per_minute THEN RETURN FALSE; END IF;
    INSERT INTO public.rate_limits (user_id, action) VALUES (p_user_id, p_action);
    RETURN TRUE;
END;
$$;

-- NOT BROWSER-CALLABLE. Both helpers are SECURITY DEFINER and write, and
-- check_rate_limit takes the actor as a parameter - a caller-supplied id is a
-- caller-supplied answer. The 2026-03 original predates this repo's
-- definer-authorization rule and left EXECUTE with `authenticated`, which the
-- pre-push guard correctly refused. Neither has a single caller in src/,
-- server/src/ or any plpgsql body. PUBLIC is named alongside the roles because
-- revoking a role while PUBLIC still holds EXECUTE does nothing.
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

REVOKE ALL ON FUNCTION public.check_rate_limit(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer) TO service_role;

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='rate_limits' AND policyname='Users can see own rate limits') THEN
    CREATE POLICY "Users can see own rate limits" ON public.rate_limits
      FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='rate_limits' AND policyname='Service can insert rate limit entries') THEN
    CREATE POLICY "Service can insert rate limit entries" ON public.rate_limits
      FOR INSERT WITH CHECK (TRUE);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.rate_limits') IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: public.rate_limits still missing';
  END IF;
END $$;
