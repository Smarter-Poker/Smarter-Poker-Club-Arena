-- =============================================================================
--  FIXTURE: the owner's personal inbox keeps no operational original
-- =============================================================================
-- For scripts/dev/probe-owner-inbox-cleanup.sh only; never applied to
-- production. It is loaded after scripts/dev/fixtures/owner-inbox-store-only/
-- (production before store-only delivery) and adds the two tables that hold a
-- foreign key into public.notifications, with their production columns,
-- constraints and grants (read from production kuklfnapbkmacvwxktbh on
-- 2026-09-28; their other foreign keys and their policies omitted). Both
-- foreign keys are NO ACTION, as in production.
SET client_min_messages = warning;

CREATE TABLE public.push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid,
  title text NOT NULL,
  body text NOT NULL,
  url text,
  icon_url text,
  badge_url text,
  tag text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending','processing','sent','failed','skipped'])),
  attempts integer NOT NULL DEFAULT 0,
  failure_reason text,
  related_entity_id uuid,
  event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  claimed_at timestamptz,
  image_url text,
  accounting_notification_id uuid REFERENCES public.notifications(id),
  next_attempt_at timestamptz,
  CONSTRAINT accounting_push_deferral_requires_typed_receipt
    CHECK (next_attempt_at IS NULL OR (accounting_notification_id IS NOT NULL AND isfinite(next_attempt_at))),
  CONSTRAINT accounting_push_notification_identity
    CHECK (accounting_notification_id IS NULL OR (NOT (event IS DISTINCT FROM 'accounting_invoice')
      AND NOT (related_entity_id IS DISTINCT FROM accounting_notification_id)))
);
CREATE UNIQUE INDEX accounting_push_one_notification_receipt ON public.push_outbox (accounting_notification_id)
  WHERE accounting_notification_id IS NOT NULL;
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_outbox FROM anon, authenticated;
GRANT SELECT, REFERENCES, TRIGGER ON public.push_outbox TO anon, authenticated;

CREATE TABLE public.accounting_invoice_deliveries (
  invoice_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  message_id uuid NOT NULL UNIQUE,
  notification_id uuid NOT NULL UNIQUE REFERENCES public.notifications(id),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  delivery_mode text NOT NULL DEFAULT 'immediate' CHECK (delivery_mode = ANY (ARRAY['immediate','weekly_detail'])),
  PRIMARY KEY (invoice_id, recipient_id)
);
ALTER TABLE public.accounting_invoice_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_invoice_deliveries FROM anon, authenticated;
GRANT SELECT ON public.accounting_invoice_deliveries TO authenticated;
