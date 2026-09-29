/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND CORRECTION SETTLES ONCE (DIAMOND PHASE 10, 2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The four platform-staff doors over the audited adjustments register
 * (ca_manual_adjustments) for Diamonds: propose, approve, reject and settle.
 * Each door names the signed-in caller as the proposer, approver, rejecter or
 * settler, so nothing sent from here can name anyone else, and a proposer can
 * never approve their own row (the register refuses it: four_eyes_violated).
 *
 * The database answers every refusal by name ({ ok: false, refused_reason })
 * and this service passes that name through untouched, with the rest of the
 * answer as detail: a staff screen shows it and never guesses.
 *
 * Settling moves Diamonds only once what pays for a correction is authorized
 * (ca_diamond_correction_source, Dan's decision). Until then the settle door
 * answers diamond_correction_source_not_authorized. A row that is already
 * settled answers its stored receipt again, with replayed: true, and moves
 * nothing, so a retried click is safe.
 */
import { supabase } from '../lib/supabase';

export type DiamondAdjustmentTargetKind = 'diamond_wallet' | 'diamond_house';
export type DiamondCorrectionSource = 'diamond_house' | 'new_issuance';

/** A refusal, under the database's own name. */
export interface DiamondAdjustmentRefusal {
  ok: false;
  refusedReason: string;
  detail: Record<string, unknown>;
}

export interface DiamondAdjustmentProposal {
  ok: true;
  adjustmentId: string;
  status: string;
  /** Signed whole Diamonds: a credit is positive, a debit negative. */
  amount: number;
  targetKind: DiamondAdjustmentTargetKind;
}

export interface DiamondAdjustmentDecision {
  ok: true;
  adjustmentId: string;
  status: 'approved' | 'rejected';
}

export interface DiamondAdjustmentReceipt {
  ok: true;
  /** True when the row was already settled: the same receipt, nothing moved. */
  replayed: boolean;
  adjustmentId: string;
  targetKind: DiamondAdjustmentTargetKind;
  /** The player for a wallet row; the house sentinel for a house row. */
  targetId: string | null;
  amount: number;
  direction: 'credit' | 'debit';
  source: DiamondCorrectionSource;
  /** What the register's supply moved: 0 when the house paid or received. */
  supplyMoved: number;
  /** The Mint's own answer for every leg, in the order they ran. */
  legs: Array<Record<string, unknown>>;
  proposedBy: string;
  approvedBy: string;
  settledBy: string;
  settledAt: string;
}

export type DiamondAdjustmentAnswer<T> = T | DiamondAdjustmentRefusal;

type Answer = Record<string, unknown>;

async function callDoor(door: string, args: Record<string, unknown>): Promise<Answer> {
  const { data, error } = await supabase.rpc(door, args);
  if (error) throw new Error(error.message || 'Could Not Reach The Adjustment Door');
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
    throw new Error('Invalid Adjustment Response');
  }
  return data as Answer;
}

function refusal(answer: Answer): DiamondAdjustmentRefusal {
  const detail: Record<string, unknown> = { ...answer };
  delete detail.ok;
  delete detail.refused_reason;
  const named = answer.refused_reason;
  return {
    ok: false,
    refusedReason: typeof named === 'string' && named.length > 0 ? named : 'refused',
    detail,
  };
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Invalid Adjustment ${what}`);
  return value;
}

function whole(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid Adjustment ${what}`);
  return n;
}

/** Propose a correction. amount is signed whole Diamonds; the reason is at least 20 characters. */
export async function proposeDiamondAdjustment(input: {
  targetKind: DiamondAdjustmentTargetKind;
  /** The player for diamond_wallet; null for diamond_house. */
  targetId: string | null;
  amount: number;
  reason: string;
}): Promise<DiamondAdjustmentAnswer<DiamondAdjustmentProposal>> {
  const answer = await callDoor('fn_ca_diamond_adjustment_propose', {
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_amount: input.amount,
    p_reason: input.reason,
  });
  if (answer.ok !== true) return refusal(answer);
  return {
    ok: true,
    adjustmentId: text(answer.adjustment_id, 'Id'),
    status: text(answer.status, 'Status'),
    amount: whole(answer.amount, 'Amount'),
    targetKind: text(answer.target_kind, 'Target') as DiamondAdjustmentTargetKind,
  };
}

async function decide(
  door: string,
  adjustmentId: string,
  note: string | null | undefined
): Promise<DiamondAdjustmentAnswer<DiamondAdjustmentDecision>> {
  const answer = await callDoor(door, { p_adjustment_id: adjustmentId, p_note: note ?? null });
  if (answer.ok !== true) return refusal(answer);
  const status = text(answer.status, 'Status');
  if (status !== 'approved' && status !== 'rejected') throw new Error('Invalid Adjustment Status');
  return { ok: true, adjustmentId: text(answer.adjustment_id, 'Id'), status };
}

/** Approve someone else's proposal. Approving your own is refused (four_eyes_violated). */
export function approveDiamondAdjustment(
  adjustmentId: string,
  note?: string | null
): Promise<DiamondAdjustmentAnswer<DiamondAdjustmentDecision>> {
  return decide('fn_ca_diamond_adjustment_approve', adjustmentId, note);
}

/** Reject a proposal that has not been approved. */
export function rejectDiamondAdjustment(
  adjustmentId: string,
  note?: string | null
): Promise<DiamondAdjustmentAnswer<DiamondAdjustmentDecision>> {
  return decide('fn_ca_diamond_adjustment_reject', adjustmentId, note);
}

/** Settle an approved correction, exactly once. A settled row answers its receipt again. */
export async function settleDiamondAdjustment(
  adjustmentId: string
): Promise<DiamondAdjustmentAnswer<DiamondAdjustmentReceipt>> {
  const answer = await callDoor('fn_ca_diamond_adjustment_settle', {
    p_adjustment_id: adjustmentId,
  });
  if (answer.ok !== true) return refusal(answer);
  if (!Array.isArray(answer.legs) || answer.legs.length === 0) {
    throw new Error('Invalid Adjustment Receipt');
  }
  const amount = whole(answer.amount, 'Amount');
  return {
    ok: true,
    replayed: answer.replayed === true,
    adjustmentId: text(answer.adjustment_id, 'Id'),
    targetKind: text(answer.target_kind, 'Target') as DiamondAdjustmentTargetKind,
    targetId: typeof answer.target_id === 'string' ? answer.target_id : null,
    amount,
    direction: amount < 0 ? 'debit' : 'credit',
    source: text(answer.source, 'Source') as DiamondCorrectionSource,
    supplyMoved: whole(answer.supply_moved, 'Supply'),
    legs: answer.legs as Array<Record<string, unknown>>,
    proposedBy: text(answer.proposed_by, 'Proposer'),
    approvedBy: text(answer.approved_by, 'Approver'),
    settledBy: text(answer.settled_by, 'Settler'),
    settledAt: text(answer.settled_at, 'Time'),
  };
}
