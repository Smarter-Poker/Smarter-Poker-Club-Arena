-- fn_ca_quick_reconcile:frozen_pool has paged critical 37 times saying "a money
-- path is writing to the dead public.wallets pool". Nothing was writing to it.
--
-- The pre-freeze rows sum 0.30 below their baseline, and NOT ONE of them has
-- been updated since 2026-08-21 - the newest updated_at in the whole
-- pre-freeze set predates the freeze. A balance that falls with no UPDATE fell
-- because the ROW LEFT. public.wallets carries ON DELETE CASCADE to both
-- profiles and auth.users, and 188 of the 1,711 pre-freeze rows belong to
-- certification accounts, which are created and torn down continuously. Delete
-- one test account and its share of the stranded pool disappears: no UPDATE,
-- no journal row, no trace, and an hourly critical that no amount of hunting
-- for a "money path" would ever have explained.
--
-- So the detector was right that the pool moved and wrong about how, and its
-- suspected_cause sent every reader looking for a writer that does not exist.
--
-- Fix: record what leaves. A BEFORE DELETE trigger books the departing balance
-- into ca_frozen_pool_deletions, and the check compares baseline against
-- (surviving rows + recorded departures). An attributable teardown then nets to
-- zero and pages nobody, while an unrecorded change still pages exactly as
-- before - detection is preserved, not weakened.
--
-- The trigger NEVER blocks. Refusing the delete would abort the account
-- teardown that owns the transaction, which is a far worse failure than a
-- drifting count on a pool nothing reads.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_frozen_pool_deletions (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  pool            text NOT NULL DEFAULT 'public.wallets',
  wallet_id       uuid,
  user_id         uuid,
  wallet_type     text,
  deleted_balance numeric NOT NULL,
  row_created_at  timestamptz,
  db_role         text,
  app_name        text,
  reconstructed   boolean NOT NULL DEFAULT false,
  note            text
);

CREATE INDEX IF NOT EXISTS ca_frozen_pool_deletions_at_idx
  ON public.ca_frozen_pool_deletions (occurred_at DESC);

ALTER TABLE public.ca_frozen_pool_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_frozen_pool_deletions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_frozen_pool_deletions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_frozen_pool_deletions_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_record_frozen_pool_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.created_at < '2026-08-22' THEN
    BEGIN
      INSERT INTO public.ca_frozen_pool_deletions
        (wallet_id, user_id, wallet_type, deleted_balance, row_created_at,
         db_role, app_name, note)
      VALUES
        (OLD.id, OLD.user_id, OLD.wallet_type, COALESCE(OLD.balance,0), OLD.created_at,
         current_user, COALESCE(current_setting('application_name', true), ''),
         'pre-freeze wallet row deleted (cascade or direct)');
    EXCEPTION WHEN OTHERS THEN
      -- Never block an account teardown to record it.
      NULL;
    END;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS zz_ca_record_frozen_pool_deletion ON public.wallets;
CREATE TRIGGER zz_ca_record_frozen_pool_deletion
  BEFORE DELETE ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_record_frozen_pool_deletion();

-- The 0.30 that already left carries no record, because nothing was watching
-- when it went. Seeded explicitly and flagged reconstructed=true so nobody
-- mistakes it for an observation.
INSERT INTO public.ca_frozen_pool_deletions
  (deleted_balance, reconstructed, note)
SELECT 0.30, true,
       'reconstructed: pre-freeze rows sum 0.30 under baseline with zero post-freeze updates; attributed to a cascaded account teardown before the recording trigger existed'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ca_frozen_pool_deletions WHERE reconstructed
);

COMMIT;
