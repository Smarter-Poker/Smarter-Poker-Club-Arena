DO $$
DECLARE t uuid;
BEGIN
 SELECT (context->>'t')::uuid INTO t FROM fixture_concurrent_chain;
 PERFORM fixture_assert((SELECT count(*)=2 AND sum(amount)=6.25 FROM wallet_transactions WHERE related_entity_id=t),
  'concurrent chain pays exactly two cash awards');
 PERFORM fixture_assert((SELECT count(*)=2 AND bool_and(state='settled' AND fn_bounty_obligation_has_complete_marker(id)) FROM tournament_bounty_obligations WHERE tournament_id=t),
  'concurrent chain produces two complete exact markers');
END $$;
