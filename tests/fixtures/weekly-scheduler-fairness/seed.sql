-- The real routed fixture's club has 170 rake, 46.60 direct payouts and real
-- Messenger/notification receipt triggers. Make that book standalone.
DELETE FROM unions;
DELETE FROM union_clubs;
DELETE FROM union_settlement_floor;
DELETE FROM accounting_agreement_history;
UPDATE clubs SET union_id=NULL;
UPDATE accounting_cash_rake_sources SET union_id=NULL,coordinator_union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
-- These nine unions have no posted Round 1 receipt. Actual preparation and
-- cascade code must refuse them; no coordinator or payout stub is substituted.
INSERT INTO unions(id,name,owner_id) SELECT u(n),'Blocked Union '||n,u(902) FROM generate_series(1001,1009)n;
INSERT INTO union_settlement_floor SELECT id,'2026-09-07 07:00Z'::timestamptz FROM unions;
SET test.clock='2026-09-14T09:20:00Z';
CREATE FUNCTION test_scheduler_money_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'clubs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM clubs c),
  'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.club_id,m.user_id) FROM club_members m),
  'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM chip_ledger l),
  'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM wallet_transactions w),
  'routes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.scope_kind,r.scope_id,r.period_start,r.round_no) FROM accounting_routed_settlement_runs r),
  'invoices',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM settlement_invoices i),
  'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM social_messages m),
  'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM notifications n),
  'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.invoice_id,d.recipient_id) FROM accounting_invoice_deliveries d));
$$;
