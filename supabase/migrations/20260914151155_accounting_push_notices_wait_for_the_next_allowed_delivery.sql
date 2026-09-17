BEGIN;
-- Forward candidate: preserve verified accounting notices through quiet hours,
-- daily limits and dispatch outages in the existing durable queue.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.claim_push_outbox_batch(integer,integer)'::regprocedure))
    IS DISTINCT FROM '0c33374ff247a08650e5d0235cffda9d'
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.push_outbox'::regclass
   AND attname='accounting_notification_id' AND NOT attisdropped)
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.push_outbox'::regclass
   AND attname='next_attempt_at' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'accounting push deferral preimage changed';
 END IF;
END $guard$;
ALTER TABLE public.push_outbox ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE public.push_outbox ADD CONSTRAINT accounting_push_deferral_requires_typed_receipt
 CHECK(next_attempt_at IS NULL OR (accounting_notification_id IS NOT NULL AND isfinite(next_attempt_at)));
CREATE INDEX accounting_push_deferred_due ON public.push_outbox(next_attempt_at,id)
 WHERE status='pending' AND next_attempt_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.claim_push_outbox_batch(p_limit integer DEFAULT 100, p_max_attempts integer DEFAULT 5)
 RETURNS SETOF push_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.push_outbox
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = now()
   WHERE id IN (
     SELECT id FROM public.push_outbox
      WHERE status = 'pending'
        AND attempts < p_max_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at, id
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$function$;
-- CREATE OR REPLACE preserves the established function ACL. No receipt is
-- inserted, deleted, reset or re-enqueued; archived/history/opt-out rows stay put.
COMMENT ON COLUMN public.push_outbox.next_attempt_at IS 'Earliest next dispatch of a typed accounting receipt. Temporary preference deferral preserves the same receipt and provider retry budget.';

COMMIT;
