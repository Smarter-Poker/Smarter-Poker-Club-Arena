-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820022724 "retire_second_move_rake_to_chips_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 052079d99d2496bcfb11f237f87e0394 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The trust leak had TWO overloads and my first pass only retired one.
--
--   fn_union_move_rake_to_chips_atomic(uuid, numeric, uuid, text, uuid)  <- retired
--   fn_union_move_rake_to_chips_atomic(uuid, numeric, text, uuid, uuid)  <- STILL LIVE
--
-- And the live production caller binds to the second one: World Hub
-- pages/api/club-arena/union-wallet.js passes p_union_id, p_amount, p_notes,
-- p_created_by, p_op_id — i.e. (uuid, numeric, text, uuid, uuid). So the path a
-- union admin can actually reach was the one still able to move the clubs'
-- money out of trust and into the union's own bank ahead of the weekly close.
--
-- A reminder that "I replaced the function" is not the same as "the function is
-- gone" when overloads exist. Both refuse now.

CREATE OR REPLACE FUNCTION public.fn_union_move_rake_to_chips_atomic(
  p_union_id uuid, p_amount numeric, p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL, p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error', 'retired_rake_is_held_in_trust',
    'detail', 'The Rake Treasury holds the member clubs'' rake until the weekly '
           || 'close, which returns 90% to the clubs and moves the union''s '
           || 'retained share into the Union Bank automatically. Moving rake '
           || 'into the bank by hand would spend money that belongs to the clubs.'
  );
END $$;

REVOKE ALL ON FUNCTION public.fn_union_move_rake_to_chips_atomic(uuid, numeric, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_move_rake_to_chips_atomic(uuid, numeric, text, uuid, uuid) TO service_role;
