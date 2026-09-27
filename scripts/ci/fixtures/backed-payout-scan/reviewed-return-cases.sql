-- An independent oracle assigns each isolated event its expected net return.
-- The common overlay is GREATEST(10,13), never the sum. No wallet effects are
-- present initially, so the scalar delta must be round(13 - expected_return,2).
CREATE TABLE fixture_expected_returns(n integer PRIMARY KEY,amount numeric NOT NULL);
INSERT INTO fixture_expected_returns VALUES
 (1,13),(2,20),(3,-3),(4,0),(5,0),(6,0),(7,0),(8,0),(9,0),(10,0),
 (11,0),(12,0),(13,0),(14,4.005),(15,12.985),(16,12.986),(17,5),(18,0);
INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status,fixture_topup)
SELECT md5('return-'||n)::uuid,'return-'||n,md5('club')::uuid,100,
 now()-interval '2 days'-make_interval(secs=>n),'COMPLETED',2 FROM fixture_expected_returns;
INSERT INTO chip_ledger(tournament_id,amount,category,to_type)
SELECT md5('return-'||n)::uuid,10,'overlay','prize_liability' FROM fixture_expected_returns;
INSERT INTO tournament_guarantee_overlays
SELECT md5('return-'||n)::uuid,13 FROM fixture_expected_returns;
INSERT INTO chip_ledger(tournament_id,amount,category,from_type,from_entity_id,metadata)
SELECT CASE WHEN n=10 THEN NULL ELSE md5('return-'||n)::uuid END,
 CASE n WHEN 1 THEN 13 WHEN 2 THEN 20 WHEN 3 THEN -3 WHEN 4 THEN 0
 WHEN 5 THEN NULL WHEN 14 THEN 4.005 WHEN 15 THEN 12.985 WHEN 16 THEN 12.986 ELSE 999 END,
 CASE WHEN n=6 THEN 'Reversal' ELSE 'reversal' END,
 CASE WHEN n=7 THEN 'club_treasury' ELSE 'prize_liability' END,
 CASE WHEN n=8 THEN md5('other')::uuid WHEN n=9 THEN NULL ELSE md5('return-'||n)::uuid END,
 CASE n WHEN 11 THEN NULL WHEN 12 THEN '{}'::jsonb
 WHEN 13 THEN '{"kind":"Reviewed_void_overlay_return"}'::jsonb
 WHEN 18 THEN '{"kind":["reviewed_void_overlay_return"]}'::jsonb
 ELSE '{"kind":"reviewed_void_overlay_return"}'::jsonb END
FROM fixture_expected_returns WHERE n<>17;
-- Duplicate recorded return legs, including cancellation/NULL amounts, sum as
-- recorded. They are not deduplicated or limited to positive money.
INSERT INTO chip_ledger(tournament_id,amount,category,from_type,from_entity_id,metadata)
SELECT md5('return-17')::uuid,amount,'reversal','prize_liability',md5('return-17')::uuid,
 '{"kind":"reviewed_void_overlay_return"}'::jsonb FROM (VALUES(4::numeric),(4),(-3),(NULL))x(amount);
