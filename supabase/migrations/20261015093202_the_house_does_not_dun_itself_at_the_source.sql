-- 20261015093202_the_house_does_not_dun_itself_at_the_source.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE HOUSE DOES NOT DUN ITSELF, AT THE SOURCE (2026-10-15)
--
-- What fired. At the :35 union integrity sweep of 2026-10-15 07:35 UTC,
-- fn_union_age_invoices escalated MIDWAY-2026-000015 (Club JAQK, 126,153.66)
-- and MIDWAY-2026-000017 (SHARK CLUB, 124,015.29) at 7.02 days past due, and
-- fn_union_enforce_stop_loss suspended BOTH clubs from Midway Union with
-- "stop_loss_breached: ... unpaid more than 7 days past due" (financial alerts
-- 491b3b86, 552c0553, f3808384, 9efcf8f6 and their four drift incidents; the
-- 07:40 to 07:50 rows are the incident escalation ticks of the same four).
--
-- What changed. Nothing in the 20261015* migrations touches the union books.
-- The statements for the week 2026-09-28 .. 2026-10-05 were issued
-- 2026-10-07 21:35 due 2026-10-08 07:00; on 2026-10-15 07:35 they crossed the
-- seven-day grace. This is the SAME episode as 2026-09-24 / 2026-09-26
-- (MIDWAY-2026-000005/000006), which 20261002165500_the_house_does_not_dun_itself
-- answered by WAIVING the four statements then open with credit notes. That
-- migration's own header said the next statements "would suspend the clubs
-- again". A one-off waiver is a compensating write (CLAUDE.md 10.12); the line
-- that produces the outcome was never changed, so it recurred one week later.
--
-- The cause, read from rows. Club JAQK (a0000000-...-0001), SHARK CLUB
-- (a41434bb) and the third member club 2a1132b9 have clubs.owner_id equal to
-- unions.owner_id of Midway Union (fade0000-...-0001). The weekly square-up is
-- an off-ledger statement (no chip moves; ca_union_set_statement_paid only
-- records a payment), so a statement whose debtor club and creditor union
-- have ONE owner is a debt the owner owes himself: no payment can ever be
-- recorded against it, and every one of them ages, escalates and suspends.
--   fn_union_age_invoices       selects every club-owes-union square-up past
--                               due and chases it (reminders, then a critical
--                               alert at level 3);
--   fn_union_enforce_stop_loss  sums those same statements past grace and
--                               suspends the club.
-- Neither asks who owns the two books.
--
-- The fix, in both functions (the two places that treat a square-up as a
-- collectible receivable): a square-up owed by a club whose owner owns the
-- union is not a receivable. It is still issued and delivered (the statement
-- is the club's weekly accounting), it is never marked overdue, chased,
-- escalated or counted toward suspension. Nothing is waived, nothing is
-- credited, no number on any statement moves.
--
-- The enforcer's restore branch now also closes the suspension's own open
-- alert when it restores the club, so the record of a suspension ends when
-- the suspension does (2026-10-02 this was done by hand).
--
-- Effect after install: the next :35 sweep finds nothing past grace for
-- Club JAQK and SHARK CLUB (no stop-loss limit on file: exposure_state
-- no_limit), restores both, and resolves f3808384 and 9efcf8f6 (their
-- incidents follow through zz_ca_alert_resolution_reaches_the_incident). The
-- two age_invoices alerts are resolved here: under the corrected rule the
-- statements they name are not receivables.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to the md5 read on production 2026-10-15
-- (age 20ed85f3..., enforcer e36819df...), each anchor must occur exactly
-- once, and the result must hash to the postimage derived read-only on
-- production with replace(); owner, SECURITY DEFINER, proconfig and grants
-- must not move.
--
-- Regression: scripts/ci/test-the-house-does-not-dun-itself.py (native
-- PostgreSQL), run by .github/workflows/the-house-does-not-dun-itself.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_age_invoices(uuid)'::regprocedure)) = '60ad1fb7ca887133bf93fd5aaab80b30' AND md5(pg_get_functiondef('public.fn_union_enforce_stop_loss(uuid)'::regprocedure)) = '64b6418cf751bc785f358f77ebf6dddf')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_house_subst(p_sig text, p_before text, p_after text,
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

-- 1. The dunning ladder never chases a debt the owner owes himself.
SELECT pg_temp.ca_house_subst(
  'public.fn_union_age_invoices(uuid)',
  '20ed85f3c1b63072fb8f7966658f1423', '60ad1fb7ca887133bf93fd5aaab80b30',
  ARRAY[$ao1$       AND si.from_entity_type = 'club'             -- only what the CLUB owes
$ao1$],
  ARRAY[$an1$       AND si.from_entity_type = 'club'             -- only what the CLUB owes
       -- THE HOUSE DOES NOT DUN ITSELF (20261015093202). A club whose owner
       -- owns the union owes this off-ledger square-up to himself: no payment
       -- can ever be recorded against it, so it is a statement, not a
       -- receivable. It is never marked overdue, chased or escalated.
       AND NOT EXISTS (SELECT 1 FROM clubs c JOIN unions u ON u.id = p_union_id
                        WHERE c.id = si.club_id AND c.owner_id = u.owner_id)
$an1$]
);

-- 2. The stop-loss never suspends a club for a debt its owner owes himself,
--    and a restore closes the suspension's own alert.
SELECT pg_temp.ca_house_subst(
  'public.fn_union_enforce_stop_loss(uuid)',
  'e36819dfda5eafa1a7152ae0fddb7e3d', '64b6418cf751bc785f358f77ebf6dddf',
  ARRAY[$eo1$       AND si.status = 'overdue'
       AND si.due_at < now() - make_interval(days => v_grace);
$eo1$,
        $eo2$        IF FOUND THEN
          v_restored := v_restored + 1;
$eo2$],
  ARRAY[$en1$       AND si.status = 'overdue'
       AND si.due_at < now() - make_interval(days => v_grace)
       -- THE HOUSE DOES NOT DUN ITSELF (20261015093202): a square-up owed by
       -- a club whose owner owns the union is not a receivable and never
       -- counts toward suspension.
       AND NOT EXISTS (SELECT 1 FROM clubs c JOIN unions u ON u.id = p_union_id
                        WHERE c.id = si.club_id AND c.owner_id = u.owner_id);
$en1$,
        $en2$        IF FOUND THEN
          v_restored := v_restored + 1;
          -- A suspension's record ends when the suspension does
          -- (20261015093202): the alert that announced it is resolved by the
          -- same run that restores the club.
          UPDATE financial_alerts f
             SET resolved = true, resolved_at = now(),
                 resolution = r.club_name || ' restored to active by fn_union_enforce_stop_loss: '
                              || 'nothing is owed past grace and the exposure leg is '
                              || v_exp_state || '.'
           WHERE f.source = 'fn_union_enforce_stop_loss'
             AND NOT COALESCE(f.resolved, false)
             AND f.context->>'outcome' IS NULL
             AND f.context->>'union_id' = p_union_id::text
             AND f.context->>'club_id' = r.club_id::text;
$en2$]
);

-- 3. The two escalations of 2026-10-15 named statements that, under the
--    corrected rule, are not receivables. Their incidents follow through
--    zz_ca_alert_resolution_reaches_the_incident. The two suspension alerts
--    (f3808384, 9efcf8f6) are closed by the enforcer itself when the next
--    :35 run restores the clubs.
UPDATE public.financial_alerts f
   SET resolved = true, resolved_at = now(),
       resolution = 'Resolved by migration 20261015093202_the_house_does_not_dun_itself_at_the_source: '
                    || 'the statement named here is owed by a club whose owner owns Midway Union, '
                    || 'an off-ledger debt the owner owes himself. fn_union_age_invoices and '
                    || 'fn_union_enforce_stop_loss no longer treat such a square-up as a receivable. '
                    || 'Nothing was waived or credited.'
 WHERE f.id IN ('491b3b86-1379-4eef-8025-7ff0e06786a8', '552c0553-d608-43b9-b8b4-150055968191')
   AND f.source = 'fn_union_age_invoices'
   AND NOT COALESCE(f.resolved, false)
   AND EXISTS (SELECT 1 FROM public.settlement_invoices si
                 JOIN public.clubs c ON c.id = si.club_id
                 JOIN public.unions u ON u.id = (si.breakdown->>'union_id')::uuid
                WHERE si.id::text = f.context->>'invoice_id'
                  AND c.owner_id = u.owner_id);

COMMIT;
