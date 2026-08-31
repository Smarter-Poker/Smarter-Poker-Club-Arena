-- Every standalone club opens with a real, auditable 100,000-chip Club Bank.
-- This belongs at the clubs INSERT boundary, not in the browser: direct admin
-- creation and fn_create_club_atomic must obey the same rule, and a failed
-- ledger write must roll back the club instead of leaving an unexplained mint.

ALTER TABLE public.clubs
  ALTER COLUMN chip_treasury SET DEFAULT 100000;

CREATE OR REPLACE FUNCTION public.fn_seed_new_club_opening_bank()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- A union's house row is infrastructure, not a newly opened player club.
  -- It is funded through the union wallet paths and must not mint a club float.
  IF COALESCE(NEW.is_union, false) THEN
    RETURN NEW;
  END IF;

  NEW.chip_treasury := 100000;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_record_new_club_opening_bank()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_union, false) OR COALESCE(NEW.chip_treasury, 0) <> 100000 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.chip_transactions (
    club_id, amount, transaction_type, notes, balance_after, metadata
  ) VALUES (
    NEW.id,
    100000,
    'club_opening_grant',
    'New Club Opening Bank',
    100000,
    jsonb_build_object(
      'source', 'system',
      'destination', 'club_bank',
      'club_owner_id', NEW.owner_id,
      'club_code', NEW.club_id,
      'opening_balance', 100000
    )
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_seed_new_club_opening_bank ON public.clubs;
CREATE TRIGGER trg_seed_new_club_opening_bank
  BEFORE INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_seed_new_club_opening_bank();

DROP TRIGGER IF EXISTS trg_record_new_club_opening_bank ON public.clubs;
CREATE TRIGGER trg_record_new_club_opening_bank
  AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_record_new_club_opening_bank();

COMMENT ON FUNCTION public.fn_seed_new_club_opening_bank() IS
  'Sets every newly opened standalone club Club Bank to exactly 100,000 chips at the authoritative INSERT boundary.';
COMMENT ON FUNCTION public.fn_record_new_club_opening_bank() IS
  'Writes the immutable opening Club Bank grant ledger row in the same transaction as club creation.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.clubs'::regclass
       AND tgname = 'trg_seed_new_club_opening_bank'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'New Club opening bank seed trigger was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.clubs'::regclass
       AND tgname = 'trg_record_new_club_opening_bank'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'New Club opening bank ledger trigger was not installed';
  END IF;
END;
$verify$;
