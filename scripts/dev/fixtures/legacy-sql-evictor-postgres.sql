CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,command text,active boolean);
-- Adapter for pg_cron's installed cron.unschedule(bigint) API. This fixture
-- proves transaction/job selection, not execution of the pg_cron scheduler.
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN DELETE FROM cron.job WHERE jobid=$1; RETURN FOUND; END $$;
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE TABLE tables(id uuid PRIMARY KEY,game_type text,tournament_id uuid);
CREATE TABLE table_seats(table_id uuid,user_id uuid,left_at timestamptz,sit_out_at timestamptz,stack numeric,is_sitting_out boolean);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,status text);
CREATE TABLE attempted_legacy_departures(table_id uuid,user_id uuid);
CREATE FUNCTION player_leave_table(uuid,uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO attempted_legacy_departures VALUES($1,$2)
$$;
INSERT INTO cron.job VALUES
 (152,'sp_evict_sitting_out_cash_players','SELECT public.fn_evict_sitting_out_cash_players();',true),
 (999,'unrelated_job','SELECT 1;',true);
INSERT INTO tables VALUES('dddddddd-dddd-dddd-dddd-dddddddddddd','cash',NULL);
INSERT INTO table_seats VALUES('dddddddd-dddd-dddd-dddd-dddddddddddd',
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NULL,now()-interval '6 minutes',25,true);
