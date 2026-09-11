-- Candidate only. Requires prospective source and bank contracts in the same reviewed cutover.
CREATE OR REPLACE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_club uuid;
BEGIN
 FOR v_club IN SELECT DISTINCT c FROM unnest(p_club_ids) c WHERE c IS NOT NULL ORDER BY c LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_club::text));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_lock_rakeback_payer_clubs(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_rakeback_period_has_captured(p_club uuid,p_user uuid,p_start date,p_end date) RETURNS boolean
LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 SELECT EXISTS(SELECT 1 FROM public.rake_records r JOIN public.hand_atomic_commits h ON h.hand_id=r.hand_id
 WHERE r.club_id=p_club AND h.commission_capture_version=1
 AND r.created_at>=p_start::timestamp AT TIME ZONE 'UTC'
 AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'UTC'
 AND r.player_contributions ? p_user::text)
$f$;
CREATE FUNCTION public.fn_ca_legacy_player_rake(p_club uuid,p_user uuid,p_start date,p_end date) RETURNS numeric
LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 SELECT round(coalesce(sum(s.credit),0),2)
 FROM public.rake_records r
 CROSS JOIN LATERAL public.fn_rake_shares_for_record(r.hand_id,r.rake_amount,r.player_contributions,coalesce(r.rake_method,'DEALT_EQUAL')) s
 WHERE r.club_id=p_club AND r.created_at>=p_start::timestamp AT TIME ZONE 'UTC'
 AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'UTC'
 AND r.rake_amount>0 AND r.player_contributions ? p_user::text
 AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits h WHERE h.hand_id=r.hand_id AND h.commission_capture_version=1)
 AND s.user_id=p_user
$f$;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_period_has_captured(uuid,uuid,date,date),
 public.fn_ca_legacy_player_rake(uuid,uuid,date,date) FROM PUBLIC,anon,authenticated,service_role;
