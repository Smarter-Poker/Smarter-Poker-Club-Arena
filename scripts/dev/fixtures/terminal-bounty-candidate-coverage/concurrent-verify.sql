DO $$ DECLARE t uuid; BEGIN
 SELECT (x->>'t')::uuid INTO t FROM fixture_terminal_concurrent;
 PERFORM fixture_assert((SELECT sum(amount)=10 AND count(*)=2 FROM wallet_transactions WHERE related_entity_id=t),
  'concurrent close and repeated finalizers pay exact pool once');
 PERFORM fixture_assert((SELECT count(*)=1 FROM tournament_bounty_completion_receipts WHERE tournament_id=t AND pool_finalized_at IS NOT NULL)
  AND (SELECT count(*)=2 FROM fixture_terminal_calls WHERE tournament_id=t),
  'concurrent close records one immutable receipt and exactly two payer calls');
END $$;
