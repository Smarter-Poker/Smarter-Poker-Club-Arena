-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831200942; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_opening_bank_is_a_mint (prod 20260831200942). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5: New Club Opening Bank (#2311) declares mint vs issuance_reserve - caught as suspense by the regression watchdog 20 minutes after shipping.

-- ZERO-DRIFT phase 5: the suspense-regression watchdog caught tonight's New
-- Club Opening Bank (#2311) within 20 minutes of it shipping — the seed
-- trigger sets chip_treasury := 100000 on club creation with no ledger
-- declaration, so each opening float journaled as unclassified suspense.
-- An opening bank is chip ISSUANCE: it now declares 'mint' vs
-- issuance_reserve before the row lands, so every new club's float is a
-- clean mint row. Behavior (the 100K float itself) unchanged.
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

  -- ZERO-DRIFT phase 5: the opening float is chip issuance — journal it as
  -- a mint against the issuance reserve, not unclassified suspense.
  PERFORM set_config('app.ledger_category', 'mint', true);
  PERFORM set_config('app.ledger_counterparty', 'issuance_reserve', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  NEW.chip_treasury := 100000;
  RETURN NEW;
END;
$function$;

INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_seed_new_club_opening_bank', 'phase 5: opening bank declares mint vs issuance_reserve'),
       ('fn_record_new_club_opening_bank', 'audited 2026-08-31: opening-bank companion (no GUC needed if it only records)')
ON CONFLICT (proname) DO NOTHING;
