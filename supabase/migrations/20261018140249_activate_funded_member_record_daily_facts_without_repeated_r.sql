-- 20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: EXISTS(SELECT 1 FROM public.member_record_daily_facts_state WHERE singleton AND initialized)
-- @live-proof: position('ca_member_record_daily_facts' IN pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure))>0
-- One facts/delta snapshot seeds reporting only. Source facts, money and
-- membership remain untouched. The prior migration captures every concurrent
-- insert/update/delete atomically; subtracting its captured deltas avoids both
-- a write lock on ca_hand_facts and double counting during initialization.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8min';
SELECT pg_advisory_xact_lock(hashtextextended('member_record_daily_initialization',0));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.member_record_daily_facts_state WHERE singleton AND NOT initialized)
 THEN RAISE EXCEPTION 'Funded record facts already initialized or state missing'; END IF;
END $$;
WITH buyins AS MATERIALIZED (
 SELECT DISTINCT ON (table_id,account_entity_id,seat_joined_at)
   table_id,account_entity_id,seat_joined_at,funding_club_id
 FROM public.cash_participant_funding_receipts WHERE operation_kind='buyin' AND seat_joined_at IS NOT NULL
 ORDER BY table_id,account_entity_id,seat_joined_at,recorded_at DESC,id DESC
), funding AS MATERIALIZED (
 SELECT *,lead(seat_joined_at) OVER(PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) until_at FROM buyins
), bounds AS MATERIALIZED (
 SELECT id club_id,public.fn_ca_launch_accounting_cutoff('club',id) cutoff FROM public.clubs
), projected AS (
 SELECT coalesce(x.funding_club_id,tp.club_id,ra.club_id,f.club_id) attributed_club,f.*
 FROM public.ca_hand_facts f
 LEFT JOIN funding x ON f.tournament_id IS NULL AND x.table_id=f.table_id AND x.account_entity_id=f.user_id
   AND f.played_at>=x.seat_joined_at AND (x.until_at IS NULL OR f.played_at<x.until_at)
 LEFT JOIN public.tournament_players tp ON tp.tournament_id=f.tournament_id AND tp.user_id=f.user_id
 LEFT JOIN public.rake_attributions ra ON x.funding_club_id IS NULL AND tp.club_id IS NULL
   AND ra.hand_id=f.hand_id AND ra.player_id=f.user_id
), facts AS MATERIALIZED (
 SELECT f.attributed_club club_id,f.user_id,(f.played_at AT TIME ZONE 'UTC')::date played_on,
   lower(f.game_variant) game_variant,f.tournament_id IS NOT NULL is_mtt,b.cutoff accounting_cutoff,
sum(1)::bigint hands,sum(CASE WHEN net>0 THEN 1 ELSE 0 END)::bigint wins,sum(CASE WHEN vpip THEN 1 ELSE 0 END)::bigint vpip_hands,sum(CASE WHEN pfr THEN 1 ELSE 0 END)::bigint pfr_hands,sum(CASE WHEN three_bet THEN 1 ELSE 0 END)::bigint tb_hands,sum(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)::bigint faced_tb,sum(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)::bigint folded_tb,sum(CASE WHEN cbet_flop THEN 1 ELSE 0 END)::bigint cb_hands,sum(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)::bigint cb_opps,sum(coalesce(rake_paid,0)) fees,sum(coalesce(net,0)) net
 FROM projected f JOIN bounds b ON b.club_id=f.attributed_club
 WHERE b.cutoff IS NULL OR (f.played_at IS NOT NULL AND isfinite(f.played_at) AND f.played_at>=b.cutoff)
 GROUP BY f.attributed_club,f.user_id,(f.played_at AT TIME ZONE 'UTC')::date,lower(f.game_variant),f.tournament_id IS NOT NULL,b.cutoff
), captured AS MATERIALIZED (SELECT * FROM public.member_record_daily_facts), baseline AS (
 SELECT coalesce(f.club_id,c.club_id) club_id,coalesce(f.user_id,c.user_id) user_id,
 coalesce(f.played_on,c.played_on) played_on,coalesce(f.game_variant,c.game_variant) game_variant,
 coalesce(f.is_mtt,c.is_mtt) is_mtt,coalesce(f.accounting_cutoff,c.accounting_cutoff) accounting_cutoff,
coalesce(f.hands,0)-coalesce(c.hands,0) hands,coalesce(f.wins,0)-coalesce(c.wins,0) wins,coalesce(f.vpip_hands,0)-coalesce(c.vpip_hands,0) vpip_hands,coalesce(f.pfr_hands,0)-coalesce(c.pfr_hands,0) pfr_hands,coalesce(f.tb_hands,0)-coalesce(c.tb_hands,0) tb_hands,coalesce(f.faced_tb,0)-coalesce(c.faced_tb,0) faced_tb,coalesce(f.folded_tb,0)-coalesce(c.folded_tb,0) folded_tb,coalesce(f.cb_hands,0)-coalesce(c.cb_hands,0) cb_hands,coalesce(f.cb_opps,0)-coalesce(c.cb_opps,0) cb_opps,coalesce(f.fees,0)-coalesce(c.fees,0) fees,coalesce(f.net,0)-coalesce(c.net,0) net
 FROM facts f FULL JOIN captured c ON f.club_id=c.club_id AND f.user_id=c.user_id
 AND f.played_on IS NOT DISTINCT FROM c.played_on AND f.game_variant IS NOT DISTINCT FROM c.game_variant AND f.is_mtt=c.is_mtt AND f.accounting_cutoff IS NOT DISTINCT FROM c.accounting_cutoff
)
INSERT INTO public.member_record_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
SELECT club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net FROM baseline ORDER BY club_id,user_id,played_on,game_variant,is_mtt
ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt,accounting_cutoff) DO UPDATE SET hands=totals.hands+EXCLUDED.hands,wins=totals.wins+EXCLUDED.wins,vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,tb_hands=totals.tb_hands+EXCLUDED.tb_hands,faced_tb=totals.faced_tb+EXCLUDED.faced_tb,folded_tb=totals.folded_tb+EXCLUDED.folded_tb,cb_hands=totals.cb_hands+EXCLUDED.cb_hands,cb_opps=totals.cb_opps+EXCLUDED.cb_opps,fees=totals.fees+EXCLUDED.fees,net=totals.net+EXCLUDED.net;
UPDATE public.member_record_daily_facts_state SET initialized=true WHERE singleton;

CREATE FUNCTION public.ca_member_record_daily_facts(p_club uuid,p_user uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS SETOF public.club_member_daily_facts LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT f.club_id,f.user_id,f.played_on,f.game_variant,f.is_mtt,f.hands,f.wins,f.vpip_hands,f.pfr_hands,
 f.tb_hands,f.faced_tb,f.folded_tb,f.cb_hands,f.cb_opps,f.fees,f.net
 FROM public.member_record_daily_facts f WHERE f.club_id=p_club AND f.user_id=p_user
 AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club)
   AND (p_from IS NULL OR f.played_on>=p_from) AND (p_to IS NULL OR f.played_on<=p_to);
$$;
REVOKE ALL ON FUNCTION public.ca_member_record_daily_facts(uuid,uuid,date,date) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text; original text; signature text; expected text;
BEGIN
  FOR signature,expected IN VALUES
    ('public.ca_club_member_detail(uuid,uuid,date,date)','ce4165a61260c5356b5866f76f788d49'),
    ('public.ca_club_member_statistics(uuid,uuid,text,date,date)','f35a75648faa264d56942b1f3767fd84'),
    ('public.ca_club_member_win_loss(uuid,uuid)','677c50f872c128c20b3d735caab8ad9a'),
    ('public.ca_club_members_win_loss(uuid,uuid[],text)','7273bd6ce991bb7bb77f13443f16524e')
  LOOP
    original:=pg_get_functiondef(signature::regprocedure);
    IF md5(original)<>expected THEN RAISE EXCEPTION 'Member reader preimage changed: %',signature; END IF;
    d:=original;
    IF signature LIKE '%member_detail(%' THEN
      d:=regexp_replace(d,'  \), ranged_roll AS MATERIALIZED \(.*?  \), ledger_fee AS MATERIALIZED \(',
$replacement$  ), roll AS MATERIALIZED (
    SELECT coalesce(sum(r.hands) FILTER(WHERE NOT r.is_mtt),0)::bigint hands,
      coalesce(sum(r.hands) FILTER(WHERE r.is_mtt),0)::bigint mtt_hands,
      coalesce(sum(r.net) FILTER(WHERE NOT r.is_mtt),0) net,
      coalesce(sum(r.net) FILTER(WHERE r.is_mtt),0) mtt_net
    FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,p_from,p_to) r
    WHERE v_sensitive
  ), ledger_fee AS MATERIALIZED ($replacement$,'s');
    ELSIF signature LIKE '%member_statistics(%' THEN
      d:=replace(d,'public.club_member_daily_facts f','public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) f');
    ELSIF signature LIKE '%member_win_loss(%' THEN
      d:=replace(d,'public.club_member_daily_facts f','public.ca_member_record_daily_facts(p_club_id,p_user_id,v_earliest,v_today) f');
      d:=replace(d,'SELECT coalesce(t.net, 0) INTO v_cash_all','SELECT coalesce(sum(t.net) FILTER(WHERE NOT t.is_mtt), 0) INTO v_cash_all');
      d:=replace(d,'LEFT JOIN public.club_member_play_totals t','LEFT JOIN public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) t');
    ELSE
      d:=replace(d,'SELECT coalesce(t.net, 0) FROM (SELECT 1) anchor','SELECT coalesce(sum(t.net) FILTER(WHERE NOT t.is_mtt), 0) FROM (SELECT 1) anchor');
      d:=replace(d,'LEFT JOIN public.club_member_play_totals t','LEFT JOIN public.ca_member_record_daily_facts(p_club_id,al.uid,NULL,NULL) t');
      d:=replace(d,'public.club_member_daily_facts f','public.ca_member_record_daily_facts(p_club_id,al.uid,v_from,v_today) f');
    END IF;
    IF d=original THEN RAISE EXCEPTION 'Member reader anchor missing: %',signature; END IF;
    EXECUTE d;
  END LOOP;
END $patch$;

-- Mounts that joined while initialization ran must observe the atomic reader
-- cutover without waiting for another hand, a focus change or a manual reload.
DO $activate$ DECLARE member_id uuid; BEGIN
 FOR member_id IN SELECT DISTINCT user_id FROM public.member_record_daily_facts LOOP
   PERFORM public.fn_publish_member_record_user(member_id);
 END LOOP;
END $activate$;
COMMIT;
