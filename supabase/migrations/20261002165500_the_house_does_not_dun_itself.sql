-- ===========================================================================
--  THE HOUSE DOES NOT DUN ITSELF, AND THE SIREN'S POWER LIGHT WATCHES THE
--  CHANNEL THE OWNER CHOSE
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-02. fn_ca_midway_burnin_gate has never passed
-- (744 runs since 2026-08-31). Two of its standing reds are read here.
--
-- 1. FOUR SQUARE-UPS THE HOUSE OWES ITSELF.
--
--    Club JAQK (a0000000-...-0001), SHARK CLUB (a41434bb) and Midway Union
--    (fade0000-...-0001) have one owner: 47965354 (the house account). The
--    weekly square-up is an off-ledger statement (ca_union_set_statement_paid
--    records a payment; no chip moves), so between one owner's own books
--    there is no payment that could ever be recorded against it. Unpaid:
--      MIDWAY-2026-000005  Club JAQK   33,222.29  week 09-07 .. 09-14
--      MIDWAY-2026-000006  SHARK CLUB  11,242.82  week 09-07 .. 09-14
--      MIDWAY-2026-000008  Club JAQK   42,719.62  week 09-21 .. 09-28
--      MIDWAY-2026-000010  SHARK CLUB  35,117.39  week 09-21 .. 09-28
--    The first two aged past grace on 2026-09-24 (critical incidents
--    f087ad75, d21f5350) and fn_union_enforce_stop_loss suspended both clubs
--    on 2026-09-26 (critical incidents ea9e3a11, 5d462b51). The last two were
--    issued 2026-10-01 22:43 already past their 10-01 07:00 due date and
--    would suspend the clubs again on 2026-10-08.
--
--    Owner decision (Dan, 2026-10-02, on settling the house's own accounts:
--    "you decide ... it doesn't matter as long as the bug / glitch is
--    fixed"; and 2026-09-09: settlement decisions are the agents'). Marking
--    them PAID would record a payment that never happened. The union instead
--    WAIVES each in full with a credit note (fn_union_issue_credit_note, no
--    message to the club), which is what is true: the owner forgives a debt
--    to himself. No chip moves. fn_union_integrity_sweep_all (:35 hourly)
--    then finds nothing past due and fn_union_enforce_stop_loss restores both
--    clubs, as it was built to.
--
-- 2. THE PUSH-DELIVERABILITY WARNING CANNOT CLEAR FOR THE OWNER.
--
--    fn_ca_negative_balance_watch raises 'push-deliverability:<day>'
--    (classification unknown, which the gate counts) when an active incident
--    recipient has no push subscription with a receipt in 48 h. The only
--    active recipient is the owner, and since 20260916111614 the owner's
--    financial incidents, attestations, guarantee alerts and digests are
--    routed by fn_is_owner_operational_notification to the Production Alerts
--    inbox and deliberately never pushed (push_outbox: no financial_incident
--    row for him in 72 h; operational_alert_events
--    'owner-operational-notifications' last received 16:36 UTC today). The
--    warning therefore fires every day by design (incident d85e4b8e, 99
--    occurrences).
--
--    FIX: a recipient whose incidents are routed to the inbox is live when
--    the inbox received an owner-operational row in 48 h (the daily estate
--    digest guarantees one); every other recipient still needs a fresh push
--    receipt. The warning still fires if the inbox goes quiet.
--
-- CLAUDE.md section 2: one migration, one transaction; CREATE OR REPLACE
-- FUNCTION and four credit-note rows. Applied outside :50-:03 UTC.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.settlement_invoices WHERE invoice_type = 'union_weekly_credit_note' AND breakdown->>'reason' LIKE 'House settlement 2026-10-02:%') = 4

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Preimage
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  v_live text;
  r record;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_ca_negative_balance_watch'::regproc)) INTO v_live;
  IF v_live IS DISTINCT FROM 'b8756eefab9d7a751f202bcd5b66bc90' THEN
    RAISE EXCEPTION 'preimage: fn_ca_negative_balance_watch is not the body read on 2026-10-02 (md5 %)', v_live;
  END IF;

  -- One owner on all three books.
  IF (SELECT count(DISTINCT owner_id) FROM (
        SELECT owner_id FROM public.clubs
         WHERE id IN ('a0000000-0000-0000-0000-000000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
        UNION ALL
        SELECT owner_id FROM public.unions WHERE id = 'fade0000-0000-0000-0000-000000000001') o) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.unions
                     WHERE id = 'fade0000-0000-0000-0000-000000000001'
                       AND owner_id = '47965354-0e56-43ef-931c-ddaab82af765') THEN
    RAISE EXCEPTION 'preimage: Club JAQK, SHARK CLUB and Midway Union no longer share the house owner';
  END IF;

  -- Exactly the four statements read on 2026-10-02, still owed in full.
  FOR r IN SELECT * FROM (VALUES
      ('MIDWAY-2026-000005', 'a0000000-0000-0000-0000-000000000001'::uuid, 33222.29),
      ('MIDWAY-2026-000006', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 11242.82),
      ('MIDWAY-2026-000008', 'a0000000-0000-0000-0000-000000000001'::uuid, 42719.62),
      ('MIDWAY-2026-000010', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 35117.39)) AS x(num, club, owed)
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM public.settlement_invoices si
          WHERE si.invoice_number = r.num
            AND si.invoice_type = 'union_weekly_squareup'
            AND si.club_id = r.club
            AND si.from_entity_type = 'club'
            AND si.breakdown->>'union_id' = 'fade0000-0000-0000-0000-000000000001'
            AND si.status IN ('generated', 'overdue')
            AND public.fn_union_invoice_outstanding(si.id) = r.owed) THEN
      RAISE EXCEPTION 'preimage: % is not an open square-up of % owing %', r.num, r.club, r.owed;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.settlement_invoices
              WHERE invoice_type = 'union_weekly_credit_note'
                AND breakdown->>'reason' LIKE 'House settlement 2026-10-02:%') THEN
    RAISE EXCEPTION 'preimage: the house settlement credit notes already exist';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. The union waives what the house owes itself
-- ---------------------------------------------------------------------------

DO $waive$
DECLARE
  r record;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT si.id, si.invoice_number,
           round(si.net_amount - COALESCE((
             SELECT sum(cn.net_amount) FROM public.settlement_invoices cn
              WHERE cn.adjusts_invoice_id = si.id
                AND cn.invoice_type = 'union_weekly_credit_note'), 0), 2) AS remaining
      FROM public.settlement_invoices si
     WHERE si.invoice_number IN ('MIDWAY-2026-000005', 'MIDWAY-2026-000006',
                                 'MIDWAY-2026-000008', 'MIDWAY-2026-000010')
       AND si.invoice_type = 'union_weekly_squareup'
     ORDER BY si.invoice_number
  LOOP
    v_res := public.fn_union_issue_credit_note(
      r.id, r.remaining,
      'House settlement 2026-10-02: Club JAQK, SHARK CLUB and Midway Union share one owner, '
        || 'so this square-up is owed by the owner to himself and no payment exists to record. '
        || 'Waived in full by the union (migration 20261002165500).',
      false);
    IF NOT COALESCE((v_res->>'success')::boolean, false)
       OR (v_res->>'remaining_after')::numeric <> 0 THEN
      RAISE EXCEPTION 'waive: % did not credit to zero: %', r.invoice_number, v_res;
    END IF;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM public.settlement_invoices si
        WHERE si.invoice_number IN ('MIDWAY-2026-000005', 'MIDWAY-2026-000006',
                                    'MIDWAY-2026-000008', 'MIDWAY-2026-000010')
          AND public.fn_union_invoice_outstanding(si.id) <> 0) THEN
    RAISE EXCEPTION 'waive: a house square-up still reads outstanding';
  END IF;
END $waive$;

-- ---------------------------------------------------------------------------
-- 2. The siren's power light watches the channel the owner chose
-- ---------------------------------------------------------------------------

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
  /* A RECIPIENT IS LIVE ON THE CHANNEL ITS INCIDENTS TRAVEL (20261002165500).
     An incident for a recipient routed by fn_is_owner_operational_notification
     goes to the Production Alerts inbox and is never pushed, so a push receipt
     can never prove that recipient is reachable. For such a recipient the
     light is the inbox: an owner-operational row received in 48 hours (the
     daily estate digest guarantees one). Every other recipient still needs a
     push subscription with a fresh receipt. */
  SELECT count(*) INTO v_stale FROM ca_incident_recipients rec
   WHERE rec.active
     AND CASE
           WHEN public.fn_is_owner_operational_notification(rec.user_id, 'financial_incident', NULL, NULL)
             THEN NOT EXISTS (
               SELECT 1 FROM operational_alert_events o
                WHERE o.source = 'owner-operational-notifications'
                  AND o.last_received_at > now() - interval '48 hours')
           ELSE NOT EXISTS (
             SELECT 1 FROM push_subscriptions s
              WHERE s.user_id = rec.user_id AND s.is_active
                AND COALESCE(s.last_receipt_at, s.created_at) > now() - interval '48 hours')
         END;
  IF v_stale > 0 THEN
    /* A count of recipients is not a chip amount (2026-10-01). It travels in
       metadata; discrepancy_amount stays NULL so the board does not report a
       phone with no receipt as 1.00 of chip drift. */
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_negative_balance_watch', 'unknown', 'warning',
      'push-deliverability:' || to_char(now(), 'YYYY-MM-DD'),
      NULL, NULL, NULL, 'reporting', 'push_subscriptions',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a registered incident recipient has had nothing delivered on its incident channel in 48h (a push subscription with a receipt, or for a recipient routed to Production Alerts, an inbox row) - alerts may not be reaching anyone; check the device''s notification permissions or the Production Alerts inbox',
      true, jsonb_build_object('recipients_without_fresh_receipts', v_stale));
  END IF;

  RETURN v_hits;
END $function$;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_negative_balance_watch', 'migration 20261002165500_the_house_does_not_dun_itself');

-- ---------------------------------------------------------------------------
-- 3. Postimage
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF (SELECT count(*) FROM ca_incident_recipients rec
       WHERE rec.active
         AND public.fn_is_owner_operational_notification(rec.user_id, 'financial_incident', NULL, NULL)
         AND NOT EXISTS (SELECT 1 FROM operational_alert_events o
                          WHERE o.source = 'owner-operational-notifications'
                            AND o.last_received_at > now() - interval '48 hours')) <> 0 THEN
    RAISE EXCEPTION 'postimage: the owner''s Production Alerts inbox has received nothing in 48 hours';
  END IF;
END $post$;

COMMIT;
