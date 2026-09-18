CREATE OR REPLACE FUNCTION fixture.place_original_transactions(p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres' THEN RAISE EXCEPTION 'private native fixture only'; END IF;
 ALTER TABLE union_pnl_transaction_frames DISABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_inventory_events DISABLE TRIGGER original_pnl_inventory_events_immutable;
 ALTER TABLE union_pnl_original_flows DISABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_transaction_frames SET observed_at=p_at,book_start=fn_union_week_start(p_at) WHERE observed_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_inventory_events SET observed_at=p_at WHERE observed_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_original_flows SET recognized_at=p_at WHERE recognized_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_cash_outcomes SET recognized_at=p_at WHERE recognized_at>=fn_union_week_start(clock_timestamp());
 ALTER TABLE union_pnl_transaction_frames ENABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_inventory_events ENABLE TRIGGER original_pnl_inventory_events_immutable;
 ALTER TABLE union_pnl_original_flows ENABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_cash_outcomes ENABLE TRIGGER original_pnl_immutable;
END $$;
-- The fixture places real original events on an isolated historical calendar;
-- no production clock is changed and no historical balances are manufactured.
SELECT fixture.place_original_transactions('2026-09-05 12:00Z');
ALTER TABLE union_pnl_inventory_capture DISABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_weekly_capture DISABLE TRIGGER original_pnl_immutable;
ALTER TABLE union_pnl_eco_observations DISABLE TRIGGER original_pnl_immutable;
UPDATE union_pnl_inventory_capture SET captured_at='2026-09-04 12:00Z';
UPDATE union_pnl_weekly_capture SET captured_at='2026-09-04 12:00Z';
UPDATE union_pnl_eco_observations SET observed_from='2026-09-04 12:00Z';
UPDATE accounting_agreement_history SET observed_at=CASE WHEN event_type='baseline' THEN '2026-09-04 12:00Z'::timestamptz ELSE '2026-09-03 12:00Z'::timestamptz END WHERE entity_type='unions';
ALTER TABLE union_pnl_inventory_capture ENABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_weekly_capture ENABLE TRIGGER original_pnl_immutable;
ALTER TABLE union_pnl_eco_observations ENABLE TRIGGER original_pnl_immutable;

DO $$ DECLARE r jsonb; BEGIN
 r:=fn_union_pnl_boundary(fixture.u(201),'2026-09-07 07:00Z');
 PERFORM fixture.assert((SELECT count(*)=1 AND sum((h->>'amount')::numeric)=125 FROM jsonb_array_elements(r->'holdings') h WHERE h->>'user_id'=fixture.u(1192)::text AND h->>'kind'='cash_stack' AND h->>'club_id'=fixture.u(101)::text),'Boundary preserves exact 125 same-club wallet plus treasury chips through original move: '||r::text);
 PERFORM fixture.assert((SELECT count(*)=1 AND sum((h->>'amount')::numeric)=100 FROM jsonb_array_elements(r->'holdings') h WHERE h->>'user_id'=fixture.u(1194)::text AND h->>'kind'='cash_stack'),'Boundary retains same-original-transaction buy-in and move');
END $$;
