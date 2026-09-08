
ALTER TABLE clubs ADD COLUMN owner_id uuid;
ALTER TABLE club_members ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE club_members ADD COLUMN role text DEFAULT 'player', ADD COLUMN status text DEFAULT 'active',
 ADD COLUMN agent_id uuid, ADD COLUMN is_active boolean DEFAULT true, ADD COLUMN updated_at timestamptz;
ALTER TABLE club_members ADD UNIQUE(club_id,user_id);
ALTER TABLE chip_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE chip_transactions ADD COLUMN related_cashout_id uuid, ADD COLUMN metadata jsonb;
CREATE UNIQUE INDEX cashout_receipt_op ON chip_transactions(club_id,(metadata->>'op_id'))
 WHERE transaction_type IN ('cashout_request_escrow','cashout_approved','cashout_denied','cashout_cancelled');
CREATE TABLE agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,
 agent_wallet_balance numeric DEFAULT 0,promo_wallet_balance numeric DEFAULT 0,updated_at timestamptz,UNIQUE(club_id,user_id));
CREATE TABLE cashout_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,player_id uuid,agent_id uuid,amount numeric,
 status text,player_note text,agent_note text,acknowledged_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,updated_at timestamptz);
CREATE UNIQUE INDEX cashout_pending ON cashout_requests(club_id,player_id) WHERE status='pending';
CREATE TABLE chip_escrow(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cashout_request_id uuid UNIQUE,
 player_id uuid,amount numeric,club_id uuid,locked_at timestamptz,released_at timestamptz,release_type text);
CREATE TABLE profiles(id uuid,display_name text,alias text,username text);
CREATE TABLE notifications(user_id uuid,type text,title text,message text,metadata jsonb,actor_id uuid);
-- Permission helpers are isolated fixtures, not an authorization audit.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.actor',true),'')::uuid$$;
CREATE FUNCTION fn_club_bank_role(uuid) RETURNS text LANGUAGE sql AS $$SELECT 'agent'::text$$;
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ensure_agent_row(uuid,uuid,text) RETURNS uuid LANGUAGE sql AS $$SELECT id FROM agents WHERE club_id=$1 AND user_id=$2$$;
ALTER TABLE chip_ledger ADD COLUMN epoch_id uuid, ADD COLUMN actor_service text, ADD COLUMN db_role text,
 ADD COLUMN correlation_id uuid, ADD COLUMN settlement_id text, ADD COLUMN chain_seq bigint, ADD COLUMN prev_hash text, ADD COLUMN row_hash text;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK(category IN ('adjustment','escrow_hold','escrow_release')) NOT VALID;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('escrow','player_wallet','agent_wallet','settlement_suspense')) NOT VALID;
CREATE SEQUENCE chip_ledger_chain_seq;
CREATE FUNCTION fn_ca_current_epoch() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;
CREATE SCHEMA extensions;
-- PostgreSQL core SHA256 provides the same digest without an extension install.
CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$SELECT sha256(convert_to($1,'UTF8'))$$;
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
;
CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid DEFAULT NULL::uuid, p_settlement_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_autoskip_tables text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$
;
CREATE TRIGGER enrich BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();
CREATE FUNCTION injected_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fault text:=current_setting('test.receipt_sqlstate',true);
BEGIN IF COALESCE(fault,'')<>'' THEN RAISE EXCEPTION 'injected receipt failure' USING ERRCODE=fault; END IF; RETURN NEW; END $$;
CREATE TRIGGER receipt_fault BEFORE INSERT ON chip_transactions FOR EACH ROW EXECUTE FUNCTION injected_receipt_failure();
