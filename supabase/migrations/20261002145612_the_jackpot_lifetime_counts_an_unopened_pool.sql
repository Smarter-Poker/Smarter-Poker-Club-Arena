-- 20261002145612_the_jackpot_lifetime_counts_an_unopened_pool
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 14:56:12 UTC.
--
-- @live-proof: (SELECT position('LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0 AND position('o.opened_at IS NOT NULL AND l.created_at <= o.opened_at' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0 AND position($$AND l.category NOT IN ('bbj_payout', 'promo')), 0) AS burned$$ IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0)
--
-- WHAT WAS WRONG. 20261002135140 (incident f3e82f59) put the journalled
-- welcome seeds and burns of a pool opened after the 2026-09-04 epoch into the
-- lifetime identity, but it found those pools through their meter baseline.
-- A pool the hourly meter has not opened yet has no baseline, so for up to an
-- hour after a club is created its 100.00 seed was balance with no inflow:
-- measured at 14:47 UTC, lifetime.moved_since_resolution -100.00 and
-- lifetime_healthy false, from pool 2032add6 (created 14:42:20, seeded 100.00,
-- no baseline). The epoch verdict was already right for such a pool (no
-- baseline, so the global window counts its seed once against an opening of
-- 0.00) and is unchanged.
--
-- AND THE FIRST VERSION OF THIS MIGRATION DID NOT CLOSE IT. Dispatched once on
-- 2026-10-02, it REFUSED BY ITS OWN ASSERTION at 200.00 against a 1.00
-- tolerance - and that figure was post-EXECUTE, so its own new body did not
-- reconcile. Read from rows on 2026-10-03 03:53-04:05 UTC, the 200.00 was not
-- the board moving and not a transient. Across every post-epoch pool the
-- journal carries exactly three leg categories: club_opening_allocation in,
-- and OUT either 'burn' (86 legs) or 'treasury_transfer' (2 legs, 20:49:52 and
-- 21:04:18 UTC, pools 1ade3ec6 and 41cfec59). The body named only 'burn' as a
-- later pool's journalled outflow, so it brought those two pools' 100.00 seeds
-- in as inflow against no outflow. The two legs are honest and conserved: each
-- is bbj_pool -> club_treasury 100.00 for the same club, the club deactivation
-- returning the seed rather than burning it in place, and each club's treasury
-- was then burned whole under 'cert-retire:<club>' (100,000.00 minted at
-- opening, 100,000.00 retired). All four unbaselined pools hold 0.00 in every
-- bank, have 0.00 total_paid_out, took no contribution and paid no jackpot.
-- NO PLAYER'S MONEY IS IMPLICATED and nothing is owed.
--
-- The live body reads 0.00 today only because it ignores those pools outright
-- and the two treasury returns happen to both be among them. The hole is
-- latent, not absent: the first baselined pool retired that way makes the live
-- body read +100.00 too.
--
-- WHAT THIS CHANGES. Only fn_bbj_conservation_check, by text replacement of
-- the 20261002135140 body (pre-image md5 b1fb89dc98aaad152bd5b2085b88bbfa):
--   * the later-opened set is every bbj_pools row whose opening - its baseline
--     if the meter has opened it, else its created_at - is after the epoch;
--   * only a pool WITH a baseline gives legs back to the epoch residue
--     (o.opened_at IS NOT NULL), so the epoch figure is identical;
--   * a later pool's journalled inflow and outflow are now defined by what is
--     ALREADY COUNTED ELSEWHERE rather than by naming one category each. Out:
--     everything except 'bbj_payout' and 'promo', the two families v_out
--     already holds through bbj_payouts and the promo sweeps. In: everything
--     except 'bbj_contribution', which v_in already holds through
--     fn_bbj_contributions_total(). Enumerating what to INCLUDE is what left
--     'treasury_transfer' outside the identity; a complement cannot be made
--     incomplete by a new retirement category (CLAUDE.md 10.86 rule 4).
-- Original pools (created before the epoch) are still excluded, so a seed or a
-- burn on one of those stays unexplained. The tolerance is NOT widened - it
-- stays 1.00 and 0.01 and is asserted below. Nothing is credited, written off,
-- rebaselined or moved.
--
-- Probe (read-only SELECT arithmetic over the live rows, no DDL) at 04:05 UTC:
-- absorbed 8,400.00 unchanged either way; journalled inflow 9,000.00 and
-- outflow 9,000.00, net 0.00, identical under the complement form and under an
-- explicit ('burn','treasury_transfer') list. The certification programme is
-- creating and retiring a club every few minutes, so the gross figures climb
-- (8,800.00 at 03:55, 9,000.00 at 04:05) while the net stays exactly 0.00.
-- Asserted again below at apply.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';

DO $mig$
DECLARE
  v_src text; v_new text; v_md5 text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
  v_res jsonb; v_anchor text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), r.rolname, p.prosecdef, p.proconfig, p.provolatile
    INTO v_src, v_md5, v_owner, v_secdef, v_cfg, v_vol
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b1fb89dc98aaad152bd5b2085b88bbfa' THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check is not the 20261002135140 body (md5 %)', v_md5;
  END IF;

  v_anchor := $a$    FROM (SELECT s.pool_id, min(s.taken_at) AS opened_at
            FROM public.ca_bbj_pool_snapshots s
           WHERE s.is_baseline
           GROUP BY s.pool_id
          HAVING min(s.taken_at) > v_epoch_at) o$a$;
  IF position(v_anchor IN v_src) = 0 THEN RAISE EXCEPTION 'anchor A (later-opened set) not found'; END IF;
  v_new := replace(v_src, v_anchor, $a$    FROM (SELECT p.id AS pool_id, b.opened_at
            FROM public.bbj_pools p
            LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at
                         FROM public.ca_bbj_pool_snapshots s
                        WHERE s.is_baseline
                        GROUP BY s.pool_id) b ON b.pool_id = p.id
           WHERE COALESCE(b.opened_at, p.created_at) > v_epoch_at) o$a$);

  v_anchor := $a$        COALESCE(sum(CASE WHEN l.created_at <= o.opened_at$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor B (absorbed window) not found'; END IF;
  v_new := replace(v_new, v_anchor, $a$        COALESCE(sum(CASE WHEN o.opened_at IS NOT NULL AND l.created_at <= o.opened_at$a$);

  /* Anchor C and D: the journalled legs of a later pool are everything the
     rest of the identity has not already counted. v_in already holds
     'bbj_contribution' through fn_bbj_contributions_total(); v_out already
     holds 'bbj_payout' through bbj_payouts and 'promo' through the three
     promo-sweep terms. Everything else crossing a later pool's edge - the
     welcome seed in, a burn or a return to the club treasury out, a
     correction either way - belongs to this identity. */
  v_anchor := $a$                                         AND l.category = 'club_opening_allocation'), 0) AS seeded,$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor C (journalled inflow) not found'; END IF;
  v_new := replace(v_new, v_anchor, $a$                                         AND l.category <> 'bbj_contribution'), 0) AS seeded,$a$);

  v_anchor := $a$                                         AND l.category = 'burn'), 0) AS burned$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor D (journalled outflow) not found'; END IF;
  v_new := replace(v_new, v_anchor, $a$                                         AND l.category NOT IN ('bbj_payout', 'promo')), 0) AS burned$a$);

  EXECUTE v_new;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure
                    AND r.rolname = v_owner AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg AND p.provolatile = v_vol
                    AND md5(pg_get_functiondef(p.oid)) <> v_md5) THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check post-image is not the pre-image with only its body changed';
  END IF;

  v_res := public.fn_bbj_conservation_check();
  IF COALESCE((v_res->>'healthy')::boolean, false) IS NOT TRUE
     OR abs((v_res->'epoch'->>'moved_since_recorded')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'the epoch verdict moved: %', v_res->'epoch';
  END IF;
  IF COALESCE((v_res->>'lifetime_healthy')::boolean, false) IS NOT TRUE
     OR abs((v_res->'lifetime'->>'moved_since_resolution')::numeric) > 1.00 THEN
    RAISE EXCEPTION 'the lifetime identity still moved: %', v_res->'lifetime';
  END IF;

  /* The journalled legs net to zero across the later pools: every certification
     seed that left a club treasury came back to one or was retired. If a future
     seed is stranded this is where it shows, and it is not absorbed by the
     tolerance. */
  IF abs(round((v_res->'lifetime'->>'journalled_seeds_after_epoch')::numeric
              - (v_res->'lifetime'->>'journalled_burns_after_epoch')::numeric, 2)) > 0.01 THEN
    RAISE EXCEPTION 'a later pool holds seed the journal does not account for: %', v_res->'lifetime';
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET note = note || E'\n\nUNOPENED POOLS 2026-10-02. A pool created after the epoch that the meter has not opened yet is inside the lifetime identity from its creation, not from its first baseline; until then its 100.00 seed read as -100.00 lifetime. A later pool''s journalled legs are now everything this identity has not already counted (out: not bbj_payout and not promo; in: not bbj_contribution), because naming only ''burn'' left the two 2026-10-02 treasury returns of a seed outside it and read as +200.00. Epoch figure unchanged. Nothing credited, written off or rebaselined.'
   WHERE id = 1;
END
$mig$;

COMMIT;
