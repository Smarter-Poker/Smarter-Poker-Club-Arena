-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823224939 "stakes_string_matches_the_engine_format"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9c271b5f09d032c2d5e14fcef9d2ebc1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The first pass of this repair wrote `small_blind::text || '/' || big_blind::text`,
-- which renders a numeric(_,2) as "192000.00/384000.00". The engine writes
-- `${safeSmallBlind}/${safeBigBlind}` from JS numbers, i.e. "192000/384000".
--
-- Two writers, two formats, for the same column: the next level-up would have
-- rewritten every row and any equality check between them would call a correct
-- row stale forever. trim_scale() drops the trailing zeros a numeric carries
-- and leaves genuine fractions alone (0.50 -> 0.5, 2.25 -> 2.25), which is
-- exactly what JS number-to-string does.
UPDATE public.tables tb
   SET stakes = trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text
  FROM public.tournaments t
 WHERE t.id = tb.tournament_id
   AND t.status IN ('RUNNING', 'REGISTERING', 'ANNOUNCED')
   AND tb.small_blind IS NOT NULL
   AND tb.big_blind IS NOT NULL
   AND tb.stakes IS DISTINCT FROM (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text);

DO $$
DECLARE v_stale int;
BEGIN
  SELECT count(*) INTO v_stale
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE t.status = 'RUNNING'
     AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
     AND tb.stakes IS DISTINCT FROM (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text);
  IF v_stale > 0 THEN
    RAISE EXCEPTION '% live tournament table(s) still advertise stakes in the wrong format', v_stale;
  END IF;
END $$;
