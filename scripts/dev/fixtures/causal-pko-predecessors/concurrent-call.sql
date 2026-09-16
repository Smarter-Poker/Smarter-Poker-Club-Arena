DO $$
DECLARE x jsonb;r jsonb;t uuid;a uuid;b uuid;c uuid;
BEGIN
 SELECT context INTO x FROM fixture_concurrent_chain;
 t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;
 r:=fixture_claim(t,a,b,4);PERFORM fixture_assert(r->>'ok'='true','concurrent exact ancestor claim');
 r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);PERFORM fixture_assert(r->>'ok'='true','concurrent ancestor receipt');
 r:=fixture_claim(t,b,c,3);PERFORM fixture_assert(r->>'ok'='true','concurrent exact downstream claim');
 r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);PERFORM fixture_assert(r->>'ok'='true','concurrent downstream receipt');
END $$;
