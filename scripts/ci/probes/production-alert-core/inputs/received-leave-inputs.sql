CREATE TEMP TABLE qualification_inputs (
  label text PRIMARY KEY, id uuid NOT NULL, source text NOT NULL, message text NOT NULL,
  severity text NOT NULL DEFAULT 'critical', context jsonb, category text NOT NULL);
INSERT INTO qualification_inputs(label,id,source,message,context,category) VALUES
 ('original_37375','3d335c16-aba5-4115-bddd-94d40a0fdf74','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757147 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","hand_number":10757147,"retry_budget":2}', 'original'),
 ('original_37377','d0c1e9ad-0154-437a-835b-c1e60ff035fa','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757202 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"71d90586-8b99-4f88-8a88-4920447801b2","hand_number":10757202,"retry_budget":2}', 'original'),
 ('original_37389','bf51bc70-32bd-4089-af1a-dc6edb436f00','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757153 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"09ee59dc-8129-42a4-ab33-c87bbf40ec5c","hand_number":10757153,"retry_budget":2}', 'original');

INSERT INTO qualification_inputs(label,id,source,message,context,category)
SELECT v.label, ('20000000-0000-4000-8000-' || lpad(v.n::text,12,'0'))::uuid,
  v.source, v.message, v.context, CASE WHEN v.label='nonmoney_flag' THEN 'severity' ELSE 'control' END
FROM (VALUES
 (1,'other_post_hand','postHandTasks.rake_failed','Qualification rake failed','{"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","error":"fixture"}'::jsonb),
 (2,'other_invalid_table','postHandTasks.rake_failed','Qualification rake failed','{"table_id":"invalid","error":"fixture"}'::jsonb),
 (3,'near_name','postHandTasks.leave_pending_failed_extra','Qualification leave step failed','{"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","hand_number":10}'::jsonb),
 (4,'tournament','Tournament.atomic_finish_refused','Qualification tournament refusal','{"tournament_id":"10000000-0000-4000-8000-000000000004","error":"fixture"}'::jsonb),
 (5,'prize','Tournament.prize_credit_failed','Qualification prize failure','{"tournament_id":"10000000-0000-4000-8000-000000000005"}'::jsonb),
 (6,'generic','qualification.generic','Qualification generic failure','{}'::jsonb),
 (7,'conservation','qualification.conservation','Qualification conservation failure','{}'::jsonb),
 (8,'server_nonmoney','ServerTableEngine.fixture','Qualification server failure','{}'::jsonb),
 (9,'semantic_refusal','ServerTableEngine.authoritative_hand_semantic_refusal','Qualification refusal','{}'::jsonb),
 (10,'post_commit','ServerTableEngine.post_commit_obligations_pending','Qualification pending','{}'::jsonb),
 (11,'mirror','drift_incident:qualification','Qualification mirror','{}'::jsonb),
 (12,'nonmoney_flag','postHandTasks.leave_pending_failed','Qualification no chips','{"moves_chips":false}'::jsonb)
) AS v(n,label,source,message,context);
INSERT INTO qualification_inputs SELECT 'warning', '20000000-0000-4000-8000-000000000013',
  source,message,'warning',context,'control' FROM qualification_inputs WHERE label='original_37375';

