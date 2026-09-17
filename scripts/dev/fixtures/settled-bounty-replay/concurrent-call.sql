DO $$
DECLARE r jsonb; BEGIN
 SELECT fn_collect_bounty_obligation(id) INTO r FROM fixture_concurrent_replay;
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'already'='true' AND r->>'marker_verified'='true','concurrent exact replay');
END $$;
