-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820001645 "unified_chip_ledger_view"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 382f4d9f29cc19a6918b94c720f7223d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNIFIED CHIP LEDGER (2026-08-19)
--
-- THE PROBLEM. Chip movement is recorded in TWO tables that overlap in purpose
-- and disagree in shape:
--
--   wallet_transactions   user_id, type(credit|debit), category, amount,
--                         table_id, hand_id
--   chip_transactions     club_id, from_user_id, to_user_id, amount,
--                         transaction_type, table_id (added today), metadata
--
-- A table cash-out lands in BOTH, via different paths, and the two sets do not
-- overlap — verified when building the union P&L, which had to read both and
-- FULL OUTER JOIN them to get one honest number. Every future reader faces the
-- same trap, and the ones that only checked a single ledger were wrong.
--
-- WHY A VIEW AND NOT A MIGRATION. Consolidating into one physical ledger means
-- rewriting every writer across three repos and the engine, with a backfill
-- over millions of rows, and no way to stage it. That is a project, and doing
-- it badly on a live money system is worse than not doing it. A view gives
-- readers ONE honest surface today, costs nothing, breaks nothing, and is the
-- natural seam to migrate behind later — new readers target the view, and when
-- the physical consolidation happens the view keeps its contract.
--
-- Direction is normalised so callers stop re-deriving it: `signed_amount` is
-- positive when chips move TO the subject and negative when they move away.
-- ============================================================================

CREATE OR REPLACE VIEW v_chip_ledger AS
  -- Wallet ledger: player-centric, already signed by `type`.
  SELECT
    wt.id,
    'wallet_transactions'::text            AS source_ledger,
    wt.created_at,
    wt.user_id                             AS subject_user_id,
    NULL::uuid                             AS counterparty_user_id,
    NULL::uuid                             AS club_id,
    wt.table_id,
    wt.category                            AS kind,
    wt.amount                              AS amount,
    CASE WHEN wt.type = 'credit' THEN wt.amount ELSE -wt.amount END AS signed_amount,
    wt.type                                AS direction,
    wt.description                         AS notes,
    NULL::jsonb                            AS metadata
  FROM wallet_transactions wt

  UNION ALL

  -- Chip ledger: club-centric, direction implied by which user column is set.
  SELECT
    ct.id,
    'chip_transactions'::text              AS source_ledger,
    ct.created_at,
    COALESCE(ct.to_user_id, ct.from_user_id) AS subject_user_id,
    CASE WHEN ct.to_user_id IS NOT NULL THEN ct.from_user_id ELSE ct.to_user_id END
                                           AS counterparty_user_id,
    ct.club_id,
    ct.table_id,
    ct.transaction_type                    AS kind,
    ct.amount                              AS amount,
    CASE WHEN ct.to_user_id IS NOT NULL THEN ct.amount ELSE -ct.amount END AS signed_amount,
    CASE WHEN ct.to_user_id IS NOT NULL THEN 'credit' ELSE 'debit' END AS direction,
    ct.notes,
    ct.metadata
  FROM chip_transactions ct;

COMMENT ON VIEW v_chip_ledger IS
  'One read surface over BOTH chip ledgers (wallet_transactions + chip_transactions). '
  'A table cash-out appears in both via different paths and the sets do not overlap, so '
  'reading only one ledger gives a wrong answer — the union P&L had to FULL OUTER JOIN '
  'them. Prefer this view for new readers. signed_amount is positive when chips move TO '
  'subject_user_id. Read-only; writers still target the physical tables.';

GRANT SELECT ON v_chip_ledger TO authenticated, service_role;

-- Sanity: the view must return both ledgers and agree with them on totals.
DO $$
DECLARE v_view numeric; v_direct numeric; v_sources int;
BEGIN
  SELECT count(DISTINCT source_ledger) INTO v_sources FROM v_chip_ledger;
  IF v_sources <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: view exposes % ledger(s), expected 2', v_sources;
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_view
    FROM v_chip_ledger WHERE source_ledger = 'chip_transactions';
  SELECT COALESCE(SUM(amount),0) INTO v_direct FROM chip_transactions;
  IF abs(v_view - v_direct) > 0.01 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: chip ledger total drifted (view % vs table %)',
      v_view, v_direct;
  END IF;
END $$;
