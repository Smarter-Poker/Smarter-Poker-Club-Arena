CREATE POLICY "Users can update own data" ON public.users AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view own data" ON public.users AS PERMISSIVE FOR SELECT TO PUBLIC USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Anyone can view clubs" ON public.clubs AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Authenticated users can create clubs" ON public.clubs AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Owners can update clubs" ON public.clubs AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((owner_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Club staff can read club rosters" ON public.club_members AS PERMISSIVE FOR SELECT TO "authenticated" USING ((is_club_admin(club_id, ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = club_members.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "Members can read own club memberships" ON public.club_members AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Service role manages" ON public.club_members AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Users can join clubs" ON public.club_members AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (COALESCE(credit_limit, (0)::numeric) = (0)::numeric) AND (COALESCE(credit_used, (0)::numeric) = (0)::numeric) AND (agent_id IS NULL) AND (parent_agent_id IS NULL) AND ((role = ANY (ARRAY['member'::text, 'player'::text])) OR is_club_admin(club_id, ( SELECT auth.uid() AS uid)))));
CREATE POLICY "cashier_downline_read" ON public.club_members AS PERMISSIVE FOR SELECT TO "authenticated" USING (((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id)));
CREATE POLICY "club_members_update" ON public.club_members AS PERMISSIVE FOR UPDATE TO PUBLIC USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_club_admin(club_id, ( SELECT auth.uid() AS uid)))) WITH CHECK ((is_club_admin(club_id, ( SELECT auth.uid() AS uid)) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (role = ANY (ARRAY['member'::text, 'player'::text])) AND (COALESCE(credit_limit, (0)::numeric) = (0)::numeric) AND (COALESCE(credit_used, (0)::numeric) = (0)::numeric) AND (agent_id IS NULL) AND (parent_agent_id IS NULL))));
CREATE POLICY "union_overseer_read" ON public.club_members AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "Service role manages" ON public.hand_history AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "hand_history_authenticated_select" ON public.hand_history AS PERMISSIVE FOR SELECT TO "authenticated" USING ((players @> jsonb_build_array(jsonb_build_object('userId', (( SELECT auth.uid() AS uid))::text))));
CREATE POLICY "Audience-aware view" ON public.social_posts AS PERMISSIVE FOR SELECT TO PUBLIC USING (fn_can_view_post(author_id, audience_mode, audience_list));
CREATE POLICY "Users can create their own posts" ON public.social_posts AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((author_id = ( SELECT auth.uid() AS uid)) OR (((( SELECT auth.jwt() AS jwt) ->> 'role'::text) = 'service_role'::text) AND (author_id = '00000000-0000-0000-0000-000000000001'::uuid))));
CREATE POLICY "Users can delete own posts" ON public.social_posts AS PERMISSIVE FOR DELETE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));
CREATE POLICY "Users can update own posts" ON public.social_posts AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));
CREATE POLICY "video_posts_public_select_guard" ON public.social_posts AS RESTRICTIVE FOR SELECT TO "anon","authenticated" USING (((COALESCE(is_deleted, false) = false) AND ((author_id = ( SELECT auth.uid() AS uid)) OR (visibility IS DISTINCT FROM 'private'::text)) AND fn_can_view_post(author_id, COALESCE(audience_mode, NULLIF(visibility, 'public'::text), 'public'::text), audience_list) AND ((content_type IS DISTINCT FROM 'video'::text) OR (author_id = ( SELECT auth.uid() AS uid)) OR legacy_transition_eligible(social_posts.*) OR fn_is_public_video_playback_eligible(playback_type, rights_status, NULLIF((media_urls ->> 0), ''::text), author_id, youtube_video_id, canonical_asset_key)) AND (legacy_transition_eligible(social_posts.*) OR (origin_type <> 'video_library'::text) OR fn_is_video_library_lineage_eligible(source_asset_id, youtube_video_id, canonical_asset_key, publication_key, NULLIF((media_urls ->> 0), ''::text)))));
CREATE POLICY "reward_definitions_public_read" ON public.reward_definitions AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "reward_definitions_service_write" ON public.reward_definitions AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Service role manages" ON public.social_conversations AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Users can view their conversations" ON public.social_conversations AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM social_conversation_participants
  WHERE ((social_conversation_participants.conversation_id = social_conversations.id) AND (social_conversation_participants.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Service role manages" ON public.social_conversation_participants AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Users can view their own participation" ON public.social_conversation_participants AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can send messages" ON public.social_messages AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((sender_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM social_conversation_participants scp
  WHERE ((scp.conversation_id = social_messages.conversation_id) AND (scp.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "Users can update their messages" ON public.social_messages AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((sender_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((sender_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view conversation messages" ON public.social_messages AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM social_conversation_participants scp
  WHERE ((scp.conversation_id = social_messages.conversation_id) AND (scp.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Service role manages" ON public.tournaments AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "poker_arena_diamond_tournaments" ON public.tournaments AS PERMISSIVE FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = tournaments.club_id) AND (c.asset = 'diamonds'::text)))) AND fn_poker_can_read_games(club_id)));
CREATE POLICY "poker_arena_tournament_access" ON public.tournaments AS RESTRICTIVE FOR SELECT TO "authenticated" USING ((((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN ( SELECT c.id
   FROM clubs c
  WHERE fn_poker_can_read_games(c.id)))));
CREATE POLICY "poker_arena_tournament_guest_access" ON public.tournaments AS RESTRICTIVE FOR SELECT TO "anon" USING (((club_id IS NULL) AND (union_id IS NULL)));
CREATE POLICY "tournaments_select_scoped" ON public.tournaments AS PERMISSIVE FOR SELECT TO PUBLIC USING (((COALESCE(is_private, false) = false) OR (club_id IS NULL) OR is_club_member(club_id, ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = tournaments.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "Users view own balance" ON public.user_diamond_balance AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Service role inserts" ON public.reward_claims AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);
CREATE POLICY "Users view own claims" ON public.reward_claims AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Service role manages" ON public.celebration_queue AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Users dismiss own celebrations" ON public.celebration_queue AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users view own celebrations" ON public.celebration_queue AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Admins manage authors" ON public.content_authors AS PERMISSIVE FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
CREATE POLICY "Public can read authors" ON public.content_authors AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "unions_public_browse" ON public.unions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((is_public IS NOT FALSE));
CREATE POLICY "unions_read" ON public.unions AS PERMISSIVE FOR SELECT TO PUBLIC USING (((owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM union_admins ua
  WHERE ((ua.union_id = unions.id) AND (ua.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "unions_svc" ON public.unions AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "union_clubs_read" ON public.union_clubs AS PERMISSIVE FOR SELECT TO PUBLIC USING (((EXISTS ( SELECT 1
   FROM union_admins ua
  WHERE ((ua.union_id = union_clubs.union_id) AND (ua.user_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = union_clubs.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = union_clubs.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "union_clubs_svc" ON public.union_clubs AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "agents_cashier_scoped_read" ON public.agents AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id))));
CREATE POLICY "agents_svc" ON public.agents AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "union_overseer_read" ON public.agents AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "union_admins_read" ON public.union_admins AS PERMISSIVE FOR SELECT TO PUBLIC USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "union_admins_svc" ON public.union_admins AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Service role inserts" ON public.notifications AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);
CREATE POLICY "Users can delete own notifications" ON public.notifications AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own notifications" ON public.notifications AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "friendships_delete_participant" ON public.friendships AS PERMISSIVE FOR DELETE TO "authenticated" USING (((( SELECT auth.uid() AS uid) = user_id) OR (( SELECT auth.uid() AS uid) = friend_id)));
CREATE POLICY "friendships_insert_pending_self" ON public.friendships AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND (friend_id <> user_id) AND (status = 'pending'::text)));
CREATE POLICY "friendships_select_participant" ON public.friendships AS PERMISSIVE FOR SELECT TO "authenticated" USING (((( SELECT auth.uid() AS uid) = user_id) OR (( SELECT auth.uid() AS uid) = friend_id)));
CREATE POLICY "Public read access" ON public.social_stories AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can create their own stories" ON public.social_stories AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((author_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete their own stories" ON public.social_stories AS PERMISSIVE FOR DELETE TO PUBLIC USING ((author_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Public read access" ON public.social_reels AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can delete own reels" ON public.social_reels AS PERMISSIVE FOR DELETE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));
CREATE POLICY "Users can insert own reels" ON public.social_reels AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((( SELECT auth.uid() AS uid) = author_id));
CREATE POLICY "Users can update own reels" ON public.social_reels AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));
CREATE POLICY "video_reels_public_select_guard" ON public.social_reels AS RESTRICTIVE FOR SELECT TO "anon","authenticated" USING (((COALESCE(is_deleted, false) = false) AND ((author_id = ( SELECT auth.uid() AS uid)) OR ((is_public = true) AND (legacy_transition_eligible(social_reels.*) OR fn_is_public_video_playback_eligible(playback_type, rights_status, video_url, author_id, youtube_video_id, canonical_asset_key)))) AND (legacy_transition_eligible(social_reels.*) OR ((origin_type <> 'video_library'::text) AND (source_type IS DISTINCT FROM 'video_library'::text)) OR ((origin_type = 'video_library'::text) AND (source_type = 'video_library'::text) AND fn_is_video_library_lineage_eligible(source_asset_id, youtube_video_id, canonical_asset_key, publication_key, video_url))) AND ((source_post_id IS NULL) OR (EXISTS ( SELECT 1
   FROM social_posts linked_post
  WHERE (linked_post.id = social_reels.source_post_id))))));
CREATE POLICY "Public read access" ON public.table_seats AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Service role manages" ON public.table_seats AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "union_overseer_read" ON public.table_seats AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND (EXISTS ( SELECT 1
   FROM tables t
  WHERE ((t.id = table_seats.table_id) AND fn_is_union_overseer(t.union_id, ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "Public read access" ON public.live_streams AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can create own streams" ON public.live_streams AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = broadcaster_id));
CREATE POLICY "Users can delete own streams" ON public.live_streams AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = broadcaster_id));
CREATE POLICY "Users can update own streams" ON public.live_streams AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = broadcaster_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = broadcaster_id));
CREATE POLICY "Service role manages" ON public.avatar_unlocks AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "Users can insert their own unlocks" ON public.avatar_unlocks AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view their own unlocks" ON public.avatar_unlocks AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Service role full access wallets" ON public.wallets AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Users can insert own wallets" ON public.wallets AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can read own wallets" ON public.wallets AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users view own transactions" ON public.wallet_transactions AS PERMISSIVE FOR SELECT TO PUBLIC USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "poker_arena_diamond_tables" ON public.tables AS PERMISSIVE FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = tables.club_id) AND (c.asset = 'diamonds'::text)))) AND fn_poker_can_read_games(club_id)));
CREATE POLICY "poker_arena_table_access" ON public.tables AS RESTRICTIVE FOR SELECT TO "authenticated" USING ((((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN ( SELECT c.id
   FROM clubs c
  WHERE fn_poker_can_read_games(c.id)))));
CREATE POLICY "poker_arena_table_guest_access" ON public.tables AS RESTRICTIVE FOR SELECT TO "anon" USING (((club_id IS NULL) AND (union_id IS NULL)));
CREATE POLICY "tables_insert_owner_or_admin" ON public.tables AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (fn_can_create_games(club_id, ( SELECT auth.uid() AS uid)));
CREATE POLICY "tables_select_scoped" ON public.tables AS PERMISSIVE FOR SELECT TO PUBLIC USING (((COALESCE(is_private, false) = false) OR (club_id IS NULL) OR is_club_member(club_id, ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = tables.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can send messages" ON public.messages AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = sender_id));
CREATE POLICY "Users can update their received messages" ON public.messages AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = receiver_id));
CREATE POLICY "Users can view messages in their conversations" ON public.messages AS PERMISSIVE FOR SELECT TO PUBLIC USING (((( SELECT auth.uid() AS uid) = sender_id) OR (( SELECT auth.uid() AS uid) = receiver_id)));
CREATE POLICY "Player stats are public" ON public.player_stats AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "player_stats_self" ON public.player_stats AS PERMISSIVE FOR ALL TO "authenticated" USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can create conversations" ON public.conversations AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = ANY (participant_ids)));
CREATE POLICY "Users can view their conversations" ON public.conversations AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = ANY (participant_ids)));
CREATE POLICY "rakeback_read" ON public.rakeback_periods AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = rakeback_periods.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "rakeback_svc" ON public.rakeback_periods AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "settlement_read" ON public.settlement_periods AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = settlement_periods.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'agent'::text]))))));
CREATE POLICY "settlement_svc" ON public.settlement_periods AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "union_overseer_read" ON public.settlement_periods AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "rake_records_read" ON public.rake_records AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = rake_records.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'agent'::text]))))));
CREATE POLICY "rake_records_svc" ON public.rake_records AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "union_overseer_read" ON public.rake_records AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "diamond_wallets_select_own" ON public.diamond_wallets AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view own challenges" ON public.user_daily_challenges AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "cashout_no_client_delete" ON public.cashout_requests AS RESTRICTIVE FOR DELETE TO "anon","authenticated" USING (false);
CREATE POLICY "cashout_no_client_insert" ON public.cashout_requests AS RESTRICTIVE FOR INSERT TO "anon","authenticated" WITH CHECK (false);
CREATE POLICY "cashout_no_client_update" ON public.cashout_requests AS RESTRICTIVE FOR UPDATE TO "anon","authenticated" USING (false) WITH CHECK (false);
CREATE POLICY "cashout_read_scoped" ON public.cashout_requests AS PERMISSIVE FOR SELECT TO "authenticated" USING (((player_id = ( SELECT auth.uid() AS uid)) OR (agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_bank_role(club_id) = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])) OR fn_club_is_in_downline(club_id, ( SELECT auth.uid() AS uid), player_id)));
CREATE POLICY "cashout_svc" ON public.cashout_requests AS PERMISSIVE FOR ALL TO "service_role" USING (true);
CREATE POLICY "social_pages_owner_write" ON public.social_pages AS PERMISSIVE FOR ALL TO "authenticated" USING ((( SELECT auth.uid() AS uid) = owner_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = owner_id));
CREATE POLICY "social_pages_read" ON public.social_pages AS PERMISSIVE FOR SELECT TO PUBLIC USING (((COALESCE(is_public, false) = true) OR (owner_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can view own diamonds" ON public.user_diamonds AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own streaks" ON public.user_daily_streaks AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own purchases" ON public.diamond_purchases AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "diamond_transactions_select_own" ON public.diamond_transactions AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "diamond_transactions_service_only" ON public.diamond_transactions AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "read_bbj_stakes_tiers" ON public.bbj_stakes_tiers AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "service_bbj_stakes_tiers" ON public.bbj_stakes_tiers AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "own_accounting_invoice" ON public.settlement_invoices AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM accounting_invoice_deliveries d
  WHERE ((d.invoice_id = settlement_invoices.id) AND (d.recipient_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "settlement_invoices_club_admin_select" ON public.settlement_invoices AS PERMISSIVE FOR SELECT TO "authenticated" USING ((fn_is_platform_admin() OR fn_is_club_admin_uid(club_id)));
CREATE POLICY "union_overseer_read" ON public.settlement_invoices AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "settlement_locks_club_admin_select" ON public.settlement_locks AS PERMISSIVE FOR SELECT TO "authenticated" USING ((fn_is_platform_admin() OR fn_is_club_admin_uid(club_id)));
CREATE POLICY "chip_transactions_select_own" ON public.chip_transactions AS PERMISSIVE FOR SELECT TO "authenticated" USING (((( SELECT auth.uid() AS uid) = from_user_id) OR (( SELECT auth.uid() AS uid) = to_user_id)));
CREATE POLICY "union_overseer_read" ON public.chip_transactions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "bbj_pools_select" ON public.bbj_pools AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "tournament_players_select" ON public.tournament_players AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "users_delete_own_mfa" ON public.user_mfa_factors AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "users_insert_own_mfa" ON public.user_mfa_factors AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "users_read_own_mfa" ON public.user_mfa_factors AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "users_update_own_mfa" ON public.user_mfa_factors AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "union_admin_view_wallet_txns" ON public.union_wallet_transactions AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM union_admins
  WHERE ((union_admins.union_id = union_wallet_transactions.union_id) AND (union_admins.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "waitlist_admin_read" ON public.table_waitlist AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM (tables pt
     JOIN club_members cm ON (((cm.club_id = pt.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))
  WHERE ((pt.id = table_waitlist.table_id) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text]))))));
CREATE POLICY "waitlist_public_queue_read" ON public.table_waitlist AS PERMISSIVE FOR SELECT TO "authenticated" USING ((status = ANY (ARRAY['waiting'::text, 'notified'::text])));
CREATE POLICY "waitlist_user_own_read" ON public.table_waitlist AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "financial_alerts_service_only" ON public.financial_alerts AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_rakeback_log_union_select" ON public.union_rakeback_log AS PERMISSIVE FOR SELECT TO "authenticated" USING ((fn_is_platform_admin() OR (EXISTS ( SELECT 1
   FROM (union_clubs uc
     JOIN club_members cm ON ((cm.club_id = uc.club_id)))
  WHERE ((uc.union_id = union_rakeback_log.union_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'manager'::text])))))));
CREATE POLICY "profiles_delete" ON public.profiles AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profiles_insert_self" ON public.profiles AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profiles_select" ON public.profiles AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "profiles_update" ON public.profiles AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "sf_del" ON public.social_follows AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = follower_id));
CREATE POLICY "sf_ins" ON public.social_follows AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT auth.uid() AS uid) = follower_id));
CREATE POLICY "sf_sel" ON public.social_follows AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can view their own transactions" ON public.chip_ledger AS PERMISSIVE FOR SELECT TO PUBLIC USING (((( SELECT auth.uid() AS uid) = performed_by) OR (( SELECT auth.uid() AS uid) = from_entity_id) OR (( SELECT auth.uid() AS uid) = to_entity_id)));
CREATE POLICY "Anon read access" ON public.spin_bonus_pools AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "spin_bonus_pools_service" ON public.spin_bonus_pools AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "agent_commissions_service_only" ON public.agent_commissions AS PERMISSIVE FOR ALL TO "service_role" USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "agent_reads_own_commissions" ON public.agent_commissions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "union_overseer_read" ON public.agent_commissions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "union_wallets_admin_read" ON public.union_wallets AS PERMISSIVE FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM union_admins ua
  WHERE ((ua.union_id = union_wallets.union_id) AND (ua.user_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM unions u
  WHERE ((u.id = union_wallets.union_id) AND (u.owner_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "union_wallets_service_only" ON public.union_wallets AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "bbj_payouts_admin_only" ON public.bbj_payouts AS PERMISSIVE FOR SELECT TO "authenticated" USING (fn_is_platform_admin());
CREATE POLICY "tournament_bounties_public_read" ON public.tournament_bounties AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "video_library_public_read" ON public.video_library_videos AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (fn_is_video_library_asset_eligible(id));
CREATE POLICY "video_library_videos_service_write" ON public.video_library_videos AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "youtube_embed_failures_service_only" ON public.youtube_embed_failures AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "club admins read own club rows" ON public.audit_trail AS PERMISSIVE FOR SELECT TO "authenticated" USING (((club_id IS NOT NULL) AND is_club_admin(club_id)));
CREATE POLICY "club owners read own club rows" ON public.audit_trail AS PERMISSIVE FOR SELECT TO "authenticated" USING ((club_id IN ( SELECT c.id
   FROM clubs c
  WHERE (c.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "service_role full access" ON public.audit_trail AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "service_role full access" ON public.settlement_idempotency_keys AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "club owners read own club wallet" ON public.club_wallets AS PERMISSIVE FOR SELECT TO "authenticated" USING ((club_id IN ( SELECT c.id
   FROM clubs c
  WHERE (c.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "service_role full access" ON public.club_wallets AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_overseer_read" ON public.club_wallets AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "club owners read own club ledger" ON public.club_wallet_transactions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((club_id IN ( SELECT c.id
   FROM clubs c
  WHERE (c.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "service_role full access" ON public.club_wallet_transactions AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_overseer_read" ON public.club_wallet_transactions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "club owners read own club rakeback" ON public.rakeback_period_payouts AS PERMISSIVE FOR SELECT TO "authenticated" USING ((club_id IN ( SELECT c.id
   FROM clubs c
  WHERE (c.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "service_role full access" ON public.rakeback_period_payouts AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "lb_ins" ON public.live_bans AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((( SELECT auth.uid() AS uid) = banned_by) AND (( SELECT auth.uid() AS uid) IN ( SELECT live_streams.broadcaster_id
   FROM live_streams
  WHERE (live_streams.id = live_bans.stream_id)))));
CREATE POLICY "lb_sel" ON public.live_bans AS PERMISSIVE FOR SELECT TO PUBLIC USING (((( SELECT auth.uid() AS uid) = banned_user_id) OR (EXISTS ( SELECT 1
   FROM live_streams s
  WHERE ((s.id = live_bans.stream_id) AND (s.broadcaster_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "rake_attributions_player_self_read" ON public.rake_attributions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((player_id = ( SELECT ( SELECT auth.uid() AS uid) AS uid)));
CREATE POLICY "rake_attributions_service_role_all" ON public.rake_attributions AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "video_transcode_jobs_service_only" ON public.video_transcode_jobs AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "signup_errors_service_only" ON public.signup_errors AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "credit_invoices_select_own" ON public.credit_invoices AS PERMISSIVE FOR SELECT TO PUBLIC USING ((agent_id IN ( SELECT a.id
   FROM agents a
  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "credit_payments_select_own" ON public.credit_payments AS PERMISSIVE FOR SELECT TO PUBLIC USING ((invoice_id IN ( SELECT ci.id
   FROM (credit_invoices ci
     JOIN agents a ON ((a.id = ci.agent_id)))
  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "credit_assignments_read" ON public.credit_assignments AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM agents a
  WHERE ((a.id = credit_assignments.agent_id) AND ((a.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM clubs c
          WHERE ((c.id = a.club_id) AND ((c.owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
                   FROM club_members cm
                  WHERE ((cm.club_id = a.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text]))))))))))))));
CREATE POLICY "credit_assignments_svc" ON public.credit_assignments AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "pps_select_authenticated" ON public.player_position_stats AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "diamond_reward_catalog_read" ON public.diamond_reward_catalog AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "vip_points_select_own" ON public.vip_points AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "vip_points_ledger_select_own" ON public.vip_points_ledger AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "daily_challenge_catalog_read" ON public.daily_challenge_catalog AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "admin reads all push subs" ON public.push_subscriptions AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_admin());
CREATE POLICY "user deletes own push subs" ON public.push_subscriptions AS PERMISSIVE FOR DELETE TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "user reads own push subs" ON public.push_subscriptions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "admin reads push outbox" ON public.push_outbox AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_admin());
CREATE POLICY "union_overseer_read" ON public.club_member_daily_stats AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "ca_hand_player_idx_owner_read" ON public.ca_hand_player_idx AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "union_pnl_settlements_admin_read" ON public.union_pnl_settlements AS PERMISSIVE FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM unions u
  WHERE ((u.id = union_pnl_settlements.union_id) AND (u.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM union_admins a
  WHERE ((a.union_id = union_pnl_settlements.union_id) AND (a.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "union_pnl_settlements_service" ON public.union_pnl_settlements AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "user reads own streak state" ON public.challenge_streak_state AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "union_eco_ledger_admin_read" ON public.union_eco_ledger AS PERMISSIVE FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM unions u
  WHERE ((u.id = union_eco_ledger.union_id) AND (u.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM union_admins a
  WHERE ((a.union_id = union_eco_ledger.union_id) AND (a.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "union_eco_ledger_service" ON public.union_eco_ledger AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_overseer_read_rounds" ON public.union_settlement_rounds AS PERMISSIVE FOR SELECT TO "authenticated" USING (fn_is_union_overseer(union_id, ( SELECT auth.uid() AS uid)));
CREATE POLICY "spin_reserve_ledger_service" ON public.spin_reserve_ledger AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "club_level_thresholds_readable" ON public.club_level_thresholds AS PERMISSIVE FOR SELECT TO "authenticated","anon" USING (true);
CREATE POLICY "cashier_tournament_tickets_read" ON public.tournament_tickets AS PERMISSIVE FOR SELECT TO "authenticated" USING (((issued_by = ( SELECT auth.uid() AS uid)) OR (holder_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text)));
CREATE POLICY "trapp_admin_write" ON public.tournament_registration_approvals AS PERMISSIVE FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM tournaments t
  WHERE ((t.id = tournament_registration_approvals.tournament_id) AND is_club_admin(t.club_id, ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM tournaments t
  WHERE ((t.id = tournament_registration_approvals.tournament_id) AND is_club_admin(t.club_id, ( SELECT auth.uid() AS uid))))));
CREATE POLICY "trapp_select_own" ON public.tournament_registration_approvals AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM tournaments t
  WHERE ((t.id = tournament_registration_approvals.tournament_id) AND is_club_admin(t.club_id, ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "trapp_service_all" ON public.tournament_registration_approvals AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "tpay_read_self_field_or_staff" ON public.tournament_payouts AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM tournament_players tp
  WHERE ((tp.tournament_id = tournament_payouts.tournament_id) AND (tp.user_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM tournaments t
  WHERE ((t.id = tournament_payouts.tournament_id) AND (t.club_id IS NOT NULL) AND fn_is_club_admin_uid(t.club_id))))));
CREATE POLICY "tpay_service_all" ON public.tournament_payouts AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "tdv_insert_own" ON public.tournament_deal_votes AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM tournament_players tp
  WHERE ((tp.tournament_id = tournament_deal_votes.tournament_id) AND (tp.user_id = ( SELECT auth.uid() AS uid)) AND (tp.status = ANY (ARRAY['registered'::text, 'playing'::text])) AND (tp.eliminated_at IS NULL)))) AND (EXISTS ( SELECT 1
   FROM tournaments t
  WHERE ((t.id = tournament_deal_votes.tournament_id) AND COALESCE(t.final_table_deal_enabled, false) AND (t.status = 'RUNNING'::text))))));
CREATE POLICY "tdv_read" ON public.tournament_deal_votes AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "tdv_service_all" ON public.tournament_deal_votes AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "bomb_pot_award_units_read" ON public.bomb_pot_award_units AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM (tables t
     JOIN club_members cm ON ((cm.club_id = t.club_id)))
  WHERE ((t.id = bomb_pot_award_units.table_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "users read own daily challenge revision" ON public.daily_challenge_dashboard_revisions AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "vip_points_carry_read_own" ON public.vip_points_carry AS PERMISSIVE FOR SELECT TO PUBLIC USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "maintenance_break_is_public" ON public.engine_maintenance_break AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (true);
CREATE POLICY "game_management_events_authorized_read" ON public.game_management_events AS PERMISSIVE FOR SELECT TO "authenticated" USING (((recipient_id = ( SELECT auth.uid() AS uid)) OR ((scope_kind = 'club'::text) AND fn_can_create_games(scope_id, ( SELECT auth.uid() AS uid))) OR ((scope_kind = 'union'::text) AND fn_is_union_operator(scope_id, ( SELECT auth.uid() AS uid)))));
CREATE POLICY "ca_mint_ledger_admin_read" ON public.ca_mint_ledger AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'god'::text, 'superadmin'::text]))))));
CREATE POLICY "ca_diamond_journal_archive_service_role" ON public.ca_diamond_journal_archive AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "cash_games_read" ON public.cash_games AS PERMISSIVE FOR SELECT TO "authenticated" USING (((NOT COALESCE((((ruleset_snapshot -> 'options'::text) ->> 'is_private'::text))::boolean, false)) OR (EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = cash_games.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY "ca_mint_policy_admin_read" ON public.ca_mint_policy AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'god'::text, 'superadmin'::text]))))));
CREATE POLICY "union_creators_read_self" ON public.union_creators AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "union_creators_svc" ON public.union_creators AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "cash_seat_moves_read_own" ON public.cash_seat_moves AS PERMISSIVE FOR SELECT TO "authenticated" USING ((player_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "bbj_unclaimed_self_select" ON public.bbj_unclaimed_shares AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR fn_is_platform_admin()));
CREATE POLICY "video_reels_pipeline_controls_service_only" ON public.video_reels_pipeline_controls AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "mini_tiers_are_public_reading" ON public.bbj_mini_tiers AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "acs_agent_reads_own" ON public.agent_commission_settlements AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "acs_service_only" ON public.agent_commission_settlements AS PERMISSIVE FOR ALL TO "service_role" USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "acs_union_overseer_read" ON public.agent_commission_settlements AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY "own_custody" ON public.poker_diamond_custody AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "own_movements" ON public.poker_diamond_movements AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "union_accounting_runs_scoped_read" ON public.union_accounting_runs AS PERMISSIVE FOR SELECT TO "authenticated" USING (ca_can_oversee_union(union_id));
CREATE POLICY "own_accounting_delivery" ON public.accounting_invoice_deliveries AS PERMISSIVE FOR SELECT TO "authenticated" USING ((recipient_id = ( SELECT auth.uid() AS uid)));
