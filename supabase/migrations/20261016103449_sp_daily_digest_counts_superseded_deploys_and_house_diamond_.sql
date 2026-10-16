-- 20261016103449_sp_daily_digest_counts_superseded_deploys_and_house_diamond_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DAILY DIGEST COUNTS A SUPERSEDED DEPLOY AS SHIPPED, AND A HOUSE DIAMOND
-- PAYOUT AS A PAYOUT (2026-10-16)
--
-- 1. "2 engine deploy attempts did not ship" (Oct 14). Read from
--    ca_engine_deploy_attempts: the two were ids 1043 and 1045, both "stood
--    down before cutover; protected main had moved to <sha>", and both named
--    revisions shipped and were verified (ids 1042 and 1044). Standing an older
--    revision down for a newer one that contains it is the receiver working as
--    designed, and nothing failed. fn_sp_daily_metrics_compute counted every
--    row without shipped = true as a failure. It now counts a stand-down as
--    shipped only when the revision it names really shipped within twelve
--    hours, and reports the number as 'superseded'. Measured read-only over
--    the last ten days: Oct 14 reads 5 attempted, 5 shipped (2 superseded);
--    the two real non-ships on Oct 7 and Oct 9 still read as not shipped.
--
-- 2. Diamonds given out. Every diamond_transactions row typed 'transfer' in
--    the last seven days (7 rows, 100,460 diamonds) is a house payout with the
--    player as their own counterparty: Diamond Spins daily net settlements
--    (reference diamond-spin-day:) and Wheel cards (wheel-cards). The digest
--    drops 'transfer' from given out and taken in so peer transfers net out,
--    and so these payouts vanished from both totals. They are now named
--    diamond_spins_daily_net and wheel_cards, and counted. The Oct 14 "diamond
--    movement over 10,000" was one of them: KingFish's Diamond Spins daily net
--    settlement for Oct 13, +42,080.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545 /
-- 20261015222121. The live text must hash to today's measured md5, each anchor
-- must occur exactly once (measured read-only on production 2026-10-16: 1 and
-- 1), and the result must hash to the postimage derived read-only with
-- replace(); owner, security, settings and grants must not move. If another
-- change lands on this function first, this migration refuses whole.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = '0a7241d8426993393e54accdeec01676')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_sp_daily_metrics_compute(date)',
  'ba689a29f14e0e922969645550f8e9e6', '0a7241d8426993393e54accdeec01676',
  ARRAY[$o$SELECT user_id, COALESCE(transaction_type, type, 'unknown') tt, amount, created_at$o$, $o$'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE shipped))
                  FROM public.ca_engine_deploy_attempts WHERE at >= s AND at < e),$o$],
  ARRAY[$n$SELECT user_id,
           /* A HOUSE PAYOUT FILED AS A TRANSFER IS NOT A TRANSFER (2026-10-16).
              Diamond Spins daily net settlements and Wheel cards are booked as
              type 'transfer' with the player as their own counterparty. They
              are house movements, so they count as given out or taken in under
              their own names instead of vanishing with peer transfers. */
           CASE WHEN COALESCE(transaction_type, type) = 'transfer'
                     AND metadata->>'reference_id' LIKE 'diamond-spin-day:%' THEN 'diamond_spins_daily_net'
                WHEN COALESCE(transaction_type, type) = 'transfer'
                     AND metadata->>'reference_id' LIKE 'wheel-cards%' THEN 'wheel_cards'
                ELSE COALESCE(transaction_type, type, 'unknown') END tt, amount, created_at$n$, $n$'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE a.shipped OR a.superseded),
                                     'superseded', count(*) FILTER (WHERE a.superseded))
                  /* A RELEASE THAT STOOD DOWN FOR A NEWER ONE THAT SHIPPED DID
                     SHIP (2026-10-16). The receiver stands an older revision
                     down when protected main has moved on; the newer revision
                     contains it. Counted as shipped only when the revision it
                     names really shipped within twelve hours either side. */
                  FROM (SELECT x.shipped,
                               (NOT x.shipped AND EXISTS (
                                  SELECT 1 FROM public.ca_engine_deploy_attempts y
                                   WHERE y.shipped
                                     AND y.target_sha = substring(x.reason from 'protected main had moved to ([0-9a-f]{40})')
                                     AND y.at BETWEEN x.at - interval '12 hours' AND x.at + interval '12 hours')) AS superseded
                          FROM public.ca_engine_deploy_attempts x WHERE x.at >= s AND x.at < e) a),$n$]
);

COMMIT;
