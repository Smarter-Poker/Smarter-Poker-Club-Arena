-- sp_prune_hand_history AS PRODUCTION HAD IT IMMEDIATELY BEFORE
-- 20260928031344_retention_closes_the_settlement_request_it_prunes (2026-09-28).
--
-- Not retyped: mechanically recovered, read-only, from production's live
-- pg_get_functiondef('public.sp_prune_hand_history(integer)'), by reversing
-- that migration's own DO $patch$ block -- replacing its v_repl text back to
-- its v_old anchor, using the exact literal v_old/v_repl strings copied from
-- the migration file itself, not retyped either. Verified twice, independently,
-- entirely server-side against production, with zero mutation risk (a pure
-- read-only SELECT both times):
--   1. round-trip: replace(replace(current, v_repl, v_old), v_old, v_repl) =
--      current, exactly;
--   2. v_repl occurs in current exactly once (the same invariant the
--      migration's own DO block asserts before it ever patches production).
-- md5 of this file's CREATE OR REPLACE statement (through the closing
-- '$function$;', this header excluded): 2541b09dec48ebed42dbefa5cdd1841e
--
-- Applying migration 20260928031344 to this text, for real, in a disposable
-- cluster, is a second, independent, live check of this file: that migration's
-- own DO block raises RETENTION_DISPOSAL_ANCHOR_FOUND_%_TIMES unless its
-- anchor appears in this body exactly once, and RETENTION_DISPOSAL_PATCH_UNPROVEN
-- unless the patch actually lands. If this file were wrong, the migration
-- would refuse to apply to it, not silently apply somewhere else.
--
-- sp_prune_hand_history has no single prior migration that fully rewrites it
-- immediately before this one to extract from instead (unlike
-- fn_ca_resume_hand_submission's RESUME_BASE): between the last full
-- CREATE OR REPLACE in the repo's history (20260926151328) and this migration,
-- four more migrations on 2026-09-27 (20260927134527, 20260927140721,
-- 20260927141959, 20260927142005) further patched its candidate query in
-- place, so no single repo file holds this exact text. Reversal against
-- production is the direct route to it.
CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- A hand whose F06 permit is still 'reserved' is unresolved, and this
         -- row is original evidence for it:
         -- smarter_private.f06_retired_origin_snapshot and
         -- smarter_private.f06_retained_mtt_abort_snapshot both read
         -- public.hand_history and public.hand_atomic_commits. All four DELETEs
         -- below key off the ids chosen here, so excluding the hand at this one
         -- point retains its history, atomic commit, rake attribution and
         -- player-index rows together. Excluding it from the candidate set
         -- rather than from each DELETE also keeps it out of v_keepers, so no
         -- has_human=true is written that would retain it past its permit, and
         -- it never consumes a p_batch slot. Retention ends when the permit
         -- leaves 'reserved'; every other row prunes on the same boundary as
         -- before. The lookup goes through the SECURITY DEFINER helper added by
         -- migration 20260920232341, because this function is SECURITY INVOKER
         -- and its search_path does not include smarter_private.
         AND NOT smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)
         -- AND the hand that IS the table's current movement boundary, for a
         -- table F06 can still be asked to move. The guard above protects the
         -- unresolved HAND -- which never started and has no row here -- so it
         -- reached straight past the hands the table already dealt, and
         -- smarter_private.f06_movement_prior loads the last of those by
         -- max(hand_number) and validates its post-commit payload hash,
         -- request hash and stack receipt out of it. Delete it and that table
         -- raises F06_MOVEMENT_PRIOR_INCOMPLETE for ever: on 2026-09-25 one
         -- seated player in a RUNNING freeroll was about six retention runs
         -- from exactly that. One hand per live table, and it stops being the
         -- boundary as soon as the table deals another. Migration
         -- 20260925210126.
         AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)
         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         AND EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         )
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      -- A RECORDED EARNING SOURCE IS NOT HAND HISTORY (2026-09-25).
      -- This line used to delete the pruned hands rake attributions, and
      -- every run of sp_prune_hand_history_10m raised
      -- recorded_cash_earning_source_is_immutable for it: the trigger
      -- accounting_cash_source_immutable refuses to move an attribution once
      -- accounting_cash_accrual_batches holds a batch for its rake record.
      -- The trigger is right and the DELETE was never required: there is no
      -- foreign key from rake_attributions.hand_id to hand_history.id. It
      -- also fired trg_ca_club_rake_daily_user_del, which would have
      -- decremented the per-club per-user daily rake rollup - the rakeback
      -- basis - for every horse in every pruned hand (CLAUDE.md 10.5).
      -- Retention is a storage decision about hand HISTORY (10.5, eight
      -- days); the money ledger is not pruned, so attributions are kept.
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$;
