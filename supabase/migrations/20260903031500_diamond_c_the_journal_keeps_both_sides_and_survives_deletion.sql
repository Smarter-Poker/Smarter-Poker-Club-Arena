-- ===========================================================================
--  LANE C: THE JOURNAL NAMES BOTH SIDES, AND IT SURVIVES DELETION
-- ===========================================================================
--
-- Diamond Accounting Standard, sections 2.2, 3.2 "Account deletion" and
-- 3.3 DR3 / DR4 / DR5. Everything here is RECORDING. Nothing refuses a
-- movement, nothing moves a balance, nothing changes who may call what.
--
-- What production said before this migration (SELECT-only, 2026-09-03):
--
--   * diamond_transactions carries counterparty and issuance_class (added by
--     the foundation migration) and NOTHING writes either one. Every row is
--     one-sided: a user and a signed amount.
--   * add_diamonds_to_balance requires a reference for exactly 12 settlement
--     types. Every other positive credit may pass reference_id NULL, and the
--     two UNIQUE indexes then protect nothing.
--   * fn_ca_journal_profile_deletion (BEFORE DELETE on profiles) records the
--     profile into ca_profile_deletions and nothing else. 77 profiles were
--     deleted on 2026-09-02, 38 of them holding 198,525 diamonds between
--     them, and ca_mint_ledger still has 0 rows for any asset. A balance
--     left supply and no register saw it.
--   * diamond_transactions has two ON DELETE CASCADE parents (auth.users and
--     profiles), so a deleted player's whole money history leaves with them.
--   * The append-only trigger accepts DELETE when app.ledger_maintenance is
--     set. cleanup_reserved_certification_account uses that bypass on an
--     hourly cadence: 2,718 rows / 635,761 diamonds of journal history in two
--     days (measured per hour: 138, 11, 70, 77, 78, 9, 7, 141, 70, 70).
--
-- So this migration:
--
--   1. add_diamonds_to_balance and deduct_diamonds now derive and write
--      issuance_class and counterparty on the journal row they already write
--      (DR3), and add_diamonds_to_balance files a warning incident when a
--      positive credit carries no reference (DR4) and then CONTINUES exactly
--      as before. Log-only: no credit is refused by this change.
--   2. fn_ca_journal_profile_deletion additionally archives the leaving
--      player's journal rows into ca_diamond_journal_archive and, when the
--      leaving balance is above zero, writes the burn into ca_mint_ledger and
--      files a DR5 incident. Every added step sits in its own BEGIN/EXCEPTION
--      block: a deletion that would have succeeded still succeeds.
--   3. The append-only trigger archives what the maintenance bypass deletes
--      from diamond_transactions and files an info incident. Its refusal
--      logic is untouched, so the certification fleet keeps working and its
--      deletions stop being unrecoverable.
--
-- WHAT THIS MIGRATION DOES NOT DO, deliberately:
--
--   * The CASCADE foreign keys stay CASCADE. Changing them to RESTRICT would
--     refuse a live deletion flow (Dan's risk rule). The archive is how the
--     history survives instead.
--   * cleanup_reserved_certification_account is not touched. It is the
--     certification fleet's own cleanup and step 3 already preserves what it
--     removes.
--   * No column is made NOT NULL and no balance is moved.
--
-- ROLLBACK: the three functions are CREATE OR REPLACE of bodies preserved in
-- this repo's history (see docs/changelog/2026-09-03-diamond-c-journal.md for
-- the pre-change bodies and their lengths); DROP TABLE
-- public.ca_diamond_journal_archive removes the only new object.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. The archive. Same shape as diamond_transactions, no foreign keys, so a
--    row survives the profile and the auth user that produced it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ca_diamond_journal_archive (
  id                 uuid PRIMARY KEY,
  user_id            uuid,
  type               text,
  amount             integer,
  balance_after      integer,
  description        text,
  reference_id       text,
  created_at         timestamptz,
  transaction_type   text,
  source             text,
  metadata           jsonb,
  counterparty       text,
  issuance_class     text,
  archived_at        timestamptz NOT NULL DEFAULT now(),
  deleted_profile_id uuid,
  deletion_reason    text,
  archived_by_role   text NOT NULL DEFAULT CURRENT_USER,
  archived_app       text NOT NULL DEFAULT COALESCE(current_setting('application_name', true), '')
);

COMMENT ON TABLE public.ca_diamond_journal_archive IS
  'Diamond journal rows preserved past the deletion of the player or the row. Written by fn_ca_journal_profile_deletion (before the CASCADE fires) and by fn_ca_journal_append_only (when app.ledger_maintenance permits a DELETE). No foreign keys by design: the point is to outlive profiles and auth.users. Diamond Accounting Standard DR5.';

CREATE INDEX IF NOT EXISTS idx_ca_diamond_journal_archive_user
  ON public.ca_diamond_journal_archive (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_diamond_journal_archive_archived_at
  ON public.ca_diamond_journal_archive (archived_at DESC);

ALTER TABLE public.ca_diamond_journal_archive ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ca_diamond_journal_archive FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_diamond_journal_archive TO service_role;

DROP POLICY IF EXISTS ca_diamond_journal_archive_service_role
  ON public.ca_diamond_journal_archive;
CREATE POLICY ca_diamond_journal_archive_service_role
  ON public.ca_diamond_journal_archive
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. add_diamonds_to_balance: same behaviour, plus DR3 (both sides named on
--    the journal row) and DR4 (a positive credit with no reference is
--    recorded, never refused).
--
--    Preserved verbatim from the live body: the 12-name exact-type list and
--    its reference_id_required return, the duplicate_reference return with
--    the stored balance, the profiles SELECT ... FOR UPDATE and its
--    profile_not_found return, the multiplier eligibility list and its
--    rounding, the insufficient_diamonds return, writing BOTH diamonds and
--    diamond_balance, the boost suffix on the description, the metadata
--    object and the returned jsonb.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(
    p_user_id uuid,
    p_amount integer,
    p_type text DEFAULT 'bonus'::text,
    p_description text DEFAULT NULL::text,
    p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_old_balance integer;
    v_new_balance integer;
    v_txn_id uuid;
    v_multiplier numeric(4,2) := 1.00;
    v_raw_amount integer := COALESCE(p_amount, 0);
    v_actual_amount integer;
    v_exact_type boolean;
    v_type_key text := COALESCE(p_type, 'unknown');
    v_issuance_class text;
    v_counterparty text;
BEGIN
    v_exact_type := p_type IN (
        'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
        'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
        'tournament_entry', 'tournament_entry_refund',
        'tournament_cancel_refund', 'tournament_prize'
    );

    IF p_reference_id IS NULL AND v_exact_type THEN
        RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                                  'reference_required', true);
    END IF;

    IF p_reference_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.diamond_transactions
         WHERE user_id = p_user_id AND reference_id = p_reference_id
    ) THEN
        SELECT balance_after INTO v_new_balance
          FROM public.diamond_transactions
         WHERE user_id = p_user_id AND reference_id = p_reference_id
         LIMIT 1;
        RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference',
                                  'duplicate', true, 'new_balance', v_new_balance);
    END IF;

    SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
      INTO v_old_balance, v_multiplier
      FROM public.profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
    END IF;

    IF v_raw_amount > 0
       AND NOT v_exact_type
       AND p_type NOT IN (
           'purchase', 'deduction', 'adjustment', 'refund', 'transfer',
           'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
           'diamond_received', 'live_gift_received', 'live_gift_sent',
           'vip_daily', 'vip_stipend'
       )
       AND v_multiplier > 1.00 THEN
        v_actual_amount := round(v_raw_amount * v_multiplier);
    ELSE
        v_actual_amount := v_raw_amount;
        v_multiplier := 1.00;
    END IF;

    v_new_balance := v_old_balance + v_actual_amount;
    IF v_new_balance < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds',
                                  'new_balance', v_old_balance);
    END IF;

    -- DR3: name the class and the other side of this movement.
    IF v_type_key = 'purchase' THEN
        v_issuance_class := 'purchased';
        v_counterparty   := 'purchase_clearing';
    ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
        v_issuance_class := 'refund';
        v_counterparty   := 'revenue:' || v_type_key;
    ELSIF v_type_key IN ('transfer', 'diamond_gift_received',
                         'live_gift_received', 'diamond_received') THEN
        v_issuance_class := 'transferred';
        -- This entry point never receives the sender, so the sender is named
        -- as unknown rather than invented. The two-sided transfer functions
        -- are Lane F.
        v_counterparty   := 'player:unknown';
    ELSIF v_type_key = 'adjustment' THEN
        v_issuance_class := 'admin';
        v_counterparty   := 'adjustment';
    ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
        v_issuance_class := 'promotional';
        v_counterparty   := 'promo_budget:' || v_type_key;
    ELSIF v_actual_amount < 0 THEN
        v_issuance_class := 'spend';
        v_counterparty   := 'revenue:' || v_type_key;
    ELSE
        v_issuance_class := 'earned';
        v_counterparty   := 'promo_budget:' || v_type_key;
    END IF;

    UPDATE public.profiles
       SET diamonds = v_new_balance, diamond_balance = v_new_balance, updated_at = now()
     WHERE id = p_user_id;

    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata, counterparty, issuance_class
    ) VALUES (
        p_user_id, v_actual_amount, p_type, p_type,
        CASE WHEN v_actual_amount <> v_raw_amount
             THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
             ELSE p_description END,
        v_new_balance, p_reference_id,
        jsonb_build_object('reference_id', p_reference_id,
                           'raw_amount', v_raw_amount,
                           'multiplier', v_multiplier,
                           'exact_value', v_exact_type),
        v_counterparty, v_issuance_class
    ) RETURNING id INTO v_txn_id;

    -- DR4, LOG ONLY. A positive credit with no reference is not deduped by
    -- either UNIQUE index and can be replayed. Record it and carry on; the
    -- refusal is Dan's to switch on later.
    IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
        BEGIN
            PERFORM public.fn_ca_diamond_incident(
                'DR4:credit_without_reference', 'warning', p_user_id, p_amount,
                'add_diamonds_to_balance',
                jsonb_build_object('type', p_type, 'description', p_description));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END IF;

    RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
        'new_balance', v_new_balance, 'amount', v_actual_amount,
        'multiplier', v_multiplier, 'transaction_id', v_txn_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. deduct_diamonds: same behaviour, plus DR3 on the row it already writes.
--
--    Preserved verbatim: the positive-amount guard, the auth.uid self-check
--    (service_role exempt), the reference_id idempotent success return, the
--    profiles SELECT ... FOR UPDATE and its User not found return, the
--    insufficient-balance return, v_effective_type, the cooldown check, the
--    UPDATE writing both columns, and the returned jsonb.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deduct_diamonds(
    p_user_id uuid,
    p_amount integer,
    p_description text DEFAULT ''::text,
    p_transaction_type text DEFAULT 'game_cost'::text,
    p_source text DEFAULT NULL::text,
    p_metadata jsonb DEFAULT '{}'::jsonb,
    p_reference_id text DEFAULT NULL::text,
    p_cooldown_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current     integer;
  v_new_balance integer;
  v_effective_type text;
  v_issuance_class text;
  v_counterparty text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be a positive integer');
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot deduct diamonds for another user');
  END IF;

  IF p_reference_id IS NOT NULL THEN
    SELECT balance_after INTO v_new_balance
      FROM diamond_transactions
     WHERE reference_id = p_reference_id AND user_id = p_user_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'balance', v_new_balance,
                                'charged', p_amount, 'idempotent', true);
    END IF;
  END IF;

  SELECT COALESCE(diamonds, 0) INTO v_current
    FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found');
  END IF;
  IF v_current < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds', 'balance', v_current);
  END IF;

  v_effective_type := COALESCE(p_source, p_transaction_type);

  IF p_cooldown_seconds > 0 THEN
    IF EXISTS (
      SELECT 1 FROM diamond_transactions
       WHERE user_id = p_user_id
         AND transaction_type = v_effective_type
         AND created_at >= now() - make_interval(secs => p_cooldown_seconds)
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Please wait before sending again',
                                'cooldown_active', true);
    END IF;
  END IF;

  -- DR3. A gift or a transfer leaves this player for another player; every
  -- other debit leaves for the revenue line of the sink that took it.
  IF COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')
     OR COALESCE(p_transaction_type, '') IN ('diamond_gift_sent', 'live_gift_sent') THEN
    v_issuance_class := 'transferred';
    v_counterparty   := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown');
  ELSE
    v_issuance_class := 'spend';
    v_counterparty   := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown');
  END IF;

  UPDATE profiles
     SET diamonds        = diamonds - p_amount,
         diamond_balance = diamonds - p_amount,
         updated_at      = now()
   WHERE id = p_user_id
   RETURNING diamonds INTO v_new_balance;

  INSERT INTO diamond_transactions
    (user_id, amount, transaction_type, type, description, balance_after, metadata,
     reference_id, created_at, counterparty, issuance_class)
  VALUES
    (p_user_id, -p_amount, v_effective_type, v_effective_type, p_description, v_new_balance,
     p_metadata, p_reference_id, now(), v_counterparty, v_issuance_class);

  RETURN jsonb_build_object('success', true, 'balance', v_new_balance, 'charged', p_amount);
END;
$function$;

REVOKE ALL ON FUNCTION public.deduct_diamonds(uuid, integer, text, text, text, jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_diamonds(uuid, integer, text, text, text, jsonb, text, integer)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Retirement (DR5). The BEFORE DELETE trigger on profiles already exists;
--    only its function body changes, so no trigger is created on that table.
--    Every added step is in its own BEGIN/EXCEPTION block, exactly like the
--    existing ca_profile_deletions insert: this function must never be the
--    reason a deletion fails.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_journal_profile_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_archived integer := 0;
BEGIN
  BEGIN
    INSERT INTO public.ca_profile_deletions
      (profile_id, username, is_horse, diamonds, diamond_balance, profile_created_at)
    VALUES
      (OLD.id, OLD.username, OLD.is_horse, OLD.diamonds, OLD.diamond_balance, OLD.created_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_profile_deletions could not record deletion of % (%): %',
      OLD.id, OLD.username, SQLERRM;
  END;

  -- (a) Keep the history. This runs BEFORE the ON DELETE CASCADE fires, so
  --     the rows are still there to copy.
  BEGIN
    INSERT INTO public.ca_diamond_journal_archive
      (id, user_id, type, amount, balance_after, description, reference_id, created_at,
       transaction_type, source, metadata, counterparty, issuance_class,
       deleted_profile_id, deletion_reason)
    SELECT t.id, t.user_id, t.type, t.amount, t.balance_after, t.description,
           t.reference_id, t.created_at, t.transaction_type, t.source, t.metadata,
           t.counterparty, t.issuance_class, OLD.id, v_reason
      FROM public.diamond_transactions t
     WHERE t.user_id = OLD.id
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_diamond_journal_archive could not preserve the journal of % (%): %',
      OLD.id, OLD.username, SQLERRM;
  END;

  -- (b) A balance that leaves with the account has left supply. Say so in the
  --     register and file the incident. This RECORDS the retirement; it does
  --     not stop the deletion and it does not move a balance.
  IF COALESCE(OLD.diamonds, 0) > 0 THEN
    BEGIN
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount,
         balance_before, balance_after, supply_after, reason, performed_by)
      VALUES
        ('deletion:' || OLD.id::text, 'burn', 'diamonds', 'player', OLD.id, OLD.username,
         OLD.diamonds, OLD.diamonds, 0,
         COALESCE(public.fn_ca_mint_supply('diamonds'), 0) - OLD.diamonds,
         'profile deleted with a balance (retirement recorded by trigger, docs/DIAMOND-ACCOUNTING-STANDARD.md DR5)',
         NULL)
      ON CONFLICT (op_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ca_mint_ledger could not record the retirement burn of % (% diamonds): %',
        OLD.id, OLD.diamonds, SQLERRM;
    END;

    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR5:deleted_with_balance', 'warning', OLD.id, OLD.diamonds, 'profiles DELETE',
        jsonb_build_object('is_horse', OLD.is_horse, 'username', OLD.username,
                           'journal_rows_archived', v_archived,
                           'ledger_maintenance', v_reason));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_journal_profile_deletion()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_journal_profile_deletion() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. The append-only bypass. The refusal logic below is UNCHANGED, including
--    the allowed-UPDATE shapes, the mutation log, the drift incident and the
--    P0403 exception. The only addition is, for diamond_transactions DELETEs
--    that the bypass permits, an archive copy and an info incident, so the
--    certification fleet keeps working and what it removes is recoverable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_journal_append_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_journal_append_only() TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Post-apply assertions. The migration aborts if any of them is false.
-- ---------------------------------------------------------------------------

DO $assert$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.ca_diamond_journal_archive') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_journal_archive was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ca_diamond_journal_archive'
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ca_diamond_journal_archive does not have row level security enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ca_diamond_journal_archive'::regclass AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'ca_diamond_journal_archive must have no foreign keys: it has to outlive profiles and auth.users';
  END IF;

  IF has_table_privilege('authenticated', 'public.ca_diamond_journal_archive', 'SELECT')
     OR has_table_privilege('anon', 'public.ca_diamond_journal_archive', 'SELECT') THEN
    RAISE EXCEPTION 'ca_diamond_journal_archive must not be readable by anon or authenticated';
  END IF;

  SELECT string_agg(x, ', ') INTO v_missing FROM (
    SELECT 'fn_ca_journal_profile_deletion is missing the deletion op_id' AS x
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_profile_deletion'
                          AND p.prosrc LIKE '%deletion:%')
    UNION ALL
    SELECT 'fn_ca_journal_profile_deletion does not write the archive'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_profile_deletion'
                          AND p.prosrc LIKE '%ca_diamond_journal_archive%')
    UNION ALL
    SELECT 'add_diamonds_to_balance does not record DR4'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'add_diamonds_to_balance'
                          AND p.prosrc LIKE '%DR4:credit_without_reference%')
    UNION ALL
    SELECT 'add_diamonds_to_balance does not set issuance_class'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'add_diamonds_to_balance'
                          AND p.prosrc LIKE '%issuance_class%')
    UNION ALL
    SELECT 'deduct_diamonds does not set issuance_class'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'deduct_diamonds'
                          AND p.prosrc LIKE '%issuance_class%')
    UNION ALL
    SELECT 'fn_ca_journal_append_only lost its P0403 refusal'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only'
                          AND p.prosrc LIKE '%P0403%')
    UNION ALL
    SELECT 'fn_ca_journal_append_only does not archive diamond journal deletes'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only'
                          AND p.prosrc LIKE '%DR5:journal_row_deleted_under_maintenance%')
  ) s;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'post-apply assertions failed: %', v_missing;
  END IF;
END
$assert$;

COMMIT;
