-- Synthetic principals/wallets added before enabling the captured trigger graph.
INSERT INTO club_members(club_id,user_id,role,chip_balance,status,is_bot)
SELECT test_id(900),test_id(n),CASE n WHEN 301 THEN 'super_agent' WHEN 302 THEN 'agent' ELSE 'sub_agent' END,0,'active',false
FROM unnest(ARRAY[301,302,303]) n;

UPDATE table_seats SET joined_at='2026-07-01T00:00:00Z';
