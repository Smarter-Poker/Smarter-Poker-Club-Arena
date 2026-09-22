import type { WheelContractVersion, WheelSpinResult } from '../services/DiamondWheelService';
import { assertWheelAward } from './wheelAward';
import { reportError } from './errorReporter';

export type WheelSpinMode = 'paid' | 'welcome' | 'daily_bonus';
export interface WheelPendingSpin {
  userId: string;
  clubId: string;
  mode: WheelSpinMode;
  commitId: string;
  commitHash: string;
  clientSeed: string;
  ticketId: string | null;
  /** Missing only on a request saved before the twelve-sector wheel. */
  contractVersion?: WheelContractVersion;
  entryDiamonds?: number;
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
    (a.contractVersion === undefined
      ? a.entryDiamonds === undefined
      : (a.contractVersion === 2 || a.contractVersion === 3) &&
        Number.isSafeInteger(a.entryDiamonds) &&
        Number(a.entryDiamonds) >= 25 &&
        Number(a.entryDiamonds) <= 2500 &&
        (a.mode === 'paid' || a.entryDiamonds === 100)) &&
    (a.mode === 'daily_bonus'
      ? typeof a.ticketId === 'string' && uuid.test(a.ticketId)
      : a.ticketId === null)
  );
}

/** A saved spin this client cannot read back is dropped and reported, never thrown. */
function discard(key: string, error: unknown, onDiscarded?: () => void) {
  reportError(error, 'wheelPendingSpin.unreadable');
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage that cannot be written cannot hold a spin either. */
  }
  onDiscarded?.();
}

/** Persist before submitting money. An uncertain response keeps the exact request across reloads.
 *
 * A saved spin that cannot be read back (corrupt JSON, a shape this client does
 * not send, or storage that refuses to be read) is discarded, never thrown. A
 * wheel spin settles atomically on the server - the debit and the prize in one
 * transaction, and a won game becomes a pending award the wheel reopens - so
 * all that is lost is the reveal. Throwing here stranded the wheel on
 * "Reconnecting" for good: the save lives in localStorage, and every load retry
 * read it again. Owner ruling 2026-09-21: nothing may make a player check or
 * recover anything.
 *
 * Discarding it silently is not the same as saying so. `onDiscarded` is called
 * once, after the value is gone, for the one caller that has somewhere to say
 * it (the wheel page's load): the player is told the spin could not be read and
 * that History still shows it, rather than finding their reveal simply absent.
 * Callers with nowhere to say it pass nothing. */
export function readWheelPending(
  userId: string,
  clubId: string,
  onDiscarded?: () => void
): WheelPendingSpin | null {
  const key = keyFor(userId, clubId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let a: WheelPendingSpin;
  try {
    a = JSON.parse(raw) as WheelPendingSpin;
  } catch (error) {
    discard(key, error, onDiscarded);
    return null;
  }
  if (!valid(a, userId, clubId)) {
    discard(key, new Error('The Saved Spin Could Not Be Replayed'), onDiscarded);
    return null;
  }
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
  assertWheelAward(r);
  if (
    r.ok !== true ||
    (a.contractVersion !== undefined &&
      // A saved v2 request may first execute after the v3 cutover. Its sealed
      // commit, stake and mode stay identical; a v3 request never downgrades.
      ((a.contractVersion === 3
        ? r.contract_version !== 3
        : r.contract_version !== 2 && r.contract_version !== 3) ||
        r.entry_value_diamonds !== a.entryDiamonds ||
        r.player_cost_diamonds !== (a.mode === 'paid' ? a.entryDiamonds : 0) ||
        (a.mode === 'daily_bonus' && r.entry_funded_by !== 'mint'))) ||
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
