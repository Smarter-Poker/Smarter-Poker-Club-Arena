-- After the migration.
CREATE FUNCTION public.hx_expect(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',p_msg; END IF; RAISE NOTICE 'PASS %',p_msg; END $$;
CREATE FUNCTION public.hx_raises(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN EXECUTE p_sql; RETURN false;
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; RETURN s=p_state; END $$;
CREATE TABLE public.hx_dry AS SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',NULL,false) r;
SELECT public.hx_expect((SELECT (r->>'candidates')::int=16 AND (r->>'proven_not_written')::int=6 AND (r->>'refused')::int=10
  AND (r->>'resolved_now')::int=0 AND (r->>'entry_amount')::numeric=81 AND (r->>'returned')::numeric=5 AND (r->>'deferred_amount')::numeric=76
  AND r->>'applied'='false' FROM public.hx_dry),'dry run: 16 candidates, 6 proven (81 in, 5 returned, 76 deferred), 10 refused');
SELECT public.hx_expect(NOT EXISTS(SELECT 1 FROM public.union_pnl_opening_registration_resolutions),'dry run writes nothing');
-- every refusal names its first failing reason
SELECT public.hx_expect((SELECT bool_and(p.proof->>'status'=e.status AND p.proof->>'reason' IS NOT DISTINCT FROM e.reason) AND count(*)=16
 FROM public.fn_union_pnl_prove_opening_registrations(public.u('U'),'2026-09-21 07:00+00') p
 JOIN (VALUES('o1','proven',NULL),('o2','proven',NULL),('o4','proven',NULL),('f1','proven',NULL),('f2','proven',NULL),('b0','proven',NULL),
  ('b1','refused','entry_debit_count_does_not_match_schedule'),('b2','refused','entry_amount_does_not_match_schedule'),
  ('b3','refused','entry_debit_count_does_not_match_schedule'),('b4','refused','non_chip_instrument'),('b5','refused','funding_club_ambiguous'),
  ('b6','refused','post_capture_entry_debit_unreceipted'),('b7','refused','return_credited_to_another_club'),
  ('b8','refused','entry_debit_not_posted_to_this_tournament_prize_pool'),('b9','refused','non_chip_instrument'),
  ('b10','refused','return_evidence_incomplete')) e(k,status,reason) ON p.registration_id=public.u(e.k)),
 'each registration is proven or refused for its own reason (count, amount, missing, ticket, two clubs, unreceipted debit, other-club return, unposted, satellite, unreceipted return)');
SELECT public.hx_expect((SELECT p.proof->>'owning_club_id'=public.u('A')::text AND (p.proof->>'entries')::int=2 AND (p.proof->>'entry_amount')::numeric=1
  FROM public.fn_union_pnl_prove_opening_registrations(public.u('U'),'2026-09-21 07:00+00') p WHERE p.registration_id=public.u('f1')),
 'a free-buy entry is owned by its registration club and counts its ledger add-on');
SELECT public.hx_expect(public.fn_union_pnl_boundary(public.u('U'),'2026-09-21 07:00+00')=(SELECT b FROM public.hx_before WHERE k='U')
 AND public.fn_union_pnl_boundary(public.u('O'),'2026-09-21 07:00+00')=(SELECT b FROM public.hx_before WHERE k='O'),
 'without receipts the new boundary is identical to the old one, value for value');
SELECT public.hx_expect(public.hx_raises($q$SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',NULL,true)$q$,'22023')
 AND public.hx_raises($q$SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-22 07:00+00','a reason long enough to count',true)$q$,'22023'),
 'the writer refuses to apply without a reason or off a week boundary');
CREATE TABLE public.hx_apply AS SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',
 'Opening basis 2026-09-21: pre-capture entries re-proved from the posted chip ledger',true) r;
SELECT public.hx_expect((SELECT (r->>'resolved_now')::int=6 AND (r->>'refused')::int=10 FROM public.hx_apply)
 AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions)=6,'apply writes exactly the six proven receipts');
SELECT public.hx_expect((SELECT (r->>'already_resolved')::int=6 AND (r->>'resolved_now')::int=0
 FROM (SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00','Opening basis 2026-09-21: re-run is idempotent',true) r) q),
 'a second apply is idempotent');
CREATE TABLE public.hx_after AS SELECT public.fn_union_pnl_boundary(public.u('U'),'2026-09-21 07:00+00') b;
SELECT public.hx_expect((SELECT b->'issues' FROM public.hx_after)=(SELECT jsonb_agg(e ORDER BY o) FROM public.hx_before h,
  jsonb_array_elements(h.b->'issues') WITH ORDINALITY x(e,o) WHERE h.k='U' AND e->>'tournament_id' IS DISTINCT FROM public.u('T_OK')::text
   AND e->>'tournament_id' IS DISTINCT FROM public.u('T_FREE')::text),
 'T_OK and T_FREE are read; T_BAD (unresolved registrations) and T_INS i2 are refused exactly as before');
SELECT public.hx_expect((SELECT jsonb_agg(h ORDER BY h->>'source_id') FROM public.hx_after a,jsonb_array_elements(a.b->'holdings') h
   WHERE h->>'source_id'=public.u('i1')::text)=(SELECT jsonb_agg(h) FROM public.hx_before x,jsonb_array_elements(x.b->'holdings') h WHERE x.k='U'),
 'the INSERT tournament holding is identical');
SELECT public.hx_expect((SELECT jsonb_object_agg(h->>'source_id',jsonb_build_array(h->>'club_id',(h->>'amount')::numeric,h->>'basis'))
  FROM public.hx_after a,jsonb_array_elements(a.b->'holdings') h WHERE h->>'source_id'<>public.u('i1')::text)
 =jsonb_build_object(public.u('o1'),jsonb_build_array(public.u('A'),15,'opening_registration_resolution'),
  public.u('o2'),jsonb_build_array(public.u('B'),20,'opening_registration_resolution'),
  public.u('o3'),jsonb_build_array(public.u('A'),20,NULL),
  public.u('o4'),jsonb_build_array(public.u('B'),20,'opening_registration_resolution'),
  public.u('f1'),jsonb_build_array(public.u('A'),1,'opening_registration_resolution'),
  public.u('f2'),jsonb_build_array(public.u('B'),0,'opening_registration_resolution')),
 'resolved registrations are carried at entry less returns, owned by the debited club; o3 by its own receipt');
SELECT public.hx_expect(public.fn_union_pnl_boundary(public.u('O'),'2026-09-21 07:00+00')=(SELECT b FROM public.hx_before WHERE k='O'),
 'another Union is untouched');
-- a resolution binds the exact population row: change it and the tournament is refused again
DO $$
DECLARE ok boolean;
BEGIN
 BEGIN
  UPDATE public.hx_inventory SET result=jsonb_set(result,'{population,tournament_players}',(SELECT jsonb_agg(CASE WHEN x#>>'{row,id}'=public.u('o2')::text
    THEN jsonb_set(x,'{row,club_id}',to_jsonb(public.u('A')::text)) ELSE x END ORDER BY o) FROM jsonb_array_elements(result#>'{population,tournament_players}') WITH ORDINALITY y(x,o)))
   WHERE boundary='2026-09-21 07:00+00';
  ok:=public.fn_union_pnl_boundary(public.u('U'),'2026-09-21 07:00+00')->'issues' @> jsonb_build_array(jsonb_build_object(
   'reason','open_tournament_precedes_original_population','tournament_id',public.u('T_OK')));
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE=CASE WHEN ok THEN 'rollback_ok' ELSE 'rollback_bad' END;
 EXCEPTION WHEN raise_exception THEN
  PERFORM public.hx_expect(SQLERRM='rollback_ok','a resolution does not survive a change of its registration row');
 END;
END $$;
SELECT public.hx_expect(public.hx_raises('UPDATE public.union_pnl_opening_registration_resolutions SET returned=returned','55000')
 AND public.hx_raises('DELETE FROM public.union_pnl_opening_registration_resolutions','55000'),'resolutions are immutable');
SET ROLE service_role;
SELECT public.hx_expect(public.hx_raises($q$INSERT INTO public.union_pnl_opening_registration_resolutions SELECT * FROM public.union_pnl_opening_registration_resolutions LIMIT 1$q$,'42501')
 AND public.hx_raises($q$SELECT * FROM public.fn_union_pnl_prove_opening_registrations(public.u('U'),'2026-09-21 07:00+00')$q$,'42501'),
 'service_role reads receipts and runs the writer only: it cannot insert one or call the prover');
RESET ROLE;
SET ROLE anon;
SELECT public.hx_expect(public.hx_raises($q$SELECT public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',NULL,false)$q$,'42501'),
 'the browser cannot run the writer');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ALL PASS'; END $$;
