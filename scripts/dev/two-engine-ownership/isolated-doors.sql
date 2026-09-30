-- Loaded after live-doors.sql. The live trigger, the live grants, and the two
-- service-role entry points the probe engines call.
CREATE TRIGGER f06_aborted_generation AFTER INSERT OR UPDATE ON public.engine_tournament_leases
  FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_generation_guard();

DO $$
DECLARE f text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.pronamespace IN ('public'::regnamespace, 'smarter_private'::regnamespace)
              AND p.prokind = 'f' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
-- Exactly the production ACL: service_role executes these and nothing else.
GRANT EXECUTE ON FUNCTION public.claim_engine_leadership(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_engine_leadership(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(uuid, text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb) TO service_role;

-- In production the service role reaches the exact door only through
-- fn_ca_commit_hand_settlement, which adds the Diamond variant and the
-- post-commit obligations and then calls it. This stands in for that outer
-- door: same instance id, same lease generation, same exact door.
CREATE FUNCTION public.isolated_commit_hand(
  p_table_id uuid, p_hand_number bigint, p_instance_id text, p_lease_generation uuid,
  p_hold_seconds numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  RETURN public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id, p_hand_number, '[]'::jsonb, 0, 0,
    p_instance_id || '|' || p_lease_generation::text, 0,
    CASE WHEN p_hold_seconds IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('hold_seconds', p_hold_seconds) END,
    '[]'::jsonb, p_instance_id, p_lease_generation);
END $$;
REVOKE ALL ON FUNCTION public.isolated_commit_hand(uuid, bigint, text, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.isolated_commit_hand(uuid, bigint, text, uuid, numeric) TO service_role;

-- A dealer resumes its hand counter from the database, as the engine does.
CREATE FUNCTION public.isolated_last_hand(p_table_id uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT COALESCE(max(hand_number), 1000000) FROM public.isolated_hand_commits WHERE table_id = p_table_id
$$;
REVOKE ALL ON FUNCTION public.isolated_last_hand(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.isolated_last_hand(uuid) TO service_role;
