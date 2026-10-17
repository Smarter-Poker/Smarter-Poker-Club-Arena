-- 20261016172614_the_supply_meter_counts_a_hand_in_transit
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16.
--
-- THE SUPPLY METER COUNTS A HAND IN TRANSIT (2026-10-16)
--
-- The hourly chip supply meter (fn_ca_supply_snapshot) has read a few chips
-- of "unexplained" supply about twice a day: -5.00 then +5.00 (10-15 06:05,
-- 07:05), -6.20, +0.70, +1.90, +3.60, -5.40 then +5.50 (10-16 08:05, 09:05),
-- -0.10 (16:05) and -1.93 (17:05). 20261016042936 stopped that paging the
-- owner's phone below 100 chips; it did not find the cause. This is the cause.
--
-- A settled cash hand is written in TWO transactions. The accepted-hand
-- commit moves the seats by inflow - rake - bbj (hand_atomic_commits row,
-- post_commit_payload set, post_commit_completed_at NULL). The hand's
-- post-commit obligations then post the rake and the jackpot drop to the
-- union wallet and the BBJ pool, write their chip_ledger legs, resolve any
-- pending add-on and stamp post_commit_completed_at, in the NEXT transaction,
-- a few hundred milliseconds later. Between the two, the rake and the drop
-- are on no store the meter counts: the seats have paid them and nobody has
-- received them yet. The legs are internal (table_stack -> union_wallet,
-- table_stack -> bbj_pool), so the late-leg re-read of 20261002164500 never
-- sees them either. A reading that lands in that gap is short by exactly the
-- in-flight amount, and the next reading is long by it.
--
-- Measured read-only on production 2026-10-16, both readings to the cent:
--   16:05:00.286 snapshot 1182, unexplained -0.10. In flight at the cut: hand
--     d6588e74 (rake 0.09 + drop 0.01), committed 16:05:00.079, obligations
--     completed 16:05:00.381.
--   17:05:00.320 snapshot 1183, unexplained -1.93. In flight at the cut: hand
--     8eb28ce6 (rake 1.65 + drop 0.25, committed 17:05:00.026, obligations
--     17:05:00.352) and hand 41dbd983 (rake 0.13, committed 17:05:00.182,
--     obligations 17:05:00.488): -2.03, plus the 0.10 that 1182 missed
--     arriving in this window: -1.93.
--
-- fn_ca_account_balance already counts this exact quantity on the felt
-- (2026-10-11 and 2026-10-12: "an unposted hand is on the felt by rake + bbj
-- - inflow, read from the stack result the seats were moved by"); the supply
-- meter, which that comment names as its definition of the felt, was never
-- given the same line. This gives it the same line, read from the same rows
-- with the same predicate (the partial index
-- idx_hand_atomic_commits_post_commit_pending), excluding tournament and
-- Diamond tables exactly as the felt does, in the same one-statement snapshot
-- as every other store. It is stored in its own column, posthand_transit, so a
-- reader can see it rather than have it folded into the felt.
--
-- The meaning of `total` changes, so the basis moves to posthand-transit-v6:
-- the first v6 reading has no delta and no unexplained figure, exactly as the
-- first v5 reading did (20261006141326), and is never compared with v5.
--
-- Nothing else moves: no money, no other store, no threshold, no escalation.
-- A hand whose obligations never complete stays counted on the felt (as
-- fn_ca_account_balance counts it), and fn_ca_drain_orphaned_post_commit_
-- envelopes and the ledger invariant still own that case.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (c9fa91ce...), each of the five
-- anchors must occur exactly once, and the result must hash to the postimage
-- derived read-only on production with replace(); owner, SECURITY DEFINER,
-- proconfig and grants must not move. fn_ca_supply_snapshot is on the guard
-- watchlist, so the redefinition is declared in the same transaction.
--
-- Regression: scripts/ci/test-supply-meter-hand-in-transit.py (native
-- PostgreSQL), run by .github/workflows/supply-meter-hand-in-transit.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure)) = 'de5f2ec2b0897d91d12689288723b57f' AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ca_supply_snapshots' AND column_name='posthand_transit'))

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_supply_subst(p_sig text, p_before text, p_after text,
                                        p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- 1. The column. Nullable with no default: historical readings are v5 and
--    carried no transit figure, so NULL is the truth for them.
ALTER TABLE public.ca_supply_snapshots ADD COLUMN posthand_transit numeric;
COMMENT ON COLUMN public.ca_supply_snapshots.posthand_transit IS
 'Rake + jackpot drop - inflow of accepted cash hands whose post-commit obligations had not yet posted, at the same committed snapshot (the felt by its journal, as fn_ca_account_balance reads it); NULL on readings before posthand-transit-v6.';

-- 2. The meter.
SELECT pg_temp.ca_supply_subst(
  'public.fn_ca_supply_snapshot()',
  'c9fa91cece6c07f9ba35b55455d7ce5e', 'de5f2ec2b0897d91d12689288723b57f',
  ARRAY[$so1$  v_basis CONSTANT text := 'cashout-escrow-v5';$so1$,
        $so2$                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS pending_addons,
$so2$,
        $so3$           + s.tourn_liab + s.lb_liab + s.ticket_escrow + s.cashout_escrow;$so3$,
        $so4$     ticket_escrow, cashout_escrow, total,$so4$,
        $so5$     s.ticket_escrow, s.cashout_escrow, v_total,$so5$],
  ARRAY[$sn1$  v_basis CONSTANT text := 'posthand-transit-v6';$sn1$,
        $sn2$                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS pending_addons,
    /* THE HAND IN TRANSIT IS ON THE FELT (2026-10-16). A settled cash hand
       moves the seats by inflow - rake - bbj in its accepted-hand commit, and
       its post-commit obligations post the rake and the drop (and resolve the
       add-on) in the next transaction. Until they do, those chips are on the
       felt by the journal and on no store above, so a reading in that gap was
       short by them and the next one long: -0.10 and -1.93 on 2026-10-16,
       each to the cent the hands then in flight. fn_ca_account_balance reads
       the felt with this same line; 20261016172614. */
    (SELECT COALESCE(sum(COALESCE((hc.stack_result->>'rake')::numeric, 0)
                         + COALESCE((hc.stack_result->>'bbj')::numeric, 0)
                         - COALESCE((hc.stack_result->>'inflow')::numeric, 0)), 0)
       FROM public.hand_atomic_commits hc
      WHERE hc.post_commit_payload IS NOT NULL
        AND hc.post_commit_completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = hc.table_id
                           AND (t.tournament_id IS NOT NULL
                                OR EXISTS (SELECT 1 FROM public.clubs cl
                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS posthand_transit,
$sn2$,
        $sn3$           + s.tourn_liab + s.lb_liab + s.ticket_escrow + s.cashout_escrow
           + s.posthand_transit;$sn3$,
        $sn4$     ticket_escrow, cashout_escrow, posthand_transit, total,$sn4$,
        $sn5$     s.ticket_escrow, s.cashout_escrow, s.posthand_transit, v_total,$sn5$]
);

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_supply_snapshot',
  'migration 20261016172614_the_supply_meter_counts_a_hand_in_transit');

-- 3. A second run must refuse: the preimage pin above no longer matches.

COMMIT;
