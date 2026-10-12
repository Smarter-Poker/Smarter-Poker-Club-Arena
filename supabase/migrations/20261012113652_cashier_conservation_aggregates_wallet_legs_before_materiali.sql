-- Cashier conservation aggregates both wallet sides before materializing.
-- Reserved by scripts/new-migration.mjs; original installed migration is immutable.
-- Production read timeouts coincided with ~116 MiB temporary writes per report.
-- Preserve all booked legs, both peer sides, each baseline cutoff, authority and
-- incomplete coverage. Materialize per-position sums instead of raw journal rows.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)') AND md5(prosrc)='f74f908237e0dc2f785e1004fe69bfa5' AND prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE'))
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_cashier_conservation_report(uuid)')))
     IS DISTINCT FROM '070c95f0e89b41685aaf584068e76fce' THEN
    RAISE EXCEPTION 'Cashier Conservation Preimage Changed Or Migration Already Applied'
      USING ERRCODE = '55000';
  END IF;
END;
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_report jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE='42501';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'Club Required' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND status='deleted')
    OR NOT public.fn_cashier_member_is_active(p_club_id,auth.uid())
    OR coalesce(public.fn_club_bank_role(p_club_id,auth.uid()),'')
      NOT IN ('owner','co_owner','admin') THEN
    RAISE EXCEPTION 'Active Club Finance Access Required' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='chips') THEN
    RAISE EXCEPTION 'Accounting Report Covers Chip Clubs Only' USING ERRCODE='22023';
  END IF;

  -- chip_ledger records booked movement, including correction/reversal legs.
  -- Its validated NOT NULL status contract admits only posted/correction/reversal.
  -- Read every leg; filtering only posted would omit real money and force heap
  -- reads instead of the existing covering player-wallet index.
  WITH bank AS MATERIALIZED (
    SELECT c.chip_treasury AS actual,b.opening_balance,b.taken_at,
      b.opening_balance
        + coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.club_id=p_club_id AND l.to_type='club_treasury'
            AND l.to_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0)
        - coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.club_id=p_club_id AND l.from_type='club_treasury'
            AND l.from_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0) AS expected
    FROM public.clubs c LEFT JOIN public.ca_treasury_baseline b ON b.club_id=c.id
    WHERE c.id=p_club_id
  ), baselines AS MATERIALIZED (
    SELECT user_id,opening_balance,taken_at FROM public.ca_chip_baseline WHERE club_id=p_club_id
  ), moves AS MATERIALIZED (
    -- Read each booked player-wallet leg once, retaining both sides and each
    -- position's own baseline cutoff. Only per-position sums are materialized.
    SELECT side.user_id, sum(side.amount) AS net
    FROM public.chip_ledger l
    CROSS JOIN LATERAL (VALUES
      (l.to_entity_id, l.amount, l.to_type='player_wallet'),
      (l.from_entity_id, -l.amount, l.from_type='player_wallet')
    ) AS side(user_id, amount, is_player)
    JOIN baselines b ON b.user_id=side.user_id AND l.created_at>=b.taken_at
    WHERE l.club_id=p_club_id
      AND l.created_at>=(SELECT min(taken_at) FROM baselines)
      AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
      AND side.is_player
    GROUP BY side.user_id
  ), positions AS MATERIALIZED (
    SELECT coalesce(m.user_id,b.user_id) AS user_id,m.chip_balance AS actual,
      b.opening_balance,b.taken_at,b.opening_balance+coalesce(mv.net,0) AS expected
    FROM (SELECT user_id,chip_balance FROM public.club_members WHERE club_id=p_club_id) m
    FULL JOIN baselines b USING(user_id)
    LEFT JOIN moves mv ON mv.user_id=b.user_id
  ), classified AS (
    SELECT *,actual IS NOT NULL AND opening_balance IS NOT NULL
      AND taken_at IS NOT NULL AND taken_at<=statement_timestamp() AS covered
    FROM positions
  ), totals AS (
    SELECT count(*) AS positions,count(*) FILTER(WHERE covered) AS checked,
      count(*) FILTER(WHERE NOT covered) AS missing,
      count(*) FILTER(WHERE covered AND actual<>expected) AS mismatches,
      coalesce(sum(abs(actual-expected)) FILTER(WHERE covered),0) AS absolute_drift,
      coalesce(sum(actual-expected) FILTER(WHERE covered),0) AS net_drift,
      sum(actual) FILTER(WHERE covered) AS actual,sum(expected) FILTER(WHERE covered) AS expected
    FROM classified
  )
  SELECT jsonb_build_object(
    'schema_version',1,'club_id',p_club_id,'as_of',statement_timestamp(),
    'scope','bank_and_player_baselines',
    'bank',jsonb_build_object(
      'status',CASE WHEN b.actual IS NULL OR b.opening_balance IS NULL OR b.taken_at IS NULL
        OR b.taken_at>statement_timestamp() THEN 'incomplete'
        WHEN b.actual<>b.expected THEN 'attention' ELSE 'verified' END,
      'actual',b.actual::text,'expected',b.expected::text,
      'drift',CASE WHEN b.taken_at<=statement_timestamp() THEN (b.actual-b.expected)::text END,
      'baseline_at',b.taken_at),
    'players',jsonb_build_object(
      'status',CASE WHEN t.mismatches>0 THEN 'attention'
        WHEN t.missing>0 OR t.checked=0 THEN 'incomplete' ELSE 'verified' END,
      'positions',t.positions,'checked',t.checked,'missing',t.missing,'mismatches',t.mismatches,
      'actual',t.actual::text,'expected',t.expected::text,
      'net_drift',t.net_drift::text,'absolute_drift',t.absolute_drift::text),
    'inventory',jsonb_build_object(
      'agent_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE agent_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(agent_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'promo_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE promo_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(promo_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'held_chips',(SELECT CASE WHEN count(*) FILTER(WHERE held_chips IS NULL)>0
        THEN NULL ELSE coalesce(sum(held_chips),0)::text END FROM public.club_members WHERE club_id=p_club_id),
      'cash_stacks',(SELECT CASE WHEN count(*) FILTER(WHERE s.stack IS NULL)>0
        THEN NULL ELSE coalesce(sum(s.stack),0)::text END FROM public.table_seats s
        JOIN public.tables t ON t.id=s.table_id WHERE t.club_id=p_club_id
          AND t.tournament_id IS NULL AND s.left_at IS NULL)
    )
  ) INTO v_report FROM bank b CROSS JOIN totals t;
  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE='22023';
  END IF;
  RETURN v_report;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_conservation_report(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_conservation_report(uuid) TO authenticated,service_role;
COMMENT ON FUNCTION public.fn_cashier_conservation_report(uuid) IS
  'On-demand read-only bank/player baseline comparison; other custody is inventory, never complete supply certification.';
COMMIT;
