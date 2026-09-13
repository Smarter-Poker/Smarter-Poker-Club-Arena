import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { warmTable } from '../../services/tableWarmup';
import { reportError } from '../../utils/errorReporter';
import './TournamentAutoSeat.css';

const POLL_MS = 12_000;
const FRESH_MS = 10 * 60 * 1000;
const SEEN_KEY = 'ca_tourney_autoseat_seen';
const BLIND_WARNED_KEY = 'ca_tourney_blindoff_warned';
interface AutoSeatScope {
  userId: string;
  session: string;
  alive: boolean;
  read: number;
  poll: number;
  attempt: number;
  seenKey: string;
  warnedKey: string;
  seen: Set<string>;
  warned: Set<string>;
  pending: Map<string, { openAttemptId: string; name: string; navigateOnOpen: boolean }>;
}
interface SeatNotice {
  scope: AutoSeatScope;
  tableId: string;
  name: string;
}
function storeSet(key: string, values: Set<string>) {
  try {
    sessionStorage.setItem(key, JSON.stringify([...values].slice(-40)));
  } catch {
    /* The current account/session's in-memory state remains authoritative. */
  }
}
function remember(values: Set<string>, tableId: string, key: string) {
  values.add(tableId);
  storeSet(key, values);
}
// The legacy unscoped buckets are never imported. A fresh watcher or auth session
// confirms existing parent tabs again; it cannot inherit another actor's suppression.
// Storage belongs to this account/lifetime and is removed when that scope retires.

/**
 * Dan 2026-08-23: "make the top line two lines. 'Prime Time Main Event (NLH)'
 * line one. 'Table 4' line two."
 *
 * The server hands this popup ONE string - "Prime Time Main Event (NLH) - Table
 * 4" - and at 1.35rem in a 460px panel it wrapped wherever it ran out of room,
 * which put the break after "Table" and left a lone "4" on the second line.
 *
 * Split on the LAST " - " so an event name carrying its own dash ("Sunday Deep
 * - Turbo") keeps it and only the table suffix moves down. No suffix - a cash
 * table, or a rename - falls through to a single line rather than inventing one.
 */
function renderTwoLineTitle(raw: string): ReactNode {
  const name = (raw || '').trim();
  const cut = name.lastIndexOf(' - ');
  if (cut <= 0) return name;
  const event = name.slice(0, cut).trim();
  const table = name.slice(cut + 3).trim();
  if (!event || !table) return name;
  return (
    <>
      <span className="tas-title__event">{event}</span>
      <span className="tas-title__table">{table}</span>
    </>
  );
}

export default function TournamentAutoSeat() {
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const current = useRef<AutoSeatScope | null>(null);
  const committedUser = useRef<string | null>(null);
  const committedNavigate = useRef(navigate);
  const auth = useRef<{ seen: boolean; userId: string | null }>({ seen: false, userId: null });
  const [pollEpoch, setPollEpoch] = useState(0);
  const [blocked, setBlocked] = useState<SeatNotice | null>(null);
  const [blindingOff, setBlindingOff] = useState<
    (SeatNotice & { chips: number; capBlocked?: boolean }) | null
  >(null);

  const owns = useCallback(
    (scope: AutoSeatScope) =>
      current.current === scope &&
      scope.alive &&
      committedUser.current === scope.userId &&
      (!auth.current.seen || auth.current.userId === scope.userId),
    []
  );

  const invalidate = useCallback(() => {
    const previous = current.current;
    current.current = null;
    if (!previous) return;
    previous.alive = false;
    previous.read += 1;
    previous.pending.clear();
    try {
      sessionStorage.removeItem(previous.seenKey);
      sessionStorage.removeItem(previous.warnedKey);
    } catch {
      /* owned in-memory state is already invalid */
    }
  }, []);

  const activate = useCallback(
    (notify = false) => {
      invalidate();
      const userId = committedUser.current;
      if (userId && (!auth.current.seen || auth.current.userId === userId)) {
        const session = crypto.randomUUID();
        current.current = {
          userId,
          session,
          alive: true,
          read: 0,
          poll: 0,
          attempt: 0,
          seen: new Set(),
          warned: new Set(),
          pending: new Map(),
          seenKey: `${SEEN_KEY}:${encodeURIComponent(userId)}:${session}`,
          warnedKey: `${BLIND_WARNED_KEY}:${encodeURIComponent(userId)}:${session}`,
        };
      }
      setBlocked(null);
      setBlindingOff(null);
      if (notify) setPollEpoch((n) => n + 1);
    },
    [invalidate]
  );

  // A speculative render must not transfer an existing poll or popup to a new actor.
  useLayoutEffect(() => {
    committedUser.current = user?.id ?? null;
    committedNavigate.current = navigate;
  });
  useLayoutEffect(() => {
    activate();
    return invalidate;
  }, [user?.id, activate, invalidate]);
  useLayoutEffect(() => {
    let alive = true;
    const unsubscribeAuth = masterBus.subscribe('AUTH_STATE_CHANGED', ({ payload }) => {
      if (!alive) return;
      auth.current = {
        seen: true,
        userId: payload.isAuthenticated ? payload.userId || null : null,
      };
      // Synchronous fencing also handles replacement sessions for the same account.
      activate(true);
    });
    const unsubscribeOpen = masterBus.subscribe('TOURNAMENT_TABLE_OPEN_RESULT', ({ payload }) => {
      const scope = current.current;
      if (!alive || !scope || !owns(scope) || payload.userId !== scope.userId) return;
      const pending = scope.pending.get(payload.tableId);
      if (!pending || pending.openAttemptId !== payload.openAttemptId) return;
      if (payload.status === 'cap_blocked') {
        setBlocked({ scope, tableId: payload.tableId, name: pending.name });
        if (pending.navigateOnOpen) {
          setBlindingOff((notice) =>
            notice?.scope === scope && notice.tableId === payload.tableId
              ? { ...notice, capBlocked: true }
              : notice
          );
        }
        return; // Keep it unconfirmed; the next owned poll may retry.
      }
      if (payload.status !== 'opened') return;
      scope.pending.delete(payload.tableId);
      remember(scope.seen, payload.tableId, scope.seenKey);
      setBlocked((notice) =>
        notice?.scope === scope && notice.tableId === payload.tableId ? null : notice
      );
      if (pending.navigateOnOpen) {
        setBlindingOff((notice) =>
          notice?.scope === scope && notice.tableId === payload.tableId ? null : notice
        );
        committedNavigate.current(`/table/${payload.tableId}`);
      }
    });
    return () => {
      alive = false;
      unsubscribeAuth();
      unsubscribeOpen();
    };
  }, [activate, owns]);

  const requestOpen = useCallback(
    (scope: AutoSeatScope, tableId: string, name: string, navigateOnOpen = false) => {
      if (!owns(scope)) return;
      const previous = scope.pending.get(tableId);
      const openAttemptId = `${scope.session}:${++scope.attempt}`;
      scope.pending.set(tableId, {
        openAttemptId,
        name,
        navigateOnOpen: navigateOnOpen || previous?.navigateOnOpen === true,
      });
      warmTable(tableId);
      if (!owns(scope)) return;
      masterBus.emit('TABLE_SEATED', { tableId, seat: 0, userId: scope.userId, openAttemptId });
    },
    [owns]
  );

  const check = useCallback(
    async (scope: AutoSeatScope, poll: number) => {
      if (!owns(scope) || scope.poll !== poll || document.visibilityState !== 'visible') return;
      const read = ++scope.read;
      const isCurrent = () => owns(scope) && scope.poll === poll && scope.read === read;
      try {
        const { data, error } = await supabase
          .from('table_seats')
          .select(
            'table_id, joined_at, stack, is_sitting_out, is_away, tables:table_id (id, name, tournament_id, status)'
          )
          .eq('user_id', scope.userId)
          .is('left_at', null)
          .limit(12);
        if (!isCurrent()) return;
        if (error) throw error;
        const freshFloor = Date.now() - FRESH_MS;
        for (const row of data || []) {
          if (!isCurrent()) return;
          const t = (Array.isArray(row.tables) ? row.tables[0] : row.tables) as {
            id?: string;
            name?: string;
            tournament_id?: string | null;
            status?: string;
          } | null;
          if (!t?.tournament_id) continue;
          const tableId = (row.table_id as string) || t.id || '';
          if (
            !tableId ||
            (t.status && ['closed', 'completed', 'cancelled', 'finished'].includes(t.status))
          )
            continue;
          const name = t.name || 'Your Tournament';
          const away = Boolean(row.is_sitting_out) || Boolean(row.is_away);
          if (away && !scope.warned.has(tableId)) {
            remember(scope.warned, tableId, scope.warnedKey);
            setBlindingOff({ scope, tableId, name, chips: Number(row.stack) || 0 });
          } else if (!away && scope.warned.delete(tableId)) {
            storeSet(scope.warnedKey, scope.warned);
            setBlindingOff((notice) =>
              notice?.scope === scope && notice.tableId === tableId ? null : notice
            );
          }
          if (scope.seen.has(tableId)) continue;
          const joinedAt = row.joined_at ? new Date(row.joined_at as string).getTime() : 0;
          // Freshness limits first discovery, not retries of an unconfirmed
          // attempt that this current scoped query still confirms as eligible.
          if (!scope.pending.has(tableId) && (!joinedAt || joinedAt < freshFloor)) continue;
          requestOpen(scope, tableId, name);
        }
      } catch (error) {
        if (isCurrent()) reportError(error, 'TournamentAutoSeat.check');
      }
    },
    [owns, requestOpen]
  );

  useEffect(() => {
    const scope = current.current;
    if (!scope || !owns(scope)) return;
    const poll = ++scope.poll;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => void check(scope, poll), POLL_MS);
    };
    const visibility = () => {
      if (document.hidden) {
        stop();
        scope.read += 1;
      } else {
        void check(scope, poll);
        start();
      }
    };
    if (!document.hidden) {
      void check(scope, poll);
      start();
    }
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      scope.poll += 1;
      scope.read += 1;
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [user?.id, pollEpoch, check, owns]);

  const takeSeat = (notice: SeatNotice) => {
    if (!owns(notice.scope)) return;
    requestOpen(notice.scope, notice.tableId, notice.name, true);
  };
  if (blindingOff && owns(blindingOff.scope)) {
    return (
      <div className="tas-overlay" role="dialog" aria-label="You Are Being Blinded Off">
        <div className="tas-panel tas-panel--urgent">
          <div className="tas-flag tas-flag--urgent">You Are Being Blinded Off</div>
          <div className="tas-title">{renderTwoLineTitle(blindingOff.name)}</div>
          <p className="tas-body">
            Your Seat Is Posting Blinds Without You
            {blindingOff.chips > 0
              ? ` And You Have ${Math.round(blindingOff.chips).toLocaleString()} Chips Left`
              : ''}
            . Take Your Seat Now To Stop Losing Chips.
          </p>
          {blindingOff.capBlocked && (
            <p className="tas-body" role="status">
              All Four Table Slots Are Full. Close A Table, Then Select Take My Seat Again.
            </p>
          )}
          <div className="tas-actions">
            <button className="tas-later" onClick={() => setBlindingOff(null)}>
              Dismiss
            </button>
            <button className="tas-go" onClick={() => takeSeat(blindingOff)}>
              Take My Seat
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!blocked || !owns(blocked.scope)) return null;
  return (
    <div className="tas-overlay" role="dialog" aria-label="Tournament Started">
      <div className="tas-panel">
        <div className="tas-flag">TOURNAMENT STARTED</div>
        <div className="tas-title">{renderTwoLineTitle(blocked.name)}</div>
        <p className="tas-body">
          Has Just Started And Your Seat Is Waiting. Your Cash Tables Are Full - Please Leave A Cash
          Game Or Close A Table To Sit Down.
        </p>
        <div className="tas-actions">
          <button className="tas-later" onClick={() => setBlocked(null)}>
            Not Now
          </button>
          <button className="tas-go" onClick={() => takeSeat(blocked)}>
            Take My Seat
          </button>
        </div>
      </div>
    </div>
  );
}
