-- The original chain above retains its historical P0/P2/P3/P4/P5 and source-bound
-- calibration checks. Re-evaluate its independently captured immutable inputs
-- under the exact current owner policy before comparing with today's TS port.
-- This is a fresh qualification; historical calibration rows are not restamped.
--
-- 20261024213844: the snapshot's `newcomer` is the database's answer (never the
-- big blind AND not a seat the epoch's conversion made), and the TypeScript
-- port reads it, so every fixture's flag is refreshed from the real
-- fn_lightning_matcher_snapshot at the fixture's own `now` before comparing.
CREATE FUNCTION pp.refresh_newcomer(p_n integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d jsonb; g uuid; snap jsonb;
BEGIN
  SELECT doc INTO d FROM pp.out WHERE n = p_n;
  g := (d #>> '{config,cluster_id}')::uuid;
  snap := public.fn_lightning_matcher_snapshot(g, to_timestamp((d ->> 'now_us')::numeric / 1000000), NULL, NULL) #> '{snapshot,players}';
  IF snap IS NULL THEN RAISE EXCEPTION 'FIXTURE %: no authoritative snapshot', d ->> 'name'; END IF;
  UPDATE pp.out SET doc = jsonb_set(doc, '{players}', (
    SELECT coalesce(jsonb_agg(p || jsonb_build_object('newcomer', (
             SELECT (s ->> 'newcomer')::boolean FROM jsonb_array_elements(snap) s
              WHERE s ->> 'playerId' = p ->> 'player_id')) ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'players') WITH ORDINALITY t(p, o)))
   WHERE n = p_n;
  IF EXISTS (SELECT 1 FROM pp.out, jsonb_array_elements(doc -> 'players') p
              WHERE n = p_n AND jsonb_typeof(p -> 'newcomer') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'FIXTURE %: a player the snapshot does not name', d ->> 'name';
  END IF;
END $f$;

DO $current$
DECLARE f record; g uuid; binding_before text; old_config jsonb; result jsonb; members jsonb;
BEGIN
 FOR f IN SELECT * FROM pp.out ORDER BY n LOOP
  g:=(f.doc#>>'{config,cluster_id}')::uuid;
  old_config:=f.doc->'config';
  result:=public.fn_lightning_match(g,to_timestamp((f.doc->>'now_us')::numeric/1000000),NULL,NULL,NULL);
  IF result->>'legal_count' IS DISTINCT FROM f.doc#>>'{plan,legal_count}' THEN
   RAISE EXCEPTION 'Current policy changed historical legality input: %',f.name;
  END IF;
  IF jsonb_array_length(result->'groups')=0 THEN RAISE EXCEPTION 'Current policy parity became vacuous: %',f.name; END IF;
  FOR members IN SELECT x FROM jsonb_array_elements(result->'groups') x LOOP
   IF jsonb_array_length(members->'players') NOT BETWEEN 5 AND 6 THEN RAISE EXCEPTION 'Current policy group outside5/6: % %',f.name,members; END IF;
  END LOOP;
  UPDATE pp.out SET doc=jsonb_set(jsonb_set(doc,'{config}',public.fn_lightning_config(g)),'{plan}',result) WHERE n=f.n;
  PERFORM pp.refresh_newcomer(f.n);
 END LOOP;
END $current$;
\echo '  ok  12 CURRENT POLICY  exact source-admitted 20261023230001; independent fairness snapshots re-evaluated with unchanged legality and only five/six-player groups'

-- 13 A FRESH CONVERSION (20261024213844): twenty-four players seated BEFORE
-- the real drive converts the game (lc.build without its conversion, then the
-- drive, as the EPOCH section reconverts), none of them the big blind yet, and
-- two who buy in after it (each arrival its own transaction, as a buy-in is).
-- The conversion seats are not held; each later arrival leads the blind order
-- and is a big blind.
DO $$
DECLARE v_g uuid;
BEGIN
  v_g := lc.build('parity', 'CONVERSION', 6, 24, 1, 'nlh', '{}'::jsonb, false);
  PERFORM harness.drive(v_g);
  -- THE ENGINE ACKNOWLEDGES THE HALT (fixture boundary, as in section 09).
  UPDATE public.tables tb SET dealing_halt_observed_at = clock_timestamp()
   WHERE tb.cluster_id = v_g AND tb.dealing_halted_at IS NOT NULL
     AND (tb.dealing_halt_observed_at IS NULL OR tb.dealing_halt_observed_at < tb.dealing_halted_at);
  PERFORM harness.drive(v_g);
  IF harness.mode(v_g) IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FIXTURE 13: CONVERSION did not convert'; END IF;
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  INSERT INTO pp.cl (k, game) VALUES ('CONVERSION', v_g);
END $$;
DO $$ BEGIN
  PERFORM set_config('lc.scen', 'parity', true);
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM lc.arrive(pp.g('CONVERSION'), false);
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
DO $$ BEGIN
  PERFORM set_config('lc.scen', 'parity', true);
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM lc.arrive(pp.g('CONVERSION'), true);
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
DO $$
DECLARE v_g uuid := pp.g('CONVERSION'); p jsonb; v_new uuid[]; v_n integer;
BEGIN
  PERFORM public.fx9_pool(v_g);
  -- TIME TRAVEL (fixture boundary): the five-player deadline has elapsed for
  -- everyone, so the fixture is about first entry, not fullness.
  UPDATE public.lightning_pool_slot SET idle_since = clock_timestamp() - interval '4 seconds'
   WHERE cluster_id = v_g AND closed_at IS NULL;
  v_new := ARRAY(SELECT ps.player_id FROM public.lightning_pool_session ps
                   JOIN public.cash_cluster_epoch e ON e.cluster_id = ps.cluster_id AND e.epoch = ps.cluster_epoch
                   JOIN public.cash_player_session c ON c.id = ps.cash_player_session_id
                  WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND c.opened_at >= e.started_at);
  IF cardinality(v_new) <> 2 THEN RAISE EXCEPTION 'FIXTURE 13: % arrivals after the conversion, not 2', cardinality(v_new); END IF;
  IF (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_bb_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'FIXTURE 13: a slot has been the big blind already';
  END IF;
  p := pp.capture('a fresh conversion: 24 conversion seats and 2 later buy-ins (6-max, 26)', v_g);
  SELECT max(n) INTO v_n FROM pp.out;
  PERFORM pp.refresh_newcomer(v_n);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'diagnosis') d WHERE d ->> 'state' = 'WAITING_FOR_BB') THEN
    RAISE EXCEPTION 'FAIL 13: a player was held for the big blind: %', p -> 'diagnosis';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p -> 'groups') g WHERE (g ->> 'bb')::uuid = ANY (v_new)) <> 2 THEN
    RAISE EXCEPTION 'FAIL 13: the later buy-ins are not both big blinds: %', p -> 'groups';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'groups') g, jsonb_array_elements_text(g -> 'players') WITH ORDINALITY m(pid, o)
              WHERE o > 1 AND m.pid::uuid = ANY (v_new)) THEN
    RAISE EXCEPTION 'FAIL 13: a later buy-in was dealt off the big blind: %', p -> 'groups';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements((SELECT doc -> 'players' FROM pp.out WHERE n = v_n)) x
       WHERE (x ->> 'newcomer')::boolean) <> 2 THEN
    RAISE EXCEPTION 'FAIL 13: the snapshot does not name exactly the two buy-ins as newcomers';
  END IF;
END $$;
\echo '  ok  13 A FRESH CONVERSION  conversion seats dealt at once, each later buy-in the big blind of its hand, the snapshot naming exactly the buy-ins'
