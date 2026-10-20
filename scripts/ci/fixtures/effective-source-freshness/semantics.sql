\set ON_ERROR_STOP on
CREATE TABLE local_edge_expected(id uuid PRIMARY KEY,label text,expected boolean);
DO $edges$DECLARE r record; ident uuid;BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('base_at','2026-10-15 07:00Z'::timestamptz,'2026-10-20 16:00Z'::timestamptz,NULL::timestamptz,false,false),
 ('base_after','2026-10-15 07:00Z'::timestamptz,'2026-10-20 16:00:00.000001Z'::timestamptz,NULL::timestamptz,true,false),
 ('missing_admission_null_base','2026-10-15 07:00Z'::timestamptz,NULL::timestamptz,NULL::timestamptz,false,false),
 ('null_base_future_admission','2026-10-15 07:00Z'::timestamptz,NULL::timestamptz,'2099-01-01Z'::timestamptz,true,false),
 ('base_future_admission_at','2026-10-15 07:00Z'::timestamptz,'2099-01-01Z'::timestamptz,'2026-10-20 16:00Z'::timestamptz,true,false),
 ('earned_start_inclusive','2026-10-12 07:00Z'::timestamptz,'2099-01-01Z'::timestamptz,NULL::timestamptz,true,false),
 ('earned_end_exclusive','2026-10-19 07:00Z'::timestamptz,'2099-01-01Z'::timestamptz,NULL::timestamptz,false,false),
 ('out_of_club','2026-10-15 07:00Z'::timestamptz,'2099-01-01Z'::timestamptz,'2099-01-01Z'::timestamptz,false,true)
 )x(label,earned_at,recorded_at,admitted_at,expected,otherclub) LOOP
 ident:=md5('edge:'||r.label)::uuid;
 INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract)VALUES(ident,CASE WHEN r.otherclub THEN '99999999-9999-9999-9999-999999999999'::uuid ELSE 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid END,r.earned_at,r.recorded_at,'{}');
 IF r.admitted_at IS NOT NULL THEN INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES(ident,'{}',r.admitted_at);END IF;
 INSERT INTO local_edge_expected VALUES(ident,r.label,r.expected);
 END LOOP;
END $edges$;
DO $proof$ DECLARE bad bigint;n bigint;BEGIN
 SELECT count(*) INTO bad FROM local_edge_expected e LEFT JOIN public.accounting_effective_cash_rake_sources v ON v.id=e.id
 LEFT JOIN public.accounting_cash_rake_sources b ON b.id=e.id LEFT JOIN public.accounting_cash_atomic_contract_admissions a ON a.source_id=e.id
 WHERE ((v.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND v.earned_at>='2026-10-12 07:00Z' AND v.earned_at<'2026-10-19 07:00Z' AND v.recorded_at>'2026-10-20 16:00Z')IS TRUE) IS DISTINCT FROM e.expected
 OR ((b.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND b.earned_at>='2026-10-12 07:00Z' AND b.earned_at<'2026-10-19 07:00Z' AND (b.recorded_at>'2026-10-20 16:00Z' OR a.admitted_at>'2026-10-20 16:00Z'))IS TRUE) IS DISTINCT FROM e.expected;
 IF bad<>0 THEN RAISE EXCEPTION 'scope_null_future_strict_boundary_failed %',bad;END IF;
 -- Full complete-predicate comparison over local population, actual six IDs
 -- and their exact admission boundaries, plus pilot completed receipt cutoff.
 WITH cases AS(SELECT s.club_id,a.admitted_at+d.delta cutoff FROM public.accounting_cash_atomic_contract_admissions a JOIN public.accounting_cash_rake_sources s ON s.id=a.source_id CROSS JOIN(VALUES(interval '-1 microsecond'),(interval '0 microsecond'),(interval '1 microsecond'))d(delta)
 UNION ALL SELECT 'e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-20 15:41:33.726198Z'::timestamptz),flags AS(
 SELECT c.*,EXISTS(SELECT FROM public.accounting_effective_cash_rake_sources v WHERE v.club_id=c.club_id AND v.earned_at>='2026-10-12 07:00Z' AND v.earned_at<'2026-10-19 07:00Z' AND v.recorded_at>c.cutoff) old_value,
 (EXISTS(SELECT FROM (SELECT b.earned_at FROM public.accounting_cash_rake_sources b WHERE b.club_id=c.club_id AND b.recorded_at>c.cutoff OFFSET 0)b WHERE b.earned_at>='2026-10-12 07:00Z' AND b.earned_at<'2026-10-19 07:00Z')
 OR EXISTS(SELECT FROM (SELECT a.source_id FROM public.accounting_cash_atomic_contract_admissions a WHERE a.admitted_at>c.cutoff OFFSET 0)a CROSS JOIN LATERAL(SELECT b.club_id,b.earned_at FROM public.accounting_cash_rake_sources b WHERE b.id=a.source_id OFFSET 0)b WHERE b.club_id=c.club_id AND b.earned_at>='2026-10-12 07:00Z' AND b.earned_at<'2026-10-19 07:00Z')) new_value FROM cases c)
 SELECT count(*)FILTER(WHERE old_value IS DISTINCT FROM new_value),count(*)INTO bad,n FROM flags;
 IF bad<>0 THEN RAISE EXCEPTION 'full_original_vs_equivalent_predicate_failed %',bad;END IF;
 RAISE NOTICE 'LOCAL_FULL_PREDICATE_CASES % EDGE_CASES 8 MISMATCHES 0',n;
END $proof$;

-- Synthetic NULL cases above exceed current production constraints. Remove only
-- those local edge rows and restore exact production NOT NULL before installation.
DELETE FROM public.accounting_cash_atomic_contract_admissions a USING public.accounting_cash_rake_sources s WHERE a.source_id=s.id AND s.recorded_at IS NULL;
DELETE FROM public.accounting_cash_rake_sources WHERE recorded_at IS NULL;
ALTER TABLE public.accounting_cash_rake_sources ALTER COLUMN club_id SET NOT NULL, ALTER COLUMN earned_at SET NOT NULL, ALTER COLUMN recorded_at SET NOT NULL;
ALTER TABLE public.accounting_cash_atomic_contract_admissions ALTER COLUMN admitted_at SET NOT NULL;
