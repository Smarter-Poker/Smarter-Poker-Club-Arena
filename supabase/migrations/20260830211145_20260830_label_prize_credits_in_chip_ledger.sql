-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211145; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Prize payouts landed in chip_ledger as unlabelled 'adjustment' rows.
--
-- fn_club_members_ledger_writer already records EVERY club_members.chip_balance
-- delta, and it already lets a caller name the movement:
--
--     PERFORM set_config('app.ledger_category','buyin',true);
--
-- with its own comment noting that anything unnamed is 'adjustment' — "honest
-- about the fact that we saw the money move but were not told why". The prize
-- path never named itself, so every tournament payout on the platform was
-- filed as an anonymous adjustment with no link to the tournament that caused
-- it, even though chip_ledger carries a tournament_id column.
--
-- That cost real time on 2026-08-30. Reversing the 20,880 paid by a tournament
-- that never finished meant identifying nine credits across two clubs, and the
-- only usable handle was matching a description string
-- ('auto-audited club_members.chip_balance delta %') against
-- tournament_players.prize. club_members.updated_at was NOT usable — one
-- player had two rows touched in the same second for a single credit, so
-- matching on it would have debited the wrong club.
--
-- Two additive changes, no behaviour removed:
--
--   1. the writer reads an OPTIONAL app.ledger_tournament and stamps
--      tournament_id. Absent or unparseable leaves it NULL, exactly as today.
--   2. fn_credit_and_log names the category it was already given, and passes
--      the related entity as the tournament. Every credit through it —
--      prizes, refunds, rakeback — stops being an anonymous adjustment.
--
-- This cannot double-count. The trigger is the sole writer of these rows; this
-- only changes what they are LABELLED, never how many there are. set_config is
-- transaction-local (is_local => true), so nothing leaks between statements.

-- 1. The writer learns to record which tournament moved the money.
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
BEGIN
  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  -- amount > 0 is a CHECK constraint on chip_ledger, and a no-op is not a
  -- movement worth recording.
  IF d = 0 THEN
    RETURN NEW;
  END IF;

  BEGIN
    /* performed_by is NOT NULL with an FK to auth.users. Engine and cron
       writes have no auth.uid(), so they are attributed to the smarterpoker
       system principal -- the same one the 2026-04-19 reconcile used. */
    actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    /* Callers may name the movement:
         PERFORM set_config('app.ledger_category','buyin',true);
       Anything that does not is recorded as 'adjustment' -- honest about the
       fact that we saw the money move but were not told why. */
    cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

    /* And which tournament it belonged to, when the caller knows:
         PERFORM set_config('app.ledger_tournament', t_id::text, true);
       Optional and fail-soft: an absent or unparseable value leaves
       tournament_id NULL, which is what every row carried before this. A bad
       setting must never cost somebody their credit. */
    BEGIN
      tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      tid := NULL;
    END;

    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet'  END,
      CASE WHEN d > 0 THEN NEW.club_id     ELSE NEW.user_id      END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury'  END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE NEW.club_id      END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures
        (club_id, user_id, delta, sqlstate, message)
      VALUES (NEW.club_id, NEW.user_id, d, st, msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- even the failure log must not be able to block the money.
    END;
  END;

  RETURN NEW;
END;
$fn$;

-- 2. The credit path names itself, so the trigger has something to record.
CREATE OR REPLACE FUNCTION public.fn_credit_and_log(
  p_user_id           uuid,
  p_amount            numeric,
  p_idempotency_key   text,
  p_category          text,
  p_description       text,
  p_related_entity_id uuid  DEFAULT NULL,
  p_wallet_type       text  DEFAULT 'PLAYER',
  p_table_id          uuid  DEFAULT NULL,
  p_hand_id           uuid  DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_credited boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key';
  END IF;

  /* Name the movement for fn_club_members_ledger_writer BEFORE the balance
     changes — the trigger reads these while the UPDATE runs. Transaction-local,
     so nothing leaks past this statement. */
  PERFORM set_config('app.ledger_category', COALESCE(NULLIF(p_category, ''), 'adjustment'), true);
  IF p_related_entity_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_tournament', p_related_entity_id::text, true);
  END IF;

  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);

  /* Clear it so a later, unrelated balance change in the same transaction is
     not mislabelled as this one. */
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_tournament', '', true);

  IF NOT v_credited THEN
    RETURN false;
  END IF;

  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);

  RETURN true;
END;
$fn$;
