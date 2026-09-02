-- ============================================================================
-- APPLIED TO PRODUCTION 2026-08-25 via Supabase MCP apply_migration, at Dan's
-- explicit instruction after review. Recorded in
-- supabase_migrations.schema_migrations as
-- 20260825_perf_rakeback_stats_batch_set_based.
-- ============================================================================
--
-- VERIFIED IN PRODUCTION BEFORE AND AFTER APPLYING. Both tests ran inside a
-- DO block terminated by RAISE EXCEPTION, so the whole transaction rolled back
-- and nothing persisted; ledger row count and sum(player_stats.total_rake)
-- were confirmed identical to baseline afterwards (drift 0 and 0.00).
--
--   TEST 1 - de-duplication. A batch containing the SAME (rake_record_id,
--   user_id) twice:
--     result   {"ok": 1, "failed": 0, "first_error": null}
--     ledger   +1 row      (not 2)
--     rake     +12.34      (not 24.68)
--     hands    +3          (not 6)
--
--   TEST 2 - apply-once under replay. Apply a batch, then apply the IDENTICAL
--   batch again:
--     apply    ok=1, rake +7.77
--     REPLAY   ok=0, rake +0.00   <- a retried batch cannot double-count rake
--     ledger   +1 row total
--
-- The apply-once guarantee is the load-bearing property of this function and
-- it is preserved exactly.
--
-- EVIDENCE (pg_stat_statements, 2026-08-24 09:00 -> 21:35 UTC, 12h35m):
--   fn_apply_rakeback_player_stats_batch
--     139 calls, mean 39,074 ms, MAX 380,366 ms (6.3 minutes), 1.51 core-hours
--
-- The instance has 2 vCPU. A single 380-second call holds one of the two cores
-- for over six minutes, halving the platform's entire query capacity while it
-- runs, and it runs against the same cores serving live play.
--
-- ROOT CAUSE
-- The wrapper looped over p_items and for EACH item ran
-- apply_rakeback_player_stats inside its own BEGIN/EXCEPTION block, so per item:
--   * a SUBTRANSACTION - every plpgsql EXCEPTION block opens one, consuming an
--     XID and forcing subxid tracking. Thousands per call is a known collapse
--     mode.
--   * an INSERT .. ON CONFLICT DO NOTHING on rakeback_stats_applied.
--   * an UPSERT on player_stats keyed (user_id, club_id), which takes a ROW
--     LOCK - so every item belonging to the same player serialises against the
--     others inside the same batch.
--
-- FIX
-- Three statements total, regardless of batch size:
--   1. de-duplicate the payload on (rake_record_id, user_id);
--   2. one INSERT .. ON CONFLICT DO NOTHING .. RETURNING against the
--      idempotency table. The RETURNING set is exactly the rows that were
--      genuinely new, which preserves the original apply-once guarantee -
--      this is the load-bearing detail, since it is what stops a replayed
--      batch double-counting rake.
--   3. one aggregated UPSERT into player_stats, so each (user_id, club_id) row
--      is touched ONCE per batch instead of once per item.
--
-- The DISTINCT ON is required, not cosmetic: ON CONFLICT cannot handle two rows
-- with the same conflict key inside one INSERT ("ON CONFLICT DO UPDATE command
-- cannot affect row a second time"), and a batch can legally contain the same
-- rake_record/user twice.
--
-- RESILIENCE
-- The original per-item loop is retained verbatim as an EXCEPTION fallback. The
-- old code could absorb one bad item and report it in `failed`; a single
-- set-based statement cannot. If the fast path raises for any reason we fall
-- back to the row-by-row path and the caller sees exactly the old behaviour and
-- the old {ok, failed, first_error} shape.
--
-- ROUNDING - REVIEW THIS PARAGRAPH IN PARTICULAR
-- The old code applied
--   total_rake = ROUND((total_rake + item_rake) * 100) / 100
-- once PER ITEM. The new code applies it once per (user, club) per batch, over
-- the summed rake. For 2-decimal money inputs these are identical, because the
-- sum of 2dp values is already 2dp and ROUND is a no-op. They can only diverge
-- if an item's rake carries sub-cent precision, and in that case rounding once
-- is strictly LESS lossy than rounding repeatedly - the same class of
-- accumulated-rounding drift that left the BBJ promo bank 1,456.30 short on
-- 2026-08-23. If rake is ever stored at more than 2dp, confirm you want the
-- less-lossy behaviour before applying.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_apply_rakeback_player_stats_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  it jsonb;
  v_ok integer := 0;
  v_failed integer := 0;
  v_first_error text := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', 0, 'failed', 0, 'error', 'p_items must be a jsonb array');
  END IF;

  -- ---------------------------------------------------------------- fast path
  BEGIN
    WITH src AS (
      SELECT DISTINCT ON (rake_record_id, user_id)
             rake_record_id, user_id, club_id, hands, rake
        FROM (
          SELECT (e->>'rake_record_id')::uuid        AS rake_record_id,
                 (e->>'user_id')::uuid               AS user_id,
                 (e->>'club_id')::uuid               AS club_id,
                 COALESCE((e->>'hands')::integer, 1) AS hands,
                 COALESCE((e->>'rake')::numeric, 0)  AS rake
            FROM jsonb_array_elements(p_items) AS e
        ) parsed
       WHERE rake_record_id IS NOT NULL
         AND user_id        IS NOT NULL
         AND club_id        IS NOT NULL
    ),
    ins AS (
      INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
      SELECT rake_record_id, user_id, hands, rake FROM src
      ON CONFLICT (rake_record_id, user_id) DO NOTHING
      RETURNING rake_record_id, user_id, hands, rake
    ),
    agg AS (
      SELECT i.user_id,
             s.club_id,
             SUM(COALESCE(i.hands, 0))::integer AS hands,
             SUM(COALESCE(i.rake, 0))::numeric  AS rake
        FROM ins i
        JOIN src s
          ON s.rake_record_id = i.rake_record_id
         AND s.user_id        = i.user_id
       GROUP BY i.user_id, s.club_id
    ),
    upserted AS (
      INSERT INTO public.player_stats (
        user_id, club_id, hands_played, total_rake,
        total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
      )
      SELECT user_id, club_id, hands, rake, 0, 0, 0, 0, 0, 0 FROM agg
      ON CONFLICT (user_id, club_id) DO UPDATE SET
        hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
        total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
        updated_at   = NOW()
      RETURNING 1
    )
    SELECT count(*)::integer INTO v_ok FROM ins;

    RETURN jsonb_build_object('ok', v_ok, 'failed', 0, 'first_error', NULL);

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_apply_rakeback_player_stats_batch: set-based path failed (%), falling back to per-item', SQLERRM;
    v_ok := 0; v_failed := 0; v_first_error := NULL;
  END;

  -- ------------------------------------------------- fallback: original loop
  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      PERFORM public.apply_rakeback_player_stats(
        (it->>'rake_record_id')::uuid,
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        COALESCE((it->>'hands')::integer, 1),
        COALESCE((it->>'rake')::numeric, 0)
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_error IS NULL THEN v_first_error := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed, 'first_error', v_first_error);
END;
$function$;

-- ============================================================================
-- POST-APPLY ASSERTIONS
-- Static only. This function moves money-adjacent counters, so the assertions
-- must never invoke it against production data.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_apply_rakeback_player_stats_batch'
       AND position('fast path' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'function was not replaced with the set-based body';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_apply_rakeback_player_stats_batch'
       AND position('fallback: original loop' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'the per-item fallback loop was lost';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
     WHERE ix.indrelid = 'public.rakeback_stats_applied'::regclass AND ix.indisunique
  ) THEN
    RAISE EXCEPTION 'rakeback_stats_applied has no unique index - ON CONFLICT would fail';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
     WHERE ix.indrelid = 'public.player_stats'::regclass AND ix.indisunique
  ) THEN
    RAISE EXCEPTION 'player_stats has no unique index - the aggregated UPSERT would fail';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='apply_rakeback_player_stats'
  ) THEN
    RAISE EXCEPTION 'apply_rakeback_player_stats is missing - the fallback would fail';
  END IF;
END $$;
