ALTER TABLE notifications ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),ADD COLUMN actor_id uuid,ADD COLUMN link text;
CREATE TABLE push_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_user_id uuid,title text NOT NULL,body text NOT NULL,url text,event text,tag text,status text NOT NULL,failure_reason text,related_entity_id uuid,created_at timestamptz DEFAULT now());
CREATE INDEX push_outbox_recipient_pending_idx ON push_outbox(recipient_user_id) WHERE status IN('pending','processing');
CREATE TABLE notification_preferences(user_id uuid,push_enabled boolean);
INSERT INTO notification_preferences VALUES('10000000-0000-0000-0000-000000000002',false);
