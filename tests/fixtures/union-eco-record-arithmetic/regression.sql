-- THE ECO RECORD ANSWERS FOR ITS OWN ARITHMETIC (20260925145748)
--
-- fn_union_issue_weekly_invoices has refused a square-up whose ECO disagrees
-- with union_eco_ledger since 20260921040847. That same migration taught
-- fn_union_club_invoice to RETURN the recorded amount:
--
--   CASE WHEN eco.eco_enabled THEN COALESCE(rec.eco_amount, eco.eco_amount)
--        ELSE 0 END AS eco_amount
--
-- so for the only arm that reaches the comparison - ECO enabled, record
-- present, the recordless arm having already been refused by
-- union_squareup_eco_not_recorded - the guard compares the record to itself and
-- can never fire. Proven in the Sept 28 rehearsal: a recorded eco_amount
-- mutated by 0.01 produced an invoice restating the mutated figure in silence.
--
-- The naive repair is the 2026-09-14 defect. Comparing against a fresh
-- fn_union_eco_adjustment call is what overstated club a41434bb's debt by 1.21:
-- fn_union_pnl_evidence_report is VOLATILE and each call takes its own READ
-- COMMITTED snapshot. So the independent basis is taken from INSIDE the record.
-- union_eco_ledger stores eco_base, eco_rate and eco_amount side by side, all
-- three NOT NULL, and the producer defines the amount as
-- round(-eco_rate*eco_base,2). Three stored numerics; no recomputation of the
-- week; nothing that can move between two calls.
--
-- This runs on the same private native cluster that has just closed a real
-- raked week end to end, so every assertion is made against ECO the cascade
-- actually recorded.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','The ECO record arithmetic fixture runs only in the private native cluster');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- (1) THE SHAPE. All three refusals are present, and all three are raised
-- before settlement_invoices is written.
DO $shape$
DECLARE src text;
BEGIN
 SELECT prosrc INTO src FROM pg_proc
  WHERE oid='public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
 PERFORM fixture.assert(strpos(src,'union_squareup_eco_not_recorded')>0,'an ECO-enabled square-up with no recorded ECO is still refused');
 PERFORM fixture.assert(strpos(src,'union_squareup_eco_disagrees_with_record')>0,'a document that does not quote its record is still refused');
 PERFORM fixture.assert(strpos(src,'union_squareup_eco_record_fails_its_own_arithmetic')>0,'a recorded ECO that fails its own arithmetic is refused');
 PERFORM fixture.assert(strpos(src,'union_squareup_eco_record_fails_its_own_arithmetic')<strpos(src,'INSERT INTO settlement_invoices'),
  'the arithmetic refusal is raised before the document is written');
 -- The volatile recomputation is not back. The writer calls
 -- fn_union_eco_adjustment exactly once, before the loop, for
 -- baseline_cash_exact; the ECO refusals read only union_eco_ledger.
 PERFORM fixture.assert((length(src)-length(replace(src,'fn_union_eco_adjustment','')))/length('fn_union_eco_adjustment')=1,
  'the ECO refusals read the record, never a second volatile recomputation of the week');
END $shape$;

-- (2) EVERY ECO THIS CLUSTER HAS RECORDED SATISFIES THE INVARIANT. If a real
-- closed week could not satisfy it, the guard would refuse a legitimate
-- settlement, which is the one thing it must never do.
DO $holds$
DECLARE bad int; total int;
BEGIN
 SELECT count(*) FILTER (WHERE round(-l.eco_rate*l.eco_base,2) IS DISTINCT FROM round(l.eco_amount,2)), count(*)
   INTO bad, total FROM public.union_eco_ledger l;
 PERFORM fixture.assert(total>0,format('the raked week recorded ECO to check (%s rows)',total));
 PERFORM fixture.assert(bad=0,format('every recorded ECO equals round(-eco_rate*eco_base,2) (%s of %s failing)',bad,total));
END $holds$;

-- (3) A MUTATED RECORD IS REFUSED BY NAME. The tamper and the call share one
-- subtransaction, so catching the refusal rolls the mutation back with it - the
-- record is left exactly as the cascade wrote it, and the fixture asserts that.
DO $tamper$
DECLARE
 r record; fired text; v_sqlstate text;
BEGIN
 SELECT l.union_id, l.club_id, l.period_start, l.period_end, l.eco_amount
   INTO r FROM public.union_eco_ledger l
  ORDER BY l.period_start DESC, l.club_id LIMIT 1;
 PERFORM fixture.assert(r.union_id IS NOT NULL,'a recorded ECO row is available to tamper with');

 BEGIN
  UPDATE public.union_eco_ledger SET eco_amount=eco_amount+0.01
   WHERE union_id=r.union_id AND club_id=r.club_id AND period_start=r.period_start;
  PERFORM public.fn_union_issue_weekly_invoices(r.union_id,r.period_start,r.period_end,false);
  fired:='<the square-up stated the mutated figure and raised nothing>';
 EXCEPTION WHEN OTHERS THEN
  fired:=SQLERRM; v_sqlstate:=SQLSTATE;
 END;
 PERFORM fixture.assert(fired='union_squareup_eco_record_fails_its_own_arithmetic',
  'a recorded ECO mutated by 0.01 is refused by its own arithmetic, not restated: '||COALESCE(fired,'<null>'));
 PERFORM fixture.assert(v_sqlstate='23514','the arithmetic refusal keeps the check_violation SQLSTATE its neighbours use: '||COALESCE(v_sqlstate,'<null>'));
 PERFORM fixture.assert((SELECT eco_amount FROM public.union_eco_ledger
    WHERE union_id=r.union_id AND club_id=r.club_id AND period_start=r.period_start)=r.eco_amount,
  'the refused subtransaction left the recorded ECO exactly as the cascade wrote it');
END $tamper$;

-- (4) THE UNTAMPERED WEEK IS NOT REFUSED. The same call, on the record the
-- cascade wrote, still issues. A guard that cannot distinguish a tampered
-- record from a real one is not a guard.
DO $accepted$
DECLARE r record; result jsonb;
BEGIN
 SELECT l.union_id, l.period_start, l.period_end INTO r FROM public.union_eco_ledger l
  ORDER BY l.period_start DESC, l.club_id LIMIT 1;
 result:=public.fn_union_issue_weekly_invoices(r.union_id,r.period_start,r.period_end,false);
 PERFORM fixture.assert(result->>'success'='true',
  'the real recorded week still issues its square-ups with the arithmetic guard armed: '||result::text);
 PERFORM fixture.assert((result->>'invoices')::int>0,format('the accepted run issued its documents (%s)',result->>'invoices'));
END $accepted$;

-- (5) THE ECO-DISABLED ARM IS KEPT, AND IS NOT EXERCISED HERE - THE REASON IS
-- ITSELF A PLATFORM RULE. With ECO terms disabled fn_union_club_invoice states
-- 0, so a non-zero recorded ECO for the same period is a disagreement the writer
-- must refuse. That arm is the one arm of the old comparison that was never a
-- tautology, and it is kept verbatim. It cannot be reached from a fixture,
-- because eco_enabled does not come from unions.settings at read time: since
-- 20260917230515 the commercial terms are observed at their ORIGINAL write and
-- travel with the period's recorded evidence, so flipping the union's settings
-- now does not change what an already-recorded week's invoice reports - measured
-- on this cluster, the flip left eco_enabled true and the arm silent. Reaching
-- it would mean rewriting recorded evidence, which is the thing the platform
-- forbids. So this asserts the arm exists, is distinct from the arithmetic
-- refusal, and precedes the document.
DO $disabled$
DECLARE src text;
BEGIN
 SELECT prosrc INTO src FROM pg_proc
  WHERE oid='public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
 PERFORM fixture.assert(strpos(src,'IF NOT r.eco_enabled AND round(COALESCE(v_recorded_eco, 0), 2) <> 0 THEN')>0,
  'the ECO-disabled arm is kept: a non-zero recorded ECO cannot be stated as 0');
 PERFORM fixture.assert((length(src)-length(replace(src,'union_squareup_eco_disagrees_with_record','')))
   /length('union_squareup_eco_disagrees_with_record')=2,
  'both arms of the old comparison are still raised, under the name the existing fixtures read');
 PERFORM fixture.assert(strpos(src,'IF NOT r.eco_enabled')<strpos(src,'INSERT INTO settlement_invoices'),
  'and it is raised before the document is written');
END $disabled$;
