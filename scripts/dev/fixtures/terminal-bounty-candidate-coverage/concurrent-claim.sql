SET application_name='r38-concurrent-claim';
BEGIN;
SELECT fn_ca_lock_settlement_lane_for_tournament((x->>'t')::uuid) FROM fixture_terminal_concurrent;
DO $$ DECLARE x jsonb;r jsonb;o uuid; BEGIN
 SELECT f.x INTO x FROM fixture_terminal_concurrent f;
 r:=fixture_claim((x->>'t')::uuid,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'ok'='true' AND fn_bounty_obligation_has_complete_marker(o),'concurrent claimant holds actual lane and creates exact marker');
END $$;
SELECT pg_advisory_xact_lock(783138,1);
SELECT pg_sleep(1);
COMMIT;
