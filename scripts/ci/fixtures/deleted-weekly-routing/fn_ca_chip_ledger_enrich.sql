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

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
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
END $function$
