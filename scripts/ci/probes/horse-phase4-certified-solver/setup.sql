CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END;
$roles$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
CREATE OR REPLACE FUNCTION public.fn_training_canonical_jsonb_text_v1(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT p::text $$;
CREATE OR REPLACE FUNCTION public.fn_gto_texture_class(p_board text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE ranks int[]:='{}'; suits text[]:='{}'; i int; r int; hi int:=0; high text; sk text; paired bool; conn bool:=false; distinct_r int[];
BEGIN
 IF p_board IS NULL OR length(p_board)<>6 THEN RETURN NULL; END IF;
 FOR i IN 0..2 LOOP
  r:=CASE substr(p_board,i*2+1,1) WHEN 'A' THEN 14 WHEN 'K' THEN 13 WHEN 'Q' THEN 12 WHEN 'J' THEN 11 WHEN 'T' THEN 10 ELSE nullif(substr(p_board,i*2+1,1),'')::int END;
  IF r IS NULL OR substr(p_board,i*2+2,1)!~'^[cdhs]$' THEN RETURN NULL; END IF;
  ranks:=ranks||r; suits:=suits||substr(p_board,i*2+2,1); hi:=greatest(hi,r);
 END LOOP;
 high:=CASE WHEN hi=14 THEN 'A' WHEN hi>=12 THEN 'B' WHEN hi>=9 THEN 'M' ELSE 'L' END;
 sk:=CASE WHEN suits[1]=suits[2] AND suits[2]=suits[3] THEN 'm' WHEN suits[1]=suits[2] OR suits[2]=suits[3] OR suits[1]=suits[3] THEN 't' ELSE 'r' END;
 paired:=ranks[1]=ranks[2] OR ranks[2]=ranks[3] OR ranks[1]=ranks[3];
 SELECT array_agg(DISTINCT x ORDER BY x) INTO distinct_r FROM unnest(ranks) x;
 IF array_length(distinct_r,1)>=2 AND distinct_r[array_length(distinct_r,1)]-distinct_r[1]<=4 THEN conn:=true; END IF;
 IF NOT conn AND distinct_r[array_length(distinct_r,1)]=14 AND distinct_r[greatest(1,array_length(distinct_r,1)-1)]<=5 THEN conn:=true; END IF;
 RETURN high||sk||CASE WHEN paired THEN 'p' ELSE 'u' END||CASE WHEN conn THEN 'c' ELSE 'd' END;
END $$;
CREATE OR REPLACE FUNCTION public.fn_gto_texture_class_any(p_board text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n int; ranks int[]:='{}'; suits text[]:='{}'; ch text; r int; i int; hi int:=0; high text; sk text; paired bool:=false; conn bool:=false; maxs int:=0; cnt int; dr int[]; win int;
BEGIN
 IF p_board IS NULL THEN RETURN NULL; END IF; n:=length(p_board)/2;
 IF n<3 OR n>5 OR length(p_board)%2<>0 THEN RETURN NULL; END IF;
 IF n=3 THEN RETURN public.fn_gto_texture_class(p_board); END IF;
 FOR i IN 0..n-1 LOOP ch:=substr(p_board,i*2+1,1); r:=CASE ch WHEN 'A' THEN 14 WHEN 'K' THEN 13 WHEN 'Q' THEN 12 WHEN 'J' THEN 11 WHEN 'T' THEN 10 ELSE nullif(ch,'')::int END; IF r IS NULL THEN RETURN NULL; END IF; ranks:=ranks||r; suits:=suits||substr(p_board,i*2+2,1); hi:=greatest(hi,r); END LOOP;
 high:=CASE WHEN hi=14 THEN 'A' WHEN hi>=12 THEN 'B' WHEN hi>=9 THEN 'M' ELSE 'L' END;
 SELECT max(c) INTO maxs FROM (SELECT count(*) c FROM unnest(suits) s GROUP BY s) x;
 sk:=CASE WHEN maxs>=4 THEN 'm' WHEN maxs=3 THEN 't' ELSE 'r' END;
 SELECT count(*) INTO cnt FROM (SELECT 1 FROM unnest(ranks) AS ur(value) GROUP BY ur.value HAVING count(*)>=2) p; paired:=cnt>0;
 SELECT array_agg(DISTINCT ur.value ORDER BY ur.value) INTO dr FROM unnest(ranks) AS ur(value);
 FOR win IN REVERSE 14..6 LOOP IF (SELECT count(*) FROM unnest(dr) AS ur(value) WHERE (ur.value<=win AND ur.value>win-5) OR (win=5 AND ur.value=14))>=3 THEN conn:=true; EXIT; END IF; END LOOP;
 IF NOT conn AND (SELECT count(*) FROM unnest(dr) AS ur(value) WHERE ur.value<=5 OR ur.value=14)>=3 THEN conn:=true; END IF;
 RETURN high||sk||CASE WHEN paired THEN 'p' ELSE 'u' END||CASE WHEN conn THEN 'c' ELSE 'd' END;
END $$;
CREATE TABLE public.solved_spots_gold (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scenario_hash text NOT NULL, game_type text, stack_depth int, street text,
 strategy_matrix jsonb, created_at timestamptz DEFAULT now(), strategy_matrix_v2 jsonb, solved_v2_at timestamptz,
 solver_version text, solver_binary_checksum text, machine_id text, pipeline_commit text, manifest_version text,
 pipeline_bundle_checksum text, manifest_checksum text, source_artifact_checksum text, quality_status text, audited_at timestamptz
);
CREATE TABLE public.horse_solver_agreement (
 run_date date NOT NULL, reference text NOT NULL, spots int NOT NULL DEFAULT 0,
 agreement numeric NOT NULL DEFAULT 0, pure_misses int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_date, reference)
);
CREATE TABLE public.horse_league_results (
 id bigserial PRIMARY KEY, run_date date NOT NULL, matchup text NOT NULL, hands int NOT NULL,
 bb100 numeric NOT NULL, stderr numeric NOT NULL, config_a jsonb NOT NULL DEFAULT '{}', config_b jsonb NOT NULL DEFAULT '{}',
 duration_ms int NOT NULL, illegal_actions int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_date,matchup)
);
CREATE OR REPLACE FUNCTION public.fn_is_horse_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TABLE public.ca_browser_definer_allowlist (
 proname text PRIMARY KEY,
 reason text NOT NULL CHECK (length(btrim(reason)) >= 20)
);
CREATE OR REPLACE FUNCTION public.fn_ca_browser_reachable_telemetry()
RETURNS TABLE(proname text,args text,reached_by text,volatility text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog,pg_temp AS $$
 SELECT p.proname::text,pg_get_function_identity_arguments(p.oid)::text,
        concat_ws(' + ',CASE WHEN has_function_privilege('anon',p.oid,'EXECUTE') THEN 'anon' END,
                         CASE WHEN has_function_privilege('authenticated',p.oid,'EXECUTE') THEN 'authenticated' END)::text,
        CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable' ELSE 'immutable' END::text
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND p.prosrc NOT ILIKE '%auth.uid()%' AND p.prosrc NOT ILIKE '%auth.role()%'
    AND p.prosrc NOT ILIKE '%auth.jwt()%' AND p.prosrc NOT ILIKE '%current_setting%request%'
    AND COALESCE(pg_get_function_identity_arguments(p.oid),'') !~*
        '(club|user|union|table|pool|tournament|group|member|owner|horse|author|sender|recipient|agent|payout|promotion|profile|seat|hand)'
    AND p.proname !~ '^(st_|_st_|postgis_)'
    AND NOT EXISTS (SELECT 1 FROM public.ca_browser_definer_allowlist a WHERE a.proname=p.proname)
  ORDER BY p.proname;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_browser_reachable_telemetry() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_browser_reachable_telemetry() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_run_horse_daily_audit(p_day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_findings jsonb := '[]'::jsonb;
BEGIN v_findings := v_findings || fn_audit_solver_agreement(p_day); RETURN v_findings; END;
$fn$;
