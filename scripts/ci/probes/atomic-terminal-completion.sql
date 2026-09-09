-- Run after the stage-one terminal authority is installed. Legacy bounty
-- backpay remains available during the rolling engine cutover and is verified
-- separately before its deferred retirement. The final PASS exception is
-- intentional so the probe cannot preserve locks or accidental mutations.
DO $probe$
DECLARE
  v_settle text;
  v_receipt text;
  v_count integer;
  v_row record;
  v_result jsonb;
  v_replay jsonb;
  v_outcome jsonb;
  v_before jsonb;
  v_after jsonb;
  v_immutable_refused boolean := false;
BEGIN
  IF to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_terminal_receipt(uuid,uuid)') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL
     OR to_regclass('public.tournament_terminal_settlement_cutover') IS NULL
     OR to_regprocedure(
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)')
          IS NULL
     OR to_regprocedure(
       'public.fn_stamp_tournament_terminal_evidence_markers()') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic terminal authority or immutable evidence is absent';
  END IF;

  SELECT prosrc INTO v_settle FROM pg_proc
   WHERE oid =
     'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'
       ::regprocedure;
  SELECT prosrc INTO v_receipt FROM pg_proc
   WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure;
  IF (length(v_settle)-length(replace(v_settle,
       'public.fn_settle_tournament_places(','')))
       / length('public.fn_settle_tournament_places(') <> 1
     OR (length(v_settle)-length(replace(v_settle,
       'public.fn_settle_tournament_final_table_deal(','')))
       / length('public.fn_settle_tournament_final_table_deal(') <> 1
     OR v_settle !~ 'IF v_mode = ''places'' THEN'
     OR v_settle !~ 'public.fn_mystery_bounty_settle\('
     OR v_settle !~ 'public.fn_finalize_bounty_pool\('
     OR v_settle !~ 'public.fn_settle_tournament_rake\('
     OR v_settle !~ 'INSERT INTO public.tournament_terminal_settlements'
     OR v_settle !~ 'SET status = ''COMPLETED'''
     OR v_settle ~* 'EXCEPTION\s+WHEN' THEN
    RAISE EXCEPTION 'FAIL installed terminal authority lost its atomic sequence';
  END IF;
  IF v_receipt ~* '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)
          <> 's' THEN
    RAISE EXCEPTION 'FAIL terminal replay verifier is not read-only STABLE code';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('tournament_players'),('tournament_obligations'),
           ('tournament_payouts'),('tournament_rake_settlements'),
           ('rake_records'),('tournament_bounty_chests'),
           ('tournament_bounty_awards'),('tournament_guarantee_overlays'),
           ('table_seats'),('wallet_transactions'),
           ('tournament_bounty_award_recipients'),('tournament_escrow'),
           ('spin_reserve_ledger')
         ) required(relname)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid=format('public.%I',required.relname)::regclass
             AND a.attname='terminal_closed_at'
             AND a.atttypid='timestamptz'::regtype
             AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull
             AND a.attidentity='' AND a.attgenerated='' AND a.attacl IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM pg_attrdef d
                WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
       JOIN pg_attribute a ON a.attrelid=g.tgrelid AND a.attname='status'
        WHERE g.tgrelid='public.tournaments'::regclass
          AND g.tgname='stamp_tournament_terminal_evidence_markers'
          AND g.tgfoid=
            'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=21
          AND g.tgattr::text=a.attnum::text
     ) OR (SELECT count(*) FROM pg_trigger g
            WHERE g.tgname='terminal_tournament_evidence_is_immutable'
              AND g.tgfoid=
                'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure
              AND NOT g.tgisinternal AND g.tgenabled='O'
              AND g.tgtype=31 AND g.tgattr::text='')<>15
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'service_role',
          'public.fn_stamp_tournament_terminal_evidence_markers()',
          'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
        WHERE p.oid IN (
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure,
          'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure)
          AND privilege.privilege_type='EXECUTE'
          AND privilege.grantee<>p.proowner)
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid='public.tables'::regclass
          AND g.tgname='tournament_table_terminal_close_is_irreversible'
          AND g.tgfoid=
            'public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=31) THEN
    RAISE EXCEPTION
      'FAIL terminal child marker columns, trigger shape or owner-only ACL changed';
  END IF;

  IF NOT has_function_privilege(
       'service_role','public.fn_complete_tournament_terminal(uuid,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_complete_tournament_terminal(uuid,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_places(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_final_table_deal(uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_finalize_bounty_pool(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_mystery_bounty_settle(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_rake(uuid,text)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_terminal_settlements','SELECT') THEN
    RAISE EXCEPTION 'FAIL terminal service, owner or table privilege boundary changed';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_terminal_settlement_cutover c
   WHERE c.authority = 'fn_complete_tournament_terminal:v1'
     AND c.migration_version = '20260909014534';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL terminal cutover watermark is not exact';
  END IF;

  -- A schema-only rehearsal can legitimately contain no product rows. When
  -- immutable receipts are present (including production), verify every one;
  -- the synthetic rollback probes cover first-write behavior without relying
  -- on production fixtures.
  FOR v_row IN
    SELECT h.tournament_id,h.winner_id
      FROM public.tournament_terminal_settlements h
     ORDER BY h.tournament_id
  LOOP
    v_result := public.fn_ca_tournament_terminal_receipt(
      v_row.tournament_id,v_row.winner_id);
    IF v_result->>'ok' IS DISTINCT FROM 'true'
       OR v_result->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_result->>'status' IS DISTINCT FROM 'COMPLETED'
       OR v_result->>'winner_id' IS DISTINCT FROM v_row.winner_id::text
       OR v_result->>'receipt_version' IS DISTINCT FROM '1'
       OR jsonb_typeof(v_result->'deal_shares') <> 'array'
       OR jsonb_typeof(v_result->'table_closure') <> 'object'
       OR (v_result->>'closed_table_count')::integer IS DISTINCT FROM
            (v_result->'table_closure'->>'closed_table_count')::integer
       OR (v_result->>'released_seat_count')::integer IS DISTINCT FROM
            (v_result->'table_closure'->>'released_seat_count')::integer
       OR v_result->'rake'->>'attributed' IS DISTINCT FROM 'true'
       OR (v_result->'escrow'->>'prize_balance')::numeric <> 0
       OR (v_result->'escrow'->>'bounty_balance')::numeric <> 0
       OR (v_result->'escrow'->>'fee_balance')::numeric <> 0 THEN
      RAISE EXCEPTION 'FAIL terminal receipt does not verify: %',v_result;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM (
          SELECT x.terminal_closed_at AS marker
            FROM public.tournament_players x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_obligations x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_payouts x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_rake_settlements x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.rake_records x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_bounty_chests x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_bounty_awards x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_guarantee_overlays x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT s.terminal_closed_at
            FROM public.table_seats s
            JOIN public.tables tb ON tb.id=s.table_id
           WHERE tb.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.wallet_transactions x
           WHERE x.related_entity_id=v_row.tournament_id
          UNION ALL SELECT r.terminal_closed_at
            FROM public.tournament_bounty_award_recipients r
            JOIN public.tournament_bounty_awards a ON a.id=r.award_id
           WHERE a.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.tournament_escrow x
           WHERE x.tournament_id=v_row.tournament_id
          UNION ALL SELECT x.terminal_closed_at
            FROM public.spin_reserve_ledger x
           WHERE x.tournament_id=v_row.tournament_id
             AND x.kind NOT IN ('contribution','jackpot_draw')
        ) mutable_evidence
        JOIN public.tournament_terminal_settlements h
          ON h.tournament_id=v_row.tournament_id
       WHERE mutable_evidence.marker IS DISTINCT FROM h.completed_at
    ) THEN
      RAISE EXCEPTION
        'FAIL terminal receipt has a mutable child without its exact tuple marker';
    END IF;
  END LOOP;

  SELECT h.tournament_id INTO v_row
    FROM public.tournament_terminal_settlements h
   ORDER BY h.tournament_id LIMIT 1;
  IF FOUND THEN
    SELECT jsonb_build_object(
      'payouts',(SELECT count(*) FROM public.tournament_payouts p
                  WHERE p.tournament_id=v_row.tournament_id),
      'obligations',(SELECT count(*) FROM public.tournament_obligations o
                      WHERE o.tournament_id=v_row.tournament_id),
      'wallet_transactions',(SELECT count(*) FROM public.wallet_transactions w
                              WHERE w.related_entity_id=v_row.tournament_id),
      'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r
               WHERE r.tournament_id=v_row.tournament_id),
      'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
                 WHERE e.tournament_id=v_row.tournament_id),
      'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
                  WHERE h.tournament_id=v_row.tournament_id),
      'tables',(SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id) FROM public.tables tb
                 WHERE tb.tournament_id=v_row.tournament_id),
      'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
                WHERE tb.tournament_id=v_row.tournament_id))
      INTO v_before;
    SELECT * INTO v_row FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id=v_row.tournament_id;
    v_result := public.fn_complete_tournament_terminal(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    v_replay := public.fn_complete_tournament_terminal(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    v_outcome := public.fn_resolve_tournament_terminal_outcome(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    SELECT jsonb_build_object(
      'payouts',(SELECT count(*) FROM public.tournament_payouts p
                  WHERE p.tournament_id=v_row.tournament_id),
      'obligations',(SELECT count(*) FROM public.tournament_obligations o
                      WHERE o.tournament_id=v_row.tournament_id),
      'wallet_transactions',(SELECT count(*) FROM public.wallet_transactions w
                              WHERE w.related_entity_id=v_row.tournament_id),
      'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r
               WHERE r.tournament_id=v_row.tournament_id),
      'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
                 WHERE e.tournament_id=v_row.tournament_id),
      'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
                  WHERE h.tournament_id=v_row.tournament_id),
      'tables',(SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id) FROM public.tables tb
                 WHERE tb.tournament_id=v_row.tournament_id),
      'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
                WHERE tb.tournament_id=v_row.tournament_id))
      INTO v_after;
    IF v_replay IS DISTINCT FROM v_result
       OR v_replay::text IS DISTINCT FROM v_result::text
       OR v_before IS DISTINCT FROM v_after
       OR COALESCE((v_outcome->>'terminal_committed')::boolean,false) IS NOT TRUE
       OR v_outcome->'receipt' IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION 'FAIL wrapper replay or serialized outcome changed durable state';
    END IF;
    BEGIN
      UPDATE public.tournament_terminal_settlements
         SET settled_at = settled_at
       WHERE tournament_id = v_row.tournament_id;
    EXCEPTION WHEN restrict_violation THEN
      v_immutable_refused := true;
    END;
    IF NOT v_immutable_refused THEN
      RAISE EXCEPTION 'FAIL immutable terminal receipt accepted an update';
    END IF;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: stage-one terminal cash, bounty, mystery, attributed rake, exact escrow/table closure, every present receipt replay, serialized outcome and service ACL pass; all probe work rolled back';
END;
$probe$;
