-- Minimal reproduction of the two production columns the reachability
-- predicate in 20260927221309_push_delivery_is_for_reachable_recipients.sql
-- reads: push_subscriptions(user_id, is_active) and profiles.is_horse. It
-- runs BEFORE that migration so the migration's own guard can see them.
-- is_horse exists here only so the regression can PROVE the predicate never
-- reads it: every case below is run once as a horse and once as a human.
CREATE TABLE push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,endpoint text NOT NULL,is_active boolean NOT NULL DEFAULT true,UNIQUE(user_id,endpoint));
CREATE INDEX push_subscriptions_user_active_idx ON push_subscriptions(user_id) WHERE is_active=true;
ALTER TABLE profiles ADD COLUMN is_horse boolean NOT NULL DEFAULT false;
