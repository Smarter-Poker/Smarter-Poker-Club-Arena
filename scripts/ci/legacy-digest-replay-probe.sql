-- Read-only fragment: the caller supplies distinct, non-NULL
-- page_digests(tuple_hand_digest) in its same-snapshot WITH clause.
-- OFFSET 0 keeps the inner probe on the compact hash expression. The outer
-- equality compares the actual stored digest and rejects every hash collision.
-- The caller must first verify the qualified compact index and original UNIQUE
-- digest index; this fragment never assumes a UUID-to-digest mapping.
SELECT count(*)
FROM page_digests d
CROSS JOIN LATERAL (
 SELECT p.hand_digest
 FROM smarter_private.horse_adaptive_legacy_learning_purges p
 WHERE pg_catalog.hashtextextended(p.hand_digest,0)
       =pg_catalog.hashtextextended(d.tuple_hand_digest,0)
 OFFSET 0
) matched
WHERE matched.hand_digest=d.tuple_hand_digest;
