-- Harden table_chat insert policy to prevent malicious users from spoofing 'system' or 'dealer' messages
-- Only allow authenticated users to insert messages with message_type = 'player'.
-- Service role (backend) will bypass RLS and can still insert 'system'/'dealer' messages.

DROP POLICY IF EXISTS "table_chat_insert" ON table_chat;
CREATE POLICY "table_chat_insert" ON table_chat 
FOR INSERT 
WITH CHECK (
    user_id = auth.uid() AND 
    message_type = 'player'
);
