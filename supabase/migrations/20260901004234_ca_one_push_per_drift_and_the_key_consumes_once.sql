-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Dan's ruling 2026-09-01 00:45 UTC: ONE push per drift. No 5/10/15/20-minute
-- drumbeat for any severity. The dashboard keeps the full clock, escalation
-- level and past-target state silently; a critical still announces its
-- resolution (the all-clear), and that is the only other push a drift may
-- ever send.
CREATE OR REPLACE FUNCTION public.fn_ca_incident_escalation_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  inc RECORD;
  age_min numeric;
BEGIN
  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
       AND severity IN ('critical','warning')
     ORDER BY detected_at
     LIMIT 200
  LOOP
    age_min := extract(epoch FROM now() - inc.detected_at) / 60;
    -- ONE PUSH PER DRIFT (Dan, 2026-09-01): the raise already pushed; this
    -- tick now only keeps the dashboard's clock honest. escalation_level
    -- advances silently so the age is visible at a glance.
    IF age_min >= 20 AND inc.past_target IS NOT TRUE THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = GREATEST(escalation_level, 4), past_target = true
       WHERE id = inc.id;
    ELSIF age_min >= 15 AND inc.escalation_level < 3 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 3 WHERE id = inc.id;
    ELSIF age_min >= 10 AND inc.escalation_level < 2 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 2 WHERE id = inc.id;
    ELSIF age_min >= 5 AND inc.escalation_level < 1 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
    END IF;
  END LOOP;
  RETURN 0;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_incident_escalation_tick() FROM PUBLIC, anon, authenticated;

-- The transaction-scoped idempotency key now stamps EXACTLY ONE ledger row.
-- Root cause of tonight's swallowed 100,000 member-credit row: a seed
-- trigger set app.ledger_idempotency_key for the treasury grant, and the
-- SAME transaction's next ledger row (the owner's member credit) inherited
-- the key and was rejected as a duplicate. The key is consumed on first use.
CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_chip_ledger_enrich() FROM PUBLIC, anon, authenticated;;
