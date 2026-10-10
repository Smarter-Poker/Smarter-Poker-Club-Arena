import { supabase } from '../lib/supabase';
import { assertWheelReceipt } from '../utils/wheelPendingSpin';
import { parseWheelSpinReceipt, type WheelSpinResult } from './DiamondWheelService';

export interface PaidWheelBatch {
  request_id: string;
  run_id: string;
  spins: number;
  entry_diamonds: number;
  total_cost_diamonds: number;
  client_seed: string;
  tickets: { commit_id: string; server_seed_hash: string }[];
  receipts: WheelSpinResult[];
}
export interface PendingWheelBatch {
  userId: string;
  clubId: string;
  requestId: string;
  spins: number;
  entryDiamonds: number;
  seed: string;
  presented: number;
  resumeAfterGame?: boolean;
}
const key = (user: string, club: string) => `diamond-wheel-paid-batch:${user}:${club}`;
export class WheelBatchNotCharged extends Error {
  constructor(
    message: string,
    readonly requestId: string
  ) {
    super(message);
  }
}
export function saveWheelBatch(p: PendingWheelBatch) {
  const encoded = JSON.stringify(p);
  const existing = readWheelBatch(p.userId, p.clubId);
  if (
    existing &&
    (existing.requestId !== p.requestId ||
      existing.spins !== p.spins ||
      existing.entryDiamonds !== p.entryDiamonds ||
      existing.seed !== p.seed)
  )
    throw new Error('Another Saved Run Must Be Resolved First');
  if (existing && existing.presented > p.presented)
    throw new Error('Another Page Has Already Presented More Of This Run');
  localStorage.setItem(key(p.userId, p.clubId), encoded);
  if (localStorage.getItem(key(p.userId, p.clubId)) !== encoded)
    throw new Error('Your Run Could Not Be Saved Before Payment');
}
export function readWheelBatch(user: string, club: string): PendingWheelBatch | null {
  const raw = localStorage.getItem(key(user, club));
  if (!raw) return null;
  const p = JSON.parse(raw) as PendingWheelBatch;
  if (
    p.userId !== user ||
    p.clubId !== club ||
    !/^[a-f0-9-]{36}$/i.test(p.requestId) ||
    ![5, 10, 25].includes(p.spins) ||
    !Number.isSafeInteger(p.entryDiamonds) ||
    p.entryDiamonds < 25 ||
    p.entryDiamonds > 2500 ||
    typeof p.seed !== 'string' ||
    !p.seed.length ||
    p.seed.length > 60 ||
    !Number.isInteger(p.presented) ||
    p.presented < 0 ||
    p.presented > p.spins
  )
    throw new Error('Your Saved Run Could Not Be Verified');
  return p;
}
export function clearWheelBatch(user: string, club: string, requestId: string) {
  if (readWheelBatch(user, club)?.requestId === requestId) localStorage.removeItem(key(user, club));
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw error;
  const raw = data as unknown as Record<string, unknown>;
  if (!raw || raw.ok !== true) {
    const message = typeof raw?.error === 'string' ? raw.error : 'Your Run Could Not Be Confirmed';
    if (
      name === 'fn_wheel_batch_begin' &&
      raw?.charged_diamonds === 0 &&
      raw?.status === 'prepared' &&
      raw?.request_id === args.p_request_id
    )
      throw new WheelBatchNotCharged(message, raw.request_id as string);
    throw new Error(message);
  }
  return raw;
}
export function parsePaidWheelBatch(
  raw: Record<string, unknown>,
  userId: string,
  clubId: string
): PaidWheelBatch {
  const batch = raw as unknown as PaidWheelBatch;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !uuid.test(batch.request_id) ||
    !uuid.test(batch.run_id) ||
    typeof batch.client_seed !== 'string' ||
    !batch.client_seed.length ||
    batch.client_seed.length > 60
  )
    throw new Error('The Run Identity Could Not Be Verified');
  if (
    ![5, 10, 25].includes(batch.spins) ||
    !Number.isSafeInteger(batch.entry_diamonds) ||
    batch.entry_diamonds < 25 ||
    batch.entry_diamonds > 2500 ||
    batch.total_cost_diamonds !== batch.spins * batch.entry_diamonds ||
    !Array.isArray(batch.receipts) ||
    batch.receipts.length !== batch.spins ||
    !Array.isArray(batch.tickets) ||
    batch.tickets.length !== batch.spins ||
    typeof batch.client_seed !== 'string'
  )
    throw new Error('The Complete Run Could Not Be Verified');
  batch.receipts = batch.receipts.map(parseWheelSpinReceipt);
  if (
    batch.tickets.some(
      (ticket) => !uuid.test(ticket.commit_id) || !/^[a-f0-9]{64}$/i.test(ticket.server_seed_hash)
    ) ||
    new Set(batch.receipts.map((receipt) => receipt.spin_id)).size !== batch.spins
  )
    throw new Error('The Run Receipts And Seals Could Not Be Verified');
  if (new Set(batch.tickets.map((ticket) => ticket.commit_id)).size !== batch.spins)
    throw new Error('The Run Seals Must Be Unique');
  for (let index = 0; index < batch.spins; index++) {
    assertWheelReceipt(batch.receipts[index], {
      userId,
      clubId,
      mode: 'paid',
      commitId: batch.tickets[index].commit_id,
      commitHash: batch.tickets[index].server_seed_hash,
      clientSeed: `${batch.client_seed}:${index + 1}`,
      ticketId: null,
      contractVersion: 4,
      entryDiamonds: batch.entry_diamonds,
    });
    if (
      batch.receipts[index].auto_run?.run_id !== batch.run_id ||
      batch.receipts[index].auto_run?.spins !== batch.spins ||
      batch.receipts[index].auto_run?.spins_done !== index + 1
    )
      throw new Error('The Run Receipt Order Could Not Be Verified');
  }
  return batch;
}
export const WheelBatchService = {
  async begin(p: PendingWheelBatch) {
    // Publish all independent seed hashes before submitting the paid transaction.
    const prepared = await rpc('fn_wheel_batch_prepare', {
      p_request_id: p.requestId,
      p_club_id: p.clubId,
      p_spins: p.spins,
      p_entry_diamonds: p.entryDiamonds,
    });
    if (!Array.isArray(prepared.tickets) || prepared.tickets.length !== p.spins)
      throw new Error('The Batch Seals Could Not Be Verified');
    const raw =
      prepared.status === 'complete'
        ? (prepared.receipt as Record<string, unknown>)
        : await rpc('fn_wheel_batch_begin', { p_request_id: p.requestId, p_client_seed: p.seed });
    const batch = parsePaidWheelBatch(raw, p.userId, p.clubId);
    if (
      batch.request_id !== p.requestId ||
      batch.spins !== p.spins ||
      batch.client_seed !== p.seed ||
      batch.entry_diamonds !== p.entryDiamonds ||
      JSON.stringify(batch.tickets) !== JSON.stringify(prepared.tickets)
    )
      throw new Error('The Run Does Not Match Its Published Seals');
    return batch;
  },
  async read(runId: string, userId: string, clubId: string) {
    const raw = await rpc('fn_wheel_batch_read', { p_run_id: runId });
    return parsePaidWheelBatch(raw, userId, clubId);
  },
};
