-- A rakeback payout leg cannot be written without, in the same transaction, its
-- canonical source-linked document and its settlement/run identity.
--
-- This runs on the same private native cluster that has just closed a real
-- raked week end to end, with 20260921022924 already installed, so every
-- assertion below is made against the actual money the cascade moved.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','Rakeback document guard runs only in the private native cluster');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- (b) THE CORRECT, FULLY DOCUMENTED WEEKLY PAYOUT SUCCEEDED WITH THE GUARD ARMED.
-- raked-regression.sql closed 2026-09-07 -> 2026-09-14 for the raked union
-- through fn_union_settlement_cascade while this constraint was already in
-- place, so its deferred check ran at that transaction's commit and passed.
DO $accepted$
DECLARE leg public.chip_ledger%ROWTYPE;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger
  WHERE category='rakeback' AND to_type='player_wallet' AND club_id=fixture.u(104)
  ORDER BY created_at,id LIMIT 1;
 PERFORM fixture.assert(FOUND AND leg.amount>0,'The real weekly cascade still wrote its rakeback payout leg with the guard armed');
 PERFORM fixture.assert(leg.idempotency_key='round3-period:v3:'||(leg.metadata->>'period_id'),'The accepted payout leg carries the weekly authority idempotency key');
 PERFORM fixture.assert(leg.metadata->>'routing_version'='3' AND (leg.metadata->>'certificate_id') IS NOT NULL
   AND (leg.metadata->>'payout_id') IS NOT NULL AND (leg.metadata->>'period_id') IS NOT NULL,'The accepted payout leg carries its routed period, certificate and payout identity');
 PERFORM fixture.assert(EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
   WHERE r.scope_kind=leg.metadata->>'accounting_scope_kind' AND r.scope_id=(leg.metadata->>'accounting_scope_id')::uuid
     AND r.period_start=(leg.metadata->>'period_start')::timestamptz AND r.period_end=(leg.metadata->>'period_end')::timestamptz
     AND r.round_no=3 AND r.routing_version=3),'The accepted payout leg is tied to a recorded routed settlement run');
 PERFORM fixture.assert((SELECT count(*)=1 FROM public.settlement_invoices i
   WHERE i.source_ledger_id=leg.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=leg.amount AND i.net_amount=leg.amount),'The accepted payout leg has exactly one source-linked paid receipt');
 PERFORM fixture.assert(EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
   WHERE pp.id=(leg.metadata->>'payout_id')::uuid AND pp.status='paid' AND pp.payout_amount=leg.amount),'The accepted payout leg names its paid rakeback period payout');
 -- The guard deliberately does NOT require chip_ledger.settlement_id: the v3
 -- authority does not populate it on the payout leg, and a constraint that
 -- required it would refuse the first settleable week.
 PERFORM fixture.assert(leg.settlement_id IS NULL,'The accepted payout leg proves settlement_id is not part of this invariant');
END $accepted$;

-- Money fingerprint before any refusal probe.
CREATE TEMP TABLE rakeback_guard_before AS
SELECT md5(jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.settlement_invoices x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM public.accounting_invoice_deliveries x),
   (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
   (SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM public.clubs),
   (SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM public.union_wallets),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.rakeback_period_payouts x))::text) AS fingerprint;

-- (a1) THE OWNING WRITER REFUSES. This is the exact 2026-09-14 production
-- shape: a club_members.chip_balance move with app.ledger_category declared as
-- rakeback and the journal trigger left armed. It used to mint an anonymous
-- settlement_suspense -> player_wallet leg; it now refuses by name.
DO $writer_refuses$
DECLARE moved boolean:=false;
BEGIN
 BEGIN
  PERFORM set_config('app.ledger_category','rakeback',true);
  UPDATE public.club_members SET chip_balance=chip_balance+84041.00
   WHERE club_id=fixture.u(104) AND user_id=fixture.u(907);
  moved:=true;
 EXCEPTION WHEN OTHERS THEN
  PERFORM fixture.assert(SQLSTATE='42501' AND SQLERRM='rakeback_requires_accounting_authority',
   'The journal writer refuses an undocumented rakeback movement by name, not by something else: '||SQLSTATE||' '||SQLERRM);
 END;
 PERFORM set_config('app.ledger_category','',true);
 PERFORM fixture.assert(NOT moved,'An undocumented rakeback movement is never accepted by the club_members journal writer');
END $writer_refuses$;

-- (a2) THE INVARIANT HOLDS FOR ANY OTHER WRITER. A leg inserted straight into
-- the journal in the 2026-09-14 shape reaches the existing document authority
-- and still cannot reach commit: a receipt without a settlement run is not the
-- documentation a disputing player is owed.
DO $anonymous_leg_refused$
DECLARE accepted boolean:=false;
BEGIN
 BEGIN
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,
    amount,category,club_id,description)
  VALUES(fixture.u(900),'settlement_suspense',NULL,'player_wallet',fixture.u(907),
    84041.00,'rakeback',fixture.u(104),'auto-audited club_members.chip_balance delta 84041.00');
  EXECUTE 'SET CONSTRAINTS public.zz_ca_rakeback_payout_leg_is_documented IMMEDIATE';
  accepted:=true;
 EXCEPTION WHEN OTHERS THEN
  PERFORM fixture.assert(SQLSTATE='23514' AND SQLERRM='rakeback_payout_leg_undocumented',
   'An anonymous rakeback payout leg is refused by its named guard, not by something else: '||SQLSTATE||' '||SQLERRM);
 END;
 PERFORM fixture.assert(NOT accepted,'An anonymous rakeback payout leg never reaches commit');
END $anonymous_leg_refused$;

-- (a3) A ROUTED-LOOKING LEG WITH NO SETTLEMENT RUN BEHIND IT IS STILL REFUSED.
-- Same metadata shape as the accepted leg, pointed at a scope that has no run.
DO $unrun_leg_refused$
DECLARE leg public.chip_ledger%ROWTYPE; accepted boolean:=false;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger
  WHERE category='rakeback' AND to_type='player_wallet' AND club_id=fixture.u(104)
  ORDER BY created_at,id LIMIT 1;
 BEGIN
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,
    amount,category,club_id,union_id,description,idempotency_key,metadata)
  VALUES(fixture.u(900),'club_treasury',fixture.u(104),'player_wallet',fixture.u(907),
    leg.amount,'rakeback',fixture.u(104),fixture.u(203),'Weekly rakeback from certified historical payer',
    'round3-period:v3:'||fixture.u(99999)::text,
    jsonb_set(leg.metadata,'{accounting_scope_id}',to_jsonb(fixture.u(99999)::text)));
  EXECUTE 'SET CONSTRAINTS public.zz_ca_rakeback_payout_leg_is_documented IMMEDIATE';
  accepted:=true;
 EXCEPTION WHEN OTHERS THEN
  PERFORM fixture.assert(SQLSTATE='23514' AND SQLERRM='rakeback_payout_leg_undocumented',
   'A rakeback payout leg with no recorded settlement run is refused by its named guard: '||SQLSTATE||' '||SQLERRM);
 END;
 PERFORM fixture.assert(NOT accepted,'A rakeback payout leg that names no settlement run never reaches commit');
END $unrun_leg_refused$;

-- (c) EVERY REFUSAL ROLLED BACK CLEANLY: no partial money movement, no orphan
-- journal row, no orphan receipt and no orphan delivery.
DO $clean_rollback$
BEGIN
 PERFORM fixture.assert((SELECT fingerprint FROM rakeback_guard_before)=
  (SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.settlement_invoices x),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM public.accounting_invoice_deliveries x),
    (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
    (SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM public.clubs),
    (SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM public.union_wallets),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.rakeback_period_payouts x))::text)),
  'Every refused rakeback payout leaves the journal, the documents, the deliveries and every balance exactly as they were');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM public.chip_ledger
   WHERE description LIKE 'auto-audited club_members.chip_balance delta%' AND category='rakeback'),
  'No anonymous auto-audited rakeback leg survives in the journal');
END $clean_rollback$;

-- The weekly authority still closes the week after the probes: the guard is a
-- precondition on documentation, not a lock on legitimate settlement.
DO $replay_still_closes$
DECLARE cascade jsonb;
BEGIN
 cascade:=fn_union_settlement_cascade(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(cascade->>'success'='true','The certified weekly cascade still closes with the rakeback document guard armed: '||cascade::text);
 PERFORM fixture.assert((SELECT fingerprint FROM rakeback_guard_before)=
  (SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.settlement_invoices x),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM public.accounting_invoice_deliveries x),
    (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
    (SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM public.clubs),
    (SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM public.union_wallets),
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.rakeback_period_payouts x))::text)),
  'The replayed cascade pays, invoices and delivers nothing twice');
END $replay_still_closes$;
DROP TABLE rakeback_guard_before;
