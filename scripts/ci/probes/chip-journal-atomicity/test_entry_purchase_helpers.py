"""Entry-purchase receipt and maintenance helpers run against real PG17 bodies."""


def verify_entry_purchase_helpers(run):
    request="jsonb_build_object('table_id','10000000-0000-4000-8000-000000000001','amount',5)"
    response="jsonb_build_object('success',true,'balance',15)"
    scenarios_passed=0

    def verify(sql):
        nonlocal scenarios_passed
        run(sql)
        scenarios_passed+=1

    verify(f"""
BEGIN;
DO $verify$
DECLARE v_claim jsonb; v_response jsonb;
BEGIN
  v_claim := public.fn_claim_entry_purchase_receipt('probe', NULL, {request});
  v_response := public.fn_record_entry_purchase_receipt('probe', NULL, {request}, {response});
  PERFORM public.fn_release_entry_purchase_claim('probe', NULL, {request});
  IF v_claim->>'claimed' IS DISTINCT FROM 'true'
     OR v_response IS DISTINCT FROM {response}
     OR EXISTS (SELECT 1 FROM public.entry_purchase_idempotency_receipts) THEN
    RAISE EXCEPTION 'unkeyed receipt helpers changed durable state';
  END IF;
END $verify$;
ROLLBACK;
""")

    verify(f"""
BEGIN;
DO $verify$
DECLARE v_claim jsonb; v_response jsonb; caught boolean := false;
BEGIN
  v_claim := public.fn_claim_entry_purchase_receipt('probe', 'complete', {request});
  IF v_claim->>'claimed' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'first receipt claim was not owned';
  END IF;
  BEGIN
    PERFORM public.fn_claim_entry_purchase_receipt('probe', 'complete', {request});
  EXCEPTION WHEN SQLSTATE '55000' THEN
    caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'incomplete committed-style claim was replayable'; END IF;

  v_response := public.fn_record_entry_purchase_receipt(
    'probe', 'complete', {request}, {response}
  );
  v_claim := public.fn_claim_entry_purchase_receipt('probe', 'complete', {request});
  IF v_response IS DISTINCT FROM {response}
     OR v_claim->>'claimed' IS DISTINCT FROM 'false'
     OR v_claim->'response' IS DISTINCT FROM {response} THEN
    RAISE EXCEPTION 'completed receipt did not replay its exact response';
  END IF;
  IF public.fn_record_entry_purchase_receipt(
       'probe', 'complete', {request}, {response}
     ) IS DISTINCT FROM {response} THEN
    RAISE EXCEPTION 'repeat completion did not return the recorded response';
  END IF;

  caught := false;
  BEGIN
    PERFORM public.fn_claim_entry_purchase_receipt(
      'probe', 'complete', jsonb_build_object('amount', 6)
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'receipt key accepted a different request'; END IF;
  PERFORM public.fn_release_entry_purchase_claim('probe', 'complete', {request});
  IF (SELECT count(*) FROM public.entry_purchase_idempotency_receipts) <> 1 THEN
    RAISE EXCEPTION 'release removed a completed receipt';
  END IF;
END $verify$;
ROLLBACK;
""")

    verify(f"""
BEGIN;
DO $verify$
DECLARE v_claim jsonb;
BEGIN
  PERFORM public.fn_claim_entry_purchase_receipt('probe', 'release', {request});
  PERFORM public.fn_release_entry_purchase_claim(
    'probe', 'release', jsonb_build_object('amount', 6)
  );
  IF (SELECT count(*) FROM public.entry_purchase_idempotency_receipts) <> 1 THEN
    RAISE EXCEPTION 'mismatched request released a claim';
  END IF;
  PERFORM public.fn_release_entry_purchase_claim('probe', 'release', {request});
  IF EXISTS (SELECT 1 FROM public.entry_purchase_idempotency_receipts) THEN
    RAISE EXCEPTION 'matching incomplete claim was not released';
  END IF;
  v_claim := public.fn_claim_entry_purchase_receipt('probe', 'release', {request});
  IF v_claim->>'claimed' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'released key could not be claimed again';
  END IF;
END $verify$;
ROLLBACK;
""")

    verify(f"""
BEGIN;
DO $verify$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.fn_claim_entry_purchase_receipt('probe', 'rollback', {request});
    PERFORM public.fn_record_entry_purchase_receipt(
      'probe', 'rollback', {request}, {response}
    );
    RAISE EXCEPTION 'forced rollback' USING ERRCODE = 'XX001';
  EXCEPTION WHEN SQLSTATE 'XX001' THEN
    caught := true;
  END;
  IF NOT caught
     OR EXISTS (SELECT 1 FROM public.entry_purchase_idempotency_receipts) THEN
    RAISE EXCEPTION 'receipt claim/completion survived transaction rollback';
  END IF;
END $verify$;
ROLLBACK;
""")

    verify(f"""
BEGIN;
DO $verify$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.entry_purchase_idempotency_receipts
      (key_domain, idempotency_key, request)
    VALUES ('', 'empty-domain', {request});
  EXCEPTION WHEN SQLSTATE '23514' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'empty receipt domain bypassed the production constraint';
  END IF;
  caught := false;
  BEGIN
    INSERT INTO public.entry_purchase_idempotency_receipts
      (key_domain, idempotency_key, request)
    VALUES ('probe', '', {request});
  EXCEPTION WHEN SQLSTATE '23514' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'empty receipt key bypassed the production constraint';
  END IF;
  caught := false;
  PERFORM public.fn_claim_entry_purchase_receipt(
    'probe', 'immutable-incomplete', {request}
  );
  BEGIN
    UPDATE public.entry_purchase_idempotency_receipts
       SET request = jsonb_build_object('amount', 6)
     WHERE key_domain = 'probe' AND idempotency_key = 'immutable-incomplete';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'incomplete receipt request was mutable';
  END IF;
  PERFORM public.fn_release_entry_purchase_claim(
    'probe', 'immutable-incomplete', {request}
  );
  caught := false;
  PERFORM public.fn_claim_entry_purchase_receipt('probe', 'immutable', {request});
  PERFORM public.fn_record_entry_purchase_receipt(
    'probe', 'immutable', {request}, {response}
  );
  BEGIN
    UPDATE public.entry_purchase_idempotency_receipts
       SET response = jsonb_build_object('success', false)
     WHERE key_domain = 'probe' AND idempotency_key = 'immutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'completed receipt response was mutable';
  END IF;
  caught := false;
  BEGIN
    DELETE FROM public.entry_purchase_idempotency_receipts
     WHERE key_domain = 'probe' AND idempotency_key = 'immutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'completed receipt was deletable';
  END IF;
END $verify$;
ROLLBACK;
""")

    verify("""
BEGIN;
DO $verify$
BEGIN
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'empty maintenance state froze entry';
  END IF;
  INSERT INTO public.engine_maintenance_break(id, phase, announced_at, break_ends_at)
  VALUES (true, 'last_hand', clock_timestamp(), NULL);
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'current last-hand state did not freeze entry';
  END IF;
  UPDATE public.engine_maintenance_break
     SET announced_at = clock_timestamp() - interval '8 minutes';
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'durable last-hand recovery row failed open before exact clear';
  END IF;
  UPDATE public.engine_maintenance_break
     SET announced_at = clock_timestamp() + interval '1 minute';
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'future last-hand state froze entry';
  END IF;
  UPDATE public.engine_maintenance_break
     SET phase = 'counting_down',
         announced_at = clock_timestamp(),
         break_started_at = clock_timestamp(),
         break_ends_at = clock_timestamp() + interval '5 minutes';
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'active countdown did not freeze entry';
  END IF;
  UPDATE public.engine_maintenance_break
     SET announced_at = clock_timestamp() - interval '7 minutes',
         break_started_at = clock_timestamp() - interval '5 minutes',
         break_ends_at = clock_timestamp() - interval '1 second';
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'expired countdown failed open before checkpointed thaw';
  END IF;
  UPDATE public.engine_maintenance_break
     SET break_ends_at = clock_timestamp() + interval '16 minutes';
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'unbounded future countdown froze entry';
  END IF;
END $verify$;
ROLLBACK;
""")

    club="'00000000-0000-4000-8000-000000000001'"
    table="'00000000-0000-4000-8000-000000000002'"
    member="'00000000-0000-4000-8000-000000000003'"
    user="'00000000-0000-4000-8000-000000000004'"
    fund_op="'00000000-0000-4000-8000-000000000005'"
    seat_op="'00000000-0000-4000-8000-000000000006'"
    verify(f"""
BEGIN;
INSERT INTO clubs(id) VALUES({club});
INSERT INTO tables(id,club_id) VALUES({table},{club});
INSERT INTO club_members(id,user_id,club_id) VALUES({member},{user},{club});
INSERT INTO table_seats VALUES({table},{user},1,10,false,NULL);
INSERT INTO public.engine_maintenance_break(
  id, phase, announced_at, break_started_at, break_ends_at
)
VALUES(
  true, 'counting_down', clock_timestamp() - interval '2 minutes',
  clock_timestamp(), clock_timestamp() + interval '5 minutes'
);
DO $verify$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_horse_fund_from_treasury({table},{user},5,{fund_op});
  IF v_result->>'deferred' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'frozen horse reload was not deferred';
  END IF;
  v_result := public.fn_horse_seat_from_treasury({table},{user},2,5,{seat_op});
  IF v_result->>'deferred' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'frozen horse seat was not deferred';
  END IF;
  IF (SELECT chip_treasury FROM clubs WHERE id={club}) <> 100
     OR (SELECT stack FROM table_seats WHERE table_id={table} AND user_id={user}) <> 10
     OR EXISTS (SELECT 1 FROM chip_ledger)
     OR EXISTS (SELECT 1 FROM chip_transactions)
     OR EXISTS (SELECT 1 FROM cash_baselines)
     OR EXISTS (SELECT 1 FROM entry_purchase_idempotency_receipts) THEN
    RAISE EXCEPTION 'frozen horse entry moved money or retained a claim';
  END IF;
END $verify$;
ROLLBACK;
""")

    # A completed funding receipt is the committed outcome, even if a
    # maintenance freeze begins before the caller receives it and retries.
    # Authorization and exact request matching still run before that replay;
    # a changed payload must never borrow the prior success.
    replay_op="'00000000-0000-4000-8000-000000000007'"
    verify(f"""
BEGIN;
INSERT INTO clubs(id) VALUES({club});
INSERT INTO tables(id,club_id) VALUES({table},{club});
INSERT INTO club_members(id,user_id,club_id) VALUES({member},{user},{club});
INSERT INTO table_seats VALUES({table},{user},1,10,false,NULL);
DO $verify$
DECLARE
  v_first jsonb;
  v_replay jsonb;
  v_before jsonb;
  v_after jsonb;
  caught boolean := false;
BEGIN
  v_first := public.fn_horse_fund_from_treasury(
    {table}, {user}, 5, {replay_op}
  );
  IF v_first->>'success' IS DISTINCT FROM 'true'
     OR v_first->>'replayed' IS NOT NULL
     OR (v_first->>'new_stack')::numeric <> 15 THEN
    RAISE EXCEPTION 'first horse funding did not return its exact success receipt';
  END IF;

  INSERT INTO public.engine_maintenance_break(
    id, phase, announced_at, break_started_at, break_ends_at
  ) VALUES (
    true, 'counting_down', clock_timestamp() - interval '2 minutes',
    clock_timestamp(), clock_timestamp() + interval '5 minutes'
  );
  SELECT jsonb_build_array(
    (SELECT to_jsonb(c) FROM clubs c WHERE id = {club}),
    (SELECT to_jsonb(s) FROM table_seats s
      WHERE table_id = {table} AND user_id = {user}),
    (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
       FROM chip_ledger l),
    (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
       FROM chip_transactions t),
    (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.user_id, b.table_id), '[]'::jsonb)
       FROM cash_baselines b),
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.key_domain, r.idempotency_key), '[]'::jsonb)
       FROM entry_purchase_idempotency_receipts r)
  ) INTO v_before;

  v_replay := public.fn_horse_fund_from_treasury(
    {table}, {user}, 5, {replay_op}
  );
  SELECT jsonb_build_array(
    (SELECT to_jsonb(c) FROM clubs c WHERE id = {club}),
    (SELECT to_jsonb(s) FROM table_seats s
      WHERE table_id = {table} AND user_id = {user}),
    (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
       FROM chip_ledger l),
    (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
       FROM chip_transactions t),
    (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.user_id, b.table_id), '[]'::jsonb)
       FROM cash_baselines b),
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.key_domain, r.idempotency_key), '[]'::jsonb)
       FROM entry_purchase_idempotency_receipts r)
  ) INTO v_after;
  IF v_replay->>'success' IS DISTINCT FROM 'true'
     OR v_replay->>'replayed' IS DISTINCT FROM 'true'
     OR v_replay->>'op_id' IS DISTINCT FROM trim(both '''' from {replay_op}::text)
     OR (v_replay->>'new_stack')::numeric <> 15
     OR v_before IS DISTINCT FROM v_after
     OR (SELECT count(*) FROM entry_purchase_idempotency_receipts
          WHERE key_domain = 'horse_funding') <> 1 THEN
    RAISE EXCEPTION 'maintenance changed or duplicated the committed funding replay';
  END IF;

  BEGIN
    PERFORM public.fn_horse_fund_from_treasury(
      {table}, {user}, 6, {replay_op}
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'maintenance let a changed payload borrow a funding receipt';
  END IF;
END $verify$;
ROLLBACK;
""")

    print(
        f"TOTAL entry purchase helpers: {scenarios_passed} PostgreSQL scenarios passed",
        flush=True,
    )
