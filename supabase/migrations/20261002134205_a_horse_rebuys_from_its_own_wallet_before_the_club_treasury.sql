-- 20261002134205_a_horse_rebuys_from_its_own_wallet_before_the_club_treasury.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A busted horse's cash rebuy (engine autoRebuyHorse -> fn_horse_fund_from_treasury
-- -> this money core) was paid 100 percent by the club treasury, while the
-- horse's buy-in had left its own club wallet and every cash-out landed back in
-- that wallet. So the treasury paid for every bust and the winnings it funded
-- cashed out to the horse: an open loop that drains the treasury into horse
-- wallets. Measured 2026-10-02 13:30 UTC over the previous 24 h:
--
--   Deep Stack Society  879 rebuys, 104,403.00 club_treasury -> table_stack,
--                       while its 416 horses held 5,491,527.72 in their wallets
--                       (smallest 5,349.15); treasury 8,100 at 11:07 and kept
--                       alive only by two direct UPDATEs of clubs.chip_treasury
--                       (14,630.53 at 09:44, 34,625.00 at 11:30).
--   Club JAQK           206 rebuys in 48 h, 47,195.00; treasury 4,369.76.
--   SHARK CLUB          235 rebuys in 48 h, 47,275.00; treasury 20,870.68.
--
-- Now the horse pays from its own wallet first, through the same add-on door a
-- human uses (atomic_table_addon_before_maintenance_announcement_gate: wallet
-- debit, player_wallet -> table_stack 'addon' leg, wallet journal, chip
-- continuity baseline, cash funding receipt keyed horse_fund_wallet:<op>).
-- Only a shortfall the wallet cannot cover is drawn from the treasury, with the
-- same treasury leg, key (horse_fund:<op>) and funding receipt as before, for
-- the shortfall amount. The horse's loop is now closed on its own roll, the
-- one horseRebuyAmount already sizes the rebuy from (CLAUDE.md 10.5: the same
-- buy-in, out of the same club wallet, through the same RPC).
--
-- The response shape the public door and the engine verify is unchanged:
-- success, op_id, table_id, user_id, club_id, treasury_club_id, amount (the
-- full rebuy), new_stack. wallet_amount / treasury_amount are added. Lock order
-- is unchanged: the treasury row is locked before the seat, and only when the
-- treasury pays. No engine change, no data change, nothing backfilled.
--
-- Chips already in horse wallets stay there (CLAUDE.md 10.9 rule 3 and 10.5:
-- nothing is taken back from a player, and "they are horses" is never the
-- reason); from now on those wallets fund the horses' own rebuys.
--
-- Proven 2026-10-02 in one self-aborting DO block on production (pg_temp copy
-- of this body): wallet path 2.00 -> one addon leg, wallet -2.00, treasury
-- unchanged, one funding receipt; split path (wallet 0.75) -> addon 0.75 plus
-- horse_funding 1.25 keyed horse_fund:<op>, treasury -1.25, two receipts.

BEGIN;

DO $pre$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = 'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure)
     IS DISTINCT FROM 'b5b07fa131b40391a8ff46e654c89fe8' THEN
    RAISE EXCEPTION 'HORSE_FUNDING_PREIMAGE_DRIFT: the money core changed since this migration was written';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(p_table_id uuid, p_user_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_original_ledger uuid;
  v_club_id uuid;
  v_fund_club uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_wallet numeric;
  v_from_wallet numeric := 0;
  v_from_treasury numeric := 0;
  v_wallet_after numeric;
  v_prior public.chip_ledger;
  v_skip text := COALESCE(current_setting('app.ledger_autoskip_clubs', true), '');
  v_cat text;
  v_cp text;
  v_cpe text;
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
  -- tables.club_id is the union row, which holds no treasury; the seat was
  -- bought from a member club's wallet (table_seats.club_id) and that club is
  -- the one whose wallet and treasury reload it - the same club the cash-out
  -- credits.
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
    -- A keyed call is answered once, whichever account paid it. The public
    -- door answers replays from its immutable receipt before it reaches this
    -- body; this is the money core's own second line.
    SELECT *
      INTO v_prior
      FROM public.chip_ledger
     WHERE idempotency_key = 'horse_fund:' || p_op_id::text;
    IF FOUND OR EXISTS (
      SELECT 1 FROM public.cash_participant_funding_receipts r
       WHERE r.operation_kind = 'addon'
         AND r.operation_key = 'horse_fund_wallet:' || p_op_id::text
    ) THEN
      IF v_prior.id IS NOT NULL AND (
         v_prior.table_id IS DISTINCT FROM p_table_id
         OR v_prior.club_id IS DISTINCT FROM v_fund_club
         OR COALESCE((v_prior.metadata->>'requested_amount')::numeric, v_prior.amount)
              IS DISTINCT FROM p_amount
         OR v_prior.metadata->>'user_id' IS DISTINCT FROM p_user_id::text
         OR v_prior.category IS DISTINCT FROM 'horse_funding'
         OR v_prior.from_type IS DISTINCT FROM 'club_treasury'
         OR v_prior.to_type IS DISTINCT FROM 'table_stack') THEN
        RAISE EXCEPTION 'Horse funding identity reused with different payload'
          USING ERRCODE = '22023';
      END IF;
      SELECT ts.stack INTO v_new_stack
        FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
       LIMIT 1;
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'op_id', p_op_id,
        'table_id', p_table_id,
        'user_id', p_user_id,
        'club_id', v_club_id,
        'treasury_club_id', v_fund_club,
        'amount', p_amount,
        'new_stack', COALESCE((v_prior.metadata->>'new_stack')::numeric, v_new_stack),
        'treasury_after', v_prior.metadata->'treasury_after'
      );
    END IF;
  END IF;

  /* A HORSE REBUYS FROM ITS OWN WALLET FIRST (2026-10-02). Its buy-in already
     left its club wallet and every cash-out lands back in that wallet, so the
     wallet is its roll - the same one horseRebuyAmount sizes this rebuy from.
     Until today every rebuy was paid by the club treasury instead, so the
     treasury paid for each bust and the winnings it funded cashed out to the
     horse's wallet: Deep Stack Society paid 104,403.00 in 879 rebuys in 24 h
     while its 416 horses held 5,491,527.72 in their wallets, and its treasury
     reached zero within a day. The wallet part goes through the same add-on
     door a human uses (CLAUDE.md 10.5); only a shortfall the wallet cannot
     cover is drawn from the treasury, as before. */
  SELECT GREATEST(COALESCE(cm.chip_balance, 0), 0)
    INTO v_wallet
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id
     AND cm.club_id = v_fund_club;
  v_from_wallet := LEAST(COALESCE(v_wallet, 0), p_amount);
  v_from_treasury := p_amount - v_from_wallet;

  -- Lock order is unchanged: the treasury row before the seat, and only when
  -- the treasury actually pays.
  IF v_from_treasury > 0 THEN
    SELECT COALESCE(chip_treasury, 0)
      INTO v_treasury
      FROM public.clubs
     WHERE id = v_fund_club
     FOR UPDATE;
    IF v_treasury IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club not found');
    END IF;
    IF v_treasury < v_from_treasury THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient club treasury',
        'treasury', v_treasury,
        'needed', v_from_treasury,
        'wallet', v_from_wallet,
        'treasury_club_id', v_fund_club
      );
    END IF;
  END IF;

  PERFORM 1
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no active seat for user at table'
    );
  END IF;

  IF v_from_wallet > 0 THEN
    v_cat := COALESCE(current_setting('app.ledger_category', true), '');
    v_cp := COALESCE(current_setting('app.ledger_counterparty', true), '');
    v_cpe := COALESCE(current_setting('app.ledger_counterparty_entity', true), '');
    -- The human add-on door: club wallet -> seat, its ledger leg, its wallet
    -- journal, the chip-continuity baseline and its funding receipt.
    v_wallet_after := public.atomic_table_addon_before_maintenance_announcement_gate(
      p_user_id, p_table_id, v_from_wallet, true,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund_wallet:' || p_op_id::text END
    );
    PERFORM set_config('app.ledger_category', v_cat, true);
    PERFORM set_config('app.ledger_counterparty', v_cp, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_cpe, true);
  END IF;

  IF v_from_treasury > 0 THEN
    UPDATE public.table_seats
       SET stack = COALESCE(stack, 0) + v_from_treasury
     WHERE table_id = p_table_id
       AND user_id = p_user_id
       AND left_at IS NULL;

    PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, v_from_treasury);

    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) - v_from_treasury,
           updated_at = NOW()
     WHERE id = v_fund_club;
    PERFORM set_config('app.ledger_autoskip_clubs', v_skip, true);
  END IF;

  SELECT ts.stack
    INTO v_new_stack
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL;

  IF v_from_treasury > 0 THEN
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
      v_from_treasury,
      'horse_treasury_funding',
      CASE WHEN v_from_wallet > 0
           THEN 'Horse rebuy shortfall funded from club treasury (wallet paid '
                || v_from_wallet::text || ')'
           ELSE 'Horse buy-in/rebuy funded from club treasury' END,
      v_treasury - v_from_treasury,
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
        v_from_treasury,
        'horse_funding',
        v_fund_club,
        p_table_id,
        'Buy-in/rebuy shortfall funded from club treasury (fn_horse_fund_from_treasury) for '
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
          'treasury_after', v_treasury - v_from_treasury,
          'requested_amount', p_amount,
          'wallet_amount', v_from_wallet
        )
      ) RETURNING id INTO v_original_ledger;
      PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,
        v_original_ledger,NULL,v_fund_club,v_from_treasury,v_treasury-v_from_treasury,NULL);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure aborts the entire chip movement. Bare RAISE preserves
      -- the original SQLSTATE, DETAIL, HINT and context for the caller's retry.
      RAISE;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'new_stack', v_new_stack,
    'treasury_after', CASE WHEN v_from_treasury > 0 THEN v_treasury - v_from_treasury END,
    'op_id', p_op_id,
    'table_id', p_table_id,
    'user_id', p_user_id,
    'club_id', v_club_id,
    'treasury_club_id', v_fund_club,
    'amount', p_amount,
    'wallet_amount', v_from_wallet,
    'treasury_amount', v_from_treasury,
    'wallet_after', v_wallet_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE s text := (SELECT p.prosrc FROM pg_proc p
  WHERE p.oid = 'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure);
BEGIN
  IF position('atomic_table_addon_before_maintenance_announcement_gate' IN s) = 0
     OR position('v_from_treasury := p_amount - v_from_wallet' IN s) = 0
     OR position('atomic_table_addon_before_maintenance_announcement_gate' IN s)
        > position('UPDATE public.clubs' IN s) THEN
    RAISE EXCEPTION 'HORSE_FUNDING_POSTIMAGE: the wallet is not paid before the treasury';
  END IF;
END
$post$;

COMMIT;
