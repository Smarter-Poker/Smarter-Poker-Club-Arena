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
      SELECT hh.id,hh.players,
             (hh.table_id IS NULL AND hh.tournament_id IS NULL
              AND hh.players = '[]'::jsonb) AS unattached
        FROM public.hand_history hh
       WHERE hh.has_human IS FALSE
         AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions original
           WHERE original.table_id=hh.table_id AND original.hand_number=hh.hand_number
             AND (original.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb)
         AND hh.reported IS NOT true
         AND smarter_private.horse_cash_retention_accounting_ready(hh.table_id,hh.hand_number)
         AND (hh.table_id IS NULL OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=hh.id AND a.table_id=hh.table_id AND a.hand_number=hh.hand_number AND isfinite(a.post_commit_completed_at) AND a.post_commit_completed_at<now()-v_window AND a.post_commit_result->>'ok'='true'))
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- AN UNSETTLED TOURNAMENT KEEPS ITS HANDS (2026-10-02). A tournament
         -- hand is evidence until its event's money is settled: the event is
         -- COMPLETED or CANCELLED, its bounty pool is fully paid, and its
         -- escrow, when it has one, is closed. PKO 3f19bd70 lost the only record
         -- of who knocked out whom while 2,310.00 of its bounty pool was unpaid.
         -- Cash rake records are never deleted here (20260925143224), so a cash
         -- week keeps its per-player rakeback basis settled or not.
         -- Migration 20261002082452.
         AND (hh.tournament_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournaments ut
            WHERE ut.id=hh.tournament_id
              AND (upper(COALESCE(ut.status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
                   OR COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)
                   OR EXISTS (SELECT 1 FROM public.tournament_escrow ue
                               WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL))))
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
         -- AN UNATTACHED ROW IS NOT A HAND ANYBODY PLAYED (2026-10-05). A row
         -- with no table, no tournament and nobody dealt in is the settled-hand
         -- fixture tests/e2e/production-daily-missions.spec.ts inserts and
         -- deletes; a run killed before its finally block leaves it behind.
         -- The engine never writes one. tb.id=hh.table_id is never true for a
         -- NULL table_id, so the EXISTS below excluded such a row from every
         -- run, and even admitted, an empty player list classifies as human
         -- below and would be kept for ever. Every guard above still governs
         -- it (both f06 helpers read false for a NULL table_id, measured on
         -- all eight such rows). Migration 20261005111120.
         AND ((hh.table_id IS NULL AND hh.tournament_id IS NULL
               AND hh.players = '[]'::jsonb) OR EXISTS (
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
         ))
       ORDER BY hh.created_at
       LIMIT LEAST(GREATEST(p_batch,1),250)
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN c.unattached THEN false
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
      -- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28).
      -- The commit row below is how fn_ca_resume_hand_submission knows a
      -- hand finished. Deleting it without closing the request leaves the
      -- table looking mid-hand for ever, and the next successor refuses to
      -- start it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED). Receipted here,
      -- in the same transaction, while table_id and hand_number are still
      -- readable from the rows about to go.
      PERFORM smarter_private.hand_submission_retention_disposal(v_doomed,
        'Retention pruned this settled hand under the horse hand-history policy; its durable record (atomic commit and history) has aged out, so the retained settlement request is closed here and must never be applied again. Zero credit: the hand settled when it was played.');
      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      PERFORM smarter_private.compact_horse_cash_play_contents(v_doomed);
      PERFORM smarter_private.archive_pruned_hand_index(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retention_accounting_ready(p_table uuid, p_number bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE p public.cash_hand_provenance_receipts; m public.cash_hand_participant_manifests;
 k public.settlement_idempotency_keys; sealed smarter_private.horse_settlement_key_certificates; evidence jsonb;
BEGIN
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 -- Only a verified tournament owner or the explicit unattached fixture may
 -- have no cash receipt. A missing cash/unknown owner stays original evidence.
 IF NOT FOUND THEN RETURN p_table IS NULL OR EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.tournament_id IS NOT NULL); END IF;
 IF p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE
 OR p.all_players_included IS NOT TRUE OR p.issues IS DISTINCT FROM '[]'::jsonb
 OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
 OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
 OR NOT smarter_private.horse_cash_retained_request_matches(p_table,p_number,p.payload_hash,p.accepted_request)
 OR smarter_private.f06_hand_cards_unresolved(p_table,p_number)
 OR smarter_private.f06_movement_boundary_retained(p_table,p_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=p.hand_id AND (h.has_human IS DISTINCT FROM false OR h.reported IS true))
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=p_table AND b.hand_number=p_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=p.hand_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=p.hand_id AND t.state='pending')
 THEN RETURN false; END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=p_table AND hand_number=p_number;
 IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=p_table AND o.hand_number=p_number
  AND (o.hand_id,o.payload_hash,o.game_scope) IS NOT DISTINCT FROM (p.hand_id,p.payload_hash,p.game_scope)
  AND o.evidence->>'status'='ready' AND o.evidence->'basis_certified'='true'::jsonb AND o.evidence->'all_players_included'='true'::jsonb)
 OR NOT pg_input_is_valid(p.atomic_receipt#>>'{stack_result,hand_id}','uuid') THEN RETURN false; END IF;
 SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=p_table AND hand_id=(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid;
 IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.error IS NOT NULL OR k.completed_at IS NULL
 OR NOT isfinite(k.completed_at) THEN RETURN false; END IF;
 SELECT * INTO sealed FROM smarter_private.horse_settlement_key_certificates WHERE table_id=p_table AND stack_hand_id=k.hand_id;
 IF FOUND THEN
  IF (sealed.history_hand_id,sealed.hand_number,sealed.manifest_id) IS DISTINCT FROM (p.hand_id,p_number,p.manifest_id)
  OR encode(extensions.digest(convert_to((p.atomic_receipt->'stack_result')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  OR encode(extensions.digest(convert_to(smarter_private.horse_settlement_original_result(p_table,k.hand_id,k.result)::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  THEN RETURN false; END IF;
 ELSE
  IF k.result IS DISTINCT FROM p.atomic_receipt->'stack_result' OR NOT k.result ? 'request' THEN RETURN false; END IF;
 END IF;
 evidence:=public.fn_pnl_cash_hand_evidence(p_table,p_number);
 IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
 OR (sealed.table_id IS NOT NULL AND encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.accounting_evidence_sha256)
 THEN RETURN false; END IF;
 RETURN true;
END $function$
;