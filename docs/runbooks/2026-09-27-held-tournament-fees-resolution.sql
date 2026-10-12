-- Resolve the 18 held tournament fees (741.86 chips). NOT YET EXECUTED.
--
-- Prerequisite: migration 20260927221954_an_agreement_baseline_is_in_force_from_inception
-- is installed (step 0 refuses otherwise). Read the migration header first.
--
-- WHY fn_settle_tournament_rake AND NOT fn_ca_begin_legacy_fee_resolution DIRECTLY
-- fn_ca_begin_legacy_fee_resolution only writes the resolution row and the
-- captured sources; it moves no chips. Its capture admission is guarded by a
-- deferred trigger that refuses to commit without the same-transaction
-- resolution, and fn_ca_legacy_fee_resolution_write_is_exact admits the
-- escrow, rake-settlement and ledger writes of a terminal-closed event ONLY
-- when the resolution row carries txid_current(). The settlement lane doctrine
-- (20260918213339) names fn_settle_tournament_rake as the one caller. A
-- stand-alone call would commit a resolution no later transaction could ever
-- settle, stranding the fee for good. fn_settle_tournament_rake calls
-- fn_ca_begin_legacy_fee_resolution first, in the same transaction, then banks
-- the fee (Midway: union rake wallet; DSS: standalone retirement, which is how
-- every standalone club fee is booked) and recognizes every captured source.
--
-- RUN RULES
--  * psql against production as postgres, ONE event per transaction (the
--    global settlement lane lock is held for the whole transaction and pauses
--    hand settlement; each event measured in the dry run is 1..85 sources).
--  * Never inside the hourly break window (:50..:03 UTC); step 0 refuses.
--  * Re-running is safe: an event with a resolution row is skipped, and
--    fn_settle_tournament_rake is idempotent on tournament_rake_settlements.
--  * Recognition lands in the week the script runs (recognized_at = now()).
--    Step 0 refuses if that week is already closed for Midway or DSS.
--
--  * Run as: psql -v ON_ERROR_STOP=1 -f <this file>. Through execute_sql, send the
--    WHOLE file in one call: the plan table and resolver are temporary objects
--    that live for one session. A failed event stops the run; the events
--    already committed stay committed and a re-run skips them.

-- ---------------------------------------------------------------------------
-- The ledger of what each event must do (from the read-only dry run).
-- net = obligation amount; dest = tournament_rake_settlements.destination;
-- sources = accounting_tournament_fee_sources after capture;
-- agent = sum of agent_commissions the recognition posts.
CREATE TEMP TABLE held_fee_plan(tournament_id uuid PRIMARY KEY, net numeric, dest text, sources int, agent numeric);
INSERT INTO held_fee_plan VALUES
  ('b1fdf860-2fdd-40da-8fff-ef37e650ddc8'::uuid,120.00,'union:fade0000-0000-0000-0000-000000000001',80,90.25), -- Midweek Mystery (Midway)
  ('2421c66f-6f02-40a2-8414-23379802ce23'::uuid,69.00,'union:fade0000-0000-0000-0000-000000000001',46,53.36), -- Turbo Tuesday PKO (Midway)
  ('8fc76450-534a-4877-97b5-8f784a3d5daa'::uuid,127.50,'union:fade0000-0000-0000-0000-000000000001',85,96.47), -- Monday Knockout (Midway)
  ('2d2319d4-09e4-4921-85f3-09832ca7f9da'::uuid,54.00,'union:fade0000-0000-0000-0000-000000000001',54,40.61), -- Midweek Bounty (Midway)
  ('199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,1.20,'union:fade0000-0000-0000-0000-000000000001',3,0.73), -- 5 Chip Deep Stack Spin NLH (Midway)
  ('e3f4e2ab-8397-43e8-8643-6cec3fff3a63'::uuid,4.80,'union:fade0000-0000-0000-0000-000000000001',3,3.53), -- 20 Chip Deep Stack Spin PLO4 (Midway)
  ('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid,2.70,'union:fade0000-0000-0000-0000-000000000001',27,2.08), -- Early Bird Freeroll NLH (Midway)
  ('18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6'::uuid,2.40,'union:fade0000-0000-0000-0000-000000000001',3,1.76), -- 10 Chip Spin PLO6 (Midway)
  ('f670ca7c-5134-4a22-9426-eea2601c300a'::uuid,24.00,'union:fade0000-0000-0000-0000-000000000001',3,17.61), -- 100 Chip Spin PLO5 (Midway)
  ('1ffbd637-9241-4957-902f-3a75e09892c0'::uuid,127.50,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',85,108.42), -- Monday Knockout (DSS)
  ('7834a033-8bf0-4a6b-bccf-9f4f6e78a9b9'::uuid,120.00,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',80,103.67), -- Midweek Mystery (DSS)
  ('80443725-b71c-4fc6-bc09-ceaf650809b3'::uuid,54.00,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',54,45.61), -- Midweek Bounty (DSS)
  ('f370585d-40ea-4085-bb8f-c7e8c74f3fb4'::uuid,17.00,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',34,14.70), -- Breakfast Turbo (DSS)
  ('808ef798-0942-4ce0-9ae1-eeefaaf4b0a9'::uuid,0.48,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',3,0.43), -- 2 Chip Deep Stack Spin PLO4 (DSS)
  ('b60c7add-6b38-4549-b091-601f64d118a0'::uuid,0.24,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',3,0.21), -- 1 Chip Deep Stack Spin PLO4 (DSS)
  ('f3f050f1-569e-4fb6-859f-86b6092e682e'::uuid,4.80,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',3,4.12), -- 20 Chip Deep Stack Spin PLO6 (DSS)
  ('5090c03b-2b36-456a-b301-485493280a51'::uuid,12.00,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',3,10.79), -- 50 Chip Spin PLO4 (DSS)
  ('c59c8fe4-a6a8-41f5-b436-c9c55dc0f088'::uuid,0.24,'chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',3,0.21) -- 1 Chip Spin PLO5 (DSS)
;

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT (read-only). Refuses unless every precondition holds.
DO $pre$
DECLARE n int; s numeric;
BEGIN
  IF extract(minute FROM now() AT TIME ZONE 'UTC') >= 50 OR extract(minute FROM now() AT TIME ZONE 'UTC') < 4 THEN
    RAISE EXCEPTION 'inside the hourly break window; run after :03 UTC';
  END IF;
  IF md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamptz)'::regprocedure)) <> 'e6e3bf7235783485b29c64198ea39566'
     OR md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz)'::regprocedure)) <> '31601ee35b7c067ecbe30cf7d689255b'
     OR md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)'::regprocedure)) <> '8473e50ff5435efd8cc909f99c261541'
     OR md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure)) <> '6a4d1f7dff10c76902beafa9069e0970'
     OR md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)) <> '55975e55bd6efb128b3cd7a2de6a687f' THEN
    RAISE EXCEPTION 'migration 20260927221954 is not installed as reviewed';
  END IF;
  SELECT count(*), sum(o.amount) INTO n, s FROM public.accounting_tournament_fee_custody_obligations o
    JOIN held_fee_plan p USING (tournament_id)
   WHERE o.amount = p.net AND o.reason = 'tournament_fee_sources_require_reconciliation';
  IF n <> 18 OR s <> 741.86 THEN RAISE EXCEPTION 'obligations differ from the plan: % events, % chips', n, s; END IF;
  IF EXISTS (SELECT 1 FROM held_fee_plan p JOIN public.tournament_escrow e USING (tournament_id)
              WHERE NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions r WHERE r.tournament_id = p.tournament_id)
                AND (e.fee_balance <> p.net OR e.prize_balance <> 0 OR e.bounty_balance <> 0)) THEN
    RAISE EXCEPTION 'an unresolved event''s escrow no longer holds exactly its fee';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_routed_settlement_runs x
              WHERE x.period_start <= now() AND x.period_end > now()
                AND (x.union_id = 'fade0000-0000-0000-0000-000000000001' OR x.standalone_club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')) THEN
    RAISE EXCEPTION 'the current accounting week is already closed for Midway or DSS; wait for the next week';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_commission_settlements s
              WHERE s.club_id IN ('a0000000-0000-0000-0000-000000000001','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')
                AND now() >= s.period_start AND now() < s.period_end) THEN
    RAISE EXCEPTION 'agent commissions for the current period are already settled for JAQK, SHARK or DSS';
  END IF;
  RAISE NOTICE 'preflight ok: 18 events, 741.86 chips';
END
$pre$;

-- 0b. OPTIONAL PROBE, one event, rolled back (no DDL; holds the lane lock ~1s):
--   BEGIN; SELECT public.fn_settle_tournament_rake('199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,'legacy_fee_resolution'); ROLLBACK;

-- ---------------------------------------------------------------------------
-- 1. The per-event resolver. Skips an event already resolved; otherwise settles
--    it through the rake owner and refuses unless the outcome matches the plan.
CREATE FUNCTION pg_temp.resolve_held_fee(p_tournament_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE p record; r jsonb; n int; s numeric; a numeric;
BEGIN
  SELECT * INTO p FROM held_fee_plan WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not in the plan: %', p_tournament_id; END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id = p_tournament_id) THEN
    RAISE NOTICE 'already resolved: %', p_tournament_id;
    RETURN jsonb_build_object('skipped', true, 'tournament_id', p_tournament_id);
  END IF;
  r := public.fn_settle_tournament_rake(p_tournament_id, 'legacy_fee_resolution');
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE OR COALESCE((r->>'already_settled')::boolean, false)
     OR (r->>'amount')::numeric IS DISTINCT FROM p.net OR r->>'destination' IS DISTINCT FROM p.dest THEN
    RAISE EXCEPTION 'settlement differs from the plan for %: %', p_tournament_id, r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions
                  WHERE tournament_id = p_tournament_id AND transaction_id = txid_current() AND amount = p.net) THEN
    RAISE EXCEPTION 'no same-transaction resolution for %', p_tournament_id;
  END IF;
  SELECT count(*), sum(rake_credit) INTO n, s FROM public.accounting_tournament_fee_sources WHERE tournament_id = p_tournament_id;
  SELECT COALESCE(sum(c.amount), 0) INTO a FROM public.agent_commissions c
   WHERE c.source_type = 'tournament_fee_accrual'
     AND c.source_id IN (SELECT id FROM public.accounting_tournament_fee_sources WHERE tournament_id = p_tournament_id);
  IF n <> p.sources OR s <> p.net OR a <> p.agent THEN
    RAISE EXCEPTION 'attribution differs from the dry run for %: % sources / % credit / % agent (expected % / % / %)',
      p_tournament_id, n, s, a, p.sources, p.net, p.agent;
  END IF;
  RETURN r;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. One transaction per event.
-- Midweek Mystery (Midway): 120.00 chips -> union:fade0000-0000-0000-0000-000000000001; 80 sources; agent commissions 90.25
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('b1fdf860-2fdd-40da-8fff-ef37e650ddc8'::uuid);
COMMIT;

-- Turbo Tuesday PKO (Midway): 69.00 chips -> union:fade0000-0000-0000-0000-000000000001; 46 sources; agent commissions 53.36
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('2421c66f-6f02-40a2-8414-23379802ce23'::uuid);
COMMIT;

-- Monday Knockout (Midway): 127.50 chips -> union:fade0000-0000-0000-0000-000000000001; 85 sources; agent commissions 96.47
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('8fc76450-534a-4877-97b5-8f784a3d5daa'::uuid);
COMMIT;

-- Midweek Bounty (Midway): 54.00 chips -> union:fade0000-0000-0000-0000-000000000001; 54 sources; agent commissions 40.61
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('2d2319d4-09e4-4921-85f3-09832ca7f9da'::uuid);
COMMIT;

-- 5 Chip Deep Stack Spin NLH (Midway): 1.20 chips -> union:fade0000-0000-0000-0000-000000000001; 3 sources; agent commissions 0.73
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid);
COMMIT;

-- 20 Chip Deep Stack Spin PLO4 (Midway): 4.80 chips -> union:fade0000-0000-0000-0000-000000000001; 3 sources; agent commissions 3.53
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('e3f4e2ab-8397-43e8-8643-6cec3fff3a63'::uuid);
COMMIT;

-- Early Bird Freeroll NLH (Midway): 2.70 chips -> union:fade0000-0000-0000-0000-000000000001; 27 sources; agent commissions 2.08
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid);
COMMIT;

-- 10 Chip Spin PLO6 (Midway): 2.40 chips -> union:fade0000-0000-0000-0000-000000000001; 3 sources; agent commissions 1.76
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6'::uuid);
COMMIT;

-- 100 Chip Spin PLO5 (Midway): 24.00 chips -> union:fade0000-0000-0000-0000-000000000001; 3 sources; agent commissions 17.61
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('f670ca7c-5134-4a22-9426-eea2601c300a'::uuid);
COMMIT;

-- Monday Knockout (DSS): 127.50 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 85 sources; agent commissions 108.42
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('1ffbd637-9241-4957-902f-3a75e09892c0'::uuid);
COMMIT;

-- Midweek Mystery (DSS): 120.00 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 80 sources; agent commissions 103.67
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('7834a033-8bf0-4a6b-bccf-9f4f6e78a9b9'::uuid);
COMMIT;

-- Midweek Bounty (DSS): 54.00 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 54 sources; agent commissions 45.61
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('80443725-b71c-4fc6-bc09-ceaf650809b3'::uuid);
COMMIT;

-- Breakfast Turbo (DSS): 17.00 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 34 sources; agent commissions 14.70
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('f370585d-40ea-4085-bb8f-c7e8c74f3fb4'::uuid);
COMMIT;

-- 2 Chip Deep Stack Spin PLO4 (DSS): 0.48 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 3 sources; agent commissions 0.43
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('808ef798-0942-4ce0-9ae1-eeefaaf4b0a9'::uuid);
COMMIT;

-- 1 Chip Deep Stack Spin PLO4 (DSS): 0.24 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 3 sources; agent commissions 0.21
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('b60c7add-6b38-4549-b091-601f64d118a0'::uuid);
COMMIT;

-- 20 Chip Deep Stack Spin PLO6 (DSS): 4.80 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 3 sources; agent commissions 4.12
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('f3f050f1-569e-4fb6-859f-86b6092e682e'::uuid);
COMMIT;

-- 50 Chip Spin PLO4 (DSS): 12.00 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 3 sources; agent commissions 10.79
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('5090c03b-2b36-456a-b301-485493280a51'::uuid);
COMMIT;

-- 1 Chip Spin PLO5 (DSS): 0.24 chips -> chip_retirement:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3; 3 sources; agent commissions 0.21
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.resolve_held_fee('c59c8fe4-a6a8-41f5-b436-c9c55dc0f088'::uuid);
COMMIT;

-- ---------------------------------------------------------------------------
-- 3. VERIFICATION (read-only). Every row must show ok = true.
SELECT p.tournament_id, p.net,
  r.amount = p.net AND r.transaction_id IS NOT NULL                                  AS resolved,
  e.fee_balance = 0 AND e.fee_out = p.net                                            AS escrow_emptied,
  s.amount = p.net AND s.destination = p.dest AND s.settled_at IS NOT NULL
    AND s.attribution_error IS NULL AND s.attributed_users > 0                       AS settled,
  q.status = 'recognized' AND q.net_rake = p.net                                     AS recognized,
  (SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id = p.tournament_id) = p.sources AS sources,
  (SELECT COALESCE(sum(c.amount),0) FROM public.agent_commissions c WHERE c.source_type = 'tournament_fee_accrual'
     AND c.source_id IN (SELECT f.id FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id = p.tournament_id)) = p.agent AS agent_commissions
FROM held_fee_plan p
LEFT JOIN public.accounting_tournament_fee_custody_resolutions r USING (tournament_id)
LEFT JOIN public.tournament_escrow e USING (tournament_id)
LEFT JOIN public.tournament_rake_settlements s USING (tournament_id)
LEFT JOIN public.accounting_tournament_fee_recognitions q USING (tournament_id)
ORDER BY p.dest, p.tournament_id;

-- Totals: 18 resolutions, 741.86; Midway union rake credits 405.60; DSS retired 336.26.
SELECT
 (SELECT count(*) FROM public.accounting_tournament_fee_custody_resolutions r JOIN held_fee_plan USING (tournament_id)) AS resolutions,
 (SELECT sum(r.amount) FROM public.accounting_tournament_fee_custody_resolutions r JOIN held_fee_plan USING (tournament_id)) AS resolved_chips,
 (SELECT sum(t.amount) FROM public.union_wallet_transactions t WHERE t.union_id = 'fade0000-0000-0000-0000-000000000001'
    AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
    AND EXISTS (SELECT 1 FROM held_fee_plan p WHERE position('[tournament '||p.tournament_id::text||']' IN COALESCE(t.notes,'')) > 0)) AS midway_union_banked,
 (SELECT sum(l.amount) FROM public.chip_ledger l WHERE l.to_type = 'chip_retirement' AND l.category = 'burn'
    AND l.tournament_id IN (SELECT tournament_id FROM held_fee_plan)) AS dss_retired,
 (SELECT count(*) FROM public.financial_alerts a WHERE a.created_at > now() - interval '1 hour'
    AND a.context->>'tournament_id' IN (SELECT tournament_id::text FROM held_fee_plan)) AS new_alerts;
