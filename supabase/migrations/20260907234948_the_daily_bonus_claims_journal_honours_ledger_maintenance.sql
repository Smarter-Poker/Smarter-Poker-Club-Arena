-- ca_daily_bonus_claims is append-only, and its FK to profiles / days
-- cascades on delete. Without a maintenance door the account deletion path
-- (fn_delete_user_gdpr) would be refused by this trigger. Every other journal
-- on the platform opens for `app.ledger_maintenance` (fn_ca_journal_append_only);
-- this one now does the same, and records why.
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claims_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  IF v_reason IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ca_daily_bonus_claims is append-only (% refused)', TG_OP
    USING ERRCODE = '55000',
          HINT = 'Account deletion and repairs set app.ledger_maintenance to a reason first.';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claims_append_only() FROM PUBLIC, anon, authenticated;
