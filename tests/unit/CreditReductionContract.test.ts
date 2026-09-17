import { describe,it,expect } from 'vitest';
import { creditSnapshot,creditReceipt,creditEnvelope,CREDIT_ID as ID } from '../helpers/creditReductionReceipt';
import { parseCreditSnapshot,parseCreditEnvelope,creditReductionAmount,creditIntentText,receiptIntent } from '../../src/lib/CreditReductionContract';
const args = { p_expected_actor_id:ID.actor,p_club_id:ID.club,p_operation_id:ID.operation };
const expected = { actor:ID.actor,club:ID.club,operation:ID.operation };
describe('exact nonpayable credit reduction receipt',() => {
  it('keeps exact money, bigint revisions including zero and microsecond timestamps',() => {
    const snapshot = creditSnapshot({ credit_limit:'9999999999999.99',control_revision:'9223372036854775806' });
    expect(parseCreditSnapshot(snapshot,ID.actor,ID.club,ID.target)).toEqual(snapshot);
    const envelope = creditEnvelope(args,'recorded');
    expect(parseCreditEnvelope(envelope,expected,'lookup').receipt?.applied_reduction).toBe('100.00');
    expect(envelope.receipt?.requested_reduction).toBe('250.00');
    expect(parseCreditEnvelope(envelope,expected,'lookup').receipt?.recorded_at).toBe('2026-09-15T14:01:00.654321Z');
  });
  it.each(['90071992547409.90','90071992547409.91','01.00','1e3','NaN','Infinity','1.001','-1.00',1,null])('refuses malformed or out-of-schema transport %s',(amount) => {
    expect(() => parseCreditSnapshot({ ...creditSnapshot(),credit_limit:amount },ID.actor,ID.club,ID.target)).toThrow(/Unconfirmed/);
  });
  it.each(['2026-02-30T01:00:00.123456Z','2026-09-15 14:00:00+00','2026-09-15T14:00:00.123Z','2026-09-15T24:00:00.123456Z','infinity'])('refuses noncanonical timestamp %s',(captured_at) => {
    expect(() => parseCreditSnapshot(creditSnapshot({ captured_at }),ID.actor,ID.club,ID.target)).toThrow();
  });
  it.each([
    { payment_proven:true },{ chip_movement_claimed:true },{ amount_due_claimed:true },{ invoice_id:null },
    { document_id:ID.invoice },{ after_limit:'1.00' },{ applied_reduction:'250.00' },{ after_revision:'0' },
    { credit_used:'1.00' },{ assignment_reason:'Changed' },{ requested_reduction:'0.00' },{ reason:undefined },
  ])('refuses contradictory recorded proof %j',(delta) => {
    const value = creditEnvelope(args,'recorded'); Object.assign(value.receipt!,delta);
    expect(() => parseCreditEnvelope(value,expected,'lookup')).toThrow(/Unconfirmed/);
  });
  it('accepts only the documented no-change prepaid state with no fabricated documents',() => {
    const value = creditEnvelope(args,'recorded',{ before_limit:'0.00',before_prepaid:true,applied_reduction:'0.00',
      after_revision:'0',outcome:'no_change',assignment_id:null,document_id:null,invoice_id:null });
    expect(parseCreditEnvelope(value,expected,'lookup').receipt?.outcome).toBe('no_change');
    value.receipt!.invoice_id = ID.invoice;
    expect(() => parseCreditEnvelope(value,expected,'lookup')).toThrow();
  });
  it('keeps NULL, empty and whitespace reasons distinct while checking the assignment default',() => {
    const nullIntent = receiptIntent(creditReceipt()), emptyIntent = receiptIntent(creditReceipt({ reason:'' }));
    expect(creditIntentText(nullIntent)).not.toBe(creditIntentText(emptyIntent));
    const empty = creditEnvelope(args,'recorded',{ reason:'' });
    expect(() => parseCreditEnvelope(empty,expected,'lookup',nullIntent)).toThrow();
    expect(parseCreditEnvelope(empty,expected,'lookup',emptyIntent).receipt?.reason).toBe('');
    const spaced = creditEnvelope(args,'recorded',{ reason:' ',assignment_reason:' ' });
    expect(parseCreditEnvelope(spaced,expected,'lookup').receipt?.reason).toBe(' ');
  });
  it('requires exact absent and retired envelopes rather than truthiness or status alone',() => {
    expect(parseCreditEnvelope(creditEnvelope(args),expected,'lookup').state).toBe('absent');
    for (const value of [null,{},true,{ ...creditEnvelope(args),receipt:{} },{ ...creditEnvelope(args),replayed:true },
      { ...creditEnvelope(args),operation_id:ID.receipt },{ ...creditEnvelope(args),extra:1 }]) {
      expect(() => parseCreditEnvelope(value,expected,'lookup')).toThrow();
    }
    expect(() => parseCreditEnvelope(creditEnvelope(args),expected,'apply')).toThrow();
    expect(() => parseCreditEnvelope(creditEnvelope(args,'retired'),expected,'apply')).toThrow();
    expect(() => parseCreditEnvelope(creditEnvelope(args,'recorded',{},false),expected,'retire')).toThrow();
    expect(parseCreditEnvelope(creditEnvelope(args,'retired'),expected,'retire').state).toBe('retired');
  });
  it('normalizes plain UI decimals once without rounding or treating empty as zero',() => {
    expect(creditReductionAmount('25')).toBe('25.00'); expect(creditReductionAmount('25.1')).toBe('25.10');
    for (const value of ['', '0', '25.001', '1e2', ' 25', '1000000000.01']) expect(() => creditReductionAmount(value)).toThrow();
  });
});
