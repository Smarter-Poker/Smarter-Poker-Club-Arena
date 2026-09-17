-- SOURCE ONLY / UNRUN. No invocation is authorized by this file.
-- Two separately admitted phases: prepare BEFORE installing the real component,
-- then verify AFTER its qualified installation in the SAME disposable database.
-- prepare commits synthetic NOTIFICATION evidence; verify rolls its work back.
-- No auth identities, balances, payments, push senders or production data created.
\set ON_ERROR_STOP on
\if :{?phase}
\else
  \echo 'Required protected phase: prepare or verify'
  \quit 3
\endif
\if :{?execution_uuid}
\else
  \quit 3
\endif
\if :{?ordinary_user_uuid}
\else
  \quit 3
\endif
\if :{?legacy_operational_uuid}
\else
  \quit 3
\endif
\if :{?legacy_personal_uuid}
\else
  \quit 3
\endif

BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SET LOCAL idle_in_transaction_session_timeout='20s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
CREATE TEMP TABLE q_inputs AS SELECT :'phase'::text phase,
  :'execution_uuid'::uuid execution, :'ordinary_user_uuid'::uuid ordinary_user,
  :'legacy_operational_uuid'::uuid legacy_operational,
  :'legacy_personal_uuid'::uuid legacy_personal,
  '47965354-0e56-43ef-931c-ddaab82af765'::uuid owner_user,
  '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid task_id;
CREATE FUNCTION pg_temp.q_assert(p_ok boolean,p_message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification: %',p_message; END IF;
END$$;
DO $admission$
DECLARE q record;
BEGIN
  SELECT * INTO q FROM q_inputs;
  PERFORM pg_temp.q_assert(q.phase IN ('prepare','verify'),'unknown phase');
  PERFORM pg_temp.q_assert(current_user='postgres' AND session_user='postgres'
    AND current_database()='qual_owner_notify_'||replace(q.execution::text,'-','')
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999,
    'requires exact separately admitted private PG17 allocation');
  PERFORM pg_temp.q_assert(q.ordinary_user<>q.owner_user
    AND q.legacy_personal<>q.legacy_operational,'fixture identities collapse');
  PERFORM pg_temp.q_assert((SELECT count(*)=2 FROM public.profiles
    WHERE id IN(q.owner_user,q.ordinary_user)) AND (SELECT count(*)=2 FROM auth.users
    WHERE id IN(q.owner_user,q.ordinary_user)),'provider identities absent');
  PERFORM pg_temp.q_assert(md5(pg_get_functiondef(
    'public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
      ='36601e205494e8768f5a1dce09f4a186','actual recorder authority drift');
  PERFORM pg_temp.q_assert((SELECT count(*)<=100 FROM public.notifications)
    AND (SELECT count(*)<=200 FROM public.operational_alert_events)
    AND (SELECT count(*)<=100 FROM public.push_outbox),'not a bounded notification fixture');
  -- This database/name/role tripwire is NOT an admission, network or sender seal.
  -- The protected owner must independently enforce those before this script.
END;
$admission$;
SELECT phase='prepare' AS preparing FROM q_inputs \gset
\if :preparing
  SELECT pg_temp.q_assert(to_regclass('public.operational_notification_destinations') IS NULL,
    'prepare requires pre-component catalog, never disabling its trigger');
  SELECT pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.notifications)
    AND NOT EXISTS(SELECT 1 FROM public.operational_alert_events)
    AND NOT EXISTS(SELECT 1 FROM public.push_outbox),'requires a new empty notification allocation');
  INSERT INTO public.notifications(id,user_id,type,title,message,data,metadata,read,is_read)
  SELECT legacy_operational,owner_user,'financial_incident','QUAL legacy operational',
    'Original qualification evidence',jsonb_build_object('_push','none'),
    jsonb_build_object('qualification_execution',execution),false,false FROM q_inputs
  UNION ALL
  SELECT legacy_personal,owner_user,'system','QUAL security login notice',
    'Ordinary account control',jsonb_build_object('_push','none'),
    jsonb_build_object('qualification_execution',execution),false,false FROM q_inputs;
  SELECT public.fn_record_operational_alert('owner-operational-notifications',n.id::text,
    'financial_incident:QUAL legacy operational','firing','warning',
    jsonb_build_object('original_notification',to_jsonb(n),'target_task_id',q.task_id))
    FROM public.notifications n JOIN q_inputs q ON n.id=q.legacy_operational;
  -- Genuine older snapshot followed by ordinary read-state updates. Do not
  -- mutate the recorded original to make replay match a new notification body.
  UPDATE public.notifications n SET read=true,is_read=true,read_at=clock_timestamp()
    FROM q_inputs q WHERE n.id=q.legacy_operational;
  UPDATE public.operational_alert_events e SET investigation_status='investigating',
    investigation=jsonb_build_object('qualification_execution',q.execution,'held',true)
    FROM q_inputs q WHERE e.source='owner-operational-notifications'
      AND e.event_key=q.legacy_operational::text;
  SET CONSTRAINTS ALL IMMEDIATE;
  COMMIT;
  SELECT jsonb_build_object('stage','prepared_committed_notification_fixture',
    'execution',q.execution,'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id)
      FROM public.notifications n WHERE n.id IN(q.legacy_operational,q.legacy_personal)),
    'prior_inbox',(SELECT to_jsonb(e) FROM public.operational_alert_events e
      WHERE e.source='owner-operational-notifications' AND e.event_key=q.legacy_operational::text),
    'full_qualification',false,'allocation_disposed',false) FROM q_inputs q;
  -- COMMIT acknowledgement + a separate protected observer must preserve this
  -- original before component installation. The row above is not that observer.
\else
  SELECT pg_temp.q_assert(to_regclass('public.operational_notification_destinations') IS NOT NULL,
    'real candidate must already be independently installed');
  SELECT pg_temp.q_assert((SELECT relrowsecurity FROM pg_class WHERE oid='public.notifications'::regclass)
    AND (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class
      WHERE oid='public.personal_notifications'::regclass), 'RLS/invoker view absent');
  SELECT pg_temp.q_assert(EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.notifications'::regclass
        AND tgname='zz_capture_owner_notification_destination' AND tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.notifications'::regclass
      AND polname='personal_notification_destination' AND NOT polpermissive),
    'required real capture/RLS bindings absent');
  SELECT pg_temp.q_assert((SELECT count(*)=2 FROM public.notifications n,q_inputs q
      WHERE n.id IN(q.legacy_operational,q.legacy_personal)
        AND n.metadata->>'qualification_execution'=q.execution::text)
    AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations d,q_inputs q
      WHERE d.notification_id IN(q.legacy_operational,q.legacy_personal)),
    'expected genuinely pre-install originals missing/already captured');
  SELECT pg_temp.q_assert((SELECT count(*)=2 FROM public.notifications)
    AND (SELECT count(*)=1 FROM public.operational_alert_events)
    AND NOT EXISTS(SELECT 1 FROM public.push_outbox)
    AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations),
    'unexpected notification work in isolated allocation');
  CREATE TEMP TABLE q_before AS SELECT
    (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.notifications n) notifications,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.operational_alert_events e) events,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.push_outbox p) pushes,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY notification_id)
       FROM public.operational_notification_destinations d) destinations;
  SAVEPOINT exercise;
  CREATE TEMP TABLE q_cases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE,
    recipient uuid,type text,title text,data jsonb,routed boolean,expected_status text);
  INSERT INTO q_cases(name,recipient,type,title,data,routed,expected_status)
  SELECT x.name,CASE WHEN x.other THEN q.ordinary_user ELSE q.owner_user END,
    x.type,x.title,x.data,x.routed,x.expected_status FROM q_inputs q CROSS JOIN (VALUES
    ('raw',false,'financial_incident','QUAL fault','{}'::jsonb,true,'firing'),
    ('inline',false,'financial_incident','QUAL inline','{"_push":"inline"}',true,'firing'),
    ('none',false,'financial_incident','QUAL in-app only','{"_push":"none"}',true,'firing'),
    ('recovery',false,'financial_incident_resolved','QUAL recovered','{}',true,'resolved'),
    ('health',false,'system','Push Health Alert','{}',true,'firing'),
    ('delivery',false,'system','Notifications May Not Be Reaching This Device','{}',true,'firing'),
    ('horse',false,'system','Horse Fleet Recovered: QUAL','{}',true,'resolved'),
    ('engine',false,'system','QUAL engine','{"component":"club-arena-engine","alertname":"QUAL Engine","severity":"critical"}',true,'firing'),
    ('engine-green',false,'system','QUAL engine recovered','{"component":"club-arena-engine","alertname":"QUAL Engine","green":true}',true,'resolved'),
    ('null-data',false,'financial_incident','QUAL null data',NULL,true,'firing'),
    ('array-data',false,'financial_incident','QUAL array data','[1,2]',true,'firing'),
    ('number-name',false,'system','QUAL malformed name','{"component":"club-arena-engine","alertname":7}',false,NULL),
    ('object-name',false,'system','QUAL malformed object','{"component":"club-arena-engine","alertname":{}}',false,NULL),
    ('empty-name',false,'system','QUAL empty name','{"component":"club-arena-engine","alertname":""}',false,NULL),
    ('null-name',false,'system','QUAL null name','{"component":"club-arena-engine","alertname":null}',false,NULL),
    ('security',false,'system','QUAL security login','{}',false,NULL),
    ('customer',false,'new_message','Push Health Alert','{}',false,NULL),
    ('accounting',false,'accounting_invoice_detail','QUAL ordinary invoice detail','{"_push":"none"}',false,NULL),
    ('other-recipient',true,'financial_incident','QUAL other recipient','{}',false,NULL)
  ) x(name,other,type,title,data,routed,expected_status);
  INSERT INTO public.notifications(id,user_id,type,title,message,data,metadata,read,is_read)
  SELECT c.id,c.recipient,c.type,c.title,'Original body: '||c.name,c.data,
    jsonb_build_object('qualification_execution',q.execution),false,false FROM q_cases c,q_inputs q;
  SET CONSTRAINTS ALL IMMEDIATE;
  DO $originals$
  DECLARE c record; n jsonb; d record; e record;
  BEGIN
    FOR c IN SELECT * FROM q_cases LOOP
      SELECT to_jsonb(x) INTO STRICT n FROM public.notifications x WHERE x.id=c.id;
      PERFORM pg_temp.q_assert(n->>'message'='Original body: '||c.name,'notification original not inserted');
      IF c.routed THEN
        SELECT * INTO STRICT d FROM public.operational_notification_destinations WHERE notification_id=c.id;
        PERFORM pg_temp.q_assert(d.inbox_event_id IS NOT NULL AND d.last_error IS NULL,
          format('routed receipt missing or failed: case=%s notification_id=%s inbox_event_id=%s last_error=%s',
            c.name,c.id,COALESCE(d.inbox_event_id::text,'NULL'),COALESCE(d.last_error,'NULL')));
        SELECT * INTO STRICT e FROM public.operational_alert_events WHERE id=d.inbox_event_id;
        PERFORM pg_temp.q_assert(d.original_notification->'data' IS NOT DISTINCT FROM COALESCE(c.data,'null'::jsonb)
          AND d.original_notification->>'message'='Original body: '||c.name
          AND d.original_notification->>'id'=c.id::text AND d.recipient_user_id=c.recipient
          AND d.target_task_id=(SELECT task_id FROM q_inputs),'pre-routing original erased or rebound');
        PERFORM pg_temp.q_assert(n=d.original_notification,
          'routing changed the original notification, including its push marker');
        PERFORM pg_temp.q_assert(e.source='owner-operational-notifications' AND e.event_key=c.id::text
          AND e.status=c.expected_status AND e.payload->'original_notification'=d.original_notification
          AND e.payload->>'target_task_id'=d.target_task_id::text,'wrong canonical inbox receipt');
        PERFORM pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.push_outbox WHERE related_entity_id=c.id),
          'owner operational original mirrored to phone outbox');
      ELSE
        PERFORM pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations
          WHERE notification_id=c.id),'ordinary notice diverted');
        IF c.name<>'accounting' THEN
          PERFORM pg_temp.q_assert((SELECT count(*)=1 FROM public.push_outbox
            WHERE related_entity_id=c.id AND recipient_user_id=c.recipient AND status='pending'),
            'ordinary mirror control disappeared');
        END IF;
      END IF;
    END LOOP;
  END;
  $originals$;
  -- Independent literal receipt expectations for the routed fixture population.
  SELECT pg_temp.q_assert(count(*)=11 AND bool_and(e.alertname=x.alertname AND e.severity=x.severity),
    'canonical name/severity differs from fixture contract')
  FROM (VALUES
    ('raw','financial_incident:QUAL fault','warning'),
    ('inline','financial_incident:QUAL inline','warning'),
    ('none','financial_incident:QUAL in-app only','warning'),
    ('recovery','financial_incident_resolved:QUAL recovered','warning'),
    ('health','system:Push Health Alert','warning'),
    ('delivery','system:Notifications May Not Be Reaching This Device','warning'),
    ('horse','system:Horse Fleet Recovered: QUAL','warning'),
    ('engine','QUAL Engine','critical'),
    ('engine-green','QUAL Engine','warning'),
    ('null-data','financial_incident:QUAL null data','warning'),
    ('array-data','financial_incident:QUAL array data','warning')
  ) x(name,alertname,severity)
  JOIN q_cases c ON c.name=x.name
  JOIN public.operational_notification_destinations d ON d.notification_id=c.id
  JOIN public.operational_alert_events e ON e.id=d.inbox_event_id;
  -- The fresh actor-FK case proves post-capture rollback. The duplicate only
  -- proves refusal; it can collide with the destination PK before capture writes.
  DO $rollback_original$
  DECLARE c record; rejected boolean:=false; before_events bigint; before_dest bigint;
    fresh_id uuid:=gen_random_uuid(); absent_actor uuid:=gen_random_uuid(); violated_constraint text;
  BEGIN
    SELECT * INTO c FROM q_cases WHERE name='raw';
    SELECT count(*) INTO before_events FROM public.operational_alert_events;
    SELECT count(*) INTO before_dest FROM public.operational_notification_destinations;
    BEGIN
      INSERT INTO public.notifications(id,user_id,type,title,message)
        VALUES(c.id,c.recipient,c.type,c.title,'must fail duplicate original');
    EXCEPTION WHEN unique_violation THEN rejected:=true; END;
    PERFORM pg_temp.q_assert(rejected AND (SELECT count(*)=before_events FROM public.operational_alert_events)
      AND (SELECT count(*)=before_dest FROM public.operational_notification_destinations),
      'original insertion failure left partial destination/inbox state');
    rejected:=false;
    PERFORM pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=absent_actor),
      'generated missing actor unexpectedly exists');
    BEGIN
      INSERT INTO public.notifications(id,user_id,type,title,message,actor_id)
        VALUES(fresh_id,c.recipient,c.type,'QUAL actor FK failure','original capture must roll back',absent_actor);
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint=CONSTRAINT_NAME;
      rejected:=violated_constraint='notifications_actor_id_fkey';
    END;
    PERFORM pg_temp.q_assert(rejected AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=fresh_id)
      AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations WHERE notification_id=fresh_id)
      AND NOT EXISTS(SELECT 1 FROM public.operational_alert_events
        WHERE source='owner-operational-notifications' AND event_key=fresh_id::text)
      AND (SELECT count(*)=before_events FROM public.operational_alert_events)
      AND (SELECT count(*)=before_dest FROM public.operational_notification_destinations),
      'actual original actor FK failure retained partial capture');
  END;
  $rollback_original$;
  DO $ordinary_authority$
  DECLARE owner_id uuid; rejected boolean:=false; original_count bigint; bad_id uuid:=gen_random_uuid();
    refusal_message text; refusal_state text;
  BEGIN
    SELECT owner_user INTO owner_id FROM q_inputs;
    PERFORM pg_temp.q_assert(public.fn_is_owner_operational_notification(owner_id,
      'accounting_invoice','QUAL invoice','{}'::jsonb)=false,
      'ordinary accounting category reclassified as operational');
    SELECT count(*) INTO original_count FROM public.notifications;
    BEGIN
      INSERT INTO public.notifications(id,user_id,type,title,data) VALUES(bad_id,owner_id,
        'accounting_invoice','QUAL unlinked invoice','{"_push":"none"}');
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS refusal_message=MESSAGE_TEXT,refusal_state=RETURNED_SQLSTATE;
      rejected:=refusal_state='23514' AND refusal_message='accounting_push_delivery_link_missing';
    END;
    PERFORM pg_temp.q_assert(rejected AND (SELECT count(*)=original_count FROM public.notifications)
      AND NOT EXISTS(SELECT 1 FROM public.push_outbox WHERE related_entity_id=bad_id)
      AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations WHERE notification_id=bad_id),
      'reserved accounting label bypassed canonical receipt authority');
    rejected:=false; bad_id:=gen_random_uuid();
    BEGIN
      INSERT INTO public.notifications(id,user_id,type,title) VALUES(bad_id,owner_id,'financial_incident',NULL);
    EXCEPTION WHEN not_null_violation THEN rejected:=true; END;
    PERFORM pg_temp.q_assert(rejected AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations
      WHERE notification_id=bad_id) AND NOT EXISTS(SELECT 1 FROM public.operational_alert_events
      WHERE source='owner-operational-notifications' AND event_key=bad_id::text),
      'post-capture original constraint failure did not roll back both stores');
  END;
  $ordinary_authority$;
  -- SQL role tests use real roles/policies. They do not emulate auth.uid().
  GRANT SELECT ON q_inputs,q_cases TO anon,authenticated,service_role;
  DO $$BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',
    pg_my_temp_schema()::regnamespace::text); END$$;
  SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated')::text,true),
    set_config('request.jwt.claim.sub',owner_user::text,true) FROM q_inputs;
  SET LOCAL ROLE authenticated;
  SELECT pg_temp.q_assert(auth.uid()=(SELECT owner_user FROM q_inputs),'owner auth identity not active');
  SELECT pg_temp.q_assert(bool_and(public.fn_is_owner_operational_notification(recipient,type,title,data)
    IS NOT DISTINCT FROM routed),'authenticated classifier/WHEN privilege or semantics differs') FROM q_cases;
  SELECT pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.notifications n JOIN q_cases c ON c.id=n.id
    WHERE c.routed OR c.recipient<>(SELECT owner_user FROM q_inputs)),'direct authenticated RLS leaked original');
  SELECT pg_temp.q_assert((SELECT count(*) FROM public.personal_notifications n JOIN q_cases c ON c.id=n.id)
    =(SELECT count(*) FROM q_cases WHERE NOT routed AND recipient=(SELECT owner_user FROM q_inputs)),
    'owner view lost ordinary controls');
  SELECT pg_temp.q_assert(NOT has_table_privilege(current_user,'public.operational_notification_destinations','SELECT'),
    'authenticated can read retained private originals');
  RESET ROLE;
  SELECT set_config('request.jwt.claims',jsonb_build_object('sub',ordinary_user,'role','authenticated')::text,true),
    set_config('request.jwt.claim.sub',ordinary_user::text,true) FROM q_inputs;
  SET LOCAL ROLE authenticated;
  SELECT pg_temp.q_assert((SELECT count(*) FROM public.notifications n JOIN q_cases c ON c.id=n.id)=1
    AND (SELECT count(*) FROM public.personal_notifications n JOIN q_cases c ON c.id=n.id)=1,
    'ordinary recipient RLS identity/control differs');
  RESET ROLE;
  SELECT set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true);
  SET LOCAL ROLE anon;
  SELECT pg_temp.q_assert(auth.uid() IS NULL,'anonymous control retained a subject');
  SELECT pg_temp.q_assert(bool_and(public.fn_is_owner_operational_notification(recipient,type,title,data)
    IS NOT DISTINCT FROM routed),'anonymous classifier/WHEN privilege or semantics differs') FROM q_cases;
  SELECT pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.notifications),'anonymous RLS leaked a notification');
  RESET ROLE;
  SET LOCAL ROLE service_role;
  SELECT pg_temp.q_assert(current_user='service_role'
    AND NOT has_function_privilege(current_user,'public.fn_try_record_owner_notification(uuid)','EXECUTE')
    AND NOT has_table_privilege(current_user,'public.operational_notification_destinations','UPDATE'),
    'service role gained private mutation authority');
  SELECT pg_temp.q_assert((SELECT count(*) FROM public.personal_notifications n JOIN q_cases c ON c.id=n.id)
    =(SELECT count(*) FROM q_cases WHERE NOT routed),'service view bypass leaked routed row');
  SELECT pg_temp.q_assert((SELECT count(*) FROM public.personal_notifications n JOIN q_cases c ON c.id=n.id
      WHERE n.user_id=(SELECT owner_user FROM q_inputs) AND n.type<>'accounting_invoice_detail'
        AND n.read IS NOT TRUE AND n.is_read IS NOT TRUE)
    =(SELECT count(*) FROM q_cases WHERE NOT routed AND recipient=(SELECT owner_user FROM q_inputs)
        AND type<>'accounting_invoice_detail'),
    'unread-count relational predicate includes operational rows');
  SELECT public.fn_capture_owner_notification_history(200) AS actual_history_receipt;
  RESET ROLE;
  DO $history$
  DECLARE q record; old_e jsonb; now_e jsonb; original jsonb; destination jsonb; result jsonb;
  BEGIN
    SELECT * INTO q FROM q_inputs;
    SELECT x.value INTO STRICT old_e FROM q_before b,jsonb_array_elements(b.events) AS x(value)
      WHERE x.value->>'source'='owner-operational-notifications' AND x.value->>'event_key'=q.legacy_operational::text;
    SELECT to_jsonb(e) INTO STRICT now_e FROM public.operational_alert_events e WHERE e.id=(old_e->>'id')::bigint;
    SELECT x.value INTO STRICT original FROM q_before b,jsonb_array_elements(b.notifications) AS x(value)
      WHERE x.value->>'id'=q.legacy_operational::text;
    SELECT original_notification INTO STRICT destination FROM public.operational_notification_destinations
      WHERE notification_id=q.legacy_operational;
    PERFORM pg_temp.q_assert(destination=original AND (now_e-ARRAY['delivery_count','last_received_at'])
      =(old_e-ARRAY['delivery_count','last_received_at']), 'historical original/id/investigation rewritten');
    PERFORM pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations
      WHERE notification_id=q.legacy_personal),'historical ordinary notice captured');
    PERFORM pg_temp.q_assert(NOT EXISTS(SELECT 1 FROM public.personal_notifications WHERE id=q.legacy_operational)
      AND EXISTS(SELECT 1 FROM public.personal_notifications WHERE id=q.legacy_personal),
      'backfilled destination did not change personal visibility');
    PERFORM pg_temp.q_assert((SELECT to_jsonb(n)=original FROM public.notifications n
      WHERE id=q.legacy_operational),'backfill modified notification read-state/body');
    result:=public.fn_capture_owner_notification_history(200);
    PERFORM pg_temp.q_assert(result->>'candidates_seen'='0' AND result->>'inbox_receipts_recorded'='0'
      AND result->'pending'='false'::jsonb AND result->'uncaptured'='false'::jsonb,
      'stable replay is not bounded/idempotent');
  END;
  $history$;
  -- Real recorder constraint failure, not a replacement recorder returning a fake id.
  DO $pending$
  DECLARE notice_id uuid:=gen_random_uuid(); q record; original jsonb; receipt bigint; state jsonb;
  BEGIN
    SELECT * INTO q FROM q_inputs;
    EXECUTE format('ALTER TABLE public.operational_alert_events ADD CONSTRAINT qual_owner_exact_failure CHECK (event_key<>%L)',notice_id::text);
    INSERT INTO public.notifications(id,user_id,type,title,data) VALUES(notice_id,q.owner_user,'financial_incident',
      'QUAL pending recorder','{"_push":"none"}');
    SELECT original_notification INTO STRICT original FROM public.operational_notification_destinations WHERE notification_id=notice_id;
    PERFORM pg_temp.q_assert(EXISTS(SELECT 1 FROM public.operational_notification_destinations
      WHERE notification_id=notice_id AND inbox_event_id IS NULL AND last_error LIKE '23514:%')
      AND NOT EXISTS(SELECT 1 FROM public.push_outbox WHERE related_entity_id=notice_id),'failure did not retain pending original');
    EXECUTE 'SET LOCAL ROLE service_role';
    state:=public.fn_retry_owner_notification_destination(notice_id);
    PERFORM pg_temp.q_assert(current_user='service_role' AND state->>'notification_id'=notice_id::text
      AND state->>'target_task_id'=q.task_id::text AND state->'inbox_event_id'='null'::jsonb,
      'owning-request retry concealed a still-pending recorder failure');
    EXECUTE 'RESET ROLE';
    EXECUTE 'ALTER TABLE public.operational_alert_events DROP CONSTRAINT qual_owner_exact_failure';
    EXECUTE 'SET LOCAL ROLE service_role';
    state:=public.fn_retry_owner_notification_destination(notice_id);
    PERFORM pg_temp.q_assert(current_user='service_role' AND state->>'notification_id'=notice_id::text
      AND state->>'target_task_id'=q.task_id::text AND (state->>'inbox_event_id')::bigint>0,
      'bounded exact retry returned a malformed receipt');
    EXECUTE 'RESET ROLE';
    SELECT inbox_event_id INTO STRICT receipt FROM public.operational_notification_destinations WHERE notification_id=notice_id;
    PERFORM pg_temp.q_assert(receipt=(state->>'inbox_event_id')::bigint AND receipt>0
      AND (SELECT original_notification=original AND last_error IS NULL
      FROM public.operational_notification_destinations WHERE notification_id=notice_id),'pending retry lost original or actual receipt');
    PERFORM pg_temp.q_assert(public.fn_try_record_owner_notification(notice_id)=receipt,'exact recorded retry changed identity');
    -- Actual oversize recorder refusal stays pending; never truncate its original.
    notice_id:=gen_random_uuid();
    INSERT INTO public.notifications(id,user_id,type,title,message)
      VALUES(notice_id,q.owner_user,'financial_incident','QUAL oversize original',repeat('x',262145));
    PERFORM pg_temp.q_assert(EXISTS(SELECT 1 FROM public.operational_notification_destinations
      WHERE notification_id=notice_id AND inbox_event_id IS NULL AND last_error IS NOT NULL
        AND length(original_notification->>'message')=262145)
      AND NOT EXISTS(SELECT 1 FROM public.push_outbox WHERE related_entity_id=notice_id),'oversize falsely accepted/truncated/fell back');
  END;
  $pending$;
  -- Change only generated fixture copies. Each control rolls its corruption back.
  DO $collisions$
  DECLARE notice_id uuid; d public.operational_notification_destinations%ROWTYPE;
    e public.operational_alert_events%ROWTYPE; field text; result bigint; old_original jsonb;
  BEGIN
    SELECT c.id INTO notice_id FROM q_cases c WHERE c.name='raw';
    SELECT * INTO STRICT d FROM public.operational_notification_destinations WHERE notification_id=notice_id;
    SELECT x.* INTO STRICT e FROM public.operational_alert_events x WHERE x.id=d.inbox_event_id;
    FOREACH field IN ARRAY ARRAY['name','status','severity','target','original','pointer','malformed-original'] LOOP
      BEGIN
        old_original:=d.original_notification;
        IF field='pointer' THEN
          UPDATE public.operational_notification_destinations SET inbox_event_id=(
            SELECT x.inbox_event_id FROM public.operational_notification_destinations x
            JOIN q_cases c ON c.id=x.notification_id WHERE c.name='inline') WHERE notification_id=notice_id;
        ELSIF field='malformed-original' THEN
          UPDATE public.operational_notification_destinations SET original_notification='{}'::jsonb WHERE notification_id=notice_id;
        ELSE
          UPDATE public.operational_alert_events x SET
            alertname=CASE WHEN field='name' THEN 'QUAL wrong name' ELSE x.alertname END,
            status=CASE WHEN field='status' THEN 'resolved' ELSE x.status END,
            severity=CASE WHEN field='severity' THEN 'info' ELSE x.severity END,
            payload=CASE WHEN field='target' THEN jsonb_set(x.payload,'{target_task_id}',to_jsonb(gen_random_uuid()::text))
              WHEN field='original' THEN jsonb_set(x.payload,'{original_notification,message}','"different body"'::jsonb)
              ELSE x.payload END WHERE x.id=e.id;
          UPDATE public.operational_notification_destinations SET inbox_event_id=NULL WHERE notification_id=notice_id;
        END IF;
        result:=public.fn_try_record_owner_notification(notice_id);
        PERFORM pg_temp.q_assert(result IS NULL AND EXISTS(SELECT 1 FROM public.operational_notification_destinations
          WHERE notification_id=notice_id AND inbox_event_id IS NULL AND last_error IS NOT NULL),'collision/malformed receipt accepted: '||field);
        IF field<>'malformed-original' THEN
          PERFORM pg_temp.q_assert((SELECT original_notification=old_original FROM public.operational_notification_destinations
            WHERE notification_id=notice_id),'collision overwrote original');
        END IF;
        RAISE SQLSTATE 'ZQ001' USING MESSAGE='rollback only this qualification corruption';
      EXCEPTION WHEN SQLSTATE 'ZQ001' THEN NULL; END;
    END LOOP;
    PERFORM pg_temp.q_assert((SELECT to_jsonb(x)=to_jsonb(e) FROM public.operational_alert_events x WHERE x.id=e.id)
      AND (SELECT original_notification=d.original_notification FROM public.operational_notification_destinations WHERE notification_id=notice_id),
      'negative control leaked corruption');
  END;
  $collisions$;
  SELECT jsonb_build_object('stage','rollback_scoped_native_source_observations',
    'execution',execution,'full_qualification',false,'realtime_verified',false,
    'http_loader_cache_verified',false,'allocation_disposed',false) FROM q_inputs;
  ROLLBACK TO SAVEPOINT exercise;
  SELECT pg_temp.q_assert((SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.notifications n)
      IS NOT DISTINCT FROM b.notifications
    AND (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.operational_alert_events e)
      IS NOT DISTINCT FROM b.events
    AND (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.push_outbox p)
      IS NOT DISTINCT FROM b.pushes
    AND (SELECT jsonb_agg(to_jsonb(d) ORDER BY notification_id) FROM public.operational_notification_destinations d)
      IS NOT DISTINCT FROM b.destinations,'rollback did not restore every selected original') FROM q_before b;
  ROLLBACK;
\endif
