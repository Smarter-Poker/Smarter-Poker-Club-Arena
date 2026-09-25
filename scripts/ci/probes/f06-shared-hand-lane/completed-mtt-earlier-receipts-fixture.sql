-- Isolated synthetic legacy receipts with the actual persisted authority shape.
-- Call after fixture_seed_completed_mtt(i), before capturing expected input.
-- These are original prior receipts, not a reconstructed current hand request.
CREATE FUNCTION fixture_seed_completed_mtt_earlier_receipts(i integer,n integer DEFAULT 53)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE tab uuid:=md5('cm-table'||i)::uuid; hid uuid; j integer;
 stamp timestamptz; result jsonb;
BEGIN
 FOR j IN 1..n LOOP
  hid:=md5('cm-earlier-hand'||i||':'||j)::uuid;
  stamp:='2026-09-09 05:49:35+00'::timestamptz+j*interval '1 minute';
  result:=jsonb_build_object('success',true,'table_id',tab,'hand_id',hid,
   'hand_number',8563187+j,'conservation_checked',true,'mode','delta',
   'players',2,'rake',0,'bbj',0,'inflow',0,'net_deltas',0,
   'rebased','{}'::jsonb,'departed','[]'::jsonb);
  INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,result,error,
    attempt_count,first_attempt_at,last_attempt_at,completed_at)
  VALUES(tab,hid,'succeeded',result,NULL,1,stamp,stamp,stamp);
  INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id,
    idempotency_key,totals,error_detail,created_at,updated_at)
  VALUES('hand_stacks',tab::text||':'||hid::text,'final',tab,hid,
    'hand:'||tab::text||':'||hid::text,
    jsonb_build_object('mode','delta','players',2,'rake',0,'bbj',0,
      'inflow',0,'net_deltas',0,'rebased','{}'::jsonb,'departed','[]'::jsonb,'ref',NULL),
    NULL,stamp,stamp);
 END LOOP;
END $$;
