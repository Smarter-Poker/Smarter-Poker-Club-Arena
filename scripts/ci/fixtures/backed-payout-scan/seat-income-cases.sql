-- A separate target makes the expected incoming total independent of the
-- implementation. Only cases10,11,13,14,16,19 contribute:5-2+3+3+7+7=23.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status)
VALUES(md5('income-target')::uuid,'income-target',1000,now()-interval '1 day','COMPLETED'),
      (md5('income-source')::uuid,'income-source',0,now(),'RUNNING');
INSERT INTO wallet_transactions(related_entity_id,type,category,amount)
VALUES(md5('income-target')::uuid,'debit','tournament_buyin',100);
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT md5('income-source')::uuid,md5('income-user-'||n)::uuid,
 CASE n WHEN 10 THEN 5 WHEN 11 THEN -2 WHEN 12 THEN NULL
        WHEN 13 THEN 3 WHEN 14 THEN 3 ELSE 7 END,
 CASE n WHEN 21 THEN 'prize' WHEN 22 THEN NULL ELSE 'satellite_ticket' END,n,
 CASE n WHEN 1 THEN NULL WHEN 2 THEN 'null'::jsonb WHEN 3 THEN '{}'::jsonb
 WHEN 4 THEN '{"satellite_target_id":null}'::jsonb
 WHEN 5 THEN '{"satellite_target_id":""}'::jsonb
 WHEN 6 THEN '{"satellite_target_id":"not-a-uuid"}'::jsonb
 WHEN 7 THEN jsonb_build_object('satellite_target_id',upper(md5('income-target')::uuid::text))
 WHEN 8 THEN '17'::jsonb WHEN 9 THEN '[]'::jsonb
 ELSE jsonb_build_object('satellite_target_id',md5('income-target')::uuid::text) END
FROM generate_series(1,22)n;
INSERT INTO tournament_tickets(id,status)
VALUES(md5('income-ticket-15')::uuid,'issued'),(md5('income-ticket-16')::uuid,'redeemed'),
      (md5('income-ticket-17')::uuid,'cancelled'),(md5('income-ticket-20')::uuid,NULL);
INSERT INTO tournament_satellite_awards(tournament_id,place,ticket_id,delivery_kind)
SELECT md5('income-source')::uuid,n,md5('income-ticket-'||n)::uuid,
 CASE WHEN n=18 THEN 'cash' ELSE 'ticket' END FROM generate_series(15,20)n;
-- The payout reader must ignore this unrelated majority without truncating
-- the target window or dropping a player class.
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT md5('income-source')::uuid,md5('income-noise-'||n)::uuid,1,'prize',1000+n,NULL
FROM generate_series(1,50000)n;
