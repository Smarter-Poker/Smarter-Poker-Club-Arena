-- SOURCE ONLY / UNRUN: append to the existing private notification PG fixture
-- AFTER its prepare/component/verify and unchanged committed observer comparison.
-- Synthetic structural inputs/accruals only. Real Mint and current Round 2 own
-- every balance movement, ledger, invoice, message, notification and push write.
-- No sender runs. This proves no signup, full weekly close or production state.
\set ON_ERROR_STOP on
\if :{?execution_uuid}
\else
  \quit 3
\endif
\if :{?ordinary_user_uuid}
\else
  \quit 3
\endif

BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SET LOCAL idle_in_transaction_session_timeout='20s';
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO,YMD';
SET LOCAL search_path=public,pg_temp;
CREATE TEMP TABLE invoice_q_inputs AS SELECT :'execution_uuid'::uuid scope,
  '47965354-0e56-43ef-931c-ddaab82af765'::uuid owner_user,
  :'ordinary_user_uuid'::uuid ordinary_user,
  date_trunc('day',now())-interval '2 days' period_start,
  date_trunc('day',now())-interval '1 day' period_end;
CREATE FUNCTION pg_temp.invoice_q_assert(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'linked invoice qualification: %',message; END IF;
END$$;
DO $admission$
DECLARE q record;
BEGIN
  SELECT * INTO STRICT q FROM invoice_q_inputs;
  PERFORM pg_temp.invoice_q_assert(current_user='postgres' AND session_user='postgres'
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    AND current_database()='qual_owner_notify_'||replace(q.scope::text,'-','')
    AND inet_server_addr() IS NULL
    AND current_setting('session_replication_role')='origin'
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999,
    'exact existing private PG17 allocation required');
  PERFORM pg_temp.invoice_q_assert(q.owner_user<>q.ordinary_user
    AND q.scope NOT IN(q.owner_user,q.ordinary_user)
    AND (SELECT count(*)=2 FROM public.profiles)
    AND (SELECT count(*)=2 FROM auth.users)
    AND (SELECT count(*)=2 FROM public.profiles WHERE id IN(q.owner_user,q.ordinary_user)),
    'requires the original two synthetic principals');
  PERFORM pg_temp.invoice_q_assert(to_regclass('public.operational_notification_destinations') IS NOT NULL
    AND md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))
      ='a726e393ab7ef02aa7a5a9f0622bee64',
    'installed routing component and unchanged canonical mirror required');
  PERFORM pg_temp.invoice_q_assert(NOT EXISTS(SELECT 1 FROM public.clubs)
    AND NOT EXISTS(SELECT 1 FROM public.unions)
    AND NOT EXISTS(SELECT 1 FROM public.club_members)
    AND NOT EXISTS(SELECT 1 FROM public.agents)
    AND NOT EXISTS(SELECT 1 FROM public.agent_commissions)
    AND NOT EXISTS(SELECT 1 FROM public.agent_commission_settlements)
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger)
    AND NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger)
    AND NOT EXISTS(SELECT 1 FROM public.ca_mint_policy)
    AND NOT EXISTS(SELECT 1 FROM public.ca_chip_store_coverage)
    AND NOT EXISTS(SELECT 1 FROM public.settlement_invoices)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries),
    'financial fixture must start empty');
  PERFORM pg_temp.invoice_q_assert((SELECT count(*)=2 FROM pg_trigger
      WHERE (tgrelid,tgname) IN
        (('public.chip_ledger'::regclass,'accounting_transfer_document'),
         ('public.notifications'::regclass,'trg_accounting_push_after_delivery'))
      AND tgenabled='O')
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled NOT IN('O','A')
      AND tgrelid IN('public.clubs'::regclass,'public.unions'::regclass,
        'public.club_members'::regclass,'public.agents'::regclass,'public.chip_ledger'::regclass,
        'public.ca_mint_ledger'::regclass,'public.settlement_invoices'::regclass,
        'public.accounting_invoice_deliveries'::regclass,'public.notifications'::regclass,
        'public.social_messages'::regclass,'public.social_conversation_participants'::regclass)),
    'all connected original triggers must remain active');
END $admission$;

-- Exact three relevant rows from the retained read-only store-policy capture.
-- No treatment or supply basis is invented for the fixture.
\ir captured-financial-store-policy.sql
-- Finite synthetic issuance policy; the real Mint and deferred guard enforce it.
INSERT INTO public.ca_mint_policy(id,per_operation_cap_chips,rolling_24h_cap_chips,
  per_operation_cap_diamonds,rolling_24h_cap_diamonds,note)
VALUES(1,100,100,1,1,'Private notification positive control: exactly one 100-chip issuance');
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','service_role',true) FROM invoice_q_inputs;

-- A real empty Union host/mirror club: no opening grant is due on is_union.
-- All creation, membership, hierarchy, audit and ledger triggers stay enabled.
INSERT INTO public.union_creators(user_id,note)
SELECT owner_user,'Synthetic isolated notification fixture' FROM invoice_q_inputs;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,
  bbj_wallet,promo_wallet,total_rake)
SELECT scope,'Invoice qualification '||scope,owner_user,'invoice-qualification-'||scope,
  0,0,0,0,0 FROM invoice_q_inputs;
INSERT INTO public.clubs(id,name,owner_id,is_union,chip_treasury,chip_pool,asset)
SELECT scope,'Invoice qualification host '||scope,owner_user,true,0,0,'chips' FROM invoice_q_inputs;
SELECT pg_temp.invoice_q_assert((SELECT chip_treasury=0 AND chip_pool=0 FROM public.clubs),
  'host starts genuinely empty before membership/funding');
INSERT INTO public.union_clubs(union_id,club_id)
SELECT scope,scope FROM invoice_q_inputs;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT q.scope,u.user_id,'player','active',0 FROM invoice_q_inputs q
CROSS JOIN LATERAL (VALUES(q.owner_user),(q.ordinary_user)) u(user_id);
SELECT set_config('app.club_membership_source','',true);
INSERT INTO public.agents(user_id,club_id,role,status,commission_rate,player_rakeback_rate)
SELECT q.owner_user,q.scope,'agent','active',0.1,0 FROM invoice_q_inputs q
UNION ALL SELECT q.ordinary_user,q.scope,'agent','active',0.1,0 FROM invoice_q_inputs q;
-- These are synthetic preexisting accrual inputs, not fabricated ledger entries.
-- Their real rollup trigger executes, and the original five-minute cutoff applies.
INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,created_at)
SELECT scope,owner_user,12.34,0.1,'rake',period_start+interval '1 hour' FROM invoice_q_inputs
UNION ALL SELECT scope,ordinary_user,7.66,0.1,'rake',period_start+interval '1 hour' FROM invoice_q_inputs;
CREATE TEMP TABLE invoice_q_calls(stage text PRIMARY KEY,result jsonb NOT NULL);
GRANT SELECT ON invoice_q_inputs TO service_role,authenticated;
GRANT INSERT ON invoice_q_calls TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO invoice_q_calls SELECT 'mint',public.fn_ca_mint('chips','club',scope,100,
  'Private invoice routing qualification','invoice-qualification:'||scope,'admin') FROM invoice_q_inputs;
RESET ROLE;
SELECT pg_temp.invoice_q_assert((SELECT result->>'ok'='true' AND result->>'replayed'='false'
  AND (result->>'balance_before')::numeric=0 AND (result->>'balance_after')::numeric=100
  FROM invoice_q_calls WHERE stage='mint'),'real Mint must fund exactly 100 chips');
COMMIT;

BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SET LOCAL timezone='UTC';
SELECT pg_temp.invoice_q_assert((SELECT count(*)=1 AND sum(amount)=100 FROM public.ca_mint_ledger)
  AND (SELECT count(*)=1 AND sum(amount)=100 FROM public.chip_ledger)
  AND (SELECT chip_treasury=100 FROM public.clubs)
  AND (SELECT count(*)=2 AND sum(chip_balance)=0 FROM public.club_members),
  'committed real issuance/register and zero member wallets');
CREATE TEMP TABLE invoice_q_events_before AS SELECT * FROM public.operational_alert_events;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','service_role',true) FROM invoice_q_inputs;
SET LOCAL ROLE service_role;
INSERT INTO invoice_q_calls SELECT 'settle',public.fn_settle_round2_club_to_agents(
  scope,period_start,period_end) FROM invoice_q_inputs;
RESET ROLE;
SELECT pg_temp.invoice_q_assert((SELECT (result->>'payees')::integer=2
  AND (result->>'amount')::numeric=20 AND (result->>'shortfalls')::integer=0
  FROM invoice_q_calls WHERE stage='settle'),'real current settlement must pay both recipients');
CREATE TEMP TABLE invoice_q_receipts AS
SELECT l.id ledger_id,i.id invoice_id,d.recipient_id,d.message_id,d.notification_id
FROM public.chip_ledger l JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
JOIN public.accounting_invoice_deliveries d ON d.invoice_id=i.id
WHERE l.category='commission' AND l.club_id=(SELECT scope FROM invoice_q_inputs);
SELECT pg_temp.invoice_q_assert((SELECT count(*)=2 FROM invoice_q_receipts)
  AND (SELECT count(*)=1 FROM invoice_q_receipts WHERE recipient_id=(SELECT owner_user FROM invoice_q_inputs))
  AND (SELECT count(*)=1 FROM invoice_q_receipts WHERE recipient_id=(SELECT ordinary_user FROM invoice_q_inputs))
  AND NOT EXISTS(SELECT 1 FROM public.push_outbox p JOIN invoice_q_receipts q
    ON p.accounting_notification_id=q.notification_id),
  'real delivery links exist but deferred push is absent before COMMIT');
COMMIT;

BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SET LOCAL timezone='UTC';
SELECT pg_temp.invoice_q_assert((SELECT chip_treasury=80 FROM public.clubs)
  AND (SELECT chip_balance=12.34 FROM public.club_members WHERE user_id=(SELECT owner_user FROM invoice_q_inputs))
  AND (SELECT chip_balance=7.66 FROM public.club_members WHERE user_id=(SELECT ordinary_user FROM invoice_q_inputs))
  AND (SELECT count(*)=2 AND sum(amount)=20 FROM public.agent_commission_settlements)
  AND (SELECT count(*)=3 AND sum(amount) FILTER(WHERE category='commission')=20 FROM public.chip_ledger),
  'exact committed conservation, two settlement records and no duplicate ledger legs');
SELECT pg_temp.invoice_q_assert((SELECT count(*)=2 FROM invoice_q_receipts q
  JOIN public.chip_ledger l ON l.id=q.ledger_id
  JOIN public.settlement_invoices i ON i.id=q.invoice_id AND i.source_ledger_id=l.id
  JOIN public.accounting_invoice_deliveries d ON d.invoice_id=i.id AND d.recipient_id=q.recipient_id
  JOIN public.social_messages m ON m.id=d.message_id AND m.id=q.message_id
  JOIN public.notifications n ON n.id=d.notification_id AND n.id=q.notification_id
  JOIN public.push_outbox p ON p.accounting_notification_id=n.id
  WHERE l.status='posted' AND l.from_type='club_treasury' AND l.from_entity_id=l.club_id
    AND l.to_type='player_wallet' AND l.to_entity_id=q.recipient_id
    AND l.amount=CASE WHEN q.recipient_id=(SELECT owner_user FROM invoice_q_inputs) THEN 12.34 ELSE 7.66 END
    AND i.status='paid' AND i.chips_transferred AND i.net_amount=l.amount AND i.gross_amount=l.amount
    AND m.message_type='invoice' AND m.media_metadata->>'invoice_id'=i.id::text
    AND n.type='accounting_invoice' AND n.user_id=q.recipient_id
    AND n.data->>'invoice_id'=i.id::text AND n.data->>'invoice_number'=i.invoice_number
    AND n.data->'amount'=to_jsonb(l.amount)
    AND n.data->>'conversation_id'=m.conversation_id::text
    AND p.recipient_user_id=q.recipient_id AND p.related_entity_id=n.id
    AND p.event='accounting_invoice' AND p.status='pending' AND p.failure_reason IS NULL
    AND p.url='/hub/messenger?conversation='||m.conversation_id::text
    AND EXISTS(SELECT 1 FROM public.social_conversation_participants cp
      WHERE cp.conversation_id=m.conversation_id AND cp.user_id=q.recipient_id))
  AND (SELECT count(*)=2 FROM public.push_outbox WHERE accounting_notification_id IS NOT NULL),
  'exact committed ledger/invoice/recipient/message/notification/typed push identity');
SELECT pg_temp.invoice_q_assert(NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations d
    JOIN invoice_q_receipts q ON q.notification_id=d.notification_id)
  AND NOT EXISTS((SELECT * FROM public.operational_alert_events EXCEPT SELECT * FROM invoice_q_events_before)
    UNION ALL (SELECT * FROM invoice_q_events_before EXCEPT SELECT * FROM public.operational_alert_events)),
  'neither owner nor ordinary invoice may be diverted into operational intake');
CREATE TEMP TABLE invoice_q_replay_before AS SELECT jsonb_build_object(
  'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
  'invoices',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.settlement_invoices t),
  'deliveries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY invoice_id,recipient_id) FROM public.accounting_invoice_deliveries t),
  'messages',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.social_messages t),
  'notices',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.notifications t),
  'pushes',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.push_outbox t)) evidence;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','service_role',true) FROM invoice_q_inputs;
SET LOCAL ROLE service_role;
INSERT INTO invoice_q_calls SELECT 'replay',public.fn_settle_round2_club_to_agents(
  scope,period_start,period_end) FROM invoice_q_inputs;
RESET ROLE;
SELECT pg_temp.invoice_q_assert((SELECT (result->>'payees')::integer=0
  AND (result->>'amount')::numeric=0 AND (result->>'shortfalls')::integer=0
  FROM invoice_q_calls WHERE stage='replay'),'same period must not pay twice');
SELECT pg_temp.invoice_q_assert((public.fn_deliver_accounting_invoice(invoice_id)->>'new_deliveries')::integer=0,
  'same invoice delivery must not duplicate receipts') FROM invoice_q_receipts;
COMMIT;

BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL timezone='UTC';
SELECT pg_temp.invoice_q_assert((SELECT evidence FROM invoice_q_replay_before)=jsonb_build_object(
  'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
  'invoices',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.settlement_invoices t),
  'deliveries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY invoice_id,recipient_id) FROM public.accounting_invoice_deliveries t),
  'messages',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.social_messages t),
  'notices',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.notifications t),
  'pushes',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.push_outbox t))
  AND (SELECT chip_treasury=80 FROM public.clubs)
  AND (SELECT sum(chip_balance)=20 FROM public.club_members),
  'committed replay preserves exact financial and delivery evidence');
GRANT SELECT ON invoice_q_receipts TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','authenticated',true) FROM invoice_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.invoice_q_assert((SELECT count(*)=1 AND bool_and(n.user_id=auth.uid())
  FROM public.personal_notifications n JOIN invoice_q_receipts q ON q.notification_id=n.id),
  'configured owner sees its own genuine invoice as personal');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',ordinary_user,'role','authenticated')::text,true),
  set_config('request.jwt.claim.sub',ordinary_user::text,true),
  set_config('request.jwt.claim.role','authenticated',true) FROM invoice_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.invoice_q_assert((SELECT count(*)=1 AND bool_and(n.user_id=auth.uid())
  FROM public.personal_notifications n JOIN invoice_q_receipts q ON q.notification_id=n.id),
  'ordinary recipient sees only its own genuine invoice');
RESET ROLE;
SELECT pg_temp.invoice_q_assert(md5(pg_get_functiondef(
  'public.fn_mirror_notification_to_push_outbox()'::regprocedure))='a726e393ab7ef02aa7a5a9f0622bee64',
  'canonical mirror remains unchanged');
SELECT 'PASS: authentic current financial posting, committed linked invoices, typed pushes, replay and personal visibility';
ROLLBACK;
