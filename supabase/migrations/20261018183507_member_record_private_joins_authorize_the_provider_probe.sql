-- Supabase authorizes a private subscription by inserting a temporary probe
-- with topic/extension only. The probe does not carry private=true, so requiring
-- that delivery column rejects every intended authenticated subscription.
-- Channel configuration and realtime.send(...,true) continue to require private
-- transport; exact topic plus the existing member-access helper own authorization.
-- @live-proof: EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='realtime' AND tablename='messages' AND policyname='authorized viewers receive member record changes' AND qual NOT LIKE '%private IS TRUE%' AND qual LIKE '%ca_member_record_can_subscribe%')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
ALTER POLICY "authorized viewers receive member record changes" ON realtime.messages
USING(extension='broadcast' AND topic=realtime.topic()
  AND public.ca_member_record_can_subscribe(topic));
COMMIT;
