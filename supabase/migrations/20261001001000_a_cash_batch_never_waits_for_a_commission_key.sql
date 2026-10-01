-- ============================================================================
-- A CASH BATCH NEVER WAITS FOR A COMMISSION KEY
-- ============================================================================
--
-- Follows 20261001000000_the_chip_estate_takes_its_locks_in_one_order, which had
-- fn_credit_agent_commissions_batch and fn_retry_cash_accounting_sources take every club
-- commission key ('agent-commission:<club>') they would need, in club order, before their
-- first item. Those waits sit outside the per-item refusal blocks. The engine's role has
-- lock_timeout 8s, and a tournament finish holds a club's key for the rest of its run, so
-- at 2026-10-01 00:07:30 UTC a batch waited 8 s on one and failed WHOLE ("canceling
-- statement due to lock timeout" at that line). The settler holds its cursor on a failed
-- batch: production's rakeback_settler cursor has not moved since 00:03:25 UTC - no cash
-- commission accrual since then. Before that change the same wait happened inside an item,
-- where a timeout refuses that item for retry and the batch goes on.
--
-- Now both take the keys only while they are free: pg_try_advisory_xact_lock, in club order,
-- and the walk stops at the first key someone holds. Nothing waits outside an item any more;
-- the keys not taken here are taken item by item in trg_agent_commission_rollup_insert as
-- before, where a timeout is one item's refusal. With every key free (nearly always) the
-- batch holds them all in club order, as intended; with one held it degrades to the order
-- it had before 20261001000000, never to a failed batch.
--
-- Two asserted substitutions over the pinned live text (each clause once, result md5 asserted,
-- reverse proved, owner and grants unchanged).
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-01, and AFTER:
--   fn_credit_agent_commissions_batch  5ebf5489eabbe478d393e2e040683fe8 -> d4572f3e1efd9c85a0025cc2906c6fae
--   fn_retry_cash_accounting_sources   4b62b13c70191e56fe55644070303a97 -> 3788581d5e8f1953663b8929b4688d0a
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'd4572f3e1efd9c85a0025cc2906c6fae' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '3788581d5e8f1953663b8929b4688d0a' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_def text; v_after text; v_n integer; v_acl text;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('fn_credit_agent_commissions_batch(jsonb)', '5ebf5489eabbe478d393e2e040683fe8', 'd4572f3e1efd9c85a0025cc2906c6fae',
      E' -- EVERY CLUB''S COMMISSION KEY FIRST, IN CLUB ORDER (2026-10-01). This batch is\n'
      || E' -- one transaction over many hands: it keeps each item''s rows until it ends,\n'
      || E' -- so it cannot take the clubs'' commission keys item by item without taking\n'
      || E' -- them out of order. It takes them all here, before its first item and in\n'
      || E' -- club order, for the clubs its cash items earn in (the attributions the\n'
      || E' -- accrual plan reads); trg_agent_commission_rollup_insert takes them in club\n'
      || E' -- order for every other writer. An item the set misses still takes its key\n'
      || E' -- in the trigger. Nothing is written here and no item is refused here.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT (x.value->>''source_id'')::uuid FROM jsonb_array_elements(p_items) x\n'
      || E'     WHERE x.value->>''source_type''=''cash_rake_record''\n'
      || E'       AND x.value->>''source_id'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  PERFORM pg_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n',
      E' -- EVERY FREE CLUB COMMISSION KEY FIRST, IN CLUB ORDER, WITHOUT WAITING (2026-10-01).\n'
      || E' -- This batch is one transaction over many hands and keeps each item''s rows to\n'
      || E' -- its end, so it takes the commission keys of the clubs its cash items earn in\n'
      || E' -- here, before its first item, in club order - but only while they are free:\n'
      || E' -- the first key a tournament finish holds stops the walk. A wait here would\n'
      || E' -- put the whole batch behind the role''s lock_timeout, and a timeout here fails\n'
      || E' -- every item at once (2026-10-01 00:07:30, which held the settler''s cursor).\n'
      || E' -- The rest are taken item by item in trg_agent_commission_rollup_insert, where\n'
      || E' -- a timeout refuses one item for retry, as before. Nothing is written here.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT (x.value->>''source_id'')::uuid FROM jsonb_array_elements(p_items) x\n'
      || E'     WHERE x.value->>''source_type''=''cash_rake_record''\n'
      || E'       AND x.value->>''source_id'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n'),
    ('fn_retry_cash_accounting_sources(integer)', '4b62b13c70191e56fe55644070303a97', '3788581d5e8f1953663b8929b4688d0a',
      E' -- EVERY CLUB''S COMMISSION KEY FIRST, IN CLUB ORDER (2026-10-01), as\n'
      || E' -- fn_credit_agent_commissions_batch takes them: this retry is one transaction\n'
      || E' -- over many sources too. Read from the rows the loop below selects; a source\n'
      || E' -- that becomes due in between still takes its key in the trigger.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s\n'
      || E'     WHERE s.status=''blocked'' AND s.next_attempt_at<=clock_timestamp()\n'
      || E'     ORDER BY s.next_attempt_at,s.rake_record_id LIMIT p_limit))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  PERFORM pg_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n',
      E' -- EVERY FREE CLUB COMMISSION KEY FIRST, IN CLUB ORDER, WITHOUT WAITING (2026-10-01),\n'
      || E' -- as fn_credit_agent_commissions_batch takes them: this retry is one transaction\n'
      || E' -- over many sources too, and a wait here would fail all of them at the role''s\n'
      || E' -- lock_timeout. Read from the rows the loop below selects; the rest are taken\n'
      || E' -- item by item in the trigger.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s\n'
      || E'     WHERE s.status=''blocked'' AND s.next_attempt_at<=clock_timestamp()\n'
      || E'     ORDER BY s.next_attempt_at,s.rake_record_id LIMIT p_limit))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n')
  ) AS x(signature, before_md5, after_md5, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_def) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', s.signature, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, s.old_text, ''))) / length(s.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the clause to change occurs % times in %, expected exactly 1', v_n, s.signature;
    END IF;
    SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure;
    EXECUTE replace(v_def, s.old_text, s.new_text);
    v_after := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the text the harness measured (md5 %)', s.signature, md5(v_after);
    END IF;
    IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', s.signature;
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure) IS DISTINCT FROM v_acl
       OR has_function_privilege('anon', 'public.' || s.signature, 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.' || s.signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.' || s.signature, 'EXECUTE') THEN
      RAISE EXCEPTION '%: grants moved', s.signature;
    END IF;
    IF position('pg_advisory_xact_lock(hashtextextended(''agent-commission:''' IN v_after) > 0 THEN
      RAISE EXCEPTION '%: still waits for a commission key outside an item', s.signature;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  RAISE NOTICE 'a cash batch never waits for a commission key: two bodies changed, nothing else';
END $subs$;

COMMIT;
