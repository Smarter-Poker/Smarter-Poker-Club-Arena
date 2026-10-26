SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_enforce_whole_dollar_buyin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.buy_in_amount IS DISTINCT FROM OLD.buy_in_amount
     OR NEW.buy_in_fee    IS DISTINCT FROM OLD.buy_in_fee
  THEN
    -- Owner exception, 2026-10-20: the two small Midway fixed-bounty events
    -- are a 5.50 entry (2 bounty + 3 prize contribution + 0.50 fee).
    IF COALESCE(NEW.buy_in_amount, 0) = 5.00
       AND COALESCE(NEW.buy_in_fee, 0) = 0.50
       AND NEW.name IN ('Sunrise Bounty (NLH)', 'Midnight Bounty (NLH)')
       AND upper(COALESCE(NEW.tournament_type, '')) = 'MTT'
       AND NEW.is_bounty IS TRUE
       AND NEW.is_pko IS NOT TRUE
       AND NEW.is_mystery_bounty IS NOT TRUE
       AND (NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
            OR NEW.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid)
    THEN
      RETURN NEW;
    END IF;

    IF (COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
       <> round(COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
    THEN
      RAISE EXCEPTION
        'whole-dollar buy-in rule: buy_in_amount (%) + buy_in_fee (%) must total a whole number - split a whole total via splitBuyIn(), never surcharge the fee on top',
        NEW.buy_in_amount, NEW.buy_in_fee;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DO $assert$
BEGIN
  IF position('Sunrise Bounty (NLH)' IN pg_get_functiondef('public.fn_enforce_whole_dollar_buyin'::regproc)) = 0 THEN
    RAISE EXCEPTION 'fn_enforce_whole_dollar_buyin was not updated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_whole_dollar_buyin'
                  AND tgrelid = 'public.tournaments'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_whole_dollar_buyin is missing';
  END IF;
END
$assert$;
