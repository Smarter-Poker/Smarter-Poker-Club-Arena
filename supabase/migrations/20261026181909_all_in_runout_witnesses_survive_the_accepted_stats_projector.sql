-- Reserved through scripts/new-migration.mjs. Preserve the original cards-to-come
-- runout witness through the existing accepted-facts projection. Missing legacy
-- flags mean false. No EV math, money, daily rollup, history or receipt hash changes.
-- Function-only patch; no hot table locks or historical backfill.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_project_hand_stats_facts(uuid)'::regprocedure)))='1fbfe441e124bff9317e4f8b1c3def8c'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $witness$
DECLARE definition text; before_md5 text := '303e52861c2db7b6b8e3118afbf53a8b';
BEGIN
 definition:=pg_get_functiondef('public.ca_project_hand_stats_facts(uuid)'::regprocedure);
 IF md5(definition)<>before_md5 THEN RAISE EXCEPTION 'all_in_witness_projector_preimage_changed:%',md5(definition); END IF;
 IF (length(definition)-length(replace(definition,$old0$all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,source_hash)$old0$,'')))/length($old0$all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,source_hash)$old0$)<>1 THEN RAISE EXCEPTION 'all_in_witness_projector_anchor_changed:0'; END IF;
definition:=replace(definition,$old0$all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,source_hash)$old0$,$new0$all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,all_in_equity_owed,source_hash)$new0$);
 IF (length(definition)-length(replace(definition,$old1$         f.ev_net_bb,v_hash$old1$,'')))/length($old1$         f.ev_net_bb,v_hash$old1$)<>1 THEN RAISE EXCEPTION 'all_in_witness_projector_anchor_changed:1'; END IF;
definition:=replace(definition,$old1$         f.ev_net_bb,v_hash$old1$,$new1$         f.ev_net_bb,coalesce(f.all_in_equity_owed,false),v_hash$new1$);
 IF (length(definition)-length(replace(definition,$old2$-'all_in_equity_owed'$old2$,'')))/length($old2$-'all_in_equity_owed'$old2$)<>4 THEN RAISE EXCEPTION 'all_in_witness_projector_anchor_changed:2'; END IF;
definition:=replace(definition,$old2$-'all_in_equity_owed'$old2$,$new2$$new2$);
 IF (length(definition)-length(replace(definition,$old3$    WHERE actual.source_hash IS DISTINCT FROM v_hash$old3$,'')))/length($old3$    WHERE actual.source_hash IS DISTINCT FROM v_hash$old3$)<>1 THEN RAISE EXCEPTION 'all_in_witness_projector_anchor_changed:3'; END IF;
definition:=replace(definition,$old3$    WHERE actual.source_hash IS DISTINCT FROM v_hash$old3$,$new3$    WHERE actual.all_in_equity_owed IS DISTINCT FROM coalesce((expected->>'all_in_equity_owed')::boolean,false)
       OR actual.source_hash IS DISTINCT FROM v_hash$new3$);
 IF (length(definition)-length(replace(definition,$old4$  v_hash := encode(extensions.digest$old4$,'')))/length($old4$  v_hash := encode(extensions.digest$old4$)<>1 THEN RAISE EXCEPTION 'all_in_witness_projector_anchor_changed:4'; END IF;
definition:=replace(definition,$old4$  v_hash := encode(extensions.digest$old4$,$new4$  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_stats->'facts') f
    WHERE f ? 'all_in_equity_owed' AND jsonb_typeof(f->'all_in_equity_owed') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'stats facts refused (invalid_all_in_equity_witness)';
  END IF;

  v_hash := encode(extensions.digest$new4$);
 IF md5(definition)<>'1fbfe441e124bff9317e4f8b1c3def8c' THEN RAISE EXCEPTION 'all_in_witness_projector_postimage_changed'; END IF;
 EXECUTE definition;
END $witness$;
COMMIT;
