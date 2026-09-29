-- A SEAT REOPENED AFTER CAPTURE BEGAN IS ORIGINAL POPULATION (2026-09-28).
--
-- fn_union_pnl_inventory_population refuses any active row whose first
-- captured event is not 'baseline' or 'INSERT' (active_row_original_population_missing).
-- The inventory capture (union_pnl_inventory_capture, started 2026-09-18
-- 00:20:48 UTC) baselined only rows that were ACTIVE at that instant. A
-- table_seats row that was already vacated (left_at set) before capture began
-- and was later re-used for a new occupancy therefore has, as its first
-- captured event, the UPDATE that opened that occupancy. Its before_row proves
-- the seat was vacant since before capture began, and its after_row carries
-- the whole new occupancy (user, joined_at, stack): the occupancy's origin IS
-- captured. Eleven such seats (all re-seated 2026-09-18 after capture began,
-- still seated at 2026-09-21 07:00) blocked the opening inventory of the
-- 2026-09-21 book and so every union's weekly P&L close.
--
-- This accepts exactly that case and nothing wider: source table_seats, first
-- captured event an UPDATE, its before_row has left_at set, and that left_at is
-- at or before the capture start. A seat that was OCCUPIED at capture and
-- missed its baseline still refuses (its first event's before_row has
-- left_at NULL). Every other source keeps the original rule.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)'::regprocedure);
 IF md5(source) IS DISTINCT FROM '577987fcbf75e127018003ebe2606e78' THEN
  RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_inventory_population is not the reviewed definition'; END IF;
 needle:=$n$   FROM active WHERE first_operation NOT IN ('baseline','INSERT')),'[]')$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'population_rule_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$   FROM active WHERE first_operation NOT IN ('baseline','INSERT')
    -- A seat vacated before capture began and re-opened afterwards: its first
    -- captured event is the UPDATE that opened this occupancy (see 20260928153000).
    AND NOT (source_name='table_seats' AND first_operation='UPDATE' AND EXISTS(
     SELECT 1 FROM (SELECT e.before_row FROM public.union_pnl_inventory_events e
       WHERE e.source_name='table_seats' AND e.row_id=active.row_id ORDER BY e.event_id LIMIT 1) f
     WHERE f.before_row->>'left_at' IS NOT NULL
      AND (f.before_row->>'left_at')::timestamptz<=(SELECT c.captured_at FROM public.union_pnl_inventory_capture c WHERE c.singleton)))),'[]')$r$;
 EXECUTE replace(source,needle,replacement);
END $patch$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_population(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
 IF position('re-opened afterwards' in pg_get_functiondef('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'postimage: population rule not installed'; END IF;
 IF has_function_privilege('anon','public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'postimage: browser roles can call the population reader'; END IF;
END $post$;
COMMIT;
