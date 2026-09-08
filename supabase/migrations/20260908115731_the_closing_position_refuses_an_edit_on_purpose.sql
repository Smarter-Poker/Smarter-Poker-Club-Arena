/* A GUARD THAT REFUSES FOR THE WRONG REASON IS NOT A GUARD.

   `ca_epoch_closing_positions` was given `fn_ca_journal_append_only`, the guard
   phase 8 put on the other journals. Probed immediately after applying it, an
   UPDATE was indeed refused - but with `record "new" has no field "amount"`.
   That guard reads NEW.amount, and this table's money column is `balance`.

   So the refusal was an accident of a missing field, not the guard's judgement.
   It works today, tells an operator nothing, and stops working the moment
   somebody adds an `amount` column or the shared guard is rewritten. DELETE was
   refused properly ('forbidden: financial'), which is what made the asymmetry
   visible.

   A closing position is stricter than a journal anyway: a journal has
   legitimate movements (a settled_at stamped once, a payout's own bookkeeping),
   and this has none. It is a photograph of a moment that has passed. So it gets
   its own guard that refuses UPDATE, DELETE and TRUNCATE outright, on purpose,
   and says why. */

CREATE OR REPLACE FUNCTION public.fn_ca_closing_position_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION
    '% on ca_epoch_closing_positions is forbidden: a closing position is the only evidence of what every account held before an epoch reset, and it is kept seven years under docs/CHIP-JOURNAL-RETENTION-POLICY.md. Correct it forward with a new capture; never edit it.',
    TG_OP
    USING ERRCODE = 'P0403',
          HINT = 'CLAUDE.md 10.9: correct it forward, with a row that says what changed. Never edit history quiet.';
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_closing_position_is_immutable() IS
  'Refuses every UPDATE, DELETE and TRUNCATE on ca_epoch_closing_positions with a message that says why. Replaces fn_ca_journal_append_only there, which refused an UPDATE only by accident - it reads NEW.amount and that table names its money column balance.';

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.ca_epoch_closing_positions;
DROP TRIGGER IF EXISTS trg_ca_closing_position_immutable ON public.ca_epoch_closing_positions;
CREATE TRIGGER trg_ca_closing_position_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_epoch_closing_positions
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_closing_position_is_immutable();

REVOKE ALL ON FUNCTION public.fn_ca_closing_position_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
