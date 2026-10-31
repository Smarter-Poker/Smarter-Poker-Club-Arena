-- Burls' 620.20 table share was paid on 2026-10-30 but omitted from Win/Loss.
-- Read the original unique paid-recipient receipts; never pay or rewrite facts.
-- Include main/mini, winner/loser/table and wallet/felt credits identically.
-- Funded hand ownership (including retained outcomes when facts are absent),
-- launch cutoffs, permissions and Chicago period boundaries are preserved.
-- The record, roster, detail and variant statistics share one private reader.
-- Signal through the existing private event transport inside the credit owner.
-- Function-only migration: no live table locks or engine replacement.
-- @live-proof: to_regprocedure('public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)') IS NOT NULL
-- @live-proof: position('ca_club_member_jackpot_money' IN pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure))>0
-- @live-proof: position('fn_publish_member_record_user' IN pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.ca_club_member_jackpot_money(
  p_club_id uuid, p_user_id uuid, p_from timestamptz, p_to timestamptz,
  p_variant text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $jackpot$
DECLARE v_amount numeric; v_unknown bigint;
BEGIN
  -- The unique payout/user receipt is written atomically with the credit.
  -- Count seated and departed recipients once, never the pool's aggregate leg
  -- or an unpaid parked allocation. Awards belong to their credit-time window.
  SELECT coalesce(sum(r.amount) FILTER(WHERE earned.club_id=p_club_id),0),
         count(*) FILTER(WHERE earned.club_id IS NULL)
    INTO v_amount,v_unknown
  FROM public.bbj_payout_recipients r
  JOIN public.bbj_payouts b ON b.id=r.payout_id
  LEFT JOIN public.ca_hand_facts f ON f.hand_id=b.hand_id AND f.user_id=r.user_id
  LEFT JOIN public.union_pnl_cash_outcomes o ON o.table_id=b.table_id AND o.hand_number=b.hand_number
  LEFT JOIN public.hand_history h ON h.id=b.hand_id
  CROSS JOIN LATERAL (
    SELECT coalesce(
      (SELECT (p->>'earning_club_id')::uuid
       FROM jsonb_array_elements(coalesce(o.evidence->'participants','[]')) p
       WHERE p->>'user_id'=r.user_id::text AND p->>'ownership_certified'='true' LIMIT 1),
      CASE WHEN f.hand_id IS NOT NULL THEN public.fn_member_record_fact_club(f) END,
      -- Some retained hands have no derived fact/outcome participant yet.
      -- Resolve the original occupancy exactly as the funded fact reader does.
      (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
       WHERE x.operation_kind='buyin' AND x.table_id=b.table_id
         AND x.account_entity_id=r.user_id AND x.seat_joined_at<=h.started_at
       ORDER BY x.seat_joined_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1),
      (SELECT a.club_id FROM public.rake_attributions a WHERE a.hand_id=b.hand_id AND a.player_id=r.user_id)
    ) AS club_id
  ) earned
  WHERE r.user_id=p_user_id AND r.amount>0 AND (earned.club_id=p_club_id OR earned.club_id IS NULL)
    AND (p_from IS NULL OR r.created_at>=p_from)
    AND (p_to IS NULL OR r.created_at<p_to)
    AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at)
    AND (p_variant IS NULL OR p_variant='all' OR lower(coalesce(f.game_variant,h.game_variant))=p_variant);
  IF v_unknown>0 THEN
    RAISE EXCEPTION 'Paid jackpot ownership evidence is unavailable' USING ERRCODE='55000';
  END IF;
  RETURN v_amount;
END;
$jackpot$;
REVOKE ALL ON FUNCTION public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)
  FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text := pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure);
BEGIN
 IF md5(d)<>'8050bcf18b46ec5722eca45816e07d81' THEN RAISE EXCEPTION 'Member jackpot preimage changed: ca_club_member_win_loss'; END IF;
 IF (length(d)-length(replace(d,$old$  v_mtt_today :=$old$,'')))/length($old$  v_mtt_today :=$old$)<>1
 THEN RAISE EXCEPTION 'Member jackpot anchor changed: ca_club_member_win_loss'; END IF;
 EXECUTE replace(d,$old$  v_mtt_today :=$old$,$new$  v_cash_today := v_cash_today + public.ca_club_member_jackpot_money(p_club_id,p_user_id,v_start,v_end);
  v_cash_week := v_cash_week + public.ca_club_member_jackpot_money(p_club_id,p_user_id,v_week::timestamp AT TIME ZONE 'America/Chicago',v_end);
  v_cash_month := v_cash_month + public.ca_club_member_jackpot_money(p_club_id,p_user_id,v_month::timestamp AT TIME ZONE 'America/Chicago',v_end);
  v_cash_all := v_cash_all + public.ca_club_member_jackpot_money(p_club_id,p_user_id,NULL,NULL);

  v_mtt_today :=$new$);
END $patch$;
DO $patch$
DECLARE d text := pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure);
BEGIN
 IF md5(d)<>'2c02c3c5ab3cff998243a34de1cec02c' THEN RAISE EXCEPTION 'Member jackpot preimage changed: ca_club_members_win_loss'; END IF;
 IF (length(d)-length(replace(d,$old$SELECT c.user_id uid,c.cash_net FROM public.ca_club_members_cash_window($old$,'')))/length($old$SELECT c.user_id uid,c.cash_net FROM public.ca_club_members_cash_window($old$)<>1
 THEN RAISE EXCEPTION 'Member jackpot anchor changed: ca_club_members_win_loss'; END IF;
 EXECUTE replace(d,$old$SELECT c.user_id uid,c.cash_net FROM public.ca_club_members_cash_window($old$,$new$SELECT c.user_id uid,c.cash_net + public.ca_club_member_jackpot_money(
      p_club_id,c.user_id,v_start,CASE WHEN v_from IS NULL THEN NULL ELSE v_end END) cash_net
    FROM public.ca_club_members_cash_window($new$);
END $patch$;
DO $patch$
DECLARE d text := pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure);
BEGIN
 IF md5(d)<>'0bc4c6079d7f0c8605b6eecd02331fd8' THEN RAISE EXCEPTION 'Member jackpot preimage changed: ca_club_member_detail'; END IF;
 IF (length(d)-length(replace(d,$old$'total_winnings', round(coalesce(rl.net, 0), 2)$old$,'')))/length($old$'total_winnings', round(coalesce(rl.net, 0), 2)$old$)<>1
 THEN RAISE EXCEPTION 'Member jackpot anchor changed: ca_club_member_detail'; END IF;
 EXECUTE replace(d,$old$'total_winnings', round(coalesce(rl.net, 0), 2)$old$,$new$'total_winnings', round(coalesce(rl.net, 0) + public.ca_club_member_jackpot_money(p_club_id,p_user_id,v_ts_from,v_ts_to), 2)$new$);
END $patch$;
DO $patch$
DECLARE d text := pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure);
BEGIN
 IF md5(d)<>'deacde08aa4db4e8fe5a00bd753e0edb' THEN RAISE EXCEPTION 'Member jackpot preimage changed: ca_club_member_statistics'; END IF;
 IF (length(d)-length(replace(d,$old$'net', round(a.net + CASE$old$,'')))/length($old$'net', round(a.net + CASE$old$)<>1
 THEN RAISE EXCEPTION 'Member jackpot anchor changed: ca_club_member_statistics'; END IF;
 EXECUTE replace(d,$old$'net', round(a.net + CASE$old$,$new$'net', round(a.net + public.ca_club_member_jackpot_money(p_club_id,p_user_id,v_from,v_to,v_variant) + CASE$new$);
END $patch$;
DO $patch$
DECLARE d text := pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure);
BEGIN
 IF md5(d)<>'55cc5d74e09b97e32702f0b02e3c2d65' THEN RAISE EXCEPTION 'Member jackpot preimage changed: bbj_credit_one_recipient'; END IF;
 IF (length(d)-length(replace(d,$old$  RETURN true;$old$,'')))/length($old$  RETURN true;$old$)<>1
 THEN RAISE EXCEPTION 'Member jackpot anchor changed: bbj_credit_one_recipient'; END IF;
 EXECUTE replace(d,$old$  RETURN true;$old$,$new$  -- Refresh the existing private member/roster consumers only after credit.
  -- PostgreSQL delivers the signal on commit; a rollback or duplicate emits none.
  PERFORM public.fn_publish_member_record_user(p_user_id);
  RETURN true;$new$);
END $patch$;
COMMIT;
