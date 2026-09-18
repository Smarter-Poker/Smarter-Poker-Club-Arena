
ALTER TABLE club_members ADD COLUMN updated_at timestamptz;
CREATE UNIQUE INDEX member_scope ON club_members(club_id,user_id);
-- The shared base fixture owns table_seats.id and table_seats.club_id.
CREATE TABLE transaction_idempotency_keys(key uuid PRIMARY KEY,user_id uuid NOT NULL,action text NOT NULL,amount numeric,created_at timestamptz DEFAULT now());
CREATE TABLE table_pending_addons(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,amount numeric,kind text);
-- The original cash funding fixture owns wallet_transactions and its receipt IDs.
CREATE TABLE blacklists(id uuid,user_id uuid,club_id uuid,union_id uuid,expires_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
CREATE FUNCTION fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.session_live',true),'true')<>'false' $$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION fn_seat_club_for_user(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT club_id FROM tables WHERE id=$2 $$;
CREATE FUNCTION fn_ensure_club_wallet(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
CREATE TRIGGER member_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();

-- The shared base fixture owns entry_purchase_idempotency_receipts.
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.frozen',true),'false')='true' $$;
CREATE FUNCTION fn_assert_cash_chip_purchase_table(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
CREATE FUNCTION trg_entry_purchase_receipt_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.response IS NOT NULL OR OLD.completed_at IS NOT NULL THEN RAISE EXCEPTION 'completed receipts cannot be deleted' USING ERRCODE='55000';END IF;
  RETURN OLD;
 END IF;
 IF OLD.key_domain IS DISTINCT FROM NEW.key_domain OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.request IS DISTINCT FROM NEW.request OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at OR OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL THEN
  RAISE EXCEPTION 'only first completion allowed' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER z_entry_purchase_receipt_is_immutable BEFORE DELETE OR UPDATE ON entry_purchase_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION trg_entry_purchase_receipt_is_immutable();
CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_record_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb, p_response jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN p_response;
  END IF;
  IF p_request IS NULL OR p_response IS NULL THEN
    RAISE EXCEPTION 'entry purchase receipts require a non-null request and response'
      USING ERRCODE = '22004';
  END IF;

  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key completed concurrently for a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NOT NULL THEN
    RETURN v_response;
  END IF;

  UPDATE public.entry_purchase_idempotency_receipts r
     SET response = p_response,
         completed_at = transaction_timestamp()
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL
  RETURNING r.response INTO STRICT v_response;
  RETURN v_response;
END;
$function$
;
