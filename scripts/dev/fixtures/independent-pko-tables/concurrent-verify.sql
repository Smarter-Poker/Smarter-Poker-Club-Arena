DO $$
DECLARE t uuid; x jsonb; BEGIN
 SELECT evidence INTO x FROM fixture_concurrent_pko;t:=(x->>'t')::uuid;
 PERFORM fixture_assert((SELECT count(*) FROM tournament_bounties WHERE tournament_id=t)=2
   AND (SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t)=5.00
   AND (SELECT count(*) FROM tournament_bounty_obligations WHERE tournament_id=t AND state='settled')=2,
   'concurrent claims and collections pay each of the two heads once');
 PERFORM fixture_assert((SELECT bounty_pool-bounty_pool_paid FROM tournaments WHERE id=t)=
   (SELECT sum(current_bounty) FROM tournament_players WHERE tournament_id=t),
   'remaining synthetic pool exactly backs surviving progressive heads');
 PERFORM fixture_assert((SELECT last_settled_hand_number FROM tournament_pko_settlement_watermarks WHERE tournament_id=t)=5000002,
   'independent lower hand never rewinds global observation watermark');
END $$;
