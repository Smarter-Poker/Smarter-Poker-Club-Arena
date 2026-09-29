-- fn_tournament_late_registration_open as installed on production
-- (kuklfnapbkmacvwxktbh), read with pg_get_functiondef on 2026-09-26.
-- prosrc md5 920def27870ad5babe69dac7622025f7; ACL
-- {postgres=X/postgres,service_role=X/postgres}. This is the preimage that
-- migration 20260926035534 replaces, and the RED side of
-- scripts/ci/test-late-registration-clock.py.
CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND COALESCE(t.current_level,0)>=0
       AND COALESCE(t.late_reg_levels,0)>=0
       AND COALESCE(t.rebuy_levels,0)>=0
       AND COALESCE(t.late_reg_mins,0)>=0
       AND (
         CASE
           WHEN COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
             THEN COALESCE(t.current_level,0)
                    <COALESCE(t.late_reg_levels,t.rebuy_levels,0)
           WHEN COALESCE(t.late_reg_mins,0)>0
             THEN t.started_at IS NOT NULL
              AND clock_timestamp()
                    <t.started_at+make_interval(mins=>t.late_reg_mins)
           ELSE false
         END
       )
       AND (
         public.fn_ca_tournament_is_unlimited(t.id)
         OR t.max_players IS NULL OR t.max_players<=0 OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_late_registration_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_late_registration_open(uuid) TO service_role;
