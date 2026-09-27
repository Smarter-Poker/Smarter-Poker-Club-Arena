CREATE OR REPLACE FUNCTION public.fn_settlement_conservation_check()
 RETURNS TABLE(issue text, severity text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 1. A settlement's own recorded totals must match the union ledger rows it
  --    claims to have written.
  SELECT 'pnl_collect_mismatch', 'critical',
         'Settlement ' || s.id || ' recorded total_collected ' || s.total_collected
           || ' but the union ledger shows ' || COALESCE(l.credited, 0)
    FROM union_pnl_settlements s
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(amount), 0) AS credited
        FROM union_wallet_transactions t
       WHERE t.union_id = s.union_id AND t.tx_type = 'player_pnl_collect'
         AND t.created_at >= s.period_start
         AND t.created_at <= COALESCE(s.settled_at, now()) + interval '1 minute'
    ) l ON true
   WHERE s.status = 'settled' AND s.total_collected > 0
     AND abs(s.total_collected - COALESCE(l.credited, 0)) > 0.01

  UNION ALL
  SELECT 'pnl_pay_mismatch', 'critical',
         'Settlement ' || s.id || ' recorded total_paid ' || s.total_paid
           || ' but the union ledger shows ' || COALESCE(l.debited, 0)
    FROM union_pnl_settlements s
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(amount), 0) AS debited
        FROM union_wallet_transactions t
       WHERE t.union_id = s.union_id AND t.tx_type = 'player_pnl_pay'
         AND t.created_at >= s.period_start
         AND t.created_at <= COALESCE(s.settled_at, now()) + interval '1 minute'
    ) l ON true
   WHERE s.status = 'settled' AND s.total_paid > 0
     AND abs(s.total_paid - COALESCE(l.debited, 0)) > 0.01

  UNION ALL
  -- 2. THE BUG THIS EXISTS FOR: a union hold taken from a club treasury must
  --    appear as a credit in the union's wallet. For months it did not, and
  --    those chips simply ceased to exist.
  SELECT 'union_hold_not_credited', 'critical',
         'club ' || ct.club_id || ' was debited ' || ct.amount
           || ' as a union hold on ' || ct.created_at::date
           || ' with no matching union wallet credit'
    FROM chip_transactions ct
   WHERE ct.transaction_type = 'union_hold'
     AND ct.created_at > now() - interval '90 days'
     AND NOT EXISTS (
       SELECT 1 FROM union_wallet_transactions t
        WHERE t.tx_type = 'settlement_hold'
          AND t.club_id = ct.club_id
          AND abs(t.amount - ct.amount) < 0.01
          AND t.created_at BETWEEN ct.created_at - interval '5 minutes'
                               AND ct.created_at + interval '5 minutes')

  UNION ALL
  -- 3. A negative pool is always a bug, never a business state.
  SELECT 'negative_balance', 'critical', pool || ' holds a negative balance: ' || amt
    FROM (
      SELECT 'club treasury ' || id::text AS pool, chip_treasury AS amt
        FROM clubs WHERE chip_treasury < 0
      UNION ALL
      SELECT 'union chip wallet ' || union_id::text, chip_balance
        FROM union_wallets WHERE chip_balance < 0
      UNION ALL
      SELECT 'union rake wallet ' || union_id::text, rake_wallet
        FROM union_wallets WHERE rake_wallet < 0
      UNION ALL
      SELECT 'player wallet ' || user_id::text, balance
        FROM wallets WHERE wallet_type = 'PLAYER' AND balance < 0
    ) neg;
$function$
