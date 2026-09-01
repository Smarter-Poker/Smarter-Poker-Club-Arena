-- Canonical club/union game management and operator-controlled live ticker.
-- A standalone club manages itself. Once it joins a union, only the union
-- owner/admin may manage those games, through the union scope.

CREATE TABLE IF NOT EXISTS public.game_ticker_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  union_id uuid REFERENCES public.unions(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_ticker_one_scope CHECK ((club_id IS NULL) <> (union_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS game_ticker_settings_club_unique
  ON public.game_ticker_settings(club_id) WHERE club_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS game_ticker_settings_union_unique
  ON public.game_ticker_settings(union_id) WHERE union_id IS NOT NULL;
ALTER TABLE public.game_ticker_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_ticker_settings FROM anon, authenticated;

-- Identity copy displayed around the club is managed alongside its games.
-- lobby_message separates the 72-character lobby rail from the longer club
-- description; historically both surfaces wrote clubs.description and the
-- short editor could silently destroy the long description.
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS lobby_message text;
UPDATE public.clubs SET lobby_message=left(regexp_replace(description,'[\r\n]+',' ','g'),72)
  WHERE lobby_message IS NULL AND COALESCE(description,'')<>'';
UPDATE public.clubs SET tagline=left(tagline,72) WHERE char_length(COALESCE(tagline,''))>72;
UPDATE public.clubs SET description=left(description,500) WHERE char_length(COALESCE(description,''))>500;
UPDATE public.club_announcements SET title=left(title,100),content=left(content,2000),message=left(COALESCE(message,content),2000);
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_tagline_character_limit;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_lobby_message_character_limit;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_description_character_limit;
ALTER TABLE public.clubs ADD CONSTRAINT clubs_tagline_character_limit CHECK(char_length(COALESCE(tagline,''))<=72);
ALTER TABLE public.clubs ADD CONSTRAINT clubs_lobby_message_character_limit CHECK(char_length(COALESCE(lobby_message,''))<=72);
ALTER TABLE public.clubs ADD CONSTRAINT clubs_description_character_limit CHECK(char_length(COALESCE(description,''))<=500);
ALTER TABLE public.club_announcements DROP CONSTRAINT IF EXISTS club_announcements_title_character_limit;
ALTER TABLE public.club_announcements DROP CONSTRAINT IF EXISTS club_announcements_content_character_limit;
ALTER TABLE public.club_announcements ADD CONSTRAINT club_announcements_title_character_limit CHECK(char_length(title)<=100);
ALTER TABLE public.club_announcements ADD CONSTRAINT club_announcements_content_character_limit CHECK(char_length(content)<=2000);

CREATE OR REPLACE FUNCTION public.fn_sync_club_announcement_message()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.content:=COALESCE(NEW.content,NEW.message,'');
    NEW.message:=NEW.content;
  ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.message:=NEW.content;
  ELSIF NEW.message IS DISTINCT FROM OLD.message THEN
    NEW.content:=COALESCE(NEW.message,'');
  END IF;
  IF char_length(NEW.title)>100 OR char_length(NEW.content)>2000 THEN
    RAISE EXCEPTION 'Club announcement exceeds its display character limit' USING ERRCODE='22001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sync_club_announcement_message ON public.club_announcements;
CREATE TRIGGER trg_sync_club_announcement_message BEFORE INSERT OR UPDATE OF title,content,message
  ON public.club_announcements FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_announcement_message();

CREATE OR REPLACE FUNCTION public.fn_is_union_operator(p_union_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.unions u WHERE u.id=p_union_id AND u.owner_id=p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id=p_union_id AND a.user_id=p_user_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.fn_save_game_ticker_settings(
  p_scope text,
  p_scope_id uuid,
  p_settings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_sanitized jsonb;
  v_font text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_scope NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_scope');
  END IF;

  IF p_scope='club' THEN
    v_access := public.fn_game_creation_access(p_scope_id);
    IF COALESCE((v_access->>'allowed')::boolean,false)=false OR v_access->>'union_id' IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_authorized');
    END IF;
  ELSIF NOT public.fn_is_union_operator(p_scope_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;

  v_font := CASE WHEN p_settings->>'font_family' IN ('Rajdhani','Inter','Roboto Condensed','System')
    THEN p_settings->>'font_family' ELSE 'Rajdhani' END;
  v_sanitized := jsonb_build_object(
    'enabled', COALESCE((p_settings->>'enabled')::boolean,true),
    'speed_seconds', LEAST(60,GREATEST(8,COALESCE((p_settings->>'speed_seconds')::int,24))),
    'background_color', CASE WHEN COALESCE(p_settings->>'background_color','') ~ '^#[0-9A-Fa-f]{6}$' THEN p_settings->>'background_color' ELSE '#0b1a33' END,
    'text_color', CASE WHEN COALESCE(p_settings->>'text_color','') ~ '^#[0-9A-Fa-f]{6}$' THEN p_settings->>'text_color' ELSE '#f5fbff' END,
    'accent_color', CASE WHEN COALESCE(p_settings->>'accent_color','') ~ '^#[0-9A-Fa-f]{6}$' THEN p_settings->>'accent_color' ELSE '#00d4ff' END,
    'font_family', v_font,
    'sources', COALESCE(p_settings->'sources','{}'::jsonb),
    'custom_messages', COALESCE((SELECT jsonb_agg(left(regexp_replace(value,'\s+',' ','g'),160)) FROM jsonb_array_elements_text(COALESCE(p_settings->'custom_messages','[]'::jsonb)) WITH ORDINALITY m(value,ord) WHERE ord<=10),'[]'::jsonb)
  );

  IF p_scope='club' THEN
    INSERT INTO public.game_ticker_settings(club_id,settings,created_by)
    VALUES(p_scope_id,v_sanitized,v_uid)
    ON CONFLICT (club_id) WHERE club_id IS NOT NULL DO UPDATE SET settings=EXCLUDED.settings,updated_at=now();
  ELSE
    INSERT INTO public.game_ticker_settings(union_id,settings,created_by)
    VALUES(p_scope_id,v_sanitized,v_uid)
    ON CONFLICT (union_id) WHERE union_id IS NOT NULL DO UPDATE SET settings=EXCLUDED.settings,updated_at=now();
  END IF;
  RETURN jsonb_build_object('ok',true,'settings',v_sanitized);
END $$;

CREATE OR REPLACE FUNCTION public.fn_get_game_ticker_settings(p_club_id uuid DEFAULT NULL,p_union_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_settings jsonb; v_union uuid:=p_union_id;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  IF v_union IS NULL AND p_club_id IS NOT NULL THEN
    SELECT member_union_id INTO v_union FROM public.fn_club_union_context(p_club_id);
  END IF;
  IF v_union IS NOT NULL THEN
    IF NOT (public.fn_is_union_operator(v_union,v_uid) OR EXISTS(
      SELECT 1 FROM public.union_clubs uc JOIN public.club_members cm ON cm.club_id=uc.club_id
      WHERE uc.union_id=v_union AND cm.user_id=v_uid AND cm.status IN ('active','approved')
    )) THEN RETURN NULL; END IF;
    SELECT settings INTO v_settings FROM public.game_ticker_settings WHERE union_id=v_union;
  ELSE
    IF p_club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=v_uid AND cm.status IN ('active','approved')) THEN RETURN NULL; END IF;
    SELECT settings INTO v_settings FROM public.game_ticker_settings WHERE club_id=p_club_id;
  END IF;
  RETURN COALESCE(v_settings,'{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.fn_get_club_message_management(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_identity jsonb; v_announcements jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  SELECT jsonb_build_object(
    'tagline',COALESCE(c.tagline,''),
    'lobby_message',COALESCE(c.lobby_message,''),
    'description',COALESCE(c.description,'')
  ) INTO v_identity FROM public.clubs c WHERE c.id=p_club_id;
  IF v_identity IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','club_not_found'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',a.id,'title',a.title,'content',a.content,'is_pinned',COALESCE(a.is_pinned,false),
    'is_active',COALESCE(a.is_active,true),'created_at',a.created_at
  ) ORDER BY a.is_pinned DESC,a.created_at DESC),'[]'::jsonb)
  INTO v_announcements FROM public.club_announcements a WHERE a.club_id=p_club_id;
  RETURN jsonb_build_object('ok',true,'identity',v_identity,'announcements',v_announcements);
END $$;

CREATE OR REPLACE FUNCTION public.fn_save_club_identity_messages(
  p_club_id uuid,p_tagline text,p_lobby_message text,p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_tagline text; v_lobby text; v_description text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF char_length(COALESCE(p_tagline,''))>72 OR char_length(COALESCE(p_lobby_message,''))>72 OR char_length(COALESCE(p_description,''))>500 THEN
    RETURN jsonb_build_object('ok',false,'reason','character_limit');
  END IF;
  v_tagline:=trim(regexp_replace(COALESCE(p_tagline,''),'[\r\n\t ]+',' ','g'));
  v_lobby:=trim(regexp_replace(COALESCE(p_lobby_message,''),'[\r\n\t ]+',' ','g'));
  v_description:=trim(COALESCE(p_description,''));
  UPDATE public.clubs SET tagline=NULLIF(v_tagline,''),lobby_message=NULLIF(v_lobby,''),description=NULLIF(v_description,''),updated_at=now() WHERE id=p_club_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','club_not_found'); END IF;
  RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION public.fn_manage_club_announcement(
  p_action text,p_club_id uuid,p_announcement_id uuid DEFAULT NULL,p_title text DEFAULT NULL,
  p_content text DEFAULT NULL,p_is_pinned boolean DEFAULT false,p_is_active boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_id uuid:=p_announcement_id; v_title text; v_content text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF p_action='delete' THEN
    DELETE FROM public.club_announcements WHERE id=v_id AND club_id=p_club_id;
    RETURN jsonb_build_object('ok',FOUND);
  ELSIF p_action='set_pin' THEN
    UPDATE public.club_announcements SET is_pinned=p_is_pinned,updated_at=now() WHERE id=v_id AND club_id=p_club_id;
    RETURN jsonb_build_object('ok',FOUND);
  ELSIF p_action='set_active' THEN
    UPDATE public.club_announcements SET is_active=p_is_active,updated_at=now() WHERE id=v_id AND club_id=p_club_id;
    RETURN jsonb_build_object('ok',FOUND);
  ELSIF p_action<>'save' THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_action');
  END IF;
  IF char_length(COALESCE(p_title,''))>100 OR char_length(COALESCE(p_content,''))>2000 THEN
    RETURN jsonb_build_object('ok',false,'reason','character_limit');
  END IF;
  v_title:=trim(regexp_replace(COALESCE(p_title,''),'[\r\n\t ]+',' ','g'));
  v_content:=trim(COALESCE(p_content,''));
  IF v_title='' OR v_content='' THEN RETURN jsonb_build_object('ok',false,'reason','message_required'); END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.club_announcements(club_id,author_id,created_by,title,content,message,is_pinned,is_active)
    VALUES(p_club_id,v_uid,v_uid,v_title,v_content,v_content,p_is_pinned,p_is_active) RETURNING id INTO v_id;
  ELSE
    UPDATE public.club_announcements SET title=v_title,content=v_content,message=v_content,is_pinned=p_is_pinned,is_active=p_is_active,updated_at=now()
      WHERE id=v_id AND club_id=p_club_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','announcement_not_found'); END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.fn_update_managed_game(p_kind text,p_game_id uuid,p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_club uuid; v_players int; v_status text; v_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_kind='table' THEN
    SELECT club_id,current_players,status INTO v_club,v_players,v_status FROM public.tables WHERE id=p_game_id FOR UPDATE;
  ELSIF p_kind='tournament' THEN
    SELECT club_id,current_players,status INTO v_club,v_players,v_status FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
  ELSE RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind'); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
  v_name:=left(regexp_replace(COALESCE(p_patch->>'name',''),'\s+',' ','g'),80);
  IF length(trim(v_name))=0 THEN RETURN jsonb_build_object('ok',false,'reason','name_required'); END IF;
  IF p_kind='table' THEN
    IF v_players>0 OR lower(v_status) IN ('running','active') THEN
      UPDATE public.tables SET name=v_name,updated_at=now() WHERE id=p_game_id;
    ELSE
      IF (p_patch->>'small_blind')::numeric<=0 OR (p_patch->>'big_blind')::numeric<(p_patch->>'small_blind')::numeric OR (p_patch->>'min_buy_in')::numeric<=0 OR (p_patch->>'max_buy_in')::numeric<(p_patch->>'min_buy_in')::numeric THEN
        RETURN jsonb_build_object('ok',false,'reason','invalid_table_limits');
      END IF;
      UPDATE public.tables SET name=v_name,small_blind=(p_patch->>'small_blind')::numeric,big_blind=(p_patch->>'big_blind')::numeric,min_buy_in=(p_patch->>'min_buy_in')::numeric,max_buy_in=(p_patch->>'max_buy_in')::numeric,max_players=LEAST(10,GREATEST(2,(p_patch->>'max_players')::int)),updated_at=now() WHERE id=p_game_id;
    END IF;
  ELSE
    IF v_players>0 OR upper(v_status) NOT IN ('ANNOUNCED','REGISTERING','SCHEDULED') THEN
      UPDATE public.tournaments SET name=v_name,updated_at=now() WHERE id=p_game_id;
    ELSE
      UPDATE public.tournaments SET name=v_name,max_players=GREATEST(2,(p_patch->>'max_players')::int),start_time=COALESCE((p_patch->>'start_time')::timestamptz,start_time),updated_at=now() WHERE id=p_game_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION public.fn_close_managed_game(p_kind text,p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $$
DECLARE
  v_uid uuid:=auth.uid(); v_club uuid; v_seat record; v_t record; v_player record;
  v_refunded int:=0; v_total numeric:=0; v_paid numeric; v_fee_net numeric; v_ok boolean; v_fees numeric:=0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_kind='table' THEN
    SELECT club_id INTO v_club FROM public.tables WHERE id=p_game_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    IF NOT public.fn_can_create_games(v_club,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
    FOR v_seat IN SELECT id,user_id,stack FROM public.table_seats WHERE table_id=p_game_id AND left_at IS NULL AND COALESCE(stack,0)>0 ORDER BY seat_number FOR UPDATE LOOP
      IF NOT public.atomic_credit_wallet_and_log(v_seat.user_id,v_seat.stack,'cashout','Table closed: '||v_seat.stack::text||' chips returned',p_game_id,NULL,NULL,'cashout:'||v_seat.id::text) THEN RAISE EXCEPTION 'Table refund failed' USING ERRCODE='25000'; END IF;
      v_refunded:=v_refunded+1; v_total:=v_total+v_seat.stack;
    END LOOP;
    UPDATE public.table_seats SET left_at=now() WHERE table_id=p_game_id AND left_at IS NULL;
    UPDATE public.tables SET status='closed',current_players=0,updated_at=now() WHERE id=p_game_id;
    RETURN jsonb_build_object('ok',true,'players_refunded',v_refunded,'chips_refunded',v_total);
  ELSIF p_kind='tournament' THEN
    SELECT * INTO v_t FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    IF NOT public.fn_can_create_games(v_t.club_id,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN RETURN jsonb_build_object('ok',false,'reason','already_closed'); END IF;
    UPDATE public.tournaments SET status='CANCELLED',ended_at=now(),updated_at=now(),prize_pool=0,bounty_pool=0 WHERE id=p_game_id;
    FOR v_player IN SELECT tp.id,tp.user_id FROM public.tournament_players tp WHERE tp.tournament_id=p_game_id AND tp.user_id IS NOT NULL LOOP
      SELECT round(COALESCE(sum(CASE WHEN w.type='debit' AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount WHEN w.type='credit' AND w.category='refund' THEN -w.amount ELSE 0 END),0),2) INTO v_paid FROM public.wallet_transactions w WHERE w.user_id=v_player.user_id AND w.related_entity_id=p_game_id;
      IF v_paid>0 THEN
        v_ok:=public.fn_credit_and_log(v_player.user_id,v_paid,'tourney:'||p_game_id||':cancelrefund:'||v_player.id,'refund','Tournament cancellation refund: '||COALESCE(v_t.name,'Unknown'),p_game_id);
        IF COALESCE(v_ok,false) THEN v_refunded:=v_refunded+1; v_total:=v_total+v_paid; END IF;
      END IF;
      IF v_t.club_id IS NOT NULL THEN
        SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_fee_net FROM public.rake_records r WHERE r.tournament_id=p_game_id AND r.is_tournament AND r.metadata->>'user_id'=v_player.user_id::text;
        IF v_fee_net>0 THEN INSERT INTO public.rake_records(hand_id,table_id,club_id,rake_amount,pot_size,num_players,bbj_contribution,is_tournament,tournament_id,source,metadata) VALUES(NULL,NULL,v_t.club_id,-v_fee_net,v_fee_net,1,0,true,p_game_id,'fn_close_managed_game',jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id)); v_fees:=v_fees+v_fee_net; END IF;
      END IF;
    END LOOP;
    IF v_fees>0 THEN UPDATE public.tournaments SET total_rake=GREATEST(0,COALESCE(total_rake,0)-v_fees) WHERE id=p_game_id; END IF;
    UPDATE public.tournament_players SET status='eliminated',eliminated_at=now() WHERE tournament_id=p_game_id AND status IN ('registered','playing');
    UPDATE public.tables SET status='closed',current_players=0 WHERE tournament_id=p_game_id;
    RETURN jsonb_build_object('ok',true,'players_refunded',v_refunded,'chips_refunded',v_total);
  END IF;
  RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind');
END $$;

REVOKE ALL ON FUNCTION public.fn_is_union_operator(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_sync_club_announcement_message() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_save_game_ticker_settings(text,uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_get_game_ticker_settings(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_get_club_message_management(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_save_club_identity_messages(uuid,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_manage_club_announcement(text,uuid,uuid,text,text,boolean,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_close_managed_game(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_is_union_operator(uuid,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_save_game_ticker_settings(text,uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_game_ticker_settings(uuid,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_club_message_management(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_save_club_identity_messages(uuid,text,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_manage_club_announcement(text,uuid,uuid,text,text,boolean,boolean) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text,uuid) TO authenticated,service_role;

-- The historical tournament RPC allowed a union member club's own admin to
-- bypass union governance by marking a tournament private. Keep its mature
-- validation/insert implementation, but put the canonical authorization check
-- in front of every call. This also prevents direct RPC clients from restoring
-- a creation path that the UI intentionally removed.
DO $$
BEGIN
  IF to_regprocedure('public.fn_create_tournament_governed_legacy(uuid,jsonb)') IS NULL THEN
    ALTER FUNCTION public.fn_create_tournament(uuid,jsonb)
      RENAME TO fn_create_tournament_governed_legacy;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid,p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;
  RETURN public.fn_create_tournament_governed_legacy(p_club_id,p_config);
END $$;

REVOKE ALL ON FUNCTION public.fn_create_tournament_governed_legacy(uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid,jsonb) TO authenticated,service_role;
