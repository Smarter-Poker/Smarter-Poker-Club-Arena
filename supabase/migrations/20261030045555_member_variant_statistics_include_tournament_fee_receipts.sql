-- Reserved by scripts/new-migration.mjs.
-- Rooster #1004748, KINGS CLUB, UTC 2026-10-26..29: All Variants
-- includes 18.50 tournament fees, but NLH showed 0 despite 8.00 in immutable
-- NLH fee receipts. Per-hand tournament rake is zero, so a.fees cannot supply
-- entry/rebuy/add-on fees. Add the selected game's receipt credits, using the
-- existing fee counting floor and inclusive UTC date bounds. Cash hand rake,
-- all-game fee accounting, permissions, hands, rates and money are unchanged.
-- No financial writes or hot-table DDL. The existing (club_id,player_id)
-- receipt index bounds the read before the tournament game join.
-- @live-proof: position('member_variant_tournament_fee_receipts' IN pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE original text; old_source text; new_source text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure) INTO original;
 IF md5(original)<>'eccc2baff56f434c1309e4cb8632bdb8' THEN
   RAISE EXCEPTION 'Member variant fee preimage changed or migration already installed';
 END IF;
 old_source:=$old$                 ELSE round(a.fees,2) END,$old$;
 new_source:=$new$                 ELSE round(a.fees + coalesce((
                   -- member_variant_tournament_fee_receipts
                   SELECT sum(receipt.rake_credit)
                     FROM public.accounting_tournament_fee_sources receipt
                     JOIN public.tournaments tournament ON tournament.id=receipt.tournament_id
                    WHERE receipt.club_id=p_club_id AND receipt.player_id=p_user_id
                      AND lower(tournament.game_type)=v_variant
                      AND receipt.charged_at >= greatest(coalesce(p_from,public.fn_ca_fee_counting_start()),public.fn_ca_fee_counting_start())::timestamp AT TIME ZONE 'UTC'
                      AND (v_to IS NULL OR receipt.charged_at < v_to)
                 ),0),2) END,$new$;
 IF (length(original)-length(replace(original,old_source,'')))/length(old_source)<>1 THEN
   RAISE EXCEPTION 'Member variant fee output preimage missing or ambiguous';
 END IF;
 EXECUTE replace(original,old_source,new_source);
END $patch$;
COMMIT;
