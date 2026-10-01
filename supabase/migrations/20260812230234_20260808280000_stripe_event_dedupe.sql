-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812230234 "20260808280000_stripe_event_dedupe"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 92899405d8472062a576e28e150c55be of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Event-level idempotency for the Stripe webhook.
--
-- WHY
--   The webhook has no event.id dedupe. Replay protection is per-handler
--   compare-and-set instead: the diamond credit CASes on status='pending', the
--   refund CASes on status='completed', merch and subscription branches are
--   naturally idempotent. Those two money branches are genuinely safe, so this
--   is not an active hole.
--
--   It is fragile, though, in a specific way. Every future handler has to
--   remember to invent its own CAS, and one that forgets is a double-credit
--   with no external guard. Stripe explicitly redelivers events - on 5xx, on
--   timeout, and occasionally at-least-once with no failure at all - so
--   "handled twice" is normal traffic, not an edge case.
--
--   A single claim table makes the guarantee structural rather than per-author:
--   an event id is claimed once, and a redelivery of an already-claimed id is
--   recognised before any handler runs.
--
-- The primary key does the work. INSERT ... ON CONFLICT DO NOTHING returns
-- zero rows for a replay and one row for a first delivery, atomically, with no
-- read-then-write race between two concurrent deliveries of the same event.

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
    event_id     text PRIMARY KEY,
    event_type   text,
    processed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stripe_webhook_events IS
    'Claimed Stripe event ids. INSERT ON CONFLICT DO NOTHING: zero rows returned means this event was already processed and must be skipped.';

-- Housekeeping: Stripe retries for about 3 days, so rows older than 30 days
-- cannot protect anything and only cost space.
CREATE INDEX IF NOT EXISTS stripe_webhook_events_processed_at_idx
    ON public.stripe_webhook_events (processed_at);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- No policies: service_role bypasses RLS and is the only thing that should
-- ever touch this. Clients get nothing, which is the correct posture for an
-- internal ledger of payment events.
REVOKE ALL ON public.stripe_webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.stripe_webhook_events TO service_role;

DO $postcheck$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'stripe_webhook_events' AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'post-apply failed: RLS not enabled on stripe_webhook_events';
    END IF;

    IF has_table_privilege('anon', 'public.stripe_webhook_events', 'SELECT')
       OR has_table_privilege('authenticated', 'public.stripe_webhook_events', 'SELECT') THEN
        RAISE EXCEPTION 'post-apply failed: clients can read stripe_webhook_events';
    END IF;

    IF NOT has_table_privilege('service_role', 'public.stripe_webhook_events', 'INSERT') THEN
        RAISE EXCEPTION 'post-apply failed: service_role cannot claim events';
    END IF;

    -- The whole design rests on the primary key; assert it exists.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stripe_webhook_events'::regclass AND contype = 'p'
    ) THEN
        RAISE EXCEPTION 'post-apply failed: no primary key, dedupe would not be atomic';
    END IF;
END
$postcheck$;
