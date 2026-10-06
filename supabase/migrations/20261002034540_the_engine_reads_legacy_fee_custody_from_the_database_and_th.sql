-- 20261002034540_the_engine_reads_legacy_fee_custody_from_the_database_and_th.sql
--
-- THE ENGINE READS LEGACY FEE CUSTODY FROM THE DATABASE, AND THE 26 FALSE
-- "OUTCOME UNKNOWN" ALERTS CLOSE (2026-10-02)
--
-- WHAT HAPPENED: at 2026-10-02 02:16-02:22 UTC the 26 September 8 Spins and
-- heads-up Sit & Gos launched by 20261001225325 were finished by the engine's
-- terminal lane. Each committed its immutable terminal receipt
-- (tournament_terminal_settlements, receipt_version 3): status COMPLETED, one
-- tournament_payouts row equal to the finalized pool (1,223.10 in all), prize
-- and bounty escrow at zero, and the pre-agreement entry fee (94.42 in all)
-- held in legacy fee custody, because every one of them is a member of
-- fn_ca_legacy_fee_custody_cohort. The engine's receipt verifier
-- (server/src/tournament/completionSettlementReceipt.ts) recognised custody
-- only for 13 event ids compiled into it, so it rejected all 26 committed
-- receipts ("serialized committed receipt was invalid"), reported each as
-- "outcome unknown", stopped its table engines and raised 26 CRITICAL
-- Tournament.atomic_finish_outcome_unknown alerts. Nobody was unpaid and
-- nobody was paid twice: the alerts are false.
--
-- WHAT THIS FILE DOES:
--   1. fn_ca_legacy_fee_custody_origin(uuid): a read-only, service-role-only
--      answer of the original held fee for a custody event (amount, source
--      fingerprint and source count from fn_ca_legacy_fee_custody_cohort, which
--      reads accounting_tournament_fee_custody_obligations once custody is
--      held, plus the recognized source count). The engine verifies a version 3
--      receipt field for field against this instead of a compiled list (same
--      PR). It takes no lock and writes nothing.
--   2. Resolves the 26 alerts through the ordinary path (resolved, resolved_at,
--      resolution note; the alert trigger closes the drift incident mirroring
--      them), each only after its event is proven settled: COMPLETED, a
--      terminal receipt with one cash payout equal to the pool, exactly one
--      payout row equal to the pool, prize and bounty escrow zero, and the fee
--      balance equal to its legacy custody obligation.
--
-- NOT HERE: the 26 Tournament.atomic_finish_refused alerts raised for the same
-- events before the launch are the class PR #5723 closes; they are untouched.
--
-- GUARDS: refuses in the break window; the cohort function must match the
-- live pre-image read 2026-10-02 (md5, owner, ACL, proconfig, prosecdef,
-- provolatile); the origin function must not exist yet; each alert must still
-- be open, from its source, for its event. Post-image: ACL exact, origin
-- answers exactly for two cohort events and NULL for a non-member, 0 of the 26
-- alerts open.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _sep8_false_unknown (alert_id uuid PRIMARY KEY, tournament_id uuid UNIQUE NOT NULL) ON COMMIT DROP;
INSERT INTO _sep8_false_unknown (alert_id, tournament_id) VALUES
('2dc3c6b4-7587-4394-8ad1-2677c58e5ad7','00f57d7b-db16-4307-8e40-a47e24d4aa29'),
('734a5989-4cfa-4513-89bf-5dc556f53371','106c4e13-0da7-4b62-b849-119781d25d4f'),
('b1e45a44-45a4-436c-931c-c61bb41169c2','2aa4cba1-506f-426b-a1ba-d8e22e018533'),
('15a49c40-28e8-4cdf-a7b2-ee16a8291886','2d6dadb7-d1cb-4e03-980f-41fafce98afd'),
('a843c22b-1ac4-4af7-85b7-cdce31b8d8cf','3843907b-dc12-40c3-9641-d2c66f4ebe7c'),
('ff243892-e92f-467a-b6a8-8bf5bc14f846','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa'),
('d20c9947-1a00-4ff6-ad48-fb9692c11403','482e90bb-ef9d-4135-9067-9f0332c94142'),
('a01927cc-0524-4407-b671-5c43a9dd46a6','659d3ec6-c584-42ea-956d-5fc2004ba566'),
('027b77aa-5b7a-4b59-9f21-12536025cec6','6d359f61-d681-49ba-82f3-00493178e5b3'),
('710724ff-ce5f-4d5f-8ea2-fef23fabbb81','7284506c-093c-491a-8da7-5816bf1ccccf'),
('b11aa046-ac63-4df7-9348-0773d43df26d','8904c10b-6a47-4934-bdf2-def1b1e76f0b'),
('691094ff-4b45-4959-9ce6-c65a39f018ed','8c6a20c5-a422-4177-8b93-efa371d5c14d'),
('9bf05432-a68c-4dc5-a170-3f2ab9d67443','8d5969da-df76-44fa-8c83-5608b844ca06'),
('48fb90c4-a478-437a-9f18-051a382d737b','90c4d93f-4577-4da2-bd9b-51b774019971'),
('fb7a5735-0b88-4e26-8702-1ea7167347ea','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1'),
('55d5746e-4110-4e54-9de6-9c7560c9d4c2','9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8'),
('6389efec-cf8a-48bb-95ca-0fc2f1c80e8e','ab4125bc-a85e-45c6-b0a7-22417d75c0c5'),
('3fa23cd8-efaf-406c-b85b-897205343393','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99'),
('8cba7fc9-a62e-4e81-980e-b701466db002','b5fae1b3-b900-4670-85ef-76e3aa646734'),
('11ddfdf0-923a-415c-a69b-387f2a66938b','b67ab0cb-e2d6-4955-8f43-4bff32551400'),
('b917132f-13b5-4e8d-92f9-533bde7b4371','c2fd1c7e-9572-4b95-90dd-3b999777a145'),
('1f4ddcb9-a221-42d4-87f5-fd98b354e7b2','dae6db50-4f35-4ffd-b8f5-b9f95d104c10'),
('6701597c-f9eb-4e85-812c-a8e5b6b0fa8a','e62a97cc-40a8-4d70-a89d-04ca4cc20834'),
('1504368b-51ba-4877-bccc-542a4d3a7853','efd5455d-d188-4171-becb-1d35b016d06a'),
('46237d7b-9f76-49d6-a01a-8596378b9b28','f58d6375-4bb4-4f80-a673-0460fcf2c1be'),
('db00e272-00b1-440f-b7a0-d266010a6654','f5a6896b-b739-40e0-9f73-680ee36bc532');

DO $pre$
DECLARE
  v_reason text;
  v_fn record;
  v_bad text;
  v_pool numeric;
  v_fee numeric;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  SELECT md5(p.prosrc) AS src, p.proowner::regrole::text AS owner, p.proacl::text AS acl,
         p.proconfig::text AS config, p.prosecdef AS secdef, p.provolatile AS vol
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = 'public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure;
  IF v_fn.src IS DISTINCT FROM '6585a51a27e08bd16cbbfae3cf6d8b82'
     OR v_fn.owner IS DISTINCT FROM 'postgres'
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.config IS DISTINCT FROM '{search_path=public}'
     OR v_fn.secdef IS DISTINCT FROM true
     OR v_fn.vol IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_PREIMAGE: fn_ca_legacy_fee_custody_cohort is not the function read on 2026-10-02 (%)', row_to_json(v_fn)
      USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_ca_legacy_fee_custody_origin(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_PREIMAGE: fn_ca_legacy_fee_custody_origin already exists'
      USING ERRCODE = '55000';
  END IF;

  -- Every alert open, from its source, naming its event; every event settled.
  SELECT string_agg(x.tournament_id::text || ':' || x.why, ', ') INTO v_bad
    FROM (
      SELECT f.tournament_id,
             CASE
               WHEN a.id IS NULL THEN 'alert missing'
               WHEN a.resolved THEN 'alert already resolved'
               WHEN a.source IS DISTINCT FROM 'Tournament.atomic_finish_outcome_unknown' THEN 'alert source'
               WHEN a.context->>'tournament_id' IS DISTINCT FROM f.tournament_id::text THEN 'alert event'
               WHEN t.status IS DISTINCT FROM 'COMPLETED' THEN 'not COMPLETED'
               WHEN s.tournament_id IS NULL THEN 'no terminal receipt'
               WHEN s.cash_payout_count IS DISTINCT FROM 1 OR s.cash_payout_total IS DISTINCT FROM t.prize_pool
                 OR s.winner_id IS NULL OR s.receipt_version IS DISTINCT FROM 3
                 OR s.accounting_state IS DISTINCT FROM 'fee_custody_unresolved' THEN 'receipt not one payout = pool in custody'
               WHEN (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id) <> 1
                 OR (SELECT sum(p.amount) FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id) IS DISTINCT FROM t.prize_pool
                 OR NOT EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id AND p.user_id = s.winner_id)
                 THEN 'payout row not one = pool to the winner'
               WHEN e.tournament_id IS NULL OR e.prize_balance IS DISTINCT FROM 0::numeric
                 OR e.bounty_balance IS DISTINCT FROM 0::numeric THEN 'escrow not zero'
               WHEN o.tournament_id IS NULL OR e.fee_balance IS DISTINCT FROM o.amount THEN 'fee not held in legacy custody'
               ELSE NULL
             END AS why
        FROM _sep8_false_unknown f
        LEFT JOIN public.financial_alerts a ON a.id = f.alert_id
        LEFT JOIN public.tournaments t ON t.id = f.tournament_id
        LEFT JOIN public.tournament_terminal_settlements s ON s.tournament_id = f.tournament_id
        LEFT JOIN public.tournament_escrow e ON e.tournament_id = f.tournament_id
        LEFT JOIN public.accounting_tournament_fee_custody_obligations o ON o.tournament_id = f.tournament_id
    ) x
   WHERE x.why IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_FALSE_UNKNOWN_PREIMAGE: %', v_bad USING ERRCODE = '55000';
  END IF;

  SELECT sum(t.prize_pool), sum(e.fee_balance) INTO v_pool, v_fee
    FROM _sep8_false_unknown f
    JOIN public.tournaments t ON t.id = f.tournament_id
    JOIN public.tournament_escrow e ON e.tournament_id = f.tournament_id;
  IF (SELECT count(*) FROM _sep8_false_unknown) <> 26
     OR v_pool IS DISTINCT FROM 1223.10 OR v_fee IS DISTINCT FROM 94.42 THEN
    RAISE EXCEPTION 'SEP8_FALSE_UNKNOWN_PREIMAGE: pools % fee % (expected 1223.10 and 94.42)', v_pool, v_fee
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

CREATE FUNCTION public.fn_ca_legacy_fee_custody_origin(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  -- The original held fee of a legacy fee custody event, from the obligation
  -- row fn_ca_legacy_fee_custody_cohort reads once custody is held. NULL for
  -- any event that holds no custody. Read-only: the engine verifies its
  -- version 3 terminal receipt against this, never against a compiled list.
  SELECT jsonb_build_object(
           'tournament_id', o.tournament_id,
           'amount', c.amount,
           'source_fingerprint', c.source_fingerprint,
           'source_count', c.source_count,
           'recognized_source_count',
             (SELECT count(*) FROM public.accounting_tournament_recognized_sources x
               WHERE x.tournament_id = o.tournament_id))
    FROM public.accounting_tournament_fee_custody_obligations o
    CROSS JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(o.tournament_id) c
   WHERE o.tournament_id = p_tournament_id
     AND c.amount = o.amount
     AND c.source_fingerprint = o.source_fingerprint
$fn$;

COMMENT ON FUNCTION public.fn_ca_legacy_fee_custody_origin(uuid) IS
  'Original held fee of a legacy fee custody event (fn_ca_legacy_fee_custody_cohort over its obligation row); the engine verifies version 3 terminal receipts against it. Read-only. 20261002034540.';

REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_origin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_custody_origin(uuid) TO service_role;

DO $resolve$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = 'verified false alarm: tournament ' || f.tournament_id::text
           || ' is COMPLETED with its immutable terminal receipt (tournament_terminal_settlements, receipt_version 3): '
           || 'one payout of ' || t.prize_pool::text || ' (the whole finalized pool) to the winner '
           || s.winner_id::text || ', prize and bounty escrow 0.00, and the pre-agreement fee '
           || e.fee_balance::text || ' held in legacy fee custody (fn_ca_legacy_fee_custody_cohort). '
           || 'The settlement committed; the engine called it outcome unknown only because its receipt verifier '
           || 'recognised custody for a compiled list of 13 older events. Nothing is owed and nobody was paid twice. '
           || 'Producer fixed in the same PR: the engine reads the custody origin from the database '
           || '(fn_ca_legacy_fee_custody_origin). migration 20261002034540'
    FROM _sep8_false_unknown f
    JOIN public.tournaments t ON t.id = f.tournament_id
    JOIN public.tournament_terminal_settlements s ON s.tournament_id = f.tournament_id
    JOIN public.tournament_escrow e ON e.tournament_id = f.tournament_id
   WHERE fa.id = f.alert_id
     AND fa.resolved = false
     AND fa.source = 'Tournament.atomic_finish_outcome_unknown';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 26 THEN
    RAISE EXCEPTION 'SEP8_FALSE_UNKNOWN_RESOLVE: resolved % alerts, expected 26', v_n USING ERRCODE = '55000';
  END IF;
END
$resolve$;

DO $post$
DECLARE
  v_origin jsonb;
  v_open integer;
BEGIN
  IF NOT has_function_privilege('service_role', 'public.fn_ca_legacy_fee_custody_origin(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_legacy_fee_custody_origin(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_legacy_fee_custody_origin(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.fn_ca_legacy_fee_custody_origin(uuid)'::regprocedure
                   AND a.grantee = 0) THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_POSTIMAGE: ACL is not service_role only' USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.oid = 'public.fn_ca_legacy_fee_custody_origin(uuid)'::regprocedure) IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_POSTIMAGE: not STABLE' USING ERRCODE = '55000';
  END IF;

  v_origin := public.fn_ca_legacy_fee_custody_origin('659d3ec6-c584-42ea-956d-5fc2004ba566');
  IF v_origin IS NULL
     OR (v_origin->>'amount')::numeric IS DISTINCT FROM 2.00
     OR v_origin->>'source_fingerprint' IS DISTINCT FROM 'b87bf1237b4dd2802dcb09a205838c96'
     OR (v_origin->>'source_count')::int IS DISTINCT FROM 2
     OR (v_origin->>'recognized_source_count')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_POSTIMAGE: 659d3ec6 origin %', v_origin USING ERRCODE = '55000';
  END IF;
  v_origin := public.fn_ca_legacy_fee_custody_origin('199a71a9-f364-4e90-a3ba-3cdcfb7755bc');
  IF v_origin IS NULL
     OR (v_origin->>'amount')::numeric IS DISTINCT FROM 1.20
     OR v_origin->>'source_fingerprint' IS DISTINCT FROM 'ceeb0817a40a48f9e7cfdac3883036b7'
     OR (v_origin->>'source_count')::int IS DISTINCT FROM 1
     OR (v_origin->>'recognized_source_count')::int IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_POSTIMAGE: 199a71a9 origin %', v_origin USING ERRCODE = '55000';
  END IF;
  IF public.fn_ca_legacy_fee_custody_origin('00000000-0000-0000-0000-000000000000') IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_CUSTODY_ORIGIN_POSTIMAGE: a non-member has an origin' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_open
    FROM public.financial_alerts fa JOIN _sep8_false_unknown f ON f.alert_id = fa.id
   WHERE fa.resolved = false OR fa.resolved_at IS NULL OR fa.resolution IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'SEP8_FALSE_UNKNOWN_POSTIMAGE: % of the 26 alerts still open', v_open USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
