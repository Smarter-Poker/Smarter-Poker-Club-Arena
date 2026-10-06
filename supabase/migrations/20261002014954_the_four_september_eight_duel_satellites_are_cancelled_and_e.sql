-- 20261002014954_the_four_september_eight_duel_satellites_are_cancelled_and_e.sql
--
-- THE FOUR SEPTEMBER 8 DUEL SATELLITES ARE CANCELLED AND EVERY ENTRY REFUNDED
-- (2026-10-02)
--
-- @live-proof: (SELECT count(*) FROM public.tournaments t JOIN public.tournament_cancellation_receipts c ON c.tournament_id = t.id JOIN public.tournament_escrow e ON e.tournament_id = t.id WHERE t.id IN ('097e3601-ccf9-4035-af40-eb35068d2652','20c75b67-7f78-4b29-b7df-9594faf62af0','92c93927-614f-4168-a1f9-918849c0be19','a4262ba0-cd5f-4a94-a0f8-915a028cf3a7') AND t.status = 'CANCELLED' AND e.prize_balance = 0 AND e.fee_balance = 0 AND e.bounty_balance = 0 AND e.closed_at IS NOT NULL) = 4
--
-- WHAT WAS READ (production, 2026-10-02 ~01:50 UTC, read-only): four
-- heads-up duel satellites created on 2026-09-08 still read REGISTERING,
-- started_at NULL, prize_pool_finalized, every entry in an open escrow:
--   097e3601 Sunday $200 Deep Stack Satellite Heads-Up   2 x 150.00 (142.50 + 7.50)
--   20c75b67 DSS Tuesday $22 NLH Deepstack Satellite HU  2 x  15.00 ( 14.25 + 0.75)
--   92c93927 Wednesday Feature Satellite Heads-Up        2 x  15.00 ( 14.25 + 0.75)
--   a4262ba0 Six-Card Feature Satellite Heads-Up         2 x  15.00 ( 14.25 + 0.75)
--   Total entries 390.00 = 370.50 prize escrow + 19.50 fee escrow.
-- No launch receipt, no hand_history, no obligation, no payout, no
-- cancellation receipt. Each entrant holds one wallet_charge refund
-- entitlement whose source ledger, wallet debit and escrow rail agree. Every
-- entrant is a horse; they are refunded exactly as people are.
--
-- WHY CANCEL: they cannot be settled. The satellite authority settles the
-- entry fee through fn_settle_tournament_rake and refuses (P0404) an
-- unattributed fee; a 2026-09-08 fee predates every recorded agreement and
-- the legacy custody cohort excludes satellites (#5754). Their targets
-- (13dd6b98, b6774df2, f9e22dd2, d2910755) completed between 2026-09-09 and
-- 2026-09-15, so the seat they were played for no longer exists to award.
-- A satellite whose prize cannot be delivered is void: every entrant gets
-- back the whole buy-in and fee. Nothing is taken from anyone.
--
-- THE PATH: the platform's audited cancellation authority,
-- atomic_cancel_tournament (live md5 0aea21224182e48dc5a466e4592a09e4), once
-- per event, as the service role (the managed-lifecycle guard admits only
-- the engine's role to cancel a registered event). It pays each entitlement
-- through fn_settle_tournament_refund_exact (wallet credit, refund tranche,
-- obligation), reverses each fee's rake record, closes the escrow at exact
-- zero, releases seats and tables, writes the immutable cancellation receipt
-- and the accounting cancellation. tournaments_cancel_must_refund (deferred)
-- re-proves at COMMIT that no paid entry is left unrefunded. This file
-- writes no money row itself.
--
-- GUARDS: refuses in the break window; pre-image of the cancellation
-- authority (md5/owner/security definer/volatility/config/ACL) and of each
-- event (status, start, pool, fee, escrow banks and rails, entitlements,
-- roster, no receipt/payout/obligation/hand, target completed). No row is
-- locked before the authority takes its settlement lane. Post-image: each
-- event CANCELLED with ended_at, receipt total_refunded = 2 x gross and
-- fees_reversed = 2 x fee, escrow zero and closed, every entrant's refund
-- tranche and wallet credit equal to the entry they paid.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_reason text;
  v_rows jsonb;
  v_ev record;
  v_n integer;
  v_receipt jsonb;
  v_total numeric := 0;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure
       AND md5(p.prosrc) = '0aea21224182e48dc5a466e4592a09e4'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.proconfig::text = '{"search_path=public, extensions, pg_temp",statement_timeout=120s}'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_AUTHORITY_CHANGED: atomic_cancel_tournament is not the body read'
      USING ERRCODE = '40001';
  END IF;

  -- tournament, registration, user, entitlement gross / prize / fee (read 2026-10-02)
  v_rows := $rows$[
    {"t":"097e3601-ccf9-4035-af40-eb35068d2652","p":"ebe32eb0-4224-40d2-a5a5-3a3a4b45dbdd","u":"7f2fcb20-a23c-4003-b2de-f23c01460d71","gross":150.00,"prize":142.50,"fee":7.50},
    {"t":"097e3601-ccf9-4035-af40-eb35068d2652","p":"7a76747d-6fc2-42ef-83a9-27fd4f5a2a5e","u":"8ba5f4d2-91ce-4d7b-9182-192663784a92","gross":150.00,"prize":142.50,"fee":7.50},
    {"t":"20c75b67-7f78-4b29-b7df-9594faf62af0","p":"57ed198d-c4f2-40c0-b2f2-b7f1b4737cc3","u":"6b3f4393-3ccb-491d-bce2-361b3385defe","gross":15.00,"prize":14.25,"fee":0.75},
    {"t":"20c75b67-7f78-4b29-b7df-9594faf62af0","p":"208c4209-f1b7-470c-ab40-bd76339afe78","u":"e0f03a88-afc3-448f-835a-e8e323d09b57","gross":15.00,"prize":14.25,"fee":0.75},
    {"t":"92c93927-614f-4168-a1f9-918849c0be19","p":"e92e8919-0440-41c4-83ce-8d7e4667e029","u":"e5a834e5-bae7-4acd-8be9-a3c995a52395","gross":15.00,"prize":14.25,"fee":0.75},
    {"t":"92c93927-614f-4168-a1f9-918849c0be19","p":"dbebaa3c-6035-48fb-b0ca-029c37f0b629","u":"eaf09a18-9654-4c18-8c5d-48a26ce72259","gross":15.00,"prize":14.25,"fee":0.75},
    {"t":"a4262ba0-cd5f-4a94-a0f8-915a028cf3a7","p":"85b75092-ba86-43b8-a4a6-dfd134646955","u":"8ef81aac-30ee-4ad5-bc83-20f15046f37d","gross":15.00,"prize":14.25,"fee":0.75},
    {"t":"a4262ba0-cd5f-4a94-a0f8-915a028cf3a7","p":"2b29e1d4-b39d-4f01-9c1c-670171de4baf","u":"d27088a8-f517-4281-9f17-7181e2f8d13b","gross":15.00,"prize":14.25,"fee":0.75}
  ]$rows$::jsonb;

  IF jsonb_array_length(v_rows) <> 8
     OR (SELECT count(DISTINCT e->>'t') FROM jsonb_array_elements(v_rows) e) <> 4
     OR (SELECT sum((e->>'gross')::numeric) FROM jsonb_array_elements(v_rows) e) <> 390.00 THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_SET_CHANGED';
  END IF;

  -- Pre-image, read without row locks: the authority takes its lane first.
  FOR v_ev IN SELECT (e->>'t')::uuid AS tournament_id,
                     sum((e->>'gross')::numeric) AS gross,
                     sum((e->>'prize')::numeric) AS prize,
                     sum((e->>'fee')::numeric) AS fee
                FROM jsonb_array_elements(v_rows) e GROUP BY 1 ORDER BY 1 LOOP
    IF NOT EXISTS (
         SELECT 1 FROM public.tournaments t
           JOIN public.tournament_escrow e ON e.tournament_id = t.id
           JOIN public.tournaments g ON g.id = t.satellite_target_id
          WHERE t.id = v_ev.tournament_id
            AND t.status = 'REGISTERING' AND t.started_at IS NULL AND t.ended_at IS NULL
            AND t.max_players = 2 AND COALESCE(t.spin_multiplier, 0) = 0
            AND t.prize_pool = v_ev.prize AND t.total_rake = v_ev.fee
            AND COALESCE(t.bounty_pool, 0) = 0
            AND e.enforced AND e.closed_at IS NULL
            AND e.gross_in = v_ev.gross AND e.fee_entries_in = v_ev.fee
            AND e.prize_balance = v_ev.prize AND e.fee_balance = v_ev.fee
            AND e.bounty_balance = 0 AND e.satellite_in = 0 AND e.satellite_fee_in = 0
            AND upper(g.status) = 'COMPLETED')
       OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r WHERE r.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts r WHERE r.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_payouts x WHERE x.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches r WHERE r.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.hand_history h WHERE h.tournament_id = v_ev.tournament_id)
       OR (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = v_ev.tournament_id) <> 2
       OR (SELECT count(*) FROM public.tournament_refund_entitlements r WHERE r.tournament_id = v_ev.tournament_id) <> 2 THEN
      RAISE EXCEPTION 'SEP8_DUEL_CANCEL_PREIMAGE: % is not the event read on 2026-10-02',
        v_ev.tournament_id USING ERRCODE = '40001';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_rows) e
    JOIN public.tournament_players tp
      ON tp.id = (e->>'p')::uuid AND tp.tournament_id = (e->>'t')::uuid
     AND tp.user_id = (e->>'u')::uuid
    JOIN public.tournament_refund_entitlements r
      ON r.tournament_id = tp.tournament_id AND r.user_id = tp.user_id
     AND r.entitlement_kind = 'wallet_charge'
     AND r.gross = (e->>'gross')::numeric
     AND r.refund_prize = (e->>'prize')::numeric
     AND r.refund_fee = (e->>'fee')::numeric AND r.refund_bounty = 0
    JOIN public.wallet_transactions w
      ON w.related_entity_id = tp.tournament_id AND w.user_id = tp.user_id
     AND w.type = 'debit' AND w.category = 'tournament_buyin'
     AND w.amount = (e->>'gross')::numeric;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_ENTRY_PREIMAGE: % of 8 entries match the read', v_n
      USING ERRCODE = '40001';
  END IF;

  -- The cancellation authority, as the service role, one event at a time.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  FOR v_ev IN SELECT (e->>'t')::uuid AS tournament_id,
                     sum((e->>'gross')::numeric) AS gross,
                     sum((e->>'fee')::numeric) AS fee
                FROM jsonb_array_elements(v_rows) e GROUP BY 1 ORDER BY 1 LOOP
    v_receipt := public.atomic_cancel_tournament(v_ev.tournament_id, NULL);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'total_refunded')::numeric IS DISTINCT FROM v_ev.gross
       OR (v_receipt->>'fees_reversed')::numeric IS DISTINCT FROM v_ev.fee THEN
      RAISE EXCEPTION 'SEP8_DUEL_CANCEL_RECEIPT: % returned %', v_ev.tournament_id, v_receipt;
    END IF;
    v_total := v_total + v_ev.gross;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  -- Post-image.
  SELECT count(*) INTO v_n
    FROM public.tournaments t
    JOIN public.tournament_escrow e ON e.tournament_id = t.id
    JOIN public.tournament_cancellation_receipts c ON c.tournament_id = t.id
   WHERE t.id IN (SELECT DISTINCT (x->>'t')::uuid FROM jsonb_array_elements(v_rows) x)
     AND t.status = 'CANCELLED' AND t.ended_at IS NOT NULL
     AND t.prize_pool = 0 AND t.total_rake = 0
     AND e.prize_balance = 0 AND e.fee_balance = 0 AND e.bounty_balance = 0
     AND e.closed_at IS NOT NULL
     AND c.total_rake_after = 0;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_POSTIMAGE: % of 4 events closed at exact zero', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_rows) e
   WHERE (SELECT count(*) FROM public.tournament_refund_tranches tr
           WHERE tr.tournament_id = (e->>'t')::uuid AND tr.user_id = (e->>'u')::uuid
             AND tr.amount_paid_now = (e->>'gross')::numeric) = 1
     AND (SELECT round(COALESCE(sum(w.amount), 0), 2) FROM public.wallet_transactions w
           WHERE w.related_entity_id = (e->>'t')::uuid AND w.user_id = (e->>'u')::uuid
             AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund'))
         = (e->>'gross')::numeric;
  IF v_n <> 8 OR v_total <> 390.00 THEN
    RAISE EXCEPTION 'SEP8_DUEL_CANCEL_POSTIMAGE: % of 8 entrants refunded exactly (% of 390.00)', v_n, v_total;
  END IF;

  RAISE NOTICE 'SEP8_DUELS_CANCELLED: 4 satellites, 8 entries, 390.00 refunded (370.50 prize + 19.50 fee)';
END
$mig$;

COMMIT;
