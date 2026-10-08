-- 20261008044146_a_diamond_event_is_conserved_by_its_diamond_custody.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DIAMOND EVENT IS CONSERVED BY ITS DIAMOND CUSTODY (2026-10-08)
--
-- fn_tournament_money_conservation (hourly :12 and the deep daily pass) has
-- three open financial_alerts "Tournament paid out money it never
-- collected", raised 2026-10-07 18:12, 20:12 and 2026-10-08 02:12 UTC for
-- three "Sunday Deep Stack Satellite" events (e2ea5f2a -600.00, 3bea3ecb
-- -200.00, 7e56f752 -200.00). All three are Diamond Arena events (club
-- 002c2d27-..., asset diamonds), spawned since the arena began running the
-- Midway schedule (20261007000010, 20261007010105).
--
-- A Diamond event's money never touches the chip books: its entries, fee,
-- prizes and seats move through poker_diamond_custody and the Diamond
-- journal. fn_tournament_conservation_delta and its one-pass twin
-- fn_tournament_conservation_deltas read only wallet_transactions,
-- rake_records, chip_ledger and tournament_payouts, so for a Diamond
-- satellite they see the seats it paid (tournament_payouts satellite_seat)
-- and no money in, and report the whole seat value as unfunded. Measured
-- read-only on production 2026-10-08: no wallet_transactions, rake_records or
-- chip_ledger row exists for any of the three, and
-- fn_poker_diamond_tournament_custody reads 0 for each (custody closed
-- exactly). The other side is already visible too: the target "Sunday $200
-- Deep Stack" (02b6bf8a, Diamond, REGISTERING for 2026-10-11) reads +1000.00
-- from the redeemed seats alone, and would page "retained money it never
-- paid out" (and appear to fn_pay_backed_payout_shortfalls' report) the hour
-- it completes. A detector defect: the Diamond events are conserved.
--
-- THE FIX: in both functions, a tournament of a diamonds-asset club is
-- conserved by its Diamond entry custody: its delta is the custody it still
-- holds (fn_poker_diamond_tournament_custody, 0 once it closed exactly), and
-- the chip arithmetic is unchanged for every chip event. The scalar and the
-- set function keep identical arithmetic, so the scan and the alert
-- auto-resolve (pass 1 of fn_tournament_money_conservation) agree; the next
-- hourly pass auto-resolves the three alerts because their custody is 0.
-- fn_pay_backed_payout_shortfalls keeps its own copy of the arithmetic and is
-- a money path; it is not edited here (it runs report-only, p_apply false).
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545 for
-- each function. Live text must hash to today's measured md5 (scalar
-- bfbb3e61..., set 365e9948..., both equal to their repo definitions in
-- 20261003034305 and 20261003095111), each anchor must occur exactly once,
-- and each result must hash to the postimage derived read-only on production
-- with replace() over the same bytes; owner, SECURITY DEFINER, proconfig and
-- grants (postgres, service_role) must not move. A second run refuses.
--
-- Regression: scripts/ci/test-diamond-event-conservation.py (native
-- PostgreSQL), run by .github/workflows/diamond-event-conservation.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = '4944504d426d4c34fd7a577c7b4bdd3a' AND md5(pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure)) = 'a202f925eea2157bb33dd7fda141b9f7')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_detector_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_detector_subst(
  'public.fn_tournament_conservation_delta(uuid)',
  'bfbb3e617d7c8290ac8916e21bf0c2a4', '4944504d426d4c34fd7a577c7b4bdd3a',
  ARRAY[$o1$    SELECT t.id, t.ended_at,
$o1$,
        $o2$  SELECT round(
      m.money_in$o2$,
        $o3$  , 2)
  FROM m;$o3$],
  ARRAY[$n1$    SELECT t.id, t.ended_at,
      -- A DIAMOND EVENT KEEPS NO CHIP BOOK (2026-10-08); see the final SELECT.
      EXISTS (SELECT 1 FROM public.clubs dc
               WHERE dc.id = t.club_id AND dc.asset = 'diamonds') AS diamond,
$n1$,
        $n2$  -- A DIAMOND EVENT IS CONSERVED BY ITS DIAMOND CUSTODY (2026-10-08). Its
  -- entries, fee, prizes and seats move through poker_diamond_custody and the
  -- Diamond journal, never wallet_transactions or chip_ledger, so the chip
  -- arithmetic below reads a Diamond satellite's seats as money paid out of
  -- nothing and its target's seats as money kept. Its delta is the entry
  -- custody it still holds: 0 once it closed exactly.
  SELECT CASE WHEN m.diamond
    THEN public.fn_poker_diamond_tournament_custody(m.id)::numeric
    ELSE round(
      m.money_in$n2$,
        $n3$  , 2) END
  FROM m;$n3$]
);

SELECT pg_temp.ca_detector_subst(
  'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)',
  '365e9948c804059253d73cd35ed6e3d4', 'a202f925eea2157bb33dd7fda141b9f7',
  ARRAY[$o1$    SELECT t.id, t.name, t.variant, t.ended_at
    FROM public.tournaments t
$o1$,
        $o2$  SELECT e.id, e.name, e.variant, e.ended_at,
    round(COALESCE(w.money_in, 0)$o2$,
        $o3$COALESCE(so.amount, 0), 2) AS delta$o3$],
  ARRAY[$n1$    SELECT t.id, t.name, t.variant, t.ended_at,
      EXISTS (SELECT 1 FROM public.clubs dc
               WHERE dc.id = t.club_id AND dc.asset = 'diamonds') AS diamond
    FROM public.tournaments t
$n1$,
        $n2$  SELECT e.id, e.name, e.variant, e.ended_at,
    -- A Diamond event is conserved by its Diamond custody, as in the scalar.
    CASE WHEN e.diamond
    THEN public.fn_poker_diamond_tournament_custody(e.id)::numeric
    ELSE round(COALESCE(w.money_in, 0)$n2$,
        $n3$COALESCE(so.amount, 0), 2) END AS delta$n3$]
);

COMMIT;
