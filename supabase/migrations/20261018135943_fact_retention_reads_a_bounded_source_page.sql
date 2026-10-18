-- The existing hourly fact-card retention pass reads a bounded source page.
-- EXPLAIN of the old LIMIT250 selector scans7.9M certificates and hashes7.9M
-- disposal receipts before limiting. The original retention transaction already
-- compacts ordinary arrivals; this pass must not rescan that history each hour.
-- A private cursor walks original certificate identity, bounds the page BEFORE
-- testing receipts, and wraps so an ineligible/locked hand is visited again.
-- The original compactor owns age/custody/refusal and player totals unchanged.
-- @live-proof: md5(pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure)) = 'a5300a24f3afe4c078d011f0980bf0cd'
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE smarter_private.horse_fact_card_prune_cursor(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_hand_id uuid
);
ALTER TABLE smarter_private.horse_fact_card_prune_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.horse_fact_card_prune_cursor FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE source text;patched text;
BEGIN
 source:=pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure);
 IF md5(source)<>'57ee12dc090b78191b9b459913e66b7b' THEN RAISE EXCEPTION 'fact retention preimage changed';END IF;
 patched:=replace(source,
  'DECLARE ids uuid[]; n integer; lim integer:=LEAST(GREATEST(COALESCE(p_limit,250),1),250); days integer;',
  'DECLARE ids uuid[]; n integer; lim integer:=LEAST(GREATEST(COALESCE(p_limit,250),1),250); days integer; scan_limit integer:=LEAST(GREATEST(COALESCE(p_limit,200000),1),200000); after_id uuid; page_last uuid; page_count integer;');
 patched:=replace(patched,$old$ SELECT array_agg(q.hand_id ORDER BY q.qualified_at,q.hand_id) INTO ids FROM (
  SELECT c.hand_id,c.qualified_at FROM smarter_private.horse_adaptive_disposal_certificates c
  WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals f WHERE f.hand_id=c.hand_id)
  ORDER BY c.qualified_at,c.hand_id LIMIT lim) q;$old$,$new$ INSERT INTO smarter_private.horse_fact_card_prune_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
 SELECT c.last_hand_id INTO after_id FROM smarter_private.horse_fact_card_prune_cursor c WHERE c.singleton FOR UPDATE;
 WITH page AS MATERIALIZED (
  SELECT c.hand_id FROM smarter_private.horse_adaptive_disposal_certificates c
  WHERE c.hand_id>COALESCE(after_id,'00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY c.hand_id LIMIT scan_limit
 ), receipts AS MATERIALIZED (
  -- Read the same contiguous identity range once. A correlated lookup for
  -- every certificate was still slow on the live cold indexes.
  SELECT f.hand_id FROM smarter_private.horse_fact_card_disposals f
  WHERE f.hand_id>COALESCE(after_id,'00000000-0000-0000-0000-000000000000'::uuid)
    AND f.hand_id<=(SELECT p.hand_id FROM page p ORDER BY p.hand_id DESC LIMIT 1)
 ), pending AS MATERIALIZED (
  SELECT p.hand_id FROM page p LEFT JOIN receipts f ON f.hand_id=p.hand_id
  WHERE f.hand_id IS NULL ORDER BY p.hand_id LIMIT lim
 )
 SELECT (SELECT array_agg(p.hand_id ORDER BY p.hand_id) FROM pending p),
        (SELECT p.hand_id FROM page p ORDER BY p.hand_id DESC LIMIT 1),
        (SELECT count(*)::integer FROM page)
 INTO ids,page_last,page_count;$new$);
 patched:=replace(patched,
  ' n:=smarter_private.compact_horse_fact_cards(ids);',
  $new$ n:=smarter_private.compact_horse_fact_cards(ids);
 -- Cursor and compaction commit or roll back together. A skipped hand remains
 -- intact and is retried on the next traversal, never declared disposed here.
 UPDATE smarter_private.horse_fact_card_prune_cursor
 SET last_hand_id=CASE WHEN cardinality(ids)>=lim THEN ids[cardinality(ids)]
                      WHEN page_count<scan_limit THEN NULL ELSE page_last END
 WHERE singleton;$new$);
 patched:=replace(patched,
  '''retention_days'',days,''more'',COALESCE(cardinality(ids),0)>=lim)',
  '''retention_days'',days,''scanned'',page_count,''more'',page_count>=scan_limit OR COALESCE(cardinality(ids),0)>=lim)');
 IF patched=source OR position('WITH page AS MATERIALIZED' in patched)=0 THEN RAISE EXCEPTION 'fact retention substitution failed';END IF;
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure) IS DISTINCT FROM patched
 THEN RAISE EXCEPTION 'fact retention readback mismatch';END IF;
END $migration$;
COMMIT;
