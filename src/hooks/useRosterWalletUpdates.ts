import { useEffect, useRef, type MutableRefObject } from 'react';
import ClubRosterService, {
  MemberAccessDeniedError,
  type MemberDetail,
  type RosterMember,
} from '../services/ClubRosterService';
import { reportError } from '../utils/errorReporter';

type WalletRow = Pick<
  RosterMember,
  | 'user_id'
  | 'chip_balance'
  | 'player_wallet'
  | 'agent_wallet'
  | 'promo_wallet'
  | 'can_view_financials'
>;
type WalletPatch = Omit<WalletRow, 'user_id'>;
type Pending = { controller: AbortController; queued: boolean };

/** Wallet signals update only authorized loaded rows, without restarting pagination. */
export function useRosterWalletUpdates<T extends WalletRow>(
  scopeKey: string,
  clubId: string | null,
  rows: MutableRefObject<T[]>,
  publish: (rows: T[]) => void,
  onFailure: () => void,
  onAccessDenied?: (detail: MemberDetail | null, userId: string) => void
) {
  const scopeRef = useRef({
    key: scopeKey,
    revision: 0,
    patches: new Map<string, { revision: number; patch: Partial<WalletPatch> }>(),
    pending: new Map<string, Pending>(),
  });
  if (scopeRef.current.key !== scopeKey) {
    for (const request of scopeRef.current.pending.values()) request.controller.abort();
    scopeRef.current = { key: scopeKey, revision: 0, patches: new Map(), pending: new Map() };
  }
  const scope = scopeRef.current;
  useEffect(
    () => () => {
      for (const request of scope.pending.values()) request.controller.abort();
    },
    [scope]
  );
  const current = () => scopeRef.current === scope;
  const patch = (userId: string, values: Partial<WalletPatch>) => {
    if (!current()) return;
    const member = rows.current.find((row) => row.user_id === userId && row.can_view_financials);
    if (!member) return;
    const previous = scope.patches.get(userId);
    scope.patches.set(userId, {
      revision: ++scope.revision,
      patch: { ...previous?.patch, ...values },
    });
    rows.current = rows.current.map((row) =>
      row.user_id === userId && row.can_view_financials ? { ...row, ...values } : row
    );
    publish(rows.current);
  };
  const refresh = (userId?: string) => {
    if (!clubId || !current()) return;
    for (const member of rows.current) {
      if (!member.can_view_financials || (userId && member.user_id !== userId)) continue;
      const id = member.user_id;
      const existing = scope.pending.get(id);
      if (existing) {
        existing.queued = true;
        continue;
      }
      const request = { controller: new AbortController(), queued: false };
      scope.pending.set(id, request);
      const deadline = setTimeout(() => {
        request.controller.abort();
        if (current()) onFailure();
      }, 40_000);
      const clearDeadline = () => clearTimeout(deadline);
      request.controller.signal.addEventListener('abort', clearDeadline, { once: true });
      void (async () => {
        try {
          // One active read per member, coalescing event bursts within one 40s bound.
          do {
            request.queued = false;
            const revision = scope.revision;
            const detail = await ClubRosterService.getMemberDetail(
              clubId,
              id,
              undefined,
              request.controller.signal
            );
            if (!current() || request.controller.signal.aborted) return;
            if (!detail.capabilities.can_view_financials || !detail.wallets) {
              patch(id, {
                can_view_financials: false,
                chip_balance: null,
                player_wallet: null,
                agent_wallet: null,
                promo_wallet: null,
              });
              onAccessDenied?.(detail, id);
              request.queued = false;
              continue;
            }
            // A membership event may supply a newer absolute player balance
            // while this detail read is running. Keep it, but print the agent
            // wallet answer and perform one coalesced read for newer signals.
            const newer = scope.patches.get(id);
            const playerChanged = newer && newer.revision > revision;
            patch(id, {
              agent_wallet: detail.wallets.agent_wallet,
              promo_wallet: detail.wallets.promo_wallet,
              ...(playerChanged
                ? {}
                : {
                    chip_balance: detail.wallets.chip_balance,
                    player_wallet: detail.wallets.player_wallet,
                  }),
            });
          } while (request.queued && current());
        } catch (error) {
          if (!current() || request.controller.signal.aborted) return;
          if (error instanceof MemberAccessDeniedError) {
            patch(id, {
              can_view_financials: false,
              chip_balance: null,
              player_wallet: null,
              agent_wallet: null,
              promo_wallet: null,
            });
            onAccessDenied?.(null, id);
            return;
          }
          reportError(error, 'ClubMembersPage.walletRefresh');
          onFailure();
        } finally {
          clearTimeout(deadline);
          request.controller.signal.removeEventListener('abort', clearDeadline);
          if (scope.pending.get(id) === request) scope.pending.delete(id);
        }
      })();
    }
  };
  return {
    snapshot: () => ({ scope: scopeRef.current, revision: scopeRef.current.revision }),
    reconcile: (incoming: T[], startedAt: { scope: typeof scope; revision: number }) =>
      incoming.map((row) => {
        const change = startedAt.scope.patches.get(row.user_id);
        return scopeRef.current === startedAt.scope &&
          row.can_view_financials &&
          change &&
          change.revision > startedAt.revision
          ? { ...row, ...change.patch }
          : row;
      }),
    membership: (record: Record<string, unknown>) => {
      if (record.club_id !== clubId || typeof record.user_id !== 'string') return;
      const raw = record.chip_balance;
      const balance = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
      if (typeof balance !== 'number' || !Number.isFinite(balance)) return;
      patch(record.user_id, { chip_balance: balance, player_wallet: balance });
    },
    refresh,
  };
}
