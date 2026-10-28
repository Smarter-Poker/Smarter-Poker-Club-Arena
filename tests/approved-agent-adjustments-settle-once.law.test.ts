import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const file =
  'supabase/migrations/20261028153553_approved_agent_adjustments_settle_once_from_the_club_bank.sql';
describe('Approved agent adjustments settle once through their original club bank', () => {
  it('binds one approved payload to one durable bank-to-agent receipt', () => {
    const source = read(file);
    for (const invariant of [
      'approved_agent_adjustment_payload_changed',
      'manual-agent-adjustment:',
      'approved_agent_adjustment_replay_receipt_changed',
      'approved_agent_adjustment_transfer_not_conserved',
      'approved_agent_adjustment_journal_receipt_invalid',
      "SET status='settled'",
      'fn_ca_declare_ledger',
      'approved_intent_md5',
    ])
      expect(source).toContain(invariant);
    expect(source).toContain("session_user<>'postgres' OR current_user<>'postgres'");
    expect(source).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(source).not.toContain('request.jwt.claim');
    expect(source).not.toMatch(
      /UPDATE\s+public\.(rakeback_periods|rakeback_period_payouts|agent_commission_settlements|accounting_cash_rake_sources)/i
    );
  });
  it('keeps truthful platform attribution and the original audit independence predicate', () => {
    const source = read(file);
    expect(source).toContain("VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid");
    expect(source).toContain(
      "'executed_by_db_role',current_user,'executed_by_session_user',session_user"
    );
    expect(source).toContain("WHERE a.status IN ('approved','settled')");
    expect(source).not.toContain('m.actor');
    const native = read('scripts/qualification/approved-agent-adjustment/native.py');
    for (const proof of [
      'real_actor_FK_and_original_trigger_with_absent_audit_actor',
      'platform_attributed_execution_keeps_truthful_single_actor_classification',
      'actual_deferred_tally_rejects_unjournalled_balance',
      'concurrent_original_operation_replay_uses_one_durable_leg',
    ])
      expect(native).toContain(proof);
    expect(read('.github/workflows/approved-agent-adjustment.yml')).toContain(
      'python3 -B scripts/qualification/approved-agent-adjustment/native.py'
    );
  });
  it('documents earned commission through the canonical paid transfer pipeline', () => {
    const source = read(
      'supabase/migrations/20261028193243_approved_earned_agent_commissions_issue_paid_transfer_receip.sql'
    );
    for (const invariant of [
      "public.fn_ca_declare_ledger('commission','club_treasury'",
      "a.amount,'commission',p_club,a.reason",
      'approved_agent_adjustment_paid_document_unverified',
      "i.status='paid'",
      'i.chips_transferred IS TRUE',
      "i.breakdown->'approved_intent'=intent",
      "a.id::text=l.metadata->>'adjustment_id'",
      "a.status IN('approved','settled')",
    ])
      expect(source).toContain(invariant);
    expect(source).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_accounting_correction_prepare'
    );
    const native = read('scripts/qualification/approved-agent-adjustment/native.py');
    for (const proof of [
      'real_document_trigger_reproduces_original_incident_category_failure_atomically',
      'real_commission_document_paid_transferred_numbered_history_only_and_truthful_audit',
      'commission_replay_preserves_exact_credit_invoice_counter_and_empty_messenger_deliveries',
      'missing_document_trigger_refuses_and_rolls_back_credit',
    ])
      expect(native).toContain(proof);
    expect(read('scripts/qualification/approved-agent-adjustment/document_pipeline.py')).toContain(
      'accounting_transfer_document'
    );
    expect(read('scripts/qualification/approved-agent-adjustment/document_pipeline.py')).toContain(
      "assert declaration.count('CREATE TABLE ')==1"
    );
  });
  it('keeps earned credits payable to suspended wallets without activating them', () => {
    const source = read(
      'supabase/migrations/20261028183252_suspended_agents_receive_approved_past_earned_chips.sql'
    );
    expect(source).toContain("g.status NOT IN('active','suspended')");
    expect(source).toContain('1edc12539a8b79db0614bf0470a3cf23');
    expect(source).toContain('6eec29205765cd38ca9e0f6f9bfb8ed5');
    expect(source).toContain("to_jsonb(p)-'prosrc'");
    expect(source).not.toMatch(/UPDATE\s+(?:public\.)?agents/i);
    expect(read('scripts/qualification/approved-agent-adjustment/native.py')).toContain(
      'suspended_existing_wallet_receives_past_earned_credit_without_reactivation_rollback'
    );
  });
});
