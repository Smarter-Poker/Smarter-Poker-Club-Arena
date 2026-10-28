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
});
