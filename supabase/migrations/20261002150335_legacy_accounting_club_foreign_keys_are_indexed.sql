-- 20261002150228_legacy_accounting_club_foreign_keys_are_indexed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Every post-deploy certificate since at least 2026-10-02T09:41Z has stopped at
-- "Prove every club foreign key remains deletable" with:
--
--   A CLUB CANNOT BE DELETED: 2 foreign key(s) into public.clubs would force a
--   sequential scan.
--     accounting_legacy_rakeback_certificates.club_id (1,259 rows)
--     accounting_legacy_settlement_legs.club_id       (139 rows)
--
-- Both tables arrived with the owner-authorized legacy discharge (installed
-- migration 20260926140858) carrying a club_id foreign key into public.clubs
-- and no index that can answer it: production has only their primary keys,
-- the period_id unique key and a unique key that leads on operation_id. A
-- non-leading column cannot serve a foreign key lookup, so every DELETE FROM
-- clubs scans both tables, and fn_ca_fk_index_gaps correctly names them.
--
-- Read-only production measurement at 15:02 UTC on 2026-10-02: certificates
-- 1,236,992 heap bytes (~1,259 rows), settlement legs 65,536 bytes (~139 rows).
-- A plain build inside this short transaction holds its SHARE lock for
-- milliseconds, so no CONCURRENTLY pre-build is needed. lock_timeout makes the
-- migration fail instead of queueing behind a writer.
--
-- Pre-image guard: both constraints exist, are single-column foreign keys from
-- club_id, and reference public.clubs(id). Anything else raises and nothing is
-- built. Post-image guard: each index exists on the right table, is valid, is
-- not partial and leads on club_id, and fn_ca_fk_index_gaps no longer lists
-- either table. No row, balance, constraint, privilege or accounting rule is
-- changed.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $$
DECLARE
  v_table text;
  v_ok boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'accounting_legacy_rakeback_certificates',
    'accounting_legacy_settlement_legs'
  ] LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class ch ON ch.oid = c.conrelid
      JOIN pg_namespace chn ON chn.oid = ch.relnamespace
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.conname = v_table || '_club_id_fkey'
        AND c.contype = 'f'
        AND chn.nspname = 'public'
        AND ch.relname = v_table
        AND c.confrelid = 'public.clubs'::regclass
        AND cardinality(c.conkey) = 1
        AND cardinality(c.confkey) = 1
        AND ca.attname = 'club_id'
        AND pa.attname = 'id'
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION
        'LEGACY_CLUB_FK_INDEX: pre-image refused, %_club_id_fkey is not a single-column foreign key from public.%(club_id) to public.clubs(id)',
        v_table, v_table;
    END IF;
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_accounting_legacy_rakeback_certificates_club_id_fk
  ON public.accounting_legacy_rakeback_certificates (club_id);
CREATE INDEX IF NOT EXISTS idx_accounting_legacy_settlement_legs_club_id_fk
  ON public.accounting_legacy_settlement_legs (club_id);

DO $$
DECLARE
  v_pair text[];
  v_ok boolean;
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['accounting_legacy_rakeback_certificates', 'idx_accounting_legacy_rakeback_certificates_club_id_fk'],
    ARRAY['accounting_legacy_settlement_legs', 'idx_accounting_legacy_settlement_legs_club_id_fk']
  ] LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace icn ON icn.oid = ic.relnamespace
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE icn.nspname = 'public'
        AND ic.relname = v_pair[2]
        AND i.indrelid = ('public.' || v_pair[1])::regclass
        AND i.indisvalid
        AND i.indpred IS NULL
        AND a.attname = 'club_id'
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION
        'LEGACY_CLUB_FK_INDEX: post-image refused, % on public.% is missing, invalid, partial or does not lead on club_id',
        v_pair[2], v_pair[1];
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.fn_ca_fk_index_gaps('public.clubs')->'gaps') AS gap
    WHERE gap->>'child_table' IN (
      'accounting_legacy_rakeback_certificates', 'accounting_legacy_settlement_legs'
    )
  ) THEN
    RAISE EXCEPTION 'LEGACY_CLUB_FK_INDEX: fn_ca_fk_index_gaps still lists a legacy accounting club foreign key';
  END IF;
END;
$$;

COMMIT;
