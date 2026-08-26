-- ═══════════════════════════════════════════════════════════════════════════
--  THE FAST PAINT AND THE REAL QUERY MUST FILTER ON THE SAME COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The lobby's "Table Size" slider filters tournaments on tournaments.table_size
-- -- seats at ONE table -- and never on max_players, which is the size of the
-- FIELD. (Handing it max_players is what emptied the MTT tab for Shark Club
-- and Midway on 2026-08-23: a 2-9 slider against fields of 150 to 1,000.)
--
-- Since the authoritative client query now selects that column, the fast paint
-- has to carry it too. Otherwise a narrowed slider filters after the real query
-- lands and not during the paint, and the list visibly re-narrows under the
-- player -- the same "it displays, then it disappears" shape, in miniature.
--
-- One small integer. APPLIED TO PRODUCTION 2026-08-23 via the Supabase MCP;
-- the settled body in 20260823280000_get_club_home_was_never_run.sql already
-- selects it and asserts on it. This file records the reason and re-checks.
-- ═══════════════════════════════════════════════════════════════════════════

DO $check$
DECLARE v jsonb; c record;
BEGIN
  FOR c IN SELECT id, name FROM public.clubs LOOP
    v := public.get_club_home(c.id::text);
    IF jsonb_array_length(COALESCE(v->'tournaments', '[]'::jsonb)) > 0
       AND NOT ((v->'tournaments'->0) ? 'table_size') THEN
      RAISE EXCEPTION 'get_club_home(%) does not return table_size - the Table Size slider would re-narrow the list after the paint', c.name;
    END IF;
  END LOOP;
END $check$;
