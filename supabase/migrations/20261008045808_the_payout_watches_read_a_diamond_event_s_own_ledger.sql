-- 20261008045808_the_payout_watches_read_a_diamond_event_s_own_ledger
--
-- Reserved by scripts/new-migration.mjs on 2026-10-08 04:58:08 UTC.
--
-- THE PAYOUT WATCHES READ A DIAMOND EVENT'S OWN LEDGER (2026-10-08)
--
-- fn_payout_guarantee_check (earner_not_paid) and
-- fn_ca_tournament_settlement_mismatch (and through it
-- fn_ca_tournament_underpaid_count, the tournament_underpaid_48h ratchet of
-- fn_ca_ratchet_watch) measure what a tournament paid by reading
-- wallet_transactions only. A Diamond event (clubs.asset = 'diamonds') never
-- writes a wallet row for its prizes or bounties: since Diamond phase 7 and 9
-- (20260914032315, 20260914111709) it pays from its own custody and records
-- every payout in poker_diamond_tournament_ledger (kind 'prize' and 'bounty').
-- So every completed Diamond event reads as "paid 0" to both watches.
--
-- Measured read-only on production 2026-10-08: 32 open earner_not_paid alerts
-- across 11 tournaments, and 11 'underpaid' settlement mismatches (the same
-- 11 events, paid 0 against pools of 216 to 21,600). All 11 are Diamond MTTs.
-- In every one the ledger's 'prize' rows sum to the prize pool exactly, every
-- one of the 32 named earners holds a ledger prize row, and no place differs
-- from its flat structure share by a whole Diamond (worst -0.49, best +0.79:
-- the engine pays whole Diamonds and gives the remainder to a place). Nobody
-- is owed anything; both watches are blind to the asset the event paid in.
--
-- The fix, in the watches only (no writer changes, no money moves):
--   fn_payout_guarantee_check
--     * the clearer's credited and pool_paid,
--     * the earner loop's pool_paid (the pool test),
--     * the earner loop's credited, in its SELECT and its WHERE,
--     each add the event's poker_diamond_tournament_ledger credits: 'prize'
--     for what left the prize pool, 'prize' and 'bounty' for what one player
--     received (the wallet side counts the same two categories). The bounty
--     pool reconciliation already reads the ledger (Diamond phase 9).
--   fn_ca_tournament_settlement_mismatch
--     * paid adds the ledger's 'prize' rows (the wallet side excludes bounty,
--       so the ledger side does too). fn_ca_tournament_underpaid_count and the
--       ratchet read through it and need no change.
-- A chip event has no ledger rows (0 on production), so every sum added here
-- is 0 for it and its result is unchanged. Both reads use existing indexes:
-- poker_diamond_tournament_ledger (tournament_id, kind) and
-- (user_id, tournament_id).
--
-- After install the next fn_payout_guarantee_check run clears the 32 open
-- alerts itself (each event's pool reads as fully distributed), and the
-- ratchet reads 0 underpaid events.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to the measured md5 (guarantee 7c57c1a2..., mismatch
-- 7900253b...), each anchor must occur exactly once, and the result must hash
-- to the postimage derived read-only on production with replace();
-- owner, SECURITY DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-diamond-payout-watches.py (native PostgreSQL),
-- run by .github/workflows/diamond-payout-watches.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_payout_guarantee_check(integer)'::regprocedure)) = '790179466df6948eccbf0eca42d739ba' AND md5(pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure)) = '06d38e190581c381f4ddfe2fb991f594')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_watch_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_watch_subst(
  'public.fn_payout_guarantee_check(integer)',
  '7c57c1a27ae394f67010bf5f54cdab27', '790179466df6948eccbf0eca42d739ba',
  ARRAY[$go1$                      WHERE w.related_entity_id = a.tid AND w.user_id = a.uid
                        AND w.type = 'credit' AND w.category IN ('prize','bounty')), 0) AS credited,$go1$,
        $go2$                      WHERE w.related_entity_id = a.tid
                        AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid$go2$,
        $go3$                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid$go3$,
        $go4$                        AND w.category IN ('prize','bounty')), 0) AS credited,
           (o.pool_paid + 0.01 >= o.pool) AS pool_distributed$go4$,
        $go5$                        AND w.category IN ('prize','bounty')), 0) + 0.05 < o.place_worth$go5$],
  ARRAY[$gn1$                      WHERE w.related_entity_id = a.tid AND w.user_id = a.uid
                        AND w.type = 'credit' AND w.category IN ('prize','bounty')), 0)
           -- A DIAMOND EVENT PAYS FROM ITS OWN LEDGER (2026-10-08): its prizes
           -- and bounties are poker_diamond_tournament_ledger rows, never
           -- wallet rows. A chip event has no ledger rows, so this adds 0.
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = a.tid AND l.user_id = a.uid
                          AND l.kind IN ('prize','bounty')), 0) AS credited,$gn1$,
        $gn2$                      WHERE w.related_entity_id = a.tid
                        AND w.type = 'credit' AND w.category = 'prize'), 0)
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = a.tid AND l.kind = 'prize'), 0) AS pool_paid$gn2$,
        $gn3$                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit' AND w.category = 'prize'), 0)
             -- A Diamond event's prizes left its own custody, not the wallet
             -- escrow (2026-10-08); a chip event has no ledger rows.
             + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                          WHERE l.tournament_id = t.id AND l.kind = 'prize'), 0) AS pool_paid$gn3$,
        $gn4$                        AND w.category IN ('prize','bounty')), 0)
           -- A Diamond earner is paid in poker_diamond_tournament_ledger (2026-10-08).
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = o.id AND l.user_id = o.user_id
                          AND l.kind IN ('prize','bounty')), 0) AS credited,
           (o.pool_paid + 0.01 >= o.pool) AS pool_distributed$gn4$,
        $gn5$                        AND w.category IN ('prize','bounty')), 0)
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = o.id AND l.user_id = o.user_id
                          AND l.kind IN ('prize','bounty')), 0) + 0.05 < o.place_worth$gn5$]
);

SELECT pg_temp.ca_watch_subst(
  'public.fn_ca_tournament_settlement_mismatch(interval)',
  '7900253b783a7e6ce94b9f3b6ff92598', '06d38e190581c381f4ddfe2fb991f594',
  ARRAY[$mo1$                        AND COALESCE(w.category, '') <> 'bounty'), 0) AS paid$mo1$],
  ARRAY[$mn1$                        AND COALESCE(w.category, '') <> 'bounty'), 0)
           -- A DIAMOND EVENT PAYS FROM ITS OWN LEDGER (2026-10-08): its prizes
           -- are poker_diamond_tournament_ledger 'prize' rows, never wallet
           -- rows (bounty excluded, as on the wallet side). A chip event has
           -- no ledger rows, so this adds 0.
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = t.id AND l.kind = 'prize'), 0) AS paid$mn1$]
);

COMMIT;
