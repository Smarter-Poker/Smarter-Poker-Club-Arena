-- ZERO-DRIFT phase 3F (prod 2026-08-31 ~19:16 UTC): wire the financial-
-- closure precheck into fn_delete_user_gdpr. An account that still holds or
-- is owed chips (balances, seats, pending rakeback, outstanding tickets,
-- agent balances/credit) is refused with the full blocker list instead of
-- being half-anonymized. Idempotent dynamic patch: no-op if already wired.
DO $$
DECLARE v_def text; v_new text; v_anchor text;
BEGIN
  v_def := pg_get_functiondef('public.fn_delete_user_gdpr(uuid,uuid,text)'::regprocedure);
  IF v_def LIKE '%fn_ca_gdpr_financial_precheck%' THEN
    RETURN; -- already wired
  END IF;
  v_anchor := '  INSERT INTO public.gdpr_deletion_requests';
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'gdpr wire: anchor not unique — refusing to patch blind';
  END IF;
  v_new := replace(v_def, v_anchor,
    '  -- ZERO-DRIFT phase 3: financial closure precheck — refuse to anonymize' || E'\n' ||
    '  -- an account that still holds or is owed chips (blockers returned).' || E'\n' ||
    '  IF NOT COALESCE((public.fn_ca_gdpr_financial_precheck(p_user_id)->>''clear'')::boolean, false) THEN' || E'\n' ||
    '    RETURN jsonb_build_object(''success'', false, ''error'', ''financial_precheck_failed'',' || E'\n' ||
    '      ''precheck'', public.fn_ca_gdpr_financial_precheck(p_user_id));' || E'\n' ||
    '  END IF;' || E'\n\n' || v_anchor);
  EXECUTE v_new;
END $$;
