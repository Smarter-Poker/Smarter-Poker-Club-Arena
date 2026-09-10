-- Isolated fixture overlay: preserve the exact current purchase and seat lock bodies.
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- G first: still one authority at a time, still what the trigger guards
  -- look for.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to. Keep yesterday's exclusion rather than none.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- T(id): only this tournament's hands wait, and only for this tournament's
  -- rolling authorities.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$;

DO $fixture$
DECLARE
  item jsonb;
  target oid;
  body text;
  definition text;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements($patches$[{"signature": "process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)", "before_md5": "63e4762f2f293da5f2c66ae03fd92947", "after_md5": "3db2678ad2b17093ba8dd85ab6af2339", "before": "g_advisory_xact_lock(\n    hashtextextended('ca:tournament-terminal-settlement:v1',0)", "after": "ublic.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id"}, {"signature": "trg_lock_and_validate_tournament_live_seat()", "before_md5": "1daab0d4125165fa5b501506299965d3", "after_md5": "27e86e2b51bb6cfb17c13569c8870f10", "before": "SELECT EXISTS (\n      SELECT 1\n        FROM public.tournaments t\n        LEFT JOIN public.tournament_launch_receipts r\n          ON r.tournament_id = t.id\n       WHERE t.id = ANY(v_ids", "after": "-- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL\n    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /\n    -- UPDATE, and the side that is not assigned is NULL, which matches nothing\n    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and\n    -- re-plans this statement on every seat write (0.83-0.99 ms measured);\n    -- with two scalar parameters it adopts the generic plan (0.026 ms).\n    SELECT EXISTS (\n      SELECT 1\n        FROM public.tournaments t\n        LEFT JOIN public.tournament_launch_receipts r\n          ON r.tournament_id = t.id\n       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id"}]$patches$::jsonb) LOOP
    target:=to_regprocedure(item->>'signature');
    SELECT prosrc,pg_get_functiondef(oid) INTO body,definition FROM pg_proc WHERE oid=target;
    IF md5(body) IS DISTINCT FROM item->>'before_md5' THEN
      RAISE EXCEPTION 'fixture source changed: %',item->>'signature';
    END IF;
    EXECUTE replace(definition,body,replace(body,item->>'before',item->>'after'));
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=target) IS DISTINCT FROM item->>'after_md5' THEN
      RAISE EXCEPTION 'current fixture composition differs: %',item->>'signature';
    END IF;
  END LOOP;
END;
$fixture$;
