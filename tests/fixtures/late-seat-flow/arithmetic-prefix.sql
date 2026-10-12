WITH flows(ledger_id,club_id,user_id,buyins,cashouts,kind,valid) AS (VALUES
 ('00000000-0000-0000-0000-000000000101'::uuid,'00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000011'::uuid,100::numeric,0::numeric,'cash_funding',true),
 ('00000000-0000-0000-0000-000000000102'::uuid,'00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000011'::uuid,0::numeric,100::numeric,'cash_return',true),
 ('00000000-0000-0000-0000-000000000103'::uuid,'00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000011'::uuid,0::numeric,5::numeric,'cash_late_settlement',true),
 ('00000000-0000-0000-0000-000000000104'::uuid,'00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000012'::uuid,100::numeric,0::numeric,'cash_funding',true)),
 hand_players(club_id,user_id,delta) AS (VALUES
 ('00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000011'::uuid,5::numeric),
 ('00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000012'::uuid,-5::numeric)),
 opening(club_id,amount,cash) AS (SELECT '00000000-0000-0000-0000-000000000001'::uuid,0::numeric,0::numeric),
 closing(club_id,amount,cash) AS (SELECT '00000000-0000-0000-0000-000000000001'::uuid,95::numeric,95::numeric),
 rake(club_id,generated,earned,cash_rake,tournament_rake) AS (SELECT '00000000-0000-0000-0000-000000000001'::uuid,0::numeric,0::numeric,0::numeric,0::numeric),
 roster(club_id) AS (SELECT '00000000-0000-0000-0000-000000000001'::uuid),
