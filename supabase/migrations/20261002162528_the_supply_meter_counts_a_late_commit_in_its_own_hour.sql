-- 20261002162528_the_supply_meter_counts_a_late_commit_in_its_own_hour
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 16:25:28 UTC.
--
-- @live-proof: (SELECT position('late_mint' IN pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure)) > 0 AND position('seen_from' IN pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure)) > 0)
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_supply_snapshots' AND column_name IN ('window_mint','window_burn','late_mint','late_burn','seen_from','seen_mint','seen_burn'))
-- @live-proof: (SELECT position('ca-shop-refund-' IN prosrc) > 0 AND position('fn_ca_declare_ledger' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure)
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM public.ca_supply_snapshot_classifications WHERE classification = 'late_commit_counted_in_its_own_hour'))
--
-- Chip-drift launch plan, phase 1 (no silent money failures). Two money doors
-- that misreport: the supply meter tripped the kill switch on chips that never
-- moved, and a player refund refuses by name since 20261002140203.
--
-- ============================================================================
-- 1. THE SUPPLY METER COUNTS A LATE COMMIT IN ITS OWN HOUR
-- ============================================================================
--
-- WHAT HAPPENED. At 15:05 UTC fn_ca_supply_snapshot read -100,005.30
-- unexplained, raised critical incidents 2e00634c / d9ebce90 / 035e55db and
-- crossed the 1,000-chip kill-switch threshold (UNCONFIRMED, so nothing froze).
-- The trailing-4h figure (-99,991.60) also fails
-- scripts/ci/check-chip-conservation.mjs (|trailing| > 5,000) until 19:05, so
-- every engine deploy in that window is refused.
--
-- NO CHIP MOVED WITHOUT ITS LEG. Every store is in refuse mode. Per store, the
-- 14:05 -> 15:05 balance change equals its journal except club_treasury, which
-- fell 99,700.00 more than its legs, and the 15:05 total is short exactly one
-- retired certification club:
--
--   club 43731738 (stale-cert-recovery), retired in ONE transaction that
--   started 14:04:56.07 and committed after the 14:05:00.18 reading:
--     club_treasury -> chip_retirement 99,700.00, bbj_pool 100.00,
--     spin_reserve 200.00 = 100,000.00 burned.
--   Its legs carry created_at 14:04:56 (chip_ledger.created_at is the
--   transaction's START, fn_ca_chip_ledger_enrich: COALESCE(created_at, now()))
--   but xmin 793696749, 1,644 xids before the 14:05:15 retirement: the write
--   happened ~14:05:1x, after the 14:05 reading had read the balances.
--
-- The 14:05 reading did not see the commit (balance still there, legs
-- invisible). The 15:05 reading saw the balance gone, but its window is
-- created_at in (14:05:00.18, 15:05:01.72] and the legs say 14:04:56, so they
-- fell between the two windows forever: -100,000.00 with no counterpart. The
-- remaining -5.30 is ordinary hand traffic. Recounting window 14:05 today
-- finds exactly that 100,000.00 of burn the reading never saw:
--     reading   unexplained   late burn of the window before   corrected
--     14:05          0.68                     0.00                   0.68
--     15:05   -100,005.30               100,000.00                  -5.30
--     16:05          6.01                     0.00                   6.01
-- (rolled-back probe, 2026-10-02 16:20 UTC; same recount for 07:05..13:05
-- finds 0.00 late in every window).
--
-- The same straddle produced the BBJ epoch's one-directional residue (see
-- 20260909101535): any money transaction that starts before a reading and
-- commits after it vanishes from a created_at-windowed meter. Certification
-- churn (100,000.00 per club, ~40 clubs an hour today) makes it large.
--
-- THE TWO DEFECTS.
--   (a) The balances and the ledger window were read in TWO statements, so a
--       transaction committing between them was counted on one side only.
--   (b) A transaction that started before a reading and committed after it
--       is in no window, ever.
--
-- WHAT THIS CHANGES (fn_ca_supply_snapshot only; same stores, same basis,
-- same thresholds, same incident and kill-switch calls):
--   (a) ONE statement reads every balance, this reading's window, and the
--       recount below, so they share one MVCC snapshot. The window ceiling is
--       clock_timestamp() evaluated inside that statement: a transaction
--       visible to it started before the snapshot, so its legs are <= the
--       ceiling; one that is not visible commits later with created_at <= the
--       ceiling and is found by (b).
--   (b) Each reading records what it SAW over the last three hours
--       (seen_from, seen_mint, seen_burn). The next reading recounts exactly
--       that range: whatever is there now and was not then committed late,
--       and is counted in the hour it became visible (late_mint, late_burn).
--       mint_since_prev / burn_since_prev = own window + late. A reading
--       written before this migration has no seen_* columns; the first new
--       reading recounts its window (prev2.taken_at, prev.taken_at] against
--       its stored mint_since_prev / burn_since_prev, which is the same thing.
--       A transaction longer than three hours is still missed, and still loud.
--   A ledger row DELETED inside the recount range reads as negative late
--   issuance. That is correct: the journal was altered.
--   Cost: one extra indexed created_at range of 3 hours (46,861 legs, 5,074
--   of them mint/burn, at 16:20 today).
--
-- THE 15:05 READING IS RECOMPUTED, NOT SET ASIDE. Unlike snapshots 29/30
-- (20260901181833) the true figure is arithmetic anyone can repeat from the
-- journal, so it is written: unexplained -100,005.30 -> -5.30, late_burn
-- 100,000.00, burn_since_prev 2,404,581.58 -> 2,504,581.58. The original is
-- kept in ca_supply_snapshot_classifications with the evidence. Nothing else
-- in the row changes; the balances are real measurements.
--
-- ============================================================================
-- 2. A CHIP SHOP REFUND NAMES WHERE ITS CHIPS COME FROM
-- ============================================================================
--
-- 20261002140203 guarded fn_credit_chips: a caller that names no counterparty
-- is refused by name. fn_refund_shop_purchase (World Hub
-- pages/api/club-arena/refund-purchase.js, owner/admin) calls it undeclared,
-- so a chip-currency refund that reaches the credit answers 500 "Refund
-- failed" (fn_credit_chips_requires_a_declared_counterparty, measured in the
-- probe below). Today none reaches it: all 14 unrefunded chip purchases
-- (2026-03-21 .. 2026-08-20) were redeemed, so the door answers
-- already_redeemed first, and no door sells for chips any more. The branch is
-- fixed rather than left as a refusal waiting for the first undelivered item.
--
-- Where the chips went: each purchase wrote chip_transactions 'chip_debit'
-- with no recipient and 'purchase' - the price left circulation; no club,
-- union or house balance received it (no chip_ledger leg exists for any of the
-- 15; they predate the journal). A refund puts back chips the purchase
-- retired, so its counterparty is issuance_reserve, category 'refund', under
-- the operation key 'ca-shop-refund-<purchase>' (the same key the Diamond
-- branch already uses; issuance requires one, fn_ca_issuance_leg_is_registered).
-- The caller's declaration is saved and restored around the credit.
-- fn_credit_chips now keeps a category its caller declared and falls back to
-- 'player_funding' as before; its only other caller, fn_purchase_club_chips,
-- declares nothing (EXECUTE: postgres only, no live caller) so it is unchanged.
--
-- ROLLED-BACK PROBES (production, 2026-10-02 16:3x UTC, each one DO block
-- set ending in RAISE EXCEPTION):
--   * this file's statements, then fn_ca_supply_snapshot(): trailing 4h after
--     the recompute 7.36; the probe reading -0.84 unexplained, window burn
--     1,960.95, late 0.00 / 0.00, seen range 13:29 -> 16:29 (mint
--     3,300,000.00, burn 4,711,542.96).
--   * purchase 128f44bc (20.00) with its inventory set back to undelivered:
--     before this file the refund raised
--     fn_credit_chips_requires_a_declared_counterparty; after it, success,
--     wallet 6,140.02 -> 6,160.02, ONE leg issuance_reserve -> player_wallet
--     20.00 category refund key ca-shop-refund-128f44bc-..., 0 suspense legs,
--     the commit check passed (SET CONSTRAINTS ALL IMMEDIATE), and the outer
--     caller's declaration (club_treasury) was restored.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';

-- ---------------------------------------------------------------------------
-- 0. THE REVIEWED PRE-IMAGES
-- ---------------------------------------------------------------------------
DO $pin$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure))
     IS DISTINCT FROM '05bf43e4990f11cbf0f20b6788c64449' THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot is not the reviewed pre-image (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure))
     IS DISTINCT FROM 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN
    RAISE EXCEPTION 'fn_credit_chips is not the reviewed pre-image';
  END IF;
  IF md5(pg_get_functiondef('public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure))
     IS DISTINCT FROM 'abf4bf54c469a4fe019d540d4fd11923' THEN
    RAISE EXCEPTION 'fn_refund_shop_purchase is not the reviewed pre-image';
  END IF;
END $pin$;

-- ---------------------------------------------------------------------------
-- 1. THE SUPPLY METER COUNTS A LATE COMMIT IN ITS OWN HOUR
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS window_mint numeric,
  ADD COLUMN IF NOT EXISTS window_burn numeric,
  ADD COLUMN IF NOT EXISTS late_mint numeric,
  ADD COLUMN IF NOT EXISTS late_burn numeric,
  ADD COLUMN IF NOT EXISTS seen_from timestamptz,
  ADD COLUMN IF NOT EXISTS seen_mint numeric,
  ADD COLUMN IF NOT EXISTS seen_burn numeric;

COMMENT ON COLUMN public.ca_supply_snapshots.window_mint IS
  'issuance legs with created_at in (previous taken_at, taken_at] visible at this reading';
COMMENT ON COLUMN public.ca_supply_snapshots.window_burn IS
  'retirement legs with created_at in (previous taken_at, taken_at] visible at this reading';
COMMENT ON COLUMN public.ca_supply_snapshots.late_mint IS
  'issuance legs the previous reading could not see (committed after it, created before it), counted here; mint_since_prev = window_mint + late_mint';
COMMENT ON COLUMN public.ca_supply_snapshots.late_burn IS
  'retirement legs the previous reading could not see (committed after it, created before it), counted here; burn_since_prev = window_burn + late_burn';
COMMENT ON COLUMN public.ca_supply_snapshots.seen_from IS
  'start of the range (seen_from, taken_at] whose issuance/retirement this reading saw; the next reading recounts it';
COMMENT ON COLUMN public.ca_supply_snapshots.seen_mint IS
  'issuance legs in (seen_from, taken_at] visible at this reading';
COMMENT ON COLUMN public.ca_supply_snapshots.seen_burn IS
  'retirement legs in (seen_from, taken_at] visible at this reading';

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_basis CONSTANT text := 'pending-addon-v4';
  /* A LATE COMMIT IS COUNTED IN THE HOUR IT BECOMES VISIBLE (2026-10-02,
     20261002162528). chip_ledger.created_at is the writing transaction's
     START. One that starts before a reading and commits after it was in no
     reading's window: incident 2e00634c, -100,005.30 at 15:05, was one
     certification club's 100,000.00 retirement that started 14:04:56 and
     committed after the 14:05 reading. Each reading records what it saw over
     this horizon; the next one recounts the same range and counts the
     difference. */
  v_horizon CONSTANT interval := interval '3 hours';
  v_recount_from timestamptz;
  v_late_mint numeric; v_late_burn numeric;
BEGIN
  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  /* The range the previous reading saw. A reading written before
     20261002162528 has no seen_* columns: what it saw was its own window,
     (the reading before it, its taken_at], summed into mint/burn_since_prev. */
  IF prev.id IS NOT NULL THEN
    IF prev.seen_from IS NOT NULL THEN
      v_recount_from := prev.seen_from;
    ELSE
      SELECT p2.taken_at INTO v_recount_from
        FROM public.ca_supply_snapshots p2
       WHERE p2.taken_at < prev.taken_at
       ORDER BY p2.taken_at DESC LIMIT 1;
    END IF;
  END IF;

  /* ONE STATEMENT, ONE SNAPSHOT: the balances, this reading's window, the
     recount of the previous reading's range and what this reading sees all
     come from the same MVCC snapshot. The ceiling is read inside it: every
     transaction this snapshot sees started before it, so its legs are at or
     under the ceiling; one it does not see commits later with created_at at
     or under the ceiling and is found by the next reading's recount. */
  WITH c AS MATERIALIZED (SELECT clock_timestamp() AS cut)
  SELECT
    c.cut,
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_wallets,
    (SELECT COALESCE(sum(cm.promo_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND (t.tournament_id IS NOT NULL
                                /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond seat holds
                                   Diamonds that no chip_ledger row moves. Counted here they read
                                   as unexplained chip supply and page as a chip leak. */
                                OR EXISTS (SELECT 1 FROM public.clubs c
                                            WHERE c.id = t.club_id AND c.asset = 'diamonds'))))            AS felt,
    /* THE FELT IS OWED WHAT A MID-HAND ADD-ON ALREADY PAID FOR (2026-09-12).
       atomic_table_addon debits the wallet and posts its
       player_wallet -> table_stack leg at REQUEST time, but with
       p_apply_to_seat = false the chips wait in table_pending_addons until
       resolve_pending_addon delivers them. Scoped exactly like `felt` above. */
    (SELECT COALESCE(sum(pa.amount),0) FROM public.table_pending_addons pa
      WHERE pa.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = pa.table_id
                           AND (t.tournament_id IS NOT NULL
                                /* DIAMOND PHASE 9, STEP 0: scoped exactly like felt. */
                                OR EXISTS (SELECT 1 FROM public.clubs c
                                            WHERE c.id = t.club_id AND c.asset = 'diamonds'))))            AS pending_addons,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS chip_pools,
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_insurance,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(COALESCE(promo_wallet_balance,0)),0) FROM agents) AS agent_promo,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    (SELECT COALESCE(sum(
              CASE WHEN e.tournament_id IS NOT NULL
                   THEN COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                        + COALESCE(e.fee_balance,0)
                   ELSE COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                        - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
              END),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE ((e.tournament_id IS NOT NULL
             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                 + COALESCE(e.fee_balance,0) <> 0)
         OR (e.tournament_id IS NULL
             AND t.status NOT IN ('COMPLETED','CANCELLED')))
        /* DIAMOND PHASE 9, STEP 0: a Diamond event's pools and its escrow
           shadow are Diamonds in custody, not a chip liability. */
        AND NOT EXISTS (SELECT 1 FROM public.clubs c
                         WHERE c.id = t.club_id AND c.asset = 'diamonds'))            AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* THE TICKET IS A CHIP LIABILITY (2026-09-11). ticket_issue moves chips
       into the escrow store and ticket_redeem takes them out. */
    public.fn_ca_ticket_escrow_float()                                  AS ticket_escrow,
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w,
    /* this reading's own window */
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS window_mint,
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS window_burn,
    /* the previous reading's range, recounted now */
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE v_recount_from IS NOT NULL
        AND l.created_at > v_recount_from AND l.created_at <= prev.taken_at
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS recount_mint,
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE v_recount_from IS NOT NULL
        AND l.created_at > v_recount_from AND l.created_at <= prev.taken_at
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS recount_burn,
    /* what this reading sees, for the next one to recount */
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE l.created_at > c.cut - v_horizon AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS seen_mint,
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE l.created_at > c.cut - v_horizon AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS seen_burn
  INTO s
  FROM c;

  v_total := s.member_wallets + s.member_promo + s.felt + s.pending_addons
           + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin
           + s.tourn_liab + s.lb_liab + s.ticket_escrow;

  IF prev.id IS NOT NULL THEN
    IF prev.seen_from IS NOT NULL THEN
      v_late_mint := s.recount_mint - COALESCE(prev.seen_mint, 0);
      v_late_burn := s.recount_burn - COALESCE(prev.seen_burn, 0);
    ELSIF v_recount_from IS NOT NULL THEN
      v_late_mint := s.recount_mint - COALESCE(prev.mint_since_prev, 0);
      v_late_burn := s.recount_burn - COALESCE(prev.burn_since_prev, 0);
    ELSE
      v_late_mint := 0;
      v_late_burn := 0;
    END IF;
    v_mint := s.window_mint + v_late_mint;
    v_burn := s.window_burn + v_late_burn;
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, pending_addons, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained, taken_at, basis_version,
     window_mint, window_burn, late_mint, late_burn, seen_from, seen_mint, seen_burn)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.pending_addons, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo,
     s.ticket_escrow, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END,
     s.cut, v_basis,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.window_mint END,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.window_burn END,
     v_late_mint, v_late_burn,
     s.cut - v_horizon, s.seen_mint, s.seen_burn)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 100 AND abs(v_trailing) > 300 THEN
    v_critical := abs(v_unexplained) > 25000
               OR (abs(v_trailing) > 2000
                   AND v_prev_unexplained IS NOT NULL
                   AND abs(v_prev_unexplained) > 100
                   AND sign(v_prev_unexplained) = sign(v_unexplained));
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN v_critical THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval; trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2),
                                 'late_mint', round(COALESCE(v_late_mint,0),2),
                                 'late_burn', round(COALESCE(v_late_burn,0),2)));
  END IF;

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,
    format('the supply meter read %s unexplained in one hour (trailing 4h %s)', round(COALESCE(v_unexplained, 0), 2), round(COALESCE(v_trailing, 0), 2)));

  RETURN v_unexplained;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

SELECT public.fn_ca_declare_guard_redefinition(
  'fn_ca_supply_snapshot',
  'migration 20261002162528_the_supply_meter_counts_a_late_commit_in_its_own_hour');

-- The 15:05 reading, recomputed from the journal. The original value and the
-- evidence are kept; only the derived figures change.
DO $r$
DECLARE
  r public.ca_supply_snapshots;
  v_prev public.ca_supply_snapshots;
  v_prev2_at timestamptz;
  v_now_mint numeric; v_now_burn numeric;
  v_late_mint numeric; v_late_burn numeric;
BEGIN
  SELECT * INTO r FROM public.ca_supply_snapshots
   WHERE taken_at = '2026-10-02 15:05:01.719765+00';
  IF NOT FOUND THEN RAISE EXCEPTION 'the 15:05 reading is not there'; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_supply_snapshot_classifications WHERE snapshot_id = r.id) THEN
    RAISE NOTICE 'the 15:05 reading is already classified; nothing to do';
    RETURN;
  END IF;
  IF r.unexplained IS DISTINCT FROM -100005.30 THEN
    RAISE EXCEPTION 'the 15:05 reading reads %, not the -100005.30 this migration explains', r.unexplained;
  END IF;

  SELECT * INTO v_prev FROM public.ca_supply_snapshots
   WHERE taken_at < r.taken_at ORDER BY taken_at DESC LIMIT 1;
  SELECT taken_at INTO v_prev2_at FROM public.ca_supply_snapshots
   WHERE taken_at < v_prev.taken_at ORDER BY taken_at DESC LIMIT 1;

  SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(public.fn_ca_noncirculating_chip_stores())),0),
         COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(public.fn_ca_noncirculating_chip_stores())),0)
    INTO v_now_mint, v_now_burn
    FROM public.chip_ledger
   WHERE created_at > v_prev2_at AND created_at <= v_prev.taken_at
     AND NOT (category = 'correction' AND metadata->>'posted_via' = 'fn_ca_post_correction');
  v_late_mint := v_now_mint - v_prev.mint_since_prev;
  v_late_burn := v_now_burn - v_prev.burn_since_prev;
  IF v_late_mint <> 0 OR v_late_burn <> 100000.00 THEN
    RAISE EXCEPTION 'the 14:05 window recounts late mint % / late burn %, not 0 / 100000.00', v_late_mint, v_late_burn;
  END IF;

  INSERT INTO public.ca_supply_snapshot_classifications
    (snapshot_id, original_unexplained, classification, club_id, evidence)
  VALUES (r.id, r.unexplained, 'late_commit_counted_in_its_own_hour', NULL,
    jsonb_build_object(
      'what', 'one certification club retirement (club 43731738, stale-cert-recovery) started 14:04:56.07 and committed after the 14:05:00.18 reading; its 100,000.00 of burn legs carry created_at 14:04:56, so they fell between the 14:05 and 15:05 windows',
      'legs', 'club_treasury 99,700.00 + bbj_pool 100.00 + spin_reserve 200.00 -> chip_retirement',
      'late_burn_recounted', v_late_burn,
      'late_mint_recounted', v_late_mint,
      'original_burn_since_prev', r.burn_since_prev,
      'recomputed_unexplained', r.unexplained + v_late_burn - v_late_mint,
      'incidents', 'fn_ca_supply_snapshot 2e00634c, fn_ca_kill_switch_trip d9ebce90, financial_alerts:ca_kill_switch 035e55db',
      'formula_fixed_by', 'migration 20261002162528_the_supply_meter_counts_a_late_commit_in_its_own_hour',
      'unblocks', 'scripts/ci/check-chip-conservation.mjs trailing-4h gate (|trailing| > 5,000) until 19:05 UTC'));

  UPDATE public.ca_supply_snapshots
     SET late_mint = v_late_mint,
         late_burn = v_late_burn,
         window_mint = mint_since_prev,
         window_burn = burn_since_prev,
         mint_since_prev = mint_since_prev + v_late_mint,
         burn_since_prev = burn_since_prev + v_late_burn,
         unexplained = unexplained - v_late_mint + v_late_burn
   WHERE id = r.id;

  IF (SELECT unexplained FROM public.ca_supply_snapshots WHERE id = r.id) IS DISTINCT FROM -5.30 THEN
    RAISE EXCEPTION 'the 15:05 reading did not recompute to -5.30';
  END IF;
END $r$;

-- ---------------------------------------------------------------------------
-- 2. A CHIP SHOP REFUND NAMES WHERE ITS CHIPS COME FROM
-- ---------------------------------------------------------------------------
DO $credit$
DECLARE
  v_oid oid := 'public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure);
  v_old text := E'  PERFORM set_config(''app.ledger_category'', ''player_funding'', true);\n';
  v_new text := E'  /* A category the calling door declared stands (2026-10-02,\n'
             || E'     20261002162528: a shop refund is a refund, not player funding). */\n'
             || E'  PERFORM set_config(''app.ledger_category'',\n'
             || E'    COALESCE(NULLIF(current_setting(''app.ledger_category'', true), ''''), ''player_funding''), true);\n';
  v_n int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_credit_chips: the category line occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN
    RAISE EXCEPTION 'fn_credit_chips: the reverse substitution does not reproduce the pinned text';
  END IF;
END $credit$;

DO $refund$
DECLARE
  v_oid oid := 'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure);
  v_old1 text := E'  v_credit   jsonb;\n';
  v_new1 text := E'  v_credit   jsonb;\n'
              || E'  v_saved    jsonb;\n';
  v_old2 text := E'  ELSE\n'
              || E'    v_credit := public.fn_credit_chips(\n';
  v_new2 text := E'  ELSE\n'
              || E'    /* THE REFUND NAMES WHERE ITS CHIPS COME FROM (2026-10-02, 20261002162528).\n'
              || E'       A chip purchase retired its price (chip_debit, no recipient), so the\n'
              || E'       refund puts those chips back into circulation: issuance_reserve,\n'
              || E'       category refund, under this purchase''s own operation key. Undeclared,\n'
              || E'       fn_credit_chips refuses by name. The caller''s declaration is restored. */\n'
              || E'    v_saved := public.fn_ca_ledger_declaration_save(NULL);\n'
              || E'    PERFORM public.fn_ca_declare_ledger(''refund'', ''issuance_reserve'', NULL, NULL,\n'
              || E'      ''ca-shop-refund-'' || p_purchase_id::text, NULL);\n'
              || E'    v_credit := public.fn_credit_chips(\n';
  v_old3 text := E'    IF COALESCE((v_credit->>''success'')::boolean, false) IS NOT TRUE THEN\n'
              || E'      RAISE EXCEPTION ''refund credit failed: %'', COALESCE(v_credit->>''error'', ''unknown'');\n'
              || E'    END IF;\n';
  v_new3 text := v_old3
              || E'    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);\n';
  v_n int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: declaration anchor occurs % times', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: chip branch anchor occurs % times', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: credit check anchor occurs % times', v_n; END IF;
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  IF md5(replace(replace(replace(pg_get_functiondef(v_oid), v_new3, v_old3), v_new2, v_old2), v_new1, v_old1))
     <> 'abf4bf54c469a4fe019d540d4fd11923' THEN
    RAISE EXCEPTION 'refund: the reverse substitution does not reproduce the pinned text';
  END IF;
END $refund$;

-- ---------------------------------------------------------------------------
-- 3. PROOF AT APPLY, ROLLED BACK
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_unexplained numeric; v_row public.ca_supply_snapshots; v_trailing numeric;
  v_ok boolean := false;
BEGIN
  SELECT COALESCE(sum(unexplained),0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;
  IF abs(v_trailing) > 1000 THEN
    RAISE EXCEPTION 'trailing 4h is still % after the recompute - stop and look', v_trailing;
  END IF;

  BEGIN
    v_unexplained := public.fn_ca_supply_snapshot();
    SELECT * INTO v_row FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
    RAISE EXCEPTION 'SUPPLY_METER_PROBE_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SUPPLY_METER_PROBE_ROLLBACK' THEN RAISE; END IF;
    v_ok := true;
  END;
  IF NOT v_ok OR v_row.seen_from IS NULL OR v_row.late_mint IS NULL OR v_row.late_burn IS NULL
     OR v_row.mint_since_prev IS DISTINCT FROM v_row.window_mint + v_row.late_mint
     OR v_row.burn_since_prev IS DISTINCT FROM v_row.window_burn + v_row.late_burn THEN
    RAISE EXCEPTION 'the probe reading did not record its window, late legs and seen range: %', to_jsonb(v_row);
  END IF;
  IF v_unexplained IS NULL OR abs(v_unexplained) > 1000 THEN
    RAISE EXCEPTION 'the probe reading reads % unexplained', v_unexplained;
  END IF;
  RAISE NOTICE 'SUPPLY_METER_SELFCHECK_OK unexplained % late mint % late burn %',
    v_unexplained, v_row.late_mint, v_row.late_burn;
END $proof$;

COMMIT;
