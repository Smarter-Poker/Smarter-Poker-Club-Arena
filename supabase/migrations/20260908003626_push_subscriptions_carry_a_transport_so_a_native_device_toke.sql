-- 20260908003626_push_subscriptions_carry_a_transport_so_a_native_device_toke.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (store readiness, phase 4 - native push):
--
-- The Club Arena app cannot use Web Push: a Capacitor webview has no push
-- service behind it and no root service worker. It gets a device token from
-- APNs (iOS) or FCM (Android) instead, and Firebase Cloud Messaging delivers
-- to both.
--
-- The audit suggested reviving public.user_devices for those tokens. That
-- would be a second table, a second sender path, a second retirement rule and
-- a second receipt path beside push_subscriptions - four copies of logic that
-- already works. So a native token is a push_subscriptions row like any
-- other, with `transport = 'fcm'`, the token in `endpoint` (unique per device,
-- as a Web Push endpoint is), and no VAPID keys. Everything downstream -
-- notifications -> mirror trigger -> push_outbox -> dispatch cron, the
-- inline deliverPushNow fan-out, failure counting and retirement, receipts,
-- the one-account-per-device rule - runs unchanged; only the sender is chosen
-- per row (World Hub src/lib/push/send-push.js).
--
-- p256dh and auth were NOT NULL. They stay required for Web Push rows, by a
-- CHECK that says so, and are simply absent for a token row.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'webpush',
  ADD COLUMN IF NOT EXISTS platform text;

ALTER TABLE public.push_subscriptions
  ALTER COLUMN p256dh DROP NOT NULL,
  ALTER COLUMN auth DROP NOT NULL;

ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_transport_chk,
  ADD CONSTRAINT push_subscriptions_transport_chk
    CHECK (transport IN ('webpush', 'fcm')),
  DROP CONSTRAINT IF EXISTS push_subscriptions_webpush_keys_chk,
  ADD CONSTRAINT push_subscriptions_webpush_keys_chk
    CHECK (transport <> 'webpush' OR (p256dh IS NOT NULL AND auth IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS push_subscriptions_platform_chk,
  ADD CONSTRAINT push_subscriptions_platform_chk
    CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web'));

COMMENT ON COLUMN public.push_subscriptions.transport IS
  'webpush: a browser endpoint with VAPID keys. fcm: a native device token (APNs via Firebase, or FCM) in endpoint, no keys. Chosen per row by the sender.';
COMMENT ON COLUMN public.push_subscriptions.platform IS
  'ios | android | web. Informational; the transport decides delivery.';

CREATE INDEX IF NOT EXISTS push_subscriptions_transport_active_idx
  ON public.push_subscriptions (transport) WHERE is_active;

COMMIT;
