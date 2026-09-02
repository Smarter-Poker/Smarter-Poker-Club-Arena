-- Fix auth_rls_initplan warnings
-- Changes '( SELECT auth.uid() AS uid)' to '(select auth.uid())'

-- Before: ((user_id = ( SELECT auth.uid() AS uid)) AND (message_type = 'player'::text) AND (NOT fn_table_chat_is_silenced(table_id)))
ALTER POLICY "table_chat_insert" ON "public"."table_chat" 
  WITH CHECK (((user_id = (select auth.uid())) AND (message_type = 'player'::text) AND (NOT fn_table_chat_is_silenced(table_id))));

-- Before: (user_id = ( SELECT auth.uid() AS uid))
ALTER POLICY "vip_reward_claims_select_own" ON "public"."vip_reward_claims" 
  USING ((user_id = (select auth.uid())));
