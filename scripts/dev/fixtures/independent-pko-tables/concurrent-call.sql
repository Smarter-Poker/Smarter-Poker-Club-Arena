DO $$
DECLARE x jsonb; r jsonb; BEGIN
 SELECT evidence INTO x FROM fixture_concurrent_pko;
 r:=fixture_claim((x->>'t')::uuid,(x->>'a')::uuid,(x->>'b')::uuid,3);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'obligation_id' IS NOT NULL,'concurrent exact lower-hand claim');
 r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true','concurrent exact lower-hand collection');
END $$;
