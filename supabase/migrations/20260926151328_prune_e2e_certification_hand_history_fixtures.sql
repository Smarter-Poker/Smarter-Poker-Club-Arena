-- 20260926151328_prune_e2e_certification_hand_history_fixtures.sql
--
-- Root cause (production-alerts fleet, incident
-- cash-pot-conservation-no-winner-recorded-null-table, board
-- Smarter-Poker/Smarter-Poker-Club-Arena#5070):
--
-- tests/e2e/production-daily-missions.spec.ts certifies the settled-hand
-- daily-mission trigger against LIVE production by inserting one synthetic
-- hand_history row through the service role (table_id NULL, tournament_id
-- NULL, hand_number reserved in 1,700,000,000-1,799,999,999, has_human
-- false) and deleting it in a try/finally. When the run is cancelled or the
-- runner is killed before the finally block executes, the row is orphaned.
--
-- It should not matter: sp_prune_hand_history already sweeps every
-- has_human=false row older than hand_history_retention_policy's
-- horse_retention_days (8 days) every 10 minutes via the existing
-- sp_prune_hand_history_10m pg_cron job. But its candidate EXISTS clause
-- requires a match in public.tables on tb.id = hh.table_id -- and NULL
-- never equals NULL in SQL, so a table_id-IS-NULL row can never satisfy
-- that EXISTS and is silently excluded from every run, forever. Confirmed
-- against production before this migration: table_id IS NULL matches
-- exactly 4 rows in the whole table, all 4 are this exact fixture
-- signature (hand_number in the reserved range, table_id and tournament_id
-- both NULL), and the real hand_number domain tops out at 14.8 million --
-- nowhere near the reserved range. The oldest (2026-09-11) is already
-- eleven days past the retention window and could never have aged out on
-- its own.
--
-- Fix: sp_prune_hand_history's table/tournament EXISTS check is only
-- meaningful when the row references a table. A row with no table and no
-- tournament has nothing to check spin-completion or movement-boundary
-- rules against (confirmed: smarter_private.f06_hand_cards_unresolved and
-- smarter_private.f06_movement_boundary_retained both already return false
-- for a NULL table_id), so it is admitted as a candidate on that basis
-- alone, same as every other has_human=false row. This is the existing
-- scheduled retention sweep, not a new cron and not a repair job (CLAUDE.md
-- 10.85/10.12): once this ships, the 4 leaked rows self-heal on the sweep's
-- normal cadence as each ages past horse_retention_days, with no direct
-- DELETE against production in this migration (CLAUDE.md 10.5: the fleet
-- does not hand-delete production rows).
--
-- Hardening: tests/unit/sp_prune_hand_history_null_table.law.test.ts pins
-- (a) that a table_id-IS-NULL, tournament_id-IS-NULL, has_human=false row
-- past the retention window is now a pruning candidate, and (b) that no row
-- with a non-null table_id or tournament_id is affected by this clause
-- change. tests/e2e/production-daily-missions.spec.ts additionally now
-- registers a SIGTERM/SIGINT handler that deletes the fixture row
-- immediately if the run is cancelled, so the common case no longer waits
-- on retention at all; this migration is the backstop for the cases a
-- signal handler cannot reach (SIGKILL, OOM, host loss).

BEGIN;

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
         -- A row with NEITHER a table NOR a tournament (table_id and
         -- tournament_id both NULL) has nothing for the EXISTS below to
         -- check spin/movement rules against -- it cannot be a live table's
         -- movement boundary because there is no table. Admit it on that
         -- basis alone; every guard above it already governs it correctly
         -- (both f06_* helpers return false for a NULL table_id). Without
         -- this branch, NULL never equals NULL in the tb.id=hh.table_id
         -- join below, so any such row was excluded from every run,
         -- forever, regardless of age. Root cause of the four orphaned
         -- tests/e2e/production-daily-missions.spec.ts certification rows
         -- found 2026-09-26 (board #5070); see this migration's header.
         AND (
           (hh.table_id IS NULL AND hh.tournament_id IS NULL)
           OR EXISTS (
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

COMMIT;
