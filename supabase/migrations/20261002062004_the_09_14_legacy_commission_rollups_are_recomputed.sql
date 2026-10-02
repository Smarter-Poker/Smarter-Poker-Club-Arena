-- 20261002062004_the_09_14_legacy_commission_rollups_are_recomputed.sql
--
-- THE 2026-09-14 LEGACY COMMISSION ROLLUPS ARE RECOMPUTED
--
-- After 20261002025516 pays the week of 2026-09-14 and writes one
-- agent_commission_settlements row per (club, agent) for the period
-- (settlement_ref owner_legacy:19aa02d6-1023-441a-9979-3e65ceab6240), this
-- recomputes those agents' agent_commission_unsettled_rollup rows with the
-- installed fn_agent_commission_rollup_recompute, so no screen shows the
-- settled week as owed. A derived read model: no chip moves, and a rerun
-- computes the same rows. Locks the rollup rows in key order first.
--
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s JOIN public.agent_commission_unsettled_rollup r ON r.club_id = s.club_id AND r.user_id = s.user_id WHERE s.settlement_ref = 'owner_legacy:19aa02d6-1023-441a-9979-3e65ceab6240' AND r.updated_at < s.paid_at))

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '600s';

DO $op$
DECLARE v_pairs jsonb; v_n int;
BEGIN
  IF (SELECT state FROM public.accounting_owner_legacy_operations WHERE operation_id = '19aa02d6-1023-441a-9979-3e65ceab6240') IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'the week of 2026-09-14 is not paid yet (apply 20261002025516 first)';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('club_id', club_id, 'user_id', user_id) ORDER BY club_id, user_id), count(*)
    INTO v_pairs, v_n
    FROM public.agent_commission_settlements WHERE settlement_ref = 'owner_legacy:19aa02d6-1023-441a-9979-3e65ceab6240';
  IF COALESCE(v_n, 0) = 0 THEN RAISE EXCEPTION 'no owner legacy settlement rows for 19aa02d6'; END IF;
  PERFORM 1 FROM public.agent_commission_unsettled_rollup r
    WHERE (r.club_id, r.user_id) IN (SELECT club_id, user_id FROM public.agent_commission_settlements WHERE settlement_ref = 'owner_legacy:19aa02d6-1023-441a-9979-3e65ceab6240')
    ORDER BY r.club_id, r.user_id FOR UPDATE;
  PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  RAISE NOTICE 'recomputed % agent rollups', v_n;
END
$op$;

COMMIT;
