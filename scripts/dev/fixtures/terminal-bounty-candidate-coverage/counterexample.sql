BEGIN;
DO $$ DECLARE x jsonb;t uuid;r jsonb; BEGIN
 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 UPDATE tournament_players SET status='eliminated',position=2 WHERE tournament_id=t AND user_id=(x->>'a')::uuid;
 UPDATE tournament_knockout_candidates SET state='eliminated' WHERE tournament_id=t;
 PERFORM fixture_assert(NOT fn_tournament_has_unsettled_bounties(t),'old predicate overlooks accepted unclaimed knockout');
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'ok'='true' AND (r->>'residual')::numeric=10,
  'old finalizer pays entire pool despite an exact unpaid claimant');
 PERFORM fixture_assert((SELECT count(*)=0 FROM tournament_bounty_obligations WHERE tournament_id=t),
  'old close records no obligation for the accepted knockout');
END $$;
ROLLBACK;
