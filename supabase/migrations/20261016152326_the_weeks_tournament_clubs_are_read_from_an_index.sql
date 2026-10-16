-- Reserved as 20261016152229 by scripts/new-migration.mjs; renamed to the version
-- the Supabase MCP recorded when its guarded transaction was applied (20261016152326).
--
-- THE WEEK'S TOURNAMENT CLUBS ARE READ FROM AN INDEX (2026-10-16)
--
-- fn_accounting_week_clubs names the clubs of a union's week. Its
-- tournament_clubs step is SELECT DISTINCT club_id FROM
-- accounting_tournament_fee_sources WHERE coordinator_union_id = <union>, and
-- the only index on coordinator_union_id is (coordinator_union_id,
-- tournament_id), so every one of the union's ~420,000 fee rows was fetched
-- from the 1.8 GB heap to read its club. Measured 2026-10-16 in one session:
-- the first call 86.8 s (cold heap), then 5.3 s. The first call of every job
-- 272 tick is the cold one, inside the 240 s statement that also has to prove
-- and pay the week, and the union close for 2026-10-05 kept running out of
-- its tick there.
--
-- A partial (coordinator_union_id, club_id) index answers the same DISTINCT
-- with an index-only scan (7 MB). No function, row, grant, constraint or
-- deadline changes. The concurrent preamble is installed separately, then this
-- single guarded transaction checks the index and is recorded.
--
-- @live-proof: (SELECT i.indisvalid AND i.indisready FROM pg_index i WHERE i.indexrelid = to_regclass('public.accounting_tournament_fee_sources_coordinator_club'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_coordinator_club ON public.accounting_tournament_fee_sources (coordinator_union_id, club_id) WHERE coordinator_union_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE ix record; cols text[];
BEGIN
 SELECT i.*, c.relowner, am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_tournament_fee_sources_coordinator_club');
 IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_coordinator_club_index_missing'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols
 FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
 IF ix.indrelid<>'public.accounting_tournament_fee_sources'::regclass
  OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive OR ix.indisunique
  OR ix.amname<>'btree' OR ix.indexprs IS NOT NULL OR ix.indpred IS NULL
  OR cols IS DISTINCT FROM ARRAY['coordinator_union_id','club_id']::text[]
 THEN RAISE EXCEPTION 'tournament_fee_coordinator_club_index_shape_changed'; END IF;
END $guard$;
COMMIT;
