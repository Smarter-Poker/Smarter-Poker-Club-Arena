-- The tournament manager selects tournament_launch_receipts.supply_version
-- before choosing the legacy launch protocol or the pending conserved-supply
-- protocol. Production had no such column, so the capability check depended
-- on PostgREST returning one particular 42703 error. That made the committed
-- caller a phantom-column violation and made schema-cache wording part of the
-- launch contract.
--
-- Make the pre-activation state explicit: every existing and new receipt is
-- version 0, and a validated constraint makes version 1 impossible. This is
-- intentionally not the chip-supply activation. The staged activation drops
-- this named constraint, installs its 0-or-1 replacement, and only then changes
-- the default for newly snapshotted launches to 1. No wallet, stack, seat,
-- receipt, grant, trigger, scheduled job, or historical value is repaired here.

DO $preconditions$
DECLARE
  v_type text;
  v_not_null boolean;
  v_default text;
BEGIN
  IF to_regclass('public.tournament_launch_receipts') IS NULL THEN
    RAISE EXCEPTION 'tournament_launch_receipts is required before sealing supply_version';
  END IF;

  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod),
         a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.tournament_launch_receipts'::regclass
     AND a.attname = 'supply_version'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF FOUND AND (
       v_type IS DISTINCT FROM 'smallint'
       OR v_not_null IS DISTINCT FROM true
       OR regexp_replace(coalesce(v_default, ''), '::smallint', '', 'g') IS DISTINCT FROM '0'
  ) THEN
    RAISE EXCEPTION
      'existing tournament_launch_receipts.supply_version is not the sealed smallint NOT NULL DEFAULT 0 capability';
  END IF;
END;
$preconditions$;

ALTER TABLE public.tournament_launch_receipts
  ADD COLUMN IF NOT EXISTS supply_version smallint NOT NULL DEFAULT 0;

DO $install_zero_only_constraint$
DECLARE
  v_expression text;
BEGIN
  SELECT regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
    INTO v_expression
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tournament_launch_receipts'::regclass
     AND c.conname = 'tournament_launch_receipts_supply_version_check';

  IF FOUND AND v_expression IS DISTINCT FROM '(supply_version=0)' THEN
    RAISE EXCEPTION
      'tournament_launch_receipts_supply_version_check already has incompatible semantics: %',
      v_expression;
  END IF;

  IF NOT FOUND THEN
    ALTER TABLE public.tournament_launch_receipts
      ADD CONSTRAINT tournament_launch_receipts_supply_version_check
      CHECK (supply_version = 0) NOT VALID;
  END IF;
END;
$install_zero_only_constraint$;

ALTER TABLE public.tournament_launch_receipts
  VALIDATE CONSTRAINT tournament_launch_receipts_supply_version_check;

COMMENT ON COLUMN public.tournament_launch_receipts.supply_version IS
  'Launch chip-supply protocol: sealed to 0 until the conserved-supply activation transaction installs version 1.';

DO $postconditions$
DECLARE
  v_invalid bigint;
  v_validated boolean;
BEGIN
  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_launch_receipts
   WHERE supply_version IS DISTINCT FROM 0;

  SELECT c.convalidated
    INTO v_validated
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tournament_launch_receipts'::regclass
     AND c.conname = 'tournament_launch_receipts_supply_version_check'
     AND regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g') =
       '(supply_version=0)';

  IF v_invalid <> 0 OR v_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'supply_version zero-only seal did not verify: invalid_rows=%, validated=%',
      v_invalid,
      v_validated;
  END IF;
END;
$postconditions$;
