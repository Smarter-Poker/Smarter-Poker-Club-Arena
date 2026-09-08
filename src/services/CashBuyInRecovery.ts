import { uuid } from '../utils/uuid';
import { supabase } from '../lib/supabase';
import { cashBuyInRefusalText } from '../lib/cashBuyIn';

export interface CashBuyInIntent {
  p_user_id: string;
  p_table_id: string;
  p_seat_number: number;
  p_amount: number;
  p_auto_rebuy: boolean;
  p_club_id: string | null;
}
export interface CashBuyInAttempt {
  version: 1;
  createdAt: number;
  payload: CashBuyInIntent & { p_idempotency_key: string };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface CashBuyInJournalEnvironment {
  local: StorageLike;
  session: StorageLike;
  lock: <T>(key: string, work: () => T) => Promise<T>;
  createId: () => string;
}
const PREFIX = 'smarter-poker:cash-buyin-pending:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFor = (userId: string, tableId: string) =>
  PREFIX + userId.toLowerCase() + ':' + tableId.toLowerCase();
const fields = [
  'p_user_id',
  'p_table_id',
  'p_seat_number',
  'p_amount',
  'p_auto_rebuy',
  'p_club_id',
] as const;
export const sameCashBuyInIntent = (a: CashBuyInIntent, b: CashBuyInIntent): boolean =>
  fields.every((key) =>
    key === 'p_user_id' || key === 'p_table_id' || key === 'p_club_id'
      ? String(a[key]).toLowerCase() === String(b[key]).toLowerCase()
      : a[key] === b[key]
  );

function validIntent(value: unknown): value is CashBuyInIntent {
  if (!value || typeof value !== 'object') return false;
  const p = value as CashBuyInIntent;
  return (
    UUID.test(p.p_user_id) &&
    UUID.test(p.p_table_id) &&
    (p.p_club_id === null || UUID.test(p.p_club_id)) &&
    Number.isInteger(p.p_seat_number) &&
    p.p_seat_number > 0 &&
    p.p_seat_number <= 10 &&
    typeof p.p_auto_rebuy === 'boolean' &&
    Number.isFinite(p.p_amount) &&
    p.p_amount > 0 &&
    p.p_amount <= 1e9 &&
    Math.round(p.p_amount * 100) / 100 === p.p_amount
  );
}
function decode(raw: string, userId: string, tableId: string): CashBuyInAttempt {
  const row = JSON.parse(raw) as CashBuyInAttempt;
  if (
    row?.version !== 1 ||
    !Number.isFinite(row.createdAt) ||
    !validIntent(row.payload) ||
    !UUID.test(row.payload.p_idempotency_key) ||
    row.payload.p_user_id.toLowerCase() !== userId.toLowerCase() ||
    row.payload.p_table_id.toLowerCase() !== tableId.toLowerCase()
  ) {
    throw new Error('The Saved Buy-In Could Not Be Verified');
  }
  return row;
}

/**
 * IndexedDB read/write transactions serialize overlapping object stores across
 * tabs. The critical section is synchronous storage work, never network I/O.
 * This also works in browsers without Web Locks or crypto.randomUUID.
 * https://w3c.github.io/IndexedDB/#transaction-scheduling
 */
export function lockCashBuyInJournal<T>(
  work: () => T,
  factory: IDBFactory = indexedDB
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let result: T;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      db?.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      finish(new Error('The Buy-In Could Not Be Safely Saved In Time'));
      try {
        transaction?.abort();
      } catch {
        /* already completed */
      }
    }, 2_000);
    try {
      const request = factory.open('ca-cash-buyin-journal-lock', 1);
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore('journal');
      };
      request.onerror = () => finish(request.error ?? new Error('Buy-In Storage Is Unavailable'));
      request.onsuccess = () => {
        db = request.result;
        if (settled) {
          db.close();
          return;
        }
        try {
          transaction = db.transaction('journal', 'readwrite');
          transaction.oncomplete = () => finish();
          transaction.onabort = () =>
            finish(transaction?.error ?? new Error('Buy-In Storage Was Interrupted'));
          transaction.onerror = () =>
            finish(transaction?.error ?? new Error('Buy-In Storage Failed'));
          const gate = transaction.objectStore('journal').get('reservation');
          gate.onsuccess = () => {
            if (settled) return;
            try {
              result = work();
            } catch (error) {
              finish(error);
              try {
                transaction?.abort();
              } catch {
                /* already completed */
              }
            }
          };
        } catch (error) {
          finish(error);
        }
      };
    } catch (error) {
      finish(error);
    }
  });
}

function browserEnvironment(): CashBuyInJournalEnvironment {
  return {
    local: window.localStorage,
    session: window.sessionStorage,
    createId: uuid,
    lock: (_key, work) => lockCashBuyInJournal(work),
  };
}

/** Outstanding financial intent, never an offline purchase queue. No age-based eviction. */
export function createCashBuyInJournal(environment = browserEnvironment) {
  const read = (userId: string, tableId: string): CashBuyInAttempt | null => {
    if (!UUID.test(userId) || !UUID.test(tableId)) return null;
    const env = environment();
    const key = keyFor(userId, tableId);
    // A sibling tab may have acknowledged and cleared the shared record. This
    // tab's own unanswered operation still has to replay its original receipt.
    const raw = env.session.getItem(key) ?? env.local.getItem(key);
    return raw === null ? null : decode(raw, userId, tableId);
  };
  return {
    read,
    async reserve(
      intent: CashBuyInIntent
    ): Promise<{ attempt: CashBuyInAttempt; recovered: boolean }> {
      if (!validIntent(intent)) throw new Error('The Buy-In Details Could Not Be Verified');
      intent = {
        ...intent,
        p_user_id: intent.p_user_id.toLowerCase(),
        p_table_id: intent.p_table_id.toLowerCase(),
        p_club_id: intent.p_club_id?.toLowerCase() ?? null,
      };
      const env = environment();
      const key = keyFor(intent.p_user_id, intent.p_table_id);
      return env.lock(key, () => {
        const existing = read(intent.p_user_id, intent.p_table_id);
        if (existing) {
          const raw = JSON.stringify(existing);
          env.session.setItem(key, raw);
          if (env.session.getItem(key) !== raw) throw new Error('The Buy-In Could Not Be Saved');
          return { attempt: existing, recovered: true };
        }
        const operationId = env.createId();
        if (!UUID.test(operationId)) throw new Error('The Buy-In Request Could Not Be Created');
        const attempt: CashBuyInAttempt = {
          version: 1,
          createdAt: Date.now(),
          payload: { ...intent, p_idempotency_key: operationId },
        };
        const raw = JSON.stringify(attempt);
        env.local.setItem(key, raw);
        env.session.setItem(key, raw);
        if (env.local.getItem(key) !== raw || env.session.getItem(key) !== raw)
          throw new Error('The Buy-In Could Not Be Saved');
        return { attempt, recovered: false };
      });
    },
    async complete(attempt: CashBuyInAttempt): Promise<void> {
      const env = environment();
      const p = attempt.payload;
      const key = keyFor(p.p_user_id, p.p_table_id);
      await env.lock(key, () => {
        for (const storage of [env.session, env.local]) {
          const raw = storage.getItem(key);
          if (raw === null) continue;
          const saved = decode(raw, p.p_user_id, p.p_table_id);
          if (
            saved.payload.p_idempotency_key === p.p_idempotency_key &&
            sameCashBuyInIntent(saved.payload, p)
          ) {
            storage.removeItem(key);
          }
        }
      });
    },
  };
}
export const cashBuyInJournal = createCashBuyInJournal();

interface RpcResponse {
  data: unknown;
  error: { code?: string; message?: string } | null;
}
export type CashBuyInRpc = (
  name: 'atomic_table_buyin' | 'fn_ca_cash_buyin_receipt',
  payload: Record<string, unknown>,
  signal: AbortSignal
) => PromiseLike<RpcResponse>;
const defaultRpc: CashBuyInRpc = (name, payload, signal) =>
  name === 'atomic_table_buyin'
    ? supabase.rpc('atomic_table_buyin', payload as any).abortSignal(signal)
    : supabase.rpc('fn_ca_cash_buyin_receipt', payload as any).abortSignal(signal);
export type CashBuyInOutcome =
  | { kind: 'confirmed'; fromReceipt: boolean }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'unknown'; error: unknown };

async function boundedRequest(
  name: Parameters<CashBuyInRpc>[0],
  payload: Record<string, unknown>,
  rpc: CashBuyInRpc,
  ms: number
): Promise<RpcResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(() => rpc(name, payload, controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Buy-In Confirmation Timed Out'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export function cashBuyInReceiptMatches(attempt: CashBuyInAttempt, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const receipt = data as { status?: string; request?: Record<string, unknown> };
  const r = receipt.request;
  const p = attempt.payload;
  return (
    receipt.status === 'confirmed' &&
    !!r &&
    r.door === 'atomic_table_buyin' &&
    r.user_id === p.p_user_id &&
    r.table_id === p.p_table_id &&
    r.seat_number === p.p_seat_number &&
    r.amount === p.p_amount &&
    r.auto_rebuy === p.p_auto_rebuy &&
    r.club_id === p.p_club_id
  );
}

async function checkReceipt(attempt: CashBuyInAttempt, rpc: CashBuyInRpc): Promise<boolean> {
  const { data, error } = await boundedRequest(
    'fn_ca_cash_buyin_receipt',
    {
      p_idempotency_key: attempt.payload.p_idempotency_key,
      p_table_id: attempt.payload.p_table_id,
    },
    rpc,
    6_000
  );
  if (error) throw error;
  if (cashBuyInReceiptMatches(attempt, data)) return true;
  if ((data as { status?: unknown } | null)?.status !== 'unconfirmed')
    throw new Error('The Buy-In Receipt Did Not Match The Original Request');
  return false;
}

/** Called only by a reviewed Confirm/Retry click, never on resume or network events. */
export async function executeCashBuyIn(
  attempt: CashBuyInAttempt,
  recovery: boolean,
  rpc: CashBuyInRpc = defaultRpc,
  isCurrent: () => boolean = () => true
): Promise<CashBuyInOutcome> {
  const ownedRpc: CashBuyInRpc = (name, payload, signal) => {
    if (!isCurrent()) throw new Error('The Buy-In View Changed Before The Request Was Sent');
    return rpc(name, payload, signal);
  };
  try {
    if (recovery && (await checkReceipt(attempt, ownedRpc)))
      return { kind: 'confirmed', fromReceipt: true };
    const { data, error } = await boundedRequest(
      'atomic_table_buyin',
      { ...attempt.payload },
      ownedRpc,
      15_000
    );
    if (error) {
      // Only named business refusals raised AFTER the unique receipt claim can
      // prove this key has no committed predecessor. Auth, lock timeout,
      // idempotency conflict and proxy errors cannot retire an uncertain key.
      const afterClaimRefusal =
        ['P0001', '23514', '55006'].includes(error.code ?? '') &&
        (cashBuyInRefusalText(error) !== null ||
          (error.code === '55006' && error.message?.includes('PLATFORM_FROZEN')));
      if (afterClaimRefusal) return { kind: 'rejected', error };
      throw error;
    }
    if (data && typeof data === 'object' && (data as { success?: boolean }).success === false)
      return { kind: 'rejected', error: data };
    // The canonical RPC returns void. A successful response confirms its
    // transaction; display parsing must not reinterpret it as a second purchase.
    // A reviewed retry may wait behind the original transaction and replay
    // its committed receipt even if the earlier read was unconfirmed. It must
    // never repaint an old starting stack or undo a subsequent explicit leave.
    return { kind: 'confirmed', fromReceipt: recovery };
  } catch (error) {
    // A single read can recover a lost response; it never moves chips. Its own
    // failure preserves the unresolved attempt instead of silently retrying.
    try {
      if (await checkReceipt(attempt, ownedRpc)) return { kind: 'confirmed', fromReceipt: true };
    } catch {
      /* retain the original unknown outcome */
    }
    return { kind: 'unknown', error };
  }
}
