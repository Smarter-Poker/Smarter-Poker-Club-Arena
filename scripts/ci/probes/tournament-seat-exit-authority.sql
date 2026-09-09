-- Run after the tournament seat-exit authority migration. This is a read-only
-- structural, cutover-receipt, and ACL probe: it proves the exact historical
-- backlog recorded by the one-time cutover is still closed, every future live
-- tournament seat-exit door is guarded, generic cash paths refuse tournament
-- tables, and move replay is backed by one immutable owner-only receipt.
DO $probe$
DECLARE
  v_source text;
  v_count integer;
  v_signature text;
  v_call text;
  v_caught boolean;
  v_revoked_user uuid:=gen_random_uuid();
  v_revoked_session uuid:=gen_random_uuid();
BEGIN
  IF to_regclass('public.tournament_seat_exit_authority_cutover') IS NULL
     OR to_regclass(
       'public.tournament_paid_candidate_cutover_receipts') IS NULL
     OR to_regclass(
       'public.tournament_positive_orphan_cutover_receipts') IS NULL
     OR to_regclass('public.tournament_unregistration_receipts') IS NULL
     OR to_regclass('public.tournament_seat_exit_authorizations') IS NULL
     OR to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure(
       'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])') IS NULL
     OR to_regprocedure(
       'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_unregistration_rake_evidence_is_immutable()') IS NULL
     OR to_regprocedure(
       'public.fn_tournament_live_seat_exit_requires_authority()') IS NULL
     OR to_regprocedure(
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit authority is incomplete';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_seat_exit_authority_cutover c
   WHERE c.authority='tournament_seat_exit_authority:v1'
     AND c.migration_version='20260909014545'
     AND c.installed_at IS NOT NULL
     AND c.installed_at<=clock_timestamp()
     AND c.repaired_seat_count=cardinality(c.repaired_seat_ids)
     AND c.repaired_table_count=cardinality(c.repaired_table_ids)
     AND c.repaired_roster_count=cardinality(c.repaired_roster_ids)
     AND c.repaired_chip_count=cardinality(c.repaired_chip_roster_ids)
     AND c.repaired_stakes_count=cardinality(c.repaired_stakes_table_ids)
     AND c.closed_duplicate_table_count=
         cardinality(c.closed_duplicate_table_ids)
     AND c.repaired_player_count_count=
         cardinality(c.repaired_player_count_tournament_ids)
     AND c.paid_candidate_count=cardinality(c.paid_candidate_ids)
     AND c.positive_orphan_count=cardinality(c.positive_orphan_seat_ids)
     AND array_position(c.repaired_seat_ids,NULL) IS NULL
     AND array_position(c.repaired_table_ids,NULL) IS NULL
     AND array_position(c.repaired_roster_ids,NULL) IS NULL
     AND array_position(c.repaired_chip_roster_ids,NULL) IS NULL
     AND array_position(c.repaired_stakes_table_ids,NULL) IS NULL
     AND array_position(c.closed_duplicate_table_ids,NULL) IS NULL
     AND array_position(c.repaired_player_count_tournament_ids,NULL) IS NULL
     AND array_position(c.paid_candidate_ids,NULL) IS NULL
     AND array_position(c.positive_orphan_seat_ids,NULL) IS NULL
     AND c.paid_candidate_count=(
       SELECT count(*) FROM public.tournament_paid_candidate_cutover_receipts)
     AND c.positive_orphan_count=(
       SELECT count(*) FROM public.tournament_positive_orphan_cutover_receipts)
     AND c.paid_candidate_ids IS NOT DISTINCT FROM ARRAY(
       SELECT r.candidate_id
         FROM public.tournament_paid_candidate_cutover_receipts r
        ORDER BY r.candidate_id)
     AND c.positive_orphan_seat_ids IS NOT DISTINCT FROM ARRAY(
       SELECT r.source_seat_id
         FROM public.tournament_positive_orphan_cutover_receipts r
        ORDER BY r.source_seat_id);
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL exact tournament seat-exit cutover receipt is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_seat_ids) repaired(id)
      LEFT JOIN public.table_seats s ON s.id=repaired.id
     WHERE s.id IS NULL OR s.left_at IS NULL OR s.status<>'left')
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_table_ids) repaired(id)
     LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.closed_duplicate_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'FAIL cutover receipt no longer matches durable closed state';
  END IF;

  -- The aggregate marker is only an index. Each repaired knockout generation
  -- must still resolve to both accepted-hand journals and every immutable
  -- debit identity captured by its owner-only detail receipt.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_paid_candidate_cutover_receipts r
      LEFT JOIN public.tournament_knockout_candidates c
        ON c.id=r.candidate_id
      LEFT JOIN public.hand_atomic_commits h
        ON h.table_id=r.zero_table_id AND h.hand_number=r.zero_hand_number
       AND h.hand_id=r.zero_hac_hand_id
      LEFT JOIN public.settlement_idempotency_keys k
        ON k.table_id=r.zero_table_id
       AND k.hand_id=r.zero_settlement_hand_id
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
     WHERE c.id IS NULL OR tp.id IS NULL
        OR tp.tournament_id IS DISTINCT FROM r.tournament_id
        OR tp.user_id IS DISTINCT FROM r.user_id
        OR c.tournament_id IS DISTINCT FROM r.tournament_id
        OR c.eliminated_user_id IS DISTINCT FROM r.user_id
        OR c.state IS DISTINCT FROM 'rebought'
        OR c.resolved_at IS DISTINCT FROM r.first_paid_at
        OR h.table_id IS NULL OR k.table_id IS NULL
        OR h.stack_result->>'success' IS DISTINCT FROM 'true'
        OR k.completed_at IS NULL
        OR k.status IS DISTINCT FROM 'succeeded'
        OR k.hand_id::text IS DISTINCT FROM h.stack_result->>'hand_id'
        OR k.result IS DISTINCT FROM h.stack_result
        OR COALESCE(h.stack_result->'written'->>r.user_id::text,'')
             !~'^-?[0-9]+([.][0-9]+)?$'
        OR (h.stack_result->'written'->>r.user_id::text)::numeric
             IS DISTINCT FROM 0
        OR r.first_paid_at IS DISTINCT FROM (
             SELECT min(l.created_at)
               FROM unnest(r.source_ledger_ids) source(id)
               JOIN public.chip_ledger l ON l.id=source.id)
        OR r.last_paid_at IS DISTINCT FROM (
             SELECT max(l.created_at)
               FROM unnest(r.source_ledger_ids) source(id)
               JOIN public.chip_ledger l ON l.id=source.id)
        OR (r.repair_action='stranded_stack_seated' AND (
             r.stack_after::bigint IS DISTINCT FROM (
               SELECT count(*)::bigint*r.rebuy_chips::bigint
                 FROM unnest(r.purchase_types) WITH ORDINALITY
                   kind(purchase_type,position)
                WHERE kind.position>=COALESCE((
                  SELECT max(reentry.position)
                    FROM unnest(r.purchase_types) WITH ORDINALITY
                      reentry(purchase_type,position)
                   WHERE reentry.purchase_type='reentry'),1))
             OR r.stack_before>r.stack_after OR r.seat_id IS NULL
             OR r.seat_row_reused IS NULL
             OR (r.seat_row_reused AND (
                  r.destination_seat_id_before IS DISTINCT FROM r.seat_id
                  OR r.destination_left_at_before IS NULL))
             OR (NOT r.seat_row_reused AND
                  r.destination_seat_id_before IS NOT NULL)
             OR r.seat_player_id IS NOT NULL
             OR r.seat_member_id IS NOT NULL
             OR r.seat_club_id IS NULL
             OR r.seat_is_sitting_out IS DISTINCT FROM false
             OR r.seat_is_away IS DISTINCT FROM false
             OR r.seat_sit_out_at IS NOT NULL
             OR r.seat_scheduled_leave_hands IS NOT NULL
             OR r.seat_left_at IS NOT NULL
             OR r.seat_status IS DISTINCT FROM 'active'
             OR r.seat_leave_pending IS DISTINCT FROM false
             OR r.seat_auto_rebuy IS DISTINCT FROM false
             OR r.seat_time_bank_remaining IS DISTINCT FROM 30
             OR r.seat_time_bank_uses_remaining IS DISTINCT FROM 4
             OR r.seat_entry_hold IS NOT NULL
             OR r.seat_entry_post_agreed IS DISTINCT FROM false))
        OR (r.repair_action='live_generation_rotated' AND (
             r.seat_id IS DISTINCT FROM r.zero_seat_id
             OR r.seat_joined_at_before IS DISTINCT FROM
                  r.zero_seat_joined_at
             OR r.seat_joined_at_after IS DISTINCT FROM r.first_paid_at))
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_paid_candidate_cutover_receipts r
      CROSS JOIN LATERAL unnest(
        r.entitlement_ids,r.source_ledger_ids,r.source_ledger_chain_seqs,
        r.source_ledger_row_hashes,r.wallet_transaction_ids,
        r.purchase_idempotency_keys,r.purchase_types)
        AS evidence(entitlement_id,ledger_id,chain_seq,row_hash,
                    wallet_transaction_id,purchase_key,purchase_type)
      LEFT JOIN public.tournament_refund_entitlements e
        ON e.id=evidence.entitlement_id
      LEFT JOIN public.chip_ledger l ON l.id=evidence.ledger_id
      LEFT JOIN public.wallet_transactions w
        ON w.id=evidence.wallet_transaction_id
      LEFT JOIN public.wallet_credit_idempotency i
        ON i.key=evidence.purchase_key
     WHERE e.id IS NULL OR l.id IS NULL OR w.id IS NULL OR i.key IS NULL
        OR e.source_ledger_id IS DISTINCT FROM l.id
        OR e.tournament_id IS DISTINCT FROM r.tournament_id
        OR e.user_id IS DISTINCT FROM r.user_id
        OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'
        OR e.charge_category IS DISTINCT FROM 'rebuy'
        OR e.evidence_kind NOT IN (
             'atomic_wallet_charge','cutover_wallet_charge')
        OR e.created_at IS DISTINCT FROM l.created_at
        OR l.chain_seq IS DISTINCT FROM evidence.chain_seq
        OR l.row_hash IS DISTINCT FROM evidence.row_hash
        OR l.from_type IS DISTINCT FROM 'player_wallet'
        OR l.from_entity_id IS DISTINCT FROM r.user_id
        OR l.to_type IS DISTINCT FROM 'prize_liability'
        OR l.to_entity_id IS DISTINCT FROM r.tournament_id
        OR l.tournament_id IS DISTINCT FROM r.tournament_id
        OR l.status IS DISTINCT FROM 'posted'
        OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
        OR l.amount IS DISTINCT FROM e.gross
        OR w.user_id IS DISTINCT FROM r.user_id
        OR w.related_entity_id IS DISTINCT FROM r.tournament_id
        OR w.wallet_type IS DISTINCT FROM 'PLAYER'
        OR w.type IS DISTINCT FROM 'debit'
        OR lower(COALESCE(w.category,''))<>'rebuy'
        OR w.amount IS DISTINCT FROM e.gross
        OR w.created_at IS DISTINCT FROM l.created_at
        OR evidence.purchase_type NOT IN ('rebuy','reentry')
        OR COALESCE(w.description,'') NOT LIKE
             'Tournament '||evidence.purchase_type||':%'
        OR i.user_id IS DISTINCT FROM r.user_id
        OR (
          i.amount IS NOT DISTINCT FROM e.gross
          OR (
            e.evidence_kind='cutover_wallet_charge'
            AND r.repair_action='candidate_closed'
            AND EXISTS (
              SELECT 1
                FROM public.tournament_knockout_candidates later
               WHERE later.tournament_id=r.tournament_id
                 AND later.eliminated_user_id=r.user_id
                 AND (later.hand_number,later.id)>
                     (r.zero_hand_number,r.candidate_id)
            )
            AND evidence.purchase_type='rebuy'
            AND i.amount=0
            AND e.gross=1
            AND i.key='tourney:'||r.tournament_id::text||':rebuy:'||
                      r.user_id::text||':#0'
          )
        ) IS NOT TRUE
        OR i.created_at IS DISTINCT FROM l.created_at
        OR i.key NOT LIKE 'tourney:'||r.tournament_id::text||':'||
             evidence.purchase_type||':'||r.user_id::text||':%'
  ) THEN
    RAISE EXCEPTION 'FAIL paid candidate cutover evidence changed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_positive_orphan_cutover_receipts r
      LEFT JOIN public.hand_atomic_commits h
        ON h.table_id=r.table_id AND h.hand_number=r.last_hand_number
       AND h.hand_id=r.last_hac_hand_id
      LEFT JOIN public.settlement_idempotency_keys k
        ON k.table_id=r.table_id AND k.hand_id=r.last_settlement_hand_id
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
     WHERE r.source_seat_id IS DISTINCT FROM r.revived_seat_id
        OR tp.id IS NULL
        OR tp.tournament_id IS DISTINCT FROM r.tournament_id
        OR tp.user_id IS DISTINCT FROM r.user_id
        OR r.source_status IS DISTINCT FROM 'active'
        OR r.source_player_id IS NOT NULL
        OR r.source_member_id IS NOT NULL
        OR r.source_club_id IS NULL
        OR r.revived_player_id IS NOT NULL
        OR r.revived_member_id IS NOT NULL
        OR r.revived_horse_id IS DISTINCT FROM r.source_horse_id
        OR r.revived_club_id IS NULL
        OR r.revived_is_sitting_out IS DISTINCT FROM false
        OR r.revived_is_away IS DISTINCT FROM false
        OR r.revived_sit_out_at IS NOT NULL
        OR r.revived_scheduled_leave_hands IS NOT NULL
        OR r.revived_left_at IS NOT NULL
        OR r.revived_status IS DISTINCT FROM 'active'
        OR r.revived_leave_pending IS DISTINCT FROM false
        OR r.revived_auto_rebuy IS DISTINCT FROM false
        OR r.revived_time_bank_remaining IS DISTINCT FROM
             r.source_time_bank_remaining
        OR r.revived_time_bank_uses_remaining IS DISTINCT FROM
             r.source_time_bank_uses_remaining
        OR r.revived_entry_hold IS NOT NULL
        OR r.revived_entry_post_agreed IS DISTINCT FROM false
        OR h.table_id IS NULL OR k.table_id IS NULL
        OR h.committed_at<r.source_joined_at
        OR r.source_left_at<=GREATEST(
             h.committed_at,h.post_commit_completed_at,k.completed_at)
        OR EXISTS (
             SELECT 1 FROM public.hand_atomic_commits later_global
             JOIN public.tables later_global_table
               ON later_global_table.id=later_global.table_id
              WHERE later_global_table.tournament_id=r.tournament_id
                AND later_global.stack_result->'written' ? r.user_id::text
                AND later_global.hand_number>r.last_hand_number)
        OR COALESCE(h.stack_result->'written'->>r.user_id::text,'')
             !~'^-?[0-9]+([.][0-9]+)?$'
        OR (h.stack_result->'written'->>r.user_id::text)::numeric
             IS DISTINCT FROM r.stack
        OR h.stack_result->>'success' IS DISTINCT FROM 'true'
        OR h.post_commit_completed_at IS NULL
        OR h.post_commit_result->>'ok' IS DISTINCT FROM 'true'
        OR k.status IS DISTINCT FROM 'succeeded'
        OR k.hand_id::text IS DISTINCT FROM h.stack_result->>'hand_id'
        OR k.result IS DISTINCT FROM h.stack_result
  ) THEN
    RAISE EXCEPTION 'FAIL positive-orphan cutover evidence changed';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger g
   WHERE g.tgrelid='public.table_seats'::regclass
     AND g.tgname='zy_tournament_live_seat_exit_requires_authority'
     AND g.tgfoid=
       'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure
     AND NOT g.tgisinternal AND g.tgenabled='O'
     AND g.tgtype=27;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL live tournament seat-exit trigger shape changed';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger g
   WHERE g.tgrelid='public.tournament_seat_move_receipts'::regclass
     AND g.tgname='tournament_seat_move_receipts_append_only'
     AND g.tgfoid=
       'public.fn_tournament_seat_move_receipts_append_only()'::regprocedure
     AND NOT g.tgisinternal AND g.tgenabled='O'
     AND g.tgtype=27;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL tournament move receipt is not append-only';
  END IF;

  SELECT count(*) INTO v_count
    FROM (VALUES
      ('public.tournament_paid_candidate_cutover_receipts'::regclass,
       'tournament_paid_candidate_cutover_receipts_append_only',
       'public.fn_tournament_seat_exit_cutover_receipts_append_only()'::regprocedure),
      ('public.tournament_positive_orphan_cutover_receipts'::regclass,
       'tournament_positive_orphan_cutover_receipts_append_only',
       'public.fn_tournament_seat_exit_cutover_receipts_append_only()'::regprocedure)
    ) expected(relation_id,trigger_name,function_id)
    JOIN pg_trigger g ON g.tgrelid=expected.relation_id
     AND g.tgname=expected.trigger_name AND g.tgfoid=expected.function_id
   WHERE NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=27;
  IF v_count<>2 THEN
    RAISE EXCEPTION 'FAIL cutover detail receipts are not append-only';
  END IF;

  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','DELETE')
     OR has_table_privilege(
       'service_role','public.tournament_paid_candidate_cutover_receipts','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_paid_candidate_cutover_receipts','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_paid_candidate_cutover_receipts','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_paid_candidate_cutover_receipts','DELETE')
     OR has_table_privilege(
       'service_role','public.tournament_positive_orphan_cutover_receipts','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_positive_orphan_cutover_receipts','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_positive_orphan_cutover_receipts','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_positive_orphan_cutover_receipts','DELETE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authorizations','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','SELECT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_exit_authorizations','INSERT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_move_receipts','INSERT')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_seat_move_receipt(uuid)','EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_tournament_seat_exit_cutover_receipts_append_only()',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit ACL boundary changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure)
    INTO v_source;
  IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
     OR position('app.tournament_seat_exit_token' IN v_source)=0
     OR position('tournament_seat_exit_authorizations' IN v_source)=0
     OR position('tournament_players' IN v_source)<>0
     OR position('OLD.stack=0' IN replace(v_source,' ',''))<>0 THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit token proof changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure)
    INTO v_source;
  IF position('fn_ca_open_tournament_hand_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority' IN v_source)=0
     OR position('v_expected_vacated<>v_consumed' IN replace(v_source,' ',''))=0
     OR position('accepted_hand_bust' IN v_source)=0
     OR position('fn_emit_tournament_manager_wake' IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL accepted-hand seat capability boundary changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_emit_tournament_manager_wake(uuid,text)'::regprocedure)
    INTO v_source;
  IF position('accepted_hand_bust' IN v_source)=0
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_manager_wakes'::regclass
          AND c.conname='tournament_manager_wakes_reason_check'
          AND pg_get_constraintdef(c.oid) LIKE '%accepted_hand_bust%') THEN
    RAISE EXCEPTION 'FAIL accepted-hand bust has no durable manager wake rail';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)'::regprocedure)
    INTO v_source;
  IF position('tournament_seat_move_receipts' IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0
     OR position('UPDATE public.tournament_players' IN v_source)=0
     OR position('UPDATE public.table_seats' IN v_source)=0 THEN
    RAISE EXCEPTION 'FAIL atomic tournament move lost a required commit member';
  END IF;

  FOREACH v_source IN ARRAY ARRAY[
    pg_get_functiondef(
      'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure),
    pg_get_functiondef(
      'public.fn_admin_kick_player(uuid,uuid,text)'::regprocedure),
    pg_get_functiondef(
      'public.fn_clear_table_seats(uuid,boolean)'::regprocedure),
    pg_get_functiondef(
      'public.force_close_table_and_refund(uuid,uuid,text)'::regprocedure),
    pg_get_functiondef(
      'public.player_leave_table(uuid,uuid)'::regprocedure)
  ] LOOP
    IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
       OR position('tournament_id' IN v_source)=0 THEN
      RAISE EXCEPTION 'FAIL a generic seat-exit door no longer refuses tournaments';
    END IF;
  END LOOP;

  IF to_regprocedure('public.fn_clear_seats_on_game_end()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_spin_reap_stale_boards(integer,boolean,boolean,integer)')
       IS NOT NULL
     OR to_regprocedure(
       'public.fn_reconcile_tournament_denormals()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_live_seat_chips(uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_chips(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_release_seats_on_tournament_finish()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournaments'::regclass
          AND tg.tgname='trg_release_seats_on_tournament_finish'
          AND NOT tg.tgisinternal)
     OR EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname='reconcile-tournament-denormals'
           OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'FAIL delayed tournament seat reconcilers still exist';
  END IF;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_source IS NULL
     OR v_source NOT LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
     OR has_function_privilege(
       'service_role',
       'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL late seating still depends on a stakes reconciler';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_source IS NULL
     OR v_source NOT LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL managed blind edits still depend on a reconciler';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p
     WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef;
    IF v_source IS NULL
       OR v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
       OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
       OR v_source LIKE '%UPDATE public.table_seats%'
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL elimination wrapper or ACL changed: %',v_signature;
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
    'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p
     WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef;
    IF v_source IS NULL
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR has_function_privilege('service_role',v_signature,'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL private elimination owner changed: %',v_signature;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%fn_eliminate_player_legacy_candidate_20260907%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'FAIL ordinary elimination bridge changed owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_claim_bounty_legacy_candidate_20260907%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'FAIL bounty elimination bridge changed owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%left_at%' THEN
    RAISE EXCEPTION 'FAIL ordinary elimination direct owner changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%left_at%' THEN
    RAISE EXCEPTION 'FAIL bounty elimination direct owner changed';
  END IF;

  IF to_regprocedure(
       'public.atomic_tournament_unregister(uuid,uuid,numeric)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_tournament_unregister_counter(uuid,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL amount-trusting legacy unregister still exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'FAIL a retired wallet writer exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND (p.prosrc LIKE '%atomic_tournament_unregister%'
         OR p.prosrc LIKE '%fn_tournament_unregister_counter%'
         OR p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%')
  ) THEN
    RAISE EXCEPTION 'FAIL a persistent function body names a retired wallet writer';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_club_arena_global_wallet_check()',
    'public.fn_union_money_path_check()',
    'public.fn_union_overload_check()'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature)
            AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
       ) THEN
      RAISE EXCEPTION 'FAIL diagnostic ACL or definer changed: %',v_signature;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.guard_wallet_balance_write()'::regprocedure
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public']
     AND NOT has_function_privilege(
       'anon','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'authenticated','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'service_role','public.guard_wallet_balance_write()','EXECUTE');
  IF v_source IS NULL
     OR v_source LIKE '%atomic_tournament_unregister%' THEN
    RAISE EXCEPTION 'FAIL wallet balance guard retained legacy authority';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid,uuid)',
    'public.fn_leave_seat_and_refund(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef
       ) THEN
      RAISE EXCEPTION 'FAIL supported tournament exit RPC changed: %',v_signature;
    END IF;
    SELECT p.prosrc INTO v_source
      FROM pg_proc p WHERE p.oid=to_regprocedure(v_signature);
    IF v_source IS NULL
       OR v_source NOT LIKE '%public.fn_caller_session_is_live()%' THEN
      RAISE EXCEPTION
        'FAIL tournament exit RPC admits a missing or revoked session: %',
        v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid)',
    'public.fn_leave_seat_and_refund(uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL obsolete public tournament exit still exists: %',
        v_signature;
    END IF;
  END LOOP;

  -- Execute both request-keyed player-facing exits with a syntactically valid
  -- JWT whose session row does not exist. The denial must happen before any
  -- tournament, table, registration, seat, wallet, ticket or rake lookup can
  -- become an oracle or a write. These calls are transaction-local/read-only.
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',v_revoked_user,'role','authenticated',
      'session_id',v_revoked_session)::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  FOREACH v_call IN ARRAY ARRAY[
    format('SELECT public.fn_unregister_from_tournament(%L::uuid,%L::uuid)',
           gen_random_uuid(),gen_random_uuid()),
    format('SELECT public.fn_leave_seat_and_refund(%L::uuid,%L::uuid)',
           gen_random_uuid(),gen_random_uuid())
  ] LOOP
    v_caught:=false;
    BEGIN
      EXECUTE v_call;
    EXCEPTION WHEN SQLSTATE '28000' THEN
      v_caught:=true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION
        'FAIL missing or revoked session reached tournament exit: %',v_call;
    END IF;
  END LOOP;
  EXECUTE 'RESET ROLE';

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'FAIL tournament roster exit ACL has a bypass';
  END IF;

  -- Funding-wallet provenance and fee-recipient provenance are deliberately
  -- separate. Prove the hidden unregister core groups reversals by the actual
  -- positive rake journal's club, and never by refund_wallet_club_id.
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%v_fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%GROUP BY r.club_id%'
     OR v_source NOT LIKE '%fee_recipient_club_id%'
     OR v_source NOT LIKE '%original_rake_record_ids%'
     OR v_source NOT LIKE '%fee_reversal_ids%'
     OR v_source NOT LIKE '%fees_reversed%'
     OR v_source LIKE '%SELECT e.refund_wallet_club_id AS club_id%'
     OR v_source LIKE '%GROUP BY e.refund_wallet_club_id%' THEN
    RAISE EXCEPTION
      'FAIL tournament unregistration substitutes funding club for fee recipient';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee%'
     OR v_source NOT LIKE '%v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%original.club_id=reversal.club_id%'
     OR v_source NOT LIKE '%original_rake_record_ids%'
     OR v_source NOT LIKE '%other.fee_reversal_ids && v_r.fee_reversal_ids%'
     OR v_source NOT LIKE '%other.fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%&& v_r.fee_source_rake_record_ids%' THEN
    RAISE EXCEPTION
      'FAIL unregistration receipt lost exact cross-club fee evidence';
  END IF;
  SELECT count(*) INTO v_count FROM pg_trigger g
   WHERE g.tgrelid='public.rake_records'::regclass
     AND g.tgname='tournament_unregistration_rake_evidence_is_immutable'
     AND g.tgfoid=
       'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure
     AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=27;
  IF v_count<>1 THEN
    RAISE EXCEPTION
      'FAIL unregistration fee source or reversal journals are mutable';
  END IF;

  -- Recompute every committed fee reversal independently of the replay
  -- helper. Cross-club cases pass only when each negative row shares the
  -- original fee recipient's club; the player's source-wallet club is never
  -- consulted as a substitute.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_unregistration_receipts receipt
     WHERE receipt.fees_reversed IS DISTINCT FROM (
             SELECT round(COALESCE(sum(e.refund_fee),0),2)
               FROM public.tournament_refund_entitlements e
              WHERE e.id=ANY(receipt.entitlement_ids)
                AND e.tournament_id=receipt.tournament_id
                AND e.user_id=receipt.user_id)
        OR cardinality(receipt.fee_reversal_ids)<>(
             SELECT count(*)
               FROM public.rake_records reversal
              WHERE reversal.id=ANY(receipt.fee_reversal_ids)
                AND reversal.tournament_id=receipt.tournament_id
                AND reversal.is_tournament IS TRUE
                AND reversal.source='fn_unregister_from_tournament'
                AND reversal.rake_amount<0
                AND reversal.metadata->>'kind'='tournament_fee_refund'
                AND reversal.metadata->>'user_id'=receipt.user_id::text
                AND reversal.metadata->>'registration_id'=
                      receipt.registration_id::text
                AND reversal.metadata->>'fee_recipient_club_id'=
                      reversal.club_id::text)
        OR receipt.fees_reversed IS DISTINCT FROM (
             SELECT round(COALESCE(-sum(reversal.rake_amount),0),2)
               FROM public.rake_records reversal
              WHERE reversal.id=ANY(receipt.fee_reversal_ids))
        OR receipt.fee_source_rake_record_ids IS DISTINCT FROM ARRAY(
             SELECT parsed.id
               FROM public.rake_records reversal
               CROSS JOIN LATERAL jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(
                            reversal.metadata->'original_rake_record_ids')='array'
                   THEN reversal.metadata->'original_rake_record_ids'
                   ELSE '[]'::jsonb END) raw(id)
               CROSS JOIN LATERAL (
                 SELECT CASE WHEN raw.id~*
                   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN raw.id::uuid ELSE NULL END AS id) parsed
              WHERE reversal.id=ANY(receipt.fee_reversal_ids)
              ORDER BY parsed.id NULLS FIRST)
        OR cardinality(receipt.fee_source_rake_record_ids)<>
             (SELECT count(DISTINCT source.id)
                FROM unnest(receipt.fee_source_rake_record_ids) source(id))
        OR EXISTS (
             SELECT 1
               FROM public.tournament_unregistration_receipts other
              WHERE other.registration_id<>receipt.registration_id
                AND (other.fee_reversal_ids && receipt.fee_reversal_ids
                  OR other.fee_source_rake_record_ids
                       && receipt.fee_source_rake_record_ids))
        OR EXISTS (
             SELECT 1
               FROM unnest(receipt.fee_reversal_ids) reversal_id(id)
               LEFT JOIN public.rake_records reversal
                 ON reversal.id=reversal_id.id
               LEFT JOIN LATERAL (
                 SELECT count(*) AS raw_count,
                        count(original.id) AS exact_count,
                        round(COALESCE(sum(original.rake_amount),0),2)
                          AS exact_amount
                   FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(
                                reversal.metadata->'original_rake_record_ids')='array'
                       THEN reversal.metadata->'original_rake_record_ids'
                       ELSE '[]'::jsonb END) raw(id)
                   LEFT JOIN public.rake_records original
                     ON original.id=CASE WHEN raw.id~*
                       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN raw.id::uuid ELSE NULL END
                    AND original.tournament_id=receipt.tournament_id
                    AND original.club_id=reversal.club_id
                    AND original.is_tournament IS TRUE
                    AND original.rake_amount>0
                    AND original.metadata->>'user_id'=receipt.user_id::text
                    AND (
                      (original.source IN (
                         'fn_register_for_tournament',
                         'fn_register_horse_for_tournament')
                        AND original.metadata->>'kind'='tournament_entry_fee')
                      OR (original.source='process_tournament_rebuy'
                        AND original.metadata->>'kind' IN (
                          'tournament_rebuy_fee','tournament_reentry_fee'))
                      OR (original.source=
                            'fn_register_for_tournament_with_ticket'
                        AND original.metadata->>'kind'=
                            'tournament_ticket_entry_fee')
                      OR (original.source='fn_award_satellite_seat'
                        AND original.metadata->>'kind'=
                            'satellite_seat_entry_fee'))
               ) source_proof ON true
              WHERE reversal.id IS NULL
                 OR reversal.tournament_id IS DISTINCT FROM
                      receipt.tournament_id
                 OR reversal.club_id IS NULL
                 OR reversal.is_tournament IS DISTINCT FROM true
                 OR reversal.source IS DISTINCT FROM
                      'fn_unregister_from_tournament'
                 OR reversal.rake_amount>=0
                 OR reversal.metadata->>'kind' IS DISTINCT FROM
                      'tournament_fee_refund'
                 OR reversal.metadata->>'user_id' IS DISTINCT FROM
                      receipt.user_id::text
                 OR reversal.metadata->>'registration_id' IS DISTINCT FROM
                      receipt.registration_id::text
                 OR reversal.metadata->>'fee_recipient_club_id'
                      IS DISTINCT FROM reversal.club_id::text
                 OR jsonb_typeof(
                      reversal.metadata->'original_rake_record_ids')
                      IS DISTINCT FROM 'array'
                 OR source_proof.raw_count=0
                 OR source_proof.exact_count<>source_proof.raw_count
                 OR source_proof.exact_amount IS DISTINCT FROM
                      -reversal.rake_amount)
  ) THEN
    RAISE EXCEPTION
      'FAIL a committed unregistration fee reversal changed provenance';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players';
  IF v_count<>1 OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure
       AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players'
  ) THEN
    RAISE EXCEPTION 'FAIL a second direct tournament roster delete owner exists';
  END IF;

  RAISE EXCEPTION 'PASS tournament seat-exit authority is exact';
END;
$probe$;
