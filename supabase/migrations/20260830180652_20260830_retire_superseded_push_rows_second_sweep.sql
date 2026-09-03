-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830180652; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Second sweep, same supersession rule as
-- 20260830_retire_superseded_push_rows_per_device.
--
-- After the client fix shipped, each context re-subscribed and wrote a row
-- carrying a device_id. The server's same-device retire matches on
-- `.eq('device_id', ...)`, so it cannot see a device's own LEGACY row, whose
-- device_id is NULL. One duplicate per device came back.
--
-- WHAT CHANGED FROM THE FIRST SWEEP: the post-condition. The first version
-- asserted that NO (user, device_label) group may hold more than one live row,
-- and that assertion correctly refused this run -- because one group is not a
-- duplicate at all.
--
-- On iOS an installed PWA and Safari are SEPARATE storage contexts on one
-- phone. They report a byte-identical user_agent and both label themselves
-- 'iPhone', but they hold different push subscriptions and different device
-- ids, and neither can see the other's localStorage. The account in question
-- has exactly that: two 'iPhone' rows, one updated 2026-08-30 17:46:08 with
-- device_id 657b16e5..., the other untouched since 02:43 with device_id NULL.
--
-- Deduping those by device_label would switch off one of a person's real
-- notification targets, which is the exact hazard the comment in
-- /api/push/subscribe warns about ("user_agent is not unique ... deduping on
-- that would switch off one of the person's real devices"). Whether one phone
-- should receive two banners because two contexts are enrolled is a PRODUCT
-- decision, not a cleanup, and it is Dan's to make.
--
-- So: retire only rows that are PROVABLY superseded (a newer sibling exists
-- and this row has not been delivered to since that sibling appeared), and
-- assert only that the sweep did not make any group worse.

DO $$
DECLARE
    v_before  int;
    v_target  int;
    v_retired int;
    v_dupes_before int;
    v_dupes_after  int;
BEGIN
    SELECT count(*) INTO v_before FROM push_subscriptions WHERE is_active;

    SELECT count(*) INTO v_dupes_before FROM (
        SELECT user_id, device_label FROM push_subscriptions
         WHERE is_active GROUP BY user_id, device_label HAVING count(*) > 1) d;

    SELECT count(*) INTO v_target
    FROM push_subscriptions r
    WHERE r.is_active
      AND EXISTS (SELECT 1 FROM push_subscriptions s
                  WHERE s.user_id = r.user_id
                    AND s.device_label IS NOT DISTINCT FROM r.device_label
                    AND s.is_active
                    AND s.created_at > r.created_at
                    AND (r.last_used_at IS NULL OR r.last_used_at < s.created_at));

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

    SELECT count(*) INTO v_dupes_after FROM (
        SELECT user_id, device_label FROM push_subscriptions
         WHERE is_active GROUP BY user_id, device_label HAVING count(*) > 1) d;

    -- A sweep may only reduce duplication, never create it.
    IF v_dupes_after > v_dupes_before THEN
        RAISE EXCEPTION 'sweep increased duplicate groups from % to %',
            v_dupes_before, v_dupes_after;
    END IF;

    RAISE NOTICE 'active %->%, retired %, duplicate groups %->% (any remainder is two real contexts, not a stale row)',
        v_before, v_before - v_retired, v_retired, v_dupes_before, v_dupes_after;
END $$;
