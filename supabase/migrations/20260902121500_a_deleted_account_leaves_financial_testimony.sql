-- ═══════════════════════════════════════════════════════════════════════════
--  A DELETED ACCOUNT LEAVES FINANCIAL TESTIMONY (issue #2613, ask 3)
-- ═══════════════════════════════════════════════════════════════════════════
-- On 2026-09-02, 1,259,900 non-cert diamonds left profiles.diamonds in one
-- hourly interval and the writer could not be named from surviving state:
-- deletions cascade their own journals away, and profiles had no deletion
-- record of any kind. Four hours of engine deploys were lost to a mystery
-- that this table would have answered in one SELECT.
--
-- ca_diamond_balance_audit (added the same night) records every UPDATE to a
-- profile's diamonds. This closes the other door: every DELETE of a profiles
-- row appends who vanished, holding what, removed by which role and which
-- application. Same shape and same philosophy as ca_seat_stack_exits
-- (CLAUDE.md 11.5): the trigger NEVER blocks - a deletion the audit cannot
-- record still proceeds, loudly, because a guard that can refuse a deletion
-- can break account-removal flows that legitimately cascade from auth.users.
--
-- HORSES ARE PLAYERS (10.5): is_horse is captured as DATA - a horse deletion
-- is recorded exactly like a human one, never filtered.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_profile_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL,
  username text,
  is_horse boolean,
  diamonds numeric,
  diamond_balance numeric,
  profile_created_at timestamptz,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by_role text NOT NULL DEFAULT current_user,
  application_name text NOT NULL DEFAULT COALESCE(current_setting('application_name', true), '')
);

COMMENT ON TABLE public.ca_profile_deletions IS
  'Append-only testimony for every deleted profiles row: identity, diamond holdings, db role and application that removed it. Written by trg_ca_profile_deletion_journal (never blocks). Exists because the 2026-09-02 1,259,900-diamond deletion mystery had no witness (issue #2613).';

ALTER TABLE public.ca_profile_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_profile_deletions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ca_profile_deletions TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_journal_profile_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    INSERT INTO public.ca_profile_deletions
      (profile_id, username, is_horse, diamonds, diamond_balance, profile_created_at)
    VALUES
      (OLD.id, OLD.username, OLD.is_horse, OLD.diamonds, OLD.diamond_balance, OLD.created_at);
  EXCEPTION WHEN OTHERS THEN
    -- LOUD, NEVER BLOCKING (the ca_seat_stack_exits rule): an audit failure
    -- must not refuse an account deletion that GoTrue or a cleanup RPC is
    -- mid-way through. The warning lands in the postgres log, which is
    -- exactly where the 2026-09-02 hunt went looking and found nothing.
    RAISE WARNING 'ca_profile_deletions could not record deletion of % (%): %',
      OLD.id, OLD.username, SQLERRM;
  END;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_journal_profile_deletion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_profile_deletion_journal ON public.profiles;
CREATE TRIGGER trg_ca_profile_deletion_journal
BEFORE DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_profile_deletion();

COMMIT;
