INSERT INTO clubs VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',2280,now());
INSERT INTO chip_ledger(from_type,from_entity_id,to_type,to_entity_id,to_label,amount,category)
SELECT 'promo_wallet','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',t,gen_random_uuid(),lbl,n,'promo_send' FROM (VALUES ('player_wallet',NULL::text,50),('player_wallet',NULL,25),('agent_wallet','agents.agent_wallet_balance',100),('player_wallet',NULL,25),('promo_wallet','agents.promo_wallet_balance',200),('promo_wallet','agents.promo_wallet_balance',200),('player_wallet',NULL,170))v(t,lbl,n);
-- Explicit alternate labels stay authoritative; unknown owners remain unkeyable.
INSERT INTO chip_ledger(from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category) VALUES ('promo_wallet','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','explicit.other_column','player_wallet',gen_random_uuid(),3,'promo_send'),('promo_wallet','99999999-0000-0000-0000-000000000001',NULL,'player_wallet',gen_random_uuid(),7,'promo_send');
