/** Transport fixture only. Does not execute or prove the database payer. */
export const CASHOUT_IDS = {
  player: '51000000-0000-4000-8000-000000000001',
  agent: '51000000-0000-4000-8000-000000000002',
  other: '51000000-0000-4000-8000-000000000003',
  club: '51000000-0000-4000-8000-000000000004',
  otherClub: '51000000-0000-4000-8000-000000000005',
  cashout: '51000000-0000-4000-8000-000000000006',
  escrow: '51000000-0000-4000-8000-000000000007',
  operation: '51000000-0000-4000-8000-000000000008',
  event: '51000000-0000-4000-8000-000000000009',
  invoice: '51000000-0000-4000-8000-000000000010',
  transaction: '51000000-0000-4000-8000-000000000011',
  ledger: '51000000-0000-4000-8000-000000000012',
  holdEvent: '51000000-0000-4000-8000-000000000013',
  holdInvoice: '51000000-0000-4000-8000-000000000014',
} as const;
export type FixtureCashoutKind = 'hold' | 'approval' | 'cancellation' | 'decline';
type RequestState = 'pending' | 'approved' | 'cancelled' | 'rejected' | 'expired';
export function cashoutV2Receipt(
  kind: FixtureCashoutKind = 'hold',
  options: {
    amount?: number;
    replayed?: boolean;
    currentStatus?: RequestState;
    note?: string;
  } = {}
) {
  const id = CASHOUT_IDS;
  const hold = kind === 'hold';
  const playerAction = hold || kind === 'cancellation';
  const requestStatus = {
    hold: 'pending',
    approval: 'approved',
    cancellation: 'cancelled',
    decline: 'rejected',
  }[kind];
  const currentStatus = options.currentStatus ?? requestStatus;
  const amount = (options.amount ?? 250).toFixed(2);
  const createdAt = '2026-09-15T09:00:00+00:00';
  const changedAt = '2026-09-15T09:01:00+00:00';
  const cashier = {
    contract_version: 1,
    event_id: id.event,
    invoice_id: id.invoice,
    cashout_id: id.cashout,
    escrow_id: id.escrow,
    source_transaction_id: id.transaction,
    source_ledger_id: id.ledger,
    club_id: id.club,
    player_id: id.player,
    assigned_agent_id: id.agent,
    issuer_representative_id: id.agent,
    actor_user_id: playerAction ? id.player : id.agent,
    actor_role: playerAction ? 'player' : 'agent',
    event_kind: kind,
    display_state: hold ? 'held' : kind === 'approval' ? 'approved' : 'refunded',
    amount,
    occurred_at: hold ? createdAt : changedAt,
    issued_at: changedAt,
    hold_event_id: hold ? null : id.holdEvent,
    hold_invoice_id: hold ? null : id.holdInvoice,
    ledger_from_type: hold ? 'player_wallet' : 'escrow',
    ledger_from_entity_id: hold ? id.player : id.escrow,
    ledger_to_type: hold ? 'escrow' : kind === 'approval' ? 'agent_wallet' : 'player_wallet',
    ledger_to_entity_id: hold ? id.escrow : kind === 'approval' ? id.agent : id.player,
    custody_movement_recorded: true,
    cashout_completed: kind === 'approval',
    refund_recorded: kind === 'cancellation' || kind === 'decline',
  };
  return {
    ...cashier,
    cashier,
    success: true,
    replayed: options.replayed ?? false,
    op_id: id.operation,
    request_status: requestStatus,
    accepted_note: options.note?.trim() || null,
    actor_wallet_after: kind === 'decline' ? null : '750.00',
    request: {
      id: id.cashout,
      club_id: id.club,
      player_id: id.player,
      agent_id: id.agent,
      amount,
      status: currentStatus,
      created_at: createdAt,
      updated_at: hold && currentStatus === 'pending' ? createdAt : changedAt,
      acknowledged_at:
        currentStatus === 'approved' || currentStatus === 'rejected' ? changedAt : null,
      completed_at: currentStatus === 'approved' ? changedAt : null,
      cancelled_at: ['cancelled', 'rejected', 'expired'].includes(currentStatus) ? changedAt : null,
      player_note: hold ? options.note?.trim() || null : null,
      agent_note: !playerAction ? options.note?.trim() || null : null,
    },
  };
}

/** Exact resolver envelope; null receipt is authoritative absence only here. */
export function cashoutLookupEnvelope(args: Record<string, unknown>, receipt: unknown = null) {
  return {
    contract_version: 1,
    actor_user_id: args.p_expected_actor_id,
    op_id: args.p_op_id,
    action: args.p_action,
    club_id: args.p_club_id,
    amount: args.p_amount,
    cashout_id: args.p_cashout_id,
    accepted_note: args.p_note,
    found: receipt !== null,
    receipt,
  };
}
