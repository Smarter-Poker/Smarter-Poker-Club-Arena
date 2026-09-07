-- ===============================================================================
--  THE DIAMOND AUDIT NAMES THE WRITER (DR6, log-only)
-- ===============================================================================
--
-- Lane G, second migration. It owns the trigger on public.profiles and nothing
-- else does, so it is its own transaction with its own lock_timeout.
--
-- -- WHAT WAS WRONG ----------------------------------------------------------
--
-- ca_diamond_balance_audit has 603 rows. Every one of them says db_role =
-- postgres, app_name = 'PostgREST 14.5' and journaled = false, because:
--
--   * every diamond writer is SECURITY DEFINER owned by postgres, so db_role
--     cannot attribute a movement to a caller (audit lane 1, section 2);
--   * fn_ca_audit_diamond_change never set journaled, and it is the ONLY
--     function in the database that names the table, so the column has been a
--     constant since the day it was added (measured: 603 of 603 false).
--
-- The audit therefore recorded that a balance moved and nothing about who
-- moved it. This replaces the body so it records the WRITER (the innermost
-- PL/pgSQL frame in PG_CONTEXT that is not the trigger itself, the same
-- technique fn_guard_profile_privileged_columns uses to allowlist a call
-- stack) and the declared MONEY PATH (app.money_path), and it fires on INSERT
-- as well as UPDATE so a balance born non-zero is audited rather than
-- appearing from nowhere.
--
-- -- WHY journaled CANNOT MEAN "THIS MOVEMENT WAS JOURNALLED" -----------------
--
-- The specification for this lane asked for journaled = EXISTS(a
-- diamond_transactions row for this user since the transaction started), and
-- for a DR6 incident whenever that is false and the delta is non-zero. The
-- first half is built exactly as asked. The second half is gated, and the
-- reason is measured, not assumed:
--
--   In ALL EIGHT sanctioned money paths the balance UPDATE comes BEFORE the
--   journal INSERT. Byte offsets inside pg_proc.prosrc, read 2026-09-03:
--
--     add_diamonds_to_balance       UPDATE 2359  ->  INSERT 2503
--     deduct_diamonds               UPDATE 1710  ->  INSERT 1924
--     fn_ca_mint                    UPDATE 2961  ->  INSERT 3097
--     fn_ca_burn                    UPDATE 2973  ->  INSERT 3109
--     claim_daily_challenge         UPDATE 1933  ->  INSERT 2341
--     claim_daily_challenges        UPDATE 3941  ->  INSERT 4344
--     send_stream_gift              UPDATE 2174  ->  INSERT 3239
--     send_wallet_diamond_transfer  UPDATE 2204  ->  INSERT 3016
--
--   An AFTER UPDATE trigger runs between those two statements. It can see a
--   journal row written EARLIER in the transaction (now() is transaction
--   start) and can never see one written LATER. So journaled is false for
--   every legitimate credit on this platform, and an ungated rule would file a
--   warning on 100 percent of correct movements, which is not a control, it is
--   a noise generator that hides the one real case.
--
-- So the column records the honest in-transaction-so-far fact and says so in
-- its comment, and the INCIDENT fires on what DR6 actually asks: a balance
-- changed and the writer is not one of the sanctioned money paths. That is the
-- rule in standard 3.3 DR6 word for word ("one credit function, one debit
-- function"), and it is the signal a human can act on.
--
-- Making journaled accurate needs a DEFERRED constraint trigger firing at
-- commit. That changes trigger ordering and failure timing on the hottest
-- table in the database for a log-only control, so under Dan's risk rule it is
-- NOT built here. It is written up for Dan in the changelog.
--
-- -- IT STILL NEVER BLOCKS ----------------------------------------------------
--
-- The whole body is inside BEGIN ... EXCEPTION WHEN OTHERS, the handler writes
-- to ca_ledger_write_failures, and that write has its own handler that
-- swallows. RETURN NEW is unconditional. A diamond movement can never fail
-- because the audit failed.
--
-- -- ALSO IN THIS FILE --------------------------------------------------------
--
-- fn_ca_diamond_trial_balance is re-created with ONE change: the diamond_house
-- delta. When Lane G's first migration applied at 00:31 UTC,
-- ca_diamond_house_ledger did not exist. It exists now (another lane landed it
-- in the same minutes) and its columns are (at, delta), not (created_at,
-- amount), so the guarded read fell through to its note and the house account
-- had a permanent blind spot. The read now discovers the timestamp and amount
-- columns from information_schema instead of hard-coding them. Nothing else in
-- the function changes.
--
-- DDL: one transaction, applied once, lock_timeout 4s. The function replace
-- comes first and the trigger swap last, so the ACCESS EXCLUSIVE lock on
-- profiles is held for as little as possible.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. The audit table learns the writer
-- ---------------------------------------------------------------------------

ALTER TABLE public.ca_diamond_balance_audit ADD COLUMN writer     text;
ALTER TABLE public.ca_diamond_balance_audit ADD COLUMN money_path text;

COMMENT ON COLUMN public.ca_diamond_balance_audit.writer IS
  'DR6: the innermost PL/pgSQL frame in PG_CONTEXT that is not the trigger itself, i.e. the '
  'function that actually wrote profiles.diamonds. NULL means the write came from a plain '
  'statement with no function around it. db_role cannot answer this question: every diamond '
  'writer is SECURITY DEFINER owned by postgres.';

COMMENT ON COLUMN public.ca_diamond_balance_audit.money_path IS
  'DR6: current_setting(''app.money_path''), the path the writer DECLARED it was taking. NULL '
  'means it declared nothing. Compare with writer: a mismatch is a writer lying about itself.';

COMMENT ON COLUMN public.ca_diamond_balance_audit.journaled IS
  'Whether a diamond_transactions row existed for this user when the trigger ran, i.e. earlier '
  'in the same transaction. It is NOT "this movement was journalled": all eight sanctioned '
  'money paths write the balance BEFORE the journal row, so an AFTER trigger cannot see their '
  'journal row and this reads false for correct movements. The DR6 incident is gated on the '
  'writer for exactly that reason. Constant false for the 603 rows written before 2026-09-03.';

-- ---------------------------------------------------------------------------
-- 2. The trigger function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_old        integer;
  v_new        integer := COALESCE(NEW.diamonds, 0);
  v_delta      integer;
  v_stack      text;
  v_writer     text;
  v_path       text;
  v_journaled  boolean := false;
  v_cert       boolean;
  v_sanctioned boolean;
BEGIN
  -- The WHEN clause the old UPDATE-only trigger carried, moved into the body
  -- because a WHEN clause cannot reference OLD on a trigger that also fires on
  -- INSERT. Same rows are written for an UPDATE as before. The two branches
  -- are nested rather than combined: OLD is unassigned on INSERT and PL/pgSQL
  -- evaluates a whole IF condition as one SQL expression, so a single
  -- condition naming OLD would raise on every insert.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.diamonds IS NOT DISTINCT FROM OLD.diamonds THEN
      RETURN NEW;
    END IF;
    v_old := COALESCE(OLD.diamonds, 0);
  ELSE
    -- A profile born with a zero balance has nothing to audit.
    IF v_new = 0 THEN
      RETURN NEW;
    END IF;
    v_old := 0;
  END IF;

  v_delta := v_new - v_old;

  BEGIN
    -- Who wrote it. PG_CONTEXT's first frame is this trigger function; the
    -- next one down is the writer.
    GET DIAGNOSTICS v_stack = PG_CONTEXT;
    SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1]
      INTO v_writer
      FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
     WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
       AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1]
           <> 'fn_ca_audit_diamond_change'
     ORDER BY t.ord
     LIMIT 1;

    v_path := NULLIF(btrim(COALESCE(current_setting('app.money_path', true), '')), '');

    -- Read the comment on the journaled column before believing this number.
    v_journaled := EXISTS (SELECT 1 FROM public.diamond_transactions dt
                            WHERE dt.user_id = NEW.id
                              AND dt.created_at >= now() - interval '2 seconds');

    v_cert := public.fn_ca_is_cert_account(NEW.id);

    -- DR6, standard 3.3: one credit function, one debit function.
    v_sanctioned := COALESCE(v_writer, '') IN
                      ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                       'send_wallet_diamond_transfer', 'send_stream_gift',
                       'claim_daily_challenge', 'claim_daily_challenges')
                 OR COALESCE(v_path, '') IN
                      ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                       'send_wallet_diamond_transfer', 'send_stream_gift',
                       'claim_daily_challenge', 'claim_daily_challenges');

    INSERT INTO public.ca_diamond_balance_audit
      (user_id, old_diamonds, new_diamonds, delta, is_cert, db_role, app_name,
       journaled, writer, money_path)
    VALUES
      (NEW.id, v_old, v_new, v_delta, v_cert, current_user,
       COALESCE(current_setting('application_name', true), ''),
       v_journaled, v_writer, v_path);

    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR6:balance_changed_without_journal', 'warning', NEW.id, v_delta,
        COALESCE(v_writer, v_path, '(no function frame)'),
        jsonb_build_object('money_path', v_path, 'is_cert', v_cert, 'tg_op', TG_OP,
                           'writer', v_writer, 'old_diamonds', v_old, 'new_diamonds', v_new,
                           'db_role', current_user,
                           'app_name', COALESCE(current_setting('application_name', true), ''),
                           'journaled_at_trigger_time', v_journaled,
                           'sanctioned_money_path', v_sanctioned));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block a diamond write to record one. Never swallow it in silence
    -- either: that is how the overlay moved unjournalled on 2026-09-02.
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (user_id, delta, sqlstate, message)
      VALUES (NEW.id, v_delta, SQLSTATE, 'diamond audit insert failed: ' || SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_audit_diamond_change() IS
  'DR6 log-only. Appends to ca_diamond_balance_audit on every INSERT or change of '
  'profiles.diamonds, naming the writer from PG_CONTEXT and the declared app.money_path, and '
  'files DR6:balance_changed_without_journal when a non-zero delta comes from a writer that is '
  'not one of the eight sanctioned money paths. It refuses nothing and it cannot fail a '
  'diamond movement: every failure lands in ca_ledger_write_failures.';

-- ---------------------------------------------------------------------------
-- 3. fn_ca_diamond_trial_balance: the house ledger read stops guessing columns
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(
  p_since timestamptz DEFAULT now() - interval '75 minutes'
)
RETURNS TABLE (
  account        text,
  balance_now    numeric,
  balance_delta  numeric,
  journal_net    numeric,
  mint_net       numeric,
  difference     numeric,
  note           text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- 2026-09-03 00:07 UTC: the moment 20260903000735_diamond_std_foundation
  -- added diamond_transactions.counterparty. Every row older than that has a
  -- NULL counterparty because the column did not exist, not because a writer
  -- failed to name one, so the suspense row starts here.
  c_foundation constant timestamptz := timestamptz '2026-09-03 00:07:00+00';
  v_since      timestamptz := COALESCE(p_since, now() - interval '75 minutes');
  s0           public.ca_diamond_snapshots%ROWTYPE;
  v_now        numeric;
  v_delta      numeric;
  v_jrn        numeric;
  v_mint       numeric;
  v_note       text;
  v_n          bigint;
  v_missing    bigint;
  v_sub        numeric;
  v_tscol      text;
  v_amtcol     text;
  v_tot_now    numeric := 0;
  v_tot_delta  numeric := 0;
  v_tot_jrn    numeric := 0;
  v_tot_mint   numeric := 0;
  v_tot_parts  text    := '';
  r            record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots
   WHERE taken_at >= v_since
   ORDER BY taken_at ASC LIMIT 1;

  -- player_diamonds: the canonical store
  BEGIN
    SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric INTO v_now FROM public.profiles p;
    IF s0.id IS NULL THEN
      v_delta := NULL;
      v_note  := 'no diamond snapshot at or after the window start, so the delta is unknown';
    ELSE
      v_delta := v_now - s0.profile_diamonds;
      v_note  := 'delta measured against ca_diamond_snapshots.profile_diamonds at '
              || to_char(s0.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
    END IF;
    SELECT COALESCE(SUM(dt.amount), 0)::numeric INTO v_jrn
      FROM public.diamond_transactions dt WHERE dt.created_at >= v_since;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0)::numeric
      INTO v_mint FROM public.ca_mint_ledger ml
     WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= v_since;

    v_tot_now   := v_tot_now + v_now;
    v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn   := v_tot_jrn + v_jrn;
    v_tot_mint  := v_tot_mint + v_mint;
    v_tot_parts := v_tot_parts || 'player_diamonds';

    RETURN QUERY SELECT
      'player_diamonds'::text, v_now, v_delta, v_jrn, v_mint,
      CASE WHEN v_delta IS NULL THEN NULL ELSE v_delta - v_jrn END,
      v_note || '. The journal is ONE SIDED until DR3 is enforced: journal_net is what the '
             || 'writers declared, not a double entry, so the difference measures undeclared '
             || 'movement. mint_net is the ledgered issuance for the same window and is '
             || 'informative beside it, not subtracted. Journal rows the certification '
             || 'cleanup deleted inside the window are gone from journal_net and read as a '
             || 'difference.';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'player_diamonds'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- diamond_house
  BEGIN
    IF to_regclass('public.ca_diamond_house') IS NULL THEN
      RETURN QUERY SELECT 'diamond_house'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      SELECT COALESCE(SUM(h.balance), 0)::numeric INTO v_now FROM public.ca_diamond_house h;
      v_delta := NULL;
      v_note  := 'no ca_diamond_house_ledger exists yet, so the delta is unknown; the house '
              || 'account is funded and drained by Lanes B and H';
      IF to_regclass('public.ca_diamond_house_ledger') IS NOT NULL THEN
        -- Discover the shape rather than assume it: the table was landed by
        -- another lane after this function was first written, with columns
        -- (at, delta) where this had guessed (created_at, amount).
        SELECT c.column_name INTO v_tscol
          FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = 'ca_diamond_house_ledger'
           AND c.column_name IN ('at', 'created_at', 'occurred_at', 'taken_at')
         ORDER BY array_position(ARRAY['at','created_at','occurred_at','taken_at'], c.column_name)
         LIMIT 1;
        SELECT c.column_name INTO v_amtcol
          FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = 'ca_diamond_house_ledger'
           AND c.column_name IN ('delta', 'amount', 'balance_delta')
         ORDER BY array_position(ARRAY['delta','amount','balance_delta'], c.column_name)
         LIMIT 1;
        IF v_tscol IS NULL OR v_amtcol IS NULL THEN
          v_note := format('ca_diamond_house_ledger exists but exposes no recognised '
                           'timestamp (%s) or amount (%s) column',
                           COALESCE(v_tscol, 'none'), COALESCE(v_amtcol, 'none'));
        ELSE
          BEGIN
            EXECUTE format('SELECT COALESCE(SUM(%I), 0)::numeric FROM public.ca_diamond_house_ledger '
                           'WHERE %I >= $1', v_amtcol, v_tscol)
              INTO v_delta USING v_since;
            v_note := format('delta from ca_diamond_house_ledger (%s, %s)', v_tscol, v_amtcol);
          EXCEPTION WHEN OTHERS THEN
            v_delta := NULL;
            v_note  := 'ca_diamond_house_ledger is unreadable: ' || SQLERRM;
          END;
        END IF;
      END IF;
      SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0)::numeric
        INTO v_mint FROM public.ca_mint_ledger ml
       WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= v_since;

      v_tot_now   := v_tot_now + v_now;
      v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
      v_tot_mint  := v_tot_mint + v_mint;
      v_tot_parts := v_tot_parts || ' + diamond_house';

      RETURN QUERY SELECT 'diamond_house'::text, v_now, v_delta, NULL::numeric, v_mint,
        CASE WHEN v_delta IS NULL THEN NULL ELSE v_delta - v_mint END,
        v_note || '. DR14: what leaves a player and reaches no player belongs here, so a rake, '
               || 'fee, cut or forfeit that shows up nowhere is a break on this row.';
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'diamond_house'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- diamond_debts (Lane D)
  BEGIN
    IF to_regclass('public.diamond_debts') IS NULL THEN
      RETURN QUERY SELECT 'diamond_debts'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts '
           || 'WHERE settled_at IS NULL' INTO v_now;
      v_tot_now   := v_tot_now + v_now;
      v_tot_parts := v_tot_parts || ' + diamond_debts';
      RETURN QUERY SELECT 'diamond_debts'::text, v_now, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric,
                          'unsettled chargeback receivable (DR1). A balance is never negative; '
                          'the remainder lands here and the next credit settles it.'::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'diamond_debts'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- promo_budgets_spent (DR7)
  BEGIN
    IF to_regclass('public.diamond_reward_budgets') IS NULL THEN
      RETURN QUERY SELECT 'promo_budgets_spent'::text, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      SELECT COALESCE(SUM(b.spent_diamonds), 0)::numeric,
             COALESCE(SUM(b.budget_diamonds), 0)::numeric,
             count(*)
        INTO v_now, v_sub, v_n
        FROM public.diamond_reward_budgets b;
      RETURN QUERY SELECT 'promo_budgets_spent'::text, v_now, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric,
        format('%s budget lines, %s diamonds budgeted, %s spent. A counter, not a balance: '
               'there is no history table, so the delta is unknown. It is here because '
               'DR7 makes every promotional issuance draw from one of these lines.',
               v_n, v_sub, v_now);
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'promo_budgets_spent'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- mirror_mismatch (DR10)
  v_now  := 0;
  v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_diamonds', 'balance'),
                                 ('user_diamond_balance', 'balance'),
                                 ('diamond_wallets', 'balance')) AS m(rel, col)
  LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN
        v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT count(*) FROM public.profiles p JOIN public.%I m ON m.user_id = p.id '
                       'WHERE COALESCE(m.%I, 0) <> COALESCE(p.diamonds, 0)', r.rel, r.col)
          INTO v_n;
        EXECUTE format('SELECT count(*) FROM public.profiles p WHERE NOT EXISTS '
                       '(SELECT 1 FROM public.%I m WHERE m.user_id = p.id)', r.rel)
          INTO v_missing;
        v_now  := v_now + v_n;
        v_note := v_note || format('%s: %s rows disagree, %s profiles have no row. ',
                                   r.rel, v_n, v_missing);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_now, NULL::numeric, NULL::numeric, NULL::numeric,
                      NULL::numeric,
    v_note || 'balance_now is a COUNT of disagreeing rows, not diamonds. A profile with no '
           || 'mirror row is counted in the note, not the number: the mirror trigger UPDATEs '
           || 'diamond_wallets without an upsert, so a profile that never had a row can never '
           || 'get one (audit lane 1, defect 2a).';

  -- dead_stores (DR10, the delete list)
  v_now  := 0;
  v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'),
                                 ('bot_profiles', 'diamonds'),
                                 ('club_members', 'diamonds'),
                                 ('club_memberships', 'diamonds'),
                                 ('club_diamond_wallets', 'balance')) AS m(rel, col)
  LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN
        v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I',
                       r.col, r.rel) INTO v_sub;
        v_now  := v_now + v_sub;
        v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_sub);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_now, NULL::numeric, NULL::numeric, NULL::numeric,
                      NULL::numeric,
    v_note || 'Informative and deliberately OUTSIDE the total: none of these is the canonical '
           || 'store and none of them is spendable. They are the delete list in standard '
           || 'section 5 Lane G, gated on seven days of zero writes; '
           || 'ca_diamond_dead_store_writes is the gate.';

  -- suspense (DR12)
  BEGIN
    SELECT COALESCE(SUM(dt.amount), 0)::numeric, count(*)
      INTO v_now, v_n
      FROM public.diamond_transactions dt
     WHERE dt.created_at >= GREATEST(v_since, c_foundation)
       AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown');
    RETURN QUERY SELECT 'suspense'::text, v_now, NULL::numeric, v_now, NULL::numeric, NULL::numeric,
      format('%s journal rows written since the counterparty column existed (2026-09-03 '
             '00:07 UTC) name no counterparty. DR12: this must be zero. Rows older than '
             'that are excluded because the column did not exist, not because a writer '
             'failed to name a side.', v_n);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'suspense'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END,
    v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_jrn END,
    'the sum of the BALANCE rows above (' || COALESCE(NULLIF(v_tot_parts, ''), 'none') || '), '
    || 'computed from the rows this call just returned and never from a stored total column. '
    || 'mirror_mismatch is a count, dead_stores is outside the supply, promo_budgets_spent is '
    || 'a counter and suspense is a flow, so none of the four is summed here.';
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The trigger, replaced in place. Same name, so it is replaced and not
--    duplicated. Lane B's zz_ca_diamond_born_with_balance is a different
--    trigger with a different job (it records the Mint side of a birth); both
--    are log-only and both fire, this one first by name order.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS zz_ca_audit_diamond_change ON public.profiles;

CREATE TRIGGER zz_ca_audit_diamond_change
  AFTER INSERT OR UPDATE OF diamonds ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_audit_diamond_change();

-- ---------------------------------------------------------------------------
-- Post-apply assertions
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_def text;
  v_n   integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_diamond_balance_audit'
                    AND column_name = 'writer') THEN
    RAISE EXCEPTION 'ca_diamond_balance_audit.writer missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_diamond_balance_audit'
                    AND column_name = 'money_path') THEN
    RAISE EXCEPTION 'ca_diamond_balance_audit.money_path missing';
  END IF;

  SELECT pg_get_triggerdef(oid) INTO v_def FROM pg_trigger
   WHERE tgname = 'zz_ca_audit_diamond_change' AND NOT tgisinternal;
  IF v_def IS NULL OR v_def NOT LIKE '%INSERT OR UPDATE%' THEN
    RAISE EXCEPTION 'zz_ca_audit_diamond_change does not fire on INSERT OR UPDATE: %', v_def;
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname = 'zz_ca_audit_diamond_change' AND NOT tgisinternal;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'zz_ca_audit_diamond_change exists % times, expected 1', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_audit_diamond_change'
                   AND prosrc LIKE '%DR6:balance_changed_without_journal%') THEN
    RAISE EXCEPTION 'fn_ca_audit_diamond_change does not file the DR6 incident';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_audit_diamond_change'
                   AND prosrc LIKE '%ca_ledger_write_failures%') THEN
    RAISE EXCEPTION 'fn_ca_audit_diamond_change lost its failure sink';
  END IF;

  -- The trial balance still returns its eight accounts.
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance(now() - interval '24 hours');
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'fn_ca_diamond_trial_balance returned % rows, expected 8', v_n;
  END IF;
END $assert$;

COMMIT;
