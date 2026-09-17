import type { CreditReductionReceipt, CreditReductionSnapshot } from '../../src/lib/CreditReductionContract';
export const CREDIT_ID = {
  actor:'10000000-0000-4000-8000-000000000001', club:'20000000-0000-4000-8000-000000000001',
  target:'30000000-0000-4000-8000-000000000001', agent:'40000000-0000-4000-8000-000000000001',
  operation:'50000000-0000-4000-8000-000000000001', receipt:'60000000-0000-4000-8000-000000000001',
  assignment:'70000000-0000-4000-8000-000000000001', document:'80000000-0000-4000-8000-000000000001',
  invoice:'90000000-0000-4000-8000-000000000001', retirement:'a0000000-0000-4000-8000-000000000001',
};
export function creditSnapshot(overrides: Partial<CreditReductionSnapshot> = {}): CreditReductionSnapshot {
  return { contract_version:1,actor_user_id:CREDIT_ID.actor,club_id:CREDIT_ID.club,agent_id:CREDIT_ID.agent,
    target_user_id:CREDIT_ID.target,credit_limit:'100.00',credit_used:'0.00',is_prepaid:false,control_revision:'0',
    captured_at:'2026-09-15T14:00:00.123456Z',...overrides };
}
export function creditReceipt(overrides: Partial<CreditReductionReceipt> = {}): CreditReductionReceipt {
  return { contract_version:1,receipt_id:CREDIT_ID.receipt,actor_user_id:CREDIT_ID.actor,operation_id:CREDIT_ID.operation,
    club_id:CREDIT_ID.club,agent_id:CREDIT_ID.agent,target_user_id:CREDIT_ID.target,action:'reduce_credit_limit',
    requested_reduction:'250.00',reason:null,assignment_reason:'Credit line reduced',before_limit:'100.00',after_limit:'0.00',
    credit_used:'0.00',before_prepaid:false,after_prepaid:true,before_revision:'0',after_revision:'1',applied_reduction:'100.00',
    assignment_id:CREDIT_ID.assignment,document_id:CREDIT_ID.document,invoice_id:CREDIT_ID.invoice,
    recorded_at:'2026-09-15T14:01:00.654321Z',outcome:'applied',payment_proven:false,chip_movement_claimed:false,
    amount_due_claimed:false,...overrides };
}
export function creditEnvelope(args: Record<string,unknown>, state: 'absent'|'recorded'|'retired' = 'absent',
  receiptOverrides: Partial<CreditReductionReceipt> = {}, replayed = state !== 'absent') {
  const actor = args.p_expected_actor_id as string, operation = args.p_operation_id as string, club = args.p_club_id as string;
  return { contract_version:1,state,actor_user_id:actor,operation_id:operation,club_id:club,replayed,
    receipt:state === 'recorded' ? creditReceipt({ actor_user_id:actor,operation_id:operation,club_id:club,...receiptOverrides }) : null,
    retirement:state === 'retired' ? { contract_version:1,retirement_id:CREDIT_ID.retirement,actor_user_id:actor,
      operation_id:operation,club_id:club,state:'retired',retired_at:'2026-09-15T14:02:00.123456Z' } : null };
}
