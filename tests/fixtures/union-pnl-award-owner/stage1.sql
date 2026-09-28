-- After 20260928211132 + 20260928222109 and the opening resolution writer:
-- the opening basis is ready, and the report refuses exactly the two in-week tests.
CREATE FUNCTION public.hx_expect(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',p_msg; END IF; RAISE NOTICE 'PASS %',p_msg; END $$;
SELECT public.hx_expect((public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',
 'Opening basis 2026-09-21: pre-capture entries re-proved from the posted chip ledger',true)->>'resolved_now')::int=3,'the writer resolves o1, o2 and f1');
CREATE TABLE public.hx_old AS SELECT v.k,public.fn_union_pnl_evidence_report(v.id,'2026-09-21 07:00+00','2026-09-28 07:00+00') r
 FROM (VALUES('U',public.u('U')),('O',public.u('O'))) v(k,id);
SELECT public.hx_expect((SELECT r->'issues' FROM public.hx_old WHERE k='U')=
 '[{"count":3,"reason":"tournament_original_population_or_instrument_incomplete"},{"count":3,"reason":"tournament_award_original_earning_owner_incomplete"}]'::jsonb
 AND (SELECT r#>>'{opening_basis,status}' FROM public.hx_old WHERE k='U')='ready',
 'before: opening basis ready; 3 touched unreceipted registrations and 3 receipt-less awards refuse the book');
