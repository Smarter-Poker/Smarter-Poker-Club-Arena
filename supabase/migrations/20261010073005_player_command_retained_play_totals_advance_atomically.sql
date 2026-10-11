-- Exact retained cash/MTT play totals at the facts writer, not a repair job.
-- A live cold member record exceeded the database request deadline; indexed
-- reads still touch thousands of heap pages. Preserve retention and all units.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE TABLE public.club_member_play_totals (
  club_id uuid NOT NULL, user_id uuid NOT NULL,
  hands bigint NOT NULL DEFAULT 0,
  mtt_hands bigint NOT NULL DEFAULT 0,
  fees numeric NOT NULL DEFAULT 0,
  mtt_fees numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  mtt_net numeric NOT NULL DEFAULT 0,
  PRIMARY KEY(club_id,user_id)
);
ALTER TABLE public.club_member_play_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_member_play_totals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_member_play_totals TO service_role;
CREATE TABLE public.club_member_play_totals_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  initialized boolean NOT NULL DEFAULT false
);
INSERT INTO public.club_member_play_totals_state VALUES(true,false);
ALTER TABLE public.club_member_play_totals_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_member_play_totals_state FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_member_play_totals_state TO service_role;
CREATE FUNCTION public.fn_club_member_play_totals_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_play_totals_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_play_totals_insert
AFTER INSERT ON public.ca_hand_facts
REFERENCING NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_play_totals_insert();
CREATE FUNCTION public.fn_club_member_play_totals_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts UNION ALL SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_play_totals_update() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_play_totals_update
AFTER UPDATE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_play_totals_update();
CREATE FUNCTION public.fn_club_member_play_totals_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_member_play_totals_delete() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_club_member_play_totals_delete
AFTER DELETE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts 
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_member_play_totals_delete();
COMMIT;
