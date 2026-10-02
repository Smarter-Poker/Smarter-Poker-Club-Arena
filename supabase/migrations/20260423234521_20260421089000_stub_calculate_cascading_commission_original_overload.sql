-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423234521 "20260421089000_stub_calculate_cascading_commission_original_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d761a69c8d6f0b54eace46896adab9a3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG: the original calculate_cascading_commission(p_rake_amount numeric,
-- p_player_id uuid) overload references two things that no longer exist:
--   • club_members.referred_by    → 42703
--   • public.commission_structures → 42P01
--
-- BUG-12 earlier in this arc added stub overloads with new signatures to
-- resolve the 42883 errors API routes were seeing. Those stubs work. But
-- the original (numeric, uuid) overload was left in place and still has
-- its original broken body — any caller using that specific signature
-- would still 500.
--
-- Fix: replace the body with an empty-set return. Preserves signature
-- backward-compatibility (no 42883 for callers) while eliminating the
-- undefined-column and undefined-table errors. No commission is paid
-- out from this overload either way — the schema those lookups required
-- simply doesn't exist anymore.

CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(
  p_rake_amount numeric,
  p_player_id   uuid
)
 RETURNS TABLE(agent_id uuid, amount numeric, level integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- Empty-result stub. The commission cascade logic that this overload
  -- used to drive relies on tables that no longer exist in the schema
  -- (club_members.referred_by, commission_structures). Returning zero
  -- rows matches "no commissions to pay" — which is the de facto
  -- behavior callers saw when this function was 500'ing anyway.
  RETURN;
END;
$function$;
