-- 20261018230227_member_roster_follows_funded_records_and_private_source_events
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-18 23:02:27 UTC.
--
-- Player Management still counted physically filed hands while records and
-- statistics use immutable funded-club attribution. Use the same daily facts.
-- Existing source-owned member signals now invalidate authorized club rosters.
-- Empty payloads disclose no identity, wallet, financial or note values. One
-- signal per club/transaction bounds fanout. No raw facts or money are changed.
-- @live-proof: position('public.member_record_daily_facts' IN pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; old_source text; new_source text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO d;
 IF md5(d)<>'379d5a3158f831c0d2a2029248d1e517' THEN
   RAISE EXCEPTION 'Roster source preimage changed; qualify current definition';
 END IF;
 old_source:=$old$        SELECT r.user_id, r.hands
          FROM public.club_roster_hand_totals r
         WHERE r.club_id = p_club_id$old$;
 new_source:=$new$        SELECT r.user_id, sum(r.hands)::bigint AS hands
          FROM public.member_record_daily_facts r
         WHERE r.club_id = p_club_id
           AND r.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)
         GROUP BY r.user_id$new$;
 IF strpos(d,old_source)=0 THEN RAISE EXCEPTION 'Roster physical hand source missing'; END IF;
 EXECUTE replace(d,old_source,new_source);
END $patch$;
DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO original;
 IF md5(original)<>'c84b5e82605be9fc9ea1ad4c3b8f7567' THEN RAISE EXCEPTION 'Member detail source preimage changed'; END IF;
 d:=replace(original,'cm.promo_balance, cm.nickname, cm.notes, cm.display_name, cm.joined_at,',
                     'cm.promo_balance, cm.nickname, cm.notes, cm.display_name, cm.joined_at, cm.last_active_at,');
 d:=replace(d,'greatest(pr.last_login, pr.last_seen)','greatest(pr.last_login, pr.last_seen, m.last_active_at)');
 IF d=original THEN RAISE EXCEPTION 'Member last-active source missing'; END IF;
 EXECUTE d;
END $patch$;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
('club_members','member_record_membership','Private member/roster invalidation includes membership activity; no money writes.')
ON CONFLICT DO NOTHING;
CREATE OR REPLACE TRIGGER member_record_membership AFTER INSERT OR DELETE OR UPDATE OF user_id,club_id,role,agent_id,status,nickname,notes,display_name,joined_at,last_active_at
ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_publish_member_record_row();
CREATE FUNCTION public.ca_club_roster_can_subscribe(topic text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE club uuid; actor uuid:=auth.uid(); scope uuid[];
BEGIN
 IF actor IS NULL OR topic !~ '^club-roster:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
 club:=split_part(topic,':',2)::uuid;
 scope:=public.fn_club_scope_ids(club);
 IF scope IS NULL OR array_length(scope,1) IS NULL THEN RETURN false; END IF;
 -- Match the roster reader, including exact-club membership. Financial and
 -- note access remains a row-level decision in the authoritative reader.
 RETURN EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=actor AND coalesce(p.is_admin,false))
   OR coalesce(public.fn_is_union_overseer(club,actor),false)
   OR EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=club AND m.user_id=actor
             AND coalesce(m.status,'approved') IN ('active','approved'));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.ca_club_roster_can_subscribe(text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_roster_can_subscribe(text) TO authenticated;
CREATE POLICY "authorized viewers receive club roster changes" ON realtime.messages
FOR SELECT TO authenticated USING(extension='broadcast' AND topic=realtime.topic()
 AND public.ca_club_roster_can_subscribe(topic));
CREATE FUNCTION public.fn_publish_club_roster(p_club uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; sent jsonb:=coalesce(nullif(current_setting('ca.roster_signaled_clubs',true),''),'[]')::jsonb;
BEGIN
 IF p_club IS NULL THEN RETURN; END IF;
 FOR target IN
   SELECT p_club
   UNION SELECT c.union_id FROM public.clubs c JOIN public.clubs u ON u.id=c.union_id AND u.is_union WHERE c.id=p_club
   UNION SELECT uc.union_id FROM public.union_clubs uc JOIN public.clubs u ON u.id=uc.union_id AND u.is_union WHERE uc.club_id=p_club
 LOOP
   IF NOT sent ? target::text THEN
     PERFORM realtime.send('{}'::jsonb,'record_changed','club-roster:'||target::text,true);
     sent:=sent||to_jsonb(target::text);
     -- Local to the source transaction, including savepoint/rollback behavior.
     PERFORM set_config('ca.roster_signaled_clubs',sent::text,true);
   END IF;
 END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Club roster signal failed: %',SQLERRM;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_club_roster(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_publish_member_record_user(uuid)'::regprocedure) INTO original;
 IF md5(original)<>'a6bf5ce99a038531b24456db800580f8' THEN RAISE EXCEPTION 'Member user publisher preimage changed'; END IF;
 d:=replace(original,'  LOOP'||chr(10)||'    BEGIN','  LOOP'||chr(10)||'    PERFORM public.fn_publish_club_roster(target.club_id);'||chr(10)||'    BEGIN');
 IF d=original THEN RAISE EXCEPTION 'Member user publisher insertion point missing'; END IF;
 EXECUTE d;
 SELECT pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure) INTO original;
 IF md5(original)<>'ee35d1af0d781b48d9060423971f5eb0' THEN RAISE EXCEPTION 'Member row publisher preimage changed'; END IF;
 -- OLD/NEW source clubs cover removed/moved memberships after the user no
 -- longer has a membership in the former club.
 d:=replace(original,'    PERFORM public.fn_publish_member_record_user(old_user);',
   '    PERFORM public.fn_publish_member_record_user(old_user);'||chr(10)||'    PERFORM public.fn_publish_club_roster((r->>''club_id'')::uuid);');
 d:=replace(d,'    IF new_user IS DISTINCT FROM old_user THEN',
   '    PERFORM public.fn_publish_club_roster((r->>''club_id'')::uuid);'||chr(10)||'    IF new_user IS DISTINCT FROM old_user THEN');
 IF d=original THEN RAISE EXCEPTION 'Member row publisher insertion points missing'; END IF;
 EXECUTE d;
END $patch$;
COMMIT;
