-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Deep-dive hardening batch (2026-09-01):
-- 1. diamond_transactions becomes append-only like every chip journal - the
--    diamond supply audit is only as good as a journal nobody can rewrite.
-- 2. A negative-balance watch: no store may go below zero silently. This
--    DETECTS (critical incident, one push); it never blocks a transaction,
--    per the standing never-lock rule. Today's baseline: zero negatives.
-- 3. Push-deliverability watch: if the registered recipient has no active
--    push subscription with a recent delivery receipt, the dashboard and the
--    daily dead-man session surface it - the alarm system now notices when
--    its own siren is unplugged.
-- 4. Hygiene: fn_record_new_club_opening_bank (a trigger function) loses its
--    stray authenticated EXECUTE grant.
SET LOCAL lock_timeout = '4s';

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.diamond_transactions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.diamond_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

REVOKE ALL ON FUNCTION public.fn_record_new_club_opening_bank() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_negative_balance_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_hits int := 0; r record; v_stale int;
BEGIN
  FOR r IN
    SELECT 'club_members' AS store, user_id::text AS who, club_id, chip_balance AS bal
      FROM club_members WHERE chip_balance < 0
    UNION ALL
    SELECT 'clubs', id::text, id, chip_treasury FROM clubs WHERE chip_treasury < 0
    UNION ALL
    SELECT 'union_wallets', union_id::text, NULL,
           LEAST(chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet,
                 COALESCE(spin_reserve_wallet,0))
      FROM union_wallets
     WHERE LEAST(chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet,
                 COALESCE(spin_reserve_wallet,0)) < 0
    UNION ALL
    SELECT 'agents', user_id::text, club_id,
           LEAST(COALESCE(agent_wallet_balance,0), COALESCE(promo_wallet_balance,0))
      FROM agents
     WHERE COALESCE(agent_wallet_balance,0) < 0 OR COALESCE(promo_wallet_balance,0) < 0
    LIMIT 20
  LOOP
    v_hits := v_hits + 1;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_negative_balance_watch', 'ledger_imbalance', 'critical',
      'negative-balance:' || r.store || ':' || r.who,
      r.bal, 0, r.bal, 'ledger', r.store, NULL, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a balance store went below zero - a debit path is missing its floor check; nothing was blocked, review the store''s recent ledger rows',
      false, jsonb_build_object('store', r.store, 'entity', r.who, 'balance', r.bal));
  END LOOP;

  -- the siren's own power light
  SELECT count(*) INTO v_stale FROM ca_incident_recipients rec
   WHERE rec.active
     AND NOT EXISTS (
       SELECT 1 FROM push_subscriptions s
        WHERE s.user_id = rec.user_id AND s.is_active
          AND COALESCE(s.last_receipt_at, s.created_at) > now() - interval '48 hours');
  IF v_stale > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_negative_balance_watch', 'unknown', 'warning',
      'push-deliverability:' || to_char(now(), 'YYYY-MM-DD'),
      v_stale, NULL, NULL, 'reporting', 'push_subscriptions',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a registered incident recipient has no push subscription with a delivery receipt in 48h - alerts may not be reaching a phone; check the device''s notification permissions',
      true, jsonb_build_object('recipients_without_fresh_receipts', v_stale));
  END IF;

  RETURN v_hits;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_negative_balance_watch() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-negative-balance-watch-10m', '*/10 * * * *',
  $$SELECT public.fn_ca_negative_balance_watch()$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT v.k, v.a, v.b, v.note, true FROM (VALUES
 ('trigger', 'trg_ca_append_only', 'diamond_transactions', 'diamond journal is append-only'),
 ('cron', 'ca-negative-balance-watch-10m', NULL, 'no store below zero + push-deliverability receipt watch')
) AS v(k, a, b, note)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g WHERE g.object_a=v.a AND (g.object_b=v.b OR (g.object_b IS NULL AND v.b IS NULL)));;
