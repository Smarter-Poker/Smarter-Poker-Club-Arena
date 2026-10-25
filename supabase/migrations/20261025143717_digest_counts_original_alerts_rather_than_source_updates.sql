-- Daily digest: a source-row update is not a new operational alert.
-- Oct 24 had six hand-history refusals and six resolution snapshots. The
-- digest counted twelve new failures, then did the same on its prior-day
-- baseline. Preserve every original incident and update; change only reporting.
-- Existing snapshots and sent emails remain historical evidence.
-- Tier 2, functions only. No money, source events, schedules or grants change.
-- Exact preimages/postimages and anchor counts refuse concurrent source drift.
-- Rollback: replace the predicate below with the original investigation-status
-- predicate in the two functions, and remove the o.payload predicate from the
-- attention function, through a new reviewed migration.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $digest_original_alerts$
DECLARE
  sig text; before_hash text; after_hash text; expected integer;
  original text; amended text; anchor text;
  owner_before oid; acl_before aclitem[]; config_before text[]; sec_before boolean;
BEGIN
  FOR sig, before_hash, after_hash, expected IN VALUES
    ('public.fn_sp_daily_metrics_compute(date)', '8cc2a4cfaab3573ffef2551948f534f9', 'b3e73a2b6a93d2bde0d18b4aea540a7e', 3),
    ('public.fn_sp_digest_attention(date,jsonb)', 'd68ca98e26d783ded93a94bc777ae4ac', 'e9858fa93a233234cfedff0b3a726413', 1)
  LOOP
    SELECT pg_get_functiondef(oid), proowner, proacl, proconfig, prosecdef
      INTO original, owner_before, acl_before, config_before, sec_before
      FROM pg_proc WHERE oid = sig::regprocedure;
    IF md5(original) IS DISTINCT FROM before_hash THEN
      RAISE EXCEPTION 'DIGEST_ALERT_PREIMAGE_DRIFT: % is %', sig, md5(original);
    END IF;
    anchor := $old$investigation_status IS DISTINCT FROM 'informational'$old$;
    IF (length(original) - length(replace(original, anchor, ''))) / length(anchor) <> expected THEN
      RAISE EXCEPTION 'DIGEST_ALERT_ANCHOR_COUNT: %', sig;
    END IF;
    amended := replace(original, anchor,
      $new$investigation_status IS DISTINCT FROM 'informational' AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'$new$);
    IF sig = 'public.fn_sp_digest_attention(date,jsonb)' THEN
      anchor := $old$AND o.received_at >= s - interval '7 days' AND o.received_at < s$old$;
      IF (length(amended) - length(replace(amended, anchor, ''))) / length(anchor) <> 1 THEN
        RAISE EXCEPTION 'DIGEST_ALERT_HISTORY_ANCHOR_COUNT';
      END IF;
      amended := replace(amended, anchor,
        $new$AND o.payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'
                            AND o.received_at >= s - interval '7 days' AND o.received_at < s$new$);
    END IF;
    IF md5(amended) IS DISTINCT FROM after_hash THEN
      RAISE EXCEPTION 'DIGEST_ALERT_POSTIMAGE_MISMATCH: % is %', sig, md5(amended);
    END IF;
    EXECUTE amended;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = sig::regprocedure
      AND md5(pg_get_functiondef(oid)) = after_hash
      AND proowner = owner_before AND proacl IS NOT DISTINCT FROM acl_before
      AND proconfig IS NOT DISTINCT FROM config_before AND prosecdef = sec_before) THEN
      RAISE EXCEPTION 'DIGEST_ALERT_READBACK_OR_ACCESS_CHANGED: %', sig;
    END IF;
  END LOOP;
END $digest_original_alerts$;
COMMIT;
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = 'b3e73a2b6a93d2bde0d18b4aea540a7e')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure)) = 'e9858fa93a233234cfedff0b3a726413')
