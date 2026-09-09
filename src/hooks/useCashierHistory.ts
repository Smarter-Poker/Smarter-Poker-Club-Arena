import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { reportError } from '../utils/errorReporter';

interface HistoryRow {
  id: string;
  created_at: string;
  amount: number;
  type: string;
  wallet_type: string;
  category: string;
  description: string;
}

interface PendingRead {
  refreshAgain: boolean;
  promise: Promise<void>;
}

interface HistoryOwner {
  key: string | null;
  active: boolean;
  pending: PendingRead | null;
}

interface HistorySnapshot<T> {
  owner: HistoryOwner;
  data: T[];
  loading: boolean;
  error: string | null;
}

const HISTORY_ERROR = 'Transaction History Could Not Be Refreshed. Please Try Again.';
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Owns read completion, invalidation and cache lifetime for one cashier scope. */
export function useCashierHistory<T extends HistoryRow>({
  userId,
  clubId,
  read,
}: {
  userId: string | undefined;
  clubId: string | null | undefined;
  read: () => Promise<T[]>;
}) {
  const owner = useMemo<HistoryOwner>(
    () => ({
      key: userId && clubId ? `cashier_tx_cache_v2_${JSON.stringify([userId, clubId])}` : null,
      active: false,
      pending: null,
    }),
    [userId, clubId]
  );
  const [snapshot, setSnapshot] = useState<HistorySnapshot<T>>({
    owner,
    data: [],
    loading: false,
    error: null,
  });

  useLayoutEffect(() => {
    owner.active = true;
    let data: T[] = [];
    if (owner.key) {
      try {
        // User-only legacy caches cannot establish club ownership. Ignore them.
        const cached = sessionStorage.getItem(owner.key);
        if (cached) {
          const parsed = JSON.parse(cached);
          const age = Date.now() - parsed.cachedAt;
          if (
            parsed.userId === userId &&
            parsed.clubId === clubId &&
            Number.isFinite(parsed.cachedAt) &&
            age >= 0 &&
            age < CACHE_TTL_MS &&
            Array.isArray(parsed.data) &&
            parsed.data.length <= 30 &&
            parsed.data.every(
              (row: HistoryRow) =>
                row &&
                typeof row.id === 'string' &&
                typeof row.created_at === 'string' &&
                Number.isFinite(row.amount) &&
                typeof row.type === 'string' &&
                typeof row.wallet_type === 'string' &&
                typeof row.category === 'string' &&
                (row.description == null || typeof row.description === 'string') &&
                Number.isFinite(Date.parse(row.created_at))
            )
          )
            data = parsed.data;
        }
      } catch (error) {
        reportError(error, 'CashierPage.history_cache_read');
      }
    }
    setSnapshot({ owner, data, loading: false, error: null });
    return () => {
      owner.active = false;
      owner.pending = null;
    };
  }, [owner, userId, clubId]);

  const load = useCallback(
    (options?: { force?: boolean }): Promise<void> => {
      if (!owner.active || !owner.key) return Promise.resolve();
      if (owner.pending) {
        if (options?.force) owner.pending.refreshAgain = true;
        return owner.pending.promise;
      }
      const pending: PendingRead = { refreshAgain: false, promise: Promise.resolve() };
      owner.pending = pending;
      const current = () => owner.active && owner.pending === pending;
      setSnapshot((previous) => ({ ...previous, loading: true, error: null }));
      pending.promise = Promise.resolve().then(async () => {
        try {
          do {
            pending.refreshAgain = false;
            if (!current()) return;
            try {
              const data = await read();
              if (!current()) return;
              // A confirmed change during this read makes its snapshot obsolete.
              if (pending.refreshAgain) continue;
              setSnapshot({ owner, data, loading: true, error: null });
              try {
                sessionStorage.setItem(
                  owner.key!,
                  JSON.stringify({
                    userId,
                    clubId,
                    data: data.slice(0, 30),
                    cachedAt: Date.now(),
                  })
                );
              } catch (error) {
                reportError(error, 'CashierPage.history_cache_write');
              }
            } catch (error) {
              if (!current()) return;
              reportError(error, 'CashierPage.history_read');
              if (!pending.refreshAgain) {
                setSnapshot((previous) => ({ ...previous, error: HISTORY_ERROR }));
              }
            }
          } while (current() && pending.refreshAgain);
        } finally {
          if (current()) {
            owner.pending = null;
            setSnapshot((previous) => ({ ...previous, loading: false }));
          }
        }
      });
      return pending.promise;
    },
    [owner, read, userId, clubId]
  );

  // Scope changes hide old rows in the render itself, before effect cleanup.
  return {
    transactions: snapshot.owner === owner ? snapshot.data : [],
    loading: snapshot.owner === owner ? snapshot.loading : Boolean(owner.key),
    error: snapshot.owner === owner ? snapshot.error : null,
    load,
  };
}
