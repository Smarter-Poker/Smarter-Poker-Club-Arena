-- 20260928144831_time_bank_consume_is_idempotent_by_request_id
--
-- ROOT CAUSE (production, 2026-09-28, tournament 87a68e55-2c91-43e6-a803-
-- 4a9a2b9505b0, "$100 Freeroll - 6:00 AM", table 9333d016-f241-4f31-95ad-
-- b3f062055f22, hand #16636034). A cluster of tournament leases was lost at
-- 12:19-12:20 UTC (heartbeats did not land inside their proof window - a
-- smaller repeat of the 2026-09-26 storm). 32 of the tournament's table
-- engines then failed TournamentManagerBase's stop() on "retained time-bank
-- custody"; 31 of those cleared on retry as their in-flight writes settled.
-- One did not, and it has not cleared in over 80 minutes and 80 retries:
--
--   Error: Tournament table 9333d016-... retained time-bank custody
--
-- because `fn_consume_time_bank`'s RPC for that table came back
-- `Error: supabase_timeout` (an ordinary transient DB hiccup), and
-- `onTimeBankAccounting` / `consumeTimeBankSeconds` in
-- server/src/engine/ServerTableEngineBase.ts treat ANY non-success answer as
-- permanent: `this.timeBankAccountingUnconfirmed = true`, with nothing in
-- the codebase that ever sets it back to false. The comment above the field
-- says why: "An unacknowledged non-idempotent debit must not be retried or
-- certified" - `fn_consume_time_bank` decrements `feature_purchases.
-- uses_remaining` and increments `vip_feature_usage_monthly.usage_count`
-- with no idempotency key, so a retry after an ambiguous answer could double
-- -deduct a player's purchased time-bank uses. That caution is correct for
-- the deduction; it is disproportionate for what it is gating. The frozen
-- custody `hasUnretiredStoppedTimeBankCustody()` protects
-- (stoppedTimeBankCustody.banks, captured by captureParkedTimeBanks() from
-- this process's own in-memory timeBankEngine state) does not depend on this
-- RPC's outcome at all - `meta.dbConsumedSeconds` is bumped synchronously,
-- before the RPC is even sent, and the RPC only writes a separate historical
-- usage ledger. So one ambiguous BEST-EFFORT ledger write - the function's
-- own comment: "accounting must never break gameplay" / "Gameplay never
-- waits for this call" - has been escalated into a table that can never
-- retire, a tournament manager quarantined forever
-- (GameServer.quarantined_tournament_manager_stop_retry,
-- mixed:originals_not_drained:engine_stops_not_all_fulfilled), 43 sibling
-- tables of the same tournament held stalled behind it (tableLivenessSummary
-- tournamentTablesNotRunning), and the maintenance certificate refusing
-- every hourly cutover since (unparkedReasons.stopped_bank_custody_
-- unreadable, which only a TERMINAL engine with timeBankAccountingUnconfirmed
-- raises - see ServerTableEngineBase.maintenanceDurabilityReason and the
-- binding law in tests/a-stopped-bank-that-can-never-be-released-does-not-
-- hold-the-restart-shut.law.test.ts, which is correctly NOT loosened here).
--
-- THE FIX. Give the deduction the idempotency key it was missing, the same
-- pattern this repo already uses for `fn_rabbit_hunt_purchase` two hundred
-- lines above it in 20260909203940 (digital_purchase_receipts, p_request_id):
-- an optional `p_request_id`, and a receipts table keyed on it. A call
-- carrying a request_id that already has a receipt returns that receipt's
-- own stored result WITHOUT touching a balance a second time - a retry is
-- now a safe no-op, not a double-debit risk. Existing behaviour
-- (p_request_id omitted) is untouched byte-for-byte. This migration only
-- adds the receipt path; server/src/engine/ServerTableEngineBase.ts (this
-- PR, same commit) is what starts passing a stable request_id and uses it to
-- resolve an ambiguous answer with one authoritative retry before it taints
-- the flag - "I could not tell" answered by asking again, not by refusing
-- forever (CLAUDE.md 10.86).
--
-- Preimage (production, kuklfnapbkmacvwxktbh): functiondef md5
-- a73f08235114e20cfb86bd214c286854, prosrc md5 7832bfb717daaeb625372bdd3ccc7d60,
-- args `p_user_id uuid, p_seconds integer`, grants {postgres, service_role}
-- EXECUTE only (CREATE OR REPLACE preserves them; both are restated below,
-- per 10.84, so silence never reads as PUBLIC). No `time_bank_consume_
-- receipts` relation existed before this migration.
--
-- Verified in a rolled-back transaction against production (CLAUDE.md 11.5
-- rule 1, one MCP call, one DO block, RAISE EXCEPTION at the end): a first
-- call with a fresh request_id decremented a scratch `feature_purchases` row
-- by the expected uses; a second call with the SAME request_id returned the
-- identical stored result and left the row's `uses_remaining` unchanged (no
-- second deduction); a third call with p_request_id NULL behaved exactly as
-- the preimage (no receipt written, decremented again) - byte-identical old
-- behaviour when the caller does not opt in. Both branches (lifetime-VIP
-- early return and the ordinary return) were exercised and each writes its
-- own receipt in the same transaction as its own deduction, so a crash
-- between them cannot happen with the receipt right and the deduction wrong.
--
-- Single transaction, no lock beyond the function/table DDL themselves
-- (CLAUDE.md section 2). Not run inside the :50-:03 break window.

BEGIN;

CREATE TABLE IF NOT EXISTS public.time_bank_consume_receipts (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  seconds integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.time_bank_consume_receipts IS
  'Idempotency receipts for fn_consume_time_bank. A replayed p_request_id '
  'returns the stored result instead of deducting again. Engine-only '
  '(service_role); see 20260928144831_time_bank_consume_is_idempotent_by_request_id.sql.';

ALTER TABLE public.time_bank_consume_receipts ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS entirely, anon/authenticated get
-- zero rows with zero policies defined, exactly as this table's writer
-- (the engine, service_role-only) requires.

REVOKE ALL ON public.time_bank_consume_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.time_bank_consume_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.fn_consume_time_bank(
  p_user_id uuid,
  p_seconds integer,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_vip      boolean;
  v_is_lifetime boolean;
  v_month       text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used        int;
  v_from_vip    int := 0;
  v_remaining   int;
  v_uses_needed int;
  v_uses_taken  int := 0;
  v_expiring_taken int := 0;
  v_row         record;
  v_take        int;
  v_receipt     jsonb;
  v_result      jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank is engine-only';
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_seconds must be positive');
  END IF;

  -- A REPLAY NEVER TOUCHES A BALANCE (2026-09-28). Checked before the
  -- advisory lock, before anything is read: an already-receipted request_id
  -- is answered from its own receipt, full stop.
  IF p_request_id IS NOT NULL THEN
    SELECT result INTO v_receipt
      FROM public.time_bank_consume_receipts
     WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  -- Re-check under the lock: a concurrent call with the same request_id for
  -- the same user (the retry this migration exists to make safe) serializes
  -- on the lock above and, once the first commits, is answered here instead
  -- of deducting a second time.
  IF p_request_id IS NOT NULL THEN
    SELECT result INTO v_receipt
      FROM public.time_bank_consume_receipts
     WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'time_bank_seconds', v_month, p_seconds, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
           updated_at = now();

    v_result := jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'consumed_vip_seconds', p_seconds,
      'consumed_purchased_uses', 0,
      'shortfall_seconds', 0
    );
    IF p_request_id IS NOT NULL THEN
      INSERT INTO public.time_bank_consume_receipts (request_id, user_id, seconds, result)
      VALUES (p_request_id, p_user_id, p_seconds, v_result)
      ON CONFLICT (request_id) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;

  v_remaining := p_seconds;

  -- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS. A daily
  -- bonus credit lives seven days; the VIP allowance comes back on the
  -- first. One use is twenty seconds; soonest to expire first.
  v_uses_needed := CEIL(v_remaining / 20.0)::int;
  FOR v_row IN
    SELECT id, uses_remaining
      FROM public.feature_purchases
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND COALESCE(uses_remaining, 0) > 0
       AND expires_at IS NOT NULL
       AND expires_at > now()
     ORDER BY expires_at ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_uses_needed <= 0;
    v_take := LEAST(v_row.uses_remaining, v_uses_needed);
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - v_take
     WHERE id = v_row.id;
    v_uses_taken := v_uses_taken + v_take;
    v_expiring_taken := v_expiring_taken + v_take;
    v_uses_needed := v_uses_needed - v_take;
  END LOOP;
  v_remaining := GREATEST(0, v_remaining - v_expiring_taken * 20);

  IF v_remaining > 0 AND v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND month = v_month;

    v_from_vip := LEAST(v_remaining, GREATEST(0, 120 - v_used));
    IF v_from_vip > 0 THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'time_bank_seconds', v_month, v_from_vip, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
             updated_at = now();
      v_remaining := v_remaining - v_from_vip;
    END IF;
  END IF;

  IF v_remaining > 0 THEN
    v_uses_needed := CEIL(v_remaining / 20.0)::int;
    FOR v_row IN
      SELECT id, uses_remaining
        FROM public.feature_purchases
       WHERE user_id = p_user_id
         AND feature = 'time_bank_seconds'
         AND COALESCE(uses_remaining, 0) > 0
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at
       FOR UPDATE
    LOOP
      EXIT WHEN v_uses_needed <= 0;
      v_take := LEAST(v_row.uses_remaining, v_uses_needed);
      UPDATE public.feature_purchases
         SET uses_remaining = uses_remaining - v_take
       WHERE id = v_row.id;
      v_uses_taken := v_uses_taken + v_take;
      v_uses_needed := v_uses_needed - v_take;
    END LOOP;
    v_remaining := GREATEST(0, v_remaining - (v_uses_taken - v_expiring_taken) * 20);
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'consumed_vip_seconds', v_from_vip,
    'consumed_purchased_uses', v_uses_taken,
    'consumed_expiring_uses', v_expiring_taken,
    'shortfall_seconds', v_remaining
  );
  IF p_request_id IS NOT NULL THEN
    INSERT INTO public.time_bank_consume_receipts (request_id, user_id, seconds, result)
    VALUES (p_request_id, p_user_id, p_seconds, v_result)
    ON CONFLICT (request_id) DO NOTHING;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_consume_time_bank(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_time_bank(uuid, integer, uuid)
  TO postgres, service_role;

COMMIT;
