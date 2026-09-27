-- Isolated synthetic NULL, signed, exact mirror and time-boundary cases.
INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,created_at)
SELECT u(90000+n),u(100),'club_wallet',CASE WHEN n%4=0 THEN NULL ELSE u(10) END,
 CASE WHEN n=6 THEN 'agent_wallet' ELSE 'player_wallet' END,
 CASE WHEN n=7 THEN NULL WHEN n=8 THEN u(21) ELSE u(20) END,
 CASE WHEN n%3=0 THEN -1.23 WHEN n%3=1 THEN 0 ELSE 999999.99 END,
 CASE WHEN n=9 THEN 'adjustment' ELSE 'refund' END,
 CASE WHEN n=10 THEN NULL ELSE 'mirror-edge-'||n END,
 CASE WHEN n=11 THEN '2026-09-01Z'::timestamptz
      WHEN n=12 THEN '2026-09-30Z'::timestamptz
      ELSE '2026-09-11Z'::timestamptz END
FROM generate_series(1,18) n;
INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,created_at) VALUES
 (u(91001),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-1"}','2026-09-10T23:59:00Z'),
 (u(91002),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-1"}','2026-09-11T00:01:00Z'),
 (u(91003),u(100),u(10),u(20),1,'topup','{"idempotency_key":"mirror-edge-1"}','2026-09-11Z'),
 (u(91004),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-2"}','2026-09-10T23:58:59.999999Z'),
 (u(91005),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-3"}','2026-09-11T00:01:00.000001Z'),
 (u(91006),u(200),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-4"}','2026-09-11Z'),
 (u(91007),u(100),u(10),u(21),1,'seat_credit_restored','{"restore_key":"mirror-edge-5"}','2026-09-11Z'),
 (u(91008),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-6"}','2026-09-11Z'),
 (u(91009),u(100),u(10),NULL,1,'seat_credit_restored','{"restore_key":"mirror-edge-7"}','2026-09-11Z'),
 (u(91010),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-8"}','2026-09-11Z'),
 (u(91011),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-9"}','2026-09-11Z'),
 (u(91012),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":null,"idempotency_key":null}','2026-09-11Z'),
 (u(91013),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-11"}','2026-08-31T23:59:00Z'),
 (u(91014),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":"mirror-edge-12"}','2026-09-29T23:59:00Z'),
 (u(91015),u(100),u(10),u(20),1,'topup','{"idempotency_key":"mirror-edge-13"}','2026-08-31Z'),
 (u(91016),u(100),u(10),u(20),1,'topup','{"idempotency_key":"mirror-edge-14"}','2026-10-01Z'),
 (u(91017),u(200),u(10),u(20),1,'topup','{"idempotency_key":"mirror-edge-15"}','2026-09-11Z'),
 (u(91018),u(100),u(10),u(20),1,'topup','{"restore_key":"mirror-edge-16"}','2026-09-11Z'),
 (u(91019),u(100),u(10),u(20),1,'topup',NULL,'2026-09-11Z'),
 (u(91020),u(100),u(10),u(20),1,'seat_credit_restored','{"restore_key":17}','2026-09-11Z');
