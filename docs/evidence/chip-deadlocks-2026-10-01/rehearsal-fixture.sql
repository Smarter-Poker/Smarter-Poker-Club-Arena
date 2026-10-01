-- Rehearsal fixture for 20261001000000_the_chip_estate_takes_its_locks_in_one_order.
-- rehearse.sh runs the migration and this file as ONE transaction against production and it rolls
-- back (the last statement raises). Single-session door behaviour only: no second session, no load,
-- no real account, no chip row written; the horse-mind keys below are synthetic.
SET LOCAL lock_timeout = '2s';
DO $fx$
DECLARE r record; v jsonb;
BEGIN
  -- 1. Every body is the text the isolated harness measured.
  FOR r IN SELECT * FROM (VALUES
    ('atomic_distribute_rake', 'ea7a4a403969a0fbe69f2216d63a0436'),
    ('trg_agent_commission_rollup_insert', 'c7e84377219a39d955783d0feae6642b'),
    ('fn_credit_agent_commissions_batch', '5ebf5489eabbe478d393e2e040683fe8'),
    ('fn_retry_cash_accounting_sources', '4b62b13c70191e56fe55644070303a97'),
    ('fn_sync_profile_total_hands', 'f6ee538e4bcfc329dd0e46673b05dc30'),
    ('upsert_horse_mind_pairs', '389109138a65a4d150b48da5ffa209bb'),
    ('upsert_horse_mind_stats', '6802f13c3b1e7b94e62694d1dc1e5fb1'),
    ('upsert_horse_mind_stats_scoped', '199192476497889e659b8455c38ea631')) AS x(f, m)
  LOOP
    IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = r.f) IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'REHEARSAL FAILED: % is not the measured text', r.f;
    END IF;
  END LOOP;

  -- 2. Refusals answer exactly as before, ahead of any key.
  v := public.fn_credit_agent_commissions_batch('{}'::jsonb);
  IF v->>'error' IS DISTINCT FROM 'p_items must be a jsonb array of at most 2000 items' THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: the batch refusal changed: %', v;
  END IF;
  v := public.fn_credit_agent_commissions_batch('[]'::jsonb);
  IF (v->>'ok')::int <> 0 OR (v->>'failed')::int <> 0 OR jsonb_array_length(v->'receipts') <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: an empty batch did something: %', v;
  END IF;
  IF (SELECT applied FROM public.atomic_distribute_rake(NULL::uuid, NULL::uuid, NULL::uuid, 0, 0::numeric)) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: a rake with no club applied';
  END IF;
  BEGIN
    PERFORM public.fn_retry_cash_accounting_sources(0);
    RAISE EXCEPTION 'REHEARSAL FAILED: the retry accepted a zero limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- 3. A flush with a repeated key, listed out of order, leaves the values the old loop left:
  --    GREATEST columns take the larger value, the r_* columns the LAST value listed.
  PERFORM public.upsert_horse_mind_stats('[{"user_id":"rehearsal-20261001-b","hands":5,"r_hands":1.5},{"user_id":"rehearsal-20261001-a","hands":3,"r_hands":2.5},{"user_id":"rehearsal-20261001-b","hands":4,"r_hands":9.5}]'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM public.horse_mind_stats WHERE user_id = 'rehearsal-20261001-b' AND hands = 5 AND r_hands = 9.5)
     OR NOT EXISTS (SELECT 1 FROM public.horse_mind_stats WHERE user_id = 'rehearsal-20261001-a' AND hands = 3 AND r_hands = 2.5) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: horse_mind_stats values moved';
  END IF;
  PERFORM public.upsert_horse_mind_pairs('[{"attacker_id":"rehearsal-20261001-b","victim_id":"v","n3":5},{"attacker_id":"rehearsal-20261001-a","victim_id":"v","n3":3},{"attacker_id":"rehearsal-20261001-b","victim_id":"v","n3":4}]'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM public.horse_mind_pairs WHERE attacker_id = 'rehearsal-20261001-b' AND victim_id = 'v' AND n3 = 5)
     OR NOT EXISTS (SELECT 1 FROM public.horse_mind_pairs WHERE attacker_id = 'rehearsal-20261001-a' AND victim_id = 'v' AND n3 = 3) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: horse_mind_pairs values moved';
  END IF;
  PERFORM public.upsert_horse_mind_stats_scoped('[{"user_id":"rehearsal-20261001-b","scope":"holdem:hu","hands":5},{"user_id":"rehearsal-20261001-a","scope":"holdem:hu","hands":3},{"user_id":"rehearsal-20261001-b","scope":"holdem:hu","hands":4}]'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM public.horse_mind_stats_scoped WHERE user_id = 'rehearsal-20261001-b' AND scope = 'holdem:hu' AND hands = 5)
     OR NOT EXISTS (SELECT 1 FROM public.horse_mind_stats_scoped WHERE user_id = 'rehearsal-20261001-a' AND scope = 'holdem:hu' AND hands = 3) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: horse_mind_stats_scoped values moved';
  END IF;

  RAISE EXCEPTION 'REHEARSAL OK: eight chip bodies take their locks in one order (each md5 as measured), refusals unchanged, horse-mind values unchanged, estate checks passed, nothing opened';
END $fx$;
