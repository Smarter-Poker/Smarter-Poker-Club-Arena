-- a_horse_rebuy_is_funded_by_the_club_its_seat_represents
--
-- LANE E (DB side of the horse audit, 2026-09-11). Reserve a real version with
-- `node scripts/new-migration.mjs "a horse rebuy is funded by the club its seat
-- represents"` before applying; apply ONCE, outside :50-:03 UTC.
--
-- WHAT IS WRONG (read from rows, not guessed)
--
-- `fn_horse_fund_from_treasury` is the ONLY funding path the engine has for a
-- busted horse at a cash table (server/src/services/supabase/wallets.ts
-- autoRebuyHorse -> ServerTableEngineDealing.recoverBustedSeatedHorses and
-- ServerTableEngineSettlement step 5). Both layers of it resolve the treasury
-- to debit as `SELECT club_id FROM tables WHERE id = p_table_id`.
--
-- Every Midway cash table carries `tables.club_id = fade0000-...-0001`, the
-- union's own club row (measured 2026-09-11 14:4x UTC: 283 open Midway cluster
-- tables, all of them; 262 horse seats on them, every seat stamped JAQK
-- a0000000-... or SHARK a41434bb-...). The union row's `chip_treasury` is 0.50.
-- JAQK's is 937,497.23 and SHARK's 885,816.01.
--
-- So on Midway the door answers `insufficient club treasury` to every rebuy,
-- autoRebuyHorse maps that to `declined`, and the engine releases the seat
-- with reason `busted_unfunded` ("left - insufficient treasury funds").
--
--   chip_ledger category = 'horse_funding', by club, by day:
--     Deep Stack Society  09-01 117 / 09-02 1,316 / 09-03 4,683 / 09-04 2,360 /
--                         09-05 682 / 09-06 661 / 09-07 721 / 09-08 989 /
--                         09-09 915 / 09-10 576 / 09-11 261  (449 in the last 24 h)
--     Midway Union        09-02 81 rows, 8,291.00 chips - then NOTHING for nine
--                         days. That is the 0.50 left in the union row.
--     JAQK / SHARK        0 rows ever: their treasuries were never asked.
--   Horse cash exits in the last 24 h: Midway 484 (310 with a zero stack),
--   DSS 346 (233 with a zero stack). DSS busts reload; Midway busts stand up.
--
-- Every other money door on this platform already resolves the CLUB THE SEAT
-- REPRESENTS, not the table's club: `atomic_credit_wallet_and_log` (the
-- cash-out) reads `table_seats.club_id` first; `atomic_table_buyin` stamps the
-- seat with `fn_seat_club_for_user`; the addon reads the seat's club; the engine
-- reads the rebuy roll at the seat's club (`readSeatWalletClub`, lane B #15).
-- This door is the one that did not, and it is the reason the Midway floor
-- loses every horse that busts (CLAUDE.md 10.5: a DSS horse and a Midway horse
-- must get the same deal; today only one of them can reload).
--
-- THE FIX (the line that produces the wrong outcome, CLAUDE.md 10.11/10.12)
--
-- Both layers now resolve `v_fund_club` = the live seat's `club_id`, falling
-- back to the table's club only when the seat carries none (which no live
-- cash seat does today: 445 of 445). The treasury locked, debited, journalled
-- (chip_transactions.club_id, chip_ledger.club_id / from_entity_id) and
-- replay-checked is that club. Everything else is byte-identical to the
-- production bodies (md5 87eff86bbf9e4377380ecc975b4dac6d and
-- 3ae90f749e529679f18aef61c1afccce, read from pg_proc 2026-09-11).
--
-- THE RESPONSE KEEPS `club_id` = THE TABLE'S CLUB, AND ADDS `treasury_club_id`.
-- The deployed engine verifies `data.club_id === this.tableInfo.club_id`
-- (wallets.ts autoRebuyHorse); returning the funding club there would turn
-- every Midway reload into `unknown` after the chips had already moved, and
-- the retry would replay the same mismatch for ever. The receipt therefore
-- says both: `club_id` is the table the seat is at, `treasury_club_id` is the
-- treasury that paid. Engine follow-up (lane A/B file): verify
-- `treasury_club_id` when present and log it in the "rebought" line.
--
-- The idempotency replay compares the prior ledger row's club_id against the
-- funding club, so a key first used under the old resolver (DSS rows: table
-- club == seat club, identical) still replays; a Midway key never got a row.
--
-- NOT a repair job: no row is back-filled, nobody is paid for past busts (a
-- stood-up horse kept its wallet; nothing was taken), and the live path is
-- the thing that changes.
--
-- Idempotent: re-running replaces the bodies with the same text and re-states
-- the same grants. ONE transaction, DDL only on the two function bodies.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(p_table_id uuid, p_user_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_fund_club uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_prior public.chip_ledger;
  v_skip text := COALESCE(current_setting('app.ledger_autoskip_clubs', true), '');
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'table, user and positive amount required'
    );
  END IF;

  SELECT club_id
    INTO v_club_id
    FROM public.tables
   WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  -- THE CLUB THE SEAT REPRESENTS PAYS (lane E, 2026-09-11). A union table's
  -- tables.club_id is the union row, which holds no treasury (0.50 on Midway
  -- after 09-02); the seat was bought from a member club's wallet
  -- (table_seats.club_id, stamped by fn_seat_club_for_user) and that club's
  -- treasury is the one that reloads it - the same club the cash-out credits.
  -- A seat with no club stamp (none live today) keeps the table's club.
  SELECT ts.club_id
    INTO v_fund_club
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC
   LIMIT 1;
  v_fund_club := COALESCE(v_fund_club, v_club_id);

  IF NOT public.fn_actor_can_manage_club_treasury(v_fund_club) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not authorized to fund from club treasury'
    );
  END IF;

  IF p_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('horse_fund:' || p_op_id::text, 0)
    );
    SELECT *
      INTO v_prior
      FROM public.chip_ledger
     WHERE idempotency_key = 'horse_fund:' || p_op_id::text;
    IF FOUND THEN
      IF v_prior.table_id IS DISTINCT FROM p_table_id
         OR v_prior.club_id IS DISTINCT FROM v_fund_club
         OR v_prior.amount IS DISTINCT FROM p_amount
         OR v_prior.metadata->>'user_id' IS DISTINCT FROM p_user_id::text
         OR v_prior.category IS DISTINCT FROM 'horse_funding'
         OR v_prior.from_type IS DISTINCT FROM 'club_treasury'
         OR v_prior.to_type IS DISTINCT FROM 'table_stack' THEN
        RAISE EXCEPTION 'Horse funding identity reused with different payload'
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'op_id', p_op_id,
        'table_id', p_table_id,
        'user_id', p_user_id,
        'club_id', v_club_id,
        'treasury_club_id', v_fund_club,
        'amount', p_amount,
        'new_stack', v_prior.metadata->'new_stack',
        'treasury_after', v_prior.metadata->'treasury_after'
      );
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0)
    INTO v_treasury
    FROM public.clubs
   WHERE id = v_fund_club
   FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient club treasury',
      'treasury', v_treasury,
      'needed', p_amount,
      'treasury_club_id', v_fund_club
    );
  END IF;

  UPDATE public.table_seats
     SET stack = COALESCE(stack, 0) + p_amount
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no active seat for user at table'
    );
  END IF;

  PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount,
         updated_at = NOW()
   WHERE id = v_fund_club;
  PERFORM set_config('app.ledger_autoskip_clubs', v_skip, true);

  INSERT INTO public.chip_transactions (
    id,
    club_id,
    from_user_id,
    to_user_id,
    amount,
    transaction_type,
    notes,
    balance_after,
    created_at
  ) VALUES (
    gen_random_uuid(),
    v_fund_club,
    NULL,
    p_user_id,
    p_amount,
    'horse_treasury_funding',
    'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount,
    NOW()
  );

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by,
      from_type,
      from_entity_id,
      to_type,
      to_entity_id,
      amount,
      category,
      club_id,
      table_id,
      description,
      idempotency_key,
      metadata
    ) VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury',
      v_fund_club,
      'table_stack',
      p_table_id,
      p_amount,
      'horse_funding',
      v_fund_club,
      p_table_id,
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury) for '
        || p_user_id::text,
      CASE
        WHEN p_op_id IS NULL THEN NULL
        ELSE 'horse_fund:' || p_op_id::text
      END,
      jsonb_build_object(
        'user_id', p_user_id,
        'op_id', p_op_id,
        'door', 'fn_horse_fund_from_treasury',
        'table_club_id', v_club_id,
        'new_stack', v_new_stack,
        'treasury_after', v_treasury - p_amount
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- A journal failure aborts the entire chip movement. Bare RAISE preserves
    -- the original SQLSTATE, DETAIL, HINT and context for the caller's retry.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'new_stack', v_new_stack,
    'treasury_after', v_treasury - p_amount,
    'op_id', p_op_id,
    'table_id', p_table_id,
    'user_id', p_user_id,
    'club_id', v_club_id,
    'treasury_club_id', v_fund_club,
    'amount', p_amount
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_club_id uuid;
  v_fund_club uuid;
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'table, user and positive amount required'
    );
  END IF;

  SELECT club_id
    INTO v_club_id
    FROM public.tables
   WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;
  -- The club the seat represents is the treasury that pays (see the inner
  -- body). The authority check is made against THAT club.
  SELECT ts.club_id
    INTO v_fund_club
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC
   LIMIT 1;
  v_fund_club := COALESCE(v_fund_club, v_club_id);
  IF NOT public.fn_actor_can_manage_club_treasury(v_fund_club) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not authorized to fund from club treasury'
    );
  END IF;

  v_request := jsonb_build_object(
    'door', 'fn_horse_fund_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    v_response := v_response->'response';
    IF v_response->>'success' IS DISTINCT FROM 'true'
       OR v_response->>'op_id' IS DISTINCT FROM p_op_id::text
       OR v_response->>'table_id' IS DISTINCT FROM p_table_id::text
       OR v_response->>'user_id' IS DISTINCT FROM p_user_id::text
       OR v_response->>'club_id' IS DISTINCT FROM v_club_id::text
       OR (v_response->>'amount')::numeric IS DISTINCT FROM p_amount
       OR jsonb_typeof(v_response->'new_stack') IS DISTINCT FROM 'number'
       OR (v_response->>'new_stack')::numeric < p_amount THEN
      RAISE EXCEPTION
        'HORSE_FUNDING_RECEIPT_INVALID: immutable response does not match the authorized request'
        USING ERRCODE = '55000';
    END IF;
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse rebuy'
    );
  END IF;

  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_fund_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;

  IF v_response->>'op_id' IS DISTINCT FROM p_op_id::text
     OR v_response->>'table_id' IS DISTINCT FROM p_table_id::text
     OR v_response->>'user_id' IS DISTINCT FROM p_user_id::text
     OR v_response->>'club_id' IS DISTINCT FROM v_club_id::text
     OR v_response->>'treasury_club_id' IS DISTINCT FROM v_fund_club::text
     OR (v_response->>'amount')::numeric IS DISTINCT FROM p_amount
     OR jsonb_typeof(v_response->'new_stack') IS DISTINCT FROM 'number'
     OR (v_response->>'new_stack')::numeric < p_amount THEN
    RAISE EXCEPTION
      'HORSE_FUNDING_RECEIPT_INVALID: money core returned a mismatched acknowledgement'
      USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
END;
$function$;

-- The grants, stated (check-definer-authorization): production has exactly
-- these today - the outer door is service_role only, the inner body is
-- reachable only through the outer door.
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.ca_money_rpc_registry
   SET notes = COALESCE(notes, '') || ' | 2026-09-11 lane E: the treasury debited is the club the SEAT represents (table_seats.club_id), not tables.club_id - a union table''s club is the union row, which holds no treasury; response carries treasury_club_id.'
 WHERE proname IN ('fn_horse_fund_from_treasury', 'fn_horse_fund_from_treasury_before_maintenance_gate')
   AND COALESCE(notes, '') NOT LIKE '%2026-09-11 lane E%';

DO $check$
BEGIN
  IF has_function_privilege('authenticated',
       'public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid, uuid, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants did not take on fn_horse_fund_from_treasury';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid, uuid, numeric, uuid)'::regprocedure)
       NOT LIKE '%v_fund_club := COALESCE(v_fund_club, v_club_id);%' THEN
    RAISE EXCEPTION 'the seat-club resolver did not land in the funding body';
  END IF;
END
$check$;

COMMIT;
