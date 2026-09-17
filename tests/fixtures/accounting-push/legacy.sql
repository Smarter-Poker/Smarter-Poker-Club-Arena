CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();
-- A real existing receipt, queued through the installed bridge before cutover.
SELECT set_config('test.engine','true',false);
SELECT fixture_transfer(u(900),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001');
CREATE TEMP TABLE legacy_push AS SELECT p.id,p.status,p.body,p.related_entity_id FROM push_outbox p;
-- Fill the recipient's ordinary queue to the old cap.
INSERT INTO push_outbox(recipient_user_id,title,body,event,status)
 SELECT '10000000-0000-0000-0000-000000000002','Existing','Existing','system','pending' FROM generate_series(1,20);
