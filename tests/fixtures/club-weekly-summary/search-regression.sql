-- Runs after the existing club-weekly-summary regression fixture.
SELECT set_config('test.engine','true',false);
CREATE TEMP TABLE search_receipt AS SELECT m.id,m.conversation_id,d.recipient_id,d.invoice_id,i.invoice_number
 FROM social_messages m JOIN accounting_invoice_deliveries d ON d.message_id=m.id JOIN settlement_invoices i ON i.id=d.invoice_id
 WHERE d.delivery_mode='immediate' ORDER BY m.id LIMIT 1;
SELECT assert_true((SELECT count(*)=1 FROM search_receipt),'search fixture has a real issued receipt');
SELECT assert_true((SELECT media_metadata->>'accounting_verified'='true' AND media_metadata->>'invoice_id'=(SELECT invoice_id::text FROM search_receipt)
 FROM fn_messenger_search_messages((SELECT recipient_id FROM search_receipt),ARRAY[(SELECT conversation_id FROM search_receipt)],(SELECT invoice_number FROM search_receipt),1)),
 'search receipt identity is linked to the actual issued document');
UPDATE settlement_invoices SET status='cancelled' WHERE id=(SELECT invoice_id FROM search_receipt);
SELECT assert_true((SELECT media_metadata->>'status'='cancelled' AND media_metadata->>'issued_status'='paid'
 FROM fn_messenger_search_messages((SELECT recipient_id FROM search_receipt),ARRAY[(SELECT conversation_id FROM search_receipt)],(SELECT invoice_number FROM search_receipt),1)),
 'search returns current invoice status while preserving issued status');
CREATE TEMP TABLE search_archived_receipt AS SELECT m.conversation_id,d.recipient_id,i.invoice_number FROM accounting_invoice_deliveries d JOIN social_messages m ON m.id=d.message_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE d.delivery_mode='weekly_detail' LIMIT 1;
SELECT assert_true((SELECT count(*)=0 FROM fn_messenger_search_messages((SELECT recipient_id FROM search_archived_receipt),ARRAY[(SELECT conversation_id FROM search_archived_receipt)],(SELECT invoice_number FROM search_archived_receipt),1)),
 'archived weekly and individual copies never reappear in search');
SELECT assert_true((SELECT message_type='text' AND media_metadata->>'accounting_verified'='false'
 FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'forged invoice',1)),
 'an invoice-looking message cannot forge search receipt provenance');
-- A human discussion predates the immutable archived receipt it mentions.
INSERT INTO social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 SELECT u(910),conversation_id,recipient_id,'Question about invoice '||invoice_number,'text','{}','2000-01-01 00:00:00.123456Z' FROM search_archived_receipt;
SELECT assert_true((SELECT id=u(910) FROM fn_messenger_search_messages((SELECT recipient_id FROM search_archived_receipt),ARRAY[(SELECT conversation_id FROM search_archived_receipt)],(SELECT invoice_number FROM search_archived_receipt),1)),
 'archived messages are filtered before the result limit');
SELECT assert_true((SELECT array_agg(id ORDER BY created_at DESC,id DESC)=ARRAY[u(607),u(606),u(605)] FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'DISCUSSION',3)),
 'equal-time search results use deterministic UUID ordering');
INSERT INTO social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 VALUES(u(900),(SELECT conversation_id FROM summary_thread),'10000000-0000-0000-0000-000000000001','Search literal 10%_share','text','{}','2031-01-01 00:00Z'),
 (u(901),(SELECT conversation_id FROM summary_thread),'10000000-0000-0000-0000-000000000001','Search literal 10XXshare','text','{}','2031-01-02 00:00Z');
SELECT assert_true((SELECT count(*)=1 AND min(id::text)::uuid=u(900) FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'%_',100)),
 'percent and underscore are literal search text');
UPDATE social_messages SET is_deleted=true WHERE id=u(900);
SELECT assert_true((SELECT count(*)=0 FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'%_',100)),
 'deleted discussion text does not remain searchable');
SELECT set_config('test.engine','false',false),set_config('test.uid','10000000-0000-0000-0000-000000000004',false);
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'invoice',10)$$,'42501'),'search cannot substitute another authenticated actor');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000004',ARRAY[(SELECT conversation_id FROM summary_thread)],'invoice',10)$$,'42501'),'search requires exact conversation participation');
SELECT set_config('test.engine','true',false);
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread),u(9999)],'invoice',10)$$,'42501'),'mixed authorized and unauthorized conversation sets fail closed');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',array_fill((SELECT conversation_id FROM summary_thread),ARRAY[501]),'invoice',10)$$,'22023'),'search scope cannot exceed 500 conversations');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[]::uuid[],'invoice',10)$$,'22023'),'empty conversation scope is refused');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'i',10)$$,'22023'),'one-character queries are refused');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],repeat('x',501),10)$$,'22023'),'oversized search text is refused');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_search_messages('10000000-0000-0000-0000-000000000001',ARRAY[(SELECT conversation_id FROM summary_thread)],'invoice',101)$$,'22023'),'result limits are bounded');
SELECT assert_true(NOT has_function_privilege('anon','fn_messenger_search_messages(uuid,uuid[],text,integer)','EXECUTE'),'anonymous callers cannot invoke message search');
