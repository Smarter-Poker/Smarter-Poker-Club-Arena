-- Every member/club uses these source-owned, private identity-only invalidations.
-- No balances, financial rows or hand facts are changed.
BEGIN;
SET LOCAL lock_timeout='2s';
DROP TRIGGER member_record_profile ON public.profiles;
CREATE TRIGGER member_record_profile AFTER UPDATE OF player_number,alias,username,display_name,first_name,last_name,full_name,arena_avatar_url,avatar_url,last_login,last_seen,is_online,status
ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
DROP TRIGGER member_record_membership ON public.club_members;
CREATE TRIGGER member_record_membership AFTER INSERT OR DELETE OR UPDATE OF user_id,club_id,role,agent_id,status,nickname,notes,display_name,joined_at
ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
-- A parent's player number is also displayed on its direct children's records.
DO $patch$
DECLARE original text; patched text;
BEGIN
 SELECT pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure) INTO original;
 patched:=replace(original,
 'ROW(OLD.alias,OLD.username,OLD.display_name,OLD.status,OLD.first_name,OLD.last_name,OLD.full_name)',
 'ROW(OLD.alias,OLD.username,OLD.display_name,OLD.status,OLD.first_name,OLD.last_name,OLD.full_name,OLD.player_number)');
 patched:=replace(patched,
 'ROW(NEW.alias,NEW.username,NEW.display_name,NEW.status,NEW.first_name,NEW.last_name,NEW.full_name)',
 'ROW(NEW.alias,NEW.username,NEW.display_name,NEW.status,NEW.first_name,NEW.last_name,NEW.full_name,NEW.player_number)');
 IF patched=original THEN RAISE EXCEPTION 'Member source function preimage mismatch'; END IF;
 EXECUTE patched;
END $patch$;
CREATE FUNCTION public.fn_publish_member_record_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u uuid;
BEGIN
 IF TG_TABLE_NAME='clubs' THEN
   IF NEW.name IS NOT DISTINCT FROM OLD.name THEN RETURN NULL; END IF;
   FOR u IN SELECT DISTINCT user_id FROM public.club_members WHERE club_id=NEW.id LOOP
     PERFORM public.fn_publish_member_record_user(u);
   END LOOP;
 ELSE
   IF ROW(NEW.status,NEW.club_id,NEW.name,NEW.stakes,NEW.tournament_id,NEW.is_deleted) IS NOT DISTINCT FROM ROW(OLD.status,OLD.club_id,OLD.name,OLD.stakes,OLD.tournament_id,OLD.is_deleted) THEN RETURN NULL; END IF;
   FOR u IN SELECT DISTINCT user_id FROM public.table_seats WHERE table_id=NEW.id AND left_at IS NULL LOOP
     PERFORM public.fn_publish_member_record_user(u);
   END LOOP;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_context() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_record_club AFTER UPDATE OF name ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_context();
CREATE TRIGGER member_record_table AFTER UPDATE OF status,club_id,name,stakes,tournament_id,is_deleted ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_context();
CREATE TRIGGER member_record_agent AFTER INSERT OR DELETE OR UPDATE OF user_id,club_id,status,agent_wallet_balance,promo_wallet_balance ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
('agents','member_record_agent','Private record invalidation of agent wallet/status; no money writes.');
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
('club_members','member_record_membership','Private record and upline invalidation including joined date and removals; no money writes.')
ON CONFLICT DO NOTHING;
-- Totals read all current transactions, so corrections/removals must invalidate too.
CREATE OR REPLACE FUNCTION public.fn_publish_member_record_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_row jsonb; new_row jsonb; u uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND old_row=new_row THEN RETURN NULL; END IF;
 FOR u IN SELECT DISTINCT x FROM unnest(ARRAY[
   (old_row->>'from_user_id')::uuid,(old_row->>'to_user_id')::uuid,
   (new_row->>'from_user_id')::uuid,(new_row->>'to_user_id')::uuid]) x WHERE x IS NOT NULL LOOP
   PERFORM public.fn_publish_member_record_user(u);
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER member_record_transaction ON public.chip_transactions;
CREATE TRIGGER member_record_transaction AFTER INSERT OR UPDATE OR DELETE ON public.chip_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_transaction();
DROP TRIGGER member_record_cash_fee ON public.ca_club_rake_daily_user;
CREATE TRIGGER member_record_cash_fee AFTER INSERT OR UPDATE OR DELETE ON public.ca_club_rake_daily_user
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
DROP TRIGGER member_record_tournament_fee ON public.ca_club_member_tournament_fee_daily;
CREATE TRIGGER member_record_tournament_fee AFTER INSERT OR UPDATE OR DELETE ON public.ca_club_member_tournament_fee_daily
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
COMMIT;
