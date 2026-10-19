-- 20261019095431_member_statistics_net_reads_tournament_money
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 09:54:31 UTC.
--
-- Player Statistics "Net" (ca_club_member_statistics) summed
-- member_record_daily_facts.net over cash AND tournament hands. The
-- tournament half is the change in tournament STACK chips, not money, so a
-- Club JAQK member showed about -1.97M while their Win/Loss net (cash result
-- plus tournament prizes minus buy-ins) was a few thousand. Net now uses the
-- Win/Loss definition for the same club, member and UTC calendar range:
--
--   all games:   cash hand net + ca_club_member_tournament_money(range)
--   one game:    that game's cash hand net + tournament money of that game's
--                tournaments only (chip_ledger.tournament_id joined to
--                tournaments.game_type; lower(game_type) is the same code the
--                daily facts store, checked 2026-10-19 on 1,861 tournaments
--                with zero mismatches and on 1.4M recent legs with no missing
--                tournament row or unknown code).
--
-- The single-game tournament sum repeats ca_club_member_tournament_money's two
-- legs exactly, adding only the game join; both legs read the covering
-- indexes from 20261019095423. Hands, fees (20261019021553) and every rate
-- statistic are unchanged; chip-based rates stay correct for VPIP and the rest.
-- Builds on 20261019021553: the preimage below is the definition that
-- migration installs. No money is written.
-- @live-proof: position('ca_club_member_tournament_money(p_club_id, p_user_id, v_from, v_to)' IN pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; original text; old_source text; new_source text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure) INTO original;
 IF md5(original)<>'76a6dae4741581f7d8751676a7c670b6' THEN
   RAISE EXCEPTION 'Member statistics source preimage changed; qualify current definition';
 END IF;
 old_source:=$old$           coalesce(sum(f.net),0) AS net$old$;
 new_source:=$new$           coalesce(sum(f.net) FILTER (WHERE NOT f.is_mtt),0) AS net$new$;
 IF strpos(original,old_source)=0 THEN RAISE EXCEPTION 'Statistics hand net preimage missing'; END IF;
 d:=replace(original,old_source,new_source);
 old_source:=$old$'net', round(a.net,2),$old$;
 new_source:=$new$'net', round(a.net + CASE WHEN v_variant IS NULL OR v_variant='all'
      THEN coalesce(public.ca_club_member_tournament_money(p_club_id, p_user_id, v_from, v_to), 0)
      ELSE coalesce((SELECT sum(leg.signed) FROM (
             SELECT l.amount AS signed
               FROM public.chip_ledger l JOIN public.tournaments t ON t.id = l.tournament_id
              WHERE l.club_id = p_club_id AND l.to_entity_id = p_user_id
                AND l.to_type = 'player_wallet' AND l.from_type = 'prize_liability'
                AND l.tournament_id IS NOT NULL AND l.status = 'posted'
                AND (v_from IS NULL OR l.created_at >= v_from)
                AND (v_to IS NULL OR l.created_at < v_to)
                AND lower(t.game_type) = v_variant
             UNION ALL
             SELECT -l.amount
               FROM public.chip_ledger l JOIN public.tournaments t ON t.id = l.tournament_id
              WHERE l.club_id = p_club_id AND l.from_entity_id = p_user_id
                AND l.from_type = 'player_wallet' AND l.to_type = 'prize_liability'
                AND l.tournament_id IS NOT NULL AND l.status = 'posted'
                AND (v_from IS NULL OR l.created_at >= v_from)
                AND (v_to IS NULL OR l.created_at < v_to)
                AND lower(t.game_type) = v_variant) leg), 0) END, 2),$new$;
 IF strpos(d,old_source)=0 THEN RAISE EXCEPTION 'Statistics net output preimage missing'; END IF;
 EXECUTE replace(d,old_source,new_source);
END $patch$;
COMMIT;
