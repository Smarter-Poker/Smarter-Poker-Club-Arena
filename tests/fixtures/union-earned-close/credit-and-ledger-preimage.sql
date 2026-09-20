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
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_credit_treasury_zd4core(p_club_id uuid, p_amount numeric, p_reason text, p_metadata jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid parameters');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  UPDATE clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_credit', COALESCE(p_reason, 'Treasury credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_treasury(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_op_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prior jsonb;
  v_res jsonb;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN public.fn_credit_treasury_zd4core(p_club_id, p_amount, p_reason, p_metadata);
  END IF;

  SELECT result INTO v_prior
    FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  END IF;

  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_credit_treasury', auth.uid());

  v_res := public.fn_credit_treasury_zd4core(p_club_id, p_amount, p_reason, p_metadata);

  IF COALESCE(v_res->>'success', '') = 'true' THEN
    UPDATE public.ca_op_claims
       SET result = v_res, finalized_at = now()
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  ELSE
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  END IF;

  RETURN v_res;
END;
$function$;

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
END $function$;
