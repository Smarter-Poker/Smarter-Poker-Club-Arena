-- 20261019021553_member_statistics_fees_read_fee_ledger
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 02:15:53 UTC.
--
-- Player Statistics summed per-hand rake from the first recorded hand, while
-- Player Management and the member record read the fee ledger, which counts
-- from fn_ca_fee_counting_start() (Monday 2026-10-12) and includes tournament
-- fees. The same member therefore showed two different Fees figures. For all
-- games, Statistics now reads the exact ledger total the member record reads,
-- for the same club, member and dates. A single game has no ledger split, so
-- it sums that game's rake from the same counting start. No money is written.
-- @live-proof: position('ca_club_member_fee_totals' IN pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; original text; old_source text; new_source text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure) INTO original;
 IF md5(original)<>'2970d3c0117def4e112bae20baff2d48' THEN
   RAISE EXCEPTION 'Member statistics source preimage changed; qualify current definition';
 END IF;
 old_source:=$old$           coalesce(sum(f.fees),0) AS fees,$old$;
 new_source:=$new$           coalesce(sum(f.fees) FILTER (WHERE f.played_on >= public.fn_ca_fee_counting_start()),0) AS fees,$new$;
 IF strpos(original,old_source)=0 THEN RAISE EXCEPTION 'Statistics fee sum preimage missing'; END IF;
 d:=replace(original,old_source,new_source);
 old_source:=$old$'net', round(a.net,2), 'fees', round(a.fees,2),$old$;
 new_source:=$new$'net', round(a.net,2),
    'fees', CASE WHEN v_variant IS NULL OR v_variant='all'
                 THEN coalesce((SELECT lf.total_fees FROM public.ca_club_member_fee_totals(p_club_id, p_from, p_to, p_user_id) lf
                                 WHERE lf.user_id=p_user_id), 0)
                 ELSE round(a.fees,2) END,$new$;
 IF strpos(d,old_source)=0 THEN RAISE EXCEPTION 'Statistics fee output preimage missing'; END IF;
 EXECUTE replace(d,old_source,new_source);
END $patch$;
COMMIT;
