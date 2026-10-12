-- 20261007042245_solver_nodes_prove_physical_postflop_order.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';

-- TIER: 2. Body-only validation; no stored artifacts are rewritten or
-- retro-qualified. Pio player 0 is postflop OOP, player 1 is postflop IP.
-- Heads-up has the deliberate BB-before-SB exception; three or more seats
-- act clockwise from SB through BTN. Source admission and every later use
-- must agree on that physical meaning, not merely accept two valid labels.
CREATE FUNCTION public.fn_gto_v31_physical_positions_valid(p_node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
DECLARE
 c jsonb:=p_node->'node_context'; lp jsonb:=p_node->'line_proof';
 seats integer; player integer; positions text[]; h integer; o integer;
BEGIN
 IF jsonb_typeof(c->'table_size') IS DISTINCT FROM 'number'
    OR (c->>'table_size') !~ '^(2|3|4|5|6|7|8|9|10)$'
    OR jsonb_typeof(lp->'hero_solver_player') IS DISTINCT FROM 'number'
    OR (lp->>'hero_solver_player') !~ '^[01]$' THEN RETURN false; END IF;
 seats:=(c->>'table_size')::integer; player:=(lp->>'hero_solver_player')::integer;
 positions:=CASE seats
  WHEN 2 THEN ARRAY['BB','SB'] WHEN 3 THEN ARRAY['SB','BB','BTN']
  WHEN 4 THEN ARRAY['SB','BB','CO','BTN'] WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
  WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
  WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
  WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
  WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
  WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN'] END;
 h:=array_position(positions,c->>'hero_position');
 o:=array_position(positions,c->>'opponent_position');
 RETURN COALESCE(h<>o AND ((player=0 AND h<o) OR (player=1 AND h>o)),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_physical_positions_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_physical_positions_valid(jsonb) TO service_role;

CREATE FUNCTION public.fn_gto_v31_assert_physical_positions(p_node jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 IF NOT public.fn_gto_v31_physical_positions_valid(p_node) THEN
  RAISE EXCEPTION 'source node physical postflop positions disagree with Pio player' USING ERRCODE='55000';
 END IF;
 RETURN p_node;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_assert_physical_positions(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_assert_physical_positions(jsonb) TO service_role;

CREATE TEMP TABLE v31_position_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid) definition,
 proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_source_node_valid(jsonb)'::regprocedure,
 'public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure,
 'public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure,
 'public.fn_gto_v31_seal_build(uuid)'::regprocedure);

CREATE FUNCTION pg_temp.v31_position_patch(signature text,definition text)
RETURNS text LANGUAGE plpgsql AS $patch$
DECLARE result text:=definition; anchor text; replacement text;
BEGIN
 CASE signature
 WHEN 'fn_gto_v31_source_node_valid(jsonb)' THEN
  anchor:='OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)';
  replacement:=anchor||E'\n     OR NOT public.fn_gto_v31_physical_positions_valid(p_node)';
 WHEN 'fn_gto_v31_build_cell(uuid,jsonb)' THEN
  anchor:='  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;';
  IF strpos(result,anchor)=0 THEN RAISE EXCEPTION 'existing-cell preimage absent'; END IF;
  result:=replace(result,anchor,'');
  anchor:='    FROM matching_nodes m JOIN verified_artifacts a USING (source_row_id);';
  replacement:=anchor||E'\n  PERFORM public.fn_gto_v31_assert_physical_positions(n.value->''node'')\n    FROM jsonb_array_elements(v_source_nodes) n(value);\n  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;';
 WHEN 'fn_gto_v31_heldout_metrics(uuid,text)' THEN
  anchor:='  WITH holdout AS MATERIALIZED (';
  replacement:=$sql$  WITH scored_nodes AS MATERIALIZED (
    SELECT r.dataset_id,r.cell_id,r.source_row_id,r.source_node,r.split,
           public.fn_gto_v31_assert_physical_positions(n.value) AS node
      FROM public.gto_v31_cell_source_receipts r
      JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
      JOIN public.solved_spots_gold s ON s.id=r.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE r.dataset_id=p_dataset_id AND r.split='holdout'
       AND (p_game_family IS NULL OR c.game_family=p_game_family)
       AND n.value->>'node'=r.source_node
       AND n.value->>'node_checksum'=r.source_node_checksum
  ), holdout AS MATERIALIZED ($sql$;
  IF strpos(result,anchor)=0 THEN RAISE EXCEPTION 'heldout CTE preimage absent'; END IF;
  result:=replace(result,anchor,replacement);
  anchor:=$sql$      FROM public.gto_v31_cell_source_receipts r
      JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
      JOIN public.solved_spots_gold s ON s.id=r.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
      CROSS JOIN generate_series(0,1325) i$sql$;
  replacement:=$sql$      FROM scored_nodes r
      JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
      CROSS JOIN LATERAL (SELECT r.node AS value) n
      CROSS JOIN generate_series(0,1325) i$sql$;
  result:=replace(result,E'       AND n.value->>''node_checksum''=r.source_node_checksum\n       AND (n.value->''matchups''->>i)::numeric>0',E'       AND (n.value->''matchups''->>i)::numeric>0');
 WHEN 'fn_gto_v31_seal_build(uuid)' THEN
  anchor:='  IF NOT FOUND THEN RAISE EXCEPTION ''dataset is not building''; END IF;';
  replacement:=anchor||E'\n  PERFORM public.fn_gto_v31_assert_physical_positions(n.value)\n    FROM public.gto_v31_source_artifacts a\n    JOIN public.solved_spots_gold s ON s.id=a.source_row_id\n    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->''nodes'') n(value)\n   WHERE a.dataset_id=p_dataset_id;';
 ELSE RAISE EXCEPTION 'unexpected physical-position patch signature: %',signature;
 END CASE;
 IF (length(result)-length(replace(result,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'physical-position patch anchor differs: %',signature;
 END IF;
 RETURN replace(result,anchor,replacement);
END;
$patch$;

DO $repair$
DECLARE r record; expected text;
BEGIN
 IF (SELECT count(*) FROM v31_position_preimages)<>4 THEN RAISE EXCEPTION 'physical-position correction requires four exact functions'; END IF;
 FOR r IN SELECT * FROM v31_position_preimages LOOP
  expected:=CASE r.signature
   WHEN 'fn_gto_v31_source_node_valid(jsonb)' THEN '78a8ed07e6515535a88d85ad51c1d462'
   WHEN 'fn_gto_v31_build_cell(uuid,jsonb)' THEN '8f82041b1db10c5424e8b790fea8c15e'
   WHEN 'fn_gto_v31_heldout_metrics(uuid,text)' THEN '6c43a6d823ed3197603efda073834ab8'
   WHEN 'fn_gto_v31_seal_build(uuid)' THEN '799c21d1e1d9cc4d2f51c5026a5f88a9' END;
  IF md5(r.definition) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'physical-position preimage differs: %',r.signature; END IF;
  EXECUTE pg_temp.v31_position_patch(r.signature,r.definition);
 END LOOP;
END;
$repair$;

DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM v31_position_preimages LOOP
  IF pg_get_functiondef(r.oid) IS DISTINCT FROM pg_temp.v31_position_patch(r.signature,r.definition)
   OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=r.oid AND p.proowner=r.proowner
     AND p.proacl IS NOT DISTINCT FROM r.proacl AND p.proconfig IS NOT DISTINCT FROM r.proconfig
     AND p.prosecdef=r.prosecdef) THEN RAISE EXCEPTION 'physical-position postimage/ACL changed: %',r.signature; END IF;
 END LOOP;
 IF NOT public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"BB","opponent_position":"SB"},"line_proof":{"hero_solver_player":0}}')
 OR NOT public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"SB","opponent_position":"BB"},"line_proof":{"hero_solver_player":1}}')
 OR NOT public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":6,"hero_position":"SB","opponent_position":"BB"},"line_proof":{"hero_solver_player":0}}')
 OR public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"SB","opponent_position":"BB"},"line_proof":{"hero_solver_player":0}}')
 OR public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"BB","opponent_position":"SB"},"line_proof":{"hero_solver_player":1}}')
 OR public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2.5,"hero_position":"BB","opponent_position":"SB"},"line_proof":{"hero_solver_player":0}}')
 OR public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"BB","opponent_position":"SB"},"line_proof":{"hero_solver_player":0.4}}')
 OR public.fn_gto_v31_physical_positions_valid('{"node_context":{"table_size":2,"hero_position":"BB","opponent_position":"BTN"},"line_proof":{"hero_solver_player":0}}')
 THEN RAISE EXCEPTION 'physical heads-up position contract differs'; END IF;
END;
$post$;

COMMIT;

-- Exact independently qualified postimages: dynamic body patches must be
-- visible to the existing live migration verifier, not inferred from a file.
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_source_node_valid(jsonb)'::regprocedure)) = '25b7c968e4d45776486c60564384c96d'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure)) = '0eb032c2971a6339f3bf25053eb765d2'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure)) = '3536decd52bc0b53775690f1e43e0b49'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_seal_build(uuid)'::regprocedure)) = '282e711753e111e23b03f8dc6cfdd7b3'
