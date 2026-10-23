SELECT set_config('test.access','staff',false), set_config('test.cutoff','',false);
-- Deliberately use another session zone. Only America/Chicago owns Today.
SET TIME ZONE 'Asia/Tokyo';
INSERT INTO clubs(id,name) VALUES('83000000-0000-0000-0000-000000000001','Chicago Fixture');
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net)
SELECT ('83000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,
 '83000000-0000-0000-0000-000000000002', '83000000-0000-0000-0000-000000000001',
 '83000000-0000-0000-0000-000000000004',
 CASE n WHEN 1 THEN bounds.start_at-interval '1 microsecond'
        WHEN 2 THEN bounds.start_at
        WHEN 3 THEN bounds.end_at-interval '1 microsecond'
        ELSE bounds.end_at END,
 'nlh', CASE n WHEN 1 THEN 100 WHEN 2 THEN 10 WHEN 3 THEN 20 ELSE 1000 END
FROM generate_series(1,4) n CROSS JOIN LATERAL (
 SELECT ((now() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago' start_at,
        (((now() AT TIME ZONE 'America/Chicago')::date+1)::timestamp AT TIME ZONE 'America/Chicago') end_at
) bounds;
INSERT INTO chip_ledger(club_id,from_type,to_type,to_entity_id,amount,tournament_id,status,created_at)
SELECT club_id,'prize_liability','player_wallet',user_id,net/10,
 '83000000-0000-0000-0000-000000000003','posted',played_at
FROM ca_hand_facts WHERE user_id='83000000-0000-0000-0000-000000000002';
CREATE TABLE chicago_longer_baseline AS
 SELECT ca_club_member_win_loss('83000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000002') AS value;
