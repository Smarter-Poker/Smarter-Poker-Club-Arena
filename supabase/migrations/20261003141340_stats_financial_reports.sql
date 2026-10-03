-- 20261003141340_stats_financial_reports.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Phase 7: owner-only, club/range/asset financial reporting. These reads never
-- infer money from hands. Tournament rows come from the player's immutable
-- wallet journal; rakeback comes from period and payout receipts.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.ca_player_stats_financial_report(
  p_user uuid,p_club_id uuid DEFAULT NULL,p_days integer DEFAULT NULL,
  p_tz text DEFAULT 'UTC',p_asset text DEFAULT 'chips'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  IF p_club_id IS NOT NULL THEN PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset); END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  RETURN (WITH eligible AS MATERIALIZED (
    SELECT DISTINCT c.id FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
    WHERE m.user_id=p_user AND m.status IN ('active','approved')
      AND coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR c.id=p_club_id)
  ), tx AS MATERIALIZED (
    SELECT w.id,w.created_at,w.related_entity_id tournament_id,t.club_id,w.type,w.category,
      round(w.amount,2) amount,w.balance_after,w.description
    FROM public.wallet_transactions w JOIN public.tournaments t ON t.id=w.related_entity_id
    JOIN eligible e ON e.id=t.club_id
    WHERE w.user_id=p_user AND p_asset='chips'
      AND lower(w.category) IN ('tournament_buyin','rebuy','addon','refund','tournament_refund',
        'tournament_prize','tournament_winnings','tournament_cashout','bounty','ticket_issue',
        'ticket_redeem','correction','reversal','prize_reversal')
      AND (v_from IS NULL OR w.created_at>=v_from) AND (v_to IS NULL OR w.created_at<v_to)
  ), categories AS (
    SELECT lower(category) category,lower(type) direction,count(*)::integer entries,round(sum(amount),2) amount
    FROM tx GROUP BY 1,2
  ), tournament_totals AS (
    SELECT count(*)::integer journal_rows,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='debit'),0),2) debits,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='credit'),0),2) credits,
      round(coalesce(sum(CASE WHEN lower(type)='credit' THEN amount
        WHEN lower(type)='debit' THEN -amount ELSE 0 END),0),2) net
    FROM tx
  ), periods AS MATERIALIZED (
    SELECT r.id,r.club_id,r.period_start,r.period_end,r.rake_generated,r.rakeback_rate,
      coalesce(r.rakeback_amount,r.rakeback_earned,0) amount,r.status,r.paid_at,
      r.deferred_reason,r.deferred_at,r.defer_count
    FROM public.rakeback_periods r JOIN eligible e ON e.id=r.club_id
    WHERE r.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR r.period_end>=v_from) AND (v_to IS NULL OR r.period_start<v_to)
  ), payouts AS MATERIALIZED (
    SELECT p.id,p.rakeback_period_id,p.club_id,p.payout_amount,p.currency,p.status,p.paid_at,
      p.wallet_transaction_id,p.failure_reason,p.created_at
    FROM public.rakeback_period_payouts p JOIN eligible e ON e.id=p.club_id
    WHERE p.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR coalesce(p.paid_at,p.created_at)>=v_from)
      AND (v_to IS NULL OR coalesce(p.paid_at,p.created_at)<v_to)
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object(
      'target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','owner'),'generated_at',now(),
    'availability',jsonb_build_object(
      'tournament_wallet',p_asset='chips','rakeback',p_asset='chips',
      'bankroll_ledger',false,'bankroll_reason','no_club_scoped_authoritative_player_balance_series',
      'cash_sessions',false,'cash_sessions_reason','session_identity_has_no_final_stack_or_hand_foreign_key'),
    'tournament_wallet',jsonb_build_object('source','wallet_transactions',
      'totals',(SELECT to_jsonb(tournament_totals) FROM tournament_totals),
      'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY category,direction) FROM categories c),'[]'::jsonb),
      'entries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id DESC) FROM
        (SELECT * FROM tx ORDER BY created_at DESC,id DESC LIMIT 250) x),'[]'::jsonb),
      'capped',(SELECT count(*)>250 FROM tx)),
    'rakeback',jsonb_build_object('source','rakeback_periods+rakeback_period_payouts',
      'pending_amount',coalesce((SELECT round(sum(amount),2) FROM periods WHERE status='pending'),0),
      'paid_amount',coalesce((SELECT round(sum(payout_amount),2) FROM payouts WHERE status='paid'),0),
      'periods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY period_end DESC,id DESC) FROM periods p),'[]'::jsonb),
      'payout_receipts',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY coalesce(paid_at,created_at) DESC,id DESC) FROM payouts p),'[]'::jsonb)),
    'bankroll',jsonb_build_object('available',false,'series','[]'::jsonb),
    'cash_sessions',jsonb_build_object('available',false,'sessions','[]'::jsonb)));
END;$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)
  TO authenticated,service_role;
COMMENT ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text) IS
  'Owner-only financial report. Tournament wallet entries and rakeback receipts are authoritative. Club-scoped bankroll history and cashier sessions remain explicitly unavailable because no durable source carries the required identity and closing balance.';
COMMIT;
