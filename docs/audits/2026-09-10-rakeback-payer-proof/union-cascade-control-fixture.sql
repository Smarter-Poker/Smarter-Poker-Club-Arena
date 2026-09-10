-- Control-flow rehearsal only: synthetic round effects, not actual money movement.
CREATE TABLE IF NOT EXISTS public.settlement_locks(lock_type text,is_active boolean);
CREATE TABLE IF NOT EXISTS public.union_settlement_floor(union_id uuid,earliest_period_start timestamptz);
CREATE TABLE IF NOT EXISTS public.union_rake_rollup_days(union_id uuid,day date);
CREATE TABLE IF NOT EXISTS public.union_settlement_rounds(
 union_id uuid,period_start timestamptz,period_end timestamptz,round_no integer,round_name text,
 payers integer,payees integer,amount numeric,shortfalls integer,detail jsonb,
 UNIQUE(union_id,period_start,period_end,round_no));
CREATE TABLE public.ca_cascade_probe_config(singleton boolean PRIMARY KEY,r2 jsonb,r3 jsonb,assert_fails boolean);
CREATE TABLE public.ca_cascade_probe_effects(id uuid DEFAULT gen_random_uuid(),kind text,amount numeric);
INSERT INTO ca_cascade_probe_config VALUES(true,'{"amount":70,"payees":1,"shortfalls":0}',
 '{"amount":15,"payees":1,"shortfalls":0,"source_final":false}',false);
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p timestamptz) RETURNS timestamptz
LANGUAGE sql AS $$ SELECT date_trunc('week',p AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles' $$;
CREATE OR REPLACE FUNCTION public.fn_union_prev_week_start(p timestamptz) RETURNS timestamptz
LANGUAGE sql AS $$ SELECT (date_trunc('week',p AT TIME ZONE 'America/Los_Angeles')-interval '7 days') AT TIME ZONE 'America/Los_Angeles' $$;
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_refresh_day(uuid,date) RETURNS jsonb
LANGUAGE sql AS $$ SELECT '{"synthetic_warmup":true}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ca_cascade_probe_effects(kind,amount) VALUES('round1',90);
 RETURN '{"success":true,"clubs_paid":1,"total_rakeback":90}'::jsonb; END $$;
CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ca_cascade_probe_effects(kind,amount) VALUES('round2',70);
 RETURN (SELECT r2 FROM ca_cascade_probe_config WHERE singleton); END $$;
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ca_cascade_probe_effects(kind,amount) VALUES('round3',15);
 RETURN (SELECT r3 FROM ca_cascade_probe_config WHERE singleton); END $$;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ca_cascade_probe_effects(kind) VALUES('assert');
 IF (SELECT assert_fails FROM ca_cascade_probe_config WHERE singleton) THEN
 RAISE EXCEPTION 'synthetic_conservation_failure' USING ERRCODE='23514'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_union_mark_period_settled(uuid,timestamptz,timestamptz) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ca_cascade_probe_effects(kind) VALUES('settled'); END $$;
