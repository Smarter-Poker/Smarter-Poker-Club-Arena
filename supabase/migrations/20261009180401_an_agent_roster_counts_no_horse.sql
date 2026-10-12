-- an_agent_roster_counts_no_horse
--
-- AN AGENT ROSTER COUNTS NO HORSE (2026-10-09). Full account:
-- docs/changelog/2026-10-09-the-chip-felt-counts-no-diamond-seat.md.
--
-- fn_union_integrity_sweep's agent_roster_winning signal reads an agent's
-- players' net winnings against the rake they paid. Its co-seating signal
-- already leaves house horses out (profiles.is_horse); its roster did not. On
-- 2026-10-06 and 2026-10-07 it raised two warnings (075f86b1, 5e37dd72) for
-- agent "bytesize", whose only rostered player is a horse up 20 on 0.40 of
-- rake. A horse is the house's own simulated player; its winnings say nothing
-- about an agent colluding. The roster now leaves horses out exactly as the
-- co-seating signal does. Nothing else changes.
--
-- @live-proof: (SELECT position('AN AGENT ROSTER COUNTS NO HORSE' IN pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ROSTER_HORSE_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure);
BEGIN
  IF position('AN AGENT ROSTER COUNTS NO HORSE' IN v_src) > 0 THEN
    RAISE NOTICE 'ROSTER_HORSE already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '24d4f8cf076499a6e90f5c221a135c4a' THEN
    RAISE EXCEPTION 'ROSTER_HORSE_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$     WHERE m.agent_id IS NOT NULL
  ),
$a$,
$a$     WHERE m.agent_id IS NOT NULL
       -- AN AGENT ROSTER COUNTS NO HORSE (2026-10-09), as the co-seating
       -- signal below already reads it.
       AND NOT EXISTS (SELECT 1 FROM public.profiles hp
                        WHERE hp.id = m.user_id AND COALESCE(hp.is_horse, false))
  ),
$a$, 'roster');
  EXECUTE v_src;
END
$patch$;

DO $prove$
BEGIN
  IF position('AN AGENT ROSTER COUNTS NO HORSE' IN pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'ROSTER_HORSE_RESULT_CHANGED: not live';
  END IF;
END
$prove$;

COMMIT;
