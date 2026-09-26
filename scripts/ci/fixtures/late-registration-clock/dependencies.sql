-- The relations fn_tournament_late_registration_open reads, reduced to the
-- columns it reads (types as on production), and the three functions it calls,
-- verbatim from production (kuklfnapbkmacvwxktbh, 2026-09-26):
--   fn_ca_tournament_is_unlimited       prosrc md5 d44fd7f56e1f68110fd67e84c7392cd1
--   fn_ca_lock_mtt_admission_contract   prosrc md5 2d06ee6affeed8412ee453e12212e88c
--   fn_ca_tournament_recorded_format    prosrc md5 03d5617c3dc803df7cb7da0468e23c91
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text,
  status text,
  format_contract text,
  prize_pool_finalized boolean DEFAULT false,
  current_level integer DEFAULT 0,
  late_reg_levels integer,
  rebuy_levels integer,
  late_reg_mins integer,
  started_at timestamptz,
  max_players integer
);
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL
);
CREATE TABLE public.ca_mtt_admission_contract (
  singleton boolean PRIMARY KEY DEFAULT true,
  abi text NOT NULL
);
INSERT INTO public.ca_mtt_admission_contract VALUES (true, 'unlimited-mtt-v2');

CREATE OR REPLACE FUNCTION public.fn_ca_lock_mtt_admission_contract()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text;
BEGIN
  SELECT format_contract INTO v_format FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND OR v_format IS NULL OR v_format NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1') THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
  END IF;
  RETURN v_format;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN false; END IF;
 RETURN public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2');
END $function$;
