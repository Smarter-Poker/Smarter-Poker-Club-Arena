import type { WheelSpinResult } from '../services/DiamondWheelService';

export type WheelSpinMode = 'paid' | 'welcome' | 'daily_bonus';
export interface WheelPendingSpin {
  userId: string;
  clubId: string;
  mode: WheelSpinMode;
  commitId: string;
  commitHash: string;
  clientSeed: string;
  ticketId: string | null;
}

const keyFor = (userId: string, clubId: string) => `diamond-wheel-pending:v1:${userId}:${clubId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valid(a: WheelPendingSpin, userId: string, clubId: string): boolean {
  return (
    a?.userId === userId &&
    a.clubId === clubId &&
    uuid.test(a.commitId) &&
    /^[0-9a-f]{64}$/i.test(a.commitHash) &&
    typeof a.clientSeed === 'string' &&
    a.clientSeed.length > 0 &&
    a.clientSeed.length <= 64 &&
    (a.mode === 'paid' || a.mode === 'welcome' || a.mode === 'daily_bonus') &&
    (a.mode === 'daily_bonus'
      ? typeof a.ticketId === 'string' && uuid.test(a.ticketId)
      : a.ticketId === null)
  );
}

/** Persist before submitting money. An uncertain response keeps the exact request across reloads. */
export function readWheelPending(userId: string, clubId: string): WheelPendingSpin | null {
  const raw = localStorage.getItem(keyFor(userId, clubId));
  if (!raw) return null;
  const a = JSON.parse(raw) as WheelPendingSpin;
  if (!valid(a, userId, clubId)) throw new Error('The Saved Spin Needs Recovery. Contact Support');
  return a;
}

export function saveWheelPending(a: WheelPendingSpin): void {
  if (!valid(a, a.userId, a.clubId)) throw new Error('The Spin Request Could Not Be Saved');
  const key = keyFor(a.userId, a.clubId);
  const value = JSON.stringify(a);
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw new Error('The Spin Request Could Not Be Saved');
}

export function clearWheelPending(a: WheelPendingSpin): void {
  const current = readWheelPending(a.userId, a.clubId);
  if (current?.commitId === a.commitId) localStorage.removeItem(keyFor(a.userId, a.clubId));
}

/** Transport success is insufficient: only this request's complete receipt may settle it. */
export function assertWheelReceipt(r: WheelSpinResult, a: WheelPendingSpin): void {
  if (
    r.ok !== true ||
    !uuid.test(r.spin_id) ||
    r.club_id !== a.clubId ||
    r.welcome !== (a.mode === 'welcome') ||
    Boolean(r.daily_bonus) !== (a.mode === 'daily_bonus') ||
    (a.mode === 'daily_bonus' && r.bonus_ticket_id !== a.ticketId) ||
    r.fairness.commit_id !== a.commitId ||
    r.fairness.client_seed !== a.clientSeed ||
    r.fairness.server_seed_hash !== a.commitHash ||
    !/^[0-9a-f]{64}$/i.test(r.fairness.server_seed) ||
    !Number.isInteger(r.outcome.ord) ||
    r.outcome.ord <= 0 ||
    !r.fairness.eligible_ords.includes(r.outcome.ord) ||
    r.fairness.weight_total <= 0 ||
    !Number.isFinite(Date.parse(r.created_at))
  ) {
    throw new Error('The Spin Receipt Could Not Be Confirmed. Retry The Same Spin');
  }
}
