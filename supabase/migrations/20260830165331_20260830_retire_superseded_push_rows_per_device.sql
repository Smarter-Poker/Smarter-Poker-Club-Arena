-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830165331; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- ONE LIVE PUSH SUBSCRIPTION PER PHYSICAL DEVICE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-30, from an iPhone: "I'M GETTING DOUBLE NOTIFICATIONS FOR THE
-- SAME OPEN SEAT."
--
-- /api/cron/push-dispatch selects EVERY is_active row for the recipient and
-- sends to each, so a device holding two live rows shows every banner twice.
-- Two code paths were creating those rows and both are fixed in the same batch
-- as this migration:
--
--   * Club Arena's pushClient never sent `deviceId`, so every row it wrote had
--     device_id = NULL -- exempt from push_subscriptions_one_active_per_device_uidx
--     (WHERE is_active AND device_id IS NOT NULL) and invisible to the
--     same-device retire in /api/push/subscribe, which matches on device_id.
--   * /api/push/rotate preserved device_label but dropped device_id entirely,
--     re-creating an unattributable row on every endpoint rotation.
--
-- This migration corrects the rows those bugs already left behind. It does NOT
-- substitute for either fix: without them the rows come straight back.
--
-- THE RULE. A row is retired only when a NEWER active row exists for the same
-- (user_id, device_label) AND this row has not been successfully delivered to
-- since that newer row appeared. A browser holds exactly one current push
-- subscription per registration, so the most recent row is the live one and an
-- older sibling with no delivery since is a leftover. A row with no newer
-- sibling is never touched, and neither is one still being delivered to.
--
-- SAFETY. Nothing is deleted and no endpoint is destroyed; is_active goes false
-- with an auditable reason. If this retires a row that was in fact live, the
-- device restores itself on its next app load -- PushSubscriptionSync re-runs
-- enablePush() and /api/push/subscribe upserts the row back to is_active.
-- Verified against production before applying: exactly 3 rows match, one per
-- device (iPad, iPhone, Mac), and all 3 have last_used_at IS NULL -- not one
-- has ever been successfully delivered to.

DO $$
DECLARE
    v_before  int;
    v_target  int;
    v_retired int;
    v_dupes   int;
BEGIN
    SELECT count(*) INTO v_before FROM push_subscriptions WHERE is_active;

    SELECT count(*) INTO v_target
    FROM push_subscriptions r
    WHERE r.is_active
      AND EXISTS (SELECT 1 FROM push_subscriptions s
                  WHERE s.user_id = r.user_id
                    AND s.device_label IS NOT DISTINCT FROM r.device_label
                    AND s.is_active
                    AND s.created_at > r.created_at
                    AND (r.last_used_at IS NULL OR r.last_used_at < s.created_at));

    -- A sweep that suddenly matches everything is a bug in the sweep, not a
    -- platform full of duplicates. Refuse rather than mass-unsubscribe.
    IF v_target > v_before / 2 THEN
        RAISE EXCEPTION
            'refusing to retire % of % active subscriptions: over half is not a cleanup',
            v_target, v_before;
    END IF;

    UPDATE push_subscriptions r
       SET is_active = false,
           last_failure_reason = 'superseded_newer_row_same_device',
           updated_at = now()
     WHERE r.is_active
       AND EXISTS (SELECT 1 FROM push_subscriptions s
                   WHERE s.user_id = r.user_id
                     AND s.device_label IS NOT DISTINCT FROM r.device_label
                     AND s.is_active
                     AND s.created_at > r.created_at
                     AND (r.last_used_at IS NULL OR r.last_used_at < s.created_at));
    GET DIAGNOSTICS v_retired = ROW_COUNT;

    IF v_retired <> v_target THEN
        RAISE EXCEPTION 'retired % rows but had targeted %', v_retired, v_target;
    END IF;

    -- POST-CONDITION: no account may still hold two live rows for one device.
    SELECT count(*) INTO v_dupes FROM (
        SELECT user_id, device_label
          FROM push_subscriptions
         WHERE is_active
         GROUP BY user_id, device_label
        HAVING count(*) > 1
    ) d;

    IF v_dupes > 0 THEN
        RAISE EXCEPTION
            'still % (user, device) group(s) with more than one live subscription', v_dupes;
    END IF;

    RAISE NOTICE 'active before=%, retired=%, active after=%',
        v_before, v_retired, v_before - v_retired;
END $$;
