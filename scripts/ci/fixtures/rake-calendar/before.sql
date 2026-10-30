-- Same timezone/date helper as the overview, captured in preimages.sql.
CREATE TABLE calendar_legacy_baseline AS SELECT ca_player_rake_stats('69f2cefa-017d-49f3-ac3e-61505633747c') all_clubs,
 ca_player_rake_stats_by_club('69f2cefa-017d-49f3-ac3e-61505633747c',null,'chips','a41434bb-8d0c-400a-8f0d-e8b3d65afed4') one_club;
INSERT INTO clubs VALUES ('73000000-0000-0000-0000-000000000001','chips'),('73000000-0000-0000-0000-000000000003','diamonds');
-- Existing player with a clean independent club, and isolated boundary facts.
INSERT INTO ca_hand_facts(user_id,club_id,hand_id,played_at,rake_paid,big_blind)
SELECT '73000000-0000-0000-0000-000000000002','73000000-0000-0000-0000-000000000001',
 ('73000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,
 CASE n WHEN 1 THEN b.from_at-interval '1 microsecond' WHEN 2 THEN b.from_at
 WHEN 3 THEN b.to_at-interval '1 microsecond' ELSE b.to_at END,
 n,2 FROM ca_stats_calendar_bounds(7,'America/Chicago') b CROSS JOIN generate_series(1,4) n;
INSERT INTO ca_hand_facts(user_id,club_id,hand_id,played_at,rake_paid,big_blind)
SELECT '73000000-0000-0000-0000-000000000002','73000000-0000-0000-0000-000000000003',
 '73000000-0000-0000-0001-000000000005',b.from_at,50,2 FROM ca_stats_calendar_bounds(7,'America/Chicago') b;
-- Capture authoritative legacy difference without relying on the time of day.
DO $$ DECLARE b record; j jsonb; BEGIN
 SELECT * INTO b FROM ca_stats_calendar_bounds(7,'America/Chicago');
 j:=ca_player_rake_stats('73000000-0000-0000-0000-000000000002',7,'chips');
 IF (j->>'hands')::int=2 THEN RAISE EXCEPTION 'Rolling regression did not reproduce'; END IF;
 RAISE NOTICE 'REPRODUCED rolling/calendar rake mismatch: %',j;
END $$;
