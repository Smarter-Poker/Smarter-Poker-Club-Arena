-- RECONSTRUCT THE WALLET AUDIT ROWS THAT WERE NEVER WRITTEN.
--
-- 197 open criticals: "Transaction log failed after successful financial
-- operation - audit trail gap". The chips moved; the ledger row did not. Every
-- context names the same cause:
--
--     rpcError: "permission denied for function log_wallet_transaction"
--     channel:  "client_rpc"
--
-- so this is a GRANT, not a logic bug. It is also already over — the newest of
-- the 197 is 2026-08-24 20:16 and none has appeared since. The revoke was
-- deliberate (see 20260826_daemon_functions_are_not_browser_callable and the
-- economy-function revoke of the same day); the defect was a client path
-- calling a function the browser is correctly no longer allowed to call.
-- Re-granting would undo a security fix, so nothing is re-granted here.
--
-- ── 197 ALERTS ARE 14 OPERATIONS ────────────────────────────────────────────
--
-- The naive reading of this queue is 43,971.36 chips of unlogged movement. That
-- number is wrong by an order of magnitude and believing it would have put 183
-- transactions that never happened into the ledger. The alerts are a RETRY
-- LOOP: 85 of them carry a byte-identical context (same user, same 206 chips,
-- same "Horse cash-out 206 chips from table"), 28 more share another, 24
-- another. Collapsed on (user, amount, type, category, description):
--
--     raw alerts            197
--     distinct operations    14
--     naive sum       43,971.36
--     true sum         3,289.73
--
-- CLAUDE.md already warns against retry loops that re-raise the same message.
-- This is what that costs when the duplicates are later read as facts.
--
-- ── THESE ROWS ARE MARKED AS RECONSTRUCTED ──────────────────────────────────
--
-- The alert asserts the operation succeeded, and four days on there is no way
-- to re-verify each one independently. So the rows carry their provenance in
-- the description rather than silently impersonating contemporaneous entries: a
-- reconstructed ledger entry that says so is honest bookkeeping, one that does
-- not is a forgery. created_at is the alert's own timestamp so the entry lands
-- where it belongs in the history.
--
-- `cashout` is not one of the categories fn_tournament_conservation_delta reads
-- (tournament_buyin, rebuy, addon, prize, bounty, refund), so this cannot move
-- any tournament's conservation figure.
--
-- ROLLBACK
--   DELETE FROM wallet_transactions w USING wallet_audit_backfill_log l
--    WHERE l.wallet_transaction_id = w.id;

CREATE TABLE IF NOT EXISTS public.wallet_audit_backfill_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_transaction_id uuid,
  user_id               uuid NOT NULL,
  amount                numeric NOT NULL,
  category              text,
  alert_ids             uuid[] NOT NULL,
  duplicate_alerts      integer NOT NULL,
  reconstructed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, amount, category)
);

ALTER TABLE public.wallet_audit_backfill_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_audit_backfill_log FROM PUBLIC;
GRANT SELECT ON public.wallet_audit_backfill_log TO service_role;

DO $mig$
DECLARE
  r record; v_tx uuid; v_made int := 0; v_chips numeric := 0; v_alerts int := 0;
BEGIN
  FOR r IN
    SELECT (context->>'userId')::uuid AS user_id,
           (context->>'amount')::numeric AS amount,
           context->>'type' AS type,
           COALESCE(context->>'category', 'cashout') AS category,
           COALESCE(context->>'walletType', 'PLAYER') AS wallet_type,
           context->>'description' AS description,
           min(created_at) AS first_seen,
           count(*) AS dupes,
           array_agg(id) AS alert_ids
      FROM public.financial_alerts
     WHERE source = 'WalletService.logTransaction'
       AND resolved IS NOT TRUE
       AND context->>'userId' IS NOT NULL
       AND context->>'amount' IS NOT NULL
     GROUP BY 1,2,3,4,5,6
  LOOP
    -- Skip anything that did get logged after all.
    IF EXISTS (
      SELECT 1 FROM public.wallet_transactions w
       WHERE w.user_id = r.user_id AND w.amount = r.amount
         AND w.type = r.type AND w.category = r.category
         AND w.created_at BETWEEN r.first_seen - interval '10 minutes'
                              AND r.first_seen + interval '10 minutes')
       OR EXISTS (
      SELECT 1 FROM public.wallet_audit_backfill_log l
       WHERE l.user_id = r.user_id AND l.amount = r.amount AND l.category = r.category)
    THEN
      UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
       WHERE id = ANY (r.alert_ids);
      CONTINUE;
    END IF;

    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, amount, type, category, description, created_at)
    VALUES (r.user_id, r.wallet_type, r.amount, r.type, r.category,
            '[reconstructed 2026-08-28 from WalletService.logTransaction audit gap] '
              || COALESCE(r.description, ''),
            r.first_seen)
    RETURNING id INTO v_tx;

    INSERT INTO public.wallet_audit_backfill_log
      (wallet_transaction_id, user_id, amount, category, alert_ids, duplicate_alerts)
    VALUES (v_tx, r.user_id, r.amount, r.category, r.alert_ids, r.dupes)
    ON CONFLICT (user_id, amount, category) DO NOTHING;

    UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
     WHERE id = ANY (r.alert_ids);

    v_made := v_made + 1;
    v_chips := v_chips + r.amount;
    v_alerts := v_alerts + r.dupes;
  END LOOP;

  RAISE LOG 'wallet audit backfill: % row(s), % chips, closing % alert(s)',
    v_made, v_chips, v_alerts;

  -- Guard against the exact mistake this migration exists to avoid.
  IF v_made > 40 THEN
    RAISE EXCEPTION 'backfill wrote % rows; the deduplicated population was 14 - refusing a retry-loop backfill', v_made;
  END IF;
END
$mig$;

DO $post$
DECLARE v_left int; v_written int;
BEGIN
  SELECT count(*) INTO v_left FROM public.financial_alerts
   WHERE source = 'WalletService.logTransaction' AND resolved IS NOT TRUE;
  SELECT count(*) INTO v_written FROM public.wallet_audit_backfill_log;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% WalletService audit alerts still open after the backfill', v_left;
  END IF;
  IF v_written = 0 THEN
    RAISE EXCEPTION 'no audit rows were reconstructed; the backfill did nothing';
  END IF;
END
$post$;
