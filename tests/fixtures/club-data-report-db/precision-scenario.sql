-- Sub-cent contribution shares must be summed before the displayed cent rounding.
-- The fixture and old rounded report commit before the deliberate assertion failure.
INSERT INTO clubs(id,name) VALUES('a0000000-0000-0000-0000-000000000099','Precision club') ON CONFLICT DO NOTHING;
WITH inserted AS (
 INSERT INTO tables(id,club_id,name)
 SELECT gen_random_uuid(),'a0000000-0000-0000-0000-000000000099','Precision fixture'
 FROM generate_series(1,200)
 WHERE NOT EXISTS (SELECT 1 FROM ca_club_data_fact WHERE club_id='a0000000-0000-0000-0000-000000000099'
  AND stat_date=(now() AT TIME ZONE 'UTC')::date-1)
 RETURNING id
)
INSERT INTO ca_club_data_fact(club_id,stat_date,kind,game_id,user_id,fee)
 SELECT 'a0000000-0000-0000-0000-000000000099',(now() AT TIME ZONE 'UTC')::date-1,'CASH',id,
 '00000000-0000-0000-0000-0000000000b1',1.000049 FROM inserted;
SELECT fn_ca_reporting_rollups_from_facts((now() AT TIME ZONE 'UTC')::date-1);
DO $$
DECLARE j constant uuid := 'a0000000-0000-0000-0000-000000000099';
 d date := (now() AT TIME ZONE 'UTC')::date-1; actual numeric; expected numeric;
BEGIN
 SELECT sum(rake) INTO actual FROM club_table_daily WHERE club_id=j AND stat_date=d;
 SELECT sum(fee) INTO expected FROM ca_club_data_fact WHERE club_id=j AND stat_date=d AND kind='CASH';
 IF actual IS DISTINCT FROM expected OR round(actual,2) IS DISTINCT FROM round(expected,2)
 THEN RAISE EXCEPTION 'Precision regression: table total % differs from ledger facts %',actual,expected; END IF;
 RAISE NOTICE 'PRECISION SCENARIO PASSED: % exact, displayed %',actual,round(actual,2);
END $$;
