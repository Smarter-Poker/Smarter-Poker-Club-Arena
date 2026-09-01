-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING ROUND 2, PHASE 5A: the declaration primitive.
-- Every money path today declares its ledger identity with raw set_config
-- calls - and an unknown word is only discovered LATER, as a silent suspense
-- fallback (the club-opening and spin-margin bugs). fn_ca_declare_ledger is
-- the one audited way to declare a movement: it validates category and
-- counterparty against the ledger vocabulary AT THE CALL SITE (reading the
-- live CHECK constraints, so it can never lag them) and raises immediately
-- on an unknown word. Two live movers adopt it as the reference pattern.
-- This is the first step of the long-term plan: one primitive, one place to
-- be correct, with the full caller migration scheduled after the reopen.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(
  p_category text,
  p_counterparty text,
  p_counterparty_entity uuid DEFAULT NULL,
  p_settlement_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_autoskip_tables text[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_declare_ledger(text, text, uuid, uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_ledger(text, text, uuid, uuid, text, text[]) TO service_role;

-- reference adopter 1: the spin margin mover
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := 'PERFORM set_config(''app.ledger_category'',
                     CASE WHEN p_delta >= 0 THEN ''rake'' ELSE ''overlay'' END, true);
  PERFORM set_config(''app.ledger_counterparty'', ''spin_reserve'', true);
  PERFORM set_config(''app.ledger_counterparty_entity'', '''', true);';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_spin_move_owner_wallet';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt <> 1 THEN RAISE EXCEPTION 'spin adopter anchor matched % times', cnt; END IF;
  src := replace(src, anchor,
    'PERFORM public.fn_ca_declare_ledger(
    CASE WHEN p_delta >= 0 THEN ''rake'' ELSE ''overlay'' END, ''spin_reserve'');');
  EXECUTE src;
END $do$;

-- reference adopter 2: the club opening seed trigger
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
  PERFORM public.fn_ca_declare_ledger(
    'mint', 'system_mint', NULL, NULL,
    'club-opening-grant:' || NEW.id::text || ':' || extract(epoch from clock_timestamp())::bigint::text);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_seed_new_club_opening_bank() FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT 'fn_ca_declare_ledger', 'approved',
       'Hardening round 2 phase 5 (2026-09-01): THE audited ledger declaration primitive - validates category/counterparty against the live CHECK vocabulary at the call site and raises on unknown words instead of letting flows fall to suspense later. Adoption plan: all movers migrate post-reopen.'
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_ca_declare_ledger');
