-- 20260908060643_the_register_lost_a_movement.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- THE REGISTER SERIALISED THE WHOLE ECONOMY BEHIND ONE LOCK, AND STARTED LOSING MOVEMENTS.
-- (CLAUDE.md 10.9, 10.11, 10.12; docs/changelog/2026-09-08-the-register-lost-a-movement.md)
--
-- WHAT WAS OBSERVED. At 05:37 UTC the money identity broke for the first time since the register
-- was built: players held more diamonds than the register recorded. By 05:53 the gap was 2,236
-- and growing every minute. Twenty-four critical MINT:register_follow_failed incidents named
-- twenty-four journal rows, every one with SQLSTATE 55P03, 'canceling statement due to lock
-- timeout', and those twenty-four rows summed to exactly the gap. Nothing had to be assumed:
-- the net built for this on 2026-08 caught it, named the rows, and the arithmetic closed.
--
-- THE CAUSE, AND IT IS MINE. fn_ca_register_diamond_journal_row computed supply_after under
--
--     PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
--
-- An xact-scoped advisory lock is held until the CALLER'S transaction commits - not until the
-- insert finishes. So every diamond movement on the platform took one global lock and held it
-- for the rest of whatever transaction it was part of, and every other player's movement queued
-- behind it. That was survivable while a transaction moved diamonds once. It stopped being
-- survivable at 04:38, when the horse claim went live and a single record_daily_challenge_event
-- began claiming several challenges in one transaction: the first claim took the global lock,
-- the transaction went on working, and everyone else's movement died on lock_timeout.
--
-- The trigger did the right thing with the failure - the diamonds had already moved and the
-- journal row already stood, so it filed a critical incident rather than refusing a player's
-- reward - which is why the damage is twenty-four unrecorded movements rather than twenty-four
-- refused rewards. But the register is the authority on supply, and an authority that drops what
-- it cannot write fast enough is not one.
--
-- THE FIX, AT THE ROOT (10.11): the lock is removed from the follow path.
--
-- An EXACT running total cannot exist on a path that runs thousands of times an hour without
-- serialising the entire economy behind it; that is not a tuning problem, it is what a global
-- running total means. So the honest thing is to stop pretending the column is one.
-- supply_after is an ANNOTATION - nine functions write it, no view and no function reads it, and
-- the platform's authority on supply is and always was fn_ca_mint_supply(), which SUMS the
-- movements. It keeps recording the supply observed as the row was written; under simultaneous
-- movements two rows may each omit the other, and that is now stated in the column's comment
-- rather than bought with an outage.
--
-- What is NOT weakened: every movement still gets a register row, the sum of those rows still
-- equals what players hold, and that identity is asserted at the end of this migration and by
-- the law that ships with it.
--
-- THE DAMAGE IS SETTLED HERE, ONCE, AND THIS IS NOT A REPAIR JOB (10.12). The twenty-four rows
-- are re-registered through the platform's own idempotent path, fn_ca_register_diamond_journal_row,
-- inside this transaction, after the cause is fixed. Nothing scheduled is created; the set is
-- read from the incidents that recorded it, each incident is resolved with what happened, and the
-- migration aborts unless the identity is exact afterwards. If it ever needs doing again, the
-- cause came back and that is the thing to fix.
--
-- Only the rows the register FAILED to follow are replayed. There are 1,198 unregistered journal
-- rows in total going back to February, worth 738,728, and they are unregistered on purpose: the
-- register was seeded from balances, not by replaying history, so replaying them would double
-- every diamond issued before the seed. The incident rows are the evidence of what was lost, and
-- they are the whole of what is restored.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record; v_origin text; v_action text; v_label text; v_actorlb text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO t FROM public.diamond_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = t.id) THEN
    RETURN false;
  END IF;
  v_origin := public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source, t.issuance_class, t.amount);
  IF v_origin IS NULL THEN RETURN false; END IF;

  v_action := CASE WHEN t.amount > 0 THEN 'mint' ELSE 'burn' END;
  v_after  := COALESCE(t.balance_after, 0);
  v_before := v_after - t.amount;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = t.user_id;
  v_label := COALESCE(v_label, t.user_id::text);
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_actorlb FROM public.profiles p WHERE p.id = v_actor;
  v_op := 'diamond-journal:' || v_origin || ':' || t.id::text;
  v_reason := CASE v_action
                WHEN 'mint' THEN 'The Mint issued ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
                ELSE 'The Mint retired ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
              END
              || COALESCE(NULLIF(btrim(t.description), ''), COALESCE(t.transaction_type, t.type, 'diamond movement'));

  -- NO GLOBAL LOCK ON THIS PATH. It used to hold pg_advisory_xact_lock('ca_mint_ledger:diamonds')
  -- to make supply_after an exact running total. An xact-scoped lock is held until the CALLER
  -- commits, so every diamond movement serialised the whole economy behind whatever transaction
  -- happened to be moving diamonds - and on 2026-09-08, once one transaction could claim several
  -- challenges at once, twenty-four movements died on lock_timeout and went unrecorded.
  --
  -- supply_after is therefore the supply OBSERVED as this row was written, not a serialised
  -- running total: two simultaneous movements may each omit the other. Nothing reads it. The
  -- authority on supply is fn_ca_mint_supply(), which sums the movements, and the identity that
  -- matters - that sum equals what players hold - does not depend on this column at all.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  v_supply := v_supply + CASE WHEN v_action = 'mint' THEN abs(t.amount) ELSE -abs(t.amount) END;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  VALUES
    (v_op, v_action, 'diamonds', 'player', t.user_id, v_label, abs(t.amount),
     v_before, v_after, v_supply, v_reason,
     v_actor, v_actorlb, NULL, t.id, COALESCE(t.created_at, now()))
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END $$;

COMMENT ON COLUMN public.ca_mint_ledger.supply_after IS
  'The asset supply OBSERVED as this row was written - an annotation, not a serialised running total. Under simultaneous movements two rows may each omit the other. Making it exact required a global lock held for the caller''s whole transaction, which on 2026-09-08 lost twenty-four movements to lock timeouts. fn_ca_mint_supply(asset) is the authority on supply.';

-- ---------------------------------------------------------------------------
-- Settle the twenty-four, from the evidence that recorded them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_inc record; v_done integer := 0; v_amt numeric := 0; v_drift numeric; v_open integer;
BEGIN
  FOR v_inc IN
    SELECT i.id AS incident_id, (i.detail ->> 'journal_id')::uuid AS journal_id
      FROM public.ca_diamond_incidents i
     WHERE i.rule = 'MINT:register_follow_failed'
       AND i.resolved_at IS NULL
       AND i.detail ->> 'journal_id' IS NOT NULL
     ORDER BY i.occurred_at
  LOOP
    IF EXISTS (SELECT 1 FROM public.diamond_transactions dt WHERE dt.id = v_inc.journal_id)
       AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_inc.journal_id) THEN
      PERFORM public.fn_ca_register_diamond_journal_row(v_inc.journal_id);
      SELECT v_amt + dt.amount INTO v_amt FROM public.diamond_transactions dt WHERE dt.id = v_inc.journal_id;
      v_done := v_done + 1;
    END IF;

    -- This table has no resolution column; the note goes into detail, where every other
    -- explanation on an incident already lives.
    UPDATE public.ca_diamond_incidents
       SET resolved_at = now(),
           detail = detail || jsonb_build_object(
             'resolution',
             'Registered by 2026-09-08 the-register-lost-a-movement. The movement was never in doubt - the diamonds moved and the journal row stood; only the register row was lost, to a lock timeout on the global advisory lock this migration removes. Re-registered through fn_ca_register_diamond_journal_row, the platform''s own idempotent path. No diamonds were created or destroyed.',
             'resolved_by', 'migration:the-register-lost-a-movement')
     WHERE id = v_inc.incident_id;
  END LOOP;

  RAISE NOTICE 'register: re-registered % movement(s) worth %', v_done, v_amt;

  -- The identity, exact. If a fresh movement was lost while this ran, the cause is not yet
  -- committed and this aborts rather than reporting a partial fix as a whole one.
  SELECT (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) - public.fn_ca_mint_supply('diamonds')
    INTO v_drift;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'the register and the players still disagree by % after re-registering %', v_drift, v_done;
  END IF;

  SELECT count(*) INTO v_open
    FROM public.ca_diamond_incidents i
    LEFT JOIN public.ca_mint_ledger m ON m.diamond_tx_id = (i.detail ->> 'journal_id')::uuid
   WHERE i.rule = 'MINT:register_follow_failed' AND i.resolved_at IS NULL AND m.id IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION '% lost movement(s) remain unregistered', v_open;
  END IF;

  -- And the cause is gone from the path that runs thousands of times an hour. THE COMMENTS ARE
  -- STRIPPED FIRST: the body explains what it no longer does, and the first version of this very
  -- check failed on its own explanation - the same "a mention is not a call" mistake this night's
  -- other migration is fixing in fn_ca_diamond_unreachable_money.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_ca_register_diamond_journal_row'
                AND regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') LIKE '%pg_advisory_xact_lock%') THEN
    RAISE EXCEPTION 'the follow path still takes a transaction-scoped global lock';
  END IF;
END $$;

COMMIT;
