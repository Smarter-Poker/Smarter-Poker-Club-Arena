-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827175636; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Audit trail for VIP plan changes (issue #771 item 6, built 2026-08-27).
-- The FAQ promised a prorated credit on upgrade and there was no route behind
-- it; pages/api/store/switch-vip-plan.js is that route. This table records
-- what was switched and what the resulting invoice looked like, so a billing
-- question months later has an answer that does not depend on reading Stripe's
-- event log.
--
-- NOT authoritative state. profiles.is_vip / vip_tier / vip_expires_at and the
-- vip_subscriptions tier are owned by the Stripe webhook
-- (customer.subscription.updated), which fires on exactly this change. A
-- second writer racing the webhook is the defect shape this estate keeps
-- paying for, so this is an audit row and nothing more.
CREATE TABLE IF NOT EXISTS public.vip_plan_switches (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_id   text,
  from_tier                text,
  to_tier                  text NOT NULL,
  proration_behavior       text NOT NULL DEFAULT 'create_prorations',
  next_invoice_total_cents integer,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vip_plan_switches_user ON public.vip_plan_switches (user_id, created_at DESC);

ALTER TABLE public.vip_plan_switches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vip_plan_switches_read_own ON public.vip_plan_switches;
-- A member may read their own billing history. Nobody may write from a
-- browser: the only writer is the API route, which runs as the service role.
CREATE POLICY vip_plan_switches_read_own ON public.vip_plan_switches
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.vip_plan_switches TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='vip_plan_switches') THEN
    RAISE EXCEPTION 'vip_plan_switches missing - migration did not take';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.vip_plan_switches'::regclass
                  AND polname='vip_plan_switches_read_own') THEN
    RAISE EXCEPTION 'vip_plan_switches read policy missing';
  END IF;
END $$;
