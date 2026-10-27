-- Reserved by scripts/reserve-migration-version.sh.
-- The v2 reader filters exact observer/variant/dealt count BEFORE its 512-hand
-- horizon. Its old (user_id, played_at) index fetches irrelevant contexts from
-- the heap: 26 concurrent disk-bound reads and 3,070 statement timeouts over
-- 19 minutes were observed on 2026-10-27. Match all equality keys before time,
-- cover the candidate metadata, and retain the exact original-dealt predicate.
-- No reader definition/checksum, cutoff, visibility, grants, cards, data or
-- engine behavior changes. Every horse still reads only its own public hands.
-- Install once through Apply Merged Migration's concurrent-index preamble.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.ca_hand_facts_observer_context_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_hand_facts_observer_context_cover ON public.ca_hand_facts USING btree (user_id, game_variant, players_dealt, played_at DESC, hand_id DESC) INCLUDE (table_id, tournament_id, seat, position) WHERE seat BETWEEN 1 AND 10 AND position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO');
BEGIN;
SET LOCAL lock_timeout='1s';
DO $guard$
DECLARE ix record; cols text[];
BEGIN
 SELECT i.*,c.relowner,am.amname INTO ix FROM pg_index i
 JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.ca_hand_facts_observer_context_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'horse_history_context_cover_missing'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols
 FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
 IF ix.indrelid<>'public.ca_hand_facts'::regclass
 OR ix.relowner<>'postgres'::regrole OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.amname<>'btree' OR ix.indexprs IS NOT NULL
 OR ix.indnkeyatts<>5 OR ix.indnatts<>9
 OR cols IS DISTINCT FROM ARRAY['user_id','game_variant','players_dealt','played_at','hand_id','table_id','tournament_id','seat','position']::text[]
 OR ix.indoption::smallint[] IS DISTINCT FROM '[0:4]={0,0,0,3,3}'::smallint[]
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM $predicate$(((seat >= 1) AND (seat <= 10)) AND ("position" = ANY (ARRAY['BTN'::text, 'SB'::text, 'BB'::text, 'UTG'::text, 'UTG+1'::text, 'UTG+2'::text, 'UTG+3'::text, 'MP'::text, 'LJ'::text, 'HJ'::text, 'CO'::text])))$predicate$
 OR EXISTS(SELECT 1 FROM unnest(ix.indclass::oid[]) k(opclass) JOIN pg_opclass op ON op.oid=k.opclass WHERE NOT op.opcdefault)
 OR EXISTS(SELECT 1 FROM unnest(ix.indkey::smallint[],ix.indcollation::oid[]) WITH ORDINALITY k(attnum,collation_oid,ord) JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum WHERE k.ord<=ix.indnkeyatts AND k.collation_oid IS DISTINCT FROM a.attcollation)
 THEN RAISE EXCEPTION 'horse_history_context_cover_shape_changed' USING DETAIL=jsonb_build_object('definition',pg_get_indexdef(ix.indexrelid),'predicate',pg_get_expr(ix.indpred,ix.indrelid),'options',ix.indoption::smallint[])::text; END IF;
END $guard$;
COMMIT;
