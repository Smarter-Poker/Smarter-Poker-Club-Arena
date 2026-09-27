-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821031247 "20260821c_drop_legacy_spin_draw_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 79b1bf033f0dc303aef7f412ee90cd7d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 20260821c: drop the legacy 3-arg fn_spin_draw_multiplier overload.
-- Two overloads existed: (uuid,numeric,jsonb) — pre-rake/seats legacy — and
-- (uuid,numeric,jsonb,numeric DEFAULT 0.08,integer DEFAULT 3), the one the
-- engine calls with 5 named args. Because the newer one has defaults, ANY
-- 3-argument call is ambiguous (42725 / PostgREST 300) — a live trap for the
-- next caller. The engine's 5-named-arg call resolves uniquely and is
-- unaffected.
-- ROLLBACK: recreate the 3-arg wrapper delegating to the 5-arg version:
--   CREATE FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb)
--   RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS
--   $$ SELECT public.fn_spin_draw_multiplier($1,$2,$3,0.08,3) $$;

DROP FUNCTION IF EXISTS public.fn_spin_draw_multiplier(uuid, numeric, jsonb);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname='fn_spin_draw_multiplier') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_spin_draw_multiplier overload';
  END IF;
END $$;
