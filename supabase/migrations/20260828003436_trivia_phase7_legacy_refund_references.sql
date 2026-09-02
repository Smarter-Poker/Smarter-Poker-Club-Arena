-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828003436; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Close the observability gap left by the already-clawed-back August 2026 PvP
-- refund replay incident. The 488 original credit rows intentionally retained
-- NULL source references after the monetary repair, which makes a current
-- exact-reference audit indistinguishable from an active settlement bug.
BEGIN;

DO $$
DECLARE
    v_unexpected integer;
BEGIN
    SELECT count(*) INTO v_unexpected
      FROM public.diamond_transactions
     WHERE transaction_type = 'pvp_refund'
       AND reference_id IS NULL
       AND NOT (
           created_at >= '2026-08-13 00:00:00+00'::timestamptz
           AND created_at < '2026-08-24 00:00:00+00'::timestamptz
           AND description LIKE 'PvP match abandoned — %diamonds refund'
       );
    IF v_unexpected > 0 THEN
        RAISE EXCEPTION 'refusing legacy reference repair: % unclassified null PvP refunds', v_unexpected;
    END IF;
END $$;

UPDATE public.diamond_transactions
   SET reference_id = 'legacy_pvp_refund_incident_20260823_' || id::text,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'incident', 'trivia-pvp-cleanup null reference_id refund replay',
           'monetary_repair', '20260823_pvp_refund_mint_leak',
           'reference_repair', '20260827235500_trivia_phase7_legacy_refund_references',
           'original_reference_id', NULL
       )
 WHERE transaction_type = 'pvp_refund'
   AND reference_id IS NULL
   AND created_at >= '2026-08-13 00:00:00+00'::timestamptz
   AND created_at < '2026-08-24 00:00:00+00'::timestamptz
   AND description LIKE 'PvP match abandoned — %diamonds refund';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.diamond_transactions
         WHERE transaction_type IN (
             'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
             'pvp_stake', 'pvp_refund', 'pvp_win',
             'tournament_entry', 'tournament_entry_refund',
             'tournament_cancel_refund', 'tournament_prize'
         )
           AND created_at >= now() - interval '30 days'
           AND NULLIF(btrim(reference_id), '') IS NULL
    ) THEN
        RAISE EXCEPTION 'exact-reference repair incomplete';
    END IF;
END $$;

COMMIT;

