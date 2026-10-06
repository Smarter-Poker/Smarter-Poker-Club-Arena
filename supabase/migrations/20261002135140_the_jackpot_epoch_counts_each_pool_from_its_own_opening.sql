-- 20261002135140_the_jackpot_epoch_counts_each_pool_from_its_own_opening
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 13:51:40 UTC.
--
-- @live-proof: (SELECT position('''absorbed_by_later_openings''' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0 AND position('''journalled_burns_after_epoch''' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0)
--
-- WHAT WAS WRONG. Incident f3e82f59 (fn_ca_conservation_sweep:
-- fn_bbj_conservation_check, 11 occurrences from 02:52 UTC) said the BBJ epoch
-- was short: moved_since_recorded -4,400.00 at 12:52, -4,600.00 at 13:42.
-- Read from the rows, no chip is missing and no jackpot is unpaid. The check
-- counted 46 pool openings twice:
--
--   * Since 20261001154709 / 20261002010726 the lifetime-first club welcome
--     package creates each new club's bbj_pools row with main_balance 100.00
--     moved from the club treasury, and the autoledger writes the matching
--     chip_ledger leg (opening_setup -> bbj_pool, category
--     club_opening_allocation) in the same transaction, so the leg's
--     created_at equals the pool's created_at to the microsecond.
--   * fn_bbj_open_pool_baseline (20260904213506) opens such a pool on the
--     meter's first sight at taken_at = GREATEST(created_at, epoch) and
--     reconstructs the opening balance as banks minus the journal STRICTLY
--     AFTER taken_at. The seed leg is at taken_at, so it is not subtracted:
--     every one of the 46 baselines reads main 100.00. That per-pool record is
--     internally consistent - fn_bbj_reconcile measures each pool from it.
--   * fn_bbj_conservation_check then summed the baselines AND the journal
--     since ONE global instant, the 2026-09-04 21:17:14 epoch. The seed leg is
--     after that instant, so each seed was in the opening balance and in the
--     journal: current - 100 - (100 + drops) = -100 per pool.
--
-- Measured 2026-10-02 13:42 UTC: 51 pools, 49 with a baseline. Global window
-- -4,609.82; each pool from its own opening -9.82. 46 pools read exactly
-- -100.00 each (= -4,600.00, 44 of them = -4,400.00 at the incident's 12:52
-- reading). The remaining -9.82 is the two original pools' residue already
-- recorded on 2026-09-09 (club pool a7a65cfc -5.88, union pool f9806a7f -3.94)
-- and unchanged to the cent since. Two pools created since the last meter run
-- have no baseline yet and net 0.00 under either window.
--
-- The lifetime half of the same check had the mirror image: the welcome
-- seeds are balance with no bbj_contributions row (+4,600.00 the identity did
-- not know about) and 26 of those test-club pools were retired through a
-- journalled burn to chip_retirement (2,600.00 out with no outflow term), so
-- lifetime moved_since_resolution read -2,000.00 = -4,600.00 + 2,600.00.
--
-- WHAT THIS CHANGES. Only fn_bbj_conservation_check, by text replacement of
-- the installed body (pre-image md5 cd515fb20589a20ba6b930a6831610b8, the body
-- 20260909101535 installed):
--   1. A pool whose opening is after the epoch is measured from its own
--      opening: the legs between the epoch and that pool's taken_at are added
--      back to the epoch residue, because its baseline already holds them.
--      Same window fn_bbj_open_pool_baseline and fn_bbj_reconcile use.
--   2. The lifetime identity counts the journalled opening seeds into, and the
--      journalled burns out of, those same later-opened pools. They have a
--      ledger sentence, so they are not the silent seed the remembered
--      opening_seeds figure guards against. An ORIGINAL pool's burn or seed is
--      deliberately still unexplained.
--   3. Both figures are printed (epoch.absorbed_by_later_openings,
--      lifetime.journalled_seeds_after_epoch / journalled_burns_after_epoch).
-- Nothing is credited, written off or rebaselined; no balance moves; no
-- recorded residue changes. The extra read is per later-opened pool on the
-- entity indexes: 46 ms for 46 pools, measured.
--
-- SETTLEMENT (CLAUDE.md 10.9). None owed. The 4,600.00 is 46 welcome seeds of
-- 100.00, each moved club treasury -> its own new pool with its ledger leg;
-- 2,600.00 of it was later retired by journalled burns. No player is short,
-- no bbj_payouts row is missing (paid_without_a_payout_row_since 0.00), and
-- the last bbj_payouts row (08:03) is unaffected.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';

DO $mig$
DECLARE
  v_src text; v_new text; v_md5 text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
  v_res jsonb; v_absorbed numeric; v_seed_at_open numeric;
  v_anchor text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), r.rolname, p.prosecdef, p.proconfig, p.provolatile
    INTO v_src, v_md5, v_owner, v_secdef, v_cfg, v_vol
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'cd515fb20589a20ba6b930a6831610b8' THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check is not the reviewed pre-image (md5 %)', v_md5;
  END IF;

  -- 1. declarations
  v_anchor := $a$  v_seeds numeric; v_drift numeric; v_unexplained numeric; v_tol numeric;$a$;
  IF position(v_anchor IN v_src) = 0 THEN RAISE EXCEPTION 'anchor 1 (declarations) not found'; END IF;
  v_new := replace(v_src, v_anchor, v_anchor || $a$
  v_absorbed numeric := 0; v_late_seeds numeric := 0; v_late_burns numeric := 0;$a$);

  -- 2. the later-opened pools, read before the lifetime identity uses v_in/v_out
  v_anchor := $a$  SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) INTO v_bal FROM bbj_pools;$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor 2 (balances) not found'; END IF;
  v_new := replace(v_new, v_anchor, $a$  /* A POOL OPENED AFTER THE EPOCH IS MEASURED FROM ITS OWN OPENING
     (2026-10-02, incident f3e82f59). fn_bbj_open_pool_baseline opens a later
     pool at GREATEST(created_at, epoch) and its opening balance already holds
     every leg up to that instant - the welcome seed leg has the pool's own
     created_at. Summing that baseline AND the journal since the global epoch
     counted each 100.00 seed twice. The legs a later pool's baseline absorbed
     are added back below; and its journalled seeds and burns enter the
     lifetime identity, because unlike the remembered 1,000.00 they have a
     ledger sentence. An ORIGINAL pool's seed or burn stays unexplained. */
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT COALESCE(sum(x.absorbed), 0), COALESCE(sum(x.seeded), 0), COALESCE(sum(x.burned), 0)
    INTO v_absorbed, v_late_seeds, v_late_burns
    FROM (SELECT s.pool_id, min(s.taken_at) AS opened_at
            FROM public.ca_bbj_pool_snapshots s
           WHERE s.is_baseline
           GROUP BY s.pool_id
          HAVING min(s.taken_at) > v_epoch_at) o
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(sum(CASE WHEN l.created_at <= o.opened_at
                          THEN (CASE WHEN l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id THEN l.amount ELSE 0 END)
                             - (CASE WHEN l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id THEN l.amount ELSE 0 END)
                          ELSE 0 END), 0) AS absorbed,
        COALESCE(sum(l.amount) FILTER (WHERE l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id
                                         AND l.category = 'club_opening_allocation'), 0) AS seeded,
        COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id
                                         AND l.category = 'burn'), 0) AS burned
        FROM public.chip_ledger l
       WHERE ((l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id)
           OR (l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id))
         AND l.created_at > v_epoch_at) x;
  v_in := v_in + v_late_seeds;
  v_out := v_out + v_late_burns;

$a$ || v_anchor);

  -- 3. the epoch residue gets back what a later pool's own opening absorbed
  v_anchor := $a$               AND l.created_at > v_epoch_at), 2)
    INTO v_epoch_unexp;$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor 3 (epoch sum) not found'; END IF;
  v_new := replace(v_new, v_anchor, v_anchor || $a$
  v_epoch_unexp := round(v_epoch_unexp + v_absorbed, 2);$a$);

  -- 4. print both figures
  v_anchor := $a$      'unexplained_since_opening', round(v_epoch_unexp, 2),$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor 4 (epoch object) not found'; END IF;
  v_new := replace(v_new, v_anchor, v_anchor || $a$
      'absorbed_by_later_openings', round(v_absorbed, 2),$a$);
  v_anchor := $a$      'opening_seeds_known', v_seeds,$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor 5 (lifetime object) not found'; END IF;
  v_new := replace(v_new, v_anchor, v_anchor || $a$
      'journalled_seeds_after_epoch', round(v_late_seeds, 2),
      'journalled_burns_after_epoch', round(v_late_burns, 2),$a$);

  EXECUTE v_new;

  -- The function keeps its owner, SECURITY DEFINER, search_path and volatility.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure
                    AND r.rolname = v_owner AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg AND p.provolatile = v_vol
                    AND md5(pg_get_functiondef(p.oid)) <> v_md5) THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check post-image is not the pre-image with only its body changed';
  END IF;

  -- The probe's numbers, re-read from the rows at apply time.
  v_res := public.fn_bbj_conservation_check();
  v_absorbed := (v_res->'epoch'->>'absorbed_by_later_openings')::numeric;
  SELECT COALESCE(sum(l.amount), 0) INTO v_seed_at_open
    FROM (SELECT s.pool_id, min(s.taken_at) AS opened_at FROM public.ca_bbj_pool_snapshots s
           WHERE s.is_baseline GROUP BY s.pool_id
          HAVING min(s.taken_at) > (SELECT min(taken_at) FROM public.ca_bbj_pool_snapshots WHERE is_baseline)) o
    JOIN public.chip_ledger l ON l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id
     AND l.category = 'club_opening_allocation' AND l.created_at = o.opened_at;
  IF v_absorbed IS DISTINCT FROM round(v_seed_at_open, 2) THEN
    RAISE EXCEPTION 'absorbed % is not exactly the seed legs at the later pools'' openings %', v_absorbed, v_seed_at_open;
  END IF;
  IF abs((v_res->'epoch'->>'moved_since_recorded')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'the epoch still moved since the recorded -9.82: %', v_res->'epoch';
  END IF;
  IF COALESCE((v_res->>'healthy')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the jackpot check is still unhealthy: %', v_res->'epoch';
  END IF;
  IF abs((v_res->'lifetime'->>'moved_since_resolution')::numeric) > 1.00 THEN
    RAISE EXCEPTION 'the lifetime identity still moved: %', v_res->'lifetime';
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET note = note || E'\n\nPER-POOL OPENINGS 2026-10-02 (incident f3e82f59). The epoch read -4,609.82 because 46 welcome-package pools opened after the epoch were counted twice: their 100.00 seed leg sits at the pool''s own created_at, so fn_bbj_open_pool_baseline put it in the opening balance (journal strictly after taken_at) while this check also summed it in the journal since the global epoch. A later-opened pool is now measured from its own opening, and its journalled seeds and burns enter the lifetime identity. Recorded residues unchanged: epoch -9.82, lifetime 45.80. Nothing credited, written off or rebaselined.'
   WHERE id = 1;
END
$mig$;

COMMIT;
