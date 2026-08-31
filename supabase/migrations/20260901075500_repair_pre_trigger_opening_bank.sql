-- Deep Stack Society was created during the short interval between the Club
-- Arena UI release and installation of trg_seed_new_club_opening_bank. The UI
-- initially held the promised 100,000 from its creation flow, then the first
-- authoritative refresh correctly repainted the stored zero. Repair that one
-- known pre-trigger club at the ledger boundary and make future opening grants
-- identify their source as system_mint in the canonical chip ledger.

CREATE OR REPLACE FUNCTION public.fn_seed_new_club_opening_bank()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_union, false) THEN
    RETURN NEW;
  END IF;

  NEW.chip_treasury := 100000;
  PERFORM set_config('app.ledger_category', 'mint', true);
  PERFORM set_config('app.ledger_counterparty', 'system_mint', true);
  PERFORM set_config('app.ledger_idempotency_key', 'club-opening-grant:' || NEW.id::text, true);
  RETURN NEW;
END;
$function$;

DO $repair$
DECLARE
  v_club public.clubs%ROWTYPE;
BEGIN
  SELECT * INTO v_club
    FROM public.clubs
   WHERE id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
   FOR UPDATE;

  IF NOT FOUND OR COALESCE(v_club.chip_treasury, 0) <> 0
     OR COALESCE(v_club.is_union, false)
     OR v_club.club_id <> 11192
     OR v_club.name <> 'Deep Stack Society'
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.club_id = v_club.id
          AND l.from_type = 'club_treasury'
     )
  THEN
    RETURN;
  END IF;

  PERFORM set_config('app.ledger_category', 'mint', true);
  PERFORM set_config('app.ledger_counterparty', 'system_mint', true);
  PERFORM set_config(
    'app.ledger_idempotency_key',
    'club-opening-grant:' || v_club.id::text,
    true
  );

  UPDATE public.clubs
     SET chip_treasury = 100000
   WHERE id = v_club.id
     AND COALESCE(chip_treasury, 0) = 0;

  INSERT INTO public.chip_transactions (
    club_id, amount, transaction_type, notes, balance_after, metadata
  )
  SELECT
    v_club.id,
    100000,
    'club_opening_grant',
    'New Club Opening Bank — Pre-Trigger Repair',
    100000,
    jsonb_build_object(
      'source', 'system',
      'destination', 'club_bank',
      'club_owner_id', v_club.owner_id,
      'club_code', v_club.club_id,
      'opening_balance', 100000,
      'repair', 'pre_trigger_release_window'
    )
  WHERE NOT EXISTS (
    SELECT 1 FROM public.chip_transactions t
     WHERE t.club_id = v_club.id
       AND t.transaction_type = 'club_opening_grant'
  );
END;
$repair$;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.clubs
     WHERE id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
       AND COALESCE(chip_treasury, 0) <> 100000
  ) THEN
    RAISE EXCEPTION 'Deep Stack Society opening Club Bank repair did not commit';
  END IF;
END;
$verify$;

COMMENT ON FUNCTION public.fn_seed_new_club_opening_bank() IS
  'Sets each new standalone Club Bank to 100,000 and labels its canonical chip-ledger source as system_mint.';
