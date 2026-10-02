-- 20261002061026_the_september_eight_games_finish_refused_alerts_close.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SEPTEMBER 8 GAMES' FINISH-REFUSED ALERTS CLOSE (2026-10-02)
--
-- WHAT HAPPENED: before 20261001225325 launched the 26 September 8 Spins and
-- heads-up Sit & Gos, the engine tried to finish each of them and was refused
-- (they were still REGISTERING), raising one CRITICAL
-- Tournament.atomic_finish_refused alert per event (refusal_reason "other",
-- proven_refusal true) at ~2026-10-02 00:21 UTC. At 02:16-02:22 UTC the
-- engine's terminal lane finished all 26: status COMPLETED, an immutable
-- terminal receipt with one cash payout equal to the finalized pool, exactly
-- one tournament_payouts row equal to the pool to the winner, prize and
-- bounty escrow at zero (1,223.10 paid in all). 20261002034540 (#5779)
-- closed the same events' outcome-unknown alerts on that proof; these 26
-- refusal alerts are still open although the retry they wait for has
-- settled. Read-only 2026-10-02 06:10 UTC: all 26 events match, each with
-- exactly one open refusal alert.
--
-- WHAT THIS FILE DOES: resolves exactly those 26 alerts (resolved,
-- resolved_at, resolution note), each only after its own event is proven
-- settled as above, through the ordinary path: the alert trigger
-- (zz_ca_alert_resolution_reaches_the_incident) closes the drift incident and
-- the mirror alert of each. It writes no money row, creates no function and
-- changes no closer: HELD PR #5723 (the general closer for this class) is
-- untouched and, when applied, finds these already resolved.
--
-- GUARDS: refuses in the break window; every alert must be open, from
-- Tournament.atomic_finish_refused, naming its event; every event COMPLETED
-- with one payout = pool to the receipt's winner and zero prize and bounty
-- escrow; pools sum to 1,223.10. Post-image: 0 of the 26 open.
--
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolved = false AND source = 'Tournament.atomic_finish_refused' AND id IN ('3fab3abc-4d0b-405c-962f-bed65f2a5eca','aff7d819-1775-40ae-8e05-d0f3eb83e835','40ec961d-ac19-4aa1-af1f-346dc3ca6a9b','49e236e2-3881-4a0c-9fb8-8f71052ba189','e20ae7ea-c2e8-4650-ae1b-83c3544d52f8','c90c9d20-c002-4b9b-9770-a3b20243e881','a23cdfbd-3739-470a-a790-6167f288c35d','4c8d4e57-ca7e-461e-aeed-887a4390cb81','3d93bafb-b8fc-4321-a35b-b097c3a35d8b','ed9549e3-4486-45ac-9a1f-6b98992fab72','7c4b47ca-b3b5-41fa-ba18-f57aa485feb9','43694f1b-da58-45e7-abd2-d4ec0c14699e','a20a04c1-29d4-490d-8bf0-f57bd4a0fda9','74f6de83-8abb-4a7c-84ee-d903f9b4221d','a3858a2f-41fc-484a-ba13-749eba6d11ac','6e052cb4-7fa0-4750-98ea-c80ac13203b4','f85fcc52-0d8d-4d61-bd3e-51d484cbb2d1','add69d0b-ba5d-45c0-9f39-aa667ee40fa4','f149b353-43c7-4f8c-a990-4aa6d1b3ccf0','b47600ff-96c3-44f2-af75-2d6c23ad63a0','966b8802-6226-4eff-9dc8-4ab33e22c9cc','30b8a03e-6583-488d-bb86-f36aa5795a35','d63ab3f1-0002-4558-9f50-fbc98c27f923','5a9db6e6-21da-4405-a9cd-aa7775a9712c','06096700-4aba-4b85-b965-a8ae518b3e30','08935915-8786-4656-a51b-5459c4694b80')) = 0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _sep8_finish_refused (alert_id uuid PRIMARY KEY, tournament_id uuid UNIQUE NOT NULL) ON COMMIT DROP;
INSERT INTO _sep8_finish_refused (alert_id, tournament_id) VALUES
('3fab3abc-4d0b-405c-962f-bed65f2a5eca','00f57d7b-db16-4307-8e40-a47e24d4aa29'),
('aff7d819-1775-40ae-8e05-d0f3eb83e835','106c4e13-0da7-4b62-b849-119781d25d4f'),
('40ec961d-ac19-4aa1-af1f-346dc3ca6a9b','2aa4cba1-506f-426b-a1ba-d8e22e018533'),
('49e236e2-3881-4a0c-9fb8-8f71052ba189','2d6dadb7-d1cb-4e03-980f-41fafce98afd'),
('e20ae7ea-c2e8-4650-ae1b-83c3544d52f8','3843907b-dc12-40c3-9641-d2c66f4ebe7c'),
('c90c9d20-c002-4b9b-9770-a3b20243e881','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa'),
('a23cdfbd-3739-470a-a790-6167f288c35d','482e90bb-ef9d-4135-9067-9f0332c94142'),
('4c8d4e57-ca7e-461e-aeed-887a4390cb81','659d3ec6-c584-42ea-956d-5fc2004ba566'),
('3d93bafb-b8fc-4321-a35b-b097c3a35d8b','6d359f61-d681-49ba-82f3-00493178e5b3'),
('ed9549e3-4486-45ac-9a1f-6b98992fab72','7284506c-093c-491a-8da7-5816bf1ccccf'),
('7c4b47ca-b3b5-41fa-ba18-f57aa485feb9','8904c10b-6a47-4934-bdf2-def1b1e76f0b'),
('43694f1b-da58-45e7-abd2-d4ec0c14699e','8c6a20c5-a422-4177-8b93-efa371d5c14d'),
('a20a04c1-29d4-490d-8bf0-f57bd4a0fda9','8d5969da-df76-44fa-8c83-5608b844ca06'),
('74f6de83-8abb-4a7c-84ee-d903f9b4221d','90c4d93f-4577-4da2-bd9b-51b774019971'),
('a3858a2f-41fc-484a-ba13-749eba6d11ac','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1'),
('6e052cb4-7fa0-4750-98ea-c80ac13203b4','9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8'),
('f85fcc52-0d8d-4d61-bd3e-51d484cbb2d1','ab4125bc-a85e-45c6-b0a7-22417d75c0c5'),
('add69d0b-ba5d-45c0-9f39-aa667ee40fa4','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99'),
('f149b353-43c7-4f8c-a990-4aa6d1b3ccf0','b5fae1b3-b900-4670-85ef-76e3aa646734'),
('b47600ff-96c3-44f2-af75-2d6c23ad63a0','b67ab0cb-e2d6-4955-8f43-4bff32551400'),
('966b8802-6226-4eff-9dc8-4ab33e22c9cc','c2fd1c7e-9572-4b95-90dd-3b999777a145'),
('30b8a03e-6583-488d-bb86-f36aa5795a35','dae6db50-4f35-4ffd-b8f5-b9f95d104c10'),
('d63ab3f1-0002-4558-9f50-fbc98c27f923','e62a97cc-40a8-4d70-a89d-04ca4cc20834'),
('5a9db6e6-21da-4405-a9cd-aa7775a9712c','efd5455d-d188-4171-becb-1d35b016d06a'),
('06096700-4aba-4b85-b965-a8ae518b3e30','f58d6375-4bb4-4f80-a673-0460fcf2c1be'),
('08935915-8786-4656-a51b-5459c4694b80','f5a6896b-b739-40e0-9f73-680ee36bc532');

DO $pre$
DECLARE
  v_reason text;
  v_bad text;
  v_pool numeric;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_FINISH_REFUSED_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.tournament_id::text || ':' || x.why, ', ') INTO v_bad
    FROM (
      SELECT f.tournament_id,
             CASE
               WHEN a.id IS NULL THEN 'alert missing'
               WHEN a.resolved THEN 'alert already resolved'
               WHEN a.source IS DISTINCT FROM 'Tournament.atomic_finish_refused' THEN 'alert source'
               WHEN a.context->>'tournament_id' IS DISTINCT FROM f.tournament_id::text THEN 'alert event'
               WHEN t.status IS DISTINCT FROM 'COMPLETED' THEN 'not COMPLETED'
               WHEN s.tournament_id IS NULL THEN 'no terminal receipt'
               WHEN s.cash_payout_count IS DISTINCT FROM 1 OR s.cash_payout_total IS DISTINCT FROM t.prize_pool
                 OR s.winner_id IS NULL THEN 'receipt not one payout = pool'
               WHEN (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id) <> 1
                 OR (SELECT sum(p.amount) FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id) IS DISTINCT FROM t.prize_pool
                 OR NOT EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id = f.tournament_id AND p.user_id = s.winner_id)
                 THEN 'payout row not one = pool to the winner'
               WHEN e.tournament_id IS NULL OR e.prize_balance IS DISTINCT FROM 0::numeric
                 OR e.bounty_balance IS DISTINCT FROM 0::numeric THEN 'escrow not zero'
               ELSE NULL
             END AS why
        FROM _sep8_finish_refused f
        LEFT JOIN public.financial_alerts a ON a.id = f.alert_id
        LEFT JOIN public.tournaments t ON t.id = f.tournament_id
        LEFT JOIN public.tournament_terminal_settlements s ON s.tournament_id = f.tournament_id
        LEFT JOIN public.tournament_escrow e ON e.tournament_id = f.tournament_id
    ) x
   WHERE x.why IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_FINISH_REFUSED_PREIMAGE: %', v_bad USING ERRCODE = '55000';
  END IF;

  SELECT sum(t.prize_pool) INTO v_pool
    FROM _sep8_finish_refused f JOIN public.tournaments t ON t.id = f.tournament_id;
  IF (SELECT count(*) FROM _sep8_finish_refused) <> 26 OR v_pool IS DISTINCT FROM 1223.10 THEN
    RAISE EXCEPTION 'SEP8_FINISH_REFUSED_PREIMAGE: % events, pools % (expected 26 and 1223.10)',
      (SELECT count(*) FROM _sep8_finish_refused), v_pool USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $resolve$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = 'settled after the refusal: tournament ' || f.tournament_id::text
           || ' was refused finishing while still REGISTERING; it was then launched (20261001225325) and finished '
           || 'by its terminal authority: COMPLETED with its immutable terminal receipt, one payout of '
           || t.prize_pool::text || ' (the whole finalized pool) to the winner ' || s.winner_id::text
           || ', prize and bounty escrow 0.00. The retry this alert waited for has settled; nothing is owed '
           || 'and nobody was paid twice. Same proof as its outcome-unknown alert (20261002034540). migration 20261002061026'
    FROM _sep8_finish_refused f
    JOIN public.tournaments t ON t.id = f.tournament_id
    JOIN public.tournament_terminal_settlements s ON s.tournament_id = f.tournament_id
   WHERE fa.id = f.alert_id
     AND fa.resolved = false
     AND fa.source = 'Tournament.atomic_finish_refused';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 26 THEN
    RAISE EXCEPTION 'SEP8_FINISH_REFUSED_RESOLVE: resolved % alerts, expected 26', v_n USING ERRCODE = '55000';
  END IF;
END
$resolve$;

DO $post$
DECLARE
  v_open integer;
BEGIN
  SELECT count(*) INTO v_open
    FROM public.financial_alerts fa JOIN _sep8_finish_refused f ON f.alert_id = fa.id
   WHERE fa.resolved = false OR fa.resolved_at IS NULL OR fa.resolution IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'SEP8_FINISH_REFUSED_POSTIMAGE: % of the 26 alerts still open', v_open USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
