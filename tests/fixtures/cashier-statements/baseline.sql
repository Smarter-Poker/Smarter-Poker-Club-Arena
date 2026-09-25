-- Seed data for the Cashier statement fixture.
--
-- Club A u(100): the statement club. Club B u(200): another club the same
-- player belongs to (isolation). Club C u(300): the 20,000-entry cap club,
-- filled by regression.sql. Club D u(400): the amount-format club (movements
-- of 9,999,999,999,999.99, the numeric(15,2) ceiling; a 2e13 total).
--
-- Production shapes copied (read-only probes, 2026-09-23): a receipt's
-- metadata.chip_ledger_id never resolves to a movement; a ticket redeem
-- receipt shares its movement's idempotency_key; a seat_credit_restored
-- receipt carries the refund movement's key as metadata.restore_key; a
-- tournament_ticket_issue receipt and its ticket_issue movement share only
-- the ticket_id; tournament_buyin / table_cashout / mint / rakeback /
-- cashout movements are mirrored by receipts with no key at all.
--
-- Members of club A
--   u(1) owner  u(2) co_owner  u(3) admin  u(4) super_agent
--   u(10) agent            -> downline u(10), u(11), u(20), u(21), u(25)
--   u(11) sub_agent  (agent u(10))
--   u(12) agent (not in u(10)'s tree; u(12) <-> u(22) is a cycle)
--   u(20) player (agent u(10))      u(21) player 'approved' (agent u(11))
--   u(22) player (agent u(12))      u(23) SUSPENDED player (agent u(10))
--   u(25) player, a horse (agent u(10))
--   u(26) active member with a NULL role
--   u(28) active player whose agent is the suspended u(23): not reachable
--   u(30) is not a member of club A
INSERT INTO public.profiles(id,username,display_name,alias,is_horse)
SELECT public.u(n),'user_'||n,'Display '||n,NULL,false FROM generate_series(1,40) n;
UPDATE public.profiles SET alias='Player Twenty' WHERE id=public.u(20);
UPDATE public.profiles SET alias='Player TwentyTwo' WHERE id=public.u(22);
UPDATE public.profiles SET alias='Quiet Rider',is_horse=true WHERE id=public.u(25);

INSERT INTO public.clubs VALUES
  (public.u(100),'Club A',public.u(1)),
  (public.u(200),'Club B',public.u(2)),
  (public.u(300),'Club C',public.u(3)),
  (public.u(400),'Club D',public.u(5));

INSERT INTO public.club_members(club_id,user_id,role,agent_id,status) VALUES
  (public.u(100),public.u(1),'owner',NULL,'active'),
  (public.u(100),public.u(2),'co_owner',NULL,'active'),
  (public.u(100),public.u(3),'admin',NULL,'active'),
  (public.u(100),public.u(4),'super_agent',NULL,'active'),
  (public.u(100),public.u(10),'agent',NULL,'active'),
  (public.u(100),public.u(11),'sub_agent',public.u(10),'active'),
  (public.u(100),public.u(12),'agent',public.u(22),'active'),
  (public.u(100),public.u(20),'member',public.u(10),'active'),
  (public.u(100),public.u(21),'member',public.u(11),'approved'),
  (public.u(100),public.u(22),'member',public.u(12),'active'),
  (public.u(100),public.u(23),'member',public.u(10),'suspended'),
  (public.u(100),public.u(25),'member',public.u(10),'active'),
  (public.u(100),public.u(26),NULL,NULL,'active'),
  (public.u(100),public.u(28),'member',public.u(23),'active'),
  (public.u(200),public.u(2),'owner',NULL,'active'),
  (public.u(200),public.u(20),'member',NULL,'active'),
  (public.u(300),public.u(3),'owner',NULL,'active'),
  (public.u(400),public.u(5),'owner',NULL,'active');

INSERT INTO public.agents(id,user_id,club_id,parent_agent_id) VALUES
  (public.u(901),public.u(10),public.u(100),NULL),
  (public.u(902),public.u(11),public.u(100),public.u(901)),
  (public.u(903),public.u(12),public.u(100),NULL);

-- Receipts in club A (chip_transactions). ids u(1001..).
INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,notes,related_cashout_id,metadata,created_at,balance_after,clawed_back,reversible_until,is_reversed,table_id) VALUES
  (public.u(1001),public.u(100),public.u(10),public.u(20),100.00,'agent_wallet_send','Weekly top up',NULL,'{"op_id":"op-r1","idempotency_key":"idem-r1"}','2026-09-10T12:00:00Z',600.00,false,now()+interval '1 day',false,NULL),
  (public.u(1002),public.u(100),public.u(20),public.u(10),30.00,'agent_wallet_claim_back',NULL,NULL,'{"op_id":"op-r2"}','2026-09-11T12:00:00Z',NULL,false,NULL,true,NULL),
  (public.u(1003),public.u(100),public.u(20),NULL,40.00,'cashout_request_escrow',NULL,public.u(3001),'{"op_id":"op-r3"}','2026-09-12T12:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1004),public.u(100),public.u(21),NULL,25.00,'cashout_request_escrow',NULL,public.u(3002),'{"op_id":"op-r4"}','2026-09-12T13:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1005),public.u(100),public.u(10),public.u(21),25.00,'cashout_approved',NULL,public.u(3002),'{"op_id":"op-r5"}','2026-09-12T14:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1006),public.u(100),public.u(1),public.u(22),50.00,'club_bank_send',NULL,NULL,'{"op_id":"op-r6"}','2026-09-13T12:00:00Z',NULL,true,NULL,false,NULL),
  (public.u(1007),public.u(100),public.u(1),public.u(25),500.00,'horse_treasury_funding','Horse funding for seat 3',NULL,'{"op_id":"horse-op-1","idempotency_key":"horse-funding:u25","is_horse":true}','2026-09-13T13:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1008),public.u(100),public.u(10),public.u(21),15.00,'tournament_ticket_issue',NULL,NULL,'{"ticket_id":"00000000-0000-0000-0000-000000004001"}','2026-09-14T12:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1009),public.u(100),public.u(10),public.u(20),20.00,'agent_wallet_send',NULL,NULL,'{"chip_ledger_id":"00000000-0000-0000-0000-000000002999","idempotency_key":"idem-r9"}','2026-09-15T12:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1010),public.u(100),public.u(1),public.u(22),10.00,'promo_wallet_send',NULL,NULL,'{"idempotency_key":"idem-shared"}','2026-09-15T13:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1011),public.u(100),public.u(10),public.u(10),5.00,'agent_wallet_send',NULL,NULL,NULL,'2026-09-15T14:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1012),public.u(100),public.u(22),public.u(12),7.00,'peer_transfer',NULL,NULL,NULL,'2026-09-16T12:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1013),public.u(100),public.u(10),public.u(23),9.00,'agent_wallet_send',NULL,NULL,NULL,'2026-09-16T13:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1014),public.u(100),public.u(10),public.u(28),3.00,'agent_wallet_send',NULL,NULL,NULL,'2026-09-16T14:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1015),public.u(100),public.u(10),public.u(20),999.00,'agent_wallet_send',NULL,NULL,NULL,'2026-08-15T12:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1016),public.u(100),public.u(28),public.u(22),4.00,'peer_transfer',NULL,NULL,NULL,'2026-09-16T15:00:00Z',NULL,false,NULL,false,NULL),
  -- Shares movement u(2020)'s idempotency_key and lands ten minutes after
  -- the September range ends: the movement is represented, so it is in NO
  -- range; the receipt is in the range that holds its own time.
  (public.u(1017),public.u(100),public.u(10),public.u(21),11.00,'agent_wallet_send',NULL,NULL,'{"idempotency_key":"cl-2020"}','2026-09-30T00:10:00Z',NULL,false,NULL,false,NULL),
  -- The receipt of refund movement u(2006) (restore_key = its idempotency_key).
  (public.u(1018),public.u(100),NULL,public.u(20),20.00,'seat_credit_restored',NULL,NULL,'{"op_id":"op-r18","restore_key":"restore-2006"}','2026-09-15T12:00:00Z',NULL,false,NULL,false,NULL),
  -- The receipt that mirrors tournament_buyin movement u(2022) (no key).
  (public.u(1019),public.u(100),public.u(20),NULL,33.00,'tournament_buyin',NULL,NULL,'{"op_id":"op-r19"}','2026-09-17T12:00:00Z',NULL,false,NULL,false,NULL),
  -- An escrow with no related_cashout_id: posted, never pending forever.
  (public.u(1020),public.u(100),public.u(22),NULL,6.00,'cashout_request_escrow',NULL,NULL,'{"op_id":"op-r20"}','2026-09-18T14:00:00Z',NULL,false,NULL,false,NULL),
  -- An escrow whose approval lands 2026-10-02, after p_to + 1 day of the
  -- September range: pending in September, posted in a range that holds it.
  (public.u(1021),public.u(100),public.u(21),NULL,12.00,'cashout_request_escrow',NULL,public.u(3004),'{"op_id":"op-r21"}','2026-09-20T13:00:00Z',NULL,false,NULL,false,NULL),
  (public.u(1022),public.u(100),public.u(10),public.u(21),12.00,'cashout_approved',NULL,public.u(3004),'{"op_id":"op-r22"}','2026-10-02T12:00:00Z',NULL,false,NULL,false,NULL);

-- Movements in club A (chip_ledger). ids u(2001..).
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,notes,club_id,table_id,hand_id,tournament_id,created_at,idempotency_key,correlation_id,post_from_balance,post_to_balance,status,metadata) VALUES
  (public.u(2001),'player_wallet',public.u(20),NULL,'table_stack',public.u(500),'Table Five',50,'buyin',NULL,public.u(100),public.u(500),NULL,NULL,'2026-09-10T12:00:00Z','cl-2001',NULL,450,NULL,'posted',NULL),
  (public.u(2002),'table_stack',public.u(500),'Table Five','player_wallet',public.u(20),NULL,70,'table_cashout',NULL,public.u(100),public.u(500),public.u(501),NULL,'2026-09-10T13:00:00Z','cl-2002',NULL,NULL,520,'posted',NULL),
  (public.u(2003),'table_stack',public.u(500),'Table Five','club_treasury',public.u(100),'Club Treasury',2,'rake',NULL,public.u(100),public.u(500),public.u(501),NULL,'2026-09-10T13:00:00Z','cl-2003',NULL,NULL,NULL,'posted',NULL),
  (public.u(2004),'club_treasury',public.u(100),'Club Treasury','player_wallet',public.u(25),'Horse stake',100,'horse_funding','horse seat',public.u(100),NULL,NULL,NULL,'2026-09-13T13:00:00Z','cl-2004',NULL,NULL,NULL,'posted','{"is_horse":true}'),
  (public.u(2005),'prize_liability',public.u(600),'Sunday Major','player_wallet',public.u(21),NULL,80,'tournament_prize',NULL,public.u(100),NULL,NULL,public.u(600),'2026-09-14T13:00:00Z','cl-2005',public.u(5005),NULL,NULL,'posted',NULL),
  (public.u(2006),'issuance_reserve',NULL,'Issuance Reserve','player_wallet',public.u(20),NULL,20,'refund',NULL,public.u(100),NULL,NULL,public.u(600),'2026-09-15T12:00:00Z','restore-2006',NULL,NULL,NULL,'posted',NULL),
  (public.u(2007),'promo_wallet',public.u(100),'Club Promo','promo_wallet',public.u(22),NULL,10,'promo_send',NULL,public.u(100),NULL,NULL,NULL,'2026-09-15T13:00:00Z','idem-shared',NULL,NULL,NULL,'posted',NULL),
  (public.u(2008),'player_wallet',public.u(20),NULL,'table_stack',public.u(500),'Table Five',60,'buyin',NULL,public.u(100),public.u(500),NULL,NULL,'2026-09-16T12:00:00Z','cl-2008',NULL,NULL,NULL,'pending',NULL),
  (public.u(2009),'club_treasury',public.u(100),'Club Treasury','player_wallet',public.u(22),NULL,12,'leaderboard_payout',NULL,public.u(100),NULL,NULL,NULL,'2026-09-17T12:00:00Z','cl-2009',NULL,NULL,NULL,'posted',NULL),
  (public.u(2010),'agent_wallet',public.u(10),NULL,'prize_liability',public.u(600),'Sunday Major',15,'ticket_issue',NULL,public.u(100),NULL,NULL,public.u(600),'2026-09-14T12:00:00Z','cl-2010',NULL,NULL,NULL,'posted','{"ticket_id":"00000000-0000-0000-0000-000000004001"}'),
  (public.u(2011),'issuance_reserve',NULL,'Issuance Reserve','club_treasury',public.u(100),'Club Treasury',1000,'mint',NULL,public.u(100),NULL,NULL,NULL,'2026-09-18T13:00:00Z','cl-2011',NULL,NULL,NULL,'posted',NULL),
  (public.u(2012),'club_treasury',public.u(100),'Club Treasury','spin_reserve',public.u(700),'Horse Pool Reserve',6,'adjustment','horse top-up',public.u(100),NULL,NULL,NULL,'2026-09-19T12:00:00Z','cl-2012',NULL,NULL,NULL,'posted',NULL),
  (public.u(2013),'spin_reserve',public.u(700),'Spin Reserve','player_wallet',public.u(25),NULL,8,'spin_prize',NULL,public.u(100),NULL,NULL,NULL,'2026-09-19T13:00:00Z','cl-2013',NULL,NULL,NULL,'posted','{"op_id":"op-m13","cashout_request_id":"00000000-0000-0000-0000-000000003003"}'),
  (public.u(2014),'escrow',public.u(3001),'Cashout Escrow','player_wallet',public.u(20),NULL,40,'cashout',NULL,public.u(100),NULL,NULL,NULL,'2026-09-20T12:00:00Z','idem-m14',NULL,NULL,480,'posted',NULL),
  (public.u(2015),'player_wallet',public.u(20),NULL,'table_stack',public.u(500),'Table Five',77,'buyin',NULL,public.u(100),public.u(500),NULL,NULL,'2026-10-05T12:00:00Z','cl-2015',NULL,NULL,NULL,'posted',NULL),
  (public.u(2020),'agent_wallet',public.u(10),NULL,'player_wallet',public.u(21),NULL,11,'transfer',NULL,public.u(100),NULL,NULL,NULL,'2026-09-29T23:30:00Z','cl-2020',NULL,NULL,NULL,'posted',NULL),
  (public.u(2021),'bbj_pool',public.u(800),'Bad Beat Jackpot','player_wallet',public.u(20),NULL,300,'bbj_payout',NULL,public.u(100),NULL,NULL,NULL,'2026-09-21T12:00:00Z','cl-2021',NULL,NULL,NULL,'posted',NULL),
  -- Mirrored by receipt u(1019) (same player, amount and instant; no key).
  (public.u(2022),'player_wallet',public.u(20),NULL,'prize_liability',public.u(600),'Sunday Major',33,'tournament_buyin',NULL,public.u(100),NULL,NULL,public.u(600),'2026-09-17T12:00:00Z','cl-2022',NULL,120,NULL,'posted',NULL),
  -- A rakeback movement: the rakeback receipt family mirrors the category.
  (public.u(2024),'club_treasury',public.u(100),'Club Treasury','player_wallet',public.u(20),NULL,3.5,'rakeback',NULL,public.u(100),NULL,NULL,NULL,'2026-09-18T12:00:00Z','cl-2024',NULL,NULL,210,'posted',NULL),
  -- A refund no receipt names: it is a statement movement.
  (public.u(2025),'prize_liability',public.u(600),'Sunday Major','player_wallet',public.u(21),NULL,9,'refund',NULL,public.u(100),NULL,NULL,public.u(600),'2026-09-19T14:00:00Z','refund-2025',NULL,NULL,NULL,'posted',NULL),
  -- A bounty paid to u(20) at a hand of the Sunday Major.
  (public.u(2026),'prize_liability',public.u(600),'Sunday Major','player_wallet',public.u(20),NULL,5,'bounty',NULL,public.u(100),NULL,public.u(502),public.u(600),'2026-09-14T14:00:00Z','cl-2026',NULL,NULL,525,'posted',NULL);

-- Club D: amounts at the numeric(15,2) ceiling and a total above 1e13.
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category,club_id,created_at,idempotency_key,status) VALUES
  (public.u(2301),'club_treasury',public.u(400),'Club Treasury','player_wallet',public.u(6),9999999999999.99,'player_funding',public.u(400),'2026-09-10T12:00:00Z','big-1','posted'),
  (public.u(2302),'club_treasury',public.u(400),'Club Treasury','player_wallet',public.u(6),9999999999999.99,'player_funding',public.u(400),'2026-09-10T13:00:00Z','big-2','posted');
INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES
  (public.u(1301),public.u(400),public.u(5),public.u(6),999999999999.99,'club_bank_send','2026-09-10T14:00:00Z');

-- Club B: the same player, another club. Never part of a club A statement.
INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES
  (public.u(1100),public.u(200),public.u(2),public.u(20),123.00,'agent_wallet_send','2026-09-10T12:00:00Z');
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,to_label,amount,category,club_id,created_at,status) VALUES
  (public.u(2100),'player_wallet',public.u(20),'table_stack',public.u(510),'Table Nine',321,'buyin',public.u(200),'2026-09-10T12:00:00Z','posted');

-- Paging load: 24 receipts and 24 player_funding movements over six
-- timestamps, so every timestamp carries eight entries of both sources and
-- page boundaries fall inside ties.
INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,created_at)
SELECT public.u(1200+n),public.u(100),public.u(20),public.u(21),n,'peer_transfer',
       '2026-09-05T10:00:00Z'::timestamptz + ((n % 6) * interval '1 hour')
  FROM generate_series(1,24) n;
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category,club_id,created_at,idempotency_key,status,post_to_balance)
SELECT public.u(2200+n),'club_treasury',public.u(100),'Club Treasury','player_wallet',public.u(20),n + 0.25,'player_funding',public.u(100),
       '2026-09-05T10:00:00Z'::timestamptz + ((n % 6) * interval '1 hour'),'pf-'||n,'posted',1000 + n
  FROM generate_series(1,24) n;
