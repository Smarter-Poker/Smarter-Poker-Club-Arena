-- Scenarios (week 2026-09-14 07:00 .. 09-21 07:00 UTC unless noted).
SELECT pg_temp.seed_race('aaaaaaaa-0000-0000-0000-000000000001',2000002,'2026-09-15 10:05:20+00',75.10,75.10,147.90,'addon',5,228.00,NULL);  -- A: the production race, provable
SELECT pg_temp.seed_race('bbbbbbbb-0000-0000-0000-000000000002',2000012,'2026-09-15 11:00:00+00',75.10,75.10,147.90,'addon',5,228.00,'hand_delta_conservation_mismatch'); -- B: another defect
SELECT pg_temp.seed_race('cccccccc-0000-0000-0000-000000000003',2000022,'2026-09-15 12:00:00+00',75.10,75.10,147.90,'addon',5,80.10,NULL);   -- C: late chips never reach the next hand
SELECT pg_temp.seed_race('dddddddd-0000-0000-0000-000000000004',2000032,'2026-09-15 13:00:00+00',50.00,75.10,147.90,'addon',5,228.00,NULL);  -- D: dealt stack not explained
SELECT pg_temp.seed_race('eeeeeeee-0000-0000-0000-000000000005',2000042,'2026-09-15 14:00:00+00',75.10,75.10,147.90,'horse_funding',5,228.00,NULL); -- E: late credit is not a direct add-on
SELECT pg_temp.seed_race('abababab-0000-0000-0000-000000000007',2000062,'2026-09-15 15:00:00+00',75.10,75.10,147.90,'addon',5,228.00,NULL); -- G: left after the hand, exit carries the late chips
SELECT pg_temp.seed_race('acacacac-0000-0000-0000-000000000008',2000072,'2026-09-15 16:00:00+00',75.10,75.10,147.90,'addon',5,228.00,NULL); -- H: left, exit does not carry them
DELETE FROM public.cash_hand_participant_manifests WHERE (table_id,hand_number) IN (('abababab-0000-0000-0000-000000000007',2000063),('acacacac-0000-0000-0000-000000000008',2000073));
INSERT INTO public.ca_seat_stack_exits(seat_id,table_id,user_id,stack,exit_kind,occurred_at) VALUES
 (md5('abababab-0000-0000-0000-000000000007s1')::uuid,'abababab-0000-0000-0000-000000000007',md5('abababab-0000-0000-0000-000000000007u1')::uuid,228.00,'cashout','2026-09-15 15:00:40+00'),
 (md5('acacacac-0000-0000-0000-000000000008s1')::uuid,'acacacac-0000-0000-0000-000000000008',md5('acacacac-0000-0000-0000-000000000008u1')::uuid,80.10,'cashout','2026-09-15 16:00:40+00');
SELECT pg_temp.seed_race('ffffffff-0000-0000-0000-000000000006',2000052,'2026-09-08 10:00:00+00',75.10,75.10,147.90,'addon',-3,220.00,NULL); -- F: week 09-07, provable only

-- STAGE 1: the reviewed production preimage refuses both weeks (the incident).
DO $s1$
DECLARE r jsonb; q jsonb;
BEGIN
 r:=public.fn_union_pnl_evidence_report('fade0000-0000-0000-0000-000000000001','2026-09-14 07:00+00','2026-09-21 07:00+00');
 IF r->>'status'<>'blocked' OR NOT (r->'issues' @> '[{"reason":"accepted_cash_basis_incomplete","count":7}]') THEN
  RAISE EXCEPTION 'stage1: expected 7 blocked accepted cash hands, got %',r->'issues'; END IF;
 q:=public.fn_union_pnl_close_quality('fade0000-0000-0000-0000-000000000001','2026-09-07 07:00+00','2026-09-14 07:00+00');
 IF q->>'status'<>'blocked' THEN RAISE EXCEPTION 'stage1: week 09-07 should be refused before resolution: %',q; END IF;
 RAISE NOTICE 'PASS stage1 preimage refuses: %',r->'issues';
END $s1$;
